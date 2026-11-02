// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { appendEvent } from "../verbs/common.js";
import type { DetachedPass, PassResult } from "../daemon/passes/types.js";
import { brief, isRealRun, isSkip, recordRun, runsSince, scheduledAt, startOfDay } from "../extractor/schedule.js";
import { DREAM_PROMPT_VERSION, dreamFadesAt, dreamWindowHours } from "./config.js";
import { NONE_DREAMER, type Dreamer } from "./dreamer.js";
import { dreamLaidPayload } from "./events.js";
import { dreamSystemPrompt } from "./prompt.js";
import { composeResidue, readResidue, residueIsEmpty, type Residue } from "./residue.js";

const HOUR_MS = 3_600_000;

export interface DreamState {
  enabled: boolean;
  stage: "shadow" | "propose";
  schedule: string;
  gap_hours: number;
  paused: boolean;
}

export async function readDreamState(tx: PoolClient, mind: string): Promise<DreamState | null> {
  const r = await tx.query<DreamState>(
    `select enabled, stage, schedule, gap_hours, paused_at is not null as paused from dream_state where mind_id = $1`,
    [mind],
  );
  return r.rows[0] ?? null;
}

/** Why the pass must not run now, or null when it may. */
export function dreamNotDueReason(state: DreamState | null, now: Date): string | null {
  if (!state || !state.enabled) return "dreaming is not enabled for this mind";
  if (state.paused) return "dreaming is paused";
  if (now.getTime() < scheduledAt(now, state.schedule).getTime()) return `not due until ${state.schedule} (service local time)`;
  return null;
}

type Plan = { skip: string; record?: { reason: string } } | { residue: Residue; state: DreamState };

/**
 * `dream.generate`: ONE dream from the residue, laid down as a `dreams` row with its `dream.laid` event. Detached, like
 * `notice.extract`: a read transaction for the gate and the residue, the model outside any transaction, a write transaction
 * under the per-mind daemon lock that checks the gate again and lays the dream. It writes `dreams`, one `dream.laid` event
 * and an `extractor_runs` row, and nothing else; a laid dream is residue until the mind anchors it (mind_dream, outside this
 * directory). A silent model (DREAMER=none, a failure, no dream in the answer) records a skip or a failure and writes no dream.
 */
