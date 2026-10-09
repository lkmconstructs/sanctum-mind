// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { deriveLabel, mindIdSchema, nonBlankText, text, uuidSchema } from "./common.js";
import { OBSERVATION_NODE, RELATED_TO_EDGE, eventTime, instant, texture } from "./texture.js";
import { appendEventWithTimes } from "./ledger.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  content: nonBlankText(12000),
  texture: texture.optional(),
  label: nonBlankText(200).optional(),
  linked_to: z.array(uuidSchema).max(16).optional(),
  context: text(64).optional(),
  recorded_at: instant.optional(),
  event_time: eventTime.optional(),
}).superRefine((v, c) => {
  if (!v.texture?.charge || v.texture.charge.length === 0) {
    c.addIssue({ code: "custom", message: "texture.charge is required with at least one entry", path: ["texture", "charge"] });
  }
});

export const mind_observe = defineVerb({
  name: "mind_observe",
  description:
    "Record an observation: appends a ledger event and curates an observation graph node, " +
    "optionally linked (related_to) to existing live nodes. texture.charge is required.",
  schema,
  scopeFor: () => "write",
  embedText: (input) => input.content,
  handler: async (ctx, input) => {
    const label = input.label ?? deriveLabel(input.content);
    if (label === "") return err("invalid_input", "label is empty", "content");
    const texture = input.texture!; // the schema refinement guarantees it, with a charge
    // UUIDs are case-insensitive: lowercase before deduping, and store only the deduped list.
    const linked = [...new Set((input.linked_to ?? []).map((id) => id.toLowerCase()))];

    if (linked.length > 0) {
      const found = await ctx.tx.query<{ id: string }>(
        // for share: a concurrent invalidation must wait for this transaction (and our edge inserts).
        `select id from nodes where id = any($1::uuid[]) and invalidated_at is null for share`,
        [linked],
      );
      if (found.rows.length < linked.length) return err("not_found", "linked node not found", "linked_to");
    }

    // The event and the node carry the same text; the runner embedded it once, before the transaction.
    const emb = ctx.embedded ?? { vector: null, model: null };
    const ev = await appendEventWithTimes(ctx, {
      embedded: emb,
      kind: "observe",
      payload: { content: input.content, label, linked_to: linked },
      texture,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.recorded_at === undefined ? {} : { recorded_at: input.recorded_at }),
      ...(input.event_time === undefined ? {} : { event_time: input.event_time }),
    });

    // Copy the times from the event row itself (not from JS Dates) so microseconds survive.
    const node = await ctx.tx.query<{ id: string }>(
      `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, metadata,
                          recorded_at, event_time_start, event_time_end, event_time_granularity,
                          embedding, embedding_model)
       select $1::text, $2::text, $3::text, $4::text, $5::text, 'extracted', 1.0, $6::jsonb,
              recorded_at, event_time_start, event_time_end, event_time_granularity,
              $8::vector, $9::text
         from events where id = $7
       returning id`,
      [
        ctx.mind_id,
        OBSERVATION_NODE,
        label,
        input.content,
        ctx.caller.bearer,
        JSON.stringify({ texture, event_id: ev.id, context: input.context ?? null }),
        ev.id,
        emb.vector,
        emb.model,
      ],
    );
    const node_id = node.rows[0]!.id;

    const edges: string[] = [];
    for (const target of linked) {
      const r = await ctx.tx.query<{ id: string }>(
        `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata)
         values ($1, $2, $3, $4, $5, 0.5, 1.0, $6::jsonb)
         returning id`,
        [ctx.mind_id, RELATED_TO_EDGE, ctx.caller.bearer, node_id, target, JSON.stringify({ event_id: ev.id })],
      );
      edges.push(r.rows[0]!.id);
    }
    return ok({ event_id: ev.id, projection: { event_id: ev.id, node_id, edges } });
  },
});
