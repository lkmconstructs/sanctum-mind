import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { upsertMinds } from "../src/auth.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { ArgError } from "../src/cli-args.js";
import { exportMind, parseExportArgs } from "../src/export.js";
import { ImportError, importMind, MAX_IMPORT_MIND_BYTES, parseImportMindArgs } from "../src/import-mind.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { PurgeError, parsePurgeArgs, purgeMind } from "../src/purge.js";
import { appPool, closePool, queryAs, queryLegacy, resetDatabase, testAppUrl, testDatabaseUrl } from "./helpers.js";

let admin: Pool;
let app: Pool;
const extra: Pool[] = [];
const dbs: string[] = [];
/** Test keys must meet the 32 character minimum. */
const K = (s: string): string => s.padEnd(32, "-");
const dir = mkdtempSync(join(tmpdir(), "portability-"));
let fileSeq = 0;
const outFile = () => join(dir, `x${fileSeq++}.json`);

const urlFor = (db: string, user?: string): string => {
  if (user) return testAppUrl(db);
  const u = new URL(testDatabaseUrl());
  u.pathname = `/${db}`;
  return u.toString();
};

beforeEach(async () => {
  for (const p of extra.splice(0)) await closePool(p);
  if (app) await closePool(app);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  app = appPool();
  await seed(admin, "alpha");
});

afterAll(async () => {
  for (const p of extra.splice(0)) await closePool(p);
  if (app) await closePool(app);
  if (admin) {
    for (const d of dbs) await admin.query(`drop database if exists ${d} with (force)`);
    await closePool(admin);
  }
});

/** A second, empty database with its own admin and app pools. */
async function secondDb(name: string, minds: string[]): Promise<{ admin: Pool; app: Pool }> {
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  dbs.push(name);
  await runMigrations(urlFor(name));
  const a = createPool(urlFor(name));
  const p = createPool(urlFor(name, "sanctum_test_app"));
  extra.push(a, p);
  for (const m of minds) await upsertMinds(a, [{ mind_id: m, key: K(`${m}-key`) }]);
  return { admin: a, app: p };
}

