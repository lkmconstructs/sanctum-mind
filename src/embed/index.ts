import type { Embedder } from "../verbs/types.js";
import { NONE_EMBEDDER } from "./none.js";
import { localEmbedder } from "./local.js";
import { httpEmbedder } from "./http.js";

/** Chooses the embedder from EMBEDDER: local (default), http, none. http without EMBED_URL falls back to none. */
export function embedderFromEnv(env: Record<string, string | undefined>): Embedder {
  const which = (env.EMBEDDER ?? "local").trim().toLowerCase();
  switch (which) {
    case "none":
      return NONE_EMBEDDER;
    case "http":
      if (!env.EMBED_URL) {
        console.error("sanctum-mind: EMBEDDER=http but EMBED_URL is not set; embeddings disabled");
        return NONE_EMBEDDER;
      }
      return httpEmbedder(env.EMBED_URL, env.EMBED_API_KEY || undefined);
    case "local":
      return localEmbedder(env);
    default:
      console.error(`sanctum-mind: unknown EMBEDDER "${which}"; embeddings disabled`);
      return NONE_EMBEDDER;
  }
}
