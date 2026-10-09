// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { parseArgs } from "node:util";
import type { Pool, PoolClient } from "pg";
import { isValidMindId, mindIdProblem } from "./auth.js";
import { ArgError } from "./cli-args.js";

/**
 * Operator administration of the extractor (CONTRACTS.md, "Noticing"). ADMIN ONLY: the app role can read
 * `extractor_state` and nothing more. The operator may enable, disable, pause, resume and choose the stage; no
 * operator action accepts a proposal. Every state change is a ledger event `daemon.extractor.<action>` written as
 * the mind, carrying the new state. This file is deliberately NOT under src/extractor/, which holds only the daemon passes.
 */

/** Printed when the connection is the unprivileged app role: changing the switch is an operator act on the admin URL. */
export const NEEDS_ADMIN = "extractor commands need the admin DATABASE_URL (the sanctum_app login can only read the extractor's state)";

export const EXTRACTOR_STAGES = ["shadow", "propose"] as const;
export type ExtractorStage = (typeof EXTRACTOR_STAGES)[number];
export const DEFAULT_STAGE: ExtractorStage = "shadow";
export const DEFAULT_SCHEDULE = "03:00";
const SCHEDULE_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export const EXTRACTOR_USAGE =
  "usage: sanctum-mind extractor enable --mind <id> [--stage shadow|propose] [--schedule HH:MM] [--json]\n" +
  "       sanctum-mind extractor disable|pause|resume --mind <id> [--json]\n" +
  "       sanctum-mind extractor stage --mind <id> --stage shadow|propose [--json]\n" +
  "       sanctum-mind extractor report --mind <id> [--json]";

export type ExtractorAction = "enable" | "disable" | "pause" | "resume" | "stage" | "report";
const ACTIONS: readonly ExtractorAction[] = ["enable", "disable", "pause", "resume", "stage", "report"];

export interface ExtractorArgs {
  action: ExtractorAction;
  mind: string;
  stage?: ExtractorStage;
  schedule?: string;
  json: boolean;
}

export function isExtractorStage(s: string): s is ExtractorStage {
  return (EXTRACTOR_STAGES as readonly string[]).includes(s);
}

