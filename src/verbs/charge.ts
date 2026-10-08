import { err } from "../result.js";
import type { VerbContext } from "./types.js";

/** Charge states in forward order; the last three are terminal siblings. */
export const CHARGE_STATES = ["fresh", "active", "processing", "metabolized", "deferred", "released"] as const;
export type ChargeState = (typeof CHARGE_STATES)[number];

export const TERMINAL_STATES: readonly ChargeState[] = ["metabolized", "deferred", "released"];

const RANK: Record<ChargeState, number> = {
  fresh: 0,
  active: 1,
  processing: 2,
  metabolized: 3,
  deferred: 3,
  released: 3,
};

/**
 * Transitions only move strictly forward. Terminal states accept nothing, and the terminal
 * siblings do not move between each other. fresh may jump straight to a terminal state.
 */
export function canTransition(from: ChargeState, to: ChargeState): boolean {
  if (TERMINAL_STATES.includes(from)) return false;
  return RANK[to] > RANK[from];
}

/** Advisory lock keys, kept in one place. Each is passed to hashtext() in SQL. */
export const lockKeys = {
  holding: (mind_id: string, subject_id: string) => `holdings:${mind_id}:${subject_id}`,
  loop: (loop_id: string) => `loops:${loop_id}`,
};

export async function lockHolding(ctx: VerbContext, subject_id: string): Promise<void> {
  await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [lockKeys.holding(ctx.mind_id, subject_id)]);
}

export interface HoldingRow {
  mind_id: string;
  subject_id: string;
  subject_kind: "event" | "node";
  state: ChargeState;
  note: string | null;
  last_event_id: string;
  updated_at: Date;
}

/** A live node or an event with this id, in the mind's scope (RLS); null when neither. */
export async function resolveSubjectKind(ctx: VerbContext, subject_id: string): Promise<"node" | "event" | null> {
  const r = await ctx.tx.query<{ kind: "node" | "event" }>(
    `select 'node' as kind from nodes where id = $1 and invalidated_at is null
     union all
     select 'event' from events where id = $1
     limit 1`,
    [subject_id],
  );
  return r.rows[0]?.kind ?? null;
}

export async function currentHolding(ctx: VerbContext, subject_id: string): Promise<HoldingRow | null> {
  const r = await ctx.tx.query<HoldingRow>(`select * from holdings where mind_id = $1 and subject_id = $2`, [
    ctx.mind_id,
    subject_id,
  ]);
  return r.rows[0] ?? null;
}

export async function upsertHolding(
  ctx: VerbContext,
  h: { subject_id: string; subject_kind: "event" | "node"; state: ChargeState; note: string | null; event_id: string; at: Date },
): Promise<HoldingRow> {
  const r = await ctx.tx.query<HoldingRow>(
    `insert into holdings (mind_id, subject_id, subject_kind, state, note, last_event_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (mind_id, subject_id) do update set
       state = excluded.state, note = excluded.note,
       last_event_id = excluded.last_event_id, updated_at = excluded.updated_at
     returning *`,
    [ctx.mind_id, h.subject_id, h.subject_kind, h.state, h.note, h.event_id, h.at],
  );
  return r.rows[0]!;
}

export const backwardConflict = (from: ChargeState, to: ChargeState) =>
  err("conflict", `cannot move from ${from} to ${to}`, "state");
