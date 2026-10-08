import { z } from "zod";
import { ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";

const handoffSchema = z.strictObject({
  tone: text(200).optional(),
  register: text(200).optional(),
  last_corrections: z.array(text(1000)).max(50).optional(),
  unresolved_tension: text(4000).optional(),
  partner_state: text(4000).optional(),
  active_texture: text(4000).optional(),
  reentry_instructions: text(4000).optional(),
  notes: text(12000).optional(),
});

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["write", "read"]),
    context: text(64).default(""),
    history_limit: z.number().int().min(0).max(50).default(0),
    handoff: handoffSchema.optional(),
  })
  .superRefine((v, c) => {
    if (v.operation === "write") {
      const fields = v.handoff === undefined ? [] : Object.values(v.handoff).filter((x) => x !== undefined);
      if (fields.length === 0) {
        c.addIssue({ code: "custom", message: "handoff with at least one field is required to write", path: ["handoff"] });
      }
    }
  });

export const mind_handoff = defineVerb({
  name: "mind_handoff",
  description:
    "Leave or read a session handoff for a lane (context): tone, register, last corrections, unresolved tension, " +
    "partner state, active texture, reentry instructions, notes. A write replaces the whole snapshot; fields not " +
    "supplied are dropped. read returns the current handoff and, with history_limit, earlier writes newest first.",
  schema,
  scopeFor: (input) => (input.operation === "read" ? "read" : "write"),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    const context = input.context;

    if (input.operation === "write") {
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`handoffs:${ctx.mind_id}:${context}`]);
      const ev = await appendEvent(ctx, {
        kind: "handoff.write",
        payload: { context, handoff: input.handoff },
        ...(context === "" ? {} : { context }),
      });
      const r = await ctx.tx.query(
        `insert into handoffs (mind_id, context, handoff, session_id, last_event_id, updated_at)
         values ($1, $2, $3::jsonb, $4, $5, $6)
         on conflict (mind_id, context) do update set
           handoff = excluded.handoff, session_id = excluded.session_id,
           last_event_id = excluded.last_event_id, updated_at = excluded.updated_at
         returning *`,
        [ctx.mind_id, context, JSON.stringify(input.handoff), ctx.session_id ?? null, ev.id, ev.created_at],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, handoff: r.rows[0] } });
    }

    const cur = await ctx.tx.query(`select * from handoffs where mind_id = $1 and context = $2`, [ctx.mind_id, context]);
    let history: unknown[] = [];
    if (input.history_limit > 0) {
      const h = await ctx.tx.query(
        `select id as event_id, created_at, session_id, payload->'handoff' as handoff
         from events
         where mind_id = $1 and kind = 'handoff.write' and payload->>'context' = $2
         order by seq desc limit $3`,
        [ctx.mind_id, context, input.history_limit],
      );
      history = h.rows;
    }
    return ok({ projection: { handoff: cur.rows[0] ?? null, history } });
  },
});
