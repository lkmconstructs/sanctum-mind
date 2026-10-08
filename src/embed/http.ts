// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { Embedder } from "../verbs/types.js";

/** OpenAI-compatible embeddings endpoint: POST { input: [texts] } -> { data: [{ embedding: [floats] }] }. */
export function httpEmbedder(
  url: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Embedder {
  // Failures are logged at most once a minute, so an outage stays visible without flooding the log.
  let lastWarn = -Infinity;
  const warn = (msg: string) => {
    const t = now();
    if (t - lastWarn < 60_000) return;
    lastWarn = t;
    console.error(`sanctum-mind: http embedder: ${msg}`);
  };
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "invalid-url";
    }
  })();
  return {
    name: `http:${host}`,
    dim: 384,
    async embed(texts) {
      const nulls = () => texts.map(() => null);
      if (texts.length === 0) return [];
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ input: texts }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          warn(`status ${res.status}`);
          return nulls();
        }
        const body = (await res.json()) as { data?: Array<{ embedding?: unknown; index?: unknown }> };
        const data = body.data;
        if (!Array.isArray(data) || data.length !== texts.length) {
          warn("unexpected response shape");
          return nulls();
        }
        // Honour the OpenAI `index` field when every item carries one (servers may reorder a batch);
        // otherwise the response order is the input order.
        const indexed = data.every((d) => typeof d?.index === "number");
        const out: Array<Float32Array | null> = texts.map(() => null);
        const seen = new Set<number>();
        for (let i = 0; i < data.length; i++) {
          const d = data[i];
          const e = d?.embedding;
          if (!Array.isArray(e) || e.length !== 384 || !e.every((x) => typeof x === "number" && Number.isFinite(x))) {
            warn(`dimension mismatch (expected 384, got ${Array.isArray(e) ? e.length : "none"})`);
            return nulls();
          }
          const slot = indexed ? (d!.index as number) : i;
          if (!Number.isInteger(slot) || slot < 0 || slot >= texts.length || seen.has(slot)) {
            warn("unexpected response shape (bad index)");
            return nulls();
          }
          seen.add(slot);
          out[slot] = Float32Array.from(e as number[]);
        }
        return out;
      } catch (e) {
        warn(e instanceof Error ? e.message : String(e));
        return nulls();
      }
    },
  };
}
