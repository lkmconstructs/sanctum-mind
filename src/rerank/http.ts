// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { sigmoid, type Reranker } from "./types.js";

/**
 * HTTP reranker: POST { query, documents: [...] } -> { scores: [number, ...] }, one finite score per document, in order.
 * A score outside 0..1 is read as a raw logit and squashed with the sigmoid; the batch is treated as one or the other
 * (if every score is already within 0..1 it is used as given). `apiKey` is sent as a bearer token. 10 second timeout;
 * redirects are refused (a redirect could carry the bearer token somewhere else). Any failure is logged (at most once a
 * minute) and every score is null.
 */
export function httpReranker(
  url: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Reranker {
  let lastWarn = -Infinity;
  const warn = (msg: string) => {
    const t = now();
    if (t - lastWarn < 60_000) return;
    lastWarn = t;
    console.error(`sanctum-mind: http reranker: ${msg}`);
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
    async rerank(query, documents) {
      const nulls = () => documents.map(() => null);
      if (documents.length === 0) return [];
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ query, documents }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          warn(`status ${res.status}`);
          return nulls();
        }
        const body = (await res.json()) as { scores?: unknown };
        const s = body.scores;
        if (!Array.isArray(s) || s.length !== documents.length || !s.every((x) => typeof x === "number" && Number.isFinite(x))) {
          warn("unexpected response shape");
          return nulls();
        }
        const scores = s as number[];
        const unit = scores.every((x) => x >= 0 && x <= 1);
        return scores.map((x) => (unit ? x : sigmoid(x)));
      } catch (e) {
        warn(e instanceof Error ? e.message : String(e));
        return nulls();
      }
    },
  };
}
