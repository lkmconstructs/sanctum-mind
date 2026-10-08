// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { runVerb } from "../src/verbs/run.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { vectorLiteral } from "../src/verbs/retrieval.js";
import { mind_write } from "../src/verbs/mind_write.js";
import { mind_observe } from "../src/verbs/mind_observe.js";
import { mind_link } from "../src/verbs/mind_link.js";
import { mind_search } from "../src/verbs/mind_search.js";
import { mind_surface } from "../src/verbs/mind_surface.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import type { Caller, Embedder, Registry } from "../src/verbs/types.js";

const registry: Registry = [mind_write, mind_observe, mind_link, mind_search, mind_surface];
const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const gamma: Caller = { bearer: "gamma", grants: {} };

let pool: Pool;
let admin: Pool;
const run = (caller: Caller, name: string, input: unknown, embedder: Embedder = FAKE_EMBEDDER) =>
  runVerb({ pool, registry, embedder }, caller, name, input);

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

const write = async (text: string, extra: Record<string, unknown> = {}, caller = alpha, mind = "alpha") => {
  const r: any = await run(caller, "mind_write", { mind_id: mind, type: "episodic", text, ...extra });
  expect(r.ok).toBe(true);
  return r.receipt.event_id as string;
};

/** A curated node written under the owner's scope, embedded with the fake embedder. */
const addNode = async (
  label: string,
  content: string,
  opts: { type?: string; meta?: Record<string, unknown>; mind?: string } = {},
): Promise<string> => {
  const mind = opts.mind ?? "alpha";
  const [v] = await FAKE_EMBEDDER.embed([`${label} ${content}`]);
  const r = await admin.query(
    `insert into nodes (mind_id, node_type, label, content, written_by, metadata, embedding, embedding_model)
     values ($1, $2, $3, $4, $1, $5::jsonb, $6::vector, $7) returning id`,
    [mind, opts.type ?? "concept", label, content, JSON.stringify(opts.meta ?? {}), vectorLiteral(v), FAKE_EMBEDDER.name],
  );
  return r.rows[0].id;
};

const link = async (a: string, b: string, weight: number) => {
  const r: any = await run(alpha, "mind_link", { mind_id: "alpha", source_id: a, target_id: b, weight });
  expect(r.ok).toBe(true);
};

const search = async (input: Record<string, unknown>, caller = alpha, embedder: Embedder = FAKE_EMBEDDER) => {
  const r: any = await run(caller, "mind_search", { mind_id: "alpha", ...input }, embedder);
  expect(r.ok).toBe(true);
  return r.receipt as { projection: { query: string; mode_used: string; hits: any[] }; warnings?: string[] };
};

const surface = async (input: Record<string, unknown>, embedder: Embedder = FAKE_EMBEDDER) => {
  const r: any = await run(alpha, "mind_surface", { mind_id: "alpha", ...input }, embedder);
  expect(r.ok).toBe(true);
  return r.receipt as { projection: { query: string; core: any[]; novel: any[]; edge: any[]; mode_used: string }; warnings?: string[] };
};

