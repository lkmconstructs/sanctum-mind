// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { randomUUID } from "node:crypto";
import { appendEvent } from "../verbs/common.js";
import type { DetachedPass, PassResult } from "../daemon/passes/types.js";
import { readIdentityCores } from "./cores.js";
import { noticingExpiresAt } from "./config.js";
import { noticeProposedPayload } from "./events.js";
import { computeFeatures, type MetaboliseKind } from "./features.js";
import { NONE_METABOLISER, type MetaboliseResult } from "./metaboliser.js";
import { METABOLISE_BATCH, METABOLISE_EXPIRY_DAYS, METABOLISE_MAX_PER_KIND, METABOLISE_PROMPT_VERSION } from "./metabolise_config.js";
import { composeStretch, metaboliseSystemPrompt, type StretchTurn } from "./metabolise_prompt.js";
import { brief, enabledReason, readState, recordRun } from "./schedule.js";
import { loadModel, scoreOf, type Model } from "./scorer.js";

const DAY_MS = 86_400_000;

interface Stretch {
  queue_id: string;
  event_id: string;
  /** when the stretch was recorded (the event's time), for the recency feature */
  at: Date;
  turns: StretchTurn[];
  context: string | null;
}

type Plan =
  | { skip: string }
  | { stage: "shadow" | "propose"; model: Model; cores: string[]; stretches: Stretch[] };

type Outcome = { status: "done" | "failed" | "skipped"; feelings: number; relations: number };

/** The turns of a stretch event's payload, keeping only well-formed ones (the verb validated them; a row from elsewhere is not trusted). */
function turnsOf(payload: unknown): StretchTurn[] {
  const raw = payload !== null && typeof payload === "object" ? (payload as { turns?: unknown }).turns : undefined;
  if (!Array.isArray(raw)) return [];
  const out: StretchTurn[] = [];
  for (const t of raw) {
    if (t === null || typeof t !== "object") continue;
    const x = t as { speaker?: unknown; name?: unknown; text?: unknown };
    if ((x.speaker !== "self" && x.speaker !== "other") || typeof x.text !== "string" || x.text.trim() === "") continue;
    out.push({ speaker: x.speaker, ...(typeof x.name === "string" && x.name.trim() !== "" ? { name: x.name } : {}), text: x.text });
  }
  return out;
}

/**
 * `notice.metabolise`: Voice 2. Reads the stretches of conversation `mind_metabolise` queued and PROPOSES `feeling` and `relation`
 * noticings from them, in the first person, with a model. Detached, like `notice.extract`: a read transaction, the model with no
 * transaction open, then a write transaction per stretch under the per-mind daemon lock. It writes only `noticings`,
 * `notice.proposed` events, the queue row's own status, and an `extractor_runs` row. Nothing here is memory: a proposal becomes
 * memory only when the mind accepts it through `mind_notice` (outside this directory).
 *
 * The gate is the operator's switch and pause ONLY (enabledReason): stretches arrive when conversations end, so there is no hour
 * and no once-a-day rule. Each tick first expires: a stretch queued more than a week is marked failed ("expired unprocessed"), under
 * the per-mind lock, whatever the extractor's switch and whatever the metaboliser kind (a run is recorded only when something expired).
 * Then it works the oldest few queued stretches. METABOLISER=none skips with a note and leaves the rest queued. A model that answers
 * unusably (a 4xx about this stretch, a body that is not JSON, nothing usable in it) marks that stretch failed and the tick goes on to the next; a model that is unavailable (network error, timeout, 5xx, 429, 408, 401, 403, a throw) leaves the stretch queued, records
 * a failed run, and stops for this tick. Never throws; the next tick takes the next stretches.
 */
