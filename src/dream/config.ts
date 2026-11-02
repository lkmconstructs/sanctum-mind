// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/** `DREAM_TTL_DAYS`: how long a laid dream waits for the mind before it fades. A positive integer; default 7. */
export const DEFAULT_DREAM_TTL_DAYS = 7;
/** `DREAM_WINDOW_HOURS`: how far back the residue reaches. 1 to 168; default 36. */
export const DEFAULT_DREAM_WINDOW_HOURS = 36;
/** `DREAM_TIMEOUT_MS`: how long one model call may take. Default 90000. */
export const DEFAULT_DREAM_TIMEOUT_MS = 90_000;
/** The prompt's version, part of every dream's `model_version` so a changed prompt is visible in the ledger. */
export const DREAM_PROMPT_VERSION = 1;

function positiveInt(env: NodeJS.ProcessEnv, name: string, dflt: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return dflt;
  if (!/^[1-9][0-9]{0,6}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a whole number from 1 to ${max} (got "${raw}")`);
  return Number(raw);
}

export const dreamTtlDays = (env: NodeJS.ProcessEnv = process.env): number => positiveInt(env, "DREAM_TTL_DAYS", DEFAULT_DREAM_TTL_DAYS, 3650);
export const dreamWindowHours = (env: NodeJS.ProcessEnv = process.env): number => positiveInt(env, "DREAM_WINDOW_HOURS", DEFAULT_DREAM_WINDOW_HOURS, 168);
export const dreamTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number => positiveInt(env, "DREAM_TIMEOUT_MS", DEFAULT_DREAM_TIMEOUT_MS, 600_000);

/** The `fades_at` for a dream laid at `now`. */
export function dreamFadesAt(now: Date, env: NodeJS.ProcessEnv = process.env): Date {
  return new Date(now.getTime() + dreamTtlDays(env) * 86_400_000);
}

export type DreamerKind = "none" | "http";

export interface DreamerConfig {
  kind: DreamerKind;
  /** OpenAI-compatible base URL (…/v1); the pass posts to <url>/chat/completions. */
  url: string;
  model: string;
  apiKey: string | null;
  timeoutMs: number;
}

/**
 * `DREAMER=none|http` (default none: the pass skips with a note). `http` needs `DREAM_URL` and `DREAM_MODEL`; `DREAM_API_KEY` is
 * sent as a bearer when set. A local Ollama (`http://127.0.0.1:11434/v1`), Ollama Cloud (`https://ollama.com/v1`) or OpenRouter
 * (`https://openrouter.ai/api/v1`, where a preset slug works as the model) all speak this shape.
 */
export function dreamerConfig(env: NodeJS.ProcessEnv = process.env): DreamerConfig {
  const kind = (env.DREAMER ?? "none").trim();
  if (kind !== "none" && kind !== "http") throw new Error(`DREAMER must be none or http (got "${env.DREAMER}")`);
  const url = (env.DREAM_URL ?? "").trim().replace(/\/+$/, "");
  const model = (env.DREAM_MODEL ?? "").trim();
  if (kind === "http") {
    if (!/^https?:\/\//.test(url)) throw new Error("DREAMER=http needs DREAM_URL (an http(s) OpenAI-compatible base URL ending in /v1)");
    if (model === "") throw new Error("DREAMER=http needs DREAM_MODEL");
  }
  const apiKey = (env.DREAM_API_KEY ?? "").trim();
  return { kind, url, model, apiKey: apiKey === "" ? null : apiKey, timeoutMs: dreamTimeoutMs(env) };
}

/** What `sanctum-mind` checks at start: every DREAM_* value parses. Throws with the first problem. */
export function checkDreamEnv(env: NodeJS.ProcessEnv = process.env): void {
  dreamTtlDays(env);
  dreamWindowHours(env);
  dreamerConfig(env);
}