export const dreamGenerate: DetachedPass = {
  name: "dream.generate",
  detached: true,
  async run(ctx): Promise<PassResult> {
    const mind = ctx.mind_id;
    const started = ctx.now();
    const dreamer: Dreamer = ctx.dreamer ?? NONE_DREAMER;
    try {
      const plan = await ctx.inTx("read", async (c): Promise<Plan> => {
        const state = await readDreamState(c.tx, mind);
        const why = dreamNotDueReason(state, started);
        if (why !== null || !state) return { skip: why ?? "dreaming is not enabled for this mind" };
        const today = await runsSince(c.tx, mind, "dream.generate", startOfDay(started));
        if (today.some(isRealRun)) return { skip: `already ran today (schedule ${state.schedule})` };
        const last = await c.tx.query<{ t: Date | null }>(
          `select max(started_at) as t from extractor_runs
            where mind_id = $1 and pass = 'dream.generate' and ok
              and coalesce(notes->>'skipped', '') = '' and coalesce(notes->>'imported', '') = ''`,
          [mind],
        );
        const t = last.rows[0]?.t ?? null;
        if (t !== null && started.getTime() - t.getTime() < state.gap_hours * HOUR_MS) return { skip: `the last dream was less than ${state.gap_hours} hours ago` };
        if (dreamer.name === "none") {
          const reason = "DREAMER=none: no model to dream with";
          return today.some(isSkip) ? { skip: reason } : { skip: reason, record: { reason } };
        }
        const residue = await readResidue(c.tx, mind, started, dreamWindowHours());
        if (residueIsEmpty(residue)) {
          const reason = "no residue: nothing textured in the window and nothing pinned";
          return today.some(isSkip) ? { skip: reason } : { skip: reason, record: { reason } };
        }
        return { residue, state };
      });
      if ("skip" in plan) {
        if (plan.record) {
          await ctx.inTx("write", async (c) => {
            await recordRun(c.tx, mind, "dream.generate", started, ctx.now(), false, { skipped: true, reason: plan.record!.reason });
          });
        }
        return { changed: 0, notes: [`skipped: ${plan.skip}`] };
      }

      const answer = await dreamer.dream(dreamSystemPrompt(mind, plan.residue.cores), composeResidue(plan.residue));
      const modelVersion = `${dreamer.model}@p${DREAM_PROMPT_VERSION}`;

      return await ctx.inTx("write", async (c): Promise<PassResult> => {
        // the gate again: the operator may have disabled or paused while the model worked, or another daemon may have laid one
        const state = await readDreamState(c.tx, mind);
        const why = dreamNotDueReason(state, started);
        if (why !== null || !state) {
          await recordRun(c.tx, mind, "dream.generate", started, ctx.now(), false, { skipped: true, reason: why ?? "disabled" });
          return { changed: 0, notes: [`skipped: ${why ?? "disabled"}`] };
        }
        if ((await runsSince(c.tx, mind, "dream.generate", startOfDay(started))).some(isRealRun)) {
          await recordRun(c.tx, mind, "dream.generate", started, ctx.now(), false, { skipped: true, reason: "raced" });
          return { changed: 0, notes: ["skipped: another run laid today's dream"] };
        }
        if (answer === null) {
          await recordRun(c.tx, mind, "dream.generate", started, ctx.now(), false, { error: "the dreamer answered with no dream" });
          return { changed: 0, notes: ["failed: the dreamer answered with no dream; nothing was written"] };
        }
        const r = plan.residue;
        const residue = {
          event_ids: r.events.map((e) => e.id),
          node_ids: r.pinned.filter((p) => p.type === "node").map((p) => p.id),
          pinned_event_ids: r.pinned.filter((p) => p.type === "event").map((p) => p.id),
          relation_subjects: r.relations.map((x) => x.subject),
          charge_counts: Object.fromEntries(r.chargeCounts.map((c) => [c.tag, c.n])),
          window: { from: r.window.from.toISOString(), to: r.window.to.toISOString() },
          dropped: r.dropped,
        };
        const counts = { events: residue.event_ids.length, nodes: residue.node_ids.length, relations: residue.relation_subjects.length, pinned: r.pinned.length, dropped: r.dropped };
        // the id is minted first so the dream.laid event can name the dream it lays, and the row can name the event: the same
        // order as a noticing and its notice.proposed event
        const dreamId = randomUUID();
        const ev = await appendEvent(c, {
          kind: "dream.laid",
          subject_id: dreamId,
          payload: dreamLaidPayload.parse({ dream_id: dreamId, stage: state.stage, model_version: modelVersion, residue_counts: counts, window: residue.window }),
        });
        await c.tx.query(
          `insert into dreams (id, mind_id, content, question, residue, model_version, stage, status, laid_event_id, fades_at, created_at)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, 'laid', $8, $9, $10)`,
          [dreamId, mind, answer.dream, answer.question, JSON.stringify(residue), modelVersion, state.stage, ev.id, dreamFadesAt(started), started],
        );
        await recordRun(c.tx, mind, "dream.generate", started, ctx.now(), true, { dream_id: dreamId, stage: state.stage, ...counts });
        return { changed: 1, notes: [`laid one dream at stage ${state.stage} (${counts.events} events, ${counts.pinned} pinned, ${counts.relations} relations${counts.dropped > 0 ? `, ${counts.dropped} dropped by the mind's preference` : ""})`] };
      });
    } catch (e) {
      const message = brief(e);
      try {
        await ctx.inTx("write", async (c) => {
          await recordRun(c.tx, mind, "dream.generate", started, ctx.now(), false, { error: message });
        });
      } catch {
        /* the record is best effort */
      }
      return { changed: 0, notes: [`failed: ${message}`] };
    }
  },
};
