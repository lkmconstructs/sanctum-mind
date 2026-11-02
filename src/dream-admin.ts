// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { parseArgs } from "node:util";
import type { Pool, PoolClient } from "pg";
import { isValidMindId, mindIdProblem } from "./auth.js";
import { ArgError } from "./cli-args.js";

/**
 * Operator administration of dreaming (CONTRACTS.md, "Dreaming"). OPERATOR ONLY: the app role can read `dream_state` and
 * nothing more. The operator may enable, disable, pause, resume, choose the stage, the schedule and the gap; no operator
 * action anchors a dream, and none sets who appears (that is the mind's, through mind_dream prefer). Every state change is a
 * ledger event `daemon.dream.<action>` written as the mind. This file is deliberately NOT under src/dream/, which holds only
 * the daemon passes.
 */

export const NEEDS_OPERATOR = "dream commands need the sanctum_operator lane or the admin DATABASE_URL (the sanctum_app login and the other lanes can only read dreaming's state)";

export const DREAM_STAGES = ["shadow", "propose"] as const;
export type DreamStage = (typeof DREAM_STAGES)[number];
export const DEFAULT_DREAM_STAGE: DreamStage = "shadow";
export const DEFAULT_DREAM_SCHEDULE = "03:30";
export const DEFAULT_DREAM_GAP_HOURS = 20;
const SCHEDULE_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const DREAM_USAGE =
  "usage: sanctum-mind dream enable --mind <id> [--stage shadow|propose] [--schedule HH:MM] [--gap-hours N] [--json]\n" +
  "       sanctum-mind dream disable|pause|resume --mind <id> [--json]\n" +
  "       sanctum-mind dream stage --mind <id> --stage shadow|propose [--json]\n" +
  "       sanctum-mind dream report --mind <id> [--json]";

export type DreamAction = "enable" | "disable" | "pause" | "resume" | "stage" | "report";
const ACTIONS: readonly DreamAction[] = ["enable", "disable", "pause", "resume", "stage", "report"];
type StateAction = Exclude<DreamAction, "report">;

export interface DreamArgs {
  action: DreamAction;
  mind: string;
  stage?: DreamStage;
  schedule?: string;
  gapHours?: number;
  json: boolean;
}

export function isDreamStage(s: string): s is DreamStage {
  return (DREAM_STAGES as readonly string[]).includes(s);
}

