import type { Pool } from "pg";
import { withMind } from "../db/pool.js";
import { registry } from "../verbs/registry.js";
import type { Embedder } from "../verbs/types.js";
import type { SinkConfig } from "../sinks/types.js";
import { getDaemonConfig, resolveDaemonConfig, type DaemonConfig } from "./config.js";
import { defaultCoolingMs } from "../verbs/cooling.js";
import { PASSES, type AnyPass, type PassContext } from "./passes/index.js";
import { isDetached } from "./passes/types.js";

export { getDaemonConfig, loadDaemonConfig, resolveDaemonConfig, type DaemonConfig } from "./config.js";
export { PASSES, type AnyPass, type DaemonPass, type DetachedPass, type PassContext, type PassResult } from "./passes/index.js";

export interface DaemonDeps {
  /** the app-role pool (never a superuser: row level security must apply) */
  pool: Pool;
  embedder: Embedder;
  /** outbox sinks the outbox.deliver pass delivers to; default none */
  sinks?: SinkConfig[];
  coolingMs?: number;
  now?: () => Date;
}

export interface RunOptions {
  trigger: "timer" | "manual";
  /** restrict the run to these mind ids; default every enabled mind */
  minds?: string[];
  /** threshold overrides for this run (tests); validated like the env */
  config?: Partial<DaemonConfig>;
  /** replaces the built-in pass list (tests inject a throwing pass) */
  passes?: readonly AnyPass[];
}

export interface PassReport {
  pass: string;
  ok: boolean;
  changed: number;
  ms: number;
  error?: string;
  notes?: string[];
}

export interface RunReport {
  /** "*" for a run-level failure that happened before any mind was reached */
  mind_id: string;
  run_id: string | null;
  started_at: Date;
  finished_at: Date;
  /** true when every pass of this mind was ok and the run was recorded */
  ok: boolean;
  passes: PassReport[];
  error?: string;
}

/** A message safe to store and show: no SQL, no row data, bounded. The full error goes to the log. */
function sanitise(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  if (/^[0-9A-Z]{5}$/.test(code)) return `database error ${code}`;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) || "pass failed";
}

async function runPass(
  deps: DaemonDeps,
  mind: string,
  pass: AnyPass,
  config: DaemonConfig,
  now: () => Date,
): Promise<PassReport> {
  const t0 = performance.now();
  try {
    // a detached pass (outbox delivery) runs with no transaction and no advisory lock open
    const result = isDetached(pass)
      ? await pass.run({ pool: deps.pool, mind_id: mind, now, sinks: deps.sinks ?? [], config })
      : await withMind(deps.pool, mind, mind, "write", async (tx) => {
      // Two daemons never overlap on one mind; the second waits for the first pass to commit.
      await tx.query("select pg_advisory_xact_lock(hashtext('daemon:' || $1::text))", [mind]);
      const ctx: PassContext = {
        caller: { bearer: mind, grants: {} },
        mind_id: mind,
        tx,
        now,
        registry,
        embedder: deps.embedder,
        sinks: deps.sinks ?? [],
        coolingMs: deps.coolingMs ?? defaultCoolingMs(),
        config,
      };
      return pass.run(ctx);
    });
    return {
      pass: pass.name,
      ok: true,
      changed: result.changed,
      ms: Math.round(performance.now() - t0),
      ...(result.notes && result.notes.length > 0 ? { notes: result.notes } : {}),
    };
  } catch (e) {
    console.error(`daemon: pass ${pass.name} failed for mind ${mind}:`, e);
    return { pass: pass.name, ok: false, changed: 0, ms: Math.round(performance.now() - t0), error: sanitise(e) };
  }
}

