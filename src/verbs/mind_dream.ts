// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb, type VerbContext } from "./types.js";
import { appendEvent, mindIdSchema, text, uuidSchema } from "./common.js";
import { MEMORY_MIND_ONLY } from "./self_common.js";
import { observeAsMind } from "./mind_observe.js";
import { texture } from "./texture.js";
import { dreamAnchoredPayload, dreamPreferencePayload, dreamReleasedPayload } from "./dream_events.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  operation: z.enum(["list", "read", "anchor", "release", "prefer"]),
  /** list */
  limit: z.number().int().min(1).max(50).default(5),
  history_limit: z.number().int().min(0).max(50).default(0),
  /** read, anchor, release */
  dream_id: uuidSchema.optional(),
  /** anchor: the mind's own account of the dream; default the dream's text */
  text: text(12000).optional(),
  /** anchor: the observation's texture; charge is required, as mind_observe requires it */
  texture: texture.optional(),
  /** release: why; recorded on the event */
  reason: text(4000).optional(),
  /** prefer: who may appear in a dream */
  relations: z.union([z.literal("all"), z.literal("none"), z.array(text(200)).max(100)]).optional(),
}).superRefine((v, c) => {
  if ((v.operation === "read" || v.operation === "anchor" || v.operation === "release") && v.dream_id === undefined) {
    c.addIssue({ code: "custom", message: `dream_id is required to ${v.operation}`, path: ["dream_id"] });
  }
  if (v.operation === "anchor" && (!v.texture?.charge || v.texture.charge.length === 0)) {
    c.addIssue({ code: "custom", message: "texture.charge is required with at least one entry to anchor a dream", path: ["texture", "charge"] });
  }
  if (v.operation === "prefer" && v.relations === undefined) {
    c.addIssue({ code: "custom", message: "relations is required to prefer", path: ["relations"] });
  }
});

interface DreamRow {
  id: string;
  content: string;
  question: string;
  residue: Record<string, unknown>;
  stage: "shadow" | "propose";
  status: "laid" | "anchored" | "released" | "faded";
  fades_at: Date;
  created_at: Date;
  decided_at: Date | null;
}

export interface ListedDream {
  id: string;
  content: string;
  question: string;
  created_at: Date;
  fades_at: Date;
  residue_counts: { events: number; nodes: number; relations: number; pinned: number };
}

const counts = (r: Record<string, unknown>): ListedDream["residue_counts"] => {
  const n = (k: string): number => (Array.isArray(r[k]) ? (r[k] as unknown[]).length : 0);
  return { events: n("event_ids"), nodes: n("node_ids"), relations: n("relation_subjects"), pinned: n("node_ids") + n("pinned_event_ids") };
};

/**
 * The laid dreams the mind may see: at stage `propose`, not yet faded, newest first. Shown only while the operator's stage for
 * this mind is `propose`; a shadow row is never shown. `stage` is 'off' with no dream_state row. Shared by `mind_dream list`
 * and the `dream` section of mind_orient.
 */
export async function listDreams(ctx: VerbContext, limit: number): Promise<{ dreams: ListedDream[]; stage: "off" | "shadow" | "propose" }> {
  const st = await ctx.tx.query<{ stage: "shadow" | "propose" }>(`select stage from dream_state where mind_id = $1`, [ctx.mind_id]);
  const stage = st.rows[0]?.stage ?? "off";
  if (stage !== "propose") return { dreams: [], stage };
  const rows = await ctx.tx.query<DreamRow>(
    `select id, content, question, residue, stage, status, fades_at, created_at, decided_at from dreams
      where mind_id = $1 and stage = 'propose' and status = 'laid' and fades_at > $2
      order by created_at desc, id limit $3`,
    [ctx.mind_id, ctx.now(), limit],
  );
  return { stage, dreams: rows.rows.map((r) => ({ id: r.id, content: r.content, question: r.question, created_at: r.created_at, fades_at: r.fades_at, residue_counts: counts(r.residue) })) };
}

