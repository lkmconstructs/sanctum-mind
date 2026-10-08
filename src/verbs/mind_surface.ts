import { z } from "zod";
import { ok } from "../result.js";
import { defineVerb } from "./types.js";
import { mindIdSchema, nonBlankText, text } from "./common.js";
import { chargeWeight, fuseTable, LIST_DEPTH, plan, snippet, type Candidate } from "./retrieval.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  query: nonBlankText(2000),
  pool_sizes: z
    .strictObject({
      core: z.number().int().min(1).max(20).default(3),
      novel: z.number().int().min(0).max(20).default(2),
      edge: z.number().int().min(0).max(20).default(2),
    })
    .optional(),
  context: text(64).optional(),
});

interface EdgeRow {
  id: string;
  node_type: string;
  label: string;
  content: string;
  score: number;
  hops: number;
  via: string;
}

/**
 * Nodes within two hops of the seeds over edges in either direction, never through or onto an
 * invalidated node. Hop one is capped at 500 rows (heaviest first) and the whole walk at 500.
 * Per node the best path wins: fewer hops, then larger summed weight; the pool is ranked the same way (hops asc, score desc),
 * so a node one hop from a seed is always labelled hops 1 even when a heavier two-hop route reaches it. `via` is the node the
 * path arrived from (a seed at one hop, the intermediate node at two).
 */
const EDGE_SQL = `
with recursive walk(node_id, hops, score, via, path) as (
  (select o.other, 1, e.weight, s.id, array[s.id, o.other]
     from unnest($1::uuid[]) as s(id)
     join edges e on e.source_node_id = s.id or e.target_node_id = s.id
    cross join lateral (select case when e.source_node_id = s.id then e.target_node_id else e.source_node_id end as other) o
     join nodes n on n.id = o.other and n.invalidated_at is null
    order by e.weight desc, e.id
    limit 500)
  union all
  select o.other, 2, w.score + e.weight, w.node_id, w.path || o.other
    from walk w
    join edges e on e.source_node_id = w.node_id or e.target_node_id = w.node_id
   cross join lateral (select case when e.source_node_id = w.node_id then e.target_node_id else e.source_node_id end as other) o
    join nodes n on n.id = o.other and n.invalidated_at is null
   where w.hops = 1 and not (o.other = any(w.path))
),
bounded as (select * from walk order by hops, score desc limit 500),
best as (
  select distinct on (node_id) node_id, hops, score, via
    from bounded
   where node_id <> all($2::uuid[])
   order by node_id, hops, score desc
)
select n.id, n.node_type, n.label, left(n.content, 1000) as content, b.score, b.hops, b.via
  from best b join nodes n on n.id = b.node_id
 order by b.hops, b.score desc, n.id
 limit $3`;

const hit = (c: Candidate, pool: "core" | "novel") => ({
  id: c.id,
  node_type: c.node_type,
  label: c.label,
  snippet: snippet(c.body),
  score: c.score,
  pool,
});

export const mind_surface = defineVerb({
  name: "mind_surface",
  description:
    "Surface curated nodes for a query in three pools: core (best hybrid matches), novel (related but less " +
    "obvious, favouring charged, gripping, vivid nodes) and edge (graph neighbours up to two hops from the core). " +
    "Invalidated nodes never appear. Writes nothing.",
  schema,
  scopeFor: () => "read",
  embedText: (input) => input.query,
  handler: async (ctx, input) => {
    const sizes = { core: 3, novel: 2, edge: 2, ...input.pool_sizes };
    const vec = ctx.embedded?.vector ?? null;
    const p = plan("hybrid", vec);
    const ranked = await fuseTable(
      ctx.tx, "nodes", input.query, p.useVec ? vec : null, true,
      { context: input.context },
    );
    const ranked50 = ranked.slice(0, LIST_DEPTH);
    const core = ranked50.slice(0, sizes.core);
    const novel = ranked50
      .slice(2 * sizes.core)
      .map((c) => ({ c, w: chargeWeight(c.texture) }))
      .sort((a, b) => b.w - a.w || b.c.created_at.getTime() - a.c.created_at.getTime() || (a.c.id < b.c.id ? -1 : 1))
      .slice(0, sizes.novel)
      .map((x) => x.c);

    let edge: ReturnType<typeof mapEdge>[] = [];
    if (sizes.edge > 0 && core.length > 0) {
      const r = await ctx.tx.query<EdgeRow>(EDGE_SQL, [
        core.map((c) => c.id),
        [...core, ...novel].map((c) => c.id),
        sizes.edge,
      ]);
      edge = r.rows.map(mapEdge);
    }
    return ok({
      projection: {
        query: input.query,
        core: core.map((c) => hit(c, "core")),
        novel: novel.map((c) => hit(c, "novel")),
        edge,
        mode_used: p.mode_used,
      },
      ...(p.warnings.length > 0 ? { warnings: p.warnings } : {}),
    });
  },
});

function mapEdge(r: EdgeRow) {
  return {
    id: r.id,
    node_type: r.node_type,
    label: r.label,
    snippet: snippet(r.content),
    score: Number(r.score),
    pool: "edge" as const,
    hops: Number(r.hops),
    via: r.via,
  };
}
