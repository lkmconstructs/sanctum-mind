// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * The cooling period for declared identity changes (a rewrite of a core, the breaking of a vow).
 * `IDENTITY_COOLING_HOURS`: a non-negative integer number of hours, default 24; 0 means no cooling
 * (for solo use). Validated here; verbs receive the result through `RunDeps.coolingMs` / `VerbContext.coolingMs`.
 */
export const DEFAULT_COOLING_HOURS = 24;
const HOUR_MS = 3_600_000;

export function coolingMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IDENTITY_COOLING_HOURS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_COOLING_HOURS * HOUR_MS;
  const t = raw.trim();
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isSafeInteger(n) || n > 100_000) {
    throw new Error(`IDENTITY_COOLING_HOURS must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return n * HOUR_MS;
}

let cached: number | undefined;

/** The process-wide cooling period, read from the environment on first use. */
export function defaultCoolingMs(): number {
  return (cached ??= coolingMs());
}
