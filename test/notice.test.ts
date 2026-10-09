// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, queryLegacy, resetDatabase, testAppUrl, testDatabaseUrl } from "./helpers.js";
import { upsertMinds } from "../src/auth.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool, withMind } from "../src/db/pool.js";
import { ArgError } from "../src/cli-args.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { runDaemonOnce, PASSES } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { noticeExpire } from "../src/extractor/expire.js";
import { noticeTrain as ALL_MODEL_TRAIN } from "../src/extractor/train.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import { exportMind } from "../src/export.js";
import { importMind } from "../src/import-mind.js";
import { purgeMind } from "../src/purge.js";
import { extractorReport, formatExtractorReport, parseExtractorArgs, runExtractorCommand, setExtractorState } from "../src/extractor-admin.js";
import type { Caller, Embedder, VerbContext } from "../src/verbs/types.js";
import { mind_notice } from "../src/verbs/mind_notice.js";
import { noticeAcceptedPayload, noticeRejectedPayload } from "../src/verbs/notice_events.js";
import { EXTRACTOR_EVENT_SHAPES } from "../src/extractor/events.js";
import { DEFAULT_EXTRACTOR_TTL_DAYS, extractorTtlDays, noticingExpiresAt } from "../src/extractor/config.js";
import { NEEDS_ADMIN } from "../src/extractor-admin.js";

const DAY = 86_400_000;
const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: {} };
const betaRead: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const betaWrite: Caller = { bearer: "beta", grants: { alpha: ["read", "write"] } };
const betaSteward: Caller = { bearer: "beta", grants: { alpha: ["read", "steward"] } };
const MSG = "memory is authored by the mind";

let admin: Pool;
let pool: Pool;
let T0: Date;
let clock: Date;
let embedder: Embedder = NONE_EMBEDDER;

const run = (caller: Caller, name: string, input: unknown) =>
  runVerb({ pool, registry, now: () => clock, embedder }, caller, name, input) as Promise<any>;
const N = (caller: Caller, input: Record<string, unknown>, mind = "alpha") => run(caller, "mind_notice", { mind_id: mind, ...input });
const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const expectErr = (r: any, code: string, field?: string) => {
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe(code);
  if (field !== undefined) expect(r.error.field).toBe(field);
};

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  T0 = new Date();
  clock = T0;
  embedder = NONE_EMBEDDER;
});

afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

// ---- seeding helpers: everything is inserted as the mind itself, the way the extractor pass will run ----

