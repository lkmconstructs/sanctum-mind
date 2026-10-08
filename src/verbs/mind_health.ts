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
    return ok({ projection: { db: "up" as const, mind_id: input.mind_id, counts, last_daemon_run, outbox } });
  },
});
