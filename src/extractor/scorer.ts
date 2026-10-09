// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { PoolClient } from "pg";
import { FEATURE_NAMES, featureVector, type FeatureName, type Features } from "./features.js";
import { PRIOR_BIAS, PRIOR_VERSION, PRIOR_WEIGHTS } from "./prior.js";

/**
 * The scorer is a logistic regression over the named features: score = sigmoid(bias + sum of weight_i * feature_i).
 * No neural model. Weights live in `extractor_models` as `{bias, weights: {<feature>: number}}`, one row per version;
 * the scorer uses the mind's latest valid row, or the hand-set prior (version 0) when there is none.
 */
export interface Model {
  version: number;
  bias: number;
  weights: Record<FeatureName, number>;
  source: "prior" | "trained";
}

export const PRIOR_MODEL: Model = { version: PRIOR_VERSION, bias: PRIOR_BIAS, weights: PRIOR_WEIGHTS, source: "prior" };

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export function scoreOf(model: Pick<Model, "bias" | "weights">, f: Features): number {
  const x = featureVector(f);
  let z = model.bias;
  FEATURE_NAMES.forEach((k, i) => {
    z += model.weights[k] * x[i]!;
  });
  return sigmoid(z);
}

/** The stored shape of a model's weights. */
export function weightsJson(m: Pick<Model, "bias" | "weights">): { bias: number; weights: Record<FeatureName, number> } {
  return { bias: m.bias, weights: { ...m.weights } };
}

/** Reads a stored row's weights; null when the row is not a model this code can use (a missing bias, or a non-finite weight). */
export function parseWeights(raw: unknown): { bias: number; weights: Record<FeatureName, number> } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as { bias?: unknown; weights?: unknown };
  if (typeof o.bias !== "number" || !Number.isFinite(o.bias)) return null;
  if (o.weights === null || typeof o.weights !== "object" || Array.isArray(o.weights)) return null;
  const w = o.weights as Record<string, unknown>;
  const out = {} as Record<FeatureName, number>;
  for (const k of FEATURE_NAMES) {
    const v = w[k];
    if (v === undefined) out[k] = 0; // a feature a model never saw contributes nothing
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else return null;
  }
  return { bias: o.bias, weights: out };
}

/** The mind's latest usable model (highest version whose weights parse), else the prior. `tx` must be scoped to the mind. */
export async function loadModel(tx: PoolClient, mind: string): Promise<Model> {
  const r = await tx.query<{ version: number; weights: unknown }>(
    `select version, weights from extractor_models where mind_id = $1 order by version desc`,
    [mind],
  );
  for (const row of r.rows) {
    const w = parseWeights(row.weights);
    if (w) return { version: row.version, ...w, source: "trained" };
  }
  return PRIOR_MODEL;
}
