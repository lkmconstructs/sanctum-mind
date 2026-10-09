// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { appendEvent } from "../verbs/common.js";
import type { DaemonPass, PassResult } from "../daemon/passes/types.js";
import { noticeModelTrainedPayload } from "./events.js";
import { FEATURE_NAMES, featureVector } from "./features.js";
import { isRealRun, notDueReason, readState, recordRun, runsSince, startOfDay } from "./schedule.js";
import { PRIOR_MODEL, loadModel, scoreOf, sigmoid, weightsJson, type Model } from "./scorer.js";

/** At least this many decided noticings, and at least MIN_PER_CLASS accepted and MIN_PER_CLASS not accepted, or the prior stands. */
export const MIN_DECIDED = 30;
export const MIN_PER_CLASS = 5;
/** An expired proposal is a weak "no": the mind may simply not have looked. */
export const EXPIRED_WEIGHT = 0.5;
export const EPOCHS = 200;
/** Step size of the full-batch gradient. Features are in 0..1, so the loss is smooth and 0.5 is stable with 13 of them. */
export const LEARNING_RATE = 0.5;
/**
 * The L2 penalty, lambda * (w - w_prior)^2 / 2 on every weight (not the bias), against a mean loss. It pulls the fit
 * toward the hand-set prior rather than toward zero: with a few dozen decisions and thirteen features, a mind's weights should
 * move only as far as its decisions push them. 0.05 means a weight moves a full point only if the data insists.
 */
export const L2 = 0.05;

export interface Example {
  x: number[];
  y: 0 | 1;
  w: number;
}

export interface Fit {
  bias: number;
  weights: number[];
}

/**
 * Deterministic full-batch gradient descent on the weighted log loss with L2 toward `start`, from `start`, for EPOCHS
 * steps. No randomness, no early stop: the same examples give the same weights.
 */
export function fitLogistic(examples: Example[], start: Fit): Fit {
  const k = start.weights.length;
  let bias = start.bias;
  const w = [...start.weights];
  const total = examples.reduce((s, e) => s + e.w, 0);
  if (total === 0) return { bias, weights: w };
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    let gb = 0;
    const g = new Array<number>(k).fill(0);
    for (const e of examples) {
      let z = bias;
      for (let j = 0; j < k; j++) z += w[j]! * e.x[j]!;
      const r = (sigmoid(z) - e.y) * e.w;
      gb += r;
      for (let j = 0; j < k; j++) g[j]! += r * e.x[j]!;
    }
    bias -= (LEARNING_RATE * gb) / total;
    for (let j = 0; j < k; j++) w[j]! -= LEARNING_RATE * (g[j]! / total + L2 * (w[j]! - start.weights[j]!));
  }
  return { bias, weights: w };
}

const EPS = 1e-9;

/** Mean log loss of `p` against `y`. */
export function logLoss(ps: number[], ys: number[]): number {
  if (ps.length === 0) return 0;
  let s = 0;
  ps.forEach((p, i) => {
    const q = Math.min(1 - EPS, Math.max(EPS, p));
    s -= ys[i]! === 1 ? Math.log(q) : Math.log(1 - q);
  });
  return s / ps.length;
}

/** Of the `k` highest-scored (ties: earlier first), the share that were accepted. */
export function precisionAt(k: number, ps: number[], ys: number[]): number {
  const top = ps.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p || a.i - b.i).slice(0, k);
  return top.length === 0 ? 0 : top.reduce((s, t) => s + ys[t.i]!, 0) / top.length;
}

export interface Metrics {
  precision_at_5: number;
  log_loss: number;
  n: number;
  n_train: number;
  previous_precision_at_5: number;
  previous_log_loss: number;
  [key: string]: number;
}

/** The held-out rows are every 5th, in order (the 5th, 10th, ...); the rest train. */
export function split<T>(rows: T[]): { train: T[]; test: T[] } {
  const train: T[] = [];
  const test: T[] = [];
  rows.forEach((r, i) => (i % 5 === 4 ? test : train).push(r));
  return { train, test };
}

interface DecidedRow {
  status: "accepted" | "rejected" | "expired";
  features: Record<string, unknown>;
}

export type Trained = { trained: false; reason: string } | { trained: true; model: Model; metrics: Metrics; trainedOn: number };

