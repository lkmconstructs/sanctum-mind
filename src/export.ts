// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { createWriteStream, type WriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Pool } from "pg";
import { isValidMindId, mindIdProblem } from "./auth.js";
import { ArgError } from "./cli-args.js";

/** The export document format. import-mind refuses any other value. */
export const EXPORT_FORMAT = "sanctum-mind/1";
export const EXPORT_BATCH = 1000;

export const EXPORT_USAGE = "usage: sanctum-mind export-mind --mind <id> [--out <file>]";

export interface ExportArgs {
  mind: string;
  out: string;
}

export function parseExportArgs(argv: string[], now: () => Date = () => new Date()): ExportArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { mind: { type: "string" }, out: { type: "string" } }, strict: true, allowPositionals: true });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${EXPORT_USAGE}`);
  }
  if (parsed.positionals.length > 0) throw new ArgError(`export-mind takes no positional arguments (got "${parsed.positionals.join(" ")}")\n${EXPORT_USAGE}`);
  const mind = parsed.values.mind;
  if (mind === undefined || mind === "") throw new ArgError(`--mind <id> is required\n${EXPORT_USAGE}`);
  if (!isValidMindId(mind)) throw new ArgError(mindIdProblem(mind));
  const out = parsed.values.out;
  if (out === "") throw new ArgError("--out must not be empty");
  return { mind, out: out ?? `${mind}-export-${now().toISOString().replace(/[:.]/g, "-")}.json` };
}

interface TableSpec {
  /** key in the document */
  key: string;
  table: string;
  /** predicate on alias t; $1 is the mind id */
  where: string;
  /** primary key columns, the keyset order */
  pk: string[];
}

const mine = "t.mind_id = $1";
const PROJECTIONS: TableSpec[] = [
  { key: "brain_state", table: "brain_state", where: mine, pk: ["mind_id"] },
  { key: "drive_state", table: "drive_state", where: mine, pk: ["context", "drive"] },
  { key: "kv_contexts", table: "kv_contexts", where: mine, pk: ["key"] },
  { key: "handoffs", table: "handoffs", where: mine, pk: ["context"] },
  { key: "holdings", table: "holdings", where: mine, pk: ["subject_id"] },
  { key: "loops", table: "loops", where: mine, pk: ["id"] },
  { key: "threads", table: "threads", where: mine, pk: ["id"] },
  { key: "tasks", table: "tasks", where: mine, pk: ["id"] },
  { key: "relations", table: "relations", where: mine, pk: ["subject"] },
  { key: "proposals", table: "proposals", where: mine, pk: ["id"] },
  { key: "noticings", table: "noticings", where: mine, pk: ["id"] },
  { key: "extractor_state", table: "extractor_state", where: mine, pk: ["mind_id"] },
  { key: "extractor_models", table: "extractor_models", where: mine, pk: ["version"] },
  { key: "extractor_runs", table: "extractor_runs", where: mine, pk: ["pass", "started_at"] },
  { key: "letters_sent", table: "letters", where: "t.from_mind = $1", pk: ["id"] },
  // a letter scheduled for later is not the recipient's to read yet, so it is not in the recipient's export either
  { key: "letters_received", table: "letters", where: "t.to_mind = $1 and t.from_mind <> $1 and (t.deliver_at is null or t.deliver_at <= now())", pk: ["id"] },
];
const TOP: TableSpec[] = [
  // the ledger's total order is seq, so events are streamed in seq order and import re-appends in that order
  { key: "events", table: "events", where: mine, pk: ["seq"] },
  { key: "nodes", table: "nodes", where: mine, pk: ["id"] },
  { key: "edges", table: "edges", where: mine, pk: ["id"] },
];

/** Columns never exported: vectors are rebuilt by the embedding backfill; search is generated. */
const OMIT = ["embedding", "search"];

class Out {
  private err: Error | undefined;
  constructor(private readonly s: WriteStream) {
    s.on("error", (e) => {
      this.err = e;
    });
  }
  async write(chunk: string): Promise<void> {
    if (this.err) throw this.err;
    if (!this.s.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => {
          this.s.off("error", onError);
          resolve();
        };
        const onError = (e: Error) => {
          this.s.off("drain", onDrain);
          reject(e);
        };
        this.s.once("drain", onDrain);
        this.s.once("error", onError);
      });
    }
  }
  async end(): Promise<void> {
    if (this.err) throw this.err;
    await new Promise<void>((resolve, reject) => {
      this.s.once("error", reject);
      this.s.end(resolve);
    });
    if (this.err) throw this.err;
  }
  destroy(): void {
    this.s.destroy();
  }
}

export interface ExportResult {
  file: string;
  mind_id: string;
  counts: Record<string, number>;
}

/**
 * Streams one mind to `outPath` as the sanctum-mind/1 JSON document. Reads run in ONE repeatable-read,
 * read-only transaction scoped to the mind (a snapshot, so a projection never points at an event the
 * export missed) and page each table by primary key, 1000 rows a batch; rows are written as the
 * database produced them (jsonb text), so memory stays flat. Refuses to overwrite an existing file.
 */
export async function exportMind(pool: Pool, mind_id: string, outPath: string): Promise<ExportResult> {
  const counts: Record<string, number> = {};
  const client = await pool.connect();
  let out: Out | undefined;
  try {
    out = new Out(createWriteStream(outPath, { flags: "wx", mode: 0o600 }));
    await client.query("begin isolation level repeatable read read only");
    await client.query("select set_config('app.mind_id', $1, true), set_config('app.bearer', $1, true)", [mind_id]);

    await out.write(
      `{"format":${JSON.stringify(EXPORT_FORMAT)},"exported_at":${JSON.stringify(new Date().toISOString())},"mind_id":${JSON.stringify(mind_id)}`,
    );
    for (const spec of TOP) {
      await out.write(`,\n${JSON.stringify(spec.key)}:`);
      counts[spec.key] = await streamTable(client, out, spec, mind_id);
    }
    await out.write(`,\n"projections":{`);
    let first = true;
    for (const spec of PROJECTIONS) {
      await out.write(`${first ? "" : ","}\n${JSON.stringify(spec.key)}:`);
      first = false;
      counts[spec.key] = await streamTable(client, out, spec, mind_id);
    }
    await out.write("\n}}\n");
    await client.query("commit");
    await out.end();
    out = undefined;
    return { file: outPath, mind_id, counts };
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      // the original error matters more
    }
    if (out) {
      out.destroy();
      // only remove what this call created; an EEXIST refusal must leave the existing file alone
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") await unlink(outPath).catch(() => undefined);
    }
    throw e;
  } finally {
    client.release();
  }
}

async function streamTable(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  out: Out,
  spec: TableSpec,
  mind_id: string,
): Promise<number> {
  const pkSel = spec.pk.map((c, i) => `t.${c}::text as k${i}`).join(", ");
  const pkTuple = spec.pk.map((c) => `t.${c}`).join(", ");
  const omit = OMIT.map((c) => ` - '${c}'`).join("");
  let after: string[] | null = null;
  let n = 0;
  await out.write("[");
  for (;;) {
    const params: unknown[] = [mind_id];
    let keyset = "";
    if (after !== null) {
      const ph = after.map((v, i) => {
        params.push(v);
        return `$${i + 2}`;
      });
      keyset = ` and (${pkTuple}) > (${ph.join(", ")})`;
    }
    const r = await client.query(
      `select (to_jsonb(t)${omit})::text as j, ${pkSel} from ${spec.table} t
        where ${spec.where}${keyset} order by ${pkTuple} limit ${EXPORT_BATCH}`,
      params,
    );
    if (r.rows.length === 0) break;
    let chunk = "";
    for (const row of r.rows) chunk += `${n++ === 0 ? "\n" : ",\n"}${row.j as string}`;
    await out.write(chunk);
    const last = r.rows[r.rows.length - 1]!;
    after = spec.pk.map((_, i) => last[`k${i}`] as string);
    if (r.rows.length < EXPORT_BATCH) break;
  }
  await out.write(n === 0 ? "]" : "\n]");
  return n;
}