describe("mind_search", () => {
  it("text mode finds an exact-word match and nothing else", async () => {
    const fox = await write("the quick brown fox jumps over the lazy dog");
    await write("quarterly budget spreadsheet review");
    const r = await search({ query: "fox", mode: "text" });
    expect(r.projection.mode_used).toBe("text");
    expect(r.projection.hits.map((h) => h.id)).toEqual([fox]);
    const h = r.projection.hits[0];
    expect(h.source).toBe("event");
    expect(h.kind).toBe("write");
    expect(h.snippet).toBe("the quick brown fox jumps over the lazy dog");
    expect(h.text_rank).toBeGreaterThan(0);
    expect(h.distance).toBeUndefined();
    expect(r.warnings).toBeUndefined();
  });

  it("semantic mode ranks a paraphrase sharing words above an unrelated text", async () => {
    await write("quarterly budget spreadsheet review");
    const para = await write("a lazy brown dog and a sleepy fox");
    const r = await search({ query: "brown fox lazy dog", mode: "semantic", scope: "events" });
    expect(r.projection.mode_used).toBe("semantic");
    expect(r.projection.hits[0].id).toBe(para);
    expect(r.projection.hits).toHaveLength(2);
    expect(r.projection.hits[0].distance).toBeLessThan(r.projection.hits[1].distance);
    expect(r.projection.hits[0].text_rank).toBeUndefined();
  });

  it("hybrid fuses: a hit in both lists outranks one in a single list, with exact RRF scores", async () => {
    const both = await write("fox fox den");
    const semOnly = await write("foxes den den den");
    await write("budget spreadsheet");
    const r = await search({ query: "fox", scope: "events" });
    expect(r.projection.mode_used).toBe("hybrid");
    const hits = r.projection.hits;
    expect(hits[0].id).toBe(both);
    expect(hits[0].text_rank).toBeDefined();
    expect(hits[0].distance).toBeDefined();
    const so = hits.find((h) => h.id === semOnly)!;
    expect(so.text_rank).toBeUndefined();
    expect(so.distance).toBeDefined();
    expect(hits[0].score).toBeGreaterThan(so.score);
    // "both" is text rank 1 and semantic rank 1; semOnly appears only in the semantic list.
    expect(hits[0].score).toBeCloseTo(1 / 61 + 1 / 61, 10);
    const semRank = [...hits].sort((a, b) => a.distance - b.distance).findIndex((h) => h.id === semOnly) + 1;
    expect(so.score).toBeCloseTo(1 / (60 + semRank), 10);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });

  it("merges events and nodes by fused score, and scope narrows to one table", async () => {
    const ev = await write("heron heron heron");
    const nd = await addNode("heron", "a tall grey bird");
    const both = await search({ query: "heron", mode: "text" });
    expect(both.projection.hits.map((h) => `${h.source}:${h.id}`).sort()).toEqual([`event:${ev}`, `node:${nd}`].sort());
    const nodeHit = both.projection.hits.find((h) => h.source === "node")!;
    expect(nodeHit.node_type).toBe("concept");
    expect(nodeHit.label).toBe("heron");
    expect((await search({ query: "heron", mode: "text", scope: "events" })).projection.hits.map((h) => h.id)).toEqual([ev]);
    expect((await search({ query: "heron", mode: "text", scope: "nodes" })).projection.hits.map((h) => h.id)).toEqual([nd]);
  });

  it("filters by kind, node_type, context, after and before", async () => {
    const w = await write("lantern light", { context: "lane-a", recorded_at: "2026-03-01T00:00:00.000Z" });
    const w2 = await write("lantern oil", { context: "lane-b", recorded_at: "2026-05-01T00:00:00.000Z" });
    const o: any = await run(alpha, "mind_observe", {
      mind_id: "alpha", content: "lantern glow", texture: { charge: ["warm"] }, context: "lane-a",
      recorded_at: "2026-04-01T00:00:00.000Z",
    });
    expect(o.ok).toBe(true);
    const fact = await addNode("lantern", "a fact about lanterns", { type: "fact" });
    const ids = async (extra: Record<string, unknown>) =>
      (await search({ query: "lantern", mode: "text", ...extra })).projection.hits.map((h) => h.id).sort();

    expect(await ids({ scope: "events", kind: "observe" })).toEqual([o.receipt.event_id]);
    expect(await ids({ scope: "events", kind: "write" })).toEqual([w, w2].sort());
    expect(await ids({ scope: "nodes", node_type: "fact" })).toEqual([fact]);
    expect(await ids({ scope: "nodes", node_type: "observation" })).toEqual([o.receipt.projection.node_id]);
    expect(await ids({ scope: "events", context: "lane-a" })).toEqual([w, o.receipt.event_id].sort());
    expect(await ids({ scope: "nodes", context: "lane-a" })).toEqual([o.receipt.projection.node_id]);
    expect(await ids({ scope: "events", after: "2026-03-15T00:00:00Z" })).toEqual([w2, o.receipt.event_id].sort());
    expect(await ids({ scope: "events", before: "2026-03-15T00:00:00Z" })).toEqual([w]);
    expect(await ids({ scope: "events", after: "2026-03-15T00:00:00Z", before: "2026-04-15T00:00:00Z" })).toEqual([o.receipt.event_id]);
    // the filters apply to the semantic list too
    const sem = await search({ query: "lantern", mode: "semantic", scope: "events", kind: "observe" });
    expect(sem.projection.hits.map((h) => h.id)).toEqual([o.receipt.event_id]);
  });

  it("never returns invalidated nodes, in any mode", async () => {
    const live = await addNode("willow", "willow tree by the river");
    const dead = await addNode("willow", "willow willow willow");
    await admin.query("update nodes set invalidated_at = now() where id = $1", [dead]);
    for (const mode of ["text", "semantic", "hybrid"]) {
      const r = await search({ query: "willow", mode, scope: "nodes" });
      expect(r.projection.hits.map((h) => h.id)).toEqual([live]);
    }
  });

  it("is scoped by RLS: another mind's rows never appear", async () => {
    const mine = await write("comet dust");
    await write("comet dust comet", {}, beta, "beta");
    await addNode("comet", "comet tail", { mind: "beta" });
    const r = await search({ query: "comet" });
    expect(r.projection.hits.map((h) => h.id)).toEqual([mine]);
    // beta reading alpha through the grant still sees only alpha's rows
    const viaGrant = await search({ query: "comet" }, beta);
    expect(viaGrant.projection.hits.map((h) => h.id)).toEqual([mine]);
    // beta's own scope sees beta's
    const own: any = await run(beta, "mind_search", { mind_id: "beta", query: "comet", mode: "text" });
    expect(own.receipt.projection.hits).toHaveLength(2);
    expect(own.receipt.projection.hits.map((h: any) => h.id)).not.toContain(mine);
  });

  it("rejects bad input and callers without a grant", async () => {
    const blank: any = await run(alpha, "mind_search", { mind_id: "alpha", query: "   " });
    expect(blank.ok).toBe(false);
    expect(blank.error).toMatchObject({ code: "invalid_input", field: "query" });
    const lim: any = await run(alpha, "mind_search", { mind_id: "alpha", query: "x", limit: 51 });
    expect(lim.error).toMatchObject({ code: "invalid_input", field: "limit" });
    const extra: any = await run(alpha, "mind_search", { mind_id: "alpha", query: "x", bogus: 1 });
    expect(extra.error.code).toBe("invalid_input");
    const forbidden: any = await run(gamma, "mind_search", { mind_id: "alpha", query: "x" });
    expect(forbidden.error.code).toBe("forbidden");
  });

  it("appends no event", async () => {
    await write("cedar");
    const before = Number((await admin.query("select count(*) n from events")).rows[0].n);
    await search({ query: "cedar" });
    expect(Number((await admin.query("select count(*) n from events")).rows[0].n)).toBe(before);
  });

  it("with the none embedder (or a throwing one) returns the warning and text-only results", async () => {
    const id = await write("cedar waxwing");
    await write("budget");
    const warn = "no embedder: semantic search unavailable";
    const none = await search({ query: "cedar" }, alpha, NONE_EMBEDDER);
    expect(none.warnings).toEqual([warn]);
    expect(none.projection.mode_used).toBe("text");
    expect(none.projection.hits.map((h) => h.id)).toEqual([id]);
    expect(none.projection.hits[0].distance).toBeUndefined();

    const sem = await search({ query: "cedar", mode: "semantic" }, alpha, NONE_EMBEDDER);
    expect(sem.projection.hits).toEqual([]);
    expect(sem.warnings).toEqual([warn]);

    const boom: Embedder = { name: "boom", dim: 384, embed: async () => { throw new Error("down"); } };
    const t = await search({ query: "cedar" }, alpha, boom);
    expect(t.warnings).toEqual([warn]);
    expect(t.projection.hits.map((h) => h.id)).toEqual([id]);

    // text mode asked for explicitly is not a degradation
    expect((await search({ query: "cedar", mode: "text" }, alpha, NONE_EMBEDDER)).warnings).toBeUndefined();
  });

  it("applies limit after fusion", async () => {
    for (let i = 0; i < 6; i++) await write(`pebble ${"stone ".repeat(i)}`);
    await addNode("pebble", "a pebble");
    const all = await search({ query: "pebble", limit: 50 });
    const two = await search({ query: "pebble", limit: 2 });
    expect(all.projection.hits.length).toBeGreaterThan(2);
    expect(two.projection.hits.map((h) => h.id)).toEqual(all.projection.hits.slice(0, 2).map((h) => h.id));
  });

  it("fuses before limiting: a hit at rank 8 in both lists beats rank 1 in one list (limit 1)", async () => {
    const q = "kestrel falcon";
    // A1..A7: text-only (no embedding), more occurrences than B, so they are text ranks 1..7.
    for (let r = 9; r >= 3; r--) {
      const rr: any = await run(alpha, "mind_write", { mind_id: "alpha", type: "note", text: "kestrel falcon ".repeat(r) }, NONE_EMBEDDER);
      expect(rr.ok).toBe(true);
    }
    // G1..G7: semantic-only (no "kestrel", so no text match), cosine decreasing with the filler count: semantic ranks 1..7.
    for (let j = 1; j <= 7; j++) await write(`falcon ${"drift ".repeat(j)}`);
    // B: matches both words once, buried in filler: text rank 8 and semantic rank 8.
    const b = await write(`kestrel falcon ${"murk ".repeat(40)}`);

    const textOnly = (await search({ query: q, mode: "text", scope: "events", limit: 50 })).projection.hits;
    const semOnly = (await search({ query: q, mode: "semantic", scope: "events", limit: 50 })).projection.hits;
    expect(textOnly).toHaveLength(8);
    expect(textOnly.findIndex((h) => h.id === b)).toBe(7);
    expect(semOnly.findIndex((h) => h.id === b)).toBe(7);

    const one = await search({ query: q, scope: "events", limit: 1 });
    expect(one.projection.hits.map((h) => h.id)).toEqual([b]);
    expect(one.projection.hits[0].score).toBeCloseTo(2 / 68, 10);
    const all = await search({ query: q, scope: "events", limit: 50 });
    expect(all.projection.hits[0].id).toBe(b);
    expect(all.projection.hits).toHaveLength(15);
    expect(all.projection.hits[1].score).toBeCloseTo(1 / 61, 10);
  });

  it("collapses whitespace and truncates the snippet to 240 code points", async () => {
    const long = `emoji\n\n  ${"\u{1F600}".repeat(300)}`;
    const r = await search({ query: "emoji", mode: "text", scope: "events" }, alpha);
    expect(r.projection.hits).toHaveLength(0);
    await write(long);
    const s = (await search({ query: "emoji", mode: "text", scope: "events" })).projection.hits[0].snippet as string;
    expect(Array.from(s)).toHaveLength(240);
    expect(s.startsWith("emoji \u{1F600}")).toBe(true);
  });
});

