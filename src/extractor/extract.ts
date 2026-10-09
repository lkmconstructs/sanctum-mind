// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { randomUUID } from "node:crypto";
import { appendEvent } from "../verbs/common.js";
import type { DetachedPass, PassResult } from "../daemon/passes/types.js";
import type { Reranker } from "../rerank/types.js";
import {
  capCandidates, generateCandidates, indexExisting, loadWindow, rerankPair, sourceKey, verdictFor,
  type Candidate, type Existing,
} from "./candidates.js";
import { extractorLookbackDays, extractorMaxCandidates, extractorReproposeDays, noticingExpiresAt } from "./config.js";
import { noticeProposedPayload } from "./events.js";
import { computeFeatures, type Features, type NoticingKind } from "./features.js";
import { brief, isRealRun, isSkip, notDueReason, readState, recordRun, runsSince, startOfDay } from "./schedule.js";
import { loadModel, scoreOf, type Model } from "./scorer.js";

const DAY_MS = 86_400_000;
/** The first run looks back this far; so does any later run after a long gap (CONTRACTS: cap 7 days). */
export const MAX_WINDOW_DAYS = 7;
const KINDS: readonly NoticingKind[] = ["link", "pattern", "distillation"];
/** After this many reranker calls in a row that return no scores, the rest of the run goes without (a dead endpoint would cost 10 s a call). */
const RERANK_GIVE_UP = 3;

interface Rerun {
  scores: Array<number | null>;
  scored: number;
  missing: number;
  gaveUp: boolean;
}

/** The candidate's rerank score: the mean of its documents' scores (null when none came back). Sequential, with a give-up. */
async function rerankAll(reranker: Reranker, cands: Candidate[]): Promise<Rerun> {
  const out: Rerun = { scores: [], scored: 0, missing: 0, gaveUp: false };
  let failures = 0;
  for (const c of cands) {
    let mean: number | null = null;
    const { query, documents } = rerankPair(c);
    if (reranker.name !== "none" && !out.gaveUp && documents.length > 0) {
      const s = (await reranker.rerank(query, documents)).filter((x): x is number => x !== null);
      if (s.length === 0) {
        if (++failures >= RERANK_GIVE_UP) out.gaveUp = true;
      } else {
        failures = 0;
        mean = s.reduce((a, b) => a + b, 0) / s.length;
      }
    }
    out.scores.push(mean);
    if (mean === null) out.missing++;
    else out.scored++;
  }
  return out;
}

interface Scored {
  cand: Candidate;
  features: Features;
  score: number;
  /** set when this source set expired earlier and may come back only if its score is higher than this */
  mustExceed: number | null;
}

type Plan =
  | { skip: string; record?: { reason: string } }
  | {
      start: Date;
      end: Date;
      stage: "shadow" | "propose";
      model: Model;
      day: Date;
      generated: Record<NoticingKind, number>;
      cands: Array<{ cand: Candidate; mustExceed: number | null }>;
    };

const emptyCounts = (): Record<NoticingKind, number> => ({ link: 0, pattern: 0, distillation: 0 });

/**
 * `notice.extract`: the extractor's candidate pass. Model-backed (a reranker, and the embedder's vectors), scheduled
 * (once a day at the operator's `schedule`, service local time) and detached: it holds no transaction while the reranker
 * works. It PROPOSES; it writes only `noticings`, `notice.proposed` events and an `extractor_runs` row.
 *
 *  1. Read (one read-only transaction): the operator's switch, the schedule gate, the window, the candidates, what was
 *     proposed before, the mind's scorer.
 *  2. Rerank, with no transaction open.
 *  3. Write (one transaction, under the per-mind daemon lock): re-check the gate and the dedupe against what is there now,
 *     insert each noticing with its `notice.proposed` event (ids and numbers only), record the run.
 *
 * Skips, with a note and nothing written to `noticings`: not enabled, paused, before the time, already ran today, and
 * EMBEDDER=none (no vectors, so no candidates). A failure of any kind is recorded as `ok: false` in extractor_runs and
 * returned as a note; it does not fail the tick, and the next day tries again. A reranker that is down degrades to null
 * rerank scores (the feature `rerank_missing`) and a note.
 */
