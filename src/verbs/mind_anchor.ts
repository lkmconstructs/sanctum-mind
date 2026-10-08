import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
import { ANCHOR_NODE, insertSelfNode } from "./self_common.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["create", "list", "check"]),
    trigger: text(200).optional(),
    memory_id: z.uuid().optional(),
    response: text(4000).optional(),
    text: text(12000).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .superRefine((v, c) => {
    if (v.operation === "create") {
      if (v.trigger === undefined) {
        c.addIssue({ code: "custom", message: "trigger is required to create an anchor", path: ["trigger"] });
      }
      if ((v.memory_id === undefined) === (v.response === undefined)) {
        c.addIssue({
          code: "custom",
          message: "exactly one of memory_id or response is required",
          path: ["memory_id"],
        });
      }
    }
    if (v.operation === "check" && v.text === undefined) {
      c.addIssue({ code: "custom", message: "text is required to check anchors", path: ["text"] });
    }
  });

export const mind_anchor = defineVerb<typeof schema, unknown>({
  name: "mind_anchor",
  description:
    "Anchors: create a trigger bound to a memory or a stored response, list them, or check text " +
    "against live triggers (case-insensitive substring).",
  schema,
  scopeFor: (input) => (input.operation === "create" ? "write" : "read"),
  embedText: (input) => input.operation === "create" ? (input.response ?? null) : null,
  handler: async (ctx, input) => {
    if (input.operation === "list") {
      const r = await ctx.tx.query(
        `select * from nodes where mind_id = $1 and node_type = $2 and invalidated_at is null
         order by created_at asc limit $3`,
        [ctx.mind_id, ANCHOR_NODE, input.limit],
      );
      return ok({ projection: { anchors: r.rows } });
    }

    if (input.operation === "check") {
      const anchors = await ctx.tx.query<{ id: string; metadata: { memory_id?: string | null } }>(
        `select * from nodes
         where mind_id = $1 and node_type = $2 and invalidated_at is null
           and position(metadata->>'trigger_lc' in lower($3)) > 0
         order by created_at asc`,
        [ctx.mind_id, ANCHOR_NODE, input.text],
      );
      const fired: Array<{ anchor: unknown; memory?: { id: string; label: string; content: string } }> = [];
      for (const anchor of anchors.rows) {
        const memory_id = anchor.metadata.memory_id;
        const entry: { anchor: unknown; memory?: { id: string; label: string; content: string } } = { anchor };
        if (memory_id) {
          const m = await ctx.tx.query<{ id: string; label: string; content: string }>(
            `select id, label, content from nodes where id = $1 and mind_id = $2 and invalidated_at is null`,
            [memory_id, ctx.mind_id],
          );
          if (m.rows[0]) entry.memory = m.rows[0];
        }
        fired.push(entry);
      }
      return ok({ projection: { fired } });
    }

    const trigger = input.trigger!;
    const memory_id = input.memory_id ?? null;
    if (memory_id !== null) {
      const m = await ctx.tx.query(`select id from nodes where id = $1 and mind_id = $2 and invalidated_at is null`, [
        memory_id,
        ctx.mind_id,
      ]);
      if (m.rows.length === 0) return err("not_found", "memory not found", "memory_id");
    }
    const response = input.response ?? null;
    const ev = await appendEvent(ctx, { kind: "anchor.create", payload: { trigger, memory_id, response } });
    const node_id = await insertSelfNode(ctx, {
      node_type: ANCHOR_NODE,
      label: trigger,
      content: response ?? "",
      metadata: { trigger, trigger_lc: trigger.toLowerCase(), memory_id, response, event_id: ev.id },
    });
    if (memory_id !== null) {
      await ctx.tx.query(
        `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata)
         values ($1, 'references', $2, $3, $4, 0.5, 1.0, $5::jsonb)`,
        [ctx.mind_id, ctx.caller.bearer, node_id, memory_id, JSON.stringify({ event_id: ev.id })],
      );
    }
    return ok({ event_id: ev.id, projection: { event_id: ev.id, node_id } });
  },
});
