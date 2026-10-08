import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
import { lockKeys } from "./charge.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["create", "resolve", "list"]),
    label: text(512).optional(),
    urgency: z.enum(["burning", "nagging"]).default("nagging"),
    context: text(4000).optional(),
    loop_id: z.uuid().optional(),
    resolution: text(4000).optional(),
    include_resolved: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .superRefine((v, c) => {
    if (v.operation === "create" && v.label === undefined) {
      c.addIssue({ code: "custom", message: "label is required to create a loop", path: ["label"] });
    }
    if (v.operation === "resolve" && v.loop_id === undefined) {
      c.addIssue({ code: "custom", message: "loop_id is required to resolve a loop", path: ["loop_id"] });
    }
  });

export const mind_loop = defineVerb({
  name: "mind_loop",
  description:
    "Track open loops: create one (burning or nagging), resolve one, or list them " +
    "(unresolved by default, burning first, oldest first).",
  schema,
  scopeFor: (input) => (input.operation === "list" ? "read" : "write"),
  handler: async (ctx, input) => {
    if (input.operation === "list") {
      const r = await ctx.tx.query(
        `select * from loops
         where mind_id = $1 and ($2::boolean or resolved_at is null)
         order by case urgency when 'burning' then 0 else 1 end, created_at asc
         limit $3`,
        [ctx.mind_id, input.include_resolved, input.limit],
      );
      return ok({ projection: { loops: r.rows } });
    }

    if (input.operation === "create") {
      const ev = await appendEvent(ctx, {
        kind: "loop.create",
        payload: { label: input.label, urgency: input.urgency, context: input.context ?? null },
      });
      const r = await ctx.tx.query(
        `insert into loops (mind_id, label, urgency, context, created_event_id, created_at)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [ctx.mind_id, input.label, input.urgency, input.context ?? null, ev.id, ev.created_at],
      );
      return ok({ event_id: ev.id, projection: r.rows[0] });
    }

    const loop_id = input.loop_id!;
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [lockKeys.loop(loop_id)]);
    const cur = await ctx.tx.query<{ resolved_at: Date | null }>(
      `select resolved_at from loops where id = $1 and mind_id = $2`,
      [loop_id, ctx.mind_id],
    );
    if (cur.rows.length === 0) return err("not_found", "loop not found", "loop_id");
    if (cur.rows[0]!.resolved_at !== null) return err("conflict", "loop is already resolved", "loop_id");

    const ev = await appendEvent(ctx, {
      kind: "loop.resolve",
      subject_id: loop_id,
      payload: { resolution: input.resolution ?? null },
    });
    const r = await ctx.tx.query(
      `update loops set resolved_event_id = $2, resolution = $3, resolved_at = $4 where id = $1 returning *`,
      [loop_id, ev.id, input.resolution ?? null, ev.created_at],
    );
    return ok({ event_id: ev.id, projection: r.rows[0] });
  },
});
