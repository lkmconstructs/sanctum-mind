import { EMBED_DIM, vectorLiteral } from "../../verbs/common.js";
import type { DaemonPass } from "./types.js";

const BATCH = 64;

/** The embeddable text of a row, matching src/embed/backfill.ts and the write path. */
const TEXT_EXPR = {
  events: "coalesce(nullif(btrim(payload->>'text'), ''), nullif(btrim(payload->>'content'), ''))",
  nodes: "nullif(btrim(content), '')",
} as const;

/**
 * Fills null embeddings for this mind, bounded per run. Only rows the mind itself wrote: the update
 * policies require written_by to equal the bearer, which in a daemon pass is the mind. Rows authored by
 * a grantee stay for the whole-database `backfill` command. Does nothing with the `none` embedder.
 */
export const embeddingsBackfill: DaemonPass = {
  name: "embeddings.backfill",
  async run(ctx) {
    if (ctx.embedder.name === "none") return { changed: 0, notes: ["embedder is none"] };
    let budget = ctx.config.backfillRows;
    let changed = 0;
    for (const table of ["events", "nodes"] as const) {
      let last: string | null = null;
      while (budget > 0) {
        const take = Math.min(BATCH, budget);
        const rows: Array<{ id: string; t: string }> = (
          await ctx.tx.query<{ id: string; t: string }>(
            `select id, ${TEXT_EXPR[table]} as t from ${table}
             where mind_id = $1 and written_by = $1 and embedding is null and ${TEXT_EXPR[table]} is not null
               and ($2::text is null or id::text > $2)
             order by id::text limit $3`,
            [ctx.mind_id, last, take],
          )
        ).rows;
        if (rows.length === 0) break;
        last = rows[rows.length - 1]!.id;
        const vecs = await ctx.embedder.embed(rows.map((x) => x.t));
        for (let i = 0; i < rows.length; i++) {
          const v = vecs[i];
          const lit = v && v.length === ctx.embedder.dim && v.length === EMBED_DIM ? vectorLiteral(v) : null;
          if (lit === null) continue;
          const u = await ctx.tx.query(
            `update ${table} set embedding = $2::vector, embedding_model = $3
             where id = $1 and mind_id = $4 and embedding is null`,
            [rows[i]!.id, lit, ctx.embedder.name, ctx.mind_id],
          );
          changed += u.rowCount ?? 0;
        }
        budget -= rows.length;
        if (rows.length < take) break;
      }
    }
    return { changed };
  },
};
