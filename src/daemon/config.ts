// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * Daemon thresholds. Defaults are constants; each can be overridden by a `DAEMON_*` env var, validated
 * as a positive integer. The env is read once (getDaemonConfig caches); tests override through the
 * `config` option of runDaemonOnce, which goes through the same validation.
 */
export interface DaemonConfig {
  /** drives.decay: persist a lane when any of its drive rows is older than this many hours */
  decayStaleHours: number;
  /** loops.stale: a nagging loop open longer than this many days is flagged */
  loopStaleDays: number;
  /** loops.stale: at most one event per loop in this many days */
  loopRenotifyDays: number;
  /** holdings.settle: active or processing holdings untouched this many days become deferred */
  holdingSettleDays: number;
  /** desires.fade: unfulfilled desires older than this many days fade */
  desireFadeDays: number;
  /** graph.orphans: observation nodes older than this many days with no edges are reported */
  orphanAgeDays: number;
  /** graph.orphans: at most one event per node in this many days */
  orphanRenotifyDays: number;
  /** graph.orphans: at most this many events per run (oldest nodes first) */
  orphanBatch: number;
  /** embeddings.backfill: rows embedded per run (events and nodes together) */
  backfillRows: number;
  /** letters.expire: unread letters older than this many days age */
  letterAgingDays: number;
  /** letters.expire: at most one event per letter in this many days */
  letterRenotifyDays: number;
}

export const DEFAULT_DAEMON_CONFIG: Readonly<DaemonConfig> = Object.freeze({
  decayStaleHours: 1,
  loopStaleDays: 14,
  loopRenotifyDays: 7,
  holdingSettleDays: 30,
  desireFadeDays: 60,
  orphanAgeDays: 7,
  orphanRenotifyDays: 30,
  orphanBatch: 500,
  backfillRows: 256,
  letterAgingDays: 90,
  letterRenotifyDays: 30,
});

const ENV_NAMES: Record<keyof DaemonConfig, string> = {
  decayStaleHours: "DAEMON_DECAY_STALE_HOURS",
  loopStaleDays: "DAEMON_LOOP_STALE_DAYS",
  loopRenotifyDays: "DAEMON_LOOP_RENOTIFY_DAYS",
  holdingSettleDays: "DAEMON_HOLDING_SETTLE_DAYS",
  desireFadeDays: "DAEMON_DESIRE_FADE_DAYS",
  orphanAgeDays: "DAEMON_ORPHAN_AGE_DAYS",
  orphanRenotifyDays: "DAEMON_ORPHAN_RENOTIFY_DAYS",
  orphanBatch: "DAEMON_ORPHAN_BATCH",
  backfillRows: "DAEMON_BACKFILL_ROWS",
  letterAgingDays: "DAEMON_LETTER_AGING_DAYS",
  letterRenotifyDays: "DAEMON_LETTER_RENOTIFY_DAYS",
};

const KEYS = Object.keys(ENV_NAMES) as Array<keyof DaemonConfig>;

function positiveInt(label: string, v: unknown): number {
  const n = typeof v === "string" ? (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > 1_000_000) {
    throw new Error(`${label} must be a positive integer (got ${JSON.stringify(v)})`);
  }
  return n;
}

/** Defaults overlaid with `DAEMON_*` from `env`. Throws on a value that is not a positive integer. */
export function loadDaemonConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const out: DaemonConfig = { ...DEFAULT_DAEMON_CONFIG };
  for (const k of KEYS) {
    const raw = env[ENV_NAMES[k]];
    if (raw !== undefined && raw.trim() !== "") out[k] = positiveInt(ENV_NAMES[k], raw);
  }
  return out;
}

let cached: DaemonConfig | undefined;

/** The process-wide config, read from the environment on first use. */
export function getDaemonConfig(): DaemonConfig {
  return (cached ??= loadDaemonConfig());
}

/** The process-wide config with validated overrides on top. */
export function resolveDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  const out: DaemonConfig = { ...getDaemonConfig() };
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (!(KEYS as string[]).includes(k)) throw new Error(`unknown daemon config key ${k}`);
    if (v !== undefined) out[k as keyof DaemonConfig] = positiveInt(k, v);
  }
  return out;
}
