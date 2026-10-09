// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * A cross-encoder reranker: scores how well each document answers a query. Used only by the extractor
 * (CONTRACTS.md, "Noticing"), to rank candidate proposals; it never sees a verb and never writes anything.
 * Mirrors src/embed: one interface, three implementations (none, http, local), failures degrade to null scores.
 */
export interface Reranker {
  /** stable identifier, e.g. "none", "http:rerank.example", "local:ms-marco-MiniLM-L-6-v2" */
  readonly name: string;
  /**
   * One score per document, in order, each in 0..1 (higher = more relevant), or null where no score could be had.
   * Never throws: a failure is logged once and every score is null.
   */
  rerank(query: string, documents: string[]): Promise<Array<number | null>>;
}

/** 1 / (1 + e^-x), the squash from a raw cross-encoder logit to 0..1. */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
