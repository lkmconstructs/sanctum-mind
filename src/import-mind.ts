// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Pool, PoolClient } from "pg";
import { isValidMindId, mindIdProblem } from "./auth.js";
import { ArgError } from "./cli-args.js";
import { withMind } from "./db/pool.js";
import { EXPORT_FORMAT } from "./export.js";

/**
 * Import reads the whole export into memory (JSON.parse) and refuses files over this size with a
 * clear error. Export streams; import does not. A mind larger than this is moved in pieces or with
 * pg_dump. Numbers inside jsonb values go through a JS double, so a literal such as 100.000 or an
 * integer beyond 2^53 inside a payload is normalised on the way in.
 */
export const MAX_IMPORT_MIND_BYTES = 512 * 1024 * 1024;
const BATCH = 1000;
const OMIT = ["embedding", "search"];

export class ImportError extends Error {}

export const IMPORT_MIND_USAGE = "usage: sanctum-mind import-mind <file> --mind <target> [--dry-run] [--allow-core] [--strict] [--with-letters]";

export interface ImportMindArgs {
  file: string;
  mind: string;
  dryRun: boolean;
  /** import identity and vow nodes even when the target already has any (live or retired) */
  allowCore: boolean;
  /** abort the whole import (before writing anything) if any row is refused for a reference outside the file */
  strict: boolean;
  /** also import the letters this mind sent to other minds (default: they are reported as ignored) */
  withLetters: boolean;
}

export function parseImportMindArgs(argv: string[]): ImportMindArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { mind: { type: "string" }, "dry-run": { type: "boolean" }, "allow-core": { type: "boolean" }, strict: { type: "boolean" }, "with-letters": { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${IMPORT_MIND_USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length === 0) throw new ArgError(`import-mind needs a file path\n${IMPORT_MIND_USAGE}`);
  if (positionals.length > 1) {
    throw new ArgError(`import-mind takes exactly one file, got ${positionals.length}: ${positionals.join(" ")}\n${IMPORT_MIND_USAGE}`);
  }
  if (values.mind === undefined || values.mind === "") throw new ArgError(`--mind <target> is required\n${IMPORT_MIND_USAGE}`);
  if (!isValidMindId(values.mind)) throw new ArgError(mindIdProblem(values.mind));
  return {
    file: positionals[0]!,
    mind: values.mind,
    dryRun: values["dry-run"] === true,
    allowCore: values["allow-core"] === true,
    strict: values.strict === true,
    withLetters: values["with-letters"] === true,
  };
}

type Row = Record<string, unknown>;

export interface TableReport {
  inserted: number;
  already_present: number;
  /** letters only: a party is not a mind in this database */
  skipped_missing_party?: number;
  /** letters only: the event that sent the letter is not present */
  skipped_missing_event?: number;
  /** letters only: the sending event is not a letter.send event addressed to the letter's recipient */
  skipped_event_mismatch?: number;
  /** rows refused because a referenced id (event, node, ...) is not in this file's own rows */
  skipped_foreign_ref?: number;
  /** letters_received, and letters_sent without --with-letters: rows present in the file and deliberately not imported */
  ignored?: number;
}

export interface ImportMindReport {
  source_mind: string;
  target_mind: string;
  dry_run: boolean;
  tables: Record<string, TableReport>;
  notes: string[];
}

interface Doc {
  mind_id: string;
  events: Row[];
  nodes: Row[];
  edges: Row[];
  projections: Record<string, Row[]>;
}

const PROJECTION_ORDER = [
  "brain_state", "drive_state", "kv_contexts", "handoffs", "holdings", "loops", "threads", "tasks", "relations", "proposals",
] as const;
const PROJECTION_TABLE: Record<string, string> = Object.fromEntries(PROJECTION_ORDER.map((k) => [k, k]));

function asRows(v: unknown, what: string): Row[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ImportError(`export file: ${what} must be an array`);
  for (const r of v) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new ImportError(`export file: ${what} holds a row that is not an object`);
  }
  return v as Row[];
}

