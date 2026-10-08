// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { runVerb } from "../src/verbs/run.js";
import { mind_search } from "../src/verbs/mind_search.js";
import { importRevien } from "../src/adapters/revien.js";
import { registry } from "../src/verbs/registry.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import type { Caller, Embedder } from "../src/verbs/types.js";

const FIXTURE = new URL("./fixtures/revien-export.json", import.meta.url).pathname;
const alpha: Caller = { bearer: "alpha", grants: {} };

let pool: Pool;
let admin: Pool;

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
});

afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

const imp = (opts: Partial<Parameters<typeof importRevien>[1]> = {}, embedder: Embedder = FAKE_EMBEDDER) =>
  importRevien({ pool, embedder }, { mind_id: "alpha", file: FIXTURE, ...opts });

const count = async (table: string, mind = "alpha") =>
  Number((await admin.query(`select count(*)::int as n from ${table} where mind_id = $1`, [mind])).rows[0].n);

const search = async (query: string) => {
  const r: any = await runVerb({ pool, registry: [mind_search], embedder: FAKE_EMBEDDER }, alpha, "mind_search", {
    mind_id: "alpha", query, scope: "nodes",
  });
  expect(r.ok).toBe(true);
  return r.receipt.projection.hits;
};

const tmpFile = (content: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "revien-")), "x.json");
  writeFileSync(f, content);
  return f;
};

