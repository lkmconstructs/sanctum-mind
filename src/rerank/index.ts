// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { Reranker } from "./types.js";
import { NONE_RERANKER } from "./none.js";
import { httpReranker } from "./http.js";
import { localReranker } from "./local.js";

export type { Reranker } from "./types.js";
export { NONE_RERANKER } from "./none.js";

export const RERANKERS = ["none", "local", "http"] as const;

/**
 * Chooses the reranker from RERANKER: none (default), local, http. Unlike the embedder, a bad setting is an error, not a
 * warning: the daemon calls this at start and refuses to run on an unknown value, or on http without a valid RERANK_URL.
 */
export function rerankerFromEnv(env: Record<string, string | undefined>): Reranker {
  const which = (env.RERANKER ?? "none").trim().toLowerCase() || "none";
  switch (which) {
    case "none":
      return NONE_RERANKER;
    case "local":
      return localReranker(env);
    case "http": {
      const url = env.RERANK_URL?.trim();
      if (!url) throw new Error("RERANKER=http needs RERANK_URL");
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new Error("RERANK_URL is not a valid URL");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("RERANK_URL must be an http or https URL");
      if (u.username !== "" || u.password !== "") throw new Error("RERANK_URL must not contain credentials (user:pass@); use RERANK_API_KEY");
      return httpReranker(url, env.RERANK_API_KEY || undefined);
    }
    default:
      throw new Error(`RERANKER must be one of ${RERANKERS.join(", ")} (got "${which}")`);
  }
}
