// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/** `METABOLISE_TIMEOUT_MS`: how long one model call may take. Default 90000. */
export const DEFAULT_METABOLISE_TIMEOUT_MS = 90_000;
/** The prompt's version, carried on every metabolised proposal (payload.prompt_version) so a changed prompt is visible. */
export const METABOLISE_PROMPT_VERSION = 3;
/** Stretches worked on per tick: the oldest queued first. */
export const METABOLISE_BATCH = 3;
/** A stretch still queued after this many days is marked failed ("expired unprocessed"): a conversation that old is no longer fresh. */
export const METABOLISE_EXPIRY_DAYS = 7;
/** The most proposals of each kind one stretch may produce. */
export const METABOLISE_MAX_PER_KIND = 5;

function positiveInt(env: NodeJS.ProcessEnv, name: string, dflt: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  if (!/^[1-9][0-9]{0,6}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a whole number from 1 to ${max} (got "${raw}")`);
  return Number(raw);
}

export const metaboliseTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => positiveInt(env, "METABOLISE_TIMEOUT_MS", DEFAULT_METABOLISE_TIMEOUT_MS, 600_000);

export type MetaboliserKind = "none" | "http";

export interface MetaboliserConfig {
  kind: MetaboliserKind;
  /** OpenAI-compatible base URL (…/v1); the pass posts to <url>/chat/completions. */
  url: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
}

/**
 * `METABOLISER=none|http` (default none: the pass skips with a note and the stretches stay queued). `http` needs `METABOLISE_URL`
 * and `METABOLISE_MODEL`; `METABOLISE_API_KEY` is sent as a bearer when set. Any OpenAI-compatible chat endpoint works (a local
 * Ollama, Ollama Cloud, OpenRouter).
 */
export function metaboliserConfig(env: NodeJS.ProcessEnv = process.env): MetaboliserConfig {
  const kind = (env.METABOLISER ?? "none").trim();
  if (kind !== "none" && kind !== "http") throw new Error(`METABOLISER must be none or http (got "${env.METABOLISER}")`);
  const url = (env.METABOLISE_URL ?? "").trim().replace(/\/+$/, "");
  const model = (env.METABOLISE_MODEL ?? "").trim();
  if (kind === "http") {
    if (!/^https?:\/\//.test(url)) throw new Error("METABOLISER=http needs METABOLISE_URL (an http(s) OpenAI-compatible base URL ending in /v1)");
    if (model === "") throw new Error("METABOLISER=http needs METABOLISE_MODEL");
  }
  const apiKey = (env.METABOLISE_API_KEY ?? "").trim();
  return { kind, url, model, apiKey: apiKey === "" ? null : apiKey, timeoutMs: metaboliseTimeoutMs(env) };
}

/** What `sanctum-mind` checks at start: every METABOLISE* value parses. Throws with the first problem. */
export function checkMetaboliseEnv(env: NodeJS.ProcessEnv = process.env): void {
  metaboliserConfig(env);
}
