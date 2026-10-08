// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["set", "read", "clear"]),
    subject: text(200).optional(),
    state: text(200).optional(),
    intensity: z.number().min(0).max(1).default(0.5),
    note: text(4000).optional(),
    history_limit: z.number().int().min(0).max(100).default(5),
  })
  .superRefine((v, c) => {
    if (v.operation === "set") {
      if (v.subject === undefined) c.addIssue({ code: "custom", message: "subject is required to set a relation", path: ["subject"] });
      if (v.state === undefined) c.addIssue({ code: "custom", message: "state is required to set a relation", path: ["state"] });
    }
    if (v.operation === "clear" && v.subject === undefined) {
      c.addIssue({ code: "custom", message: "subject is required to clear a relation", path: ["subject"] });
    }
  });

export const mind_relate = defineVerb({
  name: "mind_relate",
  description:
    "Hold a standing relation to a subject (state and intensity), clear it, or read one " +
    "(with its recent history) or all live relations. Setting and clearing need the relate scope.",
  schema,
  scopeFor: (input) => (input.operation === "read" ? "read" : "relate"),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.operation === "read") {
      if (input.subject !== undefined) {
        const r = await ctx.tx.query(
          `select * from relations where mind_id = $1 and subject = $2 and cleared_at is null`,
          [ctx.mind_id, input.subject],
        );
        const h = await ctx.tx.query(
          `select * from events
           where mind_id = $1 and kind in ('relate.set', 'relate.clear') and payload->>'subject' = $2
           order by seq desc limit $3`,
          [ctx.mind_id, input.subject, input.history_limit],
        );
        return ok({ projection: { relation: r.rows[0] ?? null, history: h.rows } });
      }
      const r = await ctx.tx.query(
        `select * from relations where mind_id = $1 and cleared_at is null order by updated_at desc`,
        [ctx.mind_id],
      );
      return ok({ projection: { relations: r.rows } });
    }

    const subject = input.subject!;
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext('relation:' || $1 || ':' || $2))", [ctx.mind_id, subject]);

    if (input.operation === "clear") {
      const cur = await ctx.tx.query<{ cleared_at: Date | null }>(
        `select cleared_at from relations where mind_id = $1 and subject = $2`,
        [ctx.mind_id, subject],
      );
      if (cur.rows.length === 0 || cur.rows[0]!.cleared_at !== null) {
        return err("not_found", "relation not found", "subject");
      }
      const ev = await appendEvent(ctx, { kind: "relate.clear", payload: { subject } });
      const r = await ctx.tx.query(
        `update relations set cleared_at = $3 where mind_id = $1 and subject = $2 returning *`,
        [ctx.mind_id, subject, ev.created_at],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, relation: r.rows[0] } });
    }

    const ev = await appendEvent(ctx, {
      kind: "relate.set",
      payload: { subject, state: input.state, intensity: input.intensity, note: input.note ?? null },
    });
    const r = await ctx.tx.query(
      `insert into relations (mind_id, subject, state, intensity, note, last_event_id, updated_at, cleared_at)
       values ($1, $2, $3, $4, $5, $6, $7, null)
       on conflict (mind_id, subject) do update set
         state = excluded.state, intensity = excluded.intensity, note = excluded.note,
         last_event_id = excluded.last_event_id, updated_at = excluded.updated_at, cleared_at = null
       returning *`,
      [ctx.mind_id, subject, input.state, input.intensity, input.note ?? null, ev.id, ev.created_at],
    );
    return ok({ event_id: ev.id, projection: { event_id: ev.id, relation: r.rows[0] } });
  },
});