async function mkNode(mind: string, content: string, type = "observation"): Promise<string> {
  const r = await queryAs(
    pool, mind, mind,
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence) values ($1, $2, $3, $4, $1, 'extracted', 1.0) returning id`,
    [mind, type, content.slice(0, 50), content],
  );
  return r.rows[0].id;
}

async function mkEvent(mind: string, payload: object, kind = "observe", subject: string | null = null): Promise<string> {
  const r = await queryAs(
    pool, mind, mind,
    `insert into events (mind_id, kind, payload, subject_id, written_by, recorded_at) values ($1, $2, $3::jsonb, $4, $1, now()) returning id`,
    [mind, kind, JSON.stringify(payload), subject],
  );
  return r.rows[0].id;
}

interface Seed {
  kind?: "link" | "pattern" | "distillation";
  sources: string[];
  payload?: object;
  score?: number;
  stage?: "shadow" | "propose";
  status?: "pending" | "accepted" | "rejected" | "expired";
  expires_at?: Date;
  created_at?: Date;
}

/** One noticing, inserted as the mind with its `notice.proposed` event, the way the pass will. Returns its id. */
async function seedNoticing(s: Seed, mind = "alpha"): Promise<string> {
  const kind = s.kind ?? "link";
  const payload = s.payload ?? (kind === "link" ? { edge_type: "related_to", reason: "both mention rain" } : kind === "pattern" ? { label: "Rain", summary: "rain keeps coming up", window: { start: "2026-01-01", end: "2026-01-07" } } : { content: "rain matters to me", lineage: [] });
  const ev = await mkEvent(mind, { kind }, "notice.proposed");
  const r = await queryAs(
    pool, mind, mind,
    `insert into noticings (mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at, created_at,
                            decided_event_id, decided_at)
     values ($1, $2, $3::uuid[], $4::jsonb, $5, '{}', 0, $6, $7, $8, $9, $10, case when $7 = 'pending' then null else $8::uuid end,
             case when $7 = 'pending' then null else now() end) returning id`,
    [mind, kind, s.sources, JSON.stringify(payload), s.score ?? 0.5, s.stage ?? "propose", s.status ?? "pending", ev,
      s.expires_at ?? new Date(T0.getTime() + 14 * DAY), s.created_at ?? new Date()],
  );
  return r.rows[0].id;
}

/** One statement in a transaction carrying the three settings, the way withMind sets them (actor may be "" for none). */
async function inTx(db: Pool, mind: string, bearer: string, actor: string, sql: string, params: unknown[] = []) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.mind_id', $1, true), set_config('app.bearer', $2, true), set_config('app.actor', $3, true)", [mind, bearer, actor]);
    const r = await client.query(sql, params);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** The operator's switch, set the way the CLI sets it. */
const setState = (mind: string, stage: "shadow" | "propose", extra: { enabled?: boolean; paused?: boolean } = {}) =>
  inTx(
    admin, mind, mind, "operator",
    `insert into extractor_state (mind_id, enabled, stage, paused_at) values ($1, $2, $3, case when $4::boolean then now() end)
     on conflict (mind_id) do update set enabled = excluded.enabled, stage = excluded.stage, paused_at = excluded.paused_at`,
    [mind, extra.enabled ?? true, stage, extra.paused ?? false],
  );

/** Byte-level snapshot of rows, to prove sources are untouched. */
const snapshot = async (ids: string[]): Promise<string[]> =>
  (await admin.query(`select to_jsonb(n)::text as j from nodes n where id = any($1::uuid[]) order by id`, [ids])).rows.map((r) => r.j);
const countOf = async (table: string, where = "true"): Promise<number> =>
  (await admin.query(`select count(*)::int n from ${table} where ${where}`)).rows[0].n;

// ---------------------------------------------------------------------------------------------------------------

describe("mind_notice list", () => {
  it("is empty with stage 'off' when there is no extractor_state row, however many proposals exist", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    await seedNoticing({ sources: [a, b] });
    const r = await N(alpha, { operation: "list" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toEqual({ noticings: [], stage: "off" });
  });

  it("is empty at stage shadow and never shows a shadow-stage row even after the stage becomes propose", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    await seedNoticing({ sources: [a, b], stage: "shadow" });
    await setState("alpha", "shadow");
    expect((await N(alpha, { operation: "list" })).receipt.projection).toEqual({ noticings: [], stage: "shadow" });
    await setState("alpha", "propose");
    const r = await N(alpha, { operation: "list" });
    expect(r.receipt.projection).toEqual({ noticings: [], stage: "propose" });
  });

  it("shows pending propose rows ranked by score with typed 240-character snippets, filters by kind, limits, and hides decided rows", async () => {
    await setState("alpha", "propose");
    const long = "x".repeat(300);
    const n1 = await mkNode("alpha", long);
    const n2 = await mkNode("alpha", "short node");
    const e1 = await mkEvent("alpha", { content: "an observed thing " + "y".repeat(300) });
    const e2 = await mkEvent("alpha", { text: "a written thing" }, "write");
    const low = await seedNoticing({ sources: [n1, n2], score: 0.2 });
    const high = await seedNoticing({ kind: "pattern", sources: [e1, e2, n2], score: 0.9 });
    const mid = await seedNoticing({ kind: "distillation", sources: [n1], score: 0.5 });
    await seedNoticing({ sources: [n1, n2], score: 0.99, status: "rejected" });
    await seedNoticing({ sources: [n1, n2], score: 0.98, stage: "shadow" });

    const r = await N(alpha, { operation: "list" });
    expect(r.ok).toBe(true);
    const p = r.receipt.projection;
    expect(p.stage).toBe("propose");
    expect(p.noticings.map((x: any) => x.id)).toEqual([high, mid, low]);
    expect(Object.keys(p.noticings[0]).sort()).toEqual(["expires_at", "id", "kind", "payload", "score", "sources"]);
    const pat = p.noticings[0];
    expect(pat.kind).toBe("pattern");
    expect(pat.payload.label).toBe("Rain");
    expect(pat.sources.map((s: any) => [s.id, s.type])).toEqual([[e1, "event"], [e2, "event"], [n2, "node"]]);
    expect(pat.sources[0].snippet).toHaveLength(240);
    expect(pat.sources[0].snippet.startsWith("an observed thing yyy")).toBe(true);
    expect(pat.sources[1].snippet).toBe("a written thing");
    expect(p.noticings[1].sources[0].snippet).toBe("x".repeat(240));

    expect((await N(alpha, { operation: "list", kind: "link" })).receipt.projection.noticings.map((x: any) => x.id)).toEqual([low]);
    expect((await N(alpha, { operation: "list", limit: 2 })).receipt.projection.noticings.map((x: any) => x.id)).toEqual([high, mid]);
    expectErr(await N(alpha, { operation: "list", limit: 101 }), "invalid_input", "limit");
    expectErr(await N(alpha, { operation: "list", kind: "dream" }), "invalid_input", "kind");
    // reading appends nothing
    expect(await countOf("events", "kind like 'notice.%' and kind <> 'notice.proposed'")).toBe(0);
  });

  it("a read grantee may list; a caller with no grant is forbidden", async () => {
    await setState("alpha", "propose");
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    await seedNoticing({ sources: [a, b] });
    expect((await N(betaRead, { operation: "list" })).receipt.projection.noticings).toHaveLength(1);
    expectErr(await N(beta, { operation: "list" }), "forbidden");
  });
});

describe("rls isolation", () => {
  it("each mind sees only its own noticings, state and models; another mind's id is not found; policies refuse a foreign mind_id", async () => {
    await setState("alpha", "propose");
    await setState("beta", "propose");
    const a1 = await mkNode("alpha", "a1");
    const a2 = await mkNode("alpha", "a2");
    const b1 = await mkNode("beta", "b1");
    const b2 = await mkNode("beta", "b2");
    const an = await seedNoticing({ sources: [a1, a2] }, "alpha");
    const bn = await seedNoticing({ sources: [b1, b2] }, "beta");
    await admin.query("insert into extractor_models (mind_id, version, weights) values ('alpha', 1, '{}'), ('beta', 1, '{}')");

    for (const t of ["noticings", "extractor_state", "extractor_models"]) {
      const asAlpha = await q("alpha", `select mind_id from ${t}`);
      expect(asAlpha.length).toBeGreaterThan(0);
      expect(asAlpha.every((r) => r.mind_id === "alpha")).toBe(true);
      expect((await q("beta", `select mind_id from ${t}`)).every((r) => r.mind_id === "beta")).toBe(true);
    }
    expect((await N(alpha, { operation: "list" })).receipt.projection.noticings.map((x: any) => x.id)).toEqual([an]);
    expect((await N(beta, { operation: "list" }, "beta")).receipt.projection.noticings.map((x: any) => x.id)).toEqual([bn]);
    // beta deciding alpha's noticing in its own scope: not found, and alpha's row is untouched
    expectErr(await N(beta, { operation: "reject", noticing_id: an }, "beta"), "not_found", "noticing_id");
    expect((await admin.query("select status from noticings where id = $1", [an])).rows[0].status).toBe("pending");
    // the database refuses writing a row into another mind's scope
    await expect(
      queryAs(pool, "beta", "beta", `insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at)
        values ('alpha', 'link', '{}', '{}', 0, 'propose', (select id from events where mind_id = 'beta' limit 1), now())`),
    ).rejects.toThrow(/own scope|row-level security/i);
    // and the app role cannot flip the operator's switch
    await expect(queryAs(pool, "alpha", "alpha", "update extractor_state set enabled = false")).rejects.toThrow(/permission denied/);
    await expect(queryAs(pool, "alpha", "alpha", "delete from extractor_state")).rejects.toThrow(/permission denied/);
    await expect(queryAs(pool, "alpha", "alpha", "delete from noticings")).rejects.toThrow(/permission denied/);
  });
});

describe("accept and reject are the mind's alone", () => {
  it("write and steward grantees (and read, and strangers) are forbidden with the message, and nothing is written", async () => {
    await setState("alpha", "propose");
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const id = await seedNoticing({ sources: [a, b] });
    const before = { events: await countOf("events"), edges: await countOf("edges"), nodes: await countOf("nodes") };
    for (const caller of [betaWrite, betaSteward, betaRead, beta]) {
      for (const input of [{ operation: "accept", noticing_id: id }, { operation: "reject", noticing_id: id, reason: "no" }]) {
        const r = await N(caller, input);
        expectErr(r, "forbidden");
        expect(r.error.message).toBe(MSG);
      }
    }
    expect({ events: await countOf("events"), edges: await countOf("edges"), nodes: await countOf("nodes") }).toEqual(before);
    expect((await admin.query("select status, decided_event_id from noticings where id = $1", [id])).rows[0]).toEqual({ status: "pending", decided_event_id: null });
  });

  it("requires a noticing_id", async () => {
    expectErr(await N(alpha, { operation: "accept" }), "invalid_input", "noticing_id");
    expectErr(await N(alpha, { operation: "reject" }), "invalid_input", "noticing_id");
    expectErr(await N(alpha, { operation: "accept", noticing_id: "00000000-0000-4000-8000-000000000000" }), "not_found", "noticing_id");
  });
});

describe("accept", () => {
  beforeEach(async () => {
    await setState("alpha", "propose");
  });

  it("link: one edge authored by the mind with the noticing in its metadata, the ordinary link event, notice.accepted, sources byte-identical", async () => {
    const a = await mkNode("alpha", "it rained on the hill");
    const b = await mkNode("alpha", "the garden was wet");
    const id = await seedNoticing({ sources: [a, b], payload: { edge_type: "references", reason: "both are weather" } });
    const before = await snapshot([a, b]);
    const events0 = await countOf("events");

    const r = await N(alpha, { operation: "accept", noticing_id: id });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toMatchObject({ noticing_id: id, status: "accepted" });

    const edges = (await admin.query("select * from edges")).rows;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ mind_id: "alpha", written_by: "alpha", source_node_id: a, target_node_id: b, edge_type: "references", weight: 0.5, confidence: 1 });
    expect(edges[0].metadata.noticing_id).toBe(id);
    expect(edges[0].id).toBe(r.receipt.projection.edge_id);

    const evs = (await admin.query("select * from events order by seq offset $1", [events0])).rows;
    expect(evs.map((e) => e.kind)).toEqual(["link", "notice.accepted"]);
    expect(evs[1]).toMatchObject({ subject_id: id, written_by: "alpha" });
    expect(evs[1].payload).toMatchObject({ noticing_id: id, kind: "link", edge_id: edges[0].id });
    expect(edges[0].metadata.event_id).toBe(evs[0].id);
    expect(r.receipt.event_id).toBe(evs[1].id);

    const row = (await admin.query("select * from noticings where id = $1", [id])).rows[0];
    expect(row).toMatchObject({ status: "accepted", decided_event_id: evs[1].id });
    expect(row.decided_at).toBeInstanceOf(Date);
    expect(await snapshot([a, b])).toEqual(before);
    expect(await countOf("nodes")).toBe(2);
  });

  it("link: edge_type and weight from the mind override the proposal; an existing edge is reused (warning) and the noticing is still accepted", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const id = await seedNoticing({ sources: [a, b] });
    const r = await N(alpha, { operation: "accept", noticing_id: id, edge_type: "contradicts", weight: 0.9 });
    expect(r.ok).toBe(true);
    expect((await admin.query("select edge_type, weight from edges")).rows).toEqual([{ edge_type: "contradicts", weight: 0.9 }]);
    const again = await seedNoticing({ sources: [a, b], payload: { edge_type: "contradicts", reason: "again" } });
    const r2 = await N(alpha, { operation: "accept", noticing_id: again });
    expect(r2.ok).toBe(true);
    expect(r2.receipt.warnings).toEqual(["exists"]);
    expect(await countOf("edges")).toBe(1);
    expect((await admin.query("select status from noticings where id = $1", [again])).rows[0].status).toBe("accepted");
  });

  it("link: an unknown payload edge_type falls back to related_to; content is refused; an event source cannot be an edge end (conflict, nothing written)", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const ev = await mkEvent("alpha", { content: "e" });
    const odd = await seedNoticing({ sources: [a, b], payload: { edge_type: "made_up", reason: "r" } });
    expectErr(await N(alpha, { operation: "accept", noticing_id: odd, content: "words" }), "invalid_input", "content");
    expect((await N(alpha, { operation: "accept", noticing_id: odd })).ok).toBe(true);
    expect((await admin.query("select edge_type from edges")).rows[0].edge_type).toBe("related_to");

    const mixed = await seedNoticing({ sources: [a, ev] });
    const before = await countOf("events");
    expectErr(await N(alpha, { operation: "accept", noticing_id: mixed }), "conflict", "noticing_id");
    expect(await countOf("events")).toBe(before);
    expect((await admin.query("select status from noticings where id = $1", [mixed])).rows[0].status).toBe("pending");
  });

  it("pattern: one pattern node (not pinned, label from the proposal), instance_of edges from each source node, events recorded in metadata only, sources untouched", async () => {
    const n1 = await mkNode("alpha", "monday rain");
    const n2 = await mkNode("alpha", "tuesday rain");
    const e1 = await mkEvent("alpha", { content: "wednesday rain" });
    const id = await seedNoticing({ kind: "pattern", sources: [n1, n2, e1] });
    const before = await snapshot([n1, n2]);
    const evBefore = (await admin.query("select to_jsonb(e)::text j from events e where id = $1", [e1])).rows[0].j;

    const r = await N(alpha, { operation: "accept", noticing_id: id });
    expect(r.ok).toBe(true);
    const nodeId = r.receipt.projection.node_id;
    const node = (await admin.query("select * from nodes where id = $1", [nodeId])).rows[0];
    expect(node).toMatchObject({ node_type: "pattern", label: "Rain", content: "rain keeps coming up", pinned: false, written_by: "alpha", mind_id: "alpha", source_type: "extracted", confidence: 1 });
    const pat = (await admin.query("select * from events where kind = 'pattern'")).rows;
    expect(pat).toHaveLength(1);
    expect(pat[0]).toMatchObject({ written_by: "alpha", payload: { noticing_id: id, label: "Rain", content: "rain keeps coming up", sources: [n1, n2, e1], edited: false } });
    expect(node.metadata).toEqual({ noticing_id: id, sources: [n1, n2, e1], event_id: pat[0].id });
    expect(r.receipt.projection.pattern_event_id).toBe(pat[0].id);
    const edges = (await admin.query("select * from edges order by source_node_id")).rows;
    expect(edges.map((e) => [e.edge_type, e.source_node_id, e.target_node_id].join()).sort()).toEqual(
      [n1, n2].map((s) => ["instance_of", s, nodeId].join()).sort(),
    );
    expect(edges.every((e) => e.written_by === "alpha" && e.metadata.noticing_id === id && e.metadata.event_id === pat[0].id)).toBe(true);
    const acc = (await admin.query("select * from events where kind = 'notice.accepted'")).rows;
    expect(acc).toHaveLength(1);
    expect(acc[0]).toMatchObject({ subject_id: id, written_by: "alpha" });
    // ids only: the words live in the pattern event and the node
    expect(acc[0].payload).toEqual({ noticing_id: id, kind: "pattern", sources: [n1, n2, e1], node_id: nodeId, content_event_id: pat[0].id, edited: false });
    expect((await admin.query("select status, decided_event_id from noticings where id = $1", [id])).rows[0]).toEqual({ status: "accepted", decided_event_id: acc[0].id });
    expect(await snapshot([n1, n2])).toEqual(before);
    expect((await admin.query("select to_jsonb(e)::text j from events e where id = $1", [e1])).rows[0].j).toBe(evBefore);
    expect(await countOf("nodes")).toBe(3);
  });

  it("pattern: the mind's own content replaces the summary (edited), and it is embedded when an embedder is set", async () => {
    embedder = FAKE_EMBEDDER;
    const n1 = await mkNode("alpha", "a");
    const n2 = await mkNode("alpha", "b");
    const n3 = await mkNode("alpha", "c");
    const id = await seedNoticing({ kind: "pattern", sources: [n1, n2, n3] });
    const r = await N(alpha, { operation: "accept", noticing_id: id, content: "it is the weather itself I keep returning to" });
    expect(r.ok).toBe(true);
    const node = (await admin.query("select content, embedding is not null as emb, embedding_model from nodes where id = $1", [r.receipt.projection.node_id])).rows[0];
    expect(node).toEqual({ content: "it is the weather itself I keep returning to", emb: true, embedding_model: "fake" });
    expect((await admin.query("select payload from events where kind = 'notice.accepted'")).rows[0].payload.edited).toBe(true);
  });

  it("distillation: a distill event with the content, a distillation node, derived_from edges from the node to each source, metadata, sources untouched", async () => {
    const n1 = await mkNode("alpha", "the first thing");
    const e1 = await mkEvent("alpha", { content: "the second thing" });
    const id = await seedNoticing({ kind: "distillation", sources: [n1, e1] });
    const before = await snapshot([n1]);

    const r = await N(alpha, { operation: "accept", noticing_id: id });
    expect(r.ok).toBe(true);
    const nodeId = r.receipt.projection.node_id;
    const node = (await admin.query("select * from nodes where id = $1", [nodeId])).rows[0];
    expect(node).toMatchObject({ node_type: "distillation", content: "rain matters to me", pinned: false, written_by: "alpha" });
    const distill = (await admin.query("select * from events where kind = 'distill'")).rows;
    expect(distill).toHaveLength(1);
    expect(node.metadata).toEqual({ noticing_id: id, sources: [n1, e1], event_id: distill[0].id });
    const edges = (await admin.query("select * from edges")).rows;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ edge_type: "derived_from", source_node_id: nodeId, target_node_id: n1, written_by: "alpha", metadata: { noticing_id: id, event_id: distill[0].id } });
    expect(distill[0].payload).toEqual({ content: "rain matters to me", sources: [n1, e1], noticing_id: id });
    expect(distill[0].written_by).toBe("alpha");
    const acc = (await admin.query("select * from events where kind = 'notice.accepted'")).rows;
    expect(acc).toHaveLength(1);
    expect(acc[0].payload).toEqual({ noticing_id: id, kind: "distillation", sources: [n1, e1], node_id: nodeId, content_event_id: distill[0].id, edited: false });
    expect((await admin.query("select status from noticings where id = $1", [id])).rows[0].status).toBe("accepted");
    expect(await snapshot([n1])).toEqual(before);
    expect((await admin.query("select invalidated_at, superseded_by from nodes where id = $1", [n1])).rows[0]).toEqual({ invalidated_at: null, superseded_by: null });
  });

  it("distillation: edited content is used for the event, the node and the vector", async () => {
    embedder = FAKE_EMBEDDER;
    const n1 = await mkNode("alpha", "src");
    const id = await seedNoticing({ kind: "distillation", sources: [n1] });
    const r = await N(alpha, { operation: "accept", noticing_id: id, content: "my own words" });
    expect(r.ok).toBe(true);
    expect((await admin.query("select content, embedding is not null as emb from nodes where id = $1", [r.receipt.projection.node_id])).rows[0]).toEqual({ content: "my own words", emb: true });
    expect((await admin.query("select payload, embedding is not null as emb from events where kind = 'distill'")).rows[0]).toMatchObject({ payload: { content: "my own words" }, emb: true });
  });

  it("edge_type and weight are refused on pattern and distillation; a proposal with nothing to say needs content", async () => {
    const n1 = await mkNode("alpha", "a");
    const id = await seedNoticing({ kind: "distillation", sources: [n1] });
    expectErr(await N(alpha, { operation: "accept", noticing_id: id, edge_type: "related_to" }), "invalid_input", "edge_type");
    expectErr(await N(alpha, { operation: "accept", noticing_id: id, weight: 0.3 }), "invalid_input", "weight");
    const empty = await seedNoticing({ kind: "distillation", sources: [n1], payload: {} });
    expectErr(await N(alpha, { operation: "accept", noticing_id: empty }), "invalid_input", "content");
    expect((await N(alpha, { operation: "accept", noticing_id: empty, content: "said by me" })).ok).toBe(true);
  });

  it("deciding twice is a conflict and writes nothing more; so is rejecting an accepted one and accepting a rejected one", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const id = await seedNoticing({ sources: [a, b] });
    expect((await N(alpha, { operation: "accept", noticing_id: id })).ok).toBe(true);
    const snap = { events: await countOf("events"), edges: await countOf("edges") };
    expectErr(await N(alpha, { operation: "accept", noticing_id: id }), "conflict", "noticing_id");
    expectErr(await N(alpha, { operation: "reject", noticing_id: id }), "conflict", "noticing_id");
    expect({ events: await countOf("events"), edges: await countOf("edges") }).toEqual(snap);

    const id2 = await seedNoticing({ sources: [a, b] });
    expect((await N(alpha, { operation: "reject", noticing_id: id2 })).ok).toBe(true);
    expectErr(await N(alpha, { operation: "accept", noticing_id: id2 }), "conflict", "noticing_id");
    const expired = await seedNoticing({ sources: [a, b], status: "expired" });
    expectErr(await N(alpha, { operation: "accept", noticing_id: expired }), "conflict", "noticing_id");
  });

  it("a shadow-stage noticing is not found, for accept and reject alike, and stays untouched", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const id = await seedNoticing({ sources: [a, b], stage: "shadow" });
    const before = await countOf("events");
    expectErr(await N(alpha, { operation: "accept", noticing_id: id }), "not_found", "noticing_id");
    expectErr(await N(alpha, { operation: "reject", noticing_id: id }), "not_found", "noticing_id");
    expect(await countOf("events")).toBe(before);
    expect((await admin.query("select status from noticings where id = $1", [id])).rows[0].status).toBe("pending");
  });
});

describe("reject", () => {
  it("records the reason, writes notice.rejected with the noticing as subject, changes nothing but the noticing", async () => {
    await setState("alpha", "propose");
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const id = await seedNoticing({ sources: [a, b] });
    const before = await snapshot([a, b]);
    const nodes = await countOf("nodes");
    const r = await N(alpha, { operation: "reject", noticing_id: id, reason: "these are not related" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toEqual({ noticing_id: id, status: "rejected" });
    const ev = (await admin.query("select * from events where kind = 'notice.rejected'")).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ subject_id: id, written_by: "alpha", payload: { noticing_id: id, kind: "link", reason: "these are not related" } });
    expect((await admin.query("select status, decided_event_id from noticings where id = $1", [id])).rows[0]).toEqual({ status: "rejected", decided_event_id: ev[0].id });
    expect(await countOf("edges")).toBe(0);
    expect(await countOf("nodes")).toBe(nodes);
    expect(await snapshot([a, b])).toEqual(before);
    // without a reason the payload says null
    const id2 = await seedNoticing({ sources: [a, b] });
    await N(alpha, { operation: "reject", noticing_id: id2 });
    expect((await admin.query("select payload from events where subject_id = $1 and kind = 'notice.rejected'", [id2])).rows[0].payload.reason).toBeNull();
    // and it leaves the list
    expect((await N(alpha, { operation: "list" })).receipt.projection.noticings).toEqual([]);
  });
});

describe("notice.expire", () => {
  const expire = (at: Date) =>
    runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => at }, { trigger: "manual", minds: ["alpha"] }).then(
      (r) => r[0]!.passes.find((p) => p.pass === "notice.expire")!,
    );

  it("is the eleventh deterministic pass, followed by notice.repair as the twelfth", () => {
    expect(PASSES).toHaveLength(12);
    expect(PASSES[10]!.name).toBe("notice.expire");
    expect(PASSES[11]!.name).toBe("notice.repair");
  });

  it("expires due pending rows of either stage, writes a notice.expired event each, and touches nothing else", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const past = new Date(T0.getTime() - 1000);
    const dueP = await seedNoticing({ sources: [a, b], expires_at: past });
    const dueS = await seedNoticing({ sources: [a, b], expires_at: past, stage: "shadow" });
    const exactly = await seedNoticing({ sources: [a, b], expires_at: T0 });
    const future = await seedNoticing({ sources: [a, b], expires_at: new Date(T0.getTime() + DAY) });
    const decided = await seedNoticing({ sources: [a, b], expires_at: past, status: "rejected" });
    const before = await snapshot([a, b]);
    const nodes = await countOf("nodes");
    const edges = await countOf("edges");

    const r = await expire(T0);
    expect(r).toMatchObject({ ok: true, changed: 3 });
    const status = async (id: string) => (await admin.query("select status, decided_event_id, decided_at from noticings where id = $1", [id])).rows[0];
    for (const id of [dueP, dueS, exactly]) {
      const row = await status(id);
      expect(row.status).toBe("expired");
      expect(row.decided_at).toBeInstanceOf(Date);
    }
    expect((await status(future)).status).toBe("pending");
    expect((await status(decided)).status).toBe("rejected");
    const evs = (await admin.query("select * from events where kind = 'notice.expired' order by seq")).rows;
    expect(evs.map((e) => e.subject_id).sort()).toEqual([dueP, dueS, exactly].sort());
    expect(evs.every((e) => e.written_by === "alpha" && e.mind_id === "alpha")).toBe(true);
    expect((await status(dueP)).decided_event_id).toBe(evs.find((e) => e.subject_id === dueP).id);
    expect(await snapshot([a, b])).toEqual(before);
    expect(await countOf("nodes")).toBe(nodes);
    expect(await countOf("edges")).toBe(edges);
    // idempotent
    expect((await expire(new Date(T0.getTime() + 1000))).changed).toBe(0);
    // the later pass catches the future one
    expect((await expire(new Date(T0.getTime() + 2 * DAY))).changed).toBe(1);
    expect((await status(future)).status).toBe("expired");
    // an expired one can no longer be accepted
    expectErr(await N(alpha, { operation: "accept", noticing_id: dueP }), "conflict");
  });

  it("is per mind: beta's due noticing is not expired by alpha's run", async () => {
    const b1 = await mkNode("beta", "b1");
    const b2 = await mkNode("beta", "b2");
    const id = await seedNoticing({ sources: [b1, b2], expires_at: new Date(T0.getTime() - 1000) }, "beta");
    await expire(T0);
    expect((await admin.query("select status from noticings where id = $1", [id])).rows[0].status).toBe("pending");
  });
});

describe("the database guards decisions (noticings_decision_guard)", () => {
  let a: string;
  let b: string;
  let id: string;
  beforeEach(async () => {
    a = await mkNode("alpha", "one");
    b = await mkNode("alpha", "two");
    id = await seedNoticing({ sources: [a, b] });
  });
  const decideSql = "update noticings set status = $2, decided_event_id = $3, decided_at = now() where id = $1";
  const decide = (actor: string, bearer: string, status: string, eventId: string | null) => inTx(pool, "alpha", bearer, actor, decideSql, [id, status, eventId]);
  const evFor = (status: string, subject: string = id) => mkEvent("alpha", {}, `notice.${status}`, subject);
  const statusOf = async () => (await admin.query("select status from noticings where id = $1", [id])).rows[0].status;
  const MIND = /only the mind decides what it notices/;
  const DAEMON = /only the mind's own daemon expires a noticing/;

  it("refuses a steward or write grantee (any bearer but the mind), whatever the actor, even by direct SQL", async () => {
    for (const status of ["accepted", "rejected"]) {
      const e = await evFor(status);
      for (const actor of ["verb", "daemon", "operator", "import", ""]) await expect(decide(actor, "beta", status, e)).rejects.toThrow(MIND);
    }
    const e = await evFor("expired");
    for (const actor of ["verb", "daemon", "operator", "import", ""]) await expect(decide(actor, "beta", "expired", e)).rejects.toThrow(DAEMON);
    expect(await statusOf()).toBe("pending");
  });

  it("accepting and rejecting need a verb-marked transaction as the mind: a daemon-, import-, operator- or unmarked one is refused", async () => {
    for (const status of ["accepted", "rejected"]) {
      const e = await evFor(status);
      for (const actor of ["daemon", "import", "operator", ""]) await expect(decide(actor, "alpha", status, e)).rejects.toThrow(MIND);
    }
    await expect(admin.query(decideSql, [id, "accepted", await evFor("accepted")])).rejects.toThrow(MIND); // bare admin connection
    expect(await statusOf()).toBe("pending");
    await decide("verb", "alpha", "rejected", await evFor("rejected"));
    expect(await statusOf()).toBe("rejected");
  });

  it("a verb-marked transaction as the mind can accept", async () => {
    await decide("verb", "alpha", "accepted", await evFor("accepted"));
    expect(await statusOf()).toBe("accepted");
  });

  it("expiring needs a daemon- or import-marked transaction as the mind: a verb-marked, operator-marked, unmarked or admin one is refused", async () => {
    const e = await evFor("expired");
    for (const actor of ["verb", "operator", ""]) await expect(decide(actor, "alpha", "expired", e)).rejects.toThrow(DAEMON);
    await expect(admin.query(decideSql, [id, "expired", e])).rejects.toThrow(DAEMON); // the old admin allowance is gone
    expect(await statusOf()).toBe("pending");
    await decide("daemon", "alpha", "expired", e);
    expect(await statusOf()).toBe("expired");
  });

  it("an import-marked transaction can expire too", async () => {
    await decide("import", "alpha", "expired", await evFor("expired"));
    expect(await statusOf()).toBe("expired");
  });

  it("a decision must reference its own notice.* event: present, of this mind, about this noticing, of the matching kind", async () => {
    const MSG = /a decision must reference its own notice\.\* event/;
    await expect(decide("verb", "alpha", "accepted", null)).rejects.toThrow(MSG);
    await expect(decide("verb", "alpha", "accepted", await evFor("rejected"))).rejects.toThrow(MSG); // wrong kind
    await expect(decide("verb", "alpha", "rejected", await evFor("accepted"))).rejects.toThrow(MSG);
    await expect(decide("daemon", "alpha", "expired", await evFor("accepted"))).rejects.toThrow(MSG);
    const other = await seedNoticing({ sources: [a, b] });
    await expect(decide("verb", "alpha", "accepted", await evFor("accepted", other))).rejects.toThrow(MSG); // another noticing's event
    await expect(decide("verb", "alpha", "accepted", await mkEvent("alpha", {}, "notice.accepted", null))).rejects.toThrow(MSG); // no subject
    await expect(decide("verb", "alpha", "accepted", await mkEvent("alpha", {}, "observe", id))).rejects.toThrow(MSG); // not a notice.* kind
    const betaEv = await mkEvent("beta", {}, "notice.accepted", id);
    await expect(decide("verb", "alpha", "accepted", betaEv)).rejects.toThrow(/./); // another mind's event is not even visible
    expect(await statusOf()).toBe("pending");
    await decide("verb", "alpha", "accepted", await evFor("accepted"));
    expect(await statusOf()).toBe("accepted");
  });

  it("refuses any change to payload or sources, by anyone including the mind and admin", async () => {
    const msg = /payload and sources are fixed/;
    const asMind = (sql: string, params: unknown[] = []) => inTx(pool, "alpha", "alpha", "verb", sql, params);
    await expect(asMind(`update noticings set payload = '{"x":1}'::jsonb where id = $1`, [id])).rejects.toThrow(msg);
    await expect(asMind("update noticings set sources = $2::uuid[] where id = $1", [id, [a]])).rejects.toThrow(msg);
    await expect(asMind(`update noticings set payload = '{"x":1}'::jsonb, status = 'accepted' where id = $1`, [id])).rejects.toThrow(msg);
    await expect(admin.query(`update noticings set payload = '{}'::jsonb where id = $1`, [id])).rejects.toThrow(msg);
    await expect(admin.query("update noticings set sources = '{}' where id = $1", [id])).rejects.toThrow(msg);
  });

  it("every other column is fixed once made too: kind, stage, mind_id, proposed_event_id, created_at, features, model_version, score, expires_at, id", async () => {
    const other = await mkEvent("alpha", {}, "notice.proposed");
    const changes: Array<[string, string, unknown]> = [
      ["kind", "kind = $2", "pattern"],
      ["stage", "stage = $2", "shadow"],
      ["mind_id", "mind_id = $2", "beta"],
      ["proposed_event_id", "proposed_event_id = $2", other],
      ["created_at", "created_at = $2", new Date(0)],
      ["features", "features = $2::jsonb", '{"a":1}'],
      ["model_version", "model_version = $2", 3],
      ["score", "score = $2", 0.99],
      ["expires_at", "expires_at = $2", new Date(0)],
      ["id", "id = $2", "00000000-0000-4000-8000-000000000001"],
    ];
    for (const [col, set, val] of changes) {
      for (const run of [
        () => inTx(pool, "alpha", "alpha", "verb", `update noticings set ${set} where id = $1`, [id, val]),
        () => admin.query(`update noticings set ${set} where id = $1`, [id, val]),
      ]) await expect(run(), col).rejects.toThrow(/a proposal is fixed once made/);
    }
    // an update that rewrites the same values changes nothing and is allowed
    await inTx(pool, "alpha", "alpha", "verb", "update noticings set payload = payload, sources = sources, score = score where id = $1", [id]);
  });

  it("a decided noticing is final: no second decision, no return to pending", async () => {
    await decide("daemon", "alpha", "expired", await evFor("expired"));
    await expect(decide("verb", "alpha", "accepted", await evFor("accepted"))).rejects.toThrow(/final/);
    await expect(decide("daemon", "alpha", "pending", null)).rejects.toThrow(/final/);
    await expect(admin.query("update noticings set status = 'pending' where id = $1", [id])).rejects.toThrow(/final/);
  });

  it("decided_event_id and decided_at are set only together with a status change", async () => {
    const e = await evFor("accepted");
    const asMind = (sql: string, params: unknown[] = []) => inTx(pool, "alpha", "alpha", "verb", sql, params);
    await expect(asMind("update noticings set decided_event_id = $2 where id = $1", [id, e])).rejects.toThrow(/only together with the status/);
    await expect(asMind("update noticings set decided_at = now() where id = $1", [id])).rejects.toThrow(/only together with the status/);
    await expect(admin.query("update noticings set decided_at = now() where id = $1", [id])).rejects.toThrow(/only together with the status/);
  });
});

describe("noticings are proposed in the mind's own scope (noticings_insert_guard)", () => {
  const ins = (bearer: string, status = "pending", decided: string | null = null, mind = "alpha", scope = "alpha") =>
    mkEvent("alpha", {}, "notice.proposed").then((ev) =>
      queryAs(pool, scope, bearer, `insert into noticings (mind_id, kind, sources, payload, score, stage, status, proposed_event_id, decided_event_id, expires_at)
        values ($1, 'link', '{}', '{}', 0.5, 'propose', $2, $3, $4, now() + interval '1 day') returning id`, [mind, status, ev, decided]));

  it("refuses a write grantee, a steward and any other bearer inserting a pending proposal; the mind's own scope succeeds", async () => {
    for (const bearer of ["beta"]) {
      // beta holding write/steward grants on alpha still acts with bearer beta in alpha's scope
      await expect(ins(bearer)).rejects.toThrow(/noticings are proposed in the mind's own scope/);
    }
    // a grantee cannot write into its own scope on behalf of alpha either
    await expect(ins("beta", "pending", null, "alpha", "beta")).rejects.toThrow(/own scope|row-level security/);
    expect(await countOf("noticings")).toBe(0);
    expect((await ins("alpha")).rows).toHaveLength(1);
    // a bare connection with no scope is refused too
    await expect(admin.query(`insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at)
      values ('alpha', 'link', '{}', '{}', 0, 'propose', (select id from events limit 1), now())`)).rejects.toThrow(/own scope/);
  });

  it("a non-pending row may be inserted only as expired history or with its decision event", async () => {
    await expect(ins("alpha", "accepted")).rejects.toThrow(/carries its decision event/);
    await expect(ins("alpha", "rejected")).rejects.toThrow(/carries its decision event/);
    expect((await ins("alpha", "expired")).rows).toHaveLength(1);
    const ev = await mkEvent("alpha", {}, "notice.accepted");
    expect((await ins("alpha", "accepted", ev)).rows).toHaveLength(1);
  });
});

describe("the schema admits exactly two stages and the documented values", () => {
  const mkRow = async (over: string) => {
    const a = await mkNode("alpha", "x");
    const ev = await mkEvent("alpha", {});
    return queryAs(
      pool, "alpha", "alpha",
      `insert into noticings (mind_id, kind, sources, payload, score, stage, status, proposed_event_id, expires_at)
       values ('alpha', ${over.replace("$a", `'${a}'`)}, '{}'::jsonb, 0.1, 'propose', 'pending', '${ev}', now())`,
    );
  };

  it("rejects a third stage on noticings and on extractor_state", async () => {
    const ev = await mkEvent("alpha", {});
    await expect(
      queryAs(pool, "alpha", "alpha", `insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at)
                   values ('alpha', 'link', '{}', '{}', 0, 'auto', $1, now())`, [ev]),
    ).rejects.toThrow(/noticings_stage_check/);
    await expect(admin.query("insert into extractor_state (mind_id, stage) values ('alpha', 'apply')")).rejects.toThrow(/extractor_state_stage_check/);
    await admin.query("insert into extractor_state (mind_id, stage) values ('alpha', 'propose')");
    await expect(admin.query("update extractor_state set stage = 'auto' where mind_id = 'alpha'")).rejects.toThrow(/extractor_state_stage_check/);
  });

  it("rejects an unknown kind or status and a malformed schedule", async () => {
    await expect(mkRow("'dream', '{}'::uuid[]")).rejects.toThrow(/noticings_kind_check/);
    const ev = await mkEvent("alpha", {});
    await expect(
      queryAs(pool, "alpha", "alpha", `insert into noticings (mind_id, kind, sources, payload, score, stage, status, proposed_event_id, decided_event_id, expires_at)
                   values ('alpha', 'link', '{}', '{}', 0, 'propose', 'applied', $1, $1, now())`, [ev]),
    ).rejects.toThrow(/noticings_status_check/);
    await expect(admin.query("insert into extractor_state (mind_id, schedule) values ('alpha', '25:00')")).rejects.toThrow(/extractor_state_schedule_check/);
  });

  it("nodes.node_type is free text, so pattern and distillation need no schema change", async () => {
    await mkNode("alpha", "p", "pattern");
    await mkNode("alpha", "d", "distillation");
    expect(await countOf("nodes", "node_type in ('pattern', 'distillation')")).toBe(2);
  });
});

describe("mind_orient and mind_health", () => {
  const orient = (depth: string, caller = alpha) => run(caller, "mind_orient", { mind_id: "alpha", depth });

  it("orient carries the top 5 pending propose noticings (quick and full), an empty array when off or at shadow, and none for a bare orientation", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await seedNoticing({ sources: [a, b], score: i / 10 }));
    await seedNoticing({ sources: [a, b], score: 0.99, stage: "shadow" });

    expect((await orient("quick")).receipt.projection.sections.noticings).toEqual([]); // off
    await setState("alpha", "shadow");
    expect((await orient("full")).receipt.projection.sections.noticings).toEqual([]);
    await setState("alpha", "propose");
    const quick = (await orient("quick")).receipt.projection.sections.noticings;
    expect(quick.map((n: any) => n.id)).toEqual([ids[6], ids[5], ids[4], ids[3], ids[2]]);
    expect(quick[0].sources.map((s: any) => s.type)).toEqual(["node", "node"]);
    expect((await orient("full")).receipt.projection.sections.noticings).toHaveLength(5);
    expect((await orient("orientation")).receipt.projection.sections).not.toHaveProperty("noticings");
    // a read grantee sees the same
    expect((await orient("quick", betaRead)).receipt.projection.sections.noticings).toHaveLength(5);
  });

  it("health reports {enabled, stage, paused, pending, model_version, repairs_pending, last_run} with zero defaults", async () => {
    const health = async (caller = alpha) => (await run(caller, "mind_health", { mind_id: "alpha" })).receipt.projection.extractor;
    expect(await health()).toEqual({ enabled: false, stage: "off", paused: false, pending: 0, model_version: 0, repairs_pending: 0, last_run: null });
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    await seedNoticing({ sources: [a, b] });
    await seedNoticing({ sources: [a, b] });
    await seedNoticing({ sources: [a, b], stage: "shadow" });
    await seedNoticing({ sources: [a, b], status: "rejected" });
    await setState("alpha", "propose", { paused: true });
    await admin.query("insert into extractor_models (mind_id, version, weights) values ('alpha', 1, '{}'), ('alpha', 2, '{}'), ('beta', 9, '{}')");
    expect(await health()).toEqual({ enabled: true, stage: "propose", paused: true, pending: 2, model_version: 2, repairs_pending: 0, last_run: null });
    expect(await health(betaRead)).toEqual({ enabled: true, stage: "propose", paused: true, pending: 2, model_version: 2, repairs_pending: 0, last_run: null });
    // the orient health section carries it too
    expect((await run(alpha, "mind_orient", { mind_id: "alpha", depth: "orientation" })).receipt.projection.sections.health.extractor.model_version).toBe(2);
  });
});

describe("the extractor CLI (src/extractor-admin.ts)", () => {
  const state = async (mind = "alpha") => (await admin.query("select * from extractor_state where mind_id = $1", [mind])).rows[0];
  const evs = async (mind = "alpha") => (await admin.query("select * from events where kind like 'daemon.extractor.%' and mind_id = $1 order by seq", [mind])).rows;

  describe("parser", () => {
    it("parses every subcommand and applies no defaults of its own", () => {
      expect(parseExtractorArgs(["enable", "--mind", "alpha"])).toEqual({ action: "enable", mind: "alpha", json: false });
      expect(parseExtractorArgs(["enable", "--mind", "alpha", "--stage", "propose", "--schedule", "04:30", "--json"])).toEqual({
        action: "enable", mind: "alpha", stage: "propose", schedule: "04:30", json: true,
      });
      for (const a of ["disable", "pause", "resume", "report"]) expect(parseExtractorArgs([a, "--mind", "alpha"]).action).toBe(a);
      expect(parseExtractorArgs(["stage", "--mind", "alpha", "--stage", "shadow"]).stage).toBe("shadow");
    });

    it("rejects anything but shadow or propose as a stage, at the parser", () => {
      for (const bad of ["auto", "apply", "off", "Propose", "", "shadow,propose"]) {
        expect(() => parseExtractorArgs(["stage", "--mind", "alpha", "--stage", bad])).toThrow(ArgError);
        expect(() => parseExtractorArgs(["enable", "--mind", "alpha", "--stage", bad])).toThrow(/invalid stage/);
      }
    });

    it("rejects missing or misplaced arguments", () => {
      expect(() => parseExtractorArgs([])).toThrow(/needs a subcommand/);
      expect(() => parseExtractorArgs(["start", "--mind", "alpha"])).toThrow(/needs a subcommand/);
      expect(() => parseExtractorArgs(["enable"])).toThrow(/--mind/);
      expect(() => parseExtractorArgs(["enable", "--mind", "bad id"])).toThrow(ArgError);
      expect(() => parseExtractorArgs(["stage", "--mind", "alpha"])).toThrow(/--stage/);
      expect(() => parseExtractorArgs(["pause", "--mind", "alpha", "--stage", "shadow"])).toThrow(/does not take --stage/);
      expect(() => parseExtractorArgs(["stage", "--mind", "alpha", "--stage", "shadow", "--schedule", "03:00"])).toThrow(/does not take --schedule/);
      expect(() => parseExtractorArgs(["enable", "--mind", "alpha", "--schedule", "3am"])).toThrow(/invalid schedule/);
      expect(() => parseExtractorArgs(["enable", "--mind", "alpha", "--schedule", "24:00"])).toThrow(/invalid schedule/);
      expect(() => parseExtractorArgs(["enable", "--mind", "alpha", "extra"])).toThrow(/unexpected argument/);
      expect(() => parseExtractorArgs(["enable", "--mind", "alpha", "--bogus"])).toThrow(ArgError);
    });
  });

  it("enable defaults to shadow at 03:00, writes daemon.extractor.enable as the mind with the new state, and is a no-op the second time", async () => {
    const r = await setExtractorState(admin, "alpha", "enable");
    expect(r).toMatchObject({ mind: "alpha", action: "enable", changed: true, state: { enabled: true, stage: "shadow", schedule: "03:00", paused: false } });
    expect(await state()).toMatchObject({ enabled: true, stage: "shadow", schedule: "03:00", paused_at: null, updated_event_id: r.event_id });
    const e = await evs();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "daemon.extractor.enable", written_by: "alpha", mind_id: "alpha", id: r.event_id });
    expect(e[0].payload).toMatchObject({ action: "enable", enabled: true, stage: "shadow", schedule: "03:00", paused: false, previous: null });
    const again = await setExtractorState(admin, "alpha", "enable");
    expect(again).toMatchObject({ changed: false, event_id: null });
    expect(await evs()).toHaveLength(1);
    // beta is untouched
    expect(await state("beta")).toBeUndefined();
  });

  it("enable with flags sets stage and schedule; a bare re-enable keeps them and clears a pause", async () => {
    await setExtractorState(admin, "alpha", "enable", { stage: "propose", schedule: "04:30" });
    expect(await state()).toMatchObject({ enabled: true, stage: "propose", schedule: "04:30" });
    await setExtractorState(admin, "alpha", "pause");
    await setExtractorState(admin, "alpha", "disable");
    const r = await setExtractorState(admin, "alpha", "enable");
    expect(r.state).toEqual({ enabled: true, stage: "propose", schedule: "04:30", paused: false });
    expect((await state()).paused_at).toBeNull();
  });

  it("disable, pause, resume and stage change the row, write one event each with the new state and the previous one, and are no-ops when nothing would change", async () => {
    expect(await setExtractorState(admin, "alpha", "disable")).toMatchObject({ changed: false }); // never enabled
    await expect(setExtractorState(admin, "alpha", "pause")).rejects.toThrow(/never enabled/);
    await expect(setExtractorState(admin, "alpha", "stage", { stage: "propose" })).rejects.toThrow(/never enabled/);
    expect(await evs()).toHaveLength(0);

    await setExtractorState(admin, "alpha", "enable");
    const p = await setExtractorState(admin, "alpha", "pause");
    expect(p).toMatchObject({ changed: true, state: { enabled: true, paused: true } });
    expect((await state()).paused_at).toBeInstanceOf(Date);
    expect((await setExtractorState(admin, "alpha", "pause")).changed).toBe(false);
    const r = await setExtractorState(admin, "alpha", "resume");
    expect(r.state.paused).toBe(false);
    expect((await state()).paused_at).toBeNull();
    expect((await setExtractorState(admin, "alpha", "resume")).changed).toBe(false);
    const s = await setExtractorState(admin, "alpha", "stage", { stage: "propose" });
    expect(s).toMatchObject({ changed: true, state: { stage: "propose" } });
    expect((await state()).stage).toBe("propose");
    expect((await setExtractorState(admin, "alpha", "stage", { stage: "propose" })).changed).toBe(false);
    const d = await setExtractorState(admin, "alpha", "disable");
    expect(d.state.enabled).toBe(false);
    expect((await state()).enabled).toBe(false);

    const e = await evs();
    expect(e.map((x) => x.kind)).toEqual([
      "daemon.extractor.enable", "daemon.extractor.pause", "daemon.extractor.resume", "daemon.extractor.stage", "daemon.extractor.disable",
    ]);
    expect(e.every((x) => x.written_by === "alpha")).toBe(true);
    expect(e[3].payload).toMatchObject({ action: "stage", stage: "propose", previous: { stage: "shadow" } });
    expect(e[4].payload).toMatchObject({ action: "disable", enabled: false });
    // the mind sees the switch through its own verbs
    expect((await run(alpha, "mind_health", { mind_id: "alpha" })).receipt.projection.extractor).toMatchObject({ enabled: false, stage: "propose" });
  });

  it("the module refuses a bad stage or schedule, and the database refuses it too when the parser is bypassed", async () => {
    await expect(setExtractorState(admin, "alpha", "enable", { stage: "auto" })).rejects.toThrow(/invalid stage/);
    await expect(setExtractorState(admin, "alpha", "enable", { schedule: "99:99" })).rejects.toThrow(/invalid schedule/);
    expect(await state()).toBeUndefined();
    await setExtractorState(admin, "alpha", "enable");
    await expect(admin.query("update extractor_state set stage = 'auto' where mind_id = 'alpha'")).rejects.toThrow(/extractor_state_stage_check/);
    expect((await state()).stage).toBe("shadow");
  });

  it("refuses an unknown or suspended mind and writes nothing", async () => {
    await expect(setExtractorState(admin, "nobody", "enable")).rejects.toThrow(/unknown mind/);
    await admin.query("update minds set disabled_at = now() where mind_id = 'beta'");
    await expect(setExtractorState(admin, "beta", "enable")).rejects.toThrow(/suspended/);
    expect(await countOf("extractor_state")).toBe(0);
  });

  it("report counts by status and kind (all time and 30 days), precision over what the mind was shown, and the model version", async () => {
    const empty = await extractorReport(admin, "alpha");
    expect(empty).toMatchObject({ state: { enabled: false, stage: "off" }, model_version: 0, all_time: { total: 0 }, precision: { value: null, decided: 0 } });
    expect(formatExtractorReport(empty)).toMatch(/n\/a \(nothing decided yet\)/);

    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const old = new Date(T0.getTime() - 60 * DAY);
    await seedNoticing({ sources: [a, b], status: "accepted" });
    await seedNoticing({ kind: "pattern", sources: [a, b, a], status: "rejected" });
    await seedNoticing({ kind: "pattern", sources: [a, b, a], status: "expired", created_at: old });
    await seedNoticing({ kind: "distillation", sources: [a], status: "expired", created_at: old });
    await seedNoticing({ sources: [a, b] }); // pending
    await seedNoticing({ sources: [a, b], stage: "shadow", status: "expired" }); // shadow: counted, not scored
    await seedNoticing({ sources: [a, b], stage: "shadow" });
    await admin.query("insert into extractor_models (mind_id, version, weights) values ('alpha', 4, '{}')");
    await setExtractorState(admin, "alpha", "enable", { stage: "propose" });

    const rep = await extractorReport(admin, "alpha", () => T0);
    expect(rep.model_version).toBe(4);
    expect(rep.state).toEqual({ enabled: true, stage: "propose", schedule: "03:00", paused: false });
    expect(rep.all_time).toEqual({
      total: 7,
      by_status: { accepted: 1, rejected: 1, expired: 3, pending: 2 },
      by_kind: { link: 4, pattern: 2, distillation: 1 },
      by_stage: { propose: 5, shadow: 2 },
    });
    expect(rep.last_30_days).toEqual({
      total: 5,
      by_status: { accepted: 1, rejected: 1, expired: 1, pending: 2 },
      by_kind: { link: 4, pattern: 1 },
      by_stage: { propose: 3, shadow: 2 },
    });
    // accepted 1 of decided (1 accepted + 1 rejected + 2 expired, shadow excluded) = 0.25; last 30 days 1 of 2
    expect(rep.precision).toEqual({ value: 0.25, accepted: 1, decided: 4, last_30_days: 1 / 2 });
    const text = formatExtractorReport(rep);
    expect(text).toMatch(/model version 4/);
    expect(text).toMatch(/25\.0%/);
    expect(text).toMatch(/all time:\s+7 total/);

    const viaCommand = await runExtractorCommand(admin, { action: "report", mind: "alpha", json: true });
    expect(JSON.parse(viaCommand).precision.accepted).toBe(1);
    expect(await runExtractorCommand(admin, { action: "pause", mind: "alpha", json: false })).toMatch(/extractor pause for alpha: now enabled, stage propose, schedule 03:00, paused/);
    expect(await runExtractorCommand(admin, { action: "pause", mind: "alpha", json: false })).toMatch(/nothing changed/);
  });
});

describe("the mind's own verb call, a live proposal and the operator's stage (accept)", () => {
  it("accept and reject refuse a context that is not a verb call, even as the mind", async () => {
    await setState("alpha", "propose");
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const id = await seedNoticing({ sources: [a, b] });
    for (const actor of ["daemon", "import", undefined] as const) {
      for (const operation of ["accept", "reject"]) {
        const r = await withMind(pool, "alpha", "alpha", "write", async (tx) =>
          mind_notice.handler(
            { caller: alpha, mind_id: "alpha", tx, now: () => clock, registry, embedder: NONE_EMBEDDER, sinks: [], coolingMs: 0, ...(actor ? { actor } : {}) } as VerbContext,
            mind_notice.schema.parse({ mind_id: "alpha", operation, noticing_id: id }),
          ),
          actor,
        );
        expectErr(r, "forbidden");
        expect((r as any).error.message).toBe(MSG);
      }
    }
    expect(await countOf("edges")).toBe(0);
    expect((await admin.query("select status from noticings where id = $1", [id])).rows[0].status).toBe("pending");
  });

  it("list shows only proposals that have not expired; accept of an expired one is a conflict and writes nothing, reject still works", async () => {
    await setState("alpha", "propose");
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const live = await seedNoticing({ sources: [a, b], expires_at: new Date(T0.getTime() + 1) });
    const lapsed = await seedNoticing({ sources: [a, b], expires_at: T0, score: 0.99 }); // expires_at <= now
    expect((await N(alpha, { operation: "list" })).receipt.projection.noticings.map((x: any) => x.id)).toEqual([live]);
    const before = await countOf("events");
    expectErr(await N(alpha, { operation: "accept", noticing_id: lapsed }), "conflict", "noticing_id");
    expect((await N(alpha, { operation: "accept", noticing_id: lapsed })).error.message).toBe("noticing has expired");
    expect(await countOf("events")).toBe(before);
    expect(await countOf("edges")).toBe(0);
    expect((await admin.query("select status from noticings where id = $1", [lapsed])).rows[0].status).toBe("pending");
    // the expire pass will record it
    clock = new Date(T0.getTime() + 1000);
    const r = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => clock }, { trigger: "manual", minds: ["alpha"] });
    expect(r[0]!.passes.find((p) => p.pass === "notice.expire")!.changed).toBe(2);
    expect((await admin.query("select status from noticings where id = $1", [lapsed])).rows[0].status).toBe("expired");
  });

  it("accept needs the operator's stage to be propose at that moment (no row, or shadow: conflict); reject does not", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    const id = await seedNoticing({ sources: [a, b] });
    expectErr(await N(alpha, { operation: "accept", noticing_id: id }), "conflict", "noticing_id"); // no state row
    await setState("alpha", "shadow");
    const r = await N(alpha, { operation: "accept", noticing_id: id });
    expectErr(r, "conflict", "noticing_id");
    expect(r.error.message).toMatch(/not at stage propose/);
    expect(await countOf("edges")).toBe(0);
    await setState("alpha", "propose");
    expect((await N(alpha, { operation: "accept", noticing_id: id })).ok).toBe(true);
    const id2 = await seedNoticing({ sources: [a, b] });
    await setState("alpha", "shadow");
    expect((await N(alpha, { operation: "reject", noticing_id: id2 })).ok).toBe(true);
  });

  it("health counts pending only while the stage is propose, and not past expiry", async () => {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    await seedNoticing({ sources: [a, b] });
    await seedNoticing({ sources: [a, b], expires_at: T0 });
    const pending = async () => (await run(alpha, "mind_health", { mind_id: "alpha" })).receipt.projection.extractor.pending;
    await setState("alpha", "shadow");
    expect(await pending()).toBe(0);
    await setState("alpha", "propose");
    expect(await pending()).toBe(1);
  });
});

describe("link sources and provenance edges", () => {
  beforeEach(async () => {
    await setState("alpha", "propose");
  });

  it("a link naming the same node twice is invalid_input on noticing_id, naming the duplicate; nothing is written", async () => {
    const a = await mkNode("alpha", "one");
    const id = await seedNoticing({ sources: [a, a] });
    const before = await countOf("events");
    const r = await N(alpha, { operation: "accept", noticing_id: id });
    expectErr(r, "invalid_input", "noticing_id");
    expect(r.error.message).toContain(a);
    expect(r.error.message).toMatch(/same source twice/);
    expect(await countOf("events")).toBe(before);
  });

  it("a source node that was rewritten or retired refuses the accept (conflict, the dead ids named, nothing written); events among the sources are fine", async () => {
    const n1 = await mkNode("alpha", "live one");
    const n2 = await mkNode("alpha", "live two");
    const n3 = await mkNode("alpha", "set aside");
    await queryAs(pool, "alpha", "alpha", "update nodes set invalidated_at = now() where id = $1", [n3]);
    const pat = await seedNoticing({ kind: "pattern", sources: [n1, n2, n3] });
    const dis = await seedNoticing({ kind: "distillation", sources: [n1, n3] });
    const link = await seedNoticing({ sources: [n1, n3] });
    const before = { nodes: (await admin.query("select count(*)::int n from nodes")).rows[0].n, edges: (await admin.query("select count(*)::int n from edges")).rows[0].n, events: (await admin.query("select count(*)::int n from events")).rows[0].n };
    for (const id of [pat, dis, link]) {
      const r = await N(alpha, { operation: "accept", noticing_id: id });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("conflict");
      expect(r.error.field).toBe("noticing_id");
      expect(r.error.message).toContain("a source was rewritten or retired since this was proposed");
      expect(r.error.message).toContain(n3);
      expect(r.error.message).not.toContain(n1);
      expect((await admin.query("select status from noticings where id = $1", [id])).rows[0].status).toBe("pending");
    }
    expect({ nodes: (await admin.query("select count(*)::int n from nodes")).rows[0].n, edges: (await admin.query("select count(*)::int n from edges")).rows[0].n, events: (await admin.query("select count(*)::int n from events")).rows[0].n }).toEqual(before);
    // with every node source live, an event source is still recorded in the metadata and gets no edge
    const ev = (await admin.query("select id from events limit 1")).rows[0].id;
    const ok = await seedNoticing({ kind: "pattern", sources: [n1, n2, ev] });
    const rp = await N(alpha, { operation: "accept", noticing_id: ok });
    expect(rp.ok).toBe(true);
    expect((await admin.query("select source_node_id from edges where target_node_id = $1 order by 1", [rp.receipt.projection.node_id])).rows.map((r) => r.source_node_id).sort()).toEqual([n1, n2].sort());
    expect((await admin.query("select metadata from nodes where id = $1", [rp.receipt.projection.node_id])).rows[0].metadata.sources).toEqual([n1, n2, ev]);
  });

  it("a stale expiry (source_invalidated) is left out of training and out of the report's precision, and shown apart as stale", async () => {
    await setState("alpha", "propose");
    const n1 = await mkNode("alpha", "live one");
    const n2 = await mkNode("alpha", "live two");
    const n3 = await mkNode("alpha", "set aside");
    await queryAs(pool, "alpha", "alpha", "update nodes set invalidated_at = now() where id = $1", [n3]);
    const stale = await seedNoticing({ kind: "distillation", sources: [n1, n3] });
    const rejected = await seedNoticing({ sources: [n1, n2] });
    await queryLegacy(admin, "update noticings set features = '{\"cosine\": 0.5}'::jsonb");
    await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => T0 }, { trigger: "manual", minds: ["alpha"], passes: [noticeExpire] });
    expect((await N(alpha, { operation: "reject", noticing_id: rejected })).ok).toBe(true);
    const rep = await extractorReport(admin, "alpha", () => T0);
    expect(rep.stale).toBe(1);
    expect(rep.precision).toMatchObject({ accepted: 0, decided: 1 }); // the rejection counts, the stale expiry does not
    expect(rep.acceptance_by_kind).toEqual({ link: { accepted: 0, decided: 1, rate: 0 }, distillation: { accepted: 0, decided: 0, rate: null } });
    expect(formatExtractorReport(rep)).toMatch(/stale .*: 1/);
    await setExtractorState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const t = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => T0 }, { trigger: "manual", minds: ["alpha"], passes: [ALL_MODEL_TRAIN] });
    expect(t[0]!.passes[0]!.ok).toBe(true);
    expect((await admin.query("select notes from extractor_runs where pass = 'notice.train' order by started_at desc limit 1")).rows[0].notes).toMatchObject({ trained: false, decided: 1 });
    void stale;
  });

  it("the expiry pass expires a pending proposal that cites a dead node (reason source_invalidated, ids only) and leaves live ones and repairs alone", async () => {
    const n1 = await mkNode("alpha", "live one");
    const n2 = await mkNode("alpha", "live two");
    const n3 = await mkNode("alpha", "set aside");
    await queryAs(pool, "alpha", "alpha", "update nodes set invalidated_at = now() where id = $1", [n3]);
    const stale = await seedNoticing({ kind: "distillation", sources: [n1, n3] });
    const fine = await seedNoticing({ sources: [n1, n2] });
    const reports = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => T0 }, { trigger: "manual", minds: ["alpha"], passes: [noticeExpire] });
    expect(reports[0]!.passes[0]).toMatchObject({ ok: true, changed: 1 });
    const rows = (await admin.query("select id, status, decided_event_id from noticings where id = any($1::uuid[])", [[stale, fine]])).rows;
    expect(rows.find((r) => r.id === stale)).toMatchObject({ status: "expired" });
    expect(rows.find((r) => r.id === fine)).toMatchObject({ status: "pending" });
    const ev = (await admin.query("select payload from events where id = $1", [rows.find((r) => r.id === stale).decided_event_id])).rows[0].payload;
    expect(ev).toMatchObject({ noticing_id: stale, noticing_kind: "distillation", reason: "source_invalidated" });
    expect(JSON.stringify(ev)).not.toContain("set aside");
  });
});

describe("notice.* events carry ids and counts, never text; they are bookkeeping, not memory", () => {
  const MARK = "zebracrossingmarker";
  it("every notice.* event in the ledger parses against its shape and holds none of the memory's words", async () => {
    await setState("alpha", "propose");
    const n1 = await mkNode("alpha", `${MARK} one`);
    const n2 = await mkNode("alpha", `${MARK} two`);
    const n3 = await mkNode("alpha", `${MARK} three`);
    const link = await seedNoticing({ sources: [n1, n2], payload: { edge_type: "related_to", reason: `${MARK} reason` } });
    const pat = await seedNoticing({ kind: "pattern", sources: [n1, n2, n3], payload: { label: `${MARK} label`, summary: `${MARK} summary`, window: {} } });
    const dis = await seedNoticing({ kind: "distillation", sources: [n1], payload: { content: `${MARK} content`, lineage: [] } });
    const rej = await seedNoticing({ sources: [n2, n3], payload: { edge_type: "related_to", reason: `${MARK} r2` } });
    await seedNoticing({ sources: [n1, n3], expires_at: new Date(T0.getTime() - 1000) });
    for (const id of [link, pat, dis]) expect((await N(alpha, { operation: "accept", noticing_id: id })).ok).toBe(true);
    expect((await N(alpha, { operation: "reject", noticing_id: rej, reason: "my own words are allowed here" })).ok).toBe(true);
    await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => T0 }, { trigger: "manual", minds: ["alpha"] });

    const evs = (await admin.query("select kind, payload from events where kind like 'notice.%' and kind <> 'notice.proposed'")).rows;
    expect(evs.map((e) => e.kind).sort()).toEqual(["notice.accepted", "notice.accepted", "notice.accepted", "notice.expired", "notice.rejected"]);
    for (const e of evs) {
      const shape = e.kind === "notice.accepted" ? noticeAcceptedPayload : e.kind === "notice.rejected" ? noticeRejectedPayload : EXTRACTOR_EVENT_SHAPES["notice.expired"];
      expect(shape.safeParse(e.payload).success, `${e.kind} ${JSON.stringify(e.payload)}`).toBe(true);
      expect(JSON.stringify(e.payload)).not.toContain(MARK);
    }
    // and the shapes refuse text
    expect(noticeAcceptedPayload.safeParse({ noticing_id: link, kind: "link", sources: [], content: "words" }).success).toBe(false);
    expect(EXTRACTOR_EVENT_SHAPES["notice.expired"].safeParse({ noticing_id: link, label: "words" }).success).toBe(false);
    expect(EXTRACTOR_EVENT_SHAPES["notice.proposed"].safeParse({ noticing_id: link, noticing_kind: "link", stage: "propose", score: 1, source_count: 2, model_version: 0, summary: "x" }).success).toBe(false);
    expect(EXTRACTOR_EVENT_SHAPES["notice.model.trained"].safeParse({ version: 1, trained_on: 5, metrics: { p5: 0.5 } }).success).toBe(true);
    expect(EXTRACTOR_EVENT_SHAPES["notice.model.trained"].safeParse({ version: 1, trained_on: 5, metrics: { note: "text" } }).success).toBe(false);
  });

  it("orient's recent events, weather's counts and search/surface over events leave them out", async () => {
    clock = new Date(Date.now() + 60_000);
    await mkEvent("alpha", { content: `${MARK} remembered` }, "observe");
    const noisy = await mkEvent("alpha", { content: `${MARK} bookkeeping` }, "notice.accepted", null);
    const orient = await run(alpha, "mind_orient", { mind_id: "alpha", depth: "full" });
    const recent = orient.receipt.projection.sections.recent.events;
    expect(recent.some((e: any) => e.id === noisy)).toBe(false);
    expect(recent.some((e: any) => e.kind === "observe")).toBe(true);
    const weather = (await run(alpha, "mind_weather", { mind_id: "alpha", lookback_hours: 1 })).receipt.projection;
    expect(weather.kinds).toEqual({ observe: 1 });
    expect(weather.event_count).toBe(1);
    const search = await run(alpha, "mind_search", { mind_id: "alpha", query: MARK, scope: "events", mode: "text" });
    expect(search.receipt.projection.hits.map((h: any) => h.id)).not.toContain(noisy);
    expect(search.receipt.projection.hits).toHaveLength(1);
    const surface = await run(alpha, "mind_surface", { mind_id: "alpha", query: MARK });
    const ids = [...surface.receipt.projection.core, ...surface.receipt.projection.novel, ...surface.receipt.projection.edge].map((h: any) => h.id);
    expect(ids).not.toContain(noisy);
  });
});

describe("only the operator enables the extractor (extractor_state_guard) and only on the admin URL", () => {
  it("a row becomes enabled only in an operator-marked transaction: insert or update, admin or app role", async () => {
    const ins = (db: Pool, actor: string, enabled: boolean) =>
      inTx(db, "alpha", "alpha", actor, "insert into extractor_state (mind_id, enabled) values ('alpha', $1)", [enabled]);
    for (const actor of ["", "verb", "daemon", "import"]) {
      await expect(ins(admin, actor, true)).rejects.toThrow(/only the operator enables the extractor/);
      await expect(ins(pool, actor, true)).rejects.toThrow(/only the operator enables the extractor/);
    }
    expect(await countOf("extractor_state")).toBe(0);
    await ins(pool, "import", false); // import brings a disabled row in
    await expect(inTx(admin, "alpha", "alpha", "daemon", "update extractor_state set enabled = true where mind_id = 'alpha'")).rejects.toThrow(/only the operator enables/);
    await expect(admin.query("update extractor_state set enabled = true where mind_id = 'alpha'")).rejects.toThrow(/only the operator enables/);
    await inTx(admin, "alpha", "alpha", "operator", "update extractor_state set enabled = true where mind_id = 'alpha'");
    expect((await admin.query("select enabled from extractor_state")).rows[0].enabled).toBe(true);
    // other updates of an enabled row, and disabling, need no marker
    await admin.query("update extractor_state set stage = 'propose' where mind_id = 'alpha'");
    await admin.query("update extractor_state set enabled = false where mind_id = 'alpha'");
  });

  it("the CLI on the sanctum_app URL says it needs the admin DATABASE_URL and changes nothing; a report still reads", async () => {
    await expect(setExtractorState(pool, "alpha", "enable")).rejects.toThrow(NEEDS_ADMIN);
    await expect(setExtractorState(pool, "alpha", "enable")).rejects.toThrow(/admin DATABASE_URL/);
    await expect(runExtractorCommand(pool, { action: "disable", mind: "alpha", json: false })).rejects.toThrow(/admin DATABASE_URL/);
    expect(await countOf("extractor_state")).toBe(0);
    expect(await countOf("events", "kind like 'daemon.extractor.%'")).toBe(0);
    expect((await extractorReport(pool, "alpha")).all_time.total).toBe(0);
  });
});

describe("EXTRACTOR_TTL_DAYS", () => {
  it("defaults to 14 days, accepts a positive whole number, refuses junk, and sets a proposal's expires_at", () => {
    expect(DEFAULT_EXTRACTOR_TTL_DAYS).toBe(14);
    expect(extractorTtlDays({})).toBe(14);
    expect(extractorTtlDays({ EXTRACTOR_TTL_DAYS: "3" })).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc", "99999"]) expect(() => extractorTtlDays({ EXTRACTOR_TTL_DAYS: bad })).toThrow(/EXTRACTOR_TTL_DAYS/);
    expect(noticingExpiresAt(T0, {}).getTime() - T0.getTime()).toBe(14 * DAY);
    expect(noticingExpiresAt(T0, { EXTRACTOR_TTL_DAYS: "2" }).getTime() - T0.getTime()).toBe(2 * DAY);
  });
});

describe("export, import and purge", () => {
  const dir = mkdtempSync(join(tmpdir(), "notice-"));
  let seq = 0;
  const dbs: string[] = [];
  const extra: Pool[] = [];
  const urlFor = (db: string, app = false): string => {
    if (app) return testAppUrl(db);
    const u = new URL(testDatabaseUrl());
    u.pathname = `/${db}`;
    return u.toString();
  };
  afterAll(async () => {
    for (const p of extra.splice(0)) await closePool(p);
    if (admin) for (const d of dbs) await admin.query(`drop database if exists ${d} with (force)`);
  });

  async function seedFull(): Promise<{ pending: string; accepted: string; shadow: string }> {
    const a = await mkNode("alpha", "one");
    const b = await mkNode("alpha", "two");
    await setExtractorState(admin, "alpha", "enable", { stage: "propose", schedule: "05:15" });
    await setExtractorState(admin, "alpha", "pause");
    const pending = await seedNoticing({ sources: [a, b], score: 0.7 });
    const shadow = await seedNoticing({ sources: [a, b], score: 0.3, stage: "shadow" });
    const accepted = await seedNoticing({ sources: [a, b], score: 0.9 });
    await N(alpha, { operation: "accept", noticing_id: accepted });
    const ev = (await admin.query("select id from events where kind = 'daemon.extractor.enable'")).rows[0].id;
    await queryAs(pool, "alpha", "alpha",
      `insert into extractor_models (mind_id, version, weights, trained_on, metrics, event_id) values ('alpha', 1, '{"cosine": 1.5}', 42, '{"p5": 0.8}', $1)`, [ev]);
    return { pending, accepted, shadow };
  }

  /** An empty second database (own admin and app pools) with an `alpha` mind. */
  async function secondDb(): Promise<{ a2: Pool; p2: Pool }> {
    const name = `notice_import_${process.pid}_${seq++}`;
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
    dbs.push(name);
    await runMigrations(urlFor(name));
    const a2 = createPool(urlFor(name));
    const p2 = createPool(urlFor(name, true));
    extra.push(a2, p2);
    await upsertMinds(a2, [{ mind_id: "alpha", key: "alpha-key".padEnd(32, "-") }]);
    return { a2, p2 };
  }

  it("export carries the three tables; import brings pending noticings in expired with an event, keeps decided ones, brings state in disabled at shadow, and models as they are", async () => {
    const ids = await seedFull();
    const f = join(dir, `x${seq++}.json`);
    const exp = await exportMind(pool, "alpha", f);
    expect(exp.counts).toMatchObject({ noticings: 3, extractor_state: 1, extractor_models: 1 });
    const { a2, p2 } = await secondDb();

    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.noticings).toMatchObject({ inserted: 3, already_present: 0 });
    expect(rep.tables.extractor_state).toMatchObject({ inserted: 1 });
    expect(rep.tables.extractor_models).toMatchObject({ inserted: 1 });
    expect(rep.notes.some((n) => /2 noticing\(s\).*arrived expired.*notice\.expired.*2 were pending or of unknown status/.test(n))).toBe(true);
    expect(rep.notes.some((n) => /arrived disabled and at stage shadow/.test(n))).toBe(true);

    const rows = (await a2.query("select id, status, stage, sources, payload, score, expires_at, decided_event_id from noticings order by score")).rows;
    expect(rows.map((r) => [r.id, r.status])).toEqual([[ids.shadow, "expired"], [ids.pending, "expired"], [ids.accepted, "accepted"]]);
    expect(rows.every((r) => Array.isArray(r.sources) && r.sources.length === 2)).toBe(true);
    // each expired one points at its own notice.expired event, written as the mind with reason "imported"
    for (const r of rows.slice(0, 2)) {
      const e = (await a2.query("select * from events where id = $1", [r.decided_event_id])).rows[0];
      expect(e).toMatchObject({ kind: "notice.expired", subject_id: r.id, written_by: "alpha", mind_id: "alpha", payload: { noticing_id: r.id, reason: "imported" } });
    }
    const st = (await a2.query("select * from extractor_state")).rows[0];
    expect(st).toMatchObject({ mind_id: "alpha", enabled: false, stage: "shadow", schedule: "05:15" });
    expect(st.paused_at).not.toBeNull();
    expect((await a2.query("select version, weights, trained_on, metrics from extractor_models")).rows).toEqual([
      { version: 1, weights: { cosine: 1.5 }, trained_on: 42, metrics: { p5: 0.8, imported_from_version: 1 } },
    ]);
    // nothing imported is shown to the mind
    const imported = await runVerb({ pool: p2, registry, now: () => clock }, alpha, "mind_notice", { mind_id: "alpha", operation: "list" });
    expect((imported as any).receipt.projection).toEqual({ noticings: [], stage: "shadow" });
    // a second import changes nothing, and writes no second expiry event
    const events = (await a2.query("select count(*)::int n from events")).rows[0].n;
    const again = await importMind(p2, f, "alpha");
    expect(again.tables.noticings).toMatchObject({ inserted: 0, already_present: 3 });
    expect((await a2.query("select count(*)::int n from events")).rows[0].n).toBe(events);
    expect(again.notes.some((n) => /already existed in the target and were left as they were/.test(n))).toBe(true);
    // a dry run advances nothing either
    const dry = await importMind(p2, f, "alpha", { dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect((await a2.query("select count(*)::int n from events")).rows[0].n).toBe(events);
  });

  it("import sets a status on every noticing: unknown, missing and decision-less ones arrive expired, each with an event", async () => {
    const ids = await seedFull();
    const f = join(dir, `x${seq++}.json`);
    await exportMind(pool, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    const byId = (id: string) => doc.projections.noticings.find((n: any) => n.id === id);
    byId(ids.pending).status = "applied"; // unknown
    delete byId(ids.shadow).status; // missing
    byId(ids.accepted).decided_event_id = null; // accepted without its decision event
    writeFileSync(f, JSON.stringify(doc));
    const { a2, p2 } = await secondDb();

    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.noticings).toMatchObject({ inserted: 3 });
    expect(rep.notes.some((n) => /3 noticing\(s\).*arrived expired.*2 were pending or of unknown status, 1 were decided without a decision event/.test(n))).toBe(true);
    const rows = (await a2.query("select id, status, decided_event_id, decided_at from noticings")).rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe("expired");
      expect(r.decided_at).not.toBeNull();
      expect((await a2.query("select kind, payload from events where id = $1", [r.decided_event_id])).rows[0]).toEqual({ kind: "notice.expired", payload: { noticing_id: r.id, reason: "imported" } });
    }
  });

  it("import leaves a target's own extractor_state alone and says so", async () => {
    await seedFull();
    const f = join(dir, `x${seq++}.json`);
    await exportMind(pool, "alpha", f);
    const { a2, p2 } = await secondDb();
    const ev = (await inTx(a2, "alpha", "alpha", "operator", `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'daemon.extractor.enable', '{}', 'alpha', now()) returning id`)).rows[0].id;
    await inTx(a2, "alpha", "alpha", "operator", "insert into extractor_state (mind_id, enabled, stage, schedule, updated_event_id) values ('alpha', true, 'propose', '09:00', $1)", [ev]);
    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.extractor_state).toMatchObject({ inserted: 0, already_present: 1 });
    expect(rep.notes.some((n) => /1 extractor_state row\(s\) already existed in the target and were left as they were/.test(n))).toBe(true);
    expect(rep.notes.some((n) => /arrived disabled/.test(n))).toBe(false);
    expect((await a2.query("select enabled, stage, schedule from extractor_state")).rows[0]).toEqual({ enabled: true, stage: "propose", schedule: "09:00" });
  });

  it("purge removes the mind's rows in all three tables (and only that mind's)", async () => {
    await seedFull();
    const b1 = await mkNode("beta", "b1");
    const b2 = await mkNode("beta", "b2");
    await seedNoticing({ sources: [b1, b2] }, "beta");
    await setState("beta", "propose");
    await admin.query("insert into extractor_models (mind_id, version, weights) values ('beta', 1, '{}')");
    for (const t of ["noticings", "extractor_state", "extractor_models"]) expect(await countOf(t, "mind_id = 'alpha'")).toBeGreaterThan(0);

    const r = await purgeMind(admin, "alpha", { confirm: "alpha" });
    expect(r.counts).toMatchObject({ noticings: 3, extractor_state: 1, extractor_models: 1 });
    for (const t of ["noticings", "extractor_state", "extractor_models"]) {
      expect(await countOf(t, "mind_id = 'alpha'")).toBe(0);
      expect(await countOf(t, "mind_id = 'beta'")).toBe(1);
    }
  });
});
