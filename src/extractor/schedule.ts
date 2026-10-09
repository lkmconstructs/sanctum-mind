// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { PoolClient } from "pg";

export type ExtractorPassName = "notice.extract" | "notice.train";

/**
 * Today's scheduled instant: `schedule` (HH:MM) on the calendar day of `now`, in the SERVICE's local time zone
 * (the process TZ; under Docker that is UTC unless TZ is set). A pass is due once `now` has reached it. It has run for the
 * day when `extractor_runs` holds a run of its own (not a skip, not an imported row) that started on today's local date,
 * wherever the schedule sits: moving the schedule later in the day does not make it run twice.
 */
export function scheduledAt(now: Date, schedule: string): Date {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(schedule);
  const d = new Date(now.getTime());
  d.setHours(m ? Number(m[1]) : 3, m ? Number(m[2]) : 0, 0, 0);
  return d;
}

/** Local midnight at the start of `now`'s calendar day. */
export function startOfDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface GateState {
  enabled: boolean;
  stage: "shadow" | "propose";
  schedule: string;
  paused: boolean;
}

export async function readState(tx: PoolClient, mind: string): Promise<GateState | null> {
  const r = await tx.query<{ enabled: boolean; stage: "shadow" | "propose"; schedule: string; paused: boolean }>(
    `select enabled, stage, schedule, paused_at is not null as paused from extractor_state where mind_id = $1`,
    [mind],
  );
  return r.rows[0] ?? null;
}

/** Why a pass must not run now, or null when it may: not enabled, paused, or before its time today. */
export function notDueReason(state: GateState | null, now: Date): string | null {
  if (!state || !state.enabled) return "the extractor is not enabled for this mind";
  if (state.paused) return "the extractor is paused";
  if (now.getTime() < scheduledAt(now, state.schedule).getTime()) return `not due until ${state.schedule} (service local time)`;
  return null;
}

export interface RunRow {
  started_at: Date;
  ok: boolean;
  notes: Record<string, unknown>;
}

/** A run that uses the day up: neither a skip nor a row brought in by an import (the history of another life). */
export const isRealRun = (r: RunRow): boolean => r.notes.skipped !== true && r.notes.imported !== true;
export const isSkip = (r: RunRow): boolean => r.notes.skipped === true && r.notes.imported !== true;

/** The pass's rows since `since`, newest first. */
export async function runsSince(tx: PoolClient, mind: string, pass: ExtractorPassName, since: Date): Promise<RunRow[]> {
  const r = await tx.query<RunRow>(
    `select started_at, ok, notes from extractor_runs where mind_id = $1 and pass = $2 and started_at >= $3 order by started_at desc`,
    [mind, pass, since],
  );
  return r.rows;
}

/**
 * Appends one run row. started_at is part of the key, so if a row of this pass already sits at that instant (a fixed test
 * clock; two daemons in one millisecond) the new one is placed a millisecond after the latest.
 */
export async function recordRun(
  tx: PoolClient,
  mind: string,
  pass: ExtractorPassName,
  startedAt: Date,
  finishedAt: Date,
  ok: boolean,
  notes: Record<string, unknown>,
): Promise<void> {
  const latest = await tx.query<{ t: Date | null }>(`select max(started_at) as t from extractor_runs where mind_id = $1 and pass = $2`, [mind, pass]);
  const t = latest.rows[0]?.t ?? null;
  const at = t !== null && t.getTime() >= startedAt.getTime() ? new Date(t.getTime() + 1) : startedAt;
  await tx.query(
    `insert into extractor_runs (mind_id, pass, started_at, finished_at, ok, notes) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [mind, pass, at, finishedAt, ok, JSON.stringify(notes)],
  );
}

/** A message safe to store: no row data, bounded. */
export function brief(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (/^[0-9A-Z]{5}$/.test(code)) return `database error ${code}`;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "failed";
}
