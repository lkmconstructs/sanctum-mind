import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { Pool } from "pg";
import { withMind } from "../db/pool.js";
import { appendEvent, deriveLabel, EMBED_DIM, vectorLiteral } from "../verbs/common.js";
import { normaliseInstant } from "../verbs/texture.js";
import type { Embedder, VerbContext } from "../verbs/types.js";
import { revienExportSchema, type RevienEdge, type RevienNode } from "./revien-schema.js";

export interface ImportReport {
  nodes: { imported: number; already_present: number; skipped_invalid: number };
  edges: { imported: number; already_present: number; skipped_missing_end: number; skipped_self_loop: number; skipped_invalid: number };
  type_counts: Record<string, number>;
  notes: string[];
}

export interface ImportDeps {
  pool: Pool;
  embedder: Embedder;
}

export interface ImportOpts {
  mind_id: string;
  file: string;
  source_filter?: string[];
  dry_run?: boolean;
}

/** Imported node types are stored as "revien:<original>" so they never collide with Sanctum's own types. */
export const IMPORT_TYPE_PREFIX = "revien:";
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const WRITE_BATCH = 200;
const EMBED_BATCH = 64;
const EMBED_TIMEOUT_MS = 60_000;
const LABEL_MAX = 200;
const LABEL_FALLBACK = 120;
const MAX_NOTES = 100;
const GRANULARITIES = new Set(["day", "week", "month", "year", "fuzzy"]);

/** Revien edge types that Sanctum knows; everything else becomes related_to with the original kept in metadata. */
export const EDGE_TYPE_MAP: Readonly<Record<string, string>> = {
  related_to: "related_to",
  contradicts: "contradicts",
  conflicts_with: "conflicts_with",
  corrects: "corrects",
  derived_from: "derived_from",
  references: "references",
  depends_on: "depends_on",
  followed_by: "followed_by",
  felt_toward: "felt_toward",
  involves: "involves",
};
const FALLBACK_EDGE_TYPE = "related_to";

function isWellFormed(s: string): boolean {
  return (s as string & { isWellFormed(): boolean }).isWellFormed();
}

/** True when a value holds a string Postgres jsonb/text cannot store (NUL or lone surrogate), anywhere in it. */
function unstorable(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000") || !isWellFormed(v);
  if (Array.isArray(v)) return v.some(unstorable);
  if (v !== null && typeof v === "object") {
    return Object.entries(v).some(([k, x]) => unstorable(k) || unstorable(x));
  }
  return false;
}

/**
 * Revien (Python) writes naive ISO datetimes, sometimes with a space separator or more than six
 * fractional digits. Treat naive as UTC, truncate extra fraction, then apply the texture.ts rules
 * (real instant, UTC year 0001..9999). Null when it cannot be read.
 */
function toInstant(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  let s = v.trim();
  if (s === "") return null;
  s = s.replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, "$1T");
  s = s.replace(/(\.\d{6})\d+/, "$1");
  if (/T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(s)) s += "Z";
  return normaliseInstant(s);
}

const clamp01 = (n: number | null | undefined, dflt: number): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;

interface PreparedNode {
  originalId: string;
  newId: string;
  original: RevienNode;
  node_type: string;
  label: string;
  content: string;
  source_type: string;
  confidence: number;
  pinned: boolean;
  invalidated_at: string | null;
  recorded_at: string | null;
  event_time_start: string | null;
  event_time_end: string | null;
  event_time_granularity: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
  embedText: string;
}

interface PreparedEdge {
  original: RevienEdge;
  edge_type: string;
  weight: number;
  confidence: number;
  created_at: string | null;
  metadata: Record<string, unknown>;
}

class Notes {
  readonly list: string[] = [];
  private dropped = 0;
  add(msg: string): void {
    if (this.list.length < MAX_NOTES) this.list.push(msg);
    else this.dropped++;
  }
  finish(): string[] {
    if (this.dropped > 0) this.list.push(`${this.dropped} further notes omitted`);
    return this.list;
  }
}