describe("mind_surface", () => {
  it("core picks the top hybrid node hits", async () => {
    for (let i = 1; i <= 8; i++) await addNode(`apple ${i}`, `apple ${"orchard ".repeat(i)}`);
    await addNode("unrelated", "budget spreadsheet");
    const top = (await search({ query: "apple", scope: "nodes", limit: 50 })).projection.hits.map((h) => h.id);
    const s = await surface({ query: "apple", pool_sizes: { core: 3, novel: 0, edge: 0 } });
    expect(s.projection.mode_used).toBe("hybrid");
    expect(s.projection.core.map((h) => h.id)).toEqual(top.slice(0, 3));
    expect(s.projection.core[0]).toMatchObject({ pool: "core", node_type: "concept" });
    expect(typeof s.projection.core[0].snippet).toBe("string");
    expect(s.warnings).toBeUndefined();
  });

  it("novel excludes core, draws from rank 2*core+1 on, and prefers charged nodes", async () => {
    for (let i = 1; i <= 12; i++) await addNode(`apple ${i}`, `apple ${"orchard ".repeat(i)}`);
    const order = (await search({ query: "apple", scope: "nodes", limit: 50 })).projection.hits.map((h) => h.id);
    const last = order[order.length - 1]!;
    await admin.query(
      `update nodes set metadata = $2::jsonb where id = $1`,
      [last, JSON.stringify({ texture: { charge: ["awe", "dread"], grip: "iron", vividness: "vivid" } })],
    );
    const s = await surface({ query: "apple", pool_sizes: { core: 2, novel: 3, edge: 0 } });
    const core = s.projection.core.map((h) => h.id);
    const novel = s.projection.novel.map((h) => h.id);
    expect(core).toEqual(order.slice(0, 2));
    expect(novel).toHaveLength(3);
    expect(novel[0]).toBe(last);
    for (const id of novel) {
      expect(core).not.toContain(id);
      expect(order.indexOf(id)).toBeGreaterThanOrEqual(4); // ranks 5.. (2*core + 1)
    }
    expect(s.projection.novel.every((h) => h.pool === "novel")).toBe(true);
    // equal charge weight falls back to newest first
    const rest = novel.slice(1);
    const created = await admin.query("select id, created_at from nodes where id = any($1::uuid[])", [rest]);
    const ts = new Map(created.rows.map((r) => [r.id, r.created_at.getTime()]));
    expect(ts.get(rest[0]!)!).toBeGreaterThanOrEqual(ts.get(rest[1]!)!);
  });

  it("edge follows related_to links up to two hops, in both directions, and reports hops and via", async () => {
    const c = await addNode("zebra", "zebra stripes");
    const n1 = await addNode("one", "mango");
    const n2 = await addNode("two", "plum");
    const n3 = await addNode("three", "kiwi");
    const n4 = await addNode("four", "lime");
    await link(c, n1, 0.9);
    await link(n1, n2, 0.5);
    await link(n2, n3, 0.9); // three hops from the core: out of reach
    await link(n4, c, 0.3); // incoming edge counts too
    const s = await surface({ query: "zebra", pool_sizes: { core: 1, novel: 0, edge: 10 } });
    expect(s.projection.core.map((h) => h.id)).toEqual([c]);
    const edge = s.projection.edge;
    // ranked by hops asc, then summed weight desc: both hop-1 nodes come before the hop-2 node
    expect(edge.map((h) => h.id)).toEqual([n1, n4, n2]);
    expect(edge[0]).toMatchObject({ hops: 1, via: c });
    expect(edge[1]).toMatchObject({ hops: 1, via: c });
    expect(edge[2]).toMatchObject({ pool: "edge", hops: 2, via: n1, label: "two", node_type: "concept" });
    expect(edge[2].score).toBeCloseTo(1.4, 10);
    expect(edge.map((h) => h.id)).not.toContain(n3);
    expect(edge.map((h) => h.id)).not.toContain(c);
  });

  it("edge prefers one hop at equal weight, honours its size, and skips invalidated nodes", async () => {
    const c = await addNode("zebra", "zebra stripes");
    const one = await addNode("one", "mango");
    const mid = await addNode("mid", "plum");
    const two = await addNode("two", "kiwi");
    await link(c, one, 0.5);
    await link(c, mid, 0.25);
    await link(mid, two, 0.25);
    const q = { query: "zebra" };
    const s = await surface({ ...q, pool_sizes: { core: 1, novel: 0, edge: 10 } });
    // hops first: one (0.5) and mid (0.25) are hop 1, two (0.5 via mid) is hop 2
    expect(s.projection.edge.map((h) => h.id)).toEqual([one, mid, two]);
    expect((await surface({ ...q, pool_sizes: { core: 1, novel: 0, edge: 1 } })).projection.edge.map((h) => h.id)).toEqual([one]);

    await admin.query("update nodes set invalidated_at = now() where id = $1", [mid]);
    const s2 = await surface({ ...q, pool_sizes: { core: 1, novel: 0, edge: 10 } });
    expect(s2.projection.edge.map((h) => h.id)).toEqual([one]);
  });

  it("labels a node by its fewest hops even when a heavier two-hop path reaches it (triangle)", async () => {
    const sd = await addNode("zebra", "zebra stripes");
    const x = await addNode("xray", "mango");
    const y = await addNode("yankee", "plum");
    await link(sd, x, 0.9);
    await link(sd, y, 0.5);
    await link(y, x, 0.5); // S-Y-X sums to 1.0 and 1.4 would beat the direct 0.9 if score came first
    const s = await surface({ query: "zebra", pool_sizes: { core: 1, novel: 0, edge: 10 } });
    expect(s.projection.core.map((h) => h.id)).toEqual([sd]);
    expect(s.projection.edge.map((h) => h.id)).toEqual([x, y]);
    expect(s.projection.edge[0]).toMatchObject({ hops: 1, via: sd });
    expect(s.projection.edge[0].score).toBeCloseTo(0.9, 10);
    expect(s.projection.edge[1]).toMatchObject({ hops: 1, via: sd });
    expect(s.projection.edge[1].score).toBeCloseTo(0.5, 10);
  });

  it("edges cannot be self loops, and no HNSW index remains on events or nodes", async () => {
    const a = await addNode("loop", "loop");
    await expect(
      admin.query(
        `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'related_to', 'alpha', $1, $1)`,
        [a],
      ),
    ).rejects.toThrow(/edges_no_self_loop/);
    const idx = await admin.query(`select indexname from pg_indexes where indexdef ilike '%hnsw%'`);
    expect(idx.rows).toEqual([]);
  });

  it("edge never repeats core or novel nodes", async () => {
    const c = await addNode("zebra", "zebra stripes");
    const others: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await addNode(`animal ${i}`, `zebra ${"herd ".repeat(i + 1)}`);
      others.push(id);
      await link(c, id, 0.5);
    }
    const s = await surface({ query: "zebra", pool_sizes: { core: 1, novel: 1, edge: 10 } });
    const used = [...s.projection.core, ...s.projection.novel].map((h) => h.id);
    expect(used).toHaveLength(2);
    for (const e of s.projection.edge) expect(used).not.toContain(e.id);
    const all = [...used, ...s.projection.edge.map((h) => h.id)];
    expect(new Set(all).size).toBe(all.length);
  });

  it("honours pool sizes and allows zero-size pools", async () => {
    const c = await addNode("zebra", "zebra stripes");
    for (let i = 0; i < 6; i++) {
      const id = await addNode(`zebra ${i}`, `zebra ${"herd ".repeat(i)}`);
      await link(c, id, 0.5);
    }
    const s = await surface({ query: "zebra", pool_sizes: { core: 2, novel: 3, edge: 1 } });
    expect(s.projection.core).toHaveLength(2);
    expect(s.projection.novel).toHaveLength(3);
    expect(s.projection.edge.length).toBeLessThanOrEqual(1);
    const z = await surface({ query: "zebra", pool_sizes: { core: 1, novel: 0, edge: 0 } });
    expect(z.projection.core).toHaveLength(1);
    expect(z.projection.novel).toEqual([]);
    expect(z.projection.edge).toEqual([]);
    const d = await surface({ query: "zebra" });
    expect(d.projection.core).toHaveLength(3);
    expect(d.projection.novel.length).toBeLessThanOrEqual(2);
    const bad: any = await run(alpha, "mind_surface", { mind_id: "alpha", query: "zebra", pool_sizes: { core: 0 } });
    expect(bad.error).toMatchObject({ code: "invalid_input" });
  });

  it("works from mind_observe nodes, ignores events, excludes invalidated nodes and other minds, and honours context", async () => {
    const o: any = await run(alpha, "mind_observe", {
      mind_id: "alpha", content: "the heron stood still", texture: { charge: ["calm"] }, context: "lane-a",
    });
    await write("heron event only");
    const dead = await addNode("heron", "heron heron heron");
    await admin.query("update nodes set invalidated_at = now() where id = $1", [dead]);
    await addNode("heron", "beta heron", { mind: "beta" });
    const s = await surface({ query: "heron", pool_sizes: { core: 5, novel: 0, edge: 0 } });
    const ids = s.projection.core.map((h) => h.id);
    expect(ids).toEqual([o.receipt.projection.node_id]);
    expect(await surface({ query: "heron", context: "lane-b", pool_sizes: { core: 5, novel: 0, edge: 0 } }).then((x) => x.projection.core)).toEqual([]);
    expect((await surface({ query: "heron", context: "lane-a" })).projection.core).toHaveLength(1);
  });

  it("without an embedder warns and ranks by text only", async () => {
    const id = await addNode("zebra", "zebra stripes");
    await addNode("other", "budget");
    const s = await surface({ query: "zebra" }, NONE_EMBEDDER);
    expect(s.warnings).toEqual(["no embedder: semantic search unavailable"]);
    expect(s.projection.mode_used).toBe("text");
    expect(s.projection.core.map((h) => h.id)).toEqual([id]);
  });

  it("is read-only, scoped, and checks grants", async () => {
    const id = await addNode("zebra", "zebra stripes");
    await addNode("zebra", "beta zebra", { mind: "beta" });
    const before = Number((await admin.query("select count(*) n from events")).rows[0].n);
    const viaGrant: any = await run(beta, "mind_surface", { mind_id: "alpha", query: "zebra" });
    expect(viaGrant.ok).toBe(true);
    expect(viaGrant.receipt.projection.core.map((h: any) => h.id)).toEqual([id]);
    expect(viaGrant.receipt.event_id).toBeUndefined();
    expect(Number((await admin.query("select count(*) n from events")).rows[0].n)).toBe(before);
    const f: any = await run(gamma, "mind_surface", { mind_id: "alpha", query: "zebra" });
    expect(f.error.code).toBe("forbidden");
    const blank: any = await run(alpha, "mind_surface", { mind_id: "alpha", query: "" });
    expect(blank.error).toMatchObject({ code: "invalid_input", field: "query" });
  });
});
