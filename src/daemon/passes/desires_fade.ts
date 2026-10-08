// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { appendEvent } from "../../verbs/common.js";
import { DESIRE_NODE } from "../../verbs/self_common.js";
import { DAY_MS, ago, type DaemonPass } from "./types.js";

/** SQL: the metadata flag is not the JSON boolean true. Total: a missing, null or non-boolean value counts as false. */
const NOT_TRUE = (key: string): string => `coalesce((metadata->'${key}') = 'true'::jsonb, false) = false`;

/**
 * Marks long-unfulfilled desires faded (metadata only; the node stays and can still be fulfilled).
 * Only nodes the mind itself wrote: the nodes update policy requires written_by to equal the bearer.
 */
export const desiresFade: DaemonPass = {
  name: "desires.fade",
  async run(ctx) {
    const now = ctx.now();
    const r = await ctx.tx.query<{ id: string }>(
      `select id from nodes
       where mind_id = $1 and node_type = $2 and invalidated_at is null and written_by = $1
         and ${NOT_TRUE("fulfilled")} and ${NOT_TRUE("faded")}
         and created_at < $3
       order by created_at, id`,
      [ctx.mind_id, DESIRE_NODE, ago(now, ctx.config.desireFadeDays, DAY_MS)],
    );
    let changed = 0;
    for (const { id } of r.rows) {
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`desire:${id}`]);
      // Re-read under the lock: a concurrent fulfill or invalidate must not get a fade event.
      const still = await ctx.tx.query(
        `select 1 from nodes
         where id = $1 and mind_id = $2 and invalidated_at is null and ${NOT_TRUE("fulfilled")} and ${NOT_TRUE("faded")}`,
        [id, ctx.mind_id],
      );
      if (still.rows.length === 0) continue;
      const ev = await appendEvent(ctx, {
        kind: "daemon.desire.fade",
        subject_id: id,
        payload: { desire_id: id, faded_at: now.toISOString() },
      });
      const u = await ctx.tx.query(
        `update nodes set metadata = metadata || $2::jsonb
         where id = $1 and mind_id = $3 and invalidated_at is null and ${NOT_TRUE("fulfilled")} and ${NOT_TRUE("faded")}`,
        [id, JSON.stringify({ faded: true, faded_at: now.toISOString(), fade_event_id: ev.id }), ctx.mind_id],
      );
      changed += u.rowCount ?? 0;
    }
    return { changed };
  },
};