function prepareNode(n: RevienNode, notes: Notes, now: Date): PreparedNode | null {
  const who = `node ${n.node_id}`;
  if (unstorable(n)) {
    notes.add(`${who}: skipped, contains a NUL character or malformed Unicode`);
    return null;
  }
  const content = n.content;
  if (content.trim() === "") {
    notes.add(`${who}: skipped, blank content`);
    return null;
  }
  let created = toInstant(n.created_at);
  if (created === null) {
    notes.add(`${who}: skipped, created_at is not a valid instant (${JSON.stringify(n.created_at)})`);
    return null;
  }
  if (Date.parse(created) > now.getTime()) {
    notes.add(`${who}: created_at ${JSON.stringify(n.created_at)} is in the future, set to the import time`);
    created = now.toISOString();
  }
  let invalidated: string | null = null;
  if (n.invalidated_at !== null && n.invalidated_at !== undefined && n.invalidated_at.trim() !== "") {
    invalidated = toInstant(n.invalidated_at);
    if (invalidated === null) {
      // dropping it would silently bring an invalidated node back to life
      notes.add(`${who}: skipped, invalidated_at is not a valid instant (${JSON.stringify(n.invalidated_at)})`);
      return null;
    }
  }
  let recorded: string | null = null;
  if (n.recorded_at !== null && n.recorded_at !== undefined && n.recorded_at.trim() !== "") {
    recorded = toInstant(n.recorded_at);
    if (recorded === null) notes.add(`${who}: recorded_at dropped, not a valid instant (${JSON.stringify(n.recorded_at)})`);
  }
  let start = toInstant(n.event_time_start);
  let end = toInstant(n.event_time_end);
  if (n.event_time_start && start === null) notes.add(`${who}: event_time_start dropped, not a valid instant`);
  if (n.event_time_end && end === null) notes.add(`${who}: event_time_end dropped, not a valid instant`);
  if (start !== null && end !== null && end < start) {
    notes.add(`${who}: event time dropped, end is before start`);
    start = null;
    end = null;
  }
  let gran: string | null = null;
  if (n.event_time_granularity) {
    if (!GRANULARITIES.has(n.event_time_granularity)) {
      notes.add(`${who}: event_time_granularity dropped, "${n.event_time_granularity}" is not a known granularity`);
    } else if (start === null && end === null) {
      notes.add(`${who}: event_time_granularity dropped, there is no event time`);
    } else {
      gran = n.event_time_granularity;
    }
  }

  const label = deriveLabel(n.label, LABEL_MAX) || deriveLabel(content, LABEL_FALLBACK);
  const orig = n.metadata && typeof n.metadata === "object" && !Array.isArray(n.metadata) ? n.metadata : {};
  const metadata: Record<string, unknown> = {
    ...orig,
    revien_node_id: n.node_id,
    revien_node_type: n.node_type,
    revien: {
      source_id: n.source_id ?? null,
      confidence_set_by: n.confidence_set_by ?? null,
      source_context: n.source_context ?? null,
      modality: n.source_modality ?? null,
      answerable_by_text: n.answerable_by_text ?? null,
      vision_processed: n.vision_processed ?? null,
      event_time_confidence: n.event_time_confidence ?? null,
      event_time_text: n.event_time_text ?? null,
      last_accessed: n.last_accessed ?? null,
      access_count: n.access_count ?? null,
    },
  };
  return {
    originalId: n.node_id,
    newId: randomUUID(),
    original: n,
    node_type: IMPORT_TYPE_PREFIX + n.node_type,
    label,
    content,
    source_type: n.source_type ?? "inferred",
    confidence: clamp01(n.confidence, 0.5),
    pinned: n.pinned === true,
    invalidated_at: invalidated,
    recorded_at: recorded,
    event_time_start: start,
    event_time_end: end,
    event_time_granularity: gran,
    created_at: created,
    metadata,
    embedText: `${label} ${content}`,
  };
}

