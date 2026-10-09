// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { FeatureName } from "./features.js";

/**
 * Version 0 of the scorer: hand-set logistic weights, used until a mind has enough decisions of its own to fit (notice.train).
 * score = sigmoid(bias + sum of weight * feature). Every feature is in 0..1, so a weight is also the most a feature can add.
 * The numbers are judgement, not measurement: they only need to rank sensibly and to keep a pair with no rerank score and a
 * middling cosine well under one with strong evidence. They are replaced, per mind, by what the mind actually accepts.
 *
 * Reading the result (two new sources, no salience set, nothing else): a link at cosine 0.8 with a rerank of 0.9 scores about
 * 0.88; at cosine 0.62 with a rerank of 0.1, about 0.29. With no reranker the 0.62 pair scores about 0.58 and the 0.8 pair about 0.68.
 */
export const PRIOR_VERSION = 0;

export const PRIOR_BIAS = -3.0; // most candidates are not worth a mind's attention; start sceptical so a score of 0.5 needs real evidence

export const PRIOR_WEIGHTS: Record<FeatureName, number> = {
  // The cross-encoder reads the pair together, which is the closest thing here to "do these actually belong": the strongest signal.
  rerank: 3.0,
  // With no reranker the term above is 0, which would read as "judged irrelevant". This is roughly half the rerank weight, i.e.
  // "judged middling", so a mind without a reranker is ranked by its other features rather than all pushed down together.
  rerank_missing: 1.5,
  // Embedding similarity is cheap and already gated the candidate (0.55 to 0.6 and up), so it ranks within the gate: second strongest.
  cosine: 2.5,
  // The feature is AGE (0 new .. 1 a month old). Recent material is a little better to surface, so the weight is mildly NEGATIVE,
  // i.e. recency is a mild positive.
  recency_days: -0.5,
  // Same context is what the mind itself said belongs together, but it was already part of the candidate rules: a modest nudge.
  shared_context: 0.4,
  // Shared charge says the sources feel alike, which the mind tags deliberately: a little more than context.
  charge_overlap: 0.6,
  // Being written in the same sessions and contexts: weak evidence of belonging, so small.
  cooccurrence: 0.4,
  // What the mind marked as active or foundational is more likely to be worth carrying forward than background material.
  salience_mean: 0.5,
  // Bigger groups are a little more likely to be a real pattern, but size is cheap to get: mild.
  source_count: 0.3,
  // Kind biases start at zero: no prior opinion that one kind is better than another. Training will find the mind's own.
  kind_link: 0,
  kind_pattern: 0,
  kind_distillation: 0,
};
