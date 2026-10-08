import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, nonBlankText, text } from "./common.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["add", "list", "update", "resolve", "archive"]),
    label: nonBlankText(512).optional(),
    priority: z.enum(["low", "normal", "high"]).optional(),
    tags: z.array(text(64)).max(32).optional(),
    thread_id: z.uuid().optional(),
    note: text(4000).optional(),
    status: z.enum(["active", "resolved", "archived", "all"]).default("active"),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .superRefine((v, c) => {
    if (v.operation === "add" && v.label === undefined) {
      c.addIssue({ code: "custom", message: "label is required to add a thread", path: ["label"] });
    }
    if ((v.operation === "update" || v.operation === "resolve" || v.operation === "archive") && v.thread_id === undefined) {
      c.addIssue({ code: "custom", message: `thread_id is required to ${v.operation} a thread`, path: ["thread_id"] });
    }
    if (
      v.operation === "update" &&
      v.label === undefined && v.priority === undefined && v.tags === undefined && v.note === undefined
    ) {
      c.addIssue({
        code: "custom",
        message: "update needs at least one of label, priority, tags, note",
        path: ["label"],
      });
    }
  });

export const mind_thread = defineVerb({
  name: "mind_thread",
  description:
    "Follow ongoing concerns: add a thread, list them (high priority first), update one, " +
    "or resolve or archive it.",
  schema,
  scopeFor: (input) => (input.operation === "list" ? "read" : "write"),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.operation === "list") {
      const r = await ctx.tx.query(
        `select * from threads
         where mind_id = $1 and ($2 = 'all' or status = $2)
         order by case priority when 'high' then 0 when 'normal' then 1 else 2 end, created_at asc
         limit $3`,
        [ctx.mind_id, input.status, input.limit],
      );
      return ok({ projection: { threads: r.rows } });
    }

    if (input.operation === "add") {
      const priority = input.priority ?? "normal";
      const tags = input.tags ?? [];
      const ev = await appendEvent(ctx, { kind: "thread.add", payload: { label: input.label, priority, tags } });
      const r = await ctx.tx.query(
        `insert into threads (mind_id, label, priority, tags, created_event_id, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $6) returning *`,
        [ctx.mind_id, input.label, priority, tags, ev.id, ev.created_at],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, thread: r.rows[0] } });
    }

    const thread_id = input.thread_id!;
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", ["thread:" + thread_id]);
    const cur = await ctx.tx.query<{ status: string }>(
      `select status from threads where id = $1 and mind_id = $2`,
      [thread_id, ctx.mind_id],
    );
    if (cur.rows.length === 0) return err("not_found", "thread not found", "thread_id");
    const status = cur.rows[0]!.status;

    if (input.operation === "archive") {
      if (status === "archived") return err("conflict", "thread is already archived", "thread_id");
      const ev = await appendEvent(ctx, { kind: "thread.archive", subject_id: thread_id, payload: {} });
      const r = await ctx.tx.query(
        `update threads set status = 'archived', updated_at = $2 where id = $1 returning *`,
        [thread_id, ev.created_at],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, thread: r.rows[0] } });
    }

    if (status !== "active") return err("conflict", `thread is ${status}, not active`, "thread_id");

    if (input.operation === "resolve") {
      const ev = await appendEvent(ctx, {
        kind: "thread.resolve",
        subject_id: thread_id,
        payload: { note: input.note ?? null },
      });
      const r = await ctx.tx.query(
        `update threads set status = 'resolved', resolved_at = $2, resolution = $3, updated_at = $2
         where id = $1 returning *`,
        [thread_id, ev.created_at, input.note ?? null],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, thread: r.rows[0] } });
    }

    // update
    const payload: Record<string, unknown> = {};
    if (input.label !== undefined) payload.label = input.label;
    if (input.priority !== undefined) payload.priority = input.priority;
    if (input.tags !== undefined) payload.tags = input.tags;
    if (input.note !== undefined) payload.note = input.note;
    const ev = await appendEvent(ctx, { kind: "thread.update", subject_id: thread_id, payload });
    const noteEntry =
      input.note === undefined ? null : JSON.stringify({ event_id: ev.id, at: ev.created_at, note: input.note });
    const r = await ctx.tx.query(
      `update threads set
         label = coalesce($2, label),
         priority = coalesce($3, priority),
         tags = coalesce($4::text[], tags),
         notes = case when $5::jsonb is null then notes else notes || jsonb_build_array($5::jsonb) end,
         updated_at = $6
       where id = $1 returning *`,
      [thread_id, input.label ?? null, input.priority ?? null, input.tags ?? null, noteEntry, ev.created_at],
    );
    return ok({ event_id: ev.id, projection: { event_id: ev.id, thread: r.rows[0] } });
  },
});
