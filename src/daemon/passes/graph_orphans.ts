// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { appendEvent } from "../../verbs/common.js";
import { OBSERVATION_NODE } from "../../verbs/texture.js";
import { DAY_MS, ago, type DaemonPass } from "./types.js";

/**
 * Reports observation nodes (node_type exactly 'observation'). Imported Revien nodes are typed
 * "revien:<original>", so a bulk import never floods this report. Reports with no edges in either direction, once per node per window. Informational only. */
export const graphOrphans: DaemonPass = {
  name: "graph.orphans",
  async run(ctx) {
    const now = ctx.now();
    const r = await ctx.tx.query<{ id: string; label: string }>(
      `select n.id, n.label from nodes n
       where n.mind_id = $1 and n.node_type = $2 and n.invalidated_at is null and n.created_at < $3
         and not exists (select 1 from edges e where e.mind_id = $1 and e.source_node_id = n.id)
         and not exists (select 1 from edges e where e.mind_id = $1 and e.target_node_id = n.id)
         and not exists (
           select 1 from events v
           where v.mind_id = $1 and v.kind = 'daemon.graph.orphan' and v.subject_id = n.id and v.recorded_at > $4)
       order by n.created_at, n.id limit $5`,
      [
        ctx.mind_id,
        OBSERVATION_NODE,
        ago(now, ctx.config.orphanAgeDays, DAY_MS),
        ago(now, ctx.config.orphanRenotifyDays, DAY_MS),
        ctx.config.orphanBatch,
      ],
    );
    for (const n of r.rows) {
      await appendEvent(ctx, { kind: "daemon.graph.orphan", subject_id: n.id, payload: { node_id: n.id, label: n.label } });
    }
    return { changed: r.rows.length };
  },
};
