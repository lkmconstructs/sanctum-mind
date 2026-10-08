import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
import { DESIRE_NODE, defaultLabel, insertSelfNode } from "./self_common.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["register", "list", "fulfill"]),
    want: text(4000).optional(),
    intensity: z.number().min(0).max(1).default(0.5),
    somatic: text(200).optional(),
    context: text(4000).optional(),
    desire_id: z.uuid().optional(),
    include_fulfilled: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .superRefine((v, c) => {
    if (v.operation === "register" && v.want === undefined) {
      c.addIssue({ code: "custom", message: "want is required to register a desire", path: ["want"] });
    }
    if (v.operation === "fulfill" && v.desire_id === undefined) {
      c.addIssue({ code: "custom", message: "desire_id is required to fulfill a desire", path: ["desire_id"] });
    }
  });

export const mind_desire = defineVerb<typeof schema, unknown>({
  name: "mind_desire",
  description: "Register a desire (a graph node with intensity), list live desires by intensity (fulfilled and faded ones only with include_fulfilled), or fulfill one.",
  schema,
  scopeFor: (input) => (input.operation === "list" ? "read" : "write"),
  embedText: (input) => input.operation === "register" ? (input.want ?? null) : null,
  handler: async (ctx, input) => {
    if (input.operation === "list") {
      const r = await ctx.tx.query(
        `select * from nodes
         where mind_id = $1 and node_type = $2 and invalidated_at is null
           and ($3::boolean or (coalesce((metadata->'fulfilled') = 'true'::jsonb, false) = false
                and coalesce((metadata->'faded') = 'true'::jsonb, false) = false))
         order by (case when jsonb_typeof(metadata->'intensity') = 'number' then (metadata->'intensity')::text::float end) desc nulls last,
                  created_at asc
         limit $4`,
        [ctx.mind_id, DESIRE_NODE, input.include_fulfilled, input.limit],
      );
      return ok({ projection: { desires: r.rows } });
    }

    if (input.operation === "register") {
      const want = input.want!;
      const payload = {
        want,
        intensity: input.intensity,
        somatic: input.somatic ?? null,
        context: input.context ?? null,
      };
      const ev = await appendEvent(ctx, { kind: "desire.register", payload });
      const node_id = await insertSelfNode(ctx, {
        node_type: DESIRE_NODE,
        label: defaultLabel(want),
        content: want,
        metadata: {
          intensity: input.intensity,
          somatic: input.somatic ?? null,
          context: input.context ?? null,
          event_id: ev.id,
          registered_at: ev.created_at,
          fulfilled: false,
        },
      });
      return ok({ event_id: ev.id, projection: { event_id: ev.id, node_id } });
    }

    const desire_id = input.desire_id!;
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`desire:${desire_id}`]);
    const cur = await ctx.tx.query<{ fulfilled: boolean | null }>(
      `select coalesce((metadata->'fulfilled') = 'true'::jsonb, false) as fulfilled from nodes
       where id = $1 and mind_id = $2 and node_type = $3 and invalidated_at is null`,
      [desire_id, ctx.mind_id, DESIRE_NODE],
    );
    if (cur.rows.length === 0) return err("not_found", "desire not found", "desire_id");
    if (cur.rows[0]!.fulfilled) return err("conflict", "desire is already fulfilled", "desire_id");

    const ev = await appendEvent(ctx, { kind: "desire.fulfill", subject_id: desire_id, payload: {} });
    const r = await ctx.tx.query(
      `update nodes set metadata = metadata || $2::jsonb where id = $1 returning *`,
      [desire_id, JSON.stringify({ fulfilled: true, fulfilled_at: ev.created_at, fulfill_event_id: ev.id })],
    );
    return ok({ event_id: ev.id, projection: { event_id: ev.id, node: r.rows[0] } });
  },
});