describe("importRevien", () => {
  it("dry run reports counts and writes nothing", async () => {
    const r = await imp({ dry_run: true });
    expect(r.nodes).toEqual({ imported: 6, already_present: 0, skipped_invalid: 1 });
    expect(r.edges).toEqual({ imported: 5, already_present: 0, skipped_missing_end: 1, skipped_self_loop: 1, skipped_invalid: 0 });
    expect(r.type_counts).toMatchObject({ "revien:memory": 1, "revien:fact": 1, "revien:person": 1, "revien:decision": 1, "revien:note": 1, "revien:emotion": 1 });
    expect(r.notes.some((n) => n.includes("n-007"))).toBe(true);
    expect(await count("nodes")).toBe(0);
    expect(await count("edges")).toBe(0);
    expect(await count("events")).toBe(0);
  });

  it("imports with the right mappings", async () => {
    const r = await imp();
    expect(r.nodes.imported).toBe(6);
    expect(r.edges.imported).toBe(5);

    const nodes = (await admin.query("select * from nodes where mind_id = 'alpha'")).rows;
    expect(nodes).toHaveLength(6);
    const byRid = (rid: string) => nodes.find((n) => n.metadata.revien_node_id === rid)!;
    const n1 = byRid("n-001");
    expect(n1.id).not.toBe("n-001");
    expect(n1.written_by).toBe("alpha");
    expect(n1.node_type).toBe("revien:memory");
    expect(n1.metadata.revien_node_type).toBe("memory");
    expect(n1.metadata.origin).toBe("fixture");
    expect(n1.metadata.revien).toMatchObject({ source_id: "src-a", modality: "text", access_count: 3, confidence_set_by: "system" });
    expect(n1.pinned).toBe(true);
    expect(n1.source_type).toBe("extracted");
    expect(n1.confidence).toBeCloseTo(0.8);
    expect(n1.embedding).not.toBeNull();
    expect(n1.embedding_model).toBe("fake");
    // created_at preserved to the microsecond
    const ca = (await admin.query("select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') as t from nodes where id = $1", [n1.id])).rows[0].t;
    expect(ca).toBe("2024-02-01T09:00:00.000001");

    const n3 = byRid("n-003");
    const t = (await admin.query(
      `select to_char(event_time_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as s,
              to_char(event_time_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as e,
              to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as r,
              event_time_granularity as g from nodes where id = $1`, [n3.id])).rows[0];
    expect(t).toEqual({ s: "2024-03-05T10:20:30.123456", e: "2024-03-05T11:00:00.654321", r: "2024-02-01T09:00:05.250000", g: "fuzzy" });
    expect(n3.metadata.revien.event_time_text).toBe("early March, mid morning");

    // blank label falls back to content
    expect(byRid("n-006").label).toMatch(/^A quiet pride settled/);
    expect(byRid("n-004").invalidated_at).not.toBeNull();
    expect(byRid("n-004").source_type).toBe("corrected");

    // edges
    const edges = (await admin.query("select * from edges where mind_id = 'alpha'")).rows;
    expect(edges).toHaveLength(5);
    const e = (rid: string) => edges.find((x) => x.metadata.revien_edge_id === rid)!;
    expect(e("e-001").edge_type).toBe("related_to");
    expect(e("e-003").edge_type).toBe("felt_toward");
    expect(e("e-003").weight).toBe(1);
    expect(e("e-003").confidence).toBe(0);
    expect(e("e-002").edge_type).toBe("related_to");
    expect(e("e-002").metadata.revien_edge_type).toBe("decided_in");
    expect(e("e-007").metadata.revien_edge_type).toBe("lived_vs_clinical");
    expect(e("e-002").source_node_id).toBe(byRid("n-004").id);
    expect(e("e-002").target_node_id).toBe(byRid("n-003").id);
    expect(e("e-004")).toBeUndefined();
    expect(e("e-005")).toBeUndefined();

    // ledger keeps originals whole
    const ev = (await admin.query("select * from events where mind_id = 'alpha' and kind = 'import.revien.node'")).rows;
    expect(ev).toHaveLength(6);
    const o = ev.find((x) => x.payload.node_id === "n-001")!;
    expect(o.payload.future_field).toBe("kept");
    expect(o.subject_id).toBe(n1.id);
    expect(o.written_by).toBe("alpha");
    const eev = (await admin.query("select * from events where mind_id = 'alpha' and kind = 'import.revien.edges'")).rows;
    expect(eev).toHaveLength(1);
    expect(eev[0].payload.count).toBe(5);

    // search: found by text, invalidated absent
    expect(JSON.stringify(await search("paper boats waterfront"))).toContain("Harbor lantern festival");
    expect(JSON.stringify(await search("zyxwv flags"))).not.toContain("Retired signal plan");
  });

  it("a second run is fully already_present", async () => {
    await imp();
    const nodesBefore = await count("nodes");
    const edgesBefore = await count("edges");
    const eventsBefore = await count("events");
    const r = await imp();
    expect(r.nodes).toEqual({ imported: 0, already_present: 6, skipped_invalid: 1 });
    expect(r.edges).toEqual({ imported: 0, already_present: 5, skipped_missing_end: 1, skipped_self_loop: 1, skipped_invalid: 0 });
    expect(await count("nodes")).toBe(nodesBefore);
    expect(await count("edges")).toBe(edgesBefore);
    expect(await count("events")).toBe(eventsBefore);
  });

  it("source_filter excludes the other source and its edges", async () => {
    const r = await imp({ source_filter: ["src-a"] });
    expect(r.nodes.imported).toBe(5);
    expect(r.edges.imported).toBe(4);
    expect(r.edges.skipped_missing_end).toBe(2); // dangling plus the edge into src-b
    const n = await admin.query("select 1 from nodes where metadata->>'revien_node_id' = 'n-005'");
    expect(n.rows).toHaveLength(0);
  });

  it("stores null embeddings when the embedder fails", async () => {
    const failing: Embedder = { name: "bad", dim: 384, embed: async () => { throw new Error("down"); } };
    const r = await imp({}, failing);
    expect(r.nodes.imported).toBe(6);
    const rows = (await admin.query("select embedding is null as nul, embedding_model from nodes where mind_id = 'alpha'")).rows;
    expect(rows.every((x) => x.nul && x.embedding_model === null)).toBe(true);
  });

  it("writes nothing into another mind (RLS)", async () => {
    await imp();
    expect(await count("nodes", "beta")).toBe(0);
    expect(await count("edges", "beta")).toBe(0);
    expect(await count("events", "beta")).toBe(0);
    expect(await count("nodes", "alpha")).toBe(6);
  });

  it("drops invalid event times with a note, and skips an unreadable created_at", async () => {
    const base = { label: "x", content: "some content", source_type: "inferred", created_at: "2024-01-01T00:00:00" };
    const file = tmpFile(JSON.stringify({
      version: "1.0",
      nodes: [
        { ...base, node_id: "a", node_type: "t", event_time_start: "2024-05-02T00:00:00", event_time_end: "2024-05-01T00:00:00", event_time_granularity: "day" },
        { ...base, node_id: "b", node_type: "t", created_at: "not a date" },
        { ...base, node_id: "c", node_type: "t", event_time_start: "0000-01-01T00:00:00" },
      ],
      edges: [],
    }));
    const r = await imp({ file });
    expect(r.nodes).toEqual({ imported: 2, already_present: 0, skipped_invalid: 1 });
    expect(r.notes.length).toBeGreaterThanOrEqual(3);
    const rows = (await admin.query("select event_time_start, event_time_end, event_time_granularity from nodes where mind_id='alpha'")).rows;
    expect(rows.every((x) => x.event_time_start === null && x.event_time_end === null && x.event_time_granularity === null)).toBe(true);
  });

  it("truncates long labels to 200 code points", async () => {
    const file = tmpFile(JSON.stringify({
      nodes: [{ node_id: "a", node_type: "t", label: "\u{1F600}".repeat(300), content: "body", created_at: "2024-01-01T00:00:00" }],
    }));
    await imp({ file });
    const l = (await admin.query("select label from nodes where mind_id='alpha'")).rows[0].label as string;
    expect(Array.from(l)).toHaveLength(200);
  });

  it("rejects a malformed file with a clear error and writes nothing", async () => {
    await expect(imp({ file: tmpFile("{not json") })).rejects.toThrow(/not valid JSON/);
    await expect(imp({ file: tmpFile(JSON.stringify({ edges: [] })) })).rejects.toThrow(/not a valid Revien export.*nodes/);
    await expect(
      imp({ file: tmpFile(JSON.stringify({ nodes: [{ node_id: "a", node_type: "t", label: "x", created_at: "2024-01-01T00:00:00" }] })) }),
    ).rejects.toThrow(/nodes\.0\.content/);
    await expect(imp({ file: "/nonexistent/revien.json" })).rejects.toThrow(/cannot read/);
    expect(await count("nodes")).toBe(0);
    expect(await count("events")).toBe(0);
  });
});

