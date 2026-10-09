// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { Reranker } from "./types.js";

/** The reranker used when none is configured: every score is null and the extractor falls back to cosine and the other features. */
export const NONE_RERANKER: Reranker = {
  name: "none",
  async rerank(_query, documents) {
    return documents.map(() => null);
  },
};