export const noticeExtract: DetachedPass = {
  name: "notice.extract",
  detached: true,
  async run(ctx): Promise<PassResult> {
    const mind = ctx.mind_id;
    const started = ctx.now();
    try {
      const plan = await ctx.inTx("read", async (c): Promise<Plan> => {
        const state = await readState(c.tx, mind);
        const why = notDueReason(state, started);
        if (why !== null || !state) return { skip: why ?? "the extractor is not enabled for this mind" };
        const day = startOfDay(started);
        const today = await runsSince(c.tx, mind, "notice.extract", day);
        if (today.some(isRealRun)) return { skip: `already ran today (schedule ${state.schedule})` };
        if (c.embedder.name === "none") {
          const reason = "EMBEDDER=none: no vectors, so there is nothing to compare; candidates were not generated";
          return today.some(isSkip) ? { skip: reason } : { skip: reason, record: { reason } };
        }
        const last = await c.tx.query<{ t: Date | null }>(
          `select max(started_at) as t from extractor_runs
            where mind_id = $1 and pass = 'notice.extract' and ok
              and coalesce(notes->>'skipped', '') = '' and coalesce(notes->>'imported', '') = ''`,
          [mind],
        );
        const floor = new Date(started.getTime() - MAX_WINDOW_DAYS * DAY_MS);
        const t = last.rows[0]?.t ?? null;
        const start = t !== null && t.getTime() > floor.getTime() ? t : floor;
        // new rows are those since the last completed run; they are compared against live rows from the lookback
        const lookback = new Date(started.getTime() - extractorLookbackDays() * DAY_MS);
        // what the mind is attending to counts as new for this run (its pins, and what its heaviest items rest on)
        const attended = c.attendedIds ? await c.attendedIds() : new Set<string>();
        const win = { start: lookback.getTime() < start.getTime() ? lookback : start, newStart: start, end: started, attended };
        const loaded = await loadWindow(c.tx, mind, win);
        const found = generateCandidates(loaded, win);
        const ex = await c.tx.query<Existing>(
          `select kind, sources, status, stage, score, expires_at from noticings where mind_id = $1`,
          [mind],
        );
        const known = indexExisting(ex.rows);
        const days = extractorReproposeDays();
        const max = extractorMaxCandidates();
        const generated = emptyCounts();
        const cands: Array<{ cand: Candidate; mustExceed: number | null }> = [];
        for (const kind of KINDS) {
          generated[kind] = found[kind].length;
          const open: Candidate[] = [];
          for (const cand of found[kind]) {
            const v = verdictFor(known.get(cand.key), started, days);
            if (v.action !== "blocked") open.push(cand);
          }
          for (const cand of capCandidates(open, max)) {
            const v = verdictFor(known.get(cand.key), started, days);
            cands.push({ cand, mustExceed: v.action === "repropose" ? v.mustExceed : null });
          }
        }
        return { start, end: started, stage: state.stage, model: await loadModel(c.tx, mind), day, generated, cands };
      });

      if ("skip" in plan) {
        if (plan.record) {
          await ctx.inTx("write", async (c) => {
            const state = await readState(c.tx, mind);
            if (notDueReason(state, started) !== null) return;
            if ((await runsSince(c.tx, mind, "notice.extract", startOfDay(started))).some((r) => isRealRun(r) || isSkip(r))) return;
            await recordRun(c.tx, mind, "notice.extract", started, ctx.now(), false, { skipped: true, reason: plan.record!.reason });
          });
        }
        return { changed: 0, notes: [`skipped: ${plan.skip}`] };
      }

      const cands = plan.cands.map((x) => x.cand);
      const rr = await rerankAll(ctx.reranker, cands);
      const scored: Scored[] = plan.cands.map((x, i) => {
        const features = computeFeatures({
          kind: x.cand.kind,
          rerank: rr.scores[i] ?? null,
          cosine: x.cand.cosine,
          sources: x.cand.items,
          now: started,
        });
        return { cand: x.cand, features, score: scoreOf(plan.model, features), mustExceed: x.mustExceed };
      });
      scored.sort((a, b) => b.score - a.score || (a.cand.key < b.cand.key ? -1 : 1));

      const notes: string[] = [];
      if (ctx.reranker.name === "none") notes.push("reranker none: candidates scored on cosine and the other features only");
      else if (rr.scored === 0 && rr.missing > 0) notes.push(`reranker ${ctx.reranker.name} returned no scores: candidates scored without it (rerank_missing)`);
      else if (rr.missing > 0) notes.push(`reranker ${ctx.reranker.name} scored ${rr.scored} of ${rr.scored + rr.missing} candidates${rr.gaveUp ? " (gave up after repeated failures)" : ""}`);

      const result = await ctx.inTx("write", async (c): Promise<{ proposed: Record<NoticingKind, number>; raced: boolean; stage: string }> => {
        const proposed = emptyCounts();
        const state = await readState(c.tx, mind);
        if (notDueReason(state, started) !== null || !state) return { proposed, raced: true, stage: plan.stage };
        const today = await runsSince(c.tx, mind, "notice.extract", plan.day);
        if (today.some(isRealRun)) return { proposed, raced: true, stage: state.stage };
        // what is there now (another daemon may have proposed while the reranker worked)
        const ex = await c.tx.query<Existing>(`select kind, sources, status, stage, score, expires_at from noticings where mind_id = $1`, [mind]);
        const known = indexExisting(ex.rows);
        const days = extractorReproposeDays();
        let skippedLower = 0;
        for (const s of scored) {
          const v = verdictFor(known.get(sourceKey(s.cand.kind, s.cand.items.map((i) => i.id))), started, days);
          if (v.action === "blocked") continue;
          if (v.action === "repropose" && !(s.score > v.mustExceed)) {
            skippedLower++;
            continue;
          }
          const id = randomUUID();
          const payload = noticeProposedPayload.parse({
            noticing_id: id,
            noticing_kind: s.cand.kind,
            stage: state.stage,
            score: s.score,
            source_count: s.cand.items.length,
            model_version: plan.model.version,
          });
          const ev = await appendEvent(c, { kind: "notice.proposed", subject_id: id, payload });
          await c.tx.query(
            `insert into noticings (id, mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at, created_at)
             values ($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7::jsonb, $8, $9, 'pending', $10, $11, $12)`,
            [
              id, mind, s.cand.kind, s.cand.items.map((i) => i.id), JSON.stringify(s.cand.payload), s.score, JSON.stringify(s.features),
              plan.model.version, state.stage, ev.id, noticingExpiresAt(started), started,
            ],
          );
          proposed[s.cand.kind]++;
        }
        if (skippedLower > 0) notes.push(`${skippedLower} expired source set(s) were not proposed again: their score had not risen`);
        const total = proposed.link + proposed.pattern + proposed.distillation;
        await recordRun(c.tx, mind, "notice.extract", started, ctx.now(), true, {
          window: { new_since: plan.start.toISOString(), end: plan.end.toISOString() },
          stage: state.stage,
          reranker: ctx.reranker.name,
          rerank_missing: rr.missing,
          model_version: plan.model.version,
          generated: plan.generated,
          candidates: cands.length,
          proposed,
          proposed_total: total,
          notes,
        });
        return { proposed, raced: false, stage: state.stage };
      });

      if (result.raced) return { changed: 0, notes: ["skipped: the extractor was switched or already ran while this run worked; nothing was written"] };
      const total = result.proposed.link + result.proposed.pattern + result.proposed.distillation;
      notes.unshift(`${total} proposed at stage ${result.stage} (link ${result.proposed.link}, pattern ${result.proposed.pattern}, distillation ${result.proposed.distillation}) from ${cands.length} candidate(s)`);
      return { changed: total, notes };
    } catch (e) {
      console.error(`daemon: notice.extract failed for mind ${mind}:`, e);
      const message = brief(e);
      try {
        await ctx.inTx("write", async (c) => {
          const state = await readState(c.tx, mind);
          if (notDueReason(state, started) !== null) return;
          await recordRun(c.tx, mind, "notice.extract", started, ctx.now(), false, { error: message });
        });
      } catch (e2) {
        console.error(`daemon: could not record the failed notice.extract run for mind ${mind}:`, e2);
      }
      return { changed: 0, notes: [`failed: ${message}; tomorrow's run tries again`] };
    }
  },
};
