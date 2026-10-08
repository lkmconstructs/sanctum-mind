// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { Pool } from "pg";
import { withMind } from "../db/pool.js";
import { MAX_ATTEMPTS } from "../daemon/passes/outbox_deliver.js";
import { deliverToSink } from "./index.js";
import type { SinkBody, SinkConfig } from "./types.js";

export interface SinkTestResult {
  sink: string;
  type: string;
  ok: boolean;
  error?: string;
}

/** Sends a synthetic `sink.test` body to every sink (including none-typed, which trivially succeed). */
export async function sinksTest(sinks: SinkConfig[], fetchImpl: typeof fetch = fetch): Promise<SinkTestResult[]> {
  const out: SinkTestResult[] = [];
  for (const sink of sinks) {
    const at = new Date().toISOString();
    const body: SinkBody = {
      sink: sink.name,
      event: {
        id: "00000000-0000-0000-0000-000000000000",
        seq: "0",
        mind_id: "sink-test",
        kind: "sink.test",
        subject_id: null,
        payload: { text: "sanctum-mind sinks test" },
        texture: null,
        context: null,
        recorded_at: at,
        event_time_start: null,
        event_time_end: null,
        event_time_granularity: null,
        created_at: at,
        session_id: null,
        written_by: "sink-test",
      },
    };
    const r = await deliverToSink(sink, body, fetchImpl);
    out.push({ sink: sink.name, type: sink.type, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  }
  return out;
}

export interface SinkStatusRow {
  sink: string;
  pending: number;
  failing: number;
  delivered: number;
}

/**
 * Per-sink counts across every enabled mind, over the app-role pool (row level security applies, so each
 * mind is read in its own scope). pending = not delivered; failing = pending with at least one failed attempt.
 */
export async function sinksStatus(pool: Pool, sinks: SinkConfig[], minds?: string[]): Promise<SinkStatusRow[]> {
  const listed = (await pool.query<{ mind_id: string }>(`select mind_id from minds where disabled_at is null order by mind_id`)).rows
    .map((r) => r.mind_id)
    .filter((m) => minds === undefined || minds.includes(m));
  const rows = new Map<string, SinkStatusRow>();
  for (const s of sinks) rows.set(s.name, { sink: s.name, pending: 0, failing: 0, delivered: 0 });
  for (const mind of listed) {
    const r = await withMind(pool, mind, mind, "read", async (tx) =>
      (
        await tx.query<{ sink: string; pending: string; failing: string; delivered: string }>(
          `select sink,
                  count(*) filter (where delivered_at is null) as pending,
                  count(*) filter (where delivered_at is null and attempts > 0) as failing,
                  count(*) filter (where delivered_at is not null) as delivered
             from event_outbox where mind_id = $1 group by sink`,
          [mind],
        )
      ).rows,
    );
    for (const x of r) {
      const row = rows.get(x.sink) ?? { sink: x.sink, pending: 0, failing: 0, delivered: 0 };
      row.pending += Number(x.pending);
      row.failing += Number(x.failing);
      row.delivered += Number(x.delivered);
      rows.set(x.sink, row);
    }
  }
  return [...rows.values()];
}

/**
 * Resets the parked rows of one sink (attempts >= MAX_ATTEMPTS, undelivered) so the daemon tries them again:
 * attempts 0, due now, last_error cleared. Walks every mind in its own scope (row level security applies),
 * so it works with the app role or the admin role alike. Returns the number of rows requeued per mind.
 */
export async function sinksRequeue(pool: Pool, sink: string, now: Date = new Date()): Promise<{ total: number; minds: Record<string, number> }> {
  const listed = (await pool.query<{ mind_id: string }>(`select mind_id from minds order by mind_id`)).rows.map((r) => r.mind_id);
  const minds: Record<string, number> = {};
  let total = 0;
  for (const mind of listed) {
    const n = await withMind(pool, mind, mind, "write", async (tx) => {
      const r = await tx.query(
        `update event_outbox set attempts = 0, next_attempt_at = $3, last_error = null
          where mind_id = $1 and sink = $2 and delivered_at is null and attempts >= $4`,
        [mind, sink, now, MAX_ATTEMPTS],
      );
      return r.rowCount ?? 0;
    });
    if (n > 0) {
      minds[mind] = n;
      total += n;
    }
  }
  return { total, minds };
}