function prepareEdge(e: RevienEdge, notes: Notes): PreparedEdge | null {
  if (unstorable(e)) {
    notes.add(`edge ${e.edge_id}: skipped, contains a NUL character or malformed Unicode`);
    return null;
  }
  const mapped = EDGE_TYPE_MAP[e.edge_type] ?? FALLBACK_EDGE_TYPE;
  let created: string | null = null;
  if (e.created_at !== null && e.created_at !== undefined && e.created_at.trim() !== "") {
    created = toInstant(e.created_at);
    if (created === null) notes.add(`edge ${e.edge_id}: created_at dropped, not a valid instant`);
  }
  const orig = e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata) ? e.metadata : {};
  return {
    original: e,
    edge_type: mapped,
    weight: clamp01(e.weight, 0.5),
    confidence: clamp01(e.confidence, 0.5),
    created_at: created,
    metadata: {
      ...orig,
      revien_edge_id: e.edge_id,
      revien_edge_type: e.edge_type,
      revien: { confidence_set_by: e.confidence_set_by ?? null, source_context: e.source_context ?? null },
    },
  };
}

/** Embeds texts in the order given; a failed, late or malformed vector is null. Never throws. */
async function embedBatch(embedder: Embedder, texts: string[]): Promise<Array<{ vector: string; model: string } | null>> {
  const none = texts.map(() => null);
  if (embedder.name === "none" || texts.length === 0) return none;
  let timer: NodeJS.Timeout | undefined;
  try {
    const cap = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), EMBED_TIMEOUT_MS);
    });
    const out = await Promise.race([embedder.embed(texts), cap]);
    if (out === null) return none;
    return texts.map((_, i) => {
      const v = out[i];
      if (!v || v.length !== EMBED_DIM || v.length !== embedder.dim) return null;
      const lit = vectorLiteral(v);
      return lit === null ? null : { vector: lit, model: embedder.name };
    });
  } catch {
    return none;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

function issuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? "(file)" : path.map(String).join(".");
}

async function loadExport(file: string) {
  let raw: string;
  try {
    const size = (await stat(file)).size;
    if (size > MAX_IMPORT_BYTES) {
      throw new Error(`${size} bytes is over the ${MAX_IMPORT_BYTES / 1024 / 1024} MiB limit; split the export into smaller files`);
    }
    raw = await readFile(file, "utf8");
  } catch (e) {
    throw new Error(`cannot read Revien export ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = revienExportSchema.safeParse(json);
  if (!parsed.success) {
    const shown = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${issuePath(i.path)}: ${i.message}`)
      .join("; ");
    const more = parsed.error.issues.length > 5 ? ` (and ${parsed.error.issues.length - 5} more)` : "";
    throw new Error(`${file} is not a valid Revien export: ${shown}${more}`);
  }
  return parsed.data;
}

/**
 * Imports one Revien graph export into one mind. Idempotent on the original node and edge ids.
 * Nodes go first (events then rows, 200 per transaction, embeddings computed before each
 * transaction), then edges. dry_run validates, maps and counts without writing.
 */