export function parseDreamArgs(argv: string[]): DreamArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { mind: { type: "string" }, stage: { type: "string" }, schedule: { type: "string" }, "gap-hours": { type: "string" }, json: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${DREAM_USAGE}`);
  }
  const { values, positionals } = parsed;
  const action = positionals[0] as DreamAction | undefined;
  if (action === undefined || !ACTIONS.includes(action)) throw new ArgError(`dream needs a subcommand: ${ACTIONS.join(", ")}\n${DREAM_USAGE}`);
  if (positionals.length > 1) throw new ArgError(`unexpected argument "${positionals[1]}"\n${DREAM_USAGE}`);
  if (values.mind === undefined || values.mind === "") throw new ArgError(`--mind <id> is required\n${DREAM_USAGE}`);
  if (!isValidMindId(values.mind)) throw new ArgError(mindIdProblem(values.mind));
  if (values.stage !== undefined && action !== "enable" && action !== "stage") throw new ArgError(`dream ${action} does not take --stage\n${DREAM_USAGE}`);
  if ((values.schedule !== undefined || values["gap-hours"] !== undefined) && action !== "enable") throw new ArgError(`dream ${action} does not take --schedule or --gap-hours\n${DREAM_USAGE}`);
  if (action === "stage" && values.stage === undefined) throw new ArgError(`--stage shadow|propose is required\n${DREAM_USAGE}`);
  const out: DreamArgs = { action, mind: values.mind, json: values.json === true };
  if (values.stage !== undefined) {
    if (!isDreamStage(values.stage)) throw new ArgError(`invalid stage "${values.stage}" (allowed: ${DREAM_STAGES.join(", ")}); there is no other stage`);
    out.stage = values.stage;
  }
  if (values.schedule !== undefined) {
    if (!SCHEDULE_RE.test(values.schedule)) throw new ArgError(`invalid schedule "${values.schedule}" (use HH:MM, 24-hour, service-local time)`);
    out.schedule = values.schedule;
  }
  if (values["gap-hours"] !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(values["gap-hours"]) || Number(values["gap-hours"]) > 168) throw new ArgError(`invalid --gap-hours "${values["gap-hours"]}" (a whole number of hours from 1 to 168)`);
    out.gapHours = Number(values["gap-hours"]);
  }
  return out;
}

export interface DreamStateRow {
  mind_id: string;
  enabled: boolean;
  stage: DreamStage;
  schedule: string;
  gap_hours: number;
  paused_at: Date | null;
  updated_at: Date;
  updated_event_id: string | null;
}

export interface DreamStateView {
  enabled: boolean;
  stage: DreamStage;
  schedule: string;
  gap_hours: number;
  paused: boolean;
}

export interface DreamChange {
  mind: string;
  action: StateAction;
  changed: boolean;
  state: DreamStateView;
  event_id: string | null;
}

async function inMind<T>(pool: Pool, mind: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.mind_id', $1, true), set_config('app.bearer', $1, true), set_config('app.actor', 'operator', true)", [mind]);
    const exists = await client.query<{ disabled_at: Date | null }>("select disabled_at from minds where mind_id = $1", [mind]);
    if (exists.rows.length === 0) throw new ArgError(`unknown mind "${mind}"`);
    if (exists.rows[0]!.disabled_at !== null) throw new ArgError(`mind "${mind}" has access suspended`);
    const r = await fn(client);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    if (/permission denied/i.test(e instanceof Error ? e.message : "")) throw new ArgError(NEEDS_OPERATOR);
    throw e;
  } finally {
    client.release();
  }
}

const view = (r: DreamStateRow): DreamStateView => ({ enabled: r.enabled, stage: r.stage, schedule: r.schedule, gap_hours: r.gap_hours, paused: r.paused_at !== null });

/**
 * Applies one operator action to the dreaming of one mind. Enabling with no flags keeps an existing stage, schedule and gap
 * (first enable: shadow at 03:30, 20 hours) and clears a pause. `pause`, `resume` and `stage` need an enabled-once row. An
 * action that would not change anything writes nothing (`changed: false`).
 */
export async function setDreamState(pool: Pool, mind: string, action: StateAction, opts: { stage?: string; schedule?: string; gapHours?: number } = {}): Promise<DreamChange> {
  if (!isValidMindId(mind)) throw new ArgError(mindIdProblem(mind));
  if (opts.stage !== undefined && !isDreamStage(opts.stage)) throw new ArgError(`invalid stage "${opts.stage}" (allowed: ${DREAM_STAGES.join(", ")}); there is no other stage`);
  if (opts.schedule !== undefined && !SCHEDULE_RE.test(opts.schedule)) throw new ArgError(`invalid schedule "${opts.schedule}" (use HH:MM)`);
  if (opts.gapHours !== undefined && (!Number.isInteger(opts.gapHours) || opts.gapHours < 1 || opts.gapHours > 168)) throw new ArgError("gap hours must be a whole number from 1 to 168");

  return inMind(pool, mind, async (c) => {
    const can = await c.query<{ ok: boolean }>("select has_table_privilege(current_user, 'public.dream_state', 'UPDATE') as ok");
    if (can.rows[0]!.ok !== true) throw new ArgError(NEEDS_OPERATOR);
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`dream:${mind}`]);
    const cur = (await c.query<DreamStateRow>("select * from dream_state where mind_id = $1 for update", [mind])).rows[0];
    const off: DreamStateView = { enabled: false, stage: DEFAULT_DREAM_STAGE, schedule: DEFAULT_DREAM_SCHEDULE, gap_hours: DEFAULT_DREAM_GAP_HOURS, paused: false };
    const before = cur ? view(cur) : off;

    let next = { ...before };
    if (action === "enable") {
      next = { enabled: true, stage: (opts.stage as DreamStage | undefined) ?? before.stage, schedule: opts.schedule ?? before.schedule, gap_hours: opts.gapHours ?? before.gap_hours, paused: false };
    } else if (action === "disable") {
      if (!cur) return { mind, action, changed: false, state: before, event_id: null };
      next = { ...before, enabled: false };
    } else {
      if (!cur) throw new ArgError(`dreaming was never enabled for mind "${mind}"; run: sanctum-mind dream enable --mind ${mind}`);
      if (action === "pause") next = { ...before, paused: true };
      else if (action === "resume") next = { ...before, paused: false };
      else next = { ...before, stage: (opts.stage as DreamStage | undefined) ?? before.stage };
    }
    if (cur && JSON.stringify(next) === JSON.stringify(before)) return { mind, action, changed: false, state: before, event_id: null };

    const ev = await c.query<{ id: string }>(
      `insert into events (mind_id, kind, payload, written_by, recorded_at, created_at)
       values ($1, $2, $3::jsonb, $1, now(), clock_timestamp()) returning id`,
      [mind, `daemon.dream.${action}`, JSON.stringify({ action, ...next, previous: cur ? before : null })],
    );
    const event_id = ev.rows[0]!.id;
    await c.query(
      `insert into dream_state (mind_id, enabled, stage, schedule, gap_hours, paused_at, updated_at, updated_event_id)
       values ($1, $2, $3, $4, $5, case when $6::boolean then now() end, now(), $7)
       on conflict (mind_id) do update set enabled = excluded.enabled, stage = excluded.stage, schedule = excluded.schedule, gap_hours = excluded.gap_hours,
         paused_at = case when excluded.paused_at is null then null else coalesce(dream_state.paused_at, excluded.paused_at) end,
         updated_at = excluded.updated_at, updated_event_id = excluded.updated_event_id`,
      [mind, next.enabled, next.stage, next.schedule, next.gap_hours, next.paused, event_id],
    );
    return { mind, action, changed: true, state: next, event_id };
  });
}

export interface DreamReport {
  mind: string;
  state: DreamStateView;
  all_time: { total: number; by_status: Record<string, number>; by_stage: Record<string, number> };
  last_30_days: { total: number; by_status: Record<string, number>; by_stage: Record<string, number> };
  /** Over dreams shown to the mind (stage propose): anchored / (anchored + released + faded); null until one is decided. */
  anchoring: { value: number | null; anchored: number; decided: number };
  /** The dreams the mind can see now, newest first, with their text (the operator runs the service; the report is for them). */
  waiting: Array<{ id: string; created_at: Date; fades_at: Date; content: string; question: string }>;
  /** What was laid at stage shadow in the last 30 days: what the mind WOULD have been shown. */
  shadow_last_30_days: Array<{ id: string; created_at: Date; content: string; question: string }>;
  /** The mind's own preference about who appears: "all", "none", or the count of named relations (the names are the mind's). */
  preference: "all" | "none" | number;
  last_run: { started_at: Date; ok: boolean; notes: Record<string, unknown> } | null;
}

async function countBy(c: PoolClient, mind: string, since: Date | null): Promise<DreamReport["all_time"]> {
  const r = await c.query<{ status: string; stage: string; n: string }>(
    `select status, stage, count(*) as n from dreams where mind_id = $1 and ($2::timestamptz is null or created_at >= $2) group by status, stage`,
    [mind, since],
  );
  const out = { total: 0, by_status: {} as Record<string, number>, by_stage: {} as Record<string, number> };
  for (const row of r.rows) {
    const n = Number(row.n);
    out.total += n;
    out.by_status[row.status] = (out.by_status[row.status] ?? 0) + n;
    out.by_stage[row.stage] = (out.by_stage[row.stage] ?? 0) + n;
  }
  return out;
}

export async function dreamReport(pool: Pool, mind: string): Promise<DreamReport> {
  if (!isValidMindId(mind)) throw new ArgError(mindIdProblem(mind));
  return inMind(pool, mind, async (c) => {
    const cur = (await c.query<DreamStateRow>("select * from dream_state where mind_id = $1", [mind])).rows[0];
    const state: DreamStateView = cur ? view(cur) : { enabled: false, stage: DEFAULT_DREAM_STAGE, schedule: DEFAULT_DREAM_SCHEDULE, gap_hours: DEFAULT_DREAM_GAP_HOURS, paused: false };
    const since = new Date(Date.now() - 30 * 86_400_000);
    const all_time = await countBy(c, mind, null);
    const last_30_days = await countBy(c, mind, since);
    const dec = await c.query<{ status: string; n: string }>(
      `select status, count(*) as n from dreams where mind_id = $1 and stage = 'propose' and status in ('anchored', 'released', 'faded') group by status`,
      [mind],
    );
    let anchored = 0;
    let decided = 0;
    for (const r of dec.rows) {
      decided += Number(r.n);
      if (r.status === "anchored") anchored = Number(r.n);
    }
    const waiting = (await c.query<{ id: string; created_at: Date; fades_at: Date; content: string; question: string }>(
      `select id, created_at, fades_at, content, question from dreams where mind_id = $1 and stage = 'propose' and status = 'laid' and fades_at > now() order by created_at desc limit 10`,
      [mind],
    )).rows;
    const shadow = (await c.query<{ id: string; created_at: Date; content: string; question: string }>(
      `select id, created_at, content, question from dreams where mind_id = $1 and stage = 'shadow' and created_at >= $2 order by created_at desc limit 10`,
      [mind, since],
    )).rows;
    const pref = (await c.query<{ relations: unknown }>(`select relations from dream_preferences where mind_id = $1`, [mind])).rows[0]?.relations;
    const preference: DreamReport["preference"] = pref === "none" ? "none" : Array.isArray(pref) ? pref.length : "all";
    const lr = (await c.query<{ started_at: Date; ok: boolean; notes: Record<string, unknown> }>(
      `select started_at, ok, notes from extractor_runs where mind_id = $1 and pass = 'dream.generate' order by started_at desc limit 1`,
      [mind],
    )).rows[0] ?? null;
    return { mind, state, all_time, last_30_days, anchoring: { value: decided > 0 ? anchored / decided : null, anchored, decided }, waiting, shadow_last_30_days: shadow, preference, last_run: lr };
  });
}

export function formatDreamChange(r: DreamChange): string {
  const s = r.state;
  const desc = `${s.enabled ? "enabled" : "disabled"}, stage ${s.stage}, schedule ${s.schedule}, at most one per ${s.gap_hours} h${s.paused ? ", paused" : ""}`;
  return r.changed ? `dreaming ${r.action} for ${r.mind}: now ${desc}` : `dreaming for ${r.mind} already ${desc}; nothing changed`;
}

export function formatDreamReport(r: DreamReport): string {
  const s = r.state;
  const status = (c: DreamReport["all_time"]) => (c.total === 0 ? "none" : Object.entries(c.by_status).sort().map(([k, v]) => `${k} ${v}`).join(", "));
  const pct = r.anchoring.value === null ? "n/a (none decided yet)" : `${(r.anchoring.value * 100).toFixed(1)}% (${r.anchoring.anchored} of ${r.anchoring.decided})`;
  const lines = [
    `dreaming for ${r.mind}: ${s.enabled ? "enabled" : "disabled"}, stage ${s.stage}, schedule ${s.schedule}, at most one per ${s.gap_hours} h${s.paused ? ", paused" : ""}`,
    `dreams laid: all time ${r.all_time.total} (${status(r.all_time)}); last 30 days ${r.last_30_days.total} (${status(r.last_30_days)})`,
    `anchored, of those shown and decided: ${pct}`,
    `who may appear (the mind's choice): ${r.preference === "all" ? "everyone" : r.preference === "none" ? "no one" : `${r.preference} named relation(s)`}`,
    `last run: ${r.last_run ? `${r.last_run.started_at.toISOString()} ${r.last_run.ok ? "ok" : "failed"} ${JSON.stringify(r.last_run.notes)}` : "never"}`,
  ];
  if (r.waiting.length > 0) {
    lines.push(`waiting for the mind (${r.waiting.length}):`);
    for (const d of r.waiting) lines.push(`  ${d.created_at.toISOString().slice(0, 10)}  ${d.content}${d.question ? `\n              ${d.question}` : ""}`);
  }
  if (r.shadow_last_30_days.length > 0) {
    lines.push(`laid at stage shadow in the last 30 days, never shown (${r.shadow_last_30_days.length}):`);
    for (const d of r.shadow_last_30_days) lines.push(`  ${d.created_at.toISOString().slice(0, 10)}  ${d.content}${d.question ? `\n              ${d.question}` : ""}`);
  }
  return lines.join("\n");
}

export async function runDreamCommand(pool: Pool, args: DreamArgs): Promise<string> {
  if (args.action === "report") {
    const r = await dreamReport(pool, args.mind);
    return args.json ? JSON.stringify(r, null, 2) : formatDreamReport(r);
  }
  const r = await setDreamState(pool, args.mind, args.action, {
    ...(args.stage === undefined ? {} : { stage: args.stage }),
    ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
    ...(args.gapHours === undefined ? {} : { gapHours: args.gapHours }),
  });
  return args.json ? JSON.stringify(r, null, 2) : formatDreamChange(r);
}