export function parseExtractorArgs(argv: string[]): ExtractorArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { mind: { type: "string" }, stage: { type: "string" }, schedule: { type: "string" }, json: { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${EXTRACTOR_USAGE}`);
  }
  const { values, positionals } = parsed;
  const action = positionals[0] as ExtractorAction | undefined;
  if (action === undefined || !ACTIONS.includes(action)) {
    throw new ArgError(`extractor needs a subcommand: ${ACTIONS.join(", ")}\n${EXTRACTOR_USAGE}`);
  }
  if (positionals.length > 1) throw new ArgError(`unexpected argument "${positionals[1]}"\n${EXTRACTOR_USAGE}`);
  if (values.mind === undefined || values.mind === "") throw new ArgError(`--mind <id> is required\n${EXTRACTOR_USAGE}`);
  if (!isValidMindId(values.mind)) throw new ArgError(mindIdProblem(values.mind));
  if (values.stage !== undefined && action !== "enable" && action !== "stage") {
    throw new ArgError(`extractor ${action} does not take --stage\n${EXTRACTOR_USAGE}`);
  }
  if (values.schedule !== undefined && action !== "enable") {
    throw new ArgError(`extractor ${action} does not take --schedule\n${EXTRACTOR_USAGE}`);
  }
  const out: ExtractorArgs = { action, mind: values.mind, json: values.json === true };
  if (action === "stage" && values.stage === undefined) throw new ArgError(`--stage shadow|propose is required\n${EXTRACTOR_USAGE}`);
  if (values.stage !== undefined) {
    if (!isExtractorStage(values.stage)) {
      throw new ArgError(`invalid stage "${values.stage}" (allowed: ${EXTRACTOR_STAGES.join(", ")}); there is no other stage`);
    }
    out.stage = values.stage;
  }
  if (values.schedule !== undefined) {
    if (!SCHEDULE_RE.test(values.schedule)) throw new ArgError(`invalid schedule "${values.schedule}" (use HH:MM, 24-hour, service-local time)`);
    out.schedule = values.schedule;
  }
  return out;
}

export interface ExtractorStateRow {
  mind_id: string;
  enabled: boolean;
  stage: ExtractorStage;
  schedule: string;
  paused_at: Date | null;
  updated_at: Date;
  updated_event_id: string | null;
}

export interface ExtractorChange {
  mind: string;
  action: Exclude<ExtractorAction, "report">;
  /** false when the state already was as asked: nothing was written, no event */
  changed: boolean;
  state: { enabled: boolean; stage: ExtractorStage; schedule: string; paused: boolean };
  event_id: string | null;
}

/** Runs `fn` in one transaction carrying the mind's own scope, so row level security holds for an admin role that does not bypass it. */
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
    if (/permission denied/i.test(e instanceof Error ? e.message : "")) throw new ArgError(NEEDS_ADMIN);
    throw e;
  } finally {
    client.release();
  }
}

const view = (r: ExtractorStateRow) => ({ enabled: r.enabled, stage: r.stage, schedule: r.schedule, paused: r.paused_at !== null });

/**
 * Applies one operator action to the extractor of one mind. Enabling with no flags keeps an existing stage and
 * schedule (first enable: shadow at 03:00) and clears a pause. `pause`, `resume` and `stage` need an enabled-once
 * row. An action that would not change anything writes nothing (`changed: false`). A changing action writes the
 * state and the `daemon.extractor.<action>` event (written_by the mind) in one transaction.
 */
export async function setExtractorState(
  pool: Pool,
  mind: string,
  action: Exclude<ExtractorAction, "report">,
  opts: { stage?: string; schedule?: string } = {},
): Promise<ExtractorChange> {
  if (!isValidMindId(mind)) throw new ArgError(mindIdProblem(mind));
  if (opts.stage !== undefined && !isExtractorStage(opts.stage)) {
    throw new ArgError(`invalid stage "${opts.stage}" (allowed: ${EXTRACTOR_STAGES.join(", ")}); there is no other stage`);
  }
  if (opts.schedule !== undefined && !SCHEDULE_RE.test(opts.schedule)) throw new ArgError(`invalid schedule "${opts.schedule}" (use HH:MM)`);

  return inMind(pool, mind, async (c) => {
    const admin = await c.query<{ ok: boolean }>("select has_table_privilege(current_user, 'public.extractor_state', 'UPDATE') as ok");
    if (admin.rows[0]!.ok !== true) throw new ArgError(NEEDS_ADMIN);
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [`extractor:${mind}`]);
    const cur = (await c.query<ExtractorStateRow>("select * from extractor_state where mind_id = $1 for update", [mind])).rows[0];
    const off = { enabled: false, stage: DEFAULT_STAGE, schedule: DEFAULT_SCHEDULE, paused: false };
    const before = cur ? view(cur) : off;

    let next = { ...before };
    if (action === "enable") {
      next = { enabled: true, stage: (opts.stage as ExtractorStage | undefined) ?? before.stage, schedule: opts.schedule ?? before.schedule, paused: false };
    } else if (action === "disable") {
      if (!cur) return { mind, action, changed: false, state: before, event_id: null };
      next = { ...before, enabled: false };
    } else {
      if (!cur) throw new ArgError(`the extractor was never enabled for mind "${mind}"; run: sanctum-mind extractor enable --mind ${mind}`);
      if (action === "pause") next = { ...before, paused: true };
      else if (action === "resume") next = { ...before, paused: false };
      else next = { ...before, stage: (opts.stage as ExtractorStage | undefined) ?? before.stage };
    }
    if (cur && JSON.stringify(next) === JSON.stringify(before)) return { mind, action, changed: false, state: before, event_id: null };

    const ev = await c.query<{ id: string }>(
      `insert into events (mind_id, kind, payload, written_by, recorded_at, created_at)
       values ($1, $2, $3::jsonb, $1, now(), clock_timestamp()) returning id`,
      [mind, `daemon.extractor.${action}`, JSON.stringify({ action, ...next, previous: cur ? before : null })],
    );
    const event_id = ev.rows[0]!.id;
    await c.query(
      `insert into extractor_state (mind_id, enabled, stage, schedule, paused_at, updated_at, updated_event_id)
       values ($1, $2, $3, $4, case when $5::boolean then now() end, now(), $6)
       on conflict (mind_id) do update set enabled = excluded.enabled, stage = excluded.stage, schedule = excluded.schedule,
         paused_at = case when excluded.paused_at is null then null else coalesce(extractor_state.paused_at, excluded.paused_at) end,
         updated_at = excluded.updated_at, updated_event_id = excluded.updated_event_id`,
      [mind, next.enabled, next.stage, next.schedule, next.paused, event_id],
    );
    return { mind, action, changed: true, state: next, event_id };
  });
}

type Counts = { total: number; by_status: Record<string, number>; by_kind: Record<string, number>; by_stage: Record<string, number> };

export interface ExtractorReport {
  mind: string;
  state: { enabled: boolean; stage: string; schedule: string; paused: boolean };
  model_version: number;
  all_time: Counts;
  last_30_days: Counts;
  /** Over noticings shown to the mind (stage propose): accepted / (accepted + rejected + expired); null until one is decided. Shadow noticings are never shown, so they are not scored. */
  precision: { value: number | null; accepted: number; decided: number; last_30_days: number | null };
  /** What the extractor recorded at stage shadow in the last 30 days, by kind: what it WOULD have proposed. The mind never saw these. */
  shadow_last_30_days: { total: number; by_kind: Record<string, number> };
  /** Acceptance by kind over noticings shown to the mind (stage propose, all time): accepted / decided. rate is null until one is decided. */
  acceptance_by_kind: Record<string, { accepted: number; decided: number; rate: number | null }>;
  /** The latest model row (null while the hand-set prior, version 0, is in use). */
  model: { version: number; trained_on: number; created_at: Date; metrics: Record<string, number> } | null;
  /** Belief repair (kind repair), counted apart from the extractor's proposals above and below: those never include it. */
  repairs: RepairReport;
  /** The latest row of each scheduled pass in extractor_runs (null if it never ran). notes are counts and short reasons. */
  last_runs: Record<string, { started_at: Date; ok: boolean; notes: Record<string, unknown> } | null>;
}

export interface RepairReport {
  total: number;
  by_status: Record<string, number>;
  last_30_days: number;
  /** What the mind answered when it accepted a repair: keep, rethink or retire (counts). */
  decisions: { keep: number; rethink: number; retire: number };
  /** Share of decided repairs (accepted + rejected + expired) that went each way; null until one is decided. */
  rates: { keep: number | null; rethink: number | null; retire: number | null; rejected: number | null; expired: number | null };
  decided: number;
}

async function repairReport(c: PoolClient, mind: string, since: Date): Promise<RepairReport> {
  const st = await c.query<{ status: string; n: string; recent: string }>(
    `select status, count(*) as n, count(*) filter (where created_at >= $2) as recent from noticings where mind_id = $1 and kind = 'repair' group by status`,
    [mind, since],
  );
  const by_status: Record<string, number> = {};
  let total = 0;
  let recent = 0;
  for (const r of st.rows) {
    by_status[r.status] = Number(r.n);
    total += Number(r.n);
    recent += Number(r.recent);
  }
  const dec = await c.query<{ decision: string | null; n: string }>(
    `select d.payload->>'decision' as decision, count(*) as n
       from noticings n join events d on d.id = n.decided_event_id
      where n.mind_id = $1 and n.kind = 'repair' and n.status = 'accepted' group by 1`,
    [mind],
  );
  const decisions = { keep: 0, rethink: 0, retire: 0 };
  for (const r of dec.rows) if (r.decision === "keep" || r.decision === "rethink" || r.decision === "retire") decisions[r.decision] = Number(r.n);
  const decided = (by_status.accepted ?? 0) + (by_status.rejected ?? 0) + (by_status.expired ?? 0);
  const rate = (n: number): number | null => (decided >= 1 ? n / decided : null);
  return {
    total, by_status, last_30_days: recent, decisions, decided,
    rates: { keep: rate(decisions.keep), rethink: rate(decisions.rethink), retire: rate(decisions.retire), rejected: rate(by_status.rejected ?? 0), expired: rate(by_status.expired ?? 0) },
  };
}

const fmtRepairs = (r: RepairReport): string => {
  if (r.total === 0) return "none proposed";
  const p = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const status = Object.entries(r.by_status).sort().map(([k, v]) => `${k} ${v}`).join(", ");
  return `${r.total} total (${r.last_30_days} in the last 30 days); ${status}; decisions: keep ${r.decisions.keep} (${p(r.rates.keep)}), rethink ${r.decisions.rethink} (${p(r.rates.rethink)}), retire ${r.decisions.retire} (${p(r.rates.retire)}); rejected ${p(r.rates.rejected)}, expired ${p(r.rates.expired)} of ${r.decided} decided`;
};

async function counts(c: PoolClient, mind: string, since: Date | null): Promise<Counts> {
  const r = await c.query<{ status: string; kind: string; stage: string; n: string }>(
    `select status, kind, stage, count(*) as n from noticings
      where mind_id = $1 and kind <> 'repair' and ($2::timestamptz is null or created_at >= $2) group by status, kind, stage`,
    [mind, since],
  );
  const out: Counts = { total: 0, by_status: {}, by_kind: {}, by_stage: {} };
  for (const row of r.rows) {
    const n = Number(row.n);
    out.total += n;
    out.by_status[row.status] = (out.by_status[row.status] ?? 0) + n;
    out.by_kind[row.kind] = (out.by_kind[row.kind] ?? 0) + n;
    out.by_stage[row.stage] = (out.by_stage[row.stage] ?? 0) + n;
  }
  return out;
}

/**
 * Counts by status and kind (all time and the last 30 days); what shadow mode would have proposed per kind (30 days);
 * precision and per-kind acceptance over what the mind was shown; the latest model's version and held-out metrics; the last
 * run of each scheduled pass.
 */
export async function extractorReport(pool: Pool, mind: string, now: () => Date = () => new Date()): Promise<ExtractorReport> {
  if (!isValidMindId(mind)) throw new ArgError(mindIdProblem(mind));
  return inMind(pool, mind, async (c) => {
    const st = (await c.query<ExtractorStateRow>("select * from extractor_state where mind_id = $1", [mind])).rows[0];
    const mv = (await c.query<{ v: number | null }>("select max(version) as v from extractor_models where mind_id = $1", [mind])).rows[0]!.v;
    const since = new Date(now().getTime() - 30 * 86_400_000);
    const prec = async (from: Date | null) => {
      const r = await c.query<{ accepted: string; decided: string }>(
        `select count(*) filter (where status = 'accepted') as accepted,
                count(*) filter (where status in ('accepted', 'rejected', 'expired')) as decided
           from noticings where mind_id = $1 and kind <> 'repair' and stage = 'propose' and ($2::timestamptz is null or created_at >= $2)`,
        [mind, from],
      );
      const a = Number(r.rows[0]!.accepted);
      const d = Number(r.rows[0]!.decided);
      return { accepted: a, decided: d, value: d >= 1 ? a / d : null };
    };
    const all = await prec(null);
    const recent = await prec(since);
    const shadow = await c.query<{ kind: string; n: string }>(
      `select kind, count(*) as n from noticings where mind_id = $1 and stage = 'shadow' and created_at >= $2 group by kind`,
      [mind, since],
    );
    const shadowByKind: Record<string, number> = {};
    for (const r of shadow.rows) shadowByKind[r.kind] = Number(r.n);
    const kinds = await c.query<{ kind: string; accepted: string; decided: string }>(
      `select kind, count(*) filter (where status = 'accepted') as accepted,
              count(*) filter (where status in ('accepted', 'rejected', 'expired')) as decided
         from noticings where mind_id = $1 and kind <> 'repair' and stage = 'propose' group by kind`,
      [mind],
    );
    const acceptance: ExtractorReport["acceptance_by_kind"] = {};
    for (const r of kinds.rows) {
      const a = Number(r.accepted);
      const d = Number(r.decided);
      acceptance[r.kind] = { accepted: a, decided: d, rate: d >= 1 ? a / d : null };
    }
    const mrow = (
      await c.query<{ version: number; trained_on: number; created_at: Date; metrics: Record<string, number> }>(
        `select version, trained_on, created_at, metrics from extractor_models where mind_id = $1 order by version desc limit 1`,
        [mind],
      )
    ).rows[0];
    const last_runs: ExtractorReport["last_runs"] = {};
    for (const pass of ["notice.extract", "notice.train", "notice.repair"]) {
      const r = await c.query<{ started_at: Date; ok: boolean; notes: Record<string, unknown> }>(
        `select started_at, ok, notes from extractor_runs where mind_id = $1 and pass = $2 order by started_at desc limit 1`,
        [mind, pass],
      );
      last_runs[pass] = r.rows[0] ?? null;
    }
    return {
      shadow_last_30_days: { total: Object.values(shadowByKind).reduce((a, b) => a + b, 0), by_kind: shadowByKind },
      acceptance_by_kind: acceptance,
      model: mrow ?? null,
      last_runs,
      repairs: await repairReport(c, mind, since),
      mind,
      state: st ? view(st) : { enabled: false, stage: "off", schedule: DEFAULT_SCHEDULE, paused: false },
      model_version: mv ?? 0,
      all_time: await counts(c, mind, null),
      last_30_days: await counts(c, mind, since),
      precision: { value: all.value, accepted: all.accepted, decided: all.decided, last_30_days: recent.value },
    };
  });
}

const fmtCounts = (c: Counts): string => {
  const part = (m: Record<string, number>) => Object.entries(m).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  return `${c.total} total; status: ${part(c.by_status)}; kind: ${part(c.by_kind)}; stage: ${part(c.by_stage)}`;
};

const num = (v: unknown, digits = 3): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "n/a");
const runNote = (n: Record<string, unknown>): string => {
  if (n.skipped === true) return ` (skipped: ${String(n.reason ?? "")})`;
  if (typeof n.error === "string") return ` (failed: ${n.error})`;
  if (typeof n.proposed_total === "number") return ` (${n.proposed_total} proposed from ${String(n.candidates ?? "?")} candidate(s), reranker ${String(n.reranker ?? "?")})`;
  if (n.trained === false) return ` (not trained: ${String(n.reason ?? "")})`;
  if (n.trained === true) return ` (trained version ${String(n.version)})`;
  if (typeof n.upstreams === "number") return ` (${String(n.proposed)} proposed for ${String(n.dependants)} dependant(s) of ${n.upstreams} changed node(s))`;
  return "";
};

export function formatExtractorReport(r: ExtractorReport): string {
  const s = r.state;
  const pct = (v: number | null) => (v === null ? "n/a (nothing decided yet)" : `${(v * 100).toFixed(1)}%`);
  return [
    `extractor for ${r.mind}: ${s.enabled ? "enabled" : "disabled"}, stage ${s.stage}, schedule ${s.schedule}${s.paused ? ", paused" : ""}; model version ${r.model_version}`,
    `all time:     ${fmtCounts(r.all_time)}`,
    `last 30 days: ${fmtCounts(r.last_30_days)}`,
    `precision (shown to the mind, accepted / decided): ${pct(r.precision.value)} (${r.precision.accepted} of ${r.precision.decided}); last 30 days ${pct(r.precision.last_30_days)}`,
    `repairs (counted apart): ${fmtRepairs(r.repairs)}`,
    `acceptance by kind (shown to the mind): ${
      Object.entries(r.acceptance_by_kind).sort().map(([k, v]) => `${k} ${v.rate === null ? "n/a" : `${(v.rate * 100).toFixed(1)}%`} (${v.accepted} of ${v.decided})`).join(", ") || "nothing shown yet"
    }`,
    `shadow, last 30 days (recorded, never shown): would have proposed ${r.shadow_last_30_days.total}${
      r.shadow_last_30_days.total > 0 ? ` (${Object.entries(r.shadow_last_30_days.by_kind).sort().map(([k, v]) => `${k} ${v}`).join(", ")})` : ""
    }`,
    r.model === null
      ? "model: version 0, the hand-set prior (no refit yet: it needs 30 decided noticings, 5 accepted and 5 not)"
      : `model: version ${r.model.version}, fit on ${r.model.trained_on}; held-out precision at 5 ${num(r.model.metrics.precision_at_5)}, log loss ${num(r.model.metrics.log_loss)} (n=${num(r.model.metrics.n, 0)}); before it ${num(r.model.metrics.previous_precision_at_5)} and ${num(r.model.metrics.previous_log_loss)}`,
    ...Object.entries(r.last_runs).map(([pass, run]) => `last ${pass}: ${run === null ? "never" : `${run.started_at.toISOString()} ${run.ok ? "ok" : "not ok"}${runNote(run.notes)}`}`),
  ].join("\n");
}

export function formatExtractorChange(r: ExtractorChange): string {
  const s = r.state;
  const desc = `${s.enabled ? "enabled" : "disabled"}, stage ${s.stage}, schedule ${s.schedule}${s.paused ? ", paused" : ""}`;
  return r.changed ? `extractor ${r.action} for ${r.mind}: now ${desc}` : `extractor for ${r.mind} already ${desc}; nothing changed`;
}

/** Runs a parsed `extractor` command against an admin pool and returns the text (or JSON) to print. */
export async function runExtractorCommand(pool: Pool, args: ExtractorArgs): Promise<string> {
  if (args.action === "report") {
    const r = await extractorReport(pool, args.mind);
    return args.json ? JSON.stringify(r, null, 2) : formatExtractorReport(r);
  }
  const r = await setExtractorState(pool, args.mind, args.action, {
    ...(args.stage === undefined ? {} : { stage: args.stage }),
    ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
  });
  return args.json ? JSON.stringify(r, null, 2) : formatExtractorChange(r);
}
