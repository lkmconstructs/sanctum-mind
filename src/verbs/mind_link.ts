// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  source_id: z.uuid(),
  target_id: z.uuid(),
  edge_type: z
    .enum([
      "related_to", "contradicts", "conflicts_with", "corrects", "derived_from",
      "references", "felt_toward", "involves", "depends_on", "followed_by",
    ])
    .default("related_to"),
  weight: z.number().min(0).max(1).default(0.5),
  note: text(4000).optional(),
});

export const mind_link = defineVerb({
  name: "mind_link",
  description:
    "Link two live graph nodes with a typed weighted edge. Linking the same pair with the " +
    "same type again returns the existing edge (warning: exists) and writes nothing.",
  schema,
  scopeFor: () => "write",
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.source_id === input.target_id) {
      return err("invalid_input", "a node cannot be linked to itself", "target_id");
    }
    for (const [field, id] of [["source_id", input.source_id], ["target_id", input.target_id]] as const) {
      const n = await ctx.tx.query(`select 1 from nodes where id = $1 and invalidated_at is null`, [id]);
      if (n.rows.length === 0) return err("not_found", `${field} is not a live node`, field);
    }

    // Serialise on the triple so concurrent identical links cannot both insert.
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext('link:' || $1 || ':' || $2 || ':' || $3 || ':' || $4))", [
      ctx.mind_id, input.source_id, input.target_id, input.edge_type,
    ]);
    const existing = await ctx.tx.query<{ id: string }>(
      `select id from edges where source_node_id = $1 and target_node_id = $2 and edge_type = $3 limit 1`,
      [input.source_id, input.target_id, input.edge_type],
    );
    if (existing.rows.length > 0) {
      return ok({ projection: { edge_id: existing.rows[0]!.id, existing: true }, warnings: ["exists"] });
    }

    const ev = await appendEvent(ctx, {
      kind: "link",
      payload: {
        source_id: input.source_id,
        target_id: input.target_id,
        edge_type: input.edge_type,
        weight: input.weight,
        note: input.note ?? null,
      },
    });
    const r = await ctx.tx.query<{ id: string }>(
      `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata)
       values ($1, $2, $3, $4, $5, $6, 1.0, $7::jsonb) returning id`,
      [
        ctx.mind_id, input.edge_type, ctx.caller.bearer, input.source_id, input.target_id, input.weight,
        JSON.stringify({ note: input.note ?? null, event_id: ev.id }),
      ],
    );
    return ok({ event_id: ev.id, projection: { event_id: ev.id, edge_id: r.rows[0]!.id } });
  },
});
