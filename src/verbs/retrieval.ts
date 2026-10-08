import type { PoolClient } from "pg";
import { normaliseInstant } from "./texture.js";

/** Reciprocal rank fusion constant and per-list depth, from CONTRACTS.md. */
export const RRF_K = 60;
export const LIST_DEPTH = 50;
export const NO_EMBEDDER_WARNING = "no embedder: semantic search unavailable";

export type SearchMode = "hybrid" | "text" | "semantic";

export interface Filters {
  kind?: string | undefined;
  node_type?: string | undefined;
  context?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
}

/** One fused hit before it is shaped for a verb. */
export interface Candidate {
  source: "event" | "node";
  id: string;
  score: number;
  text_rank?: number;
  distance?: number;
  kind?: string;
  node_type?: string;
  label?: string | null;
  body: string;
  created_at: Date;
  context: string | null;
  texture: unknown;
}

interface RawRow {
  id: string;
  kind?: string;
  node_type?: string;
  label: string | null;
  body: string;
  created_at: Date;
  context: string | null;
  texture: unknown;
  text_rank?: number | string;
  distance?: number | string;
}

export { vectorLiteral } from "./common.js";

/** First 240 code points, whitespace collapsed. */
export function snippet(s: string | null | undefined, max = 240): string {
  return Array.from((s ?? "").replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

type Table = "events" | "nodes";

const COLS: Record<Table, string> = {
  events:
    `id, kind, payload->>'label' as label, left(coalesce(payload->>'text', payload->>'content', ''), 1000) as body,
     created_at, context, texture`,
  nodes:
    `id, node_type, label, left(content, 1000) as body, created_at, metadata->>'context' as context,
     metadata->'texture' as texture`,
};

/** Appends parameter-bound filter clauses; returns SQL starting with " and " (or empty). */
function filterSql(table: Table, f: Filters, params: unknown[]): string {
  const out: string[] = [];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  if (table === "events") {
    if (f.kind !== undefined) out.push(`kind = ${bind(f.kind)}`);
    if (f.context !== undefined) out.push(`context = ${bind(f.context)}`);
  } else {
    out.push("invalidated_at is null");
    if (f.node_type !== undefined) out.push(`node_type = ${bind(f.node_type)}`);
    if (f.context !== undefined) out.push(`metadata->>'context' = ${bind(f.context)}`);
  }
  const when = table === "events" ? "recorded_at" : "coalesce(recorded_at, created_at)";
  if (f.after !== undefined) out.push(`${when} >= ${bind(normaliseInstant(f.after))}::timestamptz`);
  if (f.before !== undefined) out.push(`${when} < ${bind(normaliseInstant(f.before))}::timestamptz`);
  return out.length === 0 ? "" : ` and ${out.join(" and ")}`;
}

/** Ranked full-text list for one table. */
export function textListQuery(table: Table, query: string, f: Filters): { sql: string; params: unknown[] } {
  const params: unknown[] = [query];
  const where = filterSql(table, f, params);
  const tie = table === "events" ? "seq desc" : "created_at desc, id";
  return {
    sql: `select ${COLS[table]}, ts_rank_cd(search, q.query) as text_rank
            from ${table}, websearch_to_tsquery('simple', $1) as q(query)
           where search @@ q.query${where}
           order by text_rank desc, ${tie}
           limit ${LIST_DEPTH}`,
    params,
  };
}

/** Nearest-neighbour list for one table (cosine distance). */
export function semanticListQuery(table: Table, vec: string, f: Filters): { sql: string; params: unknown[] } {
  const params: unknown[] = [vec];
  const where = filterSql(table, f, params);
  const tie = table === "events" ? "seq desc" : "created_at desc, id";
  return {
    sql: `select ${COLS[table]}, embedding <=> $1::vector as distance
            from ${table}
           where embedding is not null${where}
           order by embedding <=> $1::vector, ${tie}
           limit ${LIST_DEPTH}`,
    params,
  };
}

/** Reciprocal rank fusion over ranked id lists: sum of 1 / (k + rank), rank starting at 1. */
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return score;
}

/** Run the lists for one table and fuse them. Result is sorted by fused score desc. */
export async function fuseTable(
  tx: PoolClient,
  table: Table,
  query: string,
  vec: string | null,
  runText: boolean,
  f: Filters,
): Promise<Candidate[]> {
  const source = table === "events" ? "event" : "node";
  const rows = new Map<string, RawRow>();
  const lists: string[][] = [];
  if (runText) {
    const q = textListQuery(table, query, f);
    const r = await tx.query<RawRow>(q.sql, q.params);
    lists.push(r.rows.map((x) => x.id));
    for (const x of r.rows) rows.set(x.id, { ...x });
  }
  if (vec !== null) {
    const q = semanticListQuery(table, vec, f);
    const r = await tx.query<RawRow>(q.sql, q.params);
    lists.push(r.rows.map((x) => x.id));
    for (const x of r.rows) rows.set(x.id, { ...rows.get(x.id), ...x });
  }
  const score = rrf(lists);
  const out: Candidate[] = [];
  for (const [id, s] of score) {
    const x = rows.get(id)!;
    const c: Candidate = {
      source,
      id,
      score: s,
      body: x.body,
      label: x.label,
      created_at: x.created_at,
      context: x.context,
      texture: x.texture,
    };
    if (x.kind !== undefined) c.kind = x.kind;
    if (x.node_type !== undefined) c.node_type = x.node_type;
    if (x.text_rank !== undefined) c.text_rank = Number(x.text_rank);
    if (x.distance !== undefined) c.distance = Number(x.distance);
    out.push(c);
  }
  out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return out;
}

/** Choose which lists run. `vec` null means no vector is available. */
export function plan(mode: SearchMode, vec: string | null): { runText: boolean; useVec: boolean; mode_used: SearchMode; warnings: string[] } {
  const warnings: string[] = [];
  if (mode !== "text" && vec === null) warnings.push(NO_EMBEDDER_WARNING);
  const useVec = mode !== "text" && vec !== null;
  if (mode === "semantic") return { runText: false, useVec, mode_used: "semantic", warnings };
  return { runText: true, useVec, mode_used: useVec ? "hybrid" : "text", warnings };
}

/** charge_weight for the surface novel pool, from metadata.texture. */
export function chargeWeight(texture: unknown): number {
  if (texture === null || typeof texture !== "object") return 0;
  const t = texture as { charge?: unknown; grip?: unknown; vividness?: unknown };
  let w = Array.isArray(t.charge) ? t.charge.length : 0;
  if (t.grip === "iron" || t.grip === "strong") w += 2;
  if (t.vividness === "crystalline" || t.vividness === "vivid") w += 1;
  return w;
}
