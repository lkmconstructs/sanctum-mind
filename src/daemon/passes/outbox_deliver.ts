import type { PoolClient } from "pg";
import { withMind } from "../../db/pool.js";
import { deliverToSink } from "../../sinks/index.js";
import type { SinkConfig, SinkEvent } from "../../sinks/types.js";
import type { DetachedPass } from "./types.js";

export const BATCH = 200;
export const MAX_ATTEMPTS = 30;
/** the far-future parking time for a row that exhausted its attempts */
export const PARKED_AT = new Date("9999-12-31T00:00:00Z");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Delay before the next try after the nth failed attempt: 1m, 5m, 30m, 2h, 12h, then daily. */
export function backoffMs(attempts: number): number {
  const steps = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 12 * HOUR];
  return steps[attempts - 1] ?? 24 * HOUR;
}

/**
 * The least a lease lasts. While a delivery is in flight the claimed rows' next_attempt_at is pushed ahead by the
 * lease, so a concurrent run (another daemon, a manual run) does not pick them up and deliver them twice.
 * A crash leaves the lease to expire and the rows are retried then.
 */
export const LEASE_MS = 30 * MINUTE;

/**
 * The lease for one run, sized from the configured sinks: a sink delivers its rows one after another, so a
 * full batch against the slowest configured timeout takes BATCH * timeout; five minutes of slack are added.
 * Never less than LEASE_MS (so file sinks and fast sinks keep the 30 minute floor).
 */
export function leaseMsFor(sinks: SinkConfig[]): number {
  const slowest = sinks.reduce((m, s) => Math.max(m, s.type === "http" ? s.timeout_ms : 0), 0);
  return Math.max(LEASE_MS, BATCH * slowest + 5 * MINUTE);
}

interface Due extends SinkEvent {
  outbox_id: string;
  sink: string;
  attempts: number;
  prev_next_attempt_at: Date;
}

/**
 * Delivers due outbox rows of this mind, at most 200 per run. This pass is the one exception to "a pass
 * is one transaction under the per-mind advisory lock" (it is `detached`): a sink can be slow or hang, and
 * a network wait must not hold a pooled connection, row locks or the daemon lock, which would stall every
 * other pass and every other run for the mind.
 *
 *  1. Claim: in one short transaction, select the due rows (for update skip locked, oldest first) and
 *     lease them by pushing next_attempt_at forward. The transaction closes.
 *  2. Deliver with no transaction open. Each sink is its own sequence, in outbox id order, and stops at
 *     its first failure for the rest of the run (the rows it did not try are released unchanged). Sinks
 *     run concurrently with each other, so one hung sink does not hold up the rest.
 *  3. Record: every result is written in its own short transaction (delivered, or attempts and backoff).
 *
 * At-least-once: a crash between the call and its record can redeliver once; receivers dedupe on event.id.
 * Order is kept within a run. A row in backoff does not block newer rows in later runs, so a receiver that
 * needs strict order sorts by event.seq.
 */
export const outboxDeliver: DetachedPass = {
  name: "outbox.deliver",
  detached: true,
  async run(ctx) {
    if (ctx.sinks.length === 0) return { changed: 0 };
    const { pool, mind_id: mind } = ctx;
    const names = ctx.sinks.map((s) => s.name);
    const now = ctx.now();

    const due = await withMind(pool, mind, mind, "write", async (tx) => {
      const rows = (
        await tx.query<Due>(
          `select o.id as outbox_id, o.sink, o.attempts, o.next_attempt_at as prev_next_attempt_at,
                  e.id, e.seq, e.mind_id, e.kind, e.subject_id, e.payload, e.texture, e.context, e.recorded_at,
                  e.event_time_start, e.event_time_end, e.event_time_granularity, e.created_at, e.session_id, e.written_by
             from event_outbox o join events e on e.id = o.event_id
            where o.mind_id = $1 and o.delivered_at is null and o.next_attempt_at <= $2 and o.sink = any($3::text[])
            order by o.id limit $4
              for update of o skip locked`,
          [mind, now, names, BATCH],
        )
      ).rows;
      if (rows.length > 0) {
        await tx.query(`update event_outbox set next_attempt_at = $2 where id = any($1::bigint[]) and mind_id = $3`, [
          rows.map((r) => r.outbox_id),
          new Date(now.getTime() + leaseMsFor(ctx.sinks)),
          mind,
        ]);
      }
      return rows;
    });
    if (due.length === 0) return { changed: 0 };

    const record = <T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> => withMind(pool, mind, mind, "write", fn);
    const release = async (rows: Due[]): Promise<void> => {
      if (rows.length === 0) return;
      await record((tx) =>
        tx.query(
          `update event_outbox o set next_attempt_at = v.prev
             from unnest($1::bigint[], $2::timestamptz[]) as v(id, prev)
            where o.id = v.id and o.mind_id = $3 and o.delivered_at is null`,
          [rows.map((r) => r.outbox_id), rows.map((r) => r.prev_next_attempt_at), mind],
        ),
      );
    };

    const bySink = new Map(ctx.sinks.map((s) => [s.name, s]));
    const groups = new Map<string, Due[]>();
    for (const r of due) (groups.get(r.sink) ?? groups.set(r.sink, []).get(r.sink)!).push(r);

    const runSink = async (sinkName: string, rows: Due[]): Promise<{ changed: number; failures: string[] }> => {
      const sink = bySink.get(sinkName)!;
      let changed = 0;
      const failures: string[] = [];
      let next = 0; // rows[next..] were claimed but not tried
      try {
        for (; next < rows.length; next++) {
          const r = rows[next]!;
          const { outbox_id, sink: _s, attempts, prev_next_attempt_at: _p, ...event } = r;
          const res = await deliverToSink(sink, { sink: sinkName, event });
          const at = ctx.now();
          if (res.ok) {
            await record((tx) =>
              tx.query(`update event_outbox set delivered_at = $2, last_error = null where id = $1 and mind_id = $3`, [outbox_id, at, mind]),
            );
            changed++;
            continue;
          }
          const n = attempts + 1;
          const parked = n >= MAX_ATTEMPTS;
          const nextAt = parked ? PARKED_AT : new Date(at.getTime() + backoffMs(n));
          const error = parked ? `gave up after ${n} attempts: ${res.error ?? "failed"}`.slice(0, 300) : (res.error ?? "failed");
          await record((tx) =>
            tx.query(`update event_outbox set attempts = $2, next_attempt_at = $3, last_error = $4 where id = $1 and mind_id = $5`, [
              outbox_id,
              n,
              nextAt,
              error,
              mind,
            ]),
          );
          failures.push(`${sinkName}: event ${r.id} attempt ${n}${parked ? " (parked)" : ""}: ${res.error ?? "failed"}`);
          next++; // this row is recorded; stop the sink here
          break;
        }
      } finally {
        // rows after the stop (or after a crash) were never tried: hand them back unchanged
        await release(rows.slice(next)).catch((e) => console.error(`outbox.deliver: could not release rows of sink ${sinkName}:`, e));
      }
      return { changed, failures };
    };

    const results = await Promise.all([...groups].map(([name, rows]) => runSink(name, rows)));
    const changed = results.reduce((a, r) => a + r.changed, 0);
    const failures = results.flatMap((r) => r.failures);
    return { changed, ...(failures.length > 0 ? { notes: failures.slice(0, 20) } : {}) };
  },
};
