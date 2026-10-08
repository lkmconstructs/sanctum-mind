import type { Embedder } from "../verbs/types.js";

/** The embedder used when none is configured: vectors stay null and retrieval is full text only. */
export const NONE_EMBEDDER: Embedder = {
  name: "none",
  dim: 384,
  async embed(texts) {
    return texts.map(() => null);
  },
};
