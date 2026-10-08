import type { Pool } from "pg";
import { withMind } from "../db/pool.js";
import { EMBED_DIM, vectorLiteral } from "../verbs/common.js";
import type { Embedder } from "../verbs/types.js";

export interface BackfillCounts {
  events: number;
  nodes: number;
  skipped: number;
}

type Table = "events" | "nodes";

/** The embeddable text of a row, matching what the write path embeds. */
const TEXT_EXPR: Record<Table, string> = {
  events: "coalesce(nullif(btrim(payload->>'text'), ''), nullif(btrim(payload->>'content'), ''))",
  nodes: "nullif(btrim(content), '')",
};

/**
 * Fills null embeddings of enabled minds, per mind and per original author (so RLS and written_by are respected, and every query names `mind_id` explicitly because an admin (superuser) URL bypasses RLS:
 * the bearer for each batch is the row's written_by), in keyset-paged batches. Idempotent: only
 * rows with a null embedding are touched. With the none embedder (or failures) rows stay null and
 * are counted as skipped.
 */
export async function backfillEmbeddings(pool: Pool, embedder: Embedder, batch = 64): Promise<BackfillCounts> {
  const counts: BackfillCounts = { events: 0, nodes: 0, skipped: 0 };
  if (embedder.name === "none") return counts;
  const minds = (
    await pool.query<{ mind_id: string }>("select mind_id from minds where disabled_at is null order by mind_id")
  ).rows;
  for (const { mind_id } of minds) {
    for (const table of ["events", "nodes"] as const) {
      const authors = await withMind(pool, mind_id, mind_id, "read", async (tx) =>
        (
          await tx.query<{ written_by: string }>(
            `select distinct written_by from ${table}
              where mind_id = $1 and embedding is null and ${TEXT_EXPR[table]} is not null order by written_by`,
            [mind_id],
          )
        ).rows.map((r) => r.written_by),
      );
      for (const author of authors) {
        let last: string | null = null;
        for (;;) {
          const done: { n: number; seen: number; last: string | null } = await withMind(
            pool, mind_id, author, "write", async (tx) => {
              const rows = (
                await tx.query<{ id: string; t: string }>(
                  `select id, ${TEXT_EXPR[table]} as t from ${table}
                    where mind_id = $4 and embedding is null and written_by = $1 and ${TEXT_EXPR[table]} is not null
                      and ($2::text is null or id::text > $2)
                    order by id::text limit $3`,
                  [author, last, batch, mind_id],
                )
              ).rows;
              if (rows.length === 0) return { n: 0, seen: 0, last: null };
              const vecs = await embedder.embed(rows.map((r) => r.t));
              let n = 0;
              for (let i = 0; i < rows.length; i++) {
                const v = vecs[i];
                const lit = v && v.length === embedder.dim && v.length === EMBED_DIM ? vectorLiteral(v) : null;
                if (lit === null) continue;
                const u = await tx.query(
                  `update ${table} set embedding = $2::vector, embedding_model = $3
                    where id = $1 and mind_id = $4 and embedding is null`,
                  [rows[i]!.id, lit, embedder.name, mind_id],
                );
                n += u.rowCount ?? 0;
              }
              return { n, seen: rows.length, last: rows[rows.length - 1]!.id };
            },
          );
          if (done.seen === 0) break;
          counts[table] += done.n;
          counts.skipped += done.seen - done.n;
          last = done.last;
          if (done.seen < batch) break;
        }
      }
    }
  }
  return counts;
}