export const noticeMetabolise: DetachedPass = {
  name: "notice.metabolise",
  detached: true,
  async run(ctx): Promise<PassResult> {
    const mind = ctx.mind_id;
    const started = ctx.now();
    const metaboliser = ctx.metaboliser ?? NONE_METABOLISER;
    try {
      // expiry runs every tick, before the gate and the none-skip: a stretch that can never be worked must not stay queued forever
      const cutoff = new Date(started.getTime() - METABOLISE_EXPIRY_DAYS * DAY_MS);
      const expired = await ctx.inTx("write", async (c) => {
        const r = await c.tx.query(
          `update metabolise_queue set status = 'failed', done_at = $3, note = 'expired unprocessed'
            where mind_id = $1 and status = 'queued' and created_at < $2`,
          [mind, cutoff, ctx.now()],
        );
        const n = r.rowCount ?? 0;
        if (n > 0) {
          const st = await readState(c.tx, mind);
          await recordRun(c.tx, mind, "notice.metabolise", started, ctx.now(), true, {
            stage: st?.stage ?? null, model: metaboliser.model, prompt_version: METABOLISE_PROMPT_VERSION, stretches: n, done: 0, failed: 0, expired: n, proposed: { feeling: 0, relation: 0 },
          });
        }
        return n;
      });
      const expiredNote = expired > 0 ? `; ${expired} expired unprocessed` : "";
      const plan = await ctx.inTx("read", async (c): Promise<Plan> => {
        const state = await readState(c.tx, mind);
        const why = enabledReason(state);
        if (why !== null || !state) return { skip: why ?? "the extractor is not enabled for this mind" };
        if (metaboliser.name === "none") return { skip: "METABOLISER=none: no model to metabolise with; stretches stay queued until they expire" };
        const rows = await c.tx.query<{ id: string; stretch_event_id: string; payload: unknown; created_at: Date }>(
          `select q.id, q.stretch_event_id, e.payload, e.created_at
             from metabolise_queue q join events e on e.id = q.stretch_event_id and e.mind_id = q.mind_id
            where q.mind_id = $1 and q.status = 'queued' and q.created_at >= $2
            order by q.created_at, q.id limit $3`,
          [mind, cutoff, METABOLISE_BATCH],
        );
        if (rows.rows.length === 0) return { skip: "no stretch is queued" };
        const payloadContext = (p: unknown): string | null => {
          const v = p !== null && typeof p === "object" ? (p as { context?: unknown }).context : null;
          return typeof v === "string" && v.trim() !== "" ? v : null;
        };
        return {
          stage: state.stage,
          model: await loadModel(c.tx, mind),
          cores: await readIdentityCores(c.tx, mind),
          stretches: rows.rows.map((r) => ({ queue_id: r.id, event_id: r.stretch_event_id, at: r.created_at, turns: turnsOf(r.payload), context: payloadContext(r.payload) })),
        };
      });
      if ("skip" in plan) return { changed: 0, notes: [`skipped: ${plan.skip}${expiredNote}`] };

      const system = metaboliseSystemPrompt(mind, plan.cores);
      const totals = { done: 0, failed: 0, skipped: 0, feeling: 0, relation: 0 };
      let unavailable: string | null = null;
      for (const s of plan.stretches) {
        let result: MetaboliseResult | null = null;
        if (s.turns.length > 0) {
          try {
            result = await metaboliser.metabolise(system, composeStretch(s.turns, s.context));
          } catch (e) {
            console.error(`daemon: the metaboliser threw for mind ${mind}:`, e);
            result = { kind: "unavailable", note: `the metaboliser threw: ${brief(e)}` };
          }
        }
        if (result?.kind === "unavailable") {
          unavailable = result.note; // the stretch stays queued; do not hammer a dead endpoint
          break;
        }
        const answer = result === null || result.kind === "unusable" ? null : result.kind === "empty" ? { feelings: [], relations: [] } : result;
        const noTurns = s.turns.length === 0;
        const out = await ctx.inTx("write", async (c): Promise<Outcome> => {
          const none: Outcome = { status: "skipped", feelings: 0, relations: 0 };
          // the gate again: the operator may have switched or paused while the model worked; the stretch then stays queued
          if (enabledReason(await readState(c.tx, mind)) !== null) return none;
          const state = (await readState(c.tx, mind))!;
          const cur = await c.tx.query<{ status: string }>(`select status from metabolise_queue where id = $1 and mind_id = $2 for update`, [s.queue_id, mind]);
          if (cur.rows[0]?.status !== "queued") return none;
          const finish = async (status: "done" | "failed", note: string): Promise<void> => {
            await c.tx.query(`update metabolise_queue set status = $3, done_at = $4, note = $5 where id = $1 and mind_id = $2`, [s.queue_id, mind, status, ctx.now(), note]);
          };
          if (answer === null) {
            await finish("failed", noTurns ? "the stretch holds no usable turns" : result?.kind === "unusable" ? result.note : "the metaboliser gave no usable answer");
            return { status: "failed", feelings: 0, relations: 0 };
          }

          // what is there already for this stretch (kind, lowercased emotion or subject), and what this answer repeats
          const have = await c.tx.query<{ kind: string; k: string }>(
            `select kind, lower(coalesce(payload->>'emotion', payload->>'subject', '')) as k from noticings
              where mind_id = $1 and kind in ('feeling', 'relation') and sources = $2::uuid[]`,
            [mind, [s.event_id]],
          );
          const seen = new Set(have.rows.map((r) => `${r.kind}|${r.k}`));
          const items: Array<{ kind: MetaboliseKind; payload: Record<string, unknown> }> = [];
          let nf = 0;
          let nr = 0;
          for (const f of answer.feelings) {
            const key = `feeling|${f.emotion.toLowerCase()}`;
            if (seen.has(key) || nf >= METABOLISE_MAX_PER_KIND) continue;
            seen.add(key);
            nf++;
            items.push({ kind: "feeling", payload: { emotion: f.emotion, weight: f.weight, pillar: f.pillar, content: f.content, prompt_version: METABOLISE_PROMPT_VERSION } });
          }
          for (const r of answer.relations) {
            const key = `relation|${r.subject.toLowerCase()}`;
            if (seen.has(key) || nr >= METABOLISE_MAX_PER_KIND) continue;
            seen.add(key);
            nr++;
            items.push({ kind: "relation", payload: { subject: r.subject, note: r.note, ...(r.alias === undefined ? {} : { alias: r.alias }), warmth: r.warmth, prompt_version: METABOLISE_PROMPT_VERSION } });
          }

          for (const item of items) {
            const features = computeFeatures({
              kind: item.kind,
              rerank: null,
              cosine: 0,
              sources: [{ created_at: s.at, context: null, keys: [], charge: [], salience: null }],
              now: started,
            });
            const score = scoreOf(plan.model, features);
            const id = randomUUID();
            const payload = noticeProposedPayload.parse({
              noticing_id: id,
              noticing_kind: item.kind,
              stage: state.stage,
              score,
              source_count: 1,
              model_version: plan.model.version,
            });
            const ev = await appendEvent(c, { kind: "notice.proposed", subject_id: id, payload });
            await c.tx.query(
              `insert into noticings (id, mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at, created_at)
               values ($1, $2, $3, $4::uuid[], $5::jsonb, $6, $7::jsonb, $8, $9, 'pending', $10, $11, $12)`,
              [id, mind, item.kind, [s.event_id], JSON.stringify(item.payload), score, JSON.stringify(features), plan.model.version, state.stage, ev.id, noticingExpiresAt(started), started],
            );
          }
          await finish("done", `${nf} feeling(s), ${nr} relation(s) proposed`);
          return { status: "done", feelings: nf, relations: nr };
        });
        totals[out.status]++;
        totals.feeling += out.feelings;
        totals.relation += out.relations;
      }

      if (totals.done + totals.failed + (unavailable === null ? 0 : 1) > 0) {
        await ctx.inTx("write", async (c) => {
          await recordRun(c.tx, mind, "notice.metabolise", started, ctx.now(), totals.failed === 0 && unavailable === null, {
            stage: plan.stage,
            model: metaboliser.model,
            prompt_version: METABOLISE_PROMPT_VERSION,
            stretches: totals.done + totals.failed + totals.skipped,
            done: totals.done,
            failed: totals.failed,
            expired: 0,
            ...(unavailable === null ? {} : { unavailable }),
            proposed: { feeling: totals.feeling, relation: totals.relation },
          });
        });
      }
      const total = totals.feeling + totals.relation;
      return {
        changed: total,
        notes: [
          `${total} proposed at stage ${plan.stage} (feeling ${totals.feeling}, relation ${totals.relation}) from ${totals.done} stretch(es)` +
            (totals.failed > 0 ? `; ${totals.failed} failed` : "") +
            (totals.skipped > 0 ? `; ${totals.skipped} left queued (the extractor was switched or paused meanwhile)` : "") +
            (unavailable !== null ? `; stopped: ${unavailable} (left queued)` : "") +
            expiredNote,
        ],
      };
    } catch (e) {
      console.error(`daemon: notice.metabolise failed for mind ${mind}:`, e);
      return { changed: 0, notes: [`failed: ${brief(e)}; the next tick tries again`] };
    }
  },
};