describe("importRevien hardening", () => {
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    node_id: id, node_type: "t", label: id, content: `content ${id}`, created_at: "2024-01-01T00:00:00", ...extra,
  });
  const edge = (id: string, a: string, b: string, extra: Record<string, unknown> = {}) => ({
    edge_id: id, edge_type: "related_to", source_node_id: a, target_node_id: b, ...extra,
  });

  it("imported desire-typed nodes carry the prefix and a non-boolean `fulfilled` breaks neither the list nor the daemon", async () => {
    const file = tmpFile(JSON.stringify({
      nodes: [
        node("d1", { node_type: "desire", created_at: "2020-01-01T00:00:00", metadata: { fulfilled: "nope", faded: 5, intensity: "high" } }),
        node("o1", { node_type: "observation", created_at: "2020-01-01T00:00:00" }),
      ],
    }));
    const r = await imp({ file });
    expect(r.nodes.imported).toBe(2);
    expect(r.type_counts).toEqual({ "revien:desire": 1, "revien:observation": 1 });
    const types = (await admin.query("select node_type, metadata->>'revien_node_type' as orig from nodes order by node_type")).rows;
    expect(types).toEqual([
      { node_type: "revien:desire", orig: "desire" },
      { node_type: "revien:observation", orig: "observation" },
    ]);
    // a real desire node whose flags are not booleans (written by anything) must not break the casts either
    await admin.query(
      `insert into nodes (mind_id, node_type, label, content, written_by, metadata, created_at)
       values ('alpha', 'desire', 'odd', 'odd', 'alpha', '{"fulfilled":"nope","faded":{"x":1},"intensity":"high"}', now() - interval '90 days')`,
    );
    const list: any = await runVerb({ pool, registry }, alpha, "mind_desire", { mind_id: "alpha", operation: "list" });
    expect(list.ok).toBe(true);
    expect(list.receipt.projection.desires).toHaveLength(1);
    const reports = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER }, { trigger: "manual", minds: ["alpha"] });
    expect(reports[0]!.ok).toBe(true);
    expect(reports[0]!.passes.find((p) => p.pass === "desires.fade")).toMatchObject({ ok: true, changed: 1 });
    // the imported observation is not an 'observation' node, so the orphan pass leaves it alone
    expect(reports[0]!.passes.find((p) => p.pass === "graph.orphans")).toMatchObject({ ok: true, changed: 0 });
  });

  it("keeps a cross-source edge when sources are imported one after the other", async () => {
    const file = tmpFile(JSON.stringify({
      nodes: [node("A1", { source_id: "A" }), node("A2", { source_id: "A" }), node("B1", { source_id: "B" })],
      edges: [edge("eAA", "A1", "A2"), edge("eAB", "A1", "B1"), edge("eBA", "B1", "A2")],
    }));
    const first = await imp({ file, source_filter: ["A"] });
    expect(first.nodes.imported).toBe(2);
    expect(first.edges).toMatchObject({ imported: 1, skipped_missing_end: 2 });
    const second = await imp({ file, source_filter: ["B"] });
    expect(second.nodes.imported).toBe(1);
    expect(second.edges).toMatchObject({ imported: 2, already_present: 1, skipped_missing_end: 0 });
    const rows = (await admin.query(
      `select e.metadata->>'revien_edge_id' as eid, s.metadata->>'revien_node_id' as src, t.metadata->>'revien_node_id' as tgt
         from edges e join nodes s on s.id = e.source_node_id join nodes t on t.id = e.target_node_id order by 1`,
    )).rows;
    expect(rows).toEqual([
      { eid: "eAA", src: "A1", tgt: "A2" },
      { eid: "eAB", src: "A1", tgt: "B1" },
      { eid: "eBA", src: "B1", tgt: "A2" },
    ]);
    const dry = await imp({ file, source_filter: ["B"], dry_run: true });
    expect(dry.edges).toMatchObject({ imported: 0, already_present: 3 });
  });

  it("counts an unstorable edge as skipped_invalid", async () => {
    const file = tmpFile(JSON.stringify({
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b", { metadata: { x: "nul\u0000here" } }), edge("e2", "b", "a")],
    }));
    const r = await imp({ file });
    expect(r.edges).toMatchObject({ imported: 1, skipped_invalid: 1 });
    expect(r.notes.some((n) => n.includes("e1"))).toBe(true);
  });

  it("sets a future created_at to the import time, with a note", async () => {
    const file = tmpFile(JSON.stringify({ nodes: [node("f", { created_at: "2999-01-01T00:00:00" })] }));
    const before = Date.now();
    const r = await imp({ file });
    expect(r.nodes.imported).toBe(1);
    expect(r.notes.some((n) => n.includes("in the future"))).toBe(true);
    const t = (await admin.query("select created_at from nodes where mind_id = 'alpha'")).rows[0].created_at as Date;
    expect(t.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(t.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("refuses a file over 256 MiB before reading it", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "revien-big-")), "big.json");
    writeFileSync(f, "");
    truncateSync(f, 257 * 1024 * 1024);
    await expect(imp({ file: f })).rejects.toThrow(/256 MiB limit/);
    expect(await count("nodes")).toBe(0);
  });

  it("has an index on the original node id", async () => {
    const r = await admin.query("select 1 from pg_indexes where indexname = 'nodes_revien_node_id_idx'");
    expect(r.rowCount).toBe(1);
  });
});

