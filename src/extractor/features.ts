// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * The scorer's inputs: twelve named numbers per candidate, all in 0..1. They are stored on every noticing (`features`
 * jsonb), so a refit reads exactly what the scorer saw. The names are the model's vocabulary: weights are keyed by them.
 *
 *   rerank            cross-encoder score in 0..1; 0 when there is none
 *   rerank_missing    1 when there is no rerank score (reranker none, or it failed), else 0
 *   cosine            link: the pair's cosine; pattern, distillation: the mean pairwise cosine of the sources (0 with no vectors)
 *   recency_days      mean age of the sources in days, capped at 30, divided by 30 (0 = brand new, 1 = a month old or more)
 *   shared_context    1 when every source carries the same non-empty `context`, else 0
 *   charge_overlap    Jaccard of the sources' charge tags: tags common to all / tags on any (0 when there are none)
 *   cooccurrence      how many sessions at least two sources share, capped at 5, divided by 5 (sessions only: a shared context is
 *                     its own feature, shared_context, and is not counted twice)
 *   salience_mean     mean salience of the sources: foundational 1, active 0.7, background 0.4, archive 0.1, unset 0.4
 *   source_count      number of sources, capped at 10, divided by 10
 *   kind_link, kind_pattern, kind_distillation   one-hot of the proposal kind
 */
export const FEATURE_NAMES = [
  "rerank",
  "rerank_missing",
  "cosine",
  "recency_days",
  "shared_context",
  "charge_overlap",
  "cooccurrence",
  "salience_mean",
  "source_count",
  "kind_link",
  "kind_pattern",
  "kind_distillation",
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type Features = Record<FeatureName, number>;
export type NoticingKind = "link" | "pattern" | "distillation";

export const SALIENCE_VALUE: Record<string, number> = { foundational: 1, active: 0.7, background: 0.4, archive: 0.1 };
/** What an unset salience counts as in the feature (and, below the 0.7 bar, in the distillation rule). */
export const SALIENCE_UNSET = 0.4;

const DAY_MS = 86_400_000;
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** What the features need to know about one source. */
export interface SourceFacts {
  created_at: Date;
  context: string | null;
  /** co-occurrence keys: `session:<id>` for the session the source was written in */
  keys: string[];
  charge: string[];
  /** numeric salience, or null when unset */
  salience: number | null;
}

export interface FeatureInput {
  kind: NoticingKind;
  /** cross-encoder score in 0..1, or null when there is none */
  rerank: number | null;
  /** the cosine feature before clamping (see above) */
  cosine: number;
  sources: SourceFacts[];
  now: Date;
}

export function computeFeatures(i: FeatureInput): Features {
  const n = i.sources.length;
  const age = n === 0 ? 0 : i.sources.reduce((s, x) => s + Math.max(0, i.now.getTime() - x.created_at.getTime()) / DAY_MS, 0) / n;

  const first = i.sources[0]?.context ?? null;
  const shared = n >= 2 && first !== null && first !== "" && i.sources.every((s) => s.context === first);

  let overlap = 0;
  if (n >= 2) {
    const sets = i.sources.map((s) => new Set(s.charge));
    const union = new Set(sets.flatMap((s) => [...s]));
    if (union.size > 0) {
      const common = [...union].filter((t) => sets.every((s) => s.has(t)));
      overlap = common.length / union.size;
    }
  }

  const seen = new Map<string, number>();
  for (const s of i.sources) for (const k of new Set(s.keys)) seen.set(k, (seen.get(k) ?? 0) + 1);
  const together = [...seen.values()].filter((c) => c >= 2).length;

  const sal = n === 0 ? SALIENCE_UNSET : i.sources.reduce((s, x) => s + (x.salience ?? SALIENCE_UNSET), 0) / n;

  return {
    rerank: i.rerank === null ? 0 : clamp01(i.rerank),
    rerank_missing: i.rerank === null ? 1 : 0,
    cosine: clamp01(i.cosine),
    recency_days: clamp01(Math.min(age, 30) / 30),
    shared_context: shared ? 1 : 0,
    charge_overlap: clamp01(overlap),
    cooccurrence: clamp01(Math.min(together, 5) / 5),
    salience_mean: clamp01(sal),
    source_count: clamp01(Math.min(n, 10) / 10),
    kind_link: i.kind === "link" ? 1 : 0,
    kind_pattern: i.kind === "pattern" ? 1 : 0,
    kind_distillation: i.kind === "distillation" ? 1 : 0,
  };
}

/** The feature vector as a plain list in FEATURE_NAMES order; a stored row with a missing or non-numeric entry reads 0 there. */
export function featureVector(f: Partial<Record<string, unknown>>): number[] {
  return FEATURE_NAMES.map((k) => {
    const v = f[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  });
}
