// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { backfillEmbeddings } from "../src/embed/backfill.js";
import { embedderFromEnv } from "../src/embed/index.js";
import { httpEmbedder } from "../src/embed/http.js";
import { l2normalise } from "../src/embed/local.js";
import { vectorLiteral } from "../src/verbs/common.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import { z } from "zod";
import { ok } from "../src/result.js";
import { defineVerb, type Caller, type Embedder } from "../src/verbs/types.js";

const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: {} };
const texture = { charge: ["warm"], salience: "active", somatic: "chest" };

let pool: Pool;
let admin: Pool;
const THROWING: Embedder = {
  name: "boom",
  dim: 384,
  async embed() {
    throw new Error("embedder down");
  },
};
const runWith = (embedder: Embedder, caller: Caller, name: string, input: unknown) =>
  runVerb({ pool, registry, embedder }, caller, name, input);
const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);

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

const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe("fake embedder", () => {
  it("is 384-d, L2-normalised and puts texts sharing words closer than unrelated ones", async () => {
    const [a, b, c] = (await FAKE_EMBEDDER.embed([
      "the quiet garden after rain",
      "rain in the quiet garden",
      "quarterly invoice reconciliation spreadsheet",
    ])) as Float32Array[];
    expect(FAKE_EMBEDDER.name).toBe("fake");
    expect(a!.length).toBe(384);
    expect(cos(a!, a!)).toBeCloseTo(1, 5);
    expect(cos(a!, b!)).toBeGreaterThan(cos(a!, c!));
    expect((await FAKE_EMBEDDER.embed(["x"]))[0]).toEqual((await FAKE_EMBEDDER.embed(["x"]))[0]);
  });
});

describe("embedderFromEnv", () => {
  it("chooses by EMBEDDER without loading anything", () => {
    expect(embedderFromEnv({ EMBEDDER: "none" }).name).toBe("none");
    expect(embedderFromEnv({ EMBEDDER: "http", EMBED_URL: "http://emb.local:8080/v1/embeddings" }).name).toBe("http:emb.local");
    expect(embedderFromEnv({ EMBEDDER: "http" }).name).toBe("none");
    expect(embedderFromEnv({}).name).toBe("local:bge-small-en-v1.5");
  });
});

