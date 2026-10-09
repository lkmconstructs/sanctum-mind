// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb, type VerbContext } from "./types.js";
import { appendEvent, mindIdSchema, nonBlankText, text, uuidSchema } from "./common.js";

const STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
const TERMINAL = ["done", "cancelled"];

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["create", "list", "update"]),
    title: nonBlankText(512).optional(),
    description: text(12000).optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    status: z.enum(STATUSES).optional(),
    tags: z.array(text(64)).max(32).optional(),
    depends_on: z.array(uuidSchema).max(32).optional(),
    task_id: uuidSchema.optional(),
    filter_status: z.array(z.enum(STATUSES)).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .superRefine((v, c) => {
    if (v.operation === "create" && v.title === undefined) {
      c.addIssue({ code: "custom", message: "title is required to create a task", path: ["title"] });
    }
    if (v.operation === "create" && v.status !== undefined && v.status !== "open") {
      c.addIssue({ code: "custom", message: "a task is created open; update it to change status", path: ["status"] });
    }
    if (v.operation === "update") {
      if (v.task_id === undefined) {
        c.addIssue({ code: "custom", message: "task_id is required to update a task", path: ["task_id"] });
      }
      if (
        v.title === undefined && v.description === undefined && v.priority === undefined &&
        v.status === undefined && v.tags === undefined && v.depends_on === undefined
      ) {
        c.addIssue({
          code: "custom",
          message: "update needs at least one of title, description, priority, status, tags, depends_on",
          path: ["title"],
        });
      }
    }
  });

/** blocked_by: the entries of depends_on whose task is neither done nor cancelled, computed in SQL. */
const SELECT_TASK = `
  select t.*,
    coalesce(
      (select array_agg(d.id order by d.created_at, d.id) from tasks d
       where d.id = any(t.depends_on) and d.mind_id = t.mind_id and d.status not in ('done', 'cancelled')),
      '{}'::uuid[]) as blocked_by
  from tasks t`;

async function dependsOnExists(ctx: VerbContext, ids: string[]): Promise<boolean> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return true;
  const r = await ctx.tx.query<{ n: string }>(
    `select count(*) as n from tasks where id = any($1::uuid[]) and mind_id = $2`,
    [distinct, ctx.mind_id],
  );
  return Number(r.rows[0]!.n) === distinct.length;
}

/** True when `task_id` is reachable from `deps` by following depends_on, i.e. depending on `deps` would close a cycle. */
async function wouldCycle(ctx: VerbContext, task_id: string, deps: string[]): Promise<boolean> {
  if (deps.length === 0) return false;
  const r = await ctx.tx.query<{ hit: boolean }>(
    `with recursive walk(id) as (
       select unnest($2::uuid[])
       union
       select unnest(t.depends_on) from tasks t join walk w on t.id = w.id where t.mind_id = $3
     )
     select exists (select 1 from walk where id = $1) as hit`,
    [task_id, deps, ctx.mind_id],
  );
  return r.rows[0]!.hit;
}

const notFoundDeps = () => err("not_found", "one or more depends_on tasks not found", "depends_on");

export const mind_task = defineVerb({
  name: "mind_task",
  description:
    "Track tasks: create one (with optional dependencies), list them (urgent first, with blocked_by), " +
    "or update one. Done and cancelled are final.",
  schema,
  scopeFor: (input) => (input.operation === "list" ? "read" : "write"),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.operation === "list") {
      const filter = input.filter_status ?? ["open", "in_progress", "blocked"];
      const r = await ctx.tx.query(
        `${SELECT_TASK}
         where t.mind_id = $1 and t.status = any($2::text[])
         order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at asc
         limit $3`,
        [ctx.mind_id, filter, input.limit],
      );
      return ok({ projection: { tasks: r.rows } });
    }

    if (input.operation === "create") {
      // A new task has a fresh id nothing can depend on yet, so creation cannot close a cycle.
      const depends_on = [...new Set(input.depends_on ?? [])];
      if (!(await dependsOnExists(ctx, depends_on))) return notFoundDeps();
      const priority = input.priority ?? "normal";
      const tags = input.tags ?? [];
      const ev = await appendEvent(ctx, {
        kind: "task.create",
        payload: { title: input.title, description: input.description ?? null, priority, tags, depends_on },
      });
      const ins = await ctx.tx.query<{ id: string }>(
        `insert into tasks (mind_id, title, description, priority, tags, depends_on, created_event_id, created_at, updated_at, completed_at)
         values ($1, $2, $3, $4, $5, $6::uuid[], $7, $8, $8, null) returning id`,
        [
          ctx.mind_id, input.title, input.description ?? null, priority, tags, depends_on,
          ev.id, ev.created_at,
        ],
      );
      const r = await ctx.tx.query(`${SELECT_TASK} where t.id = $1`, [ins.rows[0]!.id]);
      return ok({ event_id: ev.id, projection: { event_id: ev.id, task: r.rows[0] } });
    }

    const task_id = input.task_id!;
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", ["task:" + task_id]);
    const cur = await ctx.tx.query<{ status: string }>(`select status from tasks where id = $1 and mind_id = $2`, [
      task_id,
      ctx.mind_id,
    ]);
    if (cur.rows.length === 0) return err("not_found", "task not found", "task_id");
    if (TERMINAL.includes(cur.rows[0]!.status)) {
      return err("conflict", `task is ${cur.rows[0]!.status} and cannot be updated`, "task_id");
    }
    const depends_on = input.depends_on === undefined ? undefined : [...new Set(input.depends_on)];
    if (depends_on !== undefined) {
      if (depends_on.includes(task_id)) return err("invalid_input", "a task cannot depend on itself", "depends_on");
      if (!(await dependsOnExists(ctx, depends_on))) return notFoundDeps();
      if (await wouldCycle(ctx, task_id, depends_on)) return err("invalid_input", "dependency cycle", "depends_on");
    }

    const payload: Record<string, unknown> = {};
    for (const k of ["title", "description", "priority", "status", "tags", "depends_on"] as const) {
      const v = k === "depends_on" ? depends_on : input[k];
      if (v !== undefined) payload[k] = v;
    }
    const ev = await appendEvent(ctx, { kind: "task.update", subject_id: task_id, payload });
    await ctx.tx.query(
      `update tasks set
         title = coalesce($2, title),
         description = coalesce($3, description),
         priority = coalesce($4, priority),
         status = coalesce($5, status),
         tags = coalesce($6::text[], tags),
         depends_on = coalesce($7::uuid[], depends_on),
         completed_at = case when $5 = 'done' then $8::timestamptz else completed_at end,
         updated_at = $8
       where id = $1 and mind_id = $9`,
      [
        task_id, input.title ?? null, input.description ?? null, input.priority ?? null, input.status ?? null,
        input.tags ?? null, depends_on ?? null, ev.created_at, ctx.mind_id,
      ],
    );
    const r = await ctx.tx.query(`${SELECT_TASK} where t.id = $1`, [task_id]);
    return ok({ event_id: ev.id, projection: { event_id: ev.id, task: r.rows[0] } });
  },
});