function parseDoc(text: string): Doc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ImportError(`export file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ImportError("export file: top level must be an object");
  const o = raw as Record<string, unknown>;
  if (o.format !== EXPORT_FORMAT) throw new ImportError(`export file: unsupported format ${JSON.stringify(o.format)} (expected "${EXPORT_FORMAT}")`);
  if (typeof o.mind_id !== "string" || !isValidMindId(o.mind_id)) throw new ImportError("export file: mind_id is missing or invalid");
  const p = o.projections ?? {};
  if (p === null || typeof p !== "object" || Array.isArray(p)) throw new ImportError("export file: projections must be an object");
  const projections: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) projections[k] = asRows(v, `projections.${k}`);
  return {
    mind_id: o.mind_id,
    events: asRows(o.events, "events"),
    nodes: asRows(o.nodes, "nodes"),
    edges: asRows(o.edges, "edges"),
    projections,
  };
}

class DryRunRollback extends Error {}

const lc = (v: unknown): string => String(v).toLowerCase();

async function insertableColumns(tx: PoolClient, table: string): Promise<string[]> {
  const r = await tx.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER'
        and identity_generation is distinct from 'ALWAYS' order by ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name).filter((c) => !OMIT.includes(c));
}

const chunk = <T>(a: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
};

interface InsertOpts {
  /** every row carries a string id: report skipped ids that belong to another mind */
  byId: boolean;
  /** look rows up by id first and insert only the new ones (events: a conflicting insert would still burn a seq value) */
  skipExisting?: boolean;
  /** events in a dry run: take seq from this counter, counting down from -1, so the real sequence is never touched */
  dryEvents?: { next: number };
}

/** Consecutive rows that carry the same set of importable columns. */
function runsBySignature(batch: Row[], cols: string[]): { use: string[]; rows: Row[] }[] {
  const runs: { sig: string; use: string[]; rows: Row[] }[] = [];
  for (const r of batch) {
    const use = cols.filter((c) => c in r);
    const sig = use.join(",");
    const last = runs[runs.length - 1];
    if (last && last.sig === sig) last.rows.push(r);
    else runs.push({ sig, use, rows: [r] });
  }
  return runs;
}

/**
 * Inserts rows through jsonb_populate_recordset, so every column type (arrays, jsonb, timestamps)
 * round-trips without per-column code. jsonb_populate_recordset yields NULL, not the column default,
 * for a key a row lacks; so rows are inserted in consecutive runs that share one key set and each run
 * names only the columns its rows carry. A key that is absent therefore takes the database default,
 * and a key that is present with JSON null stays null. Order is preserved (events are appended in
 * file order). Existing rows are skipped (on conflict do nothing). For tables keyed by id, a skipped
 * id that this mind cannot see belongs to another mind and is refused rather than silently dropped.
 */
async function insertRows(tx: PoolClient, table: string, rows: Row[], cols: string[], o: InsertOpts): Promise<TableReport> {
  let work = rows;
  if (o.skipExisting && rows.length > 0) {
    const present = new Set<string>();
    for (const part of chunk(rows.map((r) => lc(r.id)), BATCH)) {
      const r = await tx.query<{ id: string }>(`select id from ${table} where id = any($1::uuid[])`, [part]);
      for (const x of r.rows) present.add(x.id);
    }
    work = rows.filter((r) => !present.has(lc(r.id)));
  }
  let inserted = 0;
  for (const batch of chunk(work, BATCH)) {
    for (const run of runsBySignature(batch, cols)) {
      if (run.use.length === 0) throw new ImportError(`export file: ${table} rows have no importable columns`);
      const list = run.use.map((c) => `"${c}"`).join(", ");
      let sql: string;
      const params: unknown[] = [JSON.stringify(run.rows)];
      if (o.dryEvents) {
        params.push(o.dryEvents.next);
        o.dryEvents.next -= run.rows.length;
        sql = `insert into ${table} (${list}, seq) overriding system value
               select ${list}, ($2::bigint - (row_number() over ()) + 1)::bigint from jsonb_populate_recordset(null::${table}, $1::jsonb)
               on conflict do nothing${o.byId ? " returning id" : ""}`;
      } else {
        sql = `insert into ${table} (${list}) select ${list} from jsonb_populate_recordset(null::${table}, $1::jsonb)
               on conflict do nothing${o.byId ? " returning id" : ""}`;
      }
      const res = await tx.query<{ id?: string }>(sql, params);
      inserted += res.rowCount ?? 0;
      if (o.byId && (res.rowCount ?? 0) < run.rows.length) {
        const got = new Set(res.rows.map((x) => lc(x.id)));
        const skipped = run.rows.map((r) => lc(r.id)).filter((id) => !got.has(id));
        const visible = await tx.query<{ id: string }>(`select id from ${table} where id = any($1::uuid[])`, [skipped]);
        const seen = new Set(visible.rows.map((x) => lc(x.id)));
        const clash = skipped.find((id) => !seen.has(id));
        if (clash !== undefined) throw new ImportError(`${table} id ${clash} already exists in another mind; nothing was imported`);
      }
    }
  }
  return { inserted, already_present: rows.length - inserted };
}

async function existingMinds(tx: PoolClient, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await tx.query<{ mind_id: string }>("select mind_id from minds where mind_id = any($1::text[])", [ids]);
  return new Set(r.rows.map((x) => x.mind_id));
}

async function visibleNodeIds(tx: PoolClient, rows: Row[]): Promise<Set<string>> {
  const seen = new Set<string>();
  for (const part of chunk(rows.map((r) => lc(r.id)), BATCH)) {
    const r = await tx.query<{ id: string }>("select id from nodes where id = any($1::uuid[])", [part]);
    for (const x of r.rows) seen.add(x.id);
  }
  return seen;
}

/** Column names that never hold a reference to another row: authorship labels, text session labels, the row's own id. */
const NOT_A_REF = new Set(["id", "mind_id", "session_id"]);
const isRefColumn = (c: string): boolean => !NOT_A_REF.has(c) && (c.endsWith("_id") || c === "superseded_by");

/** Tables whose rows are checked for references (events carry no foreign key and are the ledger itself). */
const CHECKED: { key: string; rows: (d: Doc) => Row[]; set: (d: Doc, rows: Row[]) => void }[] = [
  { key: "nodes", rows: (d) => d.nodes, set: (d, r) => void (d.nodes = r) },
  { key: "edges", rows: (d) => d.edges, set: (d, r) => void (d.edges = r) },
  ...PROJECTION_ORDER.map((k) => ({
    key: k,
    rows: (d: Doc) => d.projections[k] ?? [],
    set: (d: Doc, r: Row[]) => void (d.projections[k] = r),
  })),
];

/**
 * Removes every row that references an id which is not a row of this same file. Applies to every
 * column ending in `_id` (except id, mind_id and session_id), `superseded_by` and holdings.subject_id:
 * `*event_id` columns must be an event of the file, node references a node of the file, holdings.subject_id
 * the event or node named by its subject_kind, anything else a row of any id-keyed table of the file.
 * A refused row can orphan others (an edge to a refused node), so this repeats until nothing changes.
 * Returns refused counts per table key.
 */
function dropForeignRefs(doc: Doc): Record<string, number> {
  const refused: Record<string, number> = {};
  const ids = (rows: Row[]): Set<string> => new Set(rows.filter((r) => typeof r.id === "string").map((r) => lc(r.id)));
  for (;;) {
    const events = ids(doc.events);
    const nodes = ids(doc.nodes);
    const any = new Set<string>([
      ...events,
      ...nodes,
      ...ids(doc.edges),
      ...["proposals", "loops", "threads", "tasks"].flatMap((k) => [...ids(doc.projections[k] ?? [])]),
    ]);
    const ok = (table: string, r: Row): boolean => {
      for (const [col, v] of Object.entries(r)) {
        const holdingsSubject = table === "holdings" && col === "subject_id";
        if (!holdingsSubject && !isRefColumn(col)) continue;
        if (v === null || v === undefined) continue;
        if (typeof v !== "string") return false;
        const id = lc(v);
        let pool: Set<string>;
        if (holdingsSubject) pool = r.subject_kind === "event" ? events : r.subject_kind === "node" ? nodes : any;
        else if (col === "event_id" || col.endsWith("_event_id")) pool = events;
        else if (col === "superseded_by" || col.endsWith("_node_id")) pool = nodes;
        else pool = any;
        if (!pool.has(id)) return false;
      }
      return true;
    };
    let changed = false;
    for (const t of CHECKED) {
      const rows = t.rows(doc);
      const kept = rows.filter((r) => ok(t.key, r));
      if (kept.length !== rows.length) {
        refused[t.key] = (refused[t.key] ?? 0) + (rows.length - kept.length);
        t.set(doc, kept);
        changed = true;
      }
    }
    if (!changed) return refused;
  }
}

const CORE_TYPES = ["identity", "vow"];

/** A proposal that is neither settled, withdrawn nor rejected: pending and accepted alike are still open. */
const isOpenProposal = (p: Row): boolean => !["settled", "withdrawn", "rejected"].includes(String(p.status));

/**
 * Imports an export file into `target_mind` (which must already exist). Ids are kept, mind_id and
 * written_by are rewritten to the target, events keep their original created_at and get new seq in
 * file order; rows already present (by id, or by primary key for projections) are skipped, so a
 * re-run changes nothing. Events, nodes, edges, projections and letters sent by the mind commit in
 * one transaction.
 *
 * An import must not be a way around cooling or authorship:
 *  - identity and vow nodes are refused when the target has ever had any (live or retired), unless `allow_core`;
 *  - proposals.proposed_by is always the target (the original is counted in the notes); open declarations
 *    (any proposal not settled, withdrawn or rejected: pending or accepted) arrive withdrawn at import time, and attestations are cleared on every proposal;
 *  - a vow's declared break (metadata.break_declared) is stripped on import (counted in the notes);
 *  - letters_received are never imported (they belong to the sender's export, and only the sender can
 *    send them); the count is reported as ignored;
 *  - letters_sent (letters to other minds) are imported only with `with_letters`; otherwise they are
 *    reported as ignored. When imported, the read receipt is cleared (read_at, read_event_id null),
 *    sent_at is the sending event's created_at in the target, and the sending event must be a
 *    `letter.send` event whose payload `to` equals the letter's to_mind;
 *  - a row that references an id outside this file (a superseding node, an event, an edge endpoint,
 *    a holdings subject, ...) is refused and counted as skipped_foreign_ref; with `strict` any such
 *    refusal aborts the import before anything is written.
 *
 * With dry_run the same statements run and are rolled back, so the counts are what a real run would do.
 * Dry-run events take negative seq values (OVERRIDING SYSTEM VALUE), so the real events.seq sequence is
 * never advanced by a dry run.
 */
export async function importMind(
  pool: Pool,
  file: string,
  target_mind: string,
  opts: { dry_run?: boolean; allow_core?: boolean; strict?: boolean; with_letters?: boolean } = {},
): Promise<ImportMindReport> {
  const dry = opts.dry_run === true;
  if (!isValidMindId(target_mind)) throw new ImportError(mindIdProblem(target_mind));
  const st = await stat(file).catch((e: NodeJS.ErrnoException) => {
    throw new ImportError(`cannot read ${file}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  });
  if (!st.isFile()) throw new ImportError(`${file} is not a file`);
  if (st.size > MAX_IMPORT_MIND_BYTES) {
    throw new ImportError(
      `${file} is ${st.size} bytes; import-mind loads the whole file into memory and refuses files over ${MAX_IMPORT_MIND_BYTES} bytes (512 MiB)`,
    );
  }
  const doc = parseDoc(await readFile(file, "utf8"));
  const source = doc.mind_id;
  const target = target_mind;

  const found = await pool.query<{ disabled_at: Date | null }>("select disabled_at from minds where mind_id = $1", [target]);
  if (found.rows.length === 0) throw new ImportError(`mind "${target}" does not exist (create it with init or seed-keys first)`);
  if (found.rows[0]!.disabled_at !== null) throw new ImportError(`mind "${target}" has access suspended; nothing was imported`);

  const tables: Record<string, TableReport> = {};
  const notes: string[] = [];
  const own = (r: Row): Row => {
    const o: Row = { ...r, mind_id: target };
    if ("written_by" in o) o.written_by = target;
    return o;
  };

  // references outside the file are refused before anything is written
  const refused = dropForeignRefs(doc);
  const refusedTotal = Object.values(refused).reduce((a, b) => a + b, 0);
  if (refusedTotal > 0 && opts.strict === true) {
    throw new ImportError(
      `--strict: ${refusedTotal} row(s) reference ids that are not in the file (${Object.entries(refused).map(([k, n]) => `${k} ${n}`).join(", ")}); nothing was imported`,
    );
  }

  // proposals are authored by the importer, never by whoever the file names
  const rewritten = (doc.projections.proposals ?? []).filter((p) => p.proposed_by !== target);
  if (rewritten.length > 0) {
    const names = [...new Set(rewritten.map((p) => String(p.proposed_by)))].slice(0, 10).join(", ");
    notes.push(`${rewritten.length} proposal(s) had proposed_by rewritten to "${target}" (original proposer(s): ${names})`);
  }

  // open declarations never cross a file boundary live: the mind re-declares if it still means them
  const importedAt = new Date().toISOString();
  const openDeclarations = (doc.projections.proposals ?? []).filter((p) => isOpenProposal(p)).length;
  if (openDeclarations > 0) notes.push(`${openDeclarations} open declaration(s) in the file arrived withdrawn (status withdrawn, withdrawn_at = import time)`);
  const attested = (doc.projections.proposals ?? []).filter((p) => Array.isArray(p.attestations) && p.attestations.length > 0).length;
  if (attested > 0) notes.push(`attestations were cleared on ${attested} proposal(s): a steward's act belongs to the declaration it was made on`);
  let strippedBreaks = 0;
  doc.nodes = doc.nodes.map((n) => {
    const md = n.metadata;
    if (n.node_type === "vow" && md !== null && typeof md === "object" && !Array.isArray(md) && "break_declared" in md) {
      const { break_declared: _drop, ...rest } = md as Record<string, unknown>;
      strippedBreaks++;
      return { ...n, metadata: rest };
    }
    return n;
  });
  if (strippedBreaks > 0) notes.push(`${strippedBreaks} declared vow break(s) in the file were stripped on import`);

  const recvCount = (doc.projections.letters_received ?? []).length;
  if (recvCount > 0) {
    notes.push(`${recvCount} received letter(s) in the file were ignored: received letters belong to the sender's export and only the sender can re-send them`);
  }
  tables.letters_received = { inserted: 0, already_present: 0, ignored: recvCount };

  const withLetters = opts.with_letters === true;
  const sentInFile = (doc.projections.letters_sent ?? []).length;
  if (sentInFile > 0 && !withLetters) {
    notes.push(`${sentInFile} sent letter(s) in the file were ignored: letters to other minds are imported only with --with-letters`);
  }
  const sentLetters: Row[] = (withLetters ? doc.projections.letters_sent ?? [] : []).map((r) => ({
    ...r,
    from_mind: target,
    to_mind: r.to_mind === source ? target : r.to_mind,
  }));

  const dryEvents = dry ? { next: -1 } : undefined;
  try {
    await withMind(pool, target, target, "write", async (tx) => {
      const cols = async (t: string) => insertableColumns(tx, t);

      // identity and vow change only through the proposal flow; a file may not smuggle them past it
      const coreNodes = doc.nodes.filter((n) => CORE_TYPES.includes(String(n.node_type)));
      if (coreNodes.length > 0) {
        const already = await visibleNodeIds(tx, coreNodes);
        const fresh = coreNodes.filter((n) => !already.has(lc(n.id)));
        if (fresh.length > 0) {
          // "has an identity" means any identity/vow row at all, live or invalidated/retired: a mind that retired
          // its cores is not fresh, and a file must not re-seed it past the proposal flow
          const rows = Number(
            (
              await tx.query<{ n: string }>(
                `select count(*) as n from nodes where mind_id = $1 and node_type = any($2::text[])`,
                [target, CORE_TYPES],
              )
            ).rows[0]!.n,
          );
          if (rows > 0 && opts.allow_core === true) {
            notes.push(
              `${fresh.length} identity/vow node(s) imported live beside existing ones under --allow-core; they take effect immediately and do not cool`,
            );
          }
          if (rows > 0 && opts.allow_core !== true) {
            throw new ImportError(
              `refusing to import ${fresh.length} identity/vow node(s): mind "${target}" already has ${rows} identity/vow node(s). ` +
                `Identity and vows change only through mind_identity propose; pass --allow-core to import them anyway. Nothing was imported`,
            );
          }
        }
      }

      tables.events = await insertRows(tx, "events", doc.events.map(own), await cols("events"), {
        byId: true,
        skipExisting: true,
        ...(dryEvents ? { dryEvents } : {}),
      });

      // superseded_by points inside the same table, possibly at a later batch: insert nulled, link after
      const supersede: { id: string; sup: string }[] = [];
      const nodeRows = doc.nodes.map((r) => {
        const o = own(r);
        if (typeof o.superseded_by === "string") supersede.push({ id: lc(o.id), sup: lc(o.superseded_by) });
        o.superseded_by = null;
        return o;
      });
      const nodeIdsBefore = await visibleNodeIds(tx, nodeRows);
      tables.nodes = await insertRows(tx, "nodes", nodeRows, await cols("nodes"), { byId: true });
      for (const part of chunk(supersede.filter((s) => !nodeIdsBefore.has(s.id)), BATCH)) {
        await tx.query(
          `update nodes n set superseded_by = v.sup from jsonb_to_recordset($1::jsonb) as v(id uuid, sup uuid)
            where n.id = v.id and n.mind_id = $2 and n.superseded_by is null`,
          [JSON.stringify(part), target],
        );
      }

      tables.edges = await insertRows(tx, "edges", doc.edges.map(own), await cols("edges"), { byId: true });

      for (const key of PROJECTION_ORDER) {
        let rows = (doc.projections[key] ?? []).map(own);
        if (key === "proposals") {
          rows = rows.map((r) => {
            const open = isOpenProposal(r);
            return {
              ...r,
              proposed_by: target,
              attestations: [],
              ...(open ? { status: "withdrawn", withdrawn_at: importedAt } : {}),
            };
          });
        }
        const table = PROJECTION_TABLE[key]!;
        const byId = rows.length > 0 && rows.every((r) => typeof r.id === "string");
        tables[key] = await insertRows(tx, table, rows, await cols(table), { byId });
      }
      for (const k of Object.keys(doc.projections)) {
        if (!(PROJECTION_ORDER as readonly string[]).includes(k) && k !== "letters_sent" && k !== "letters_received") {
          notes.push(`projection "${k}" in the file is not known to this version and was ignored`);
        }
      }

      // letters this mind sent (only with --with-letters): the sending event was imported above, so check it in this transaction
      const letterCols = await cols("letters");
      const rep: TableReport = { inserted: 0, already_present: 0, skipped_missing_party: 0, skipped_missing_event: 0, skipped_event_mismatch: 0 };
      if (!withLetters) rep.ignored = sentInFile;
      const present = await existingMinds(tx, [...new Set(sentLetters.flatMap((l) => [String(l.from_mind), String(l.to_mind)]))]);
      const sendingEvents = new Map<string, { kind: string; to: unknown; created_at: string }>();
      for (const part of chunk(sentLetters.map((l) => lc(l.sent_event_id)), BATCH)) {
        const r = await tx.query<{ id: string; kind: string; to: unknown; created_at: string }>(
          "select id, kind, payload->'to' as \"to\", created_at::text as created_at from events where id = any($1::uuid[])",
          [part],
        );
        for (const x of r.rows) sendingEvents.set(x.id, x);
      }
      const sentOk: Row[] = [];
      for (const l of sentLetters) {
        const ev = sendingEvents.get(lc(l.sent_event_id));
        if (!present.has(String(l.from_mind)) || !present.has(String(l.to_mind))) rep.skipped_missing_party!++;
        else if (!ev) rep.skipped_missing_event!++;
        else if (ev.kind !== "letter.send" || ev.to !== l.to_mind) rep.skipped_event_mismatch!++;
        else {
          // the read receipt is the recipient's own record and never travels; sent_at is the ledger's time
          sentOk.push({ ...l, read_at: null, read_event_id: null, sent_at: ev.created_at });
        }
      }
      const res = await insertRows(tx, "letters", sentOk, letterCols, { byId: true });
      rep.inserted = res.inserted;
      rep.already_present = res.already_present;
      tables.letters_sent = rep;

      // dry run: the same statements ran; abandon them
      if (dry) throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }

  for (const [k, n] of Object.entries(refused)) {
    if (tables[k]) tables[k]!.skipped_foreign_ref = n;
  }
  if (refusedTotal > 0) notes.push(`${refusedTotal} row(s) were refused because they reference ids that are not in the file (skipped_foreign_ref)`);
  if (dry) notes.push("dry run: nothing was written (events.seq was not advanced)");
  notes.push("vectors are not exported; run embed-backfill (or the daemon) to re-embed the imported events and nodes");
  return { source_mind: source, target_mind: target, dry_run: dry, tables, notes };
}