/** Every table of one mind, filled, with enough rows to cross the 1000 row batch more than once. */
async function seed(db: Pool, m: string): Promise<void> {
  const ev = "(select id from events where mind_id = $1::text order by seq limit 1)";
  await db.query(
    `insert into events (mind_id, kind, payload, texture, context, written_by, recorded_at, session_id, created_at, embedding, embedding_model,
                         event_time_start, event_time_granularity)
     select $1::text, case when i = 2 then 'letter.send' else 'note' end,
            case when i = 2 then jsonb_build_object('to', 'beta', 'letter_type', 'personal') else '{}'::jsonb end || jsonb_build_object('text', 'event ' || i, 'n', i * 1.5, 'tags', jsonb_build_array('a', i)),
            case when i % 7 = 0 then '{"charge":["warm"]}'::jsonb end, case when i % 5 = 0 then 'lane' end, $1::text,
            timestamptz '2026-01-01 00:00:00.123456+00' + (i || ' seconds')::interval, 's1',
            timestamptz '2026-01-01 00:00:00.654321+00' + (i || ' seconds')::interval,
            case when i % 100 = 0 then array_fill(0.1::real, array[384])::vector end, case when i % 100 = 0 then 'fake' end,
            case when i % 11 = 0 then timestamptz '2025-06-01+00' end, case when i % 11 = 0 then 'day' end
       from generate_series(1, 2300) i`,
    [m],
  );
  await db.query(
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, pinned, metadata, recorded_at,
                        created_at, access_count, embedding_model, invalidated_at)
     select $1::text, 'note', 'label ' || i, 'content ' || i, $1::text, 'extracted', (i % 10) / 10.0, i % 50 = 0, jsonb_build_object('i', i, 'f', i / 7.0),
            now(), timestamptz '2026-02-01 00:00:00.5+00' + (i || ' seconds')::interval, i % 4, case when i % 100 = 0 then 'fake' end,
            case when i % 97 = 0 then now() end
       from generate_series(1, 2500) i`,
    [m],
  );
  // supersession that points at a row in a LATER batch than its own
  await db.query(
    `update nodes set superseded_by = (select id from nodes where mind_id = $1::text and label = 'label 2500')
      where mind_id = $1::text and label = 'label 1'`,
    [m],
  );
  await db.query(
    `with n as (select id, row_number() over (order by (metadata->>'i')::int) rn from nodes where mind_id = $1::text)
     insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata)
     select $1::text, 'related_to', $1::text, a.id, b.id, 0.25, 0.75, '{"k":[1,2]}' from n a join n b on b.rn = a.rn + 1 where a.rn <= 1200`,
    [m],
  );
  const q = (sql: string) => db.query(sql.replaceAll("$EV", ev), [m]);
  await q(`insert into brain_state (mind_id, mood, energy, momentum, register, afterglow, note, last_event_id, updated_at)
           values ($1, 'calm', 'high', 'steady', 'quiet', 'warm', 'n', ${ev}, timestamptz '2026-03-01 00:00:00.777+00')`);
  await q(`insert into drive_state (mind_id, context, drive, intensity, frustration, satisfaction, last_event_id, updated_at)
           values ($1, '', 'care', 6, 1, 4, ${ev}, now()), ($1, 'lane', 'play', 7, 2, 3, ${ev}, now())`);
  await q(`insert into kv_contexts (mind_id, key, value, expires_at, last_event_id, updated_at, cleared_at)
           values ($1, 'k1', '{"a":[1,2,{"b":null}]}', null, ${ev}, now(), null),
                  ($1, 'k2', '"s"', now() + interval '1 day', ${ev}, now(), now())`);
  await q(`insert into handoffs (mind_id, context, handoff, session_id, last_event_id, updated_at)
           values ($1, '', '{"x":1}', 's1', ${ev}, now()), ($1, 'lane', '{"y":[2]}', null, ${ev}, now())`);
  await q(`insert into holdings (mind_id, subject_id, subject_kind, state, note, last_event_id, updated_at)
           values ($1, ${ev}, 'event', 'fresh', 'h', ${ev}, now()),
                  ($1, (select id from nodes where mind_id = $1::text order by created_at limit 1), 'node', 'active', null, ${ev}, now())`);
  await q(`insert into loops (mind_id, label, urgency, context, created_event_id, created_at, resolved_event_id, resolution, resolved_at)
           values ($1, 'open loop', 'burning', 'c', ${ev}, now(), null, null, null),
                  ($1, 'done loop', 'nagging', null, ${ev}, now(), ${ev}, 'fine', now())`);
  await q(`insert into threads (mind_id, label, priority, tags, status, notes, created_event_id, created_at, updated_at)
           values ($1, 'thread', 'high', '{a,b}', 'active', '[{"t":"n"}]', ${ev}, now(), now())`);
  await q(`insert into tasks (mind_id, title, description, priority, status, tags, depends_on, created_event_id, created_at, updated_at)
           values ($1, 'task', 'd', 'urgent', 'open', '{x}', array[gen_random_uuid(), gen_random_uuid()], ${ev}, now(), now())`);
  await q(`insert into relations (mind_id, subject, state, intensity, note, last_event_id, updated_at, cleared_at)
           values ($1, 'beta', 'warm', 0.5, 'r', ${ev}, now(), null), ($1, 'x', 'cold', 0.1, null, ${ev}, now(), now())`);
  // a pre-0017 shape: a pending proposal by another bearer, which today's guard refuses; seeded as legacy data
  await queryLegacy(db, `insert into proposals (mind_id, kind, section, content, lineage_note, proposed_by, event_id, status, created_at)
           values ($1, 'identity', 'who', 'c', 'l', 'beta', ${ev}, 'pending', now())`, [m]);
  await q(`insert into daemon_runs (mind_id, started_at, finished_at, passes, trigger) values ($1, now(), now(), '[{"pass":"x"}]', 'manual')`);
  await q(`insert into event_outbox (event_id, mind_id, sink) values (${ev}, $1, 's')`);
}

/** Letters between alpha and beta; beta gets one event of its own to send from. */
async function seedLetters(): Promise<{ betaEvent: string }> {
  const be = (
    await admin.query(
      `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('beta', 'letter.sent', '{}', 'beta', now()) returning id`,
    )
  ).rows[0].id as string;
  const ae = (await admin.query("select id from events where mind_id = 'alpha' order by seq limit 1 offset 1")).rows[0].id as string;
  await admin.query(
    `insert into letters (from_mind, to_mind, letter_type, subject, body, sent_event_id, sent_at, read_at, read_event_id)
     values ('alpha', 'beta', 'personal', 's1', 'dear beta', $1, now(), now(), $2),
            ('beta', 'alpha', 'personal', 's2', 'dear alpha', $2, now(), now(), $1)`,
    [ae, be],
  );
  return { betaEvent: be };
}

const SNAP_TABLES: [string, string, string][] = [
  ["events", "mind_id", "seq"],
  ["nodes", "mind_id", "to_jsonb(t)::text"],
  ["edges", "mind_id", "to_jsonb(t)::text"],
  ["brain_state", "mind_id", "to_jsonb(t)::text"],
  ["drive_state", "mind_id", "to_jsonb(t)::text"],
  ["kv_contexts", "mind_id", "to_jsonb(t)::text"],
  ["handoffs", "mind_id", "to_jsonb(t)::text"],
  ["holdings", "mind_id", "to_jsonb(t)::text"],
  ["loops", "mind_id", "to_jsonb(t)::text"],
  ["threads", "mind_id", "to_jsonb(t)::text"],
  ["tasks", "mind_id", "to_jsonb(t)::text"],
  ["relations", "mind_id", "to_jsonb(t)::text"],
  ["proposals", "mind_id", "to_jsonb(t)::text"],
];

/** Content of every exported table for one mind, with the columns that legitimately differ removed. */
async function snapshot(db: Pool, mind: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [table, col, order] of SNAP_TABLES) {
    const r = await db.query(
      // an open (pending or accepted) proposal arrives withdrawn by design, so its status and withdrawn_at are not compared
      `select coalesce(jsonb_agg(to_jsonb(t) - 'mind_id' - 'written_by' - 'proposed_by' - 'seq' - 'embedding' - 'search'${table === "proposals" ? " - 'status' - 'withdrawn_at'" : ""} order by ${order}), '[]') as rows
         from ${table} t where ${col} = $1`,
      [mind],
    );
    out[table] = r.rows[0].rows;
  }
  return out;
}

const count = async (db: Pool, table: string, mind = "alpha") =>
  Number((await db.query(`select count(*)::int as n from ${table} where mind_id = $1`, [mind])).rows[0].n);

describe("argument parsers", () => {
  it("export-mind", () => {
    expect(parseExportArgs(["--mind", "alpha", "--out", "f.json"])).toEqual({ mind: "alpha", out: "f.json" });
    expect(parseExportArgs(["--mind", "alpha"], () => new Date("2026-01-02T03:04:05.678Z")).out).toBe("alpha-export-2026-01-02T03-04-05-678Z.json");
    expect(() => parseExportArgs([])).toThrow(ArgError);
    expect(() => parseExportArgs(["--mind", "a b"])).toThrow(ArgError);
    expect(() => parseExportArgs(["--mind", "alpha", "--bogus"])).toThrow(ArgError);
    expect(() => parseExportArgs(["--mind", "alpha", "extra"])).toThrow(ArgError);
  });
  it("import-mind", () => {
    expect(parseImportMindArgs(["f.json", "--mind", "g", "--dry-run"])).toEqual({ file: "f.json", mind: "g", dryRun: true, allowCore: false, strict: false, withLetters: false });
    expect(parseImportMindArgs(["f.json", "--mind", "g", "--allow-core", "--strict"])).toMatchObject({ allowCore: true, strict: true });
    expect(parseImportMindArgs(["--mind", "g", "f.json"]).dryRun).toBe(false);
    expect(parseImportMindArgs(["f.json", "--mind", "g", "--with-letters"]).withLetters).toBe(true);
    expect(() => parseImportMindArgs(["--mind", "g"])).toThrow(ArgError);
    expect(() => parseImportMindArgs(["a", "b", "--mind", "g"])).toThrow(ArgError);
    expect(() => parseImportMindArgs(["f"])).toThrow(ArgError);
  });
  it("purge-mind needs --confirm equal to --mind", () => {
    expect(parsePurgeArgs(["--mind", "alpha", "--confirm", "alpha"])).toEqual({ mind: "alpha", confirm: "alpha", sever_letters: false });
    expect(parsePurgeArgs(["--mind", "alpha", "--confirm", "alpha", "--sever-letters"]).sever_letters).toBe(true);
    expect(() => parsePurgeArgs(["--mind", "alpha"])).toThrow(/--confirm/);
    expect(() => parsePurgeArgs(["--mind", "alpha", "--confirm", "Alpha"])).toThrow(/does not equal/);
    expect(() => parsePurgeArgs(["--mind", "alpha", "--confirm", "alpha ", "x"])).toThrow(ArgError);
  });
});

describe("export", () => {
  it("writes the document in the contract shape, batched, without vectors, and only the mind's own rows", async () => {
    await seedLetters();
    const f = outFile();
    const r = await exportMind(app, "alpha", f);
    expect(r.counts).toMatchObject({ events: 2300, nodes: 2500, edges: 1200 });
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(Object.keys(doc)).toEqual(["format", "exported_at", "mind_id", "events", "nodes", "edges", "projections"]);
    expect(doc).toMatchObject({ format: "sanctum-mind/1", mind_id: "alpha" });
    expect(Object.keys(doc.projections)).toEqual([
      "brain_state", "drive_state", "kv_contexts", "handoffs", "holdings", "loops", "threads", "tasks", "relations", "proposals",
      "letters_sent", "letters_received",
    ]);
    expect(doc.events).toHaveLength(2300);
    expect(doc.nodes).toHaveLength(2500);
    expect(doc.edges).toHaveLength(1200);
    expect(doc.events.every((e: any) => !("embedding" in e) && !("search" in e) && e.mind_id === "alpha")).toBe(true);
    expect(doc.events.filter((e: any) => e.embedding_model === "fake")).toHaveLength(23);
    // events in ledger order, no duplicates across batch edges
    const seqs = doc.events.map((e: any) => Number(e.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(doc.events.map((e: any) => e.id)).size).toBe(2300);
    expect(new Set(doc.nodes.map((e: any) => e.id)).size).toBe(2500);
    expect(doc.projections.letters_sent).toHaveLength(1);
    expect(doc.projections.letters_received).toHaveLength(1);
    expect(doc.projections.letters_sent[0].body).toBe("dear beta");
    expect(doc.projections.letters_received[0].body).toBe("dear alpha");
    expect(doc.projections.proposals).toHaveLength(1);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite and leaves the existing file alone; an unknown mind exports empty", async () => {
    const f = outFile();
    writeFileSync(f, "keep me");
    await expect(exportMind(app, "alpha", f)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(f, "utf8")).toBe("keep me");
    const g = outFile();
    const r = await exportMind(app, "nobody", g);
    expect(Object.values(r.counts).every((n) => n === 0)).toBe(true);
    expect(JSON.parse(readFileSync(g, "utf8")).events).toEqual([]);
  });

  it("does not leak another mind's rows or letters it is not a party to", async () => {
    await seedLetters();
    await admin.query(
      `insert into letters (from_mind, to_mind, letter_type, body, sent_event_id, sent_at)
       select 'beta', 'beta', 'personal', 'note to self', id, now() from events where mind_id = 'beta' limit 1`,
    );
    const f = outFile();
    await exportMind(app, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    const bodies = [...doc.projections.letters_sent, ...doc.projections.letters_received].map((l: any) => l.body).sort();
    expect(bodies).toEqual(["dear alpha", "dear beta"]);
  });
});

describe("import", () => {
  it("round trip into another database: identical counts and content, ids kept, authorship rewritten, vectors omitted", async () => {
    await seedLetters();
    const f = outFile();
    await exportMind(app, "alpha", f);
    const db2 = await secondDb("sanctum_port_dev2", ["gamma", "beta"]);

    const rep = await importMind(db2.app, f, "gamma", { with_letters: true });
    expect(rep.source_mind).toBe("alpha");
    expect(rep.tables.events).toEqual({ inserted: 2300, already_present: 0 });
    expect(rep.tables.nodes).toEqual({ inserted: 2500, already_present: 0 });
    expect(rep.tables.edges).toEqual({ inserted: 1200, already_present: 0 });
    expect(rep.tables.letters_sent).toMatchObject({ inserted: 1, skipped_missing_party: 0, skipped_missing_event: 0, skipped_event_mismatch: 0 });
    // received letters belong to the sender's export and are never imported
    expect(rep.tables.letters_received).toEqual({ inserted: 0, already_present: 0, ignored: 1 });

    expect(await snapshot(db2.admin, "gamma")).toEqual(await snapshot(admin, "alpha"));
    for (const t of ["events", "nodes", "edges", "brain_state", "drive_state", "kv_contexts", "handoffs", "holdings", "loops", "threads", "tasks", "relations", "proposals"]) {
      expect(await count(db2.admin, t, "gamma")).toBe(await count(admin, t, "alpha"));
    }
    // authorship is the importer; ownership is the target; vectors are gone but the model name is kept
    expect(Number((await db2.admin.query("select count(*)::int n from events where mind_id = 'gamma' and written_by <> 'gamma'")).rows[0].n)).toBe(0);
    expect(Number((await db2.admin.query("select count(*)::int n from nodes where mind_id = 'gamma' and written_by <> 'gamma'")).rows[0].n)).toBe(0);
    expect(Number((await db2.admin.query("select count(*)::int n from edges where mind_id = 'gamma' and written_by <> 'gamma'")).rows[0].n)).toBe(0);
    expect(Number((await db2.admin.query("select count(*)::int n from events where embedding is not null")).rows[0].n)).toBe(0);
    expect(Number((await db2.admin.query("select count(*)::int n from events where embedding_model = 'fake'")).rows[0].n)).toBe(23);
    // superseded_by crossed batches and survived
    const sup = await db2.admin.query(
      `select a.superseded_by = b.id as ok from nodes a, nodes b where a.mind_id = 'gamma' and b.mind_id = 'gamma' and a.label = 'label 1' and b.label = 'label 2500'`,
    );
    expect(sup.rows[0].ok).toBe(true);
    // authorship of a proposal is the importer even when the named proposer exists here
    expect((await db2.admin.query("select proposed_by, status from proposals where mind_id = 'gamma'")).rows[0]).toEqual({ proposed_by: "gamma", status: "withdrawn" });
    expect(rep.notes.some((n) => /1 proposal\(s\) had proposed_by rewritten to "gamma".*beta/.test(n))).toBe(true);
    // letters: only what the mind sent comes back, sender rewritten to gamma, body and id intact
    const letters = (await db2.admin.query("select from_mind, to_mind, body from letters order by body")).rows;
    expect(letters).toEqual([{ from_mind: "gamma", to_mind: "beta", body: "dear beta" }]);
    // L1: the read receipt does not travel, and sent_at is the sending event's created_at in the target
    const lt = (await db2.admin.query(
      "select l.read_at, l.read_event_id, l.sent_at = e.created_at as sent_at_is_event_time from letters l join events e on e.id = l.sent_event_id",
    )).rows;
    expect(lt).toEqual([{ read_at: null, read_event_id: null, sent_at_is_event_time: true }]);
    expect((await admin.query("select read_at from letters where body = 'dear beta'")).rows[0].read_at).not.toBeNull();
    const srcLetters = (await admin.query("select id from letters where body = 'dear beta'")).rows;
    expect((await db2.admin.query("select id from letters")).rows).toEqual(srcLetters);
    // the ledger is the ledger: created_at is the original, seq is new and in file order
    const a = (await admin.query("select id, created_at from events where mind_id = 'alpha' order by seq")).rows;
    const g = (await db2.admin.query("select id, created_at from events where mind_id = 'gamma' order by seq")).rows;
    expect(g).toEqual(a);
    // the backfill finds the imported rows (null embedding) and the trigger lets it fill them
    await db2.admin.query(
      "update events set embedding = array_fill(0.2::real, array[384])::vector, embedding_model = 'fake2' where id = $1",
      [g[0].id],
    );
  });

  it("is idempotent: a second run inserts nothing and changes nothing", async () => {
    const f = outFile();
    await exportMind(app, "alpha", f);
    const db2 = await secondDb("sanctum_port_dev2", ["gamma", "beta"]);
    await importMind(db2.app, f, "gamma", {});
    const before = await snapshot(db2.admin, "gamma");
    const again = await importMind(db2.app, f, "gamma", {});
    for (const [k, t] of Object.entries(again.tables)) {
      expect(t.inserted, k).toBe(0);
    }
    expect(again.tables.events).toEqual({ inserted: 0, already_present: 2300 });
    expect(await snapshot(db2.admin, "gamma")).toEqual(before);
    expect(await count(db2.admin, "events", "gamma")).toBe(2300);
  });

  it("dry run reports the counts of a real run and writes nothing", async () => {
    const f = outFile();
    await exportMind(app, "alpha", f);
    const db2 = await secondDb("sanctum_port_dev2", ["gamma", "beta"]);
    const dry = await importMind(db2.app, f, "gamma", { dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(dry.tables.events).toEqual({ inserted: 2300, already_present: 0 });
    expect(dry.tables.nodes).toEqual({ inserted: 2500, already_present: 0 });
    expect(await count(db2.admin, "events", "gamma")).toBe(0);
    expect(await count(db2.admin, "nodes", "gamma")).toBe(0);
    const real = await importMind(db2.app, f, "gamma", {});
    expect(real.tables.events).toEqual(dry.tables.events);
    expect(real.tables.proposals).toEqual(dry.tables.proposals);
  });

  it("letters are inserted only when both parties exist; a later re-import fills them in", async () => {
    await seedLetters();
    const f = outFile();
    await exportMind(app, "alpha", f);
    const db2 = await secondDb("sanctum_port_dev2", ["gamma"]);
    const first = await importMind(db2.app, f, "gamma", { with_letters: true });
    expect(first.tables.letters_sent).toMatchObject({ inserted: 0, skipped_missing_party: 1 });
    expect(first.tables.letters_received).toMatchObject({ inserted: 0, ignored: 1 });
    // a proposer that does not exist here becomes the importer
    expect((await db2.admin.query("select proposed_by from proposals where mind_id = 'gamma'")).rows[0].proposed_by).toBe("gamma");
    expect(Number((await db2.admin.query("select count(*)::int n from letters")).rows[0].n)).toBe(0);

    await upsertMinds(db2.admin, [{ mind_id: "beta", key: K("b") }]);
    const second = await importMind(db2.app, f, "gamma", { with_letters: true });
    expect(second.tables.letters_sent).toMatchObject({ inserted: 1, skipped_missing_party: 0 });
    expect(second.tables.letters_received).toMatchObject({ inserted: 0, ignored: 1 });
    const third = await importMind(db2.app, f, "gamma", { with_letters: true });
    expect(third.tables.letters_sent).toMatchObject({ inserted: 0, already_present: 1 });
    expect(third.tables.letters_received).toMatchObject({ inserted: 0, ignored: 1 });
    expect(Number((await db2.admin.query("select count(*)::int n from letters where to_mind = 'gamma'")).rows[0].n)).toBe(0);
    expect(third.tables.events!.inserted).toBe(0);
  });

  it("L1: without --with-letters sent letters are reported as ignored and nothing is written", async () => {
    await seedLetters();
    const f = outFile();
    await exportMind(app, "alpha", f);
    const db2 = await secondDb("sanctum_port_dev2", ["gamma", "beta"]);
    const rep = await importMind(db2.app, f, "gamma", {});
    expect(rep.tables.letters_sent).toMatchObject({ inserted: 0, already_present: 0, ignored: 1 });
    expect(rep.notes.some((n) => /1 sent letter\(s\).*ignored.*--with-letters/.test(n))).toBe(true);
    expect(Number((await db2.admin.query("select count(*)::int n from letters")).rows[0].n)).toBe(0);
    // the events themselves still came in
    expect(rep.tables.events!.inserted).toBe(2300);
  });

  it("L1: with --with-letters a letter whose sending event is not letter.send, or names another recipient, is refused", async () => {
    await seedLetters();
    const f = outFile();
    await exportMind(app, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    const letter = doc.projections.letters_sent[0];
    const sendEv = doc.events.find((e: any) => e.id === letter.sent_event_id);
    expect(sendEv.kind).toBe("letter.send");

    const db2 = await secondDb("sanctum_port_dev2", ["gamma", "beta"]);
    // 1. the sending event is an ordinary note
    const other = doc.events.find((e: any) => e.kind === "note");
    const f1 = outFile();
    writeFileSync(f1, JSON.stringify({ ...doc, projections: { ...doc.projections, letters_sent: [{ ...letter, sent_event_id: other.id }] } }));
    const r1 = await importMind(db2.app, f1, "gamma", { with_letters: true, dry_run: true });
    expect(r1.tables.letters_sent).toMatchObject({ inserted: 0, skipped_event_mismatch: 1 });
    // 2. the event says the letter went to someone else
    const f2 = outFile();
    const events2 = doc.events.map((e: any) => (e.id === sendEv.id ? { ...e, payload: { ...e.payload, to: "delta" } } : e));
    writeFileSync(f2, JSON.stringify({ ...doc, events: events2 }));
    const r2 = await importMind(db2.app, f2, "gamma", { with_letters: true, dry_run: true });
    expect(r2.tables.letters_sent).toMatchObject({ inserted: 0, skipped_event_mismatch: 1 });
    // 3. the untouched file is accepted
    const r3 = await importMind(db2.app, f, "gamma", { with_letters: true, dry_run: true });
    expect(r3.tables.letters_sent).toMatchObject({ inserted: 1, skipped_event_mismatch: 0 });
    expect(Number((await db2.admin.query("select count(*)::int n from letters")).rows[0].n)).toBe(0);
  });

  it("refuses ids that already belong to another mind, and imports nothing", async () => {
    const f = outFile();
    await exportMind(app, "alpha", f);
    await expect(importMind(app, f, "beta", {})).rejects.toThrow(/already exists in another mind/);
    expect(await count(admin, "events", "beta")).toBe(0);
    expect(await count(admin, "nodes", "beta")).toBe(0);
  });

  it("moves a mind in the same database once the original is purged (rename)", async () => {
    await admin.query("delete from daemon_runs; delete from event_outbox");
    const before = await snapshot(admin, "alpha");
    const f = outFile();
    await exportMind(app, "alpha", f);
    await purgeMind(admin, "alpha");
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    await importMind(app, f, "gamma", {});
    expect(await snapshot(admin, "gamma")).toEqual(before);
  });

  it("rejects bad files with clear errors", async () => {
    const bad = (content: string) => {
      const p = outFile();
      writeFileSync(p, content);
      return p;
    };
    await expect(importMind(app, join(dir, "nope.json"), "alpha", {})).rejects.toThrow(/no such file/);
    await expect(importMind(app, bad("{nope"), "alpha", {})).rejects.toThrow(/not valid JSON/);
    await expect(importMind(app, bad('{"format":"other/9"}'), "alpha", {})).rejects.toThrow(/unsupported format/);
    await expect(importMind(app, bad('{"format":"sanctum-mind/1","mind_id":"alpha","events":{}}'), "gamma", {})).rejects.toThrow(ImportError);
    const ok = bad('{"format":"sanctum-mind/1","mind_id":"alpha","events":[],"nodes":[],"edges":[],"projections":{}}');
    await expect(importMind(app, ok, "ghost", {})).rejects.toThrow(/does not exist/);
    expect(MAX_IMPORT_MIND_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe("purge", () => {
  const allCounts = async (mind: string) => {
    const tables = (
      await admin.query("select table_name from information_schema.columns where table_schema = 'public' and column_name = 'mind_id' order by 1")
    ).rows.map((r) => r.table_name as string);
    const out: Record<string, number> = {};
    for (const t of tables) if (t !== "minds") out[t] = await count(admin, t, mind);
    return out;
  };

  it("removes every table's rows including daemon_runs and the outbox, and the id can be created again", async () => {
    const pre = await allCounts("alpha");
    expect(pre.daemon_runs).toBe(1);
    expect(pre.event_outbox).toBe(1);
    const betaBefore = await allCounts("beta");
    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('beta', 'alpha', 'read')");
    const r = await purgeMind(admin, "alpha", { confirm: "alpha" });
    expect(r.counts).toMatchObject({ events: 2300, nodes: 2500, edges: 1200, daemon_runs: 1, event_outbox: 1, grants: 2, minds: 1, letters: 0 });
    expect(Object.values(await allCounts("alpha")).every((n) => n === 0)).toBe(true);
    expect(await allCounts("beta")).toEqual(betaBefore);
    expect((await admin.query("select count(*)::int n from minds where mind_id = 'alpha'")).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int n from grants where grantor_mind = 'alpha' or grantee_mind = 'alpha'")).rows[0].n).toBe(0);
    // the ledger is still append-only afterwards
    await admin.query("insert into events (mind_id, kind, payload, written_by, recorded_at) values ('beta', 'k', '{}', 'beta', now())");
    await expect(admin.query("delete from events where mind_id = 'beta'")).rejects.toThrow(/append-only/);
    expect((await admin.query("select tgenabled from pg_trigger where tgname = 'events_no_update_delete'")).rows[0].tgenabled).toBe("O");
    // the id can be created again and is empty
    await upsertMinds(admin, [{ mind_id: "alpha", key: K("again") }]);
    expect(Object.values(await allCounts("alpha")).every((n) => n === 0)).toBe(true);
  });

  it("refuses with letters outstanding, then succeeds with sever_letters", async () => {
    await seedLetters();
    const before = await allCounts("alpha");
    await expect(purgeMind(admin, "alpha", { confirm: "alpha" })).rejects.toThrow(/2 letter\(s\) held by other minds/);
    expect(await allCounts("alpha")).toEqual(before);
    expect((await admin.query("select count(*)::int n from letters")).rows[0].n).toBe(2);
    const r = await purgeMind(admin, "alpha", { sever_letters: true, confirm: "alpha" });
    expect(r.counts).toMatchObject({ letters: 2, letters_severed: 2, minds: 1 });
    expect((await admin.query("select count(*)::int n from letters")).rows[0].n).toBe(0);
    expect((await admin.query("select count(*)::int n from events where mind_id = 'beta'")).rows[0].n).toBe(1);
  });

  it("refuses a wrong confirmation and an unknown mind; nothing is deleted", async () => {
    await expect(purgeMind(admin, "alpha", { confirm: "Alpha" })).rejects.toThrow(PurgeError);
    await expect(purgeMind(admin, "ghost", { confirm: "ghost" })).rejects.toThrow(/does not exist/);
    expect(await count(admin, "events")).toBe(2300);
  });

  it("refuses when the mind authored rows inside another mind", async () => {
    await admin.query("insert into events (mind_id, kind, payload, written_by, recorded_at) values ('beta', 'k', '{}', 'alpha', now())");
    await expect(purgeMind(admin, "alpha")).rejects.toThrow(/authored rows inside other minds.*events\.written_by=1/);
    expect(await count(admin, "events")).toBe(2300);
  });

  it("is not available to the app role, which still cannot delete anything", async () => {
    await expect(app.query("select purge_mind('alpha', true)")).rejects.toThrow(/permission denied/);
    await expect(purgeMind(app, "alpha")).rejects.toThrow(/ADMIN/);
    await expect(app.query("delete from nodes")).rejects.toThrow(/permission denied/);
    expect(await count(admin, "nodes")).toBe(2500);
  });

  it("works when the function owner is not a superuser (FORCE row level security is lifted and restored)", async () => {
    await admin.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'sanctum_test_owner') then create role sanctum_test_owner nologin; end if; end $$");
    const tables = (await admin.query("select tablename from pg_tables where schemaname = 'public'")).rows.map((r) => r.tablename as string);
    for (const t of tables) await admin.query(`alter table ${t} owner to sanctum_test_owner`);
    await admin.query("grant usage, create on schema public to sanctum_test_owner");
    await admin.query("alter function purge_mind(text, boolean) owner to sanctum_test_owner");
    await seedLetters();
    await purgeMind(admin, "alpha", { sever_letters: true });
    expect(Object.values(await allCounts("alpha")).every((n) => n === 0)).toBe(true);
    const forced = (await admin.query("select relforcerowsecurity f from pg_class where relname in ('events', 'letters', 'nodes')")).rows;
    expect(forced.every((r) => r.f === true)).toBe(true);
    expect((await admin.query("select tgenabled from pg_trigger where tgname = 'events_no_update_delete'")).rows[0].tgenabled).toBe("O");
    for (const t of tables) await admin.query(`alter table ${t} owner to postgres`);
  });
});

describe("import cannot bypass the mind's authorship of identity or fake authorship", () => {
  const uuid = () => crypto.randomUUID();
  const writeDoc = (doc: Record<string, unknown>): string => {
    const p = outFile();
    writeFileSync(p, JSON.stringify({ format: "sanctum-mind/1", mind_id: "alpha", exported_at: new Date().toISOString(), projections: {}, events: [], nodes: [], edges: [], ...doc }));
    return p;
  };
  const ev = (id: string) => ({ id, mind_id: "alpha", kind: "note", payload: { t: id }, written_by: "alpha", recorded_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" });
  const node = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, mind_id: "alpha", node_type: "note", label: `l-${id.slice(0, 4)}`, content: "c", written_by: "alpha", source_type: "extracted", confidence: 1, metadata: {}, ...extra,
  });
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await admin.query(sql, params)).rows as T[];
  const betaNode = async (): Promise<string> =>
    (await q(`insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence) values ('beta','note','b','b','beta','extracted',1) returning id`))[0].id;

  /** The crafted file: an identity node, a forged proposer, a forged received letter, a cross-mind superseded_by. */
  async function crafted() {
    const bn = await betaNode();
    const be = (await q(`insert into events (mind_id, kind, payload, written_by, recorded_at) values ('beta','k','{}','beta',now()) returning id`))[0].id;
    const e1 = uuid(), idn = uuid(), n1 = uuid(), n2 = uuid(), n3 = uuid(), prop = uuid(), lt = uuid();
    const file = writeDoc({
      events: [ev(e1)],
      nodes: [
        node(n1),
        node(idn, { node_type: "identity", label: "core", pinned: true }),
        node(n2, { superseded_by: bn }), // another mind's node
        node(n3, { superseded_by: n2 }), // points at a row that is itself refused
      ],
      edges: [
        { id: uuid(), mind_id: "alpha", edge_type: "related_to", written_by: "alpha", source_node_id: n1, target_node_id: bn, weight: 0.5, confidence: 1, metadata: {} },
      ],
      projections: {
        brain_state: [{ mind_id: "alpha", mood: "calm", last_event_id: be, updated_at: "2026-01-01T00:00:00Z" }],
        proposals: [{ id: prop, mind_id: "alpha", kind: "identity", section: "s", content: "forged", proposed_by: "beta", event_id: e1, status: "pending", created_at: "2026-01-01T00:00:00Z" }],
        letters_received: [{ id: lt, from_mind: "beta", to_mind: "alpha", letter_type: "personal", body: "forged", sent_event_id: be, sent_at: "2026-01-01T00:00:00Z" }],
      },
    });
    return { file, bn, be, e1, idn, n1, n2, n3, prop, lt };
  }
  const gammaWithIdentity = async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    await q(`insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, pinned) values ('gamma','identity','core','I am','gamma','extracted',1,true)`);
  };

  it("refuses identity and vow nodes into a mind that already has them, naming the count; nothing is written", async () => {
    await gammaWithIdentity();
    const c = await crafted();
    await expect(importMind(app, c.file, "gamma", {})).rejects.toThrow(/1 identity\/vow node\(s\).*already has 1 identity\/vow node\(s\).*--allow-core/);
    expect(await count(admin, "events", "gamma")).toBe(0);
    expect(await count(admin, "nodes", "gamma")).toBe(1);
    expect(await count(admin, "proposals", "gamma")).toBe(0);
  });

  it("a fresh mind gets no --allow-core note when nothing sits beside the imported cores", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const c = await crafted();
    const rep = await importMind(app, c.file, "gamma", { allow_core: true });
    expect(rep.notes.some((n) => /under --allow-core/.test(n))).toBe(false);
  });

  it("a fresh mind may receive identity nodes without --allow-core", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const c = await crafted();
    await importMind(app, c.file, "gamma", {});
    expect((await q("select node_type from nodes where id = $1", [c.idn]))[0].node_type).toBe("identity");
    // and re-importing the same file into that now non-fresh mind adds nothing new, so nothing is refused
    const again = await importMind(app, c.file, "gamma", {});
    expect(again.tables.nodes!.inserted).toBe(0);
  });

  it("a mind that retired its cores is not fresh: a file with a new core is refused without --allow-core (nothing written), imported loudly with it", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const gamma: any = { bearer: "gamma", grants: {} };
    const call = (input: Record<string, unknown>) =>
      runVerb({ pool: app, registry, now: () => new Date(Date.now() + 1000), coolingMs: 0 }, gamma, "mind_identity", { mind_id: "gamma", ...input }) as Promise<any>;
    const old = (await call({ operation: "affirm", section: "core", content: "I was" })).receipt.projection.node_id as string;
    expect((await call({ operation: "retire", target_node_id: old })).ok).toBe(true);
    expect((await call({ operation: "settle" })).receipt.projection.settled).toBe(1);
    // retired: no live identity row, but a row nonetheless
    expect((await q("select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).not.toBeNull();
    expect((await q("select count(*)::int n from nodes where mind_id = 'gamma' and node_type = 'identity' and invalidated_at is null"))[0].n).toBe(0);

    const c = await crafted();
    const before = { events: await count(admin, "events", "gamma"), nodes: await count(admin, "nodes", "gamma"), proposals: await count(admin, "proposals", "gamma") };
    await expect(importMind(app, c.file, "gamma", {})).rejects.toThrow(/1 identity\/vow node\(s\).*already has 1 identity\/vow node\(s\).*--allow-core.*Nothing was imported/);
    expect({ events: await count(admin, "events", "gamma"), nodes: await count(admin, "nodes", "gamma"), proposals: await count(admin, "proposals", "gamma") }).toEqual(before);
    expect(await q("select 1 from nodes where id = $1", [c.idn])).toEqual([]);

    const rep = await importMind(app, c.file, "gamma", { allow_core: true });
    expect(rep.notes).toContain(
      "1 identity/vow node(s) imported live beside existing ones under --allow-core; they take effect immediately and do not cool",
    );
    expect((await q("select node_type from nodes where id = $1", [c.idn]))[0].node_type).toBe("identity");
  });

  it("with --allow-core: proposed_by is rewritten, the forged letter is ignored, cross-mind references are skipped", async () => {
    await gammaWithIdentity();
    const c = await crafted();
    const rep = await importMind(app, c.file, "gamma", { allow_core: true });
    expect((await q("select node_type from nodes where id = $1", [c.idn]))[0].node_type).toBe("identity");
    // loud: the report says these took effect at once and did not cool
    expect(rep.notes).toContain(
      "1 identity/vow node(s) imported live beside existing ones under --allow-core; they take effect immediately and do not cool",
    );
    // authorship: the proposer is the importer, the original is counted in the notes
    expect((await q("select proposed_by, mind_id from proposals where id = $1", [c.prop]))[0]).toEqual({ proposed_by: "gamma", mind_id: "gamma" });
    expect(rep.notes.some((n) => /1 proposal\(s\) had proposed_by rewritten to "gamma".*beta/.test(n))).toBe(true);
    // received letters are never imported
    expect(rep.tables.letters_received).toEqual({ inserted: 0, already_present: 0, ignored: 1 });
    expect((await q("select count(*)::int n from letters")).at(0)!.n).toBe(0);
    // the node pointing at another mind's node, the node pointing at that refused node, the edge to another mind's node
    // and the brain_state naming another mind's event are refused; the rest comes in
    expect(rep.tables.nodes).toMatchObject({ inserted: 2, skipped_foreign_ref: 2 });
    expect(rep.tables.edges).toMatchObject({ inserted: 0, skipped_foreign_ref: 1 });
    expect(rep.tables.brain_state).toMatchObject({ inserted: 0, skipped_foreign_ref: 1 });
    expect((await q("select id from nodes where mind_id = 'gamma' and id in ($1, $2)", [c.n2, c.n3]))).toEqual([]);
    expect((await q("select id from nodes where id = $1", [c.n1])).length).toBe(1);
    expect(await count(admin, "brain_state", "gamma")).toBe(0);
    // nothing of gamma points at beta
    expect((await q("select count(*)::int n from nodes where mind_id = 'gamma' and superseded_by is not null"))[0].n).toBe(0);
  });

  it("--strict aborts on the first foreign reference and writes nothing", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const c = await crafted();
    await expect(importMind(app, c.file, "gamma", { strict: true })).rejects.toThrow(/--strict: 4 row\(s\) reference ids that are not in the file.*nodes 2.*edges 1.*brain_state 1/);
    expect(await count(admin, "events", "gamma")).toBe(0);
    expect(await count(admin, "nodes", "gamma")).toBe(0);
  });

  it("holdings subjects are checked against the kind they name", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const e1 = uuid(), n1 = uuid();
    const f = writeDoc({
      events: [ev(e1)],
      nodes: [node(n1)],
      projections: {
        holdings: [
          { mind_id: "alpha", subject_id: e1, subject_kind: "event", state: "fresh", last_event_id: e1, updated_at: "2026-01-01T00:00:00Z" },
          { mind_id: "alpha", subject_id: n1, subject_kind: "node", state: "fresh", last_event_id: e1, updated_at: "2026-01-01T00:00:00Z" },
          { mind_id: "alpha", subject_id: n1, subject_kind: "event", state: "fresh", last_event_id: e1, updated_at: "2026-01-01T00:00:00Z" },
          { mind_id: "alpha", subject_id: uuid(), subject_kind: "node", state: "fresh", last_event_id: e1, updated_at: "2026-01-01T00:00:00Z" },
        ],
      },
    });
    // the third has a node id under kind event, the fourth an unknown id
    const rep = await importMind(app, f, "gamma", {});
    expect(rep.tables.holdings).toMatchObject({ inserted: 2, skipped_foreign_ref: 2 });
  });

  it("raw SQL cannot point superseded_by or a proposal target at another mind's node", async () => {
    const bn = await betaNode();
    const an = (await q(`select id from nodes where mind_id = 'alpha' limit 1`))[0].id;
    await expect(admin.query("update nodes set superseded_by = $2 where id = $1", [an, bn])).rejects.toThrow(/nodes_superseded_same_mind/);
    await expect(admin.query("update proposals set target_node_id = $1 where mind_id = 'alpha'", [bn])).rejects.toThrow(/proposals_target_same_mind/);
    // the same mind is fine, and so is null
    await admin.query("update proposals set target_node_id = $1 where mind_id = 'alpha'", [an]);
    await admin.query("update nodes set superseded_by = null where id = $1", [an]);
  });

  it("dry run does not consume events.seq; the real run does", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const f = writeDoc({ events: [ev(uuid()), ev(uuid()), ev(uuid())] });
    const seq = async () => (await q(`select last_value::text lv, is_called from ${(await q("select pg_get_serial_sequence('events','seq') s"))[0].s}`))[0];
    const before = await seq();
    const dry = await importMind(app, f, "gamma", { dry_run: true });
    expect(dry.tables.events).toEqual({ inserted: 3, already_present: 0 });
    expect(await seq()).toEqual(before);
    expect(await count(admin, "events", "gamma")).toBe(0);
    await importMind(app, f, "gamma", {});
    expect(Number((await seq()).lv)).toBe(Number(before.lv) + 3);
    // a re-run of events that exist does not burn sequence values either
    const mid = await seq();
    await importMind(app, f, "gamma", {});
    expect(await seq()).toEqual(mid);
  });

  it("a column missing from some rows of a batch takes its database default, not NULL", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const [a, b, c2] = [uuid(), uuid(), uuid()];
    const { pinned: _p, ...noPinned } = node(b);
    const f = writeDoc({ nodes: [node(a, { pinned: true }), noPinned, node(c2, { pinned: null })] });
    // pinned is NOT NULL default false: row b omits it (default), row c carries an explicit null (a file error)
    await expect(importMind(app, f, "gamma", {})).rejects.toThrow(/null value in column "pinned"/);
    const g = writeDoc({ nodes: [node(a, { pinned: true }), noPinned] });
    await importMind(app, g, "gamma", {});
    expect((await q("select id, pinned from nodes where mind_id = 'gamma' order by pinned desc")).map((r) => r.pinned)).toEqual([true, false]);
  });

  it("the cross-mind id clash check is case-insensitive", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const be = (await q(`select id from events where mind_id = 'alpha' limit 1`))[0].id as string;
    const f = writeDoc({ events: [ev(be.toUpperCase())] });
    await expect(importMind(app, f, "gamma", {})).rejects.toThrow(/events id .* already exists in another mind/);
    expect(await count(admin, "events", "gamma")).toBe(0);
  });
});

describe("export details", () => {
  it("leaves out received letters that are scheduled for later; the sender still exports its own", async () => {
    const { betaEvent } = await seedLetters();
    await admin.query(
      `insert into letters (from_mind, to_mind, letter_type, subject, body, deliver_at, sent_event_id, sent_at)
       values ('beta', 'alpha', 'personal', 'later', 'not yet', now() + interval '1 day', $1, now()),
              ('beta', 'alpha', 'personal', 'past', 'already due', now() - interval '1 day', $1, now())`,
      [betaEvent],
    );
    const f = outFile();
    await exportMind(app, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(doc.projections.letters_received.map((l: any) => l.body).sort()).toEqual(["already due", "dear alpha"]);
    const g = outFile();
    await exportMind(app, "beta", g);
    expect(JSON.parse(readFileSync(g, "utf8")).projections.letters_sent.map((l: any) => l.body)).toContain("not yet");
  });

  it("reads one repeatable-read snapshot: a row committed mid-export is not in it", async () => {
    let isolation = "";
    let readOnly = "";
    const wrapped = {
      async connect() {
        const c = await app.connect();
        const orig = c.query.bind(c) as (...a: any[]) => Promise<any>;
        let injected = false;
        (c as any).query = async (...args: any[]) => {
          const sql = typeof args[0] === "string" ? args[0] : "";
          if (!injected && /from nodes t/.test(sql)) {
            injected = true;
            isolation = (await orig("show transaction_isolation")).rows[0].transaction_isolation;
            readOnly = (await orig("show transaction_read_only")).rows[0].transaction_read_only;
            // committed by another session after the snapshot was taken, before the nodes are read
            await admin.query(`insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence) values ('alpha','note','late','late','alpha','extracted',1)`);
          }
          return orig(...args);
        };
        return c;
      },
    } as unknown as Pool;
    const f = outFile();
    const r = await exportMind(wrapped, "alpha", f);
    expect(isolation).toBe("repeatable read");
    expect(readOnly).toBe("on");
    expect(r.counts.nodes).toBe(2500);
    expect(JSON.parse(readFileSync(f, "utf8")).nodes.some((n: any) => n.label === "late")).toBe(false);
    expect(await count(admin, "nodes")).toBe(2501);
  });
});

describe("purge and references from other minds", () => {
  it("refuses, naming table.column and the count, when another mind's rows point into this mind; succeeds once removed", async () => {
    const ae = (await admin.query("select id from events where mind_id = 'alpha' order by seq limit 1")).rows[0].id as string;
    // superuser can write what the app role never could: beta's projection naming alpha's event
    await admin.query(
      `insert into brain_state (mind_id, mood, last_event_id, updated_at) values ('beta', 'x', $1, now())`,
      [ae],
    );
    await admin.query(
      `insert into kv_contexts (mind_id, key, value, last_event_id, updated_at) values ('beta', 'k', '1', $1, now()), ('beta', 'k2', '2', $1, now())`,
      [ae],
    );
    const eventsBefore = await count(admin, "events");
    // the function walks pg_constraint in catalog order, so the two entries may come in either order
    const refusal = await purgeMind(admin, "alpha", { confirm: "alpha" }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(refusal).toMatch(/referenced by rows of other minds/);
    expect(refusal).toMatch(/brain_state\.last_event_id=1/);
    expect(refusal).toMatch(/kv_contexts\.last_event_id=2/);
    await expect(purgeMind(admin, "alpha")).rejects.not.toThrow(/violates foreign key/);
    expect(await count(admin, "events")).toBe(eventsBefore);
    expect((await admin.query("select count(*)::int n from minds where mind_id = 'alpha'")).rows[0].n).toBe(1);
    await admin.query("delete from brain_state where mind_id = 'beta'; delete from kv_contexts where mind_id = 'beta'");
    const r = await purgeMind(admin, "alpha", { confirm: "alpha" });
    expect(r.counts).toMatchObject({ events: 2300, minds: 1 });
  });

  it("a letter of another pair of minds that cites this mind's event is refused too", async () => {
    await seedLetters();
    await admin.query("insert into minds (mind_id, key_hash) values ('delta', 'd')");
    const ae = (await admin.query("select id from events where mind_id = 'alpha' order by seq limit 1")).rows[0].id as string;
    await admin.query(
      `insert into letters (from_mind, to_mind, letter_type, body, sent_event_id, sent_at) values ('beta', 'delta', 'personal', 'x', $1, now())`,
      [ae],
    );
    await expect(purgeMind(admin, "alpha", { sever_letters: true })).rejects.toThrow(/letters\.sent_event_id=1/);
  });
});

describe("import does not carry live declarations", () => {
  const uuid = () => crypto.randomUUID();
  const past = "2020-01-01T00:00:00Z";
  const q = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => (await admin.query(sql, params)).rows as T[];
  const writeDoc = (doc: Record<string, unknown>): string => {
    const p = outFile();
    writeFileSync(p, JSON.stringify({ format: "sanctum-mind/1", mind_id: "alpha", exported_at: new Date().toISOString(), projections: {}, events: [], nodes: [], edges: [], ...doc }));
    return p;
  };
  const ev = (id: string) => ({ id, mind_id: "alpha", kind: "note", payload: { t: id }, written_by: "alpha", recorded_at: past, created_at: past });
  const node = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, mind_id: "alpha", node_type: "note", label: `l-${id.slice(0, 4)}`, content: "c", written_by: "alpha", source_type: "extracted", confidence: 1, metadata: {}, ...extra,
  });
  const proposal = (id: string, e: string, target: string, extra: Record<string, unknown> = {}) => ({
    id, mind_id: "alpha", kind: "identity", section: "core", content: "PLANTED", lineage_note: "x", proposed_by: "alpha", event_id: e,
    status: "accepted", created_at: past, target_node_id: target, effective_at: past, attestations: [{ by: "beta", stance: "attest", note: "planted", at: past, event_id: e }],
    ...extra,
  });
  const settleGamma = async () =>
    (
      await runDaemonOnce({ pool: app, embedder: NONE_EMBEDDER, now: () => new Date() }, { trigger: "manual", minds: ["gamma"] })
    )[0]!.passes.find((p) => p.pass === "identity.settle")!;

  it("the planted-proposal repro: a past-due accepted proposal in the file arrives withdrawn and the core is untouched after settle", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const e1 = uuid(), core = uuid(), prop = uuid();
    const f = writeDoc({
      events: [ev(e1)],
      nodes: [node(core, { node_type: "identity", label: "core", content: "I am", pinned: true })],
      projections: { proposals: [proposal(prop, e1, core)] },
    });
    const rep = await importMind(app, f, "gamma", {});
    expect(rep.notes.some((n) => /1 open declaration\(s\).*withdrawn/.test(n))).toBe(true);
    const [row] = await q("select status, withdrawn_at, settled_at, proposed_by, attestations from proposals where id = $1", [prop]);
    expect(row).toMatchObject({ status: "withdrawn", settled_at: null, proposed_by: "gamma", attestations: [] });
    expect(row.withdrawn_at).not.toBeNull();
    expect(new Date(row.withdrawn_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await settleGamma()).changed).toBe(0);
    const [n] = await q("select content, invalidated_at from nodes where id = $1", [core]);
    expect(n).toEqual({ content: "I am", invalidated_at: null });
    expect(await q("select id from nodes where mind_id = 'gamma' and content = 'PLANTED'")).toEqual([]);
  });

  it("attestations arrive empty on every imported proposal, whatever its status", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const e1 = uuid(), core = uuid(), p1 = uuid(), p2 = uuid();
    const f = writeDoc({
      events: [ev(e1)],
      nodes: [node(core, { node_type: "identity", label: "core", pinned: true })],
      projections: { proposals: [proposal(p1, e1, core, { status: "settled", settled_at: past }), proposal(p2, e1, core, { status: "pending", effective_at: null })] },
    });
    const rep = await importMind(app, f, "gamma", {});
    expect(rep.notes.some((n) => /attestations were cleared on 2 proposal/.test(n))).toBe(true);
    // the pending one is open too: it arrives withdrawn (the settled one is history and stays settled)
    expect((await q("select id, status, attestations from proposals where mind_id = 'gamma' order by status")).map((r) => [r.status, r.attestations])).toEqual([["settled", []], ["withdrawn", []]]);
  });

  it("a pending planted proposal arrives withdrawn and does not block the mind's own propose on that core", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const e1 = uuid(), core = uuid(), prop = uuid(), settledProp = uuid(), rejectedProp = uuid();
    const f = writeDoc({
      events: [ev(e1)],
      nodes: [node(core, { node_type: "identity", label: "core", content: "I am", pinned: true })],
      projections: {
        proposals: [
          proposal(prop, e1, core, { status: "pending", effective_at: null }),
          proposal(settledProp, e1, core, { status: "settled", settled_at: past }),
          proposal(rejectedProp, e1, core, { status: "rejected", effective_at: null }),
        ],
      },
    });
    const rep = await importMind(app, f, "gamma", {});
    expect(rep.notes.some((n) => /1 open declaration\(s\).*withdrawn/.test(n))).toBe(true);
    const [row] = await q("select status, withdrawn_at, proposed_by from proposals where id = $1", [prop]);
    expect(row).toMatchObject({ status: "withdrawn", proposed_by: "gamma" });
    expect(row.withdrawn_at).not.toBeNull();
    expect((await q("select status from proposals where id = $1", [settledProp]))[0].status).toBe("settled");
    expect((await q("select status from proposals where id = $1", [rejectedProp]))[0].status).toBe("rejected");
    // the mind's own rewrite of that core goes through
    const r = (await runVerb({ pool: app, registry, now: () => new Date() }, { bearer: "gamma", grants: {} }, "mind_identity", {
      mind_id: "gamma",
      operation: "propose",
      section: "core",
      content: "mine",
      target_node_id: core,
    })) as any;
    expect(r.ok).toBe(true);
  });

  it("a planted declaration against a vow id never settles, even if it were accepted by raw SQL", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const e1 = uuid(), vow = uuid(), prop = uuid();
    const f = writeDoc({
      events: [ev(e1)],
      nodes: [node(vow, { node_type: "vow", label: "v", content: "keep faith", pinned: true, metadata: { broken: false } })],
      projections: { proposals: [proposal(prop, e1, vow)] },
    });
    await importMind(app, f, "gamma", {});
    expect((await q("select status from proposals where id = $1", [prop]))[0].status).toBe("withdrawn");
    // force it live again as the operator could with raw SQL: the settle join on node_type = 'identity' still refuses it
    await admin.query("update proposals set status = 'accepted', withdrawn_at = null where id = $1", [prop]);
    expect((await settleGamma()).changed).toBe(0);
    const [n] = await q("select content, invalidated_at from nodes where id = $1", [vow]);
    expect(n).toEqual({ content: "keep faith", invalidated_at: null });
    expect((await q("select status from proposals where id = $1", [prop]))[0].status).toBe("accepted");
  });

  it("a proposal not authored by the mind never settles even when accepted and past due", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const e1 = uuid(), core = uuid(), prop = uuid();
    const f = writeDoc({
      events: [ev(e1)],
      nodes: [node(core, { node_type: "identity", label: "core", content: "I am", pinned: true })],
      projections: { proposals: [proposal(prop, e1, core)] },
    });
    await importMind(app, f, "gamma", {});
    await admin.query("update proposals set status = 'accepted', withdrawn_at = null, proposed_by = 'beta' where id = $1", [prop]);
    expect((await settleGamma()).changed).toBe(0);
    expect((await q("select content from nodes where id = $1", [core]))[0].content).toBe("I am");
  });

  it("a vow's declared break is stripped on import and counted", async () => {
    await upsertMinds(admin, [{ mind_id: "gamma", key: K("g") }]);
    const vow = uuid();
    const f = writeDoc({
      nodes: [node(vow, { node_type: "vow", label: "v", content: "keep faith", pinned: true, metadata: { broken: false, context: "kept", break_declared: { reason: "r", declared_at: past, effective_at: past, event_id: uuid() } } })],
    });
    const rep = await importMind(app, f, "gamma", {});
    expect(rep.notes.some((n) => /1 declared vow break\(s\).*stripped/.test(n))).toBe(true);
    expect((await q("select metadata from nodes where id = $1", [vow]))[0].metadata).toEqual({ broken: false, context: "kept" });
    expect((await settleGamma()).changed).toBe(0);
  });
});

describe("retire declarations cross a file boundary", () => {
  it("an open retire arrives withdrawn, the core stays live, and action survives export and import", async () => {
    const mind: any = { bearer: "alpha", grants: {} };
    const call = (input: Record<string, unknown>) =>
      runVerb({ pool: app, registry, now: () => new Date(), coolingMs: 24 * 3_600_000 }, mind, "mind_identity", { mind_id: "alpha", ...input }) as Promise<any>;
    const core = (await call({ operation: "affirm", section: "core", content: "old self" })).receipt.projection.node_id as string;
    const p = (await call({ operation: "retire", target_node_id: core, lineage_note: "enough" })).receipt.projection.proposal;
    expect(p.action).toBe("retire");

    const f = outFile();
    await exportMind(app, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(doc.projections.proposals.find((x: any) => x.id === p.id)).toMatchObject({ action: "retire", status: "accepted" });

    const db2 = await secondDb("sanctum_port_retire", ["gamma"]);
    await importMind(db2.app, f, "gamma", {});
    const [row] = (await db2.admin.query("select action, status, withdrawn_at, content from proposals where id = $1", [p.id])).rows;
    expect(row).toMatchObject({ action: "retire", status: "withdrawn", content: "old self" });
    expect(row.withdrawn_at).not.toBeNull();
    expect((await db2.admin.query("select invalidated_at from nodes where id = $1", [core])).rows[0].invalidated_at).toBeNull();
  });
});
