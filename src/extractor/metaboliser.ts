// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { parseLastJson } from "../dream/dreamer.js";
import type { MetaboliserConfig } from "./metabolise_config.js";

/**
 * The metaboliser: one chat completion against an OpenAI-compatible endpoint, answering with a JSON object
 * `{"feelings": [...], "relations": [...]}`. The result says what happened, so the pass can tell an outage from a bad answer:
 * `answer` (proposals), `empty` (both arrays empty: a complete answer, the stretch is done with nothing proposed), `unusable` (the model
 * answered but with no JSON object or neither array: the stretch is marked failed with the note), and `unavailable` (network error,
 * timeout, non-2xx, empty body, or a throw: the stretch stays queued and the pass stops for this tick).
 */
export interface Metaboliser {
  readonly name: string;
  /** The model's name, for the run record. */
  readonly model: string;
  metabolise(system: string, user: string): Promise<MetaboliseResult>;
}

export type MetaboliseResult =
  | ({ kind: "answer" } & MetaboliseAnswer)
  | { kind: "empty" }
  | { kind: "unusable"; note: string }
  | { kind: "unavailable"; note: string };

export const FEELING_WEIGHTS = ["light", "medium", "heavy"] as const;
export type FeelingWeight = (typeof FEELING_WEIGHTS)[number];

export interface MetaboliseFeeling {
  emotion: string;
  weight: FeelingWeight;
  pillar: string;
  content: string;
}

export interface MetaboliseRelation {
  subject: string;
  note: string;
  alias?: string;
  warmth: boolean;
}

export interface MetaboliseAnswer {
  feelings: MetaboliseFeeling[];
  relations: MetaboliseRelation[];
}

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\u0000/g, "").trim();
  return s === "" || s.length > max ? null : s;
};

/**
 * Strict coercion: a malformed entry is dropped, never repaired. Null when the text holds no JSON object, or the object has
 * neither array (so a model that answered in prose is a failure and a model that answered `{"feelings": [], "relations": []}` is not).
 */
export function answerFrom(text: string): MetaboliseAnswer | null {
  const o = parseLastJson<{ feelings?: unknown; relations?: unknown }>(text);
  if (o === null || typeof o !== "object" || (!Array.isArray(o.feelings) && !Array.isArray(o.relations))) return null;
  const feelings: MetaboliseFeeling[] = [];
  for (const raw of Array.isArray(o.feelings) ? o.feelings : []) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const f = raw as Record<string, unknown>;
    const emotion = clean(f.emotion, 64);
    const content = clean(f.content, 4000);
    const weight = typeof f.weight === "string" ? f.weight.trim().toLowerCase() : "";
    const pillar = clean(f.pillar, 64); // a missing or empty pillar is absent, and the prompt asks for one: the entry is dropped
    if (emotion === null || content === null || pillar === null || !(FEELING_WEIGHTS as readonly string[]).includes(weight)) continue;
    feelings.push({ emotion, weight: weight as FeelingWeight, pillar, content });
  }
  const relations: MetaboliseRelation[] = [];
  for (const raw of Array.isArray(o.relations) ? o.relations : []) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    const subject = clean(r.subject, 200);
    const note = clean(r.note, 4000);
    if (subject === null || note === null) continue;
    const alias = clean(r.alias, 200);
    relations.push({ subject, note, ...(alias === null || alias.toLowerCase() === subject.toLowerCase() ? {} : { alias }), warmth: r.warmth === true });
  }
  return { feelings, relations };
}

export const NONE_METABOLISER: Metaboliser = {
  name: "none",
  model: "none",
  metabolise: async () => ({ kind: "unavailable", note: "METABOLISER=none" }),
};

export function httpMetaboliser(cfg: MetaboliserConfig, fetchImpl: typeof fetch = fetch): Metaboliser {
  let warned = false;
  return {
    name: "http",
    model: cfg.model,
    async metabolise(system, user) {
      try {
        const res = await fetchImpl(`${cfg.url}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            max_tokens: 1200,
            temperature: 0.4,
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
        const m = data?.choices?.[0]?.message;
        const text = m?.content?.trim() || m?.reasoning_content?.trim() || m?.reasoning?.trim() || "";
        if (text === "") throw new Error("empty response body");
        const a = answerFrom(text);
        if (a === null) return { kind: "unusable", note: "the metaboliser answered without a JSON object holding feelings or relations" };
        return a.feelings.length === 0 && a.relations.length === 0 ? { kind: "empty" } : { kind: "answer", ...a };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (!warned) {
          warned = true;
          console.warn(`[metabolise] the metaboliser at ${cfg.url} failed (${why}); stretches stay queued until it answers`);
        }
        return { kind: "unavailable", note: `the metaboliser was unavailable: ${why}` };
      }
    },
  };
}

export function metaboliserFrom(cfg: MetaboliserConfig): Metaboliser {
  return cfg.kind === "http" ? httpMetaboliser(cfg) : NONE_METABOLISER;
}
