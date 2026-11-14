// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { DreamerConfig } from "./config.js";

/**
 * The dreamer: one chat completion against an OpenAI-compatible endpoint, answering with a JSON object. The same "one
 * warning, null on failure" posture as the embedder and the reranker: the pass records a skip or a failure and tries again
 * the next day; nothing is written when the model is silent.
 *
 * `parseLastJson` is adapted from lantern-thalamus/src/qwen.ts (Nana & Vex, PolyForm Noncommercial 1.0.0): it walks the
 * answer for balanced top-level objects, string-aware (a brace inside a string moves nothing), and returns the last one
 * that parses, so a reasoning model that thinks out loud before its answer still lands.
 */
export interface Dreamer {
  readonly name: string;
  /** The model's name for the ledger's `model_version`. */
  readonly model: string;
  dream(system: string, user: string): Promise<DreamAnswer | null>;
}

export interface DreamAnswer {
  dream: string;
  question: string;
}

export function parseLastJson<T>(text: string): T | null {
  const objs: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objs.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (let i = objs.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(objs[i]!) as T;
    } catch {
      /* not this one; keep walking back */
    }
  }
  return null;
}

// "content" is a letter, a combining mark (abugida scripts keep vowels in marks) or a number; a word token is a maximal run of them
const contentCount = (s: string): number => (s.match(/[\p{L}\p{M}\p{N}]/gu) ?? []).length;
const tokenCount = (s: string): number => (s.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).length;
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MIN_DREAM_CONTENT = 12;
const MIN_DREAM_TOKENS = 3;

/**
 * A dream and a question, or null when the answer carries no usable dream. After trimming, a dream needs at least 12 content
 * code points (letters, combining marks, numbers) and at least 3 word tokens; text with a Han, Hiragana, Katakana or Hangul
 * character, which is written without spaces, needs only the 12. That refuses placeholders ("...", "{}", "d", one word) and
 * not short dreams. The question may legitimately be absent: with no content code point it becomes ''.
 */
export function answerFrom(text: string): DreamAnswer | null {
  const o = parseLastJson<{ dream?: unknown; question?: unknown }>(text);
  if (!o || typeof o.dream !== "string") return null;
  const dream = o.dream.trim();
  if (contentCount(dream) < MIN_DREAM_CONTENT) return null;
  if (tokenCount(dream) < MIN_DREAM_TOKENS && !UNSPACED.test(dream)) return null;
  const question = typeof o.question === "string" ? o.question.trim() : "";
  return { dream, question: contentCount(question) < 1 ? "" : question };
}

export const NONE_DREAMER: Dreamer = {
  name: "none",
  model: "none",
  dream: async () => null,
};

export function httpDreamer(cfg: DreamerConfig, fetchImpl: typeof fetch = fetch): Dreamer {
  let warned = false;
  return {
    name: "http",
    model: cfg.model,
    async dream(system, user) {
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
            temperature: 0.9,
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
        const m = data?.choices?.[0]?.message;
        const text = m?.content?.trim() || m?.reasoning_content?.trim() || m?.reasoning?.trim() || "";
        return text === "" ? null : answerFrom(text);
      } catch (e) {
        if (!warned) {
          warned = true;
          console.warn(`[dream] the dreamer at ${cfg.url} failed (${e instanceof Error ? e.message : String(e)}); dreams are skipped until it answers`);
        }
        return null;
      }
    },
  };
}

export function dreamerFrom(cfg: DreamerConfig): Dreamer {
  return cfg.kind === "http" ? httpDreamer(cfg) : NONE_DREAMER;
}
