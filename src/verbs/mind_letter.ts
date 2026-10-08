// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["send", "inbox", "read_letter"]),
    to: mindIdSchema.optional(),
    letter_type: z.enum(["personal", "handoff", "proposal"]).default("personal"),
    subject: text(200).optional(),
    body: text(12000).optional(),
    deliver_at: z.iso.datetime().optional(),
    letter_id: z.uuid().optional(),
    include_read: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(10),
  })
  .superRefine((v, c) => {
    if (v.operation === "send") {
      if (v.to === undefined) c.addIssue({ code: "custom", message: "to is required to send a letter", path: ["to"] });
      if (v.body === undefined) c.addIssue({ code: "custom", message: "body is required to send a letter", path: ["body"] });
    }
    if (v.operation === "read_letter" && v.letter_id === undefined) {
      c.addIssue({ code: "custom", message: "letter_id is required to read a letter", path: ["letter_id"] });
    }
  });

export const mind_letter = defineVerb({
  name: "mind_letter",
  description:
    "Send a letter to another mind, list this mind's delivered inbox (bodies omitted), or read " +
    "one letter in full; the recipient's first read marks it read.",
  schema,
  // read_letter can write (the recipient's read receipt), and the runner makes read-scope
  // transactions read only, so it needs the letter scope. The mind acting as itself always passes.
  scopeFor: (input) => (input.operation === "inbox" ? "read" : "letter"),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.operation === "send") {
      const to = input.to!;
      if (to === ctx.mind_id) return err("invalid_input", "cannot send a letter to yourself", "to");
      const m = await ctx.tx.query(`select 1 from minds where mind_id = $1 and disabled_at is null`, [to]);
      if (m.rows.length === 0) return err("not_found", "recipient mind not found", "to");

      const ev = await appendEvent(ctx, {
        kind: "letter.send",
        payload: {
          to,
          letter_type: input.letter_type,
          subject: input.subject ?? null,
          deliver_at: input.deliver_at ?? null,
        },
      });
      const r = await ctx.tx.query(
        `insert into letters (from_mind, to_mind, letter_type, subject, body, deliver_at, sent_event_id, sent_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, to_mind as "to", letter_type, subject, deliver_at, sent_at`,
        [
          ctx.mind_id, to, input.letter_type, input.subject ?? null, input.body,
          input.deliver_at ?? null, ev.id, ev.created_at,
        ],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, letter: r.rows[0] } });
    }

    if (input.operation === "inbox") {
      const r = await ctx.tx.query(
        `select id, from_mind, to_mind, letter_type, subject, deliver_at, sent_event_id, sent_at, read_at, read_event_id
         from letters
         where to_mind = $1 and (deliver_at is null or deliver_at <= $2)
           and (read_at is null or $3::boolean)
         order by sent_at desc limit $4`,
        [ctx.mind_id, ctx.now(), input.include_read, input.limit],
      );
      return ok({ projection: { letters: r.rows } });
    }

    const letter_id = input.letter_id!;
    // Serialise readers of one letter so only one writes the read receipt.
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`letter:${letter_id}`]);
    const cur = await ctx.tx.query<{ from_mind: string; to_mind: string; deliver_at: Date | null; read_at: Date | null }>(
      `select from_mind, to_mind, deliver_at, read_at from letters where id = $1`,
      [letter_id],
    );
    const row = cur.rows[0];
    const isRecipient = row !== undefined && row.to_mind === ctx.mind_id;
    if (!row || (isRecipient && row.deliver_at !== null && row.deliver_at > ctx.now())) {
      return err("not_found", "letter not found", "letter_id");
    }

    let event_id: string | undefined;
    if (isRecipient && row.read_at === null) {
      const ev = await appendEvent(ctx, { kind: "letter.read", subject_id: letter_id, payload: { from: row.from_mind } });
      await ctx.tx.query(`update letters set read_at = $2, read_event_id = $3 where id = $1`, [letter_id, ev.created_at, ev.id]);
      event_id = ev.id;
    }
    const full = await ctx.tx.query(`select * from letters where id = $1`, [letter_id]);
    return ok({
      ...(event_id === undefined ? {} : { event_id }),
      projection: { letter: full.rows[0], ...(event_id === undefined ? {} : { event_id }) },
    });
  },
});
