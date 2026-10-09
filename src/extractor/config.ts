// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/** `EXTRACTOR_TTL_DAYS`: how long a proposal may wait for the mind before it expires. A positive integer; default 14. */
export const DEFAULT_EXTRACTOR_TTL_DAYS = 14;

export function extractorTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXTRACTOR_TTL_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_EXTRACTOR_TTL_DAYS;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw new Error(`EXTRACTOR_TTL_DAYS must be a positive whole number of days (got "${raw}")`);
  return Number(raw);
}

/** The `expires_at` for a proposal made at `now`. The extract pass calls this when it inserts. */
export function noticingExpiresAt(now: Date, env: NodeJS.ProcessEnv = process.env): Date {
  return new Date(now.getTime() + extractorTtlDays(env) * 86_400_000);
}

/** `EXTRACTOR_REPROPOSE_DAYS`: how long after a proposal expired the same sources may be proposed again (and only if the score rose). Default 60. */
export const DEFAULT_EXTRACTOR_REPROPOSE_DAYS = 60;

export function extractorReproposeDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXTRACTOR_REPROPOSE_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_EXTRACTOR_REPROPOSE_DAYS;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw new Error(`EXTRACTOR_REPROPOSE_DAYS must be a positive whole number of days (got "${raw}")`);
  return Number(raw);
}

/** `EXTRACTOR_MAX_CANDIDATES`: candidates kept per kind per run, before reranking. A positive integer up to 500; default 50. */
export const DEFAULT_EXTRACTOR_MAX_CANDIDATES = 50;

export function extractorMaxCandidates(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXTRACTOR_MAX_CANDIDATES;
  if (raw === undefined || raw === "") return DEFAULT_EXTRACTOR_MAX_CANDIDATES;
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 500) throw new Error(`EXTRACTOR_MAX_CANDIDATES must be a whole number from 1 to 500 (got "${raw}")`);
  return Number(raw);
}

/**
 * `EXTRACTOR_LOOKBACK_DAYS`: how far back the extractor compares new memories against older live ones (a link between a node from
 * three weeks ago and one from today; a pattern across several days). Rows since the last successful run are the NEW ones; every
 * candidate must contain at least one. A positive whole number up to 365; default 30.
 */
export const DEFAULT_EXTRACTOR_LOOKBACK_DAYS = 30;

export function extractorLookbackDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXTRACTOR_LOOKBACK_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_EXTRACTOR_LOOKBACK_DAYS;
  if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 365) throw new Error(`EXTRACTOR_LOOKBACK_DAYS must be a whole number of days from 1 to 365 (got "${raw}")`);
  return Number(raw);
}

/**
 * `EXTRACTOR_REPAIR_BUDGET`: the most new repair proposals `notice.repair` makes in one tick, across every upstream node it works through
 * (a node with many dependants is continued on the next tick). A positive whole number up to 10000; default 50.
 */
export const DEFAULT_EXTRACTOR_REPAIR_BUDGET = 50;

export function extractorRepairBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.EXTRACTOR_REPAIR_BUDGET;
  if (raw === undefined || raw === "") return DEFAULT_EXTRACTOR_REPAIR_BUDGET;
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > 10000) throw new Error(`EXTRACTOR_REPAIR_BUDGET must be a whole number from 1 to 10000 (got "${raw}")`);
  return Number(raw);
}

/** Validates every EXTRACTOR_* variable; throws on the first bad one. The daemon calls it at start so a typo stops the service, not a night's run. */
export function checkExtractorEnv(env: NodeJS.ProcessEnv = process.env): void {
  extractorTtlDays(env);
  extractorReproposeDays(env);
  extractorMaxCandidates(env);
  extractorLookbackDays(env);
  extractorRepairBudget(env);
}