async function runMind(
  deps: DaemonDeps,
  mind: string,
  opts: RunOptions,
  config: DaemonConfig,
  now: () => Date,
): Promise<RunReport> {
  const started_at = now();
  let run_id: string | null = null;
  try {
    run_id = await withMind(deps.pool, mind, mind, "write", async (tx) => {
      const r = await tx.query<{ id: string }>(
        `insert into daemon_runs (mind_id, started_at, trigger) values ($1, $2, $3) returning id`,
        [mind, started_at, opts.trigger],
      );
      return r.rows[0]!.id;
    });
  } catch (e) {
    console.error(`daemon: could not record the run for mind ${mind}:`, e);
    return { mind_id: mind, run_id: null, started_at, finished_at: now(), ok: false, passes: [], error: sanitise(e) };
  }

  const passes: PassReport[] = [];
  for (const pass of opts.passes ?? PASSES) passes.push(await runPass(deps, mind, pass, config, now));

  const finished_at = now();
  const stored = passes.map(({ pass, ok, changed, ms, error }) => ({ pass, ok, changed, ms, ...(error ? { error } : {}) }));
  try {
    await withMind(deps.pool, mind, mind, "write", async (tx) => {
      await tx.query(`update daemon_runs set finished_at = $2, passes = $3::jsonb where id = $1 and mind_id = $4`, [
        run_id,
        finished_at,
        JSON.stringify(stored),
        mind,
      ]);
    });
  } catch (e) {
    console.error(`daemon: could not finish the run record for mind ${mind}:`, e);
    return { mind_id: mind, run_id, started_at, finished_at, ok: false, passes, error: sanitise(e) };
  }
  return { mind_id: mind, run_id, started_at, finished_at, ok: passes.every((p) => p.ok), passes };
}

/**
 * One pass set for every enabled mind (or `opts.minds`), sequentially. One transaction per (mind, pass),
 * so a failing pass rolls back only itself. Never throws: failures are in the reports (`ok: false`).
 */
export async function runDaemonOnce(deps: DaemonDeps, opts: RunOptions): Promise<RunReport[]> {
  const now = deps.now ?? (() => new Date());
  const wholeRunFailure = (e: unknown): RunReport[] => {
    console.error("daemon: run failed:", e);
    const at = now();
    return [{ mind_id: "*", run_id: null, started_at: at, finished_at: at, ok: false, passes: [], error: sanitise(e) }];
  };
  try {
    const config = resolveDaemonConfig(opts.config);
    const listed = await deps.pool.query<{ mind_id: string }>(
      `select mind_id from minds where disabled_at is null order by mind_id`,
    );
    const wanted = opts.minds ? new Set(opts.minds) : null;
    const minds = listed.rows.map((r) => r.mind_id).filter((m) => wanted === null || wanted.has(m));
    const reports: RunReport[] = [];
    for (const mind of minds) {
      try {
        reports.push(await runMind(deps, mind, opts, config, now));
      } catch (e) {
        reports.push(...wholeRunFailure(e).map((r) => ({ ...r, mind_id: mind })));
      }
    }
    return reports;
  } catch (e) {
    return wholeRunFailure(e);
  }
}

export interface StartOptions {
  /** minutes between ticks; default 30 */
  intervalMinutes?: number;
  minds?: string[];
  config?: Partial<DaemonConfig>;
  /** called after every tick with its reports */
  onRun?: (reports: RunReport[]) => void;
}

export interface DaemonHandle {
  /** stops scheduling and waits for a tick in flight */
  stop(): Promise<void>;
}

/**
 * Runs the daemon now and then every `intervalMinutes`, with trigger 'timer'. A tick that fires while the
 * previous is still running is skipped. Throws at once on an invalid DAEMON_* environment.
 */
export function startDaemon(deps: DaemonDeps, opts: StartOptions = {}): DaemonHandle {
  const minutes = opts.intervalMinutes ?? 30;
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("intervalMinutes must be a positive number");
  getDaemonConfig(); // fail fast on a bad environment, before the first tick
  resolveDaemonConfig(opts.config);

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;

  const tick = (): void => {
    if (stopped || inFlight) return; // previous tick still running: skip
    inFlight = runDaemonOnce(deps, {
      trigger: "timer",
      ...(opts.minds ? { minds: opts.minds } : {}),
      ...(opts.config ? { config: opts.config } : {}),
    })
      .then((reports) => {
        try {
          opts.onRun?.(reports);
        } catch (e) {
          console.error("daemon: onRun threw:", e);
        }
      })
      .finally(() => {
        inFlight = null;
        if (!stopped) timer = setTimeout(tick, minutes * 60_000);
      });
  };
  tick();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