export async function importRevien(deps: ImportDeps, opts: ImportOpts): Promise<ImportReport> {
  const { pool, embedder } = deps;
  const mind = opts.mind_id;
  const dry = opts.dry_run === true;
  const data = await loadExport(opts.file);
  const notes = new Notes();
  const report: ImportReport = {
    nodes: { imported: 0, already_present: 0, skipped_invalid: 0 },
    edges: { imported: 0, already_present: 0, skipped_missing_end: 0, skipped_self_loop: 0, skipped_invalid: 0 },
    type_counts: {},
    notes: [],
  };
  if (data.version !== undefined && data.version !== null && data.version !== "1.0") {
    notes.add(`export version is ${JSON.stringify(data.version)}, this adapter reads "1.0"`);
  }

  const ctxFor = (tx: VerbContext["tx"]): VerbContext =>
    ({ caller: { bearer: mind, grants: {} }, mind_id: mind, tx, now: () => new Date(), registry: [], embedder, sinks: [], coolingMs: 0 }) as VerbContext;

  // ---- nodes: filter, validate, map
  const filter = opts.source_filter && opts.source_filter.length > 0 ? new Set(opts.source_filter) : null;
  const seenNodeIds = new Set<string>();
  const prepared: PreparedNode[] = [];
  const importNow = new Date();
  for (const n of data.nodes) {
    if (filter && !(n.source_id !== null && n.source_id !== undefined && filter.has(n.source_id))) continue;
    if (seenNodeIds.has(n.node_id)) {
      report.nodes.skipped_invalid++;
      notes.add(`node ${n.node_id}: skipped, duplicate node_id in the file`);
      continue;
    }
    seenNodeIds.add(n.node_id);
    const p = prepareNode(n, notes, importNow);
    if (p === null) report.nodes.skipped_invalid++;
    else prepared.push(p);
  }

  const existingNodeIds = async (ids: string[]): Promise<Map<string, string>> =>
    withMind(pool, mind, mind, "read", async (tx) => {
      const r = await tx.query<{ id: string; rid: string }>(
        `select id, metadata->>'revien_node_id' as rid from nodes
          where mind_id = $1 and metadata->>'revien_node_id' = any($2::text[])`,
        [mind, ids],
      );
      return new Map(r.rows.map((x) => [x.rid, x.id]));
    });

  const wouldImport = new Set<string>(); // dry run only
  for (const batch of chunks(prepared, WRITE_BATCH)) {
    const present = await existingNodeIds(batch.map((p) => p.originalId));
    const fresh = batch.filter((p) => !present.has(p.originalId));
    report.nodes.already_present += batch.length - fresh.length;
    if (dry) {
      for (const p of fresh) {
        wouldImport.add(p.originalId);
        report.nodes.imported++;
        report.type_counts[p.node_type] = (report.type_counts[p.node_type] ?? 0) + 1;
      }
      continue;
    }
    if (fresh.length === 0) continue;
    const embedded = new Map<string, { vector: string; model: string } | null>();
    for (const c of chunks(fresh, EMBED_BATCH)) {
      const vecs = await embedBatch(embedder, c.map((p) => p.embedText));
      c.forEach((p, i) => embedded.set(p.originalId, vecs[i] ?? null));
    }
    const done = await withMind(pool, mind, mind, "write", async (tx) => {
      // serialise concurrent imports into one mind, then re-check what is present
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`import-revien:${mind}`]);
      const r = await tx.query<{ rid: string }>(
        `select metadata->>'revien_node_id' as rid from nodes
          where mind_id = $1 and metadata->>'revien_node_id' = any($2::text[])`,
        [mind, fresh.map((p) => p.originalId)],
      );
      const nowPresent = new Set(r.rows.map((x) => x.rid));
      const ctx = ctxFor(tx);
      const imported: PreparedNode[] = [];
      for (const p of fresh) {
        if (nowPresent.has(p.originalId)) continue;
        await appendEvent(ctx, { kind: "import.revien.node", subject_id: p.newId, payload: p.original });
        const emb = embedded.get(p.originalId) ?? null;
        await tx.query(
          `insert into nodes (id, mind_id, node_type, label, content, written_by, source_type, confidence, pinned,
                              invalidated_at, metadata, recorded_at, event_time_start, event_time_end,
                              event_time_granularity, created_at, embedding, embedding_model)
           values ($1, $2, $3, $4, $5, $2, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16::vector, $17)`,
          [
            p.newId, mind, p.node_type, p.label, p.content, p.source_type, p.confidence, p.pinned,
            p.invalidated_at, JSON.stringify(p.metadata), p.recorded_at, p.event_time_start, p.event_time_end,
            p.event_time_granularity, p.created_at, emb?.vector ?? null, emb?.model ?? null,
          ],
        );
        imported.push(p);
      }
      return { imported, raced: fresh.length - imported.length };
    });
    report.nodes.already_present += done.raced;
    for (const p of done.imported) {
      report.nodes.imported++;
      report.type_counts[p.node_type] = (report.type_counts[p.node_type] ?? 0) + 1;
    }
  }

  // ---- edges
  // Endpoints resolve against nodes already in the mind (an earlier run, another --source) as well as this run's.
  const idMap = new Map<string, string>(); // original node id -> id in the mind (or a placeholder in a dry run)
  const endpoints = new Set<string>();
  for (const e of data.edges) {
    endpoints.add(e.source_node_id);
    endpoints.add(e.target_node_id);
  }
  for (const c of chunks([...endpoints], 1000)) {
    for (const [k, v] of await existingNodeIds(c)) idMap.set(k, v);
  }
  for (const k of wouldImport) idMap.set(k, `dry:${k}`);

  const seenEdgeIds = new Set<string>();
  const edgeCandidates: Array<{ e: PreparedEdge; source: string; target: string }> = [];
  for (const raw of data.edges) {
    const source = idMap.get(raw.source_node_id);
    const target = idMap.get(raw.target_node_id);
    if (source === undefined || target === undefined) {
      report.edges.skipped_missing_end++;
      continue;
    }
    if (source === target) {
      report.edges.skipped_self_loop++;
      continue;
    }
    if (seenEdgeIds.has(raw.edge_id)) {
      report.edges.already_present++;
      notes.add(`edge ${raw.edge_id}: duplicate edge_id in the file, counted as already present`);
      continue;
    }
    seenEdgeIds.add(raw.edge_id);
    const e = prepareEdge(raw, notes);
    if (e === null) {
      report.edges.skipped_invalid++;
      continue;
    }
    edgeCandidates.push({ e, source, target });
  }

  const existingEdgeIds = async (ids: string[]): Promise<Set<string>> =>
    withMind(pool, mind, mind, "read", async (tx) => {
      const r = await tx.query<{ rid: string }>(
        `select metadata->>'revien_edge_id' as rid from edges
          where mind_id = $1 and metadata->>'revien_edge_id' = any($2::text[])`,
        [mind, ids],
      );
      return new Set(r.rows.map((x) => x.rid));
    });

  for (const batch of chunks(edgeCandidates, WRITE_BATCH)) {
    const present = await existingEdgeIds(batch.map((b) => b.e.original.edge_id));
    const fresh = batch.filter((b) => !present.has(b.e.original.edge_id));
    report.edges.already_present += batch.length - fresh.length;
    if (dry) {
      report.edges.imported += fresh.length;
      continue;
    }
    if (fresh.length === 0) continue;
    const done = await withMind(pool, mind, mind, "write", async (tx) => {
      await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`import-revien:${mind}`]);
      const nowPresent = await tx
        .query<{ rid: string }>(
          `select metadata->>'revien_edge_id' as rid from edges
            where mind_id = $1 and metadata->>'revien_edge_id' = any($2::text[])`,
          [mind, fresh.map((b) => b.e.original.edge_id)],
        )
        .then((r) => new Set(r.rows.map((x) => x.rid)));
      const ids: string[] = [];
      for (const b of fresh) {
        if (nowPresent.has(b.e.original.edge_id)) continue;
        await tx.query(
          `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata, created_at)
           values ($1, $2, $1, $3, $4, $5, $6, $7::jsonb, coalesce($8::timestamptz, now()))`,
          [mind, b.e.edge_type, b.source, b.target, b.e.weight, b.e.confidence, JSON.stringify(b.e.metadata), b.e.created_at],
        );
        ids.push(b.e.original.edge_id);
      }
      if (ids.length > 0) {
        await appendEvent(ctxFor(tx), { kind: "import.revien.edges", payload: { count: ids.length, edge_ids: ids } });
      }
      return { ids, raced: fresh.length - ids.length };
    });
    report.edges.already_present += done.raced;
    report.edges.imported += done.ids.length;
  }

  report.notes = notes.finish();
  return report;
}