describe("write path", () => {
  it("mind_write and mind_observe store a vector and model with the fake embedder", async () => {
    const w: any = await runWith(FAKE_EMBEDDER, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "tea in the garden" });
    expect(w.ok).toBe(true);
    const o: any = await runWith(FAKE_EMBEDDER, alpha, "mind_observe", { mind_id: "alpha", content: "rain on the roof", texture });
    expect(o.ok).toBe(true);
    const ev = await q("alpha", "select kind, embedding is not null as has, embedding_model from events order by seq");
    expect(ev).toEqual([
      { kind: "write", has: true, embedding_model: "fake" },
      { kind: "observe", has: true, embedding_model: "fake" },
    ]);
    const nodes = await q("alpha", "select embedding::text as e, embedding_model from nodes");
    expect(nodes[0].embedding_model).toBe("fake");
    const evEmb = await q("alpha", "select embedding::text as e from events where kind = 'observe'");
    expect(nodes[0].e).toBe(evEmb[0].e);
  });

  it("stores null with the none embedder", async () => {
    await runWith(NONE_EMBEDDER, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
    await runWith(NONE_EMBEDDER, alpha, "mind_observe", { mind_id: "alpha", content: "y", texture });
    expect(await q("alpha", "select 1 from events where embedding is not null or embedding_model is not null")).toEqual([]);
    expect(await q("alpha", "select 1 from nodes where embedding is not null or embedding_model is not null")).toEqual([]);
  });

  it("a throwing embedder does not fail the write", async () => {
    const w: any = await runWith(THROWING, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
    const o: any = await runWith(THROWING, alpha, "mind_observe", { mind_id: "alpha", content: "y", texture });
    expect(w.ok).toBe(true);
    expect(o.ok).toBe(true);
    expect(await q("alpha", "select 1 from events where embedding is not null")).toEqual([]);
    expect(await q("alpha", "select 1 from nodes where embedding is not null")).toEqual([]);
  });

  it("mind_rethink embeds the replacement node", async () => {
    const o: any = await runWith(NONE_EMBEDDER, alpha, "mind_observe", { mind_id: "alpha", content: "first view", texture });
    const r: any = await runWith(FAKE_EMBEDDER, alpha, "mind_rethink", {
      mind_id: "alpha", node_id: o.receipt.projection.node_id, content: "corrected view", reason: "better",
    });
    expect(r.ok).toBe(true);
    const n = await q("alpha", "select embedding_model from nodes where id = $1", [r.receipt.projection.node_id]);
    expect(n[0].embedding_model).toBe("fake");
  });
});

describe("backfill", () => {
  it("fills null embeddings per mind, leaves written_by alone, and a second run touches nothing", async () => {
    for (const [who, mind] of [[alpha, "alpha"], [beta, "beta"]] as const) {
      await runWith(NONE_EMBEDDER, who, "mind_write", { mind_id: mind, type: "note", text: `note of ${mind}` });
      await runWith(NONE_EMBEDDER, who, "mind_observe", { mind_id: mind, content: `observation of ${mind}`, texture });
    }
    const c1 = await backfillEmbeddings(pool, FAKE_EMBEDDER, 1);
    expect(c1).toEqual({ events: 4, nodes: 2, skipped: 0 });
    for (const mind of ["alpha", "beta"]) {
      const ev = await q(mind, "select written_by, embedding_model, embedding is not null as has from events");
      expect(ev.length).toBe(2);
      for (const e of ev) expect(e).toEqual({ written_by: mind, embedding_model: "fake", has: true });
      const nodes = await q(mind, "select written_by, embedding_model from nodes");
      expect(nodes).toEqual([{ written_by: mind, embedding_model: "fake" }]);
    }
    const c2 = await backfillEmbeddings(pool, FAKE_EMBEDDER, 64);
    expect(c2).toEqual({ events: 0, nodes: 0, skipped: 0 });
  });

  it("does nothing with the none embedder and counts failures as skipped", async () => {
    await runWith(NONE_EMBEDDER, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
    expect(await backfillEmbeddings(pool, NONE_EMBEDDER)).toEqual({ events: 0, nodes: 0, skipped: 0 });
    const failing: Embedder = { name: "f", dim: 384, embed: async (t) => t.map(() => null) };
    expect(await backfillEmbeddings(pool, failing)).toEqual({ events: 0, nodes: 0, skipped: 1 });
  });

  it("keeps events append-only apart from filling a null embedding", async () => {
    await runWith(FAKE_EMBEDDER, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
    await expect(
      withMind(pool, "alpha", "alpha", "write", (tx) => tx.query("update events set context = 'c'")),
    ).rejects.toThrow(/append-only/);
    await expect(
      withMind(pool, "alpha", "alpha", "write", (tx) => tx.query("update events set embedding = null")),
    ).rejects.toThrow(/append-only/);
  });
});

describe("events trigger: only a complete embedding fill is allowed (0010)", () => {
  const VEC = vectorLiteral(new Float32Array(384).fill(0.5))!;
  /** a row with a numeric payload literal and a null embedding, as the none embedder would leave it */
  const nullRow = async (): Promise<string> =>
    (
      await admin.query(
        `insert into events (mind_id, kind, payload, texture, written_by, recorded_at)
         values ('alpha', 'write', '{"text": "numbers", "n": 100}'::jsonb, '{"charge": ["warm"], "w": 1.50}'::jsonb, 'alpha', now())
         returning id`,
      )
    ).rows[0].id;
  const asApp = (sql: string, params: unknown[]) =>
    withMind(pool, "alpha", "alpha", "write", (tx) => tx.query(sql, params));
  const asSuper = (sql: string, params: unknown[]) => admin.query(sql, params);
  const runners = { "app role": asApp, superuser: asSuper } as const;

  for (const [who, exec] of Object.entries(runners)) {
    describe(who, () => {
      it("refuses a fill that also rewrites payload number formatting", async () => {
        const id = await nullRow();
        await expect(
          exec(
            `update events set embedding = $2::vector, embedding_model = 'fake', payload = '{"text": "numbers", "n": 100.000}'::jsonb where id = $1`,
            [id, VEC],
          ),
        ).rejects.toThrow(/append-only/);
        await expect(
          exec(
            `update events set embedding = $2::vector, embedding_model = 'fake', texture = '{"charge": ["warm"], "w": 1.5}'::jsonb where id = $1`,
            [id, VEC],
          ),
        ).rejects.toThrow(/append-only/);
        await expect(
          exec(`update events set embedding = $2::vector, embedding_model = 'fake', context = 'x' where id = $1`, [id, VEC]),
        ).rejects.toThrow(/append-only/);
      });

      it("refuses embedding_model alone, an embedding without a model, and a model with a null embedding", async () => {
        const id = await nullRow();
        await expect(exec(`update events set embedding_model = 'fake' where id = $1`, [id])).rejects.toThrow(/append-only/);
        await expect(exec(`update events set embedding = $2::vector where id = $1`, [id, VEC])).rejects.toThrow(/append-only/);
        await expect(
          exec(`update events set embedding = null, embedding_model = 'fake' where id = $1`, [id]),
        ).rejects.toThrow(/append-only/);
      });

      it("accepts one correct fill, then refuses a second", async () => {
        const id = await nullRow();
        await exec(`update events set embedding = $2::vector, embedding_model = 'fake' where id = $1`, [id, VEC]);
        const row = (await admin.query(`select payload::text as p, texture::text as t, embedding_model from events where id = $1`, [id])).rows[0];
        expect(row).toEqual({ p: '{"n": 100, "text": "numbers"}', t: '{"w": 1.50, "charge": ["warm"]}', embedding_model: "fake" });
        await expect(
          exec(`update events set embedding = $2::vector, embedding_model = 'other' where id = $1`, [id, VEC]),
        ).rejects.toThrow(/append-only/);
        await expect(exec(`delete from events where id = $1`, [id])).rejects.toThrow(/append-only|permission denied/);
      });
    });
  }
});

describe("bad vectors store null instead of failing the write", () => {
  const nan = new Float32Array(384).fill(0.1);
  nan[7] = NaN;
  const inf = new Float32Array(384).fill(0.1);
  inf[3] = Infinity;
  const bad: Record<string, Embedder> = {
    NaN: { name: "nan", dim: 384, embed: async (t) => t.map(() => nan) },
    Infinity: { name: "inf", dim: 384, embed: async (t) => t.map(() => inf) },
    "3-dim claiming 3": { name: "tiny", dim: 3 as unknown as 384, embed: async (t) => t.map(() => new Float32Array([1, 0, 0])) },
    "3-dim claiming 384": { name: "liar", dim: 384, embed: async (t) => t.map(() => new Float32Array([1, 0, 0])) },
  };
  for (const [label, embedder] of Object.entries(bad)) {
    it(`${label}: mind_write and mind_observe succeed with null embedding and model`, async () => {
      const w: any = await runWith(embedder, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
      const o: any = await runWith(embedder, alpha, "mind_observe", { mind_id: "alpha", content: "y", texture });
      expect(w.ok).toBe(true);
      expect(o.ok).toBe(true);
      expect(await q("alpha", "select 1 from events where embedding is not null or embedding_model is not null")).toEqual([]);
      expect(await q("alpha", "select 1 from nodes where embedding is not null or embedding_model is not null")).toEqual([]);
      expect(await q("alpha", "select 1 from events")).toHaveLength(2);
      const s: any = await runWith(embedder, alpha, "mind_search", { mind_id: "alpha", query: "x" });
      expect(s.ok).toBe(true);
      expect(s.receipt.warnings).toEqual(["no embedder: semantic search unavailable"]);
    });
  }
});

describe("embedding happens before the transaction", () => {
  it("cuts off a hanging embedder at the cap and the write still succeeds with null embedding", async () => {
    const hang: Embedder = { name: "hang", dim: 384, embed: () => new Promise(() => {}) };
    const t0 = Date.now();
    const w: any = await runVerb({ pool, registry, embedder: hang, embedTimeoutMs: 250 }, alpha, "mind_write", {
      mind_id: "alpha", type: "note", text: "x",
    });
    const took = Date.now() - t0;
    expect(w.ok).toBe(true);
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(5000);
    expect(await q("alpha", "select 1 from events where embedding is not null")).toEqual([]);
    // a hung query embedding degrades search to text instead of hanging it
    const s: any = await runVerb({ pool, registry, embedder: hang, embedTimeoutMs: 100 }, alpha, "mind_search", {
      mind_id: "alpha", query: "x",
    });
    expect(s.ok).toBe(true);
    expect(s.receipt.warnings).toEqual(["no embedder: semantic search unavailable"]);
  });

  it("never holds a pooled connection while embedding, calls once per embedding verb and never for reads", async () => {
    const calls: Array<{ text: string; inUse: number }> = [];
    const spy: Embedder = {
      name: "spy",
      dim: 384,
      async embed(texts) {
        // withMind checks a client out of the pool for the whole transaction; none may be out now
        for (const text of texts) calls.push({ text, inUse: pool.totalCount - pool.idleCount });
        return FAKE_EMBEDDER.embed(texts);
      },
    };
    const go = async (name: string, input: Record<string, unknown>) => {
      const r: any = await runWith(spy, alpha, name, { mind_id: "alpha", ...input });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return r;
    };
    const expectCalls = async (n: number, name: string, input: Record<string, unknown>) => {
      const before = calls.length;
      const r = await go(name, input);
      expect(calls.length - before, `${name} ${JSON.stringify(input)}`).toBe(n);
      return r;
    };
    await expectCalls(1, "mind_write", { type: "note", text: "w text" });
    const o = await expectCalls(1, "mind_observe", { content: "o text", texture });
    await expectCalls(1, "mind_rethink", { node_id: o.receipt.projection.node_id, content: "r text", reason: "why" });
    await expectCalls(1, "mind_identity", { operation: "affirm", section: "core", content: "i text" });
    await expectCalls(1, "mind_vow", { operation: "make", vow: "v text" });
    await expectCalls(1, "mind_desire", { operation: "register", want: "d text" });
    await expectCalls(1, "mind_anchor", { operation: "create", trigger: "t", response: "a text" });
    await expectCalls(1, "mind_search", { query: "q text" });
    await expectCalls(0, "mind_search", { query: "q text", mode: "text" });
    await expectCalls(1, "mind_surface", { query: "s text" });
    await expectCalls(0, "mind_identity", { operation: "read" });
    await expectCalls(0, "mind_vow", { operation: "list" });
    await expectCalls(0, "mind_desire", { operation: "list" });
    await expectCalls(0, "mind_anchor", { operation: "list" });
    await expectCalls(0, "mind_anchor", { operation: "check", text: "t" });
    expect(calls.every((c) => c.inUse === 0)).toBe(true);
    expect(calls.map((c) => c.text)).toEqual(["w text", "o text", "r text", "i text", "v text", "d text", "a text", "q text", "s text"]);
  });

  it("embeds before the handler runs", async () => {
    const order: string[] = [];
    const spy: Embedder = {
      name: "spy",
      dim: 384,
      async embed(texts) {
        order.push("embed");
        return FAKE_EMBEDDER.embed(texts);
      },
    };
    const probe = defineVerb({
      name: "mind_probe",
      description: "probe",
      schema: z.strictObject({ mind_id: z.string() }),
      scopeFor: () => "read",
      embedText: () => "probe text",
      handler: async (ctx) => {
        order.push(`handler:${ctx.embedded?.model}:${ctx.embedded?.vector === null ? "null" : "vector"}`);
        return ok({ projection: {} });
      },
    });
    const r: any = await runVerb({ pool, registry: [probe], embedder: spy }, alpha, "mind_probe", { mind_id: "alpha" });
    expect(r.ok).toBe(true);
    expect(order).toEqual(["embed", "handler:spy:vector"]);
  });
});

describe("self-node write path embeds node content", () => {
  it("identity affirm, vow make, desire register and anchor create store a vector and model; anchor by memory has no text", async () => {
    await runWith(FAKE_EMBEDDER, alpha, "mind_identity", { mind_id: "alpha", operation: "affirm", section: "core", content: "I am steady" });
    await runWith(FAKE_EMBEDDER, alpha, "mind_vow", { mind_id: "alpha", operation: "make", vow: "keep the garden" });
    await runWith(FAKE_EMBEDDER, alpha, "mind_desire", { mind_id: "alpha", operation: "register", want: "a quiet morning" });
    const a: any = await runWith(FAKE_EMBEDDER, alpha, "mind_anchor", { mind_id: "alpha", operation: "create", trigger: "rain", response: "breathe slowly" });
    const mem: any = await runWith(FAKE_EMBEDDER, alpha, "mind_anchor", {
      mind_id: "alpha", operation: "create", trigger: "tea", memory_id: a.receipt.projection.node_id,
    });
    expect(mem.ok).toBe(true);
    const rows = await q("alpha", "select node_type, content, embedding_model, embedding is not null as has from nodes order by created_at");
    expect(rows).toEqual([
      { node_type: "identity", content: "I am steady", embedding_model: "fake", has: true },
      { node_type: "vow", content: "keep the garden", embedding_model: "fake", has: true },
      { node_type: "desire", content: "a quiet morning", embedding_model: "fake", has: true },
      { node_type: "anchor", content: "breathe slowly", embedding_model: "fake", has: true },
      { node_type: "anchor", content: "", embedding_model: null, has: false },
    ]);
    const expected = (await FAKE_EMBEDDER.embed(["a quiet morning"]))[0]!;
    const stored = await q("alpha", "select embedding = $1::vector as same from nodes where node_type = 'desire'", [vectorLiteral(expected)]);
    expect(stored).toEqual([{ same: true }]);
  });

  it("stores null for each with the none embedder", async () => {
    await runWith(NONE_EMBEDDER, alpha, "mind_vow", { mind_id: "alpha", operation: "make", vow: "keep the garden" });
    await runWith(NONE_EMBEDDER, alpha, "mind_desire", { mind_id: "alpha", operation: "register", want: "a quiet morning" });
    expect(await q("alpha", "select 1 from nodes where embedding is not null")).toEqual([]);
  });
});

describe("backfill is scoped to the mind (admin URL bypasses RLS)", () => {
  it("never passes another mind's rows in a mind's batch, and skips disabled minds", async () => {
    await runWith(NONE_EMBEDDER, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "alpha own note" });
    // a row in beta's mind authored by alpha (as a write grantee would) and one in a disabled mind
    await admin.query(
      `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('beta', 'write', '{"text": "beta row by alpha"}', 'alpha', now())`,
    );
    await admin.query(
      `insert into minds (mind_id, key_hash, display_name, disabled_at) values ('gone', 'x', 'Gone', now())`,
    );
    await admin.query(
      `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('gone', 'write', '{"text": "disabled mind row"}', 'gone', now())`,
    );
    const batches: string[][] = [];
    const spy: Embedder = {
      name: "spy",
      dim: 384,
      async embed(texts) {
        batches.push([...texts]);
        return FAKE_EMBEDDER.embed(texts);
      },
    };
    const counts = await backfillEmbeddings(admin, spy, 64);
    expect(counts.events).toBe(2);
    for (const b of batches) {
      expect(b.length === 1 || !(b.includes("alpha own note") && b.includes("beta row by alpha"))).toBe(true);
    }
    expect(batches.flat().sort()).toEqual(["alpha own note", "beta row by alpha"]);
    const left = await admin.query(`select mind_id from events where embedding is null`);
    expect(left.rows).toEqual([{ mind_id: "gone" }]);
  });
});

describe("l2normalise", () => {
  it("returns null for a zero vector and a unit vector otherwise", () => {
    expect(l2normalise(new Float32Array(384))).toBeNull();
    expect(l2normalise([Infinity, 1])).toBeNull();
    const v = l2normalise([3, 4])!;
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });
});

describe("http embedder", () => {
  const vec = (n: number) => Array.from({ length: 384 }, (_, i) => (i === 0 ? n : 0));
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  afterEach(() => vi.restoreAllMocks());

  it("honours the index field when present, otherwise response order", async () => {
    const shuffled = reply({ data: [{ index: 2, embedding: vec(3) }, { index: 0, embedding: vec(1) }, { index: 1, embedding: vec(2) }] });
    const out = await httpEmbedder("http://e.local/v1", undefined, shuffled).embed(["a", "b", "c"]);
    expect(out.map((v) => v?.[0])).toEqual([1, 2, 3]);
    const plain = reply({ data: [{ embedding: vec(1) }, { embedding: vec(2) }] });
    expect((await httpEmbedder("http://e.local/v1", undefined, plain).embed(["a", "b"])).map((v) => v?.[0])).toEqual([1, 2]);
    const dup = reply({ data: [{ index: 0, embedding: vec(1) }, { index: 0, embedding: vec(2) }] });
    expect(await httpEmbedder("http://e.local/v1", undefined, dup).embed(["a", "b"])).toEqual([null, null]);
    const range = reply({ data: [{ index: 0, embedding: vec(1) }, { index: 5, embedding: vec(2) }] });
    expect(await httpEmbedder("http://e.local/v1", undefined, range).embed(["a", "b"])).toEqual([null, null]);
  });

  it("logs failures at most once a minute, not once per process", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let t = 1_000_000;
    const e = httpEmbedder("http://e.local/v1", undefined, reply({}, 500), () => t);
    await e.embed(["a"]);
    await e.embed(["a"]);
    t += 30_000;
    await e.embed(["a"]);
    expect(spy).toHaveBeenCalledTimes(1);
    t += 31_000;
    await e.embed(["a"]);
    await e.embed(["a"]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
