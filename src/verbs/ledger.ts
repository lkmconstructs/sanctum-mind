import type { VerbContext } from "./types.js";
import { NOT_EMBEDDED, enqueueOutbox, type AppendedEvent, type Embedded } from "./common.js";
import { normaliseInstant, resolveEventTime, type EventTime } from "./texture.js";

export interface AppendEventWithTimesInput {
  kind: string;
  payload: unknown;
  texture?: unknown;
  context?: string;
  /** validated ISO 8601 text; stored as UTC microseconds */
  recorded_at?: string;
  event_time?: EventTime;
  /** the embedding computed before the transaction (ctx.embedded); null columns when absent */
  embedded?: Embedded | undefined;
}

/**
 * Mirrors appendEvent (common.ts) and adds the event_time columns. Used by mind_write and
 * mind_observe. end defaults to start; the embedding (computed by the runner before the transaction) is stored when given.
 * Instants are passed to Postgres as normalised UTC strings so microseconds survive.
 */
export async function appendEventWithTimes(
  ctx: VerbContext,
  e: AppendEventWithTimesInput,
): Promise<AppendedEvent> {
  const t = e.event_time === undefined ? null : resolveEventTime(e.event_time);
  const emb = e.embedded ?? NOT_EMBEDDED;
  const res = await ctx.tx.query<AppendedEvent>(
    `insert into events (mind_id, kind, payload, texture, context, written_by, recorded_at, session_id, created_at,
                         event_time_start, event_time_end, event_time_granularity, embedding, embedding_model)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, clock_timestamp(), $9, $10, $11, $12::vector, $13)
     returning id, seq, created_at, recorded_at, event_time_start, event_time_end, event_time_granularity`,
    [
      ctx.mind_id,
      e.kind,
      JSON.stringify(e.payload),
      e.texture === undefined ? null : JSON.stringify(e.texture),
      e.context ?? null,
      ctx.caller.bearer,
      e.recorded_at === undefined ? ctx.now() : normaliseInstant(e.recorded_at),
      ctx.session_id ?? null,
      t ? t.start : null,
      t ? t.end : null,
      t ? t.granularity : null,
      emb.vector,
      emb.model,
    ],
  );
  const row = res.rows[0]!;
  await enqueueOutbox(ctx, row.id, e.kind);
  return row;
}