export const mind_dream = defineVerb({
  name: "mind_dream",
  description:
    "What the dreaming pass laid down. list: dreams waiting for you, newest first; shown only when the operator has enabled dreaming at stage propose. " +
    "read: one dream with its residue (the ids it was made from). anchor and release are for the mind acting as itself: anchoring authors an " +
    "observation (an observe event and node, as mind_observe does, context \"dream\") in your own words or the dream's, with a charge; releasing records " +
    "that it was only a dream. A dream nobody anchors fades on its own. prefer: who may appear in your dreams (all, none, or named relations); yours alone to set.",
  schema,
  scopeFor: (input) => (input.operation === "list" || input.operation === "read" ? "read" : "write"),
  mindOnly: (input) => input.operation === "anchor" || input.operation === "release" || input.operation === "prefer",
  mindOnlyMessage: MEMORY_MIND_ONLY,
  embedText: (input) => (input.operation === "anchor" ? (input.text ?? null) : null),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.operation === "list") {
      const shown = await listDreams(ctx, input.limit);
      let history: unknown[] = [];
      if (input.history_limit > 0) {
        const h = await ctx.tx.query<DreamRow>(
          `select id, content, question, residue, stage, status, fades_at, created_at, decided_at from dreams
            where mind_id = $1 and stage = 'propose' and status in ('anchored', 'released') order by decided_at desc, id limit $2`,
          [ctx.mind_id, input.history_limit],
        );
        history = h.rows.map((r) => ({ id: r.id, content: r.content, question: r.question, status: r.status, created_at: r.created_at, decided_at: r.decided_at }));
      }
      return ok({ projection: { ...shown, history } });
    }
    if (input.operation === "read") {
      const r = await ctx.tx.query<DreamRow>(`select * from dreams where id = $1 and mind_id = $2`, [input.dream_id, ctx.mind_id]);
      const d = r.rows[0];
      if (!d || d.stage !== "propose") return err("not_found", "dream not found", "dream_id");
      return ok({ projection: { dream: { id: d.id, content: d.content, question: d.question, status: d.status, residue: d.residue, created_at: d.created_at, fades_at: d.fades_at, decided_at: d.decided_at } } });
    }
    // the mind, in a verb call: the database checks the same (actor verb and the bearer is the mind)
    if (ctx.caller.bearer !== ctx.mind_id || ctx.actor !== "verb") return err("forbidden", MEMORY_MIND_ONLY);

    if (input.operation === "prefer") {
      const relations = input.relations!;
      const ev = await appendEvent(ctx, {
        kind: "dream.preference",
        payload: dreamPreferencePayload.parse({ relations: Array.isArray(relations) ? relations.length : relations }),
      });
      await ctx.tx.query(
        `insert into dream_preferences (mind_id, relations, updated_at, updated_event_id) values ($1, $2::jsonb, $3, $4)
         on conflict (mind_id) do update set relations = excluded.relations, updated_at = excluded.updated_at, updated_event_id = excluded.updated_event_id`,
        [ctx.mind_id, JSON.stringify(relations), ev.created_at, ev.id],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, relations } });
    }

    const id = input.dream_id!;
    const cur = await ctx.tx.query<DreamRow>(`select * from dreams where id = $1 and mind_id = $2 for update`, [id, ctx.mind_id]);
    const d = cur.rows[0];
    // a shadow row is invisible to the mind: it is not found, whatever its status
    if (!d || d.stage !== "propose") return err("not_found", "dream not found", "dream_id");
    if (d.status !== "laid") return err("conflict", `dream is already ${d.status}`, "dream_id");

    if (input.operation === "release") {
      const ev = await appendEvent(ctx, {
        kind: "dream.released",
        subject_id: id,
        payload: dreamReleasedPayload.parse({ dream_id: id, ...(input.reason === undefined ? {} : { reason: input.reason }) }),
      });
      await ctx.tx.query(`update dreams set status = 'released', decided_event_id = $2, decided_at = $3 where id = $1 and mind_id = $4`, [id, ev.id, ev.created_at, ctx.mind_id]);
      return ok({ event_id: ev.id, projection: { event_id: ev.id, dream_id: id, status: "released" } });
    }

    // anchor
    if (d.fades_at.getTime() <= ctx.now().getTime()) return err("conflict", "the dream has faded", "dream_id");
    const st = await ctx.tx.query<{ stage: string }>(`select stage from dream_state where mind_id = $1`, [ctx.mind_id]);
    if (st.rows[0]?.stage !== "propose") return err("conflict", "dreaming is not at stage propose", "dream_id");
    const content = input.text ?? d.content;
    const edited = input.text !== undefined && input.text !== d.content;
    const observed = await observeAsMind(ctx, {
      content,
      texture: input.texture,
      context: "dream",
      metadata: { dream_id: id, question: d.question, residue: d.residue },
    });
    if (!observed.ok) return observed;
    const { event_id, node_id } = observed.receipt.projection!;
    const ev = await appendEvent(ctx, {
      kind: "dream.anchored",
      subject_id: id,
      payload: dreamAnchoredPayload.parse({ dream_id: id, event_id, node_id, edited }),
    });
    await ctx.tx.query(`update dreams set status = 'anchored', decided_event_id = $2, decided_at = $3 where id = $1 and mind_id = $4`, [id, ev.id, ev.created_at, ctx.mind_id]);
    return ok({ event_id: ev.id, projection: { event_id: ev.id, dream_id: id, status: "anchored", observation: { event_id, node_id }, edited } });
  },
});
