// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { ok } from "../result.js";
import { defineVerb } from "./types.js";
import { mindIdSchema } from "./common.js";

export const mind_health = defineVerb({
  name: "mind_health",
  description: "Report database status, row counts and the last daemon run for a mind. Appends no event.",
  schema: z.strictObject({ mind_id: mindIdSchema }),
  scopeFor: () => "read",
  handler: async (ctx, input) => {
    const count = async (table: "events" | "nodes" | "edges"): Promise<number> => {
      const r = await ctx.tx.query<{ n: string }>(`select count(*) as n from ${table}`);
      return Number(r.rows[0]!.n);
    };
    const counts = { events: await count("events"), nodes: await count("nodes"), edges: await count("edges") };
    const run = await ctx.tx.query<{ started_at: Date; finished_at: Date | null; passes: unknown; stale: boolean }>(
      `select started_at, finished_at, passes,
            (finished_at is null and started_at < now() - interval '1 hour') as stale
       from daemon_runs where mind_id = $1 order by started_at desc limit 1`,
      [ctx.mind_id],
    );
    const row = run.rows[0];
    const passes = Array.isArray(row?.passes) ? (row.passes as Array<{ ok?: unknown }>) : [];
    const last_daemon_run = row
      ? {
          started_at: row.started_at,
          finished_at: row.finished_at,
          stale: row.stale === true,
          passes_ok: passes.filter((p) => p.ok === true).length,
          passes_failed: passes.filter((p) => p.ok === false).length,
        }
      : null;
    const ob = await ctx.tx.query<{ pending: string; failing: string; total: string }>(
      `select count(*) filter (where delivered_at is null) as pending,
              count(*) filter (where delivered_at is null and attempts > 0) as failing,
              count(*) as total
         from event_outbox where mind_id = $1`,
      [ctx.mind_id],
    );
    const o = ob.rows[0]!;
    const outbox =
      ctx.sinks.length === 0 && Number(o.total) === 0 ? null : { pending: Number(o.pending), failing: Number(o.failing) };
    // the extractor's switch and its visible backlog: pending counts only proposals the mind may see (stage propose)
    const ex = await ctx.tx.query<{ enabled: boolean; stage: string; paused: boolean }>(
      `select enabled, stage, paused_at is not null as paused from extractor_state where mind_id = $1`,
      [ctx.mind_id],
    );
    const pend = await ctx.tx.query<{ n: string }>(
      `select count(*) as n from noticings where mind_id = $1 and stage = 'propose' and status = 'pending' and expires_at > $2`,
      [ctx.mind_id, ctx.now()],
    );
    const mv = await ctx.tx.query<{ v: number | null }>(`select max(version) as v from extractor_models where mind_id = $1`, [ctx.mind_id]);
    // the extractor's model-backed passes (notice.extract, notice.train) are scheduled daily; this is how the last extract went
    const lr = await ctx.tx.query<{ started_at: Date; ok: boolean; skipped: boolean }>(
      `select started_at, ok, coalesce(notes->>'skipped', '') = 'true' as skipped from extractor_runs
        where mind_id = $1 and pass = 'notice.extract' order by started_at desc limit 1`,
      [ctx.mind_id],
    );
    const extractor = {
      enabled: ex.rows[0]?.enabled ?? false,
      stage: ex.rows[0]?.stage ?? "off",
      paused: ex.rows[0]?.paused ?? false,
      // what the mind could be shown: nothing unless the operator's stage is propose
      pending: ex.rows[0]?.stage === "propose" ? Number(pend.rows[0]!.n) : 0,
      model_version: mv.rows[0]?.v ?? 0,
      last_run: lr.rows[0] ? { pass: "notice.extract", started_at: lr.rows[0].started_at, ok: lr.rows[0].ok, skipped: lr.rows[0].skipped } : null,
    };
    return ok({ projection: { db: "up" as const, mind_id: input.mind_id, counts, last_daemon_run, outbox, extractor } });
  },
});