/** The whole fit, pure: decided noticings in created order, and the model now in use (to compare against on the held-out rows); a new model and its held-out metrics out. */
export function trainModel(rows: DecidedRow[], previous: Model): Trained {
  const accepted = rows.filter((r) => r.status === "accepted").length;
  const notAccepted = rows.length - accepted;
  if (rows.length < MIN_DECIDED) return { trained: false, reason: `only ${rows.length} decided noticing(s); ${MIN_DECIDED} are needed before the prior is refit` };
  if (accepted < MIN_PER_CLASS) return { trained: false, reason: `only ${accepted} accepted; at least ${MIN_PER_CLASS} are needed (${rows.length} decided)` };
  if (notAccepted < MIN_PER_CLASS) return { trained: false, reason: `only ${notAccepted} rejected or expired; at least ${MIN_PER_CLASS} are needed (${rows.length} decided)` };

  const ex = rows.map((r): Example => ({ x: featureVector(r.features), y: r.status === "accepted" ? 1 : 0, w: r.status === "expired" ? EXPIRED_WEIGHT : 1 }));
  const { train, test } = split(ex);
  if (!train.some((e) => e.y === 1) || !train.some((e) => e.y === 0)) {
    return { trained: false, reason: "the training split holds only one class; more decisions are needed" };
  }
  // Always from the prior, never from the last fit: a refit is a function of the mind's decisions alone, so it can be reproduced.
  const start: Fit = { bias: PRIOR_MODEL.bias, weights: FEATURE_NAMES.map((k) => PRIOR_MODEL.weights[k]) };
  const fit = fitLogistic(train, start);
  const model: Model = {
    version: previous.version + 1,
    bias: fit.bias,
    weights: Object.fromEntries(FEATURE_NAMES.map((k, i) => [k, fit.weights[i]!])) as Model["weights"],
    source: "trained",
  };
  const ys = test.map((e) => e.y);
  const asFeatures = (e: Example) => Object.fromEntries(FEATURE_NAMES.map((k, i) => [k, e.x[i]!])) as Parameters<typeof scoreOf>[1];
  const now = test.map((e) => scoreOf(model, asFeatures(e)));
  const before = test.map((e) => scoreOf(previous, asFeatures(e)));
  return {
    trained: true,
    model,
    trainedOn: train.length,
    metrics: {
      precision_at_5: precisionAt(5, now, ys),
      log_loss: logLoss(now, ys),
      n: test.length,
      n_train: train.length,
      previous_precision_at_5: precisionAt(5, before, ys),
      previous_log_loss: logLoss(before, ys),
    },
  };
}

/**
 * `notice.train`: refits the mind's scorer from its own decisions, once a day after notice.extract (same schedule gate,
 * its own row in extractor_runs). Uses noticings that were shown to the mind (stage propose) and decided: accepted is 1,
 * rejected 0, expired 0 at half weight; imported expiries (a proposal from another life), expiries because a cited node was rewritten or retired (`source_invalidated`: the mind never had the chance to judge them) and rows with no recorded
 * features are left out. With fewer than 30 decided, or fewer than 5 of either class, it says why and the current model
 * stands. A refit is a NEW row in extractor_models (version = latest + 1; old rows are never changed or deleted) and a
 * `notice.model.trained` event with the held-out numbers. Deterministic: no randomness, no model call.
 */
export const noticeTrain: DaemonPass = {
  name: "notice.train",
  async run(ctx): Promise<PassResult> {
    const mind = ctx.mind_id;
    const now = ctx.now();
    const state = await readState(ctx.tx, mind);
    const why = notDueReason(state, now);
    if (why !== null || !state) return { changed: 0, notes: [`skipped: ${why ?? "the extractor is not enabled for this mind"}`] };
    if ((await runsSince(ctx.tx, mind, "notice.train", startOfDay(now))).some(isRealRun)) return { changed: 0, notes: [`skipped: already ran today (schedule ${state.schedule})`] };

    const decided = await ctx.tx.query<DecidedRow>(
      `select n.status, n.features
         from noticings n left join events d on d.id = n.decided_event_id
        where n.mind_id = $1 and n.kind <> 'repair' and n.stage = 'propose' and n.status in ('accepted', 'rejected', 'expired')
          and n.features <> '{}'::jsonb and coalesce(d.payload->>'reason', '') not in ('imported', 'source_invalidated')
        order by n.created_at, n.id`,
      [mind],
    );
    const previous = await loadModel(ctx.tx, mind);
    const out = trainModel(decided.rows, previous);
    if (!out.trained) {
      await recordRun(ctx.tx, mind, "notice.train", now, ctx.now(), true, { trained: false, reason: out.reason, decided: decided.rows.length });
      return { changed: 0, notes: [`not trained: ${out.reason}`] };
    }
    const max = await ctx.tx.query<{ v: number | null }>(`select max(version) as v from extractor_models where mind_id = $1`, [mind]);
    const version = (max.rows[0]?.v ?? 0) + 1;
    const payload = noticeModelTrainedPayload.parse({ version, trained_on: out.trainedOn, metrics: out.metrics });
    const ev = await appendEvent(ctx, { kind: "notice.model.trained", payload });
    await ctx.tx.query(
      `insert into extractor_models (mind_id, version, weights, trained_on, metrics, created_at, event_id) values ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7)`,
      [mind, version, JSON.stringify(weightsJson(out.model)), out.trainedOn, JSON.stringify(out.metrics), now, ev.id],
    );
    await recordRun(ctx.tx, mind, "notice.train", now, ctx.now(), true, { trained: true, version, trained_on: out.trainedOn, decided: decided.rows.length });
    return { changed: 1, notes: [`trained model version ${version} on ${out.trainedOn} noticing(s); held-out precision at 5 ${out.metrics.precision_at_5.toFixed(2)}, log loss ${out.metrics.log_loss.toFixed(3)} (n=${out.metrics.n})`] };
  },
};
