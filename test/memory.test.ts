// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { NONE_EMBEDDER } from "../src/embed/none.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import type { Caller } from "../src/verbs/types.js";

const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: { alpha: ["read"] } };

let pool: Pool;
const run = (caller: Caller, name: string, input: unknown) =>
  runVerb({ pool, registry }, caller, name, input);

const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const count = async (mind: string, table: string) =>
  Number((await q(mind, `select count(*) as n from ${table}`))[0].n);

beforeEach(async () => {
  if (pool) await closePool(pool);
  const admin = await resetDatabase();
  await closePool(admin);
  pool = appPool();
});

afterAll(async () => {
  if (pool) await closePool(pool);
});

const texture = { charge: ["warm"], salience: "active", somatic: "chest" };
const observe = (extra: Record<string, unknown> = {}) =>
  run(alpha, "mind_observe", { mind_id: "alpha", content: "a thing happened", texture, ...extra });

describe("mind_write", () => {
  it("returns a receipt and writes the event row", async () => {
    const r: any = await run(alpha, "mind_write", {
      mind_id: "alpha",
      type: "journal",
      text: "hello",
      tags: ["a", "b"],
      texture: { vividness: "vivid", charge: ["calm"] },
      context: "lane-a",
    });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.event_id).toBe(r.receipt.event_id);
    expect(typeof r.receipt.projection.seq).toBe("string");
    expect(r.receipt.projection.created_at).toBeInstanceOf(Date);
    const [ev] = await q("alpha", "select * from events");
    expect(ev.kind).toBe("write");
    expect(ev.written_by).toBe("alpha");
    expect(ev.context).toBe("lane-a");
    expect(ev.texture).toEqual({ vividness: "vivid", charge: ["calm"] });
    expect(ev.payload).toEqual({ type: "journal", text: "hello", tags: ["a", "b"] });
    expect(ev.event_time_start).toBeNull();
    expect(await count("alpha", "nodes")).toBe(0);
  });

  it("persists event_time columns, end defaulting to start, and text in payload", async () => {
    await run(alpha, "mind_write", {
      mind_id: "alpha", type: "episodic", text: "x",
      event_time: { start: "2026-01-02T00:00:00.000Z", granularity: "day", text: "new year-ish" },
    });
    await run(alpha, "mind_write", {
      mind_id: "alpha", type: "episodic", text: "y",
      event_time: { start: "2026-01-02T00:00:00.000Z", end: "2026-01-05T00:00:00.000Z" },
      recorded_at: "2026-02-01T00:00:00.000Z",
    });
    const rows = await q("alpha", "select * from events order by seq");
    expect(rows[0].event_time_start.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(rows[0].event_time_end.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(rows[0].event_time_granularity).toBe("day");
    expect(rows[0].payload.event_time_text).toBe("new year-ish");
    expect(rows[1].event_time_end.toISOString()).toBe("2026-01-05T00:00:00.000Z");
    expect(rows[1].event_time_granularity).toBeNull();
    expect(rows[1].recorded_at.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("rejects end before start", async () => {
    const r: any = await run(alpha, "mind_write", {
      mind_id: "alpha", type: "note", text: "x",
      event_time: { start: "2026-01-05T00:00:00.000Z", end: "2026-01-02T00:00:00.000Z" },
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("event_time.end");
    expect(await count("alpha", "events")).toBe(0);
  });

  it("rejects invalid dates, unknown keys and NUL", async () => {
    const base = { mind_id: "alpha", type: "note", text: "x" };
    for (const bad of [
      { ...base, recorded_at: "yesterday" },
      { ...base, event_time: { start: "nope" } },
      { ...base, bogus: 1 },
      { ...base, text: "a\u0000b" },
      { ...base, texture: { charge: ["a"], extra: 1 } },
    ]) {
      const r: any = await run(alpha, "mind_write", bad);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("invalid_input");
    }
    expect(await count("alpha", "events")).toBe(0);
  });

  it("read-only grantee is forbidden and writes nothing", async () => {
    const r: any = await run(beta, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("forbidden");
    expect(await count("alpha", "events")).toBe(0);
  });

  it("RLS hides the event from the other mind", async () => {
    await run(alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
    expect(await count("beta", "events")).toBe(0);
  });
});

describe("mind_observe", () => {
  it("returns a receipt, writes the event and the node", async () => {
    const r: any = await observe({
      context: "lane-b",
      event_time: { start: "2026-03-01T00:00:00.000Z", granularity: "month" },
    });
    expect(r.ok).toBe(true);
    const p = r.receipt.projection;
    expect(p.event_id).toBe(r.receipt.event_id);
    expect(p.edges).toEqual([]);
    const [ev] = await q("alpha", "select * from events");
    expect(ev.kind).toBe("observe");
    expect(ev.written_by).toBe("alpha");
    expect(ev.texture).toEqual(texture);
    expect(ev.context).toBe("lane-b");
    expect(ev.event_time_granularity).toBe("month");
    expect(ev.payload.content).toBe("a thing happened");
    const [n] = await q("alpha", "select * from nodes");
    expect(n.id).toBe(p.node_id);
    expect(n.node_type).toBe("observation");
    expect(n.source_type).toBe("extracted");
    expect(n.confidence).toBe(1);
    expect(n.written_by).toBe("alpha");
    expect(n.metadata).toEqual({ texture, event_id: ev.id, context: "lane-b" });
    expect(n.recorded_at.toISOString()).toBe(ev.recorded_at.toISOString());
    expect(n.event_time_start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(n.event_time_granularity).toBe("month");
  });

  it("defaults the label to the first 120 chars, single-spaced", async () => {
    const content = "word\n\n  spaced   ".repeat(40);
    const r: any = await observe({ content });
    expect(r.ok).toBe(true);
    const [n] = await q("alpha", "select label from nodes");
    expect(n.label.length).toBeLessThanOrEqual(120);
    expect(n.label).not.toMatch(/\s{2}|\n/);
    expect(n.label).toBe(content.replace(/\s+/g, " ").trim().slice(0, 120));
    const r2: any = await observe({ label: "custom" });
    expect(r2.ok).toBe(true);
  });

  it("missing charge is invalid_input at texture.charge", async () => {
    for (const t of [{ salience: "active" }, { charge: [] }]) {
      const r: any = await observe({ texture: t });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("invalid_input");
      expect(r.error.field).toBe("texture.charge");
    }
    expect(await count("alpha", "events")).toBe(0);
  });

  it("rejects unknown keys, NUL and bad linked_to ids", async () => {
    for (const bad of [{ bogus: 1 }, { content: "a\u0000" }, { linked_to: ["not-a-uuid"] }]) {
      const r: any = await observe(bad);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("invalid_input");
    }
  });

  it("linked_to a live node creates exactly one edge", async () => {
    const a: any = await observe();
    const b: any = await observe({ linked_to: [a.receipt.projection.node_id] });
    expect(b.ok).toBe(true);
    expect(b.receipt.projection.edges).toHaveLength(1);
    const edges = await q("alpha", "select * from edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe(b.receipt.projection.edges[0]);
    expect(edges[0].edge_type).toBe("related_to");
    expect(edges[0].source_node_id).toBe(b.receipt.projection.node_id);
    expect(edges[0].target_node_id).toBe(a.receipt.projection.node_id);
    expect(edges[0].weight).toBe(0.5);
    expect(edges[0].confidence).toBe(1);
    expect(edges[0].written_by).toBe("alpha");
    expect(edges[0].metadata).toEqual({ event_id: b.receipt.event_id });
  });

  it("linked_to an unknown node is not_found and persists nothing", async () => {
    const before = await count("alpha", "events");
    const r: any = await observe({ linked_to: ["11111111-1111-4111-8111-111111111111"] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("not_found");
    expect(r.error.field).toBe("linked_to");
    expect(await count("alpha", "events")).toBe(before);
    expect(await count("alpha", "nodes")).toBe(0);
    expect(await count("alpha", "edges")).toBe(0);
  });

  it("linked_to an invalidated node is not_found and persists nothing", async () => {
    const a: any = await observe();
    await withMind(pool, "alpha", "alpha", "write", async (tx) => {
      await tx.query("update nodes set invalidated_at = now() where id = $1", [a.receipt.projection.node_id]);
    });
    const before = await count("alpha", "events");
    const r: any = await observe({ linked_to: [a.receipt.projection.node_id] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("not_found");
    expect(await count("alpha", "events")).toBe(before);
    expect(await count("alpha", "nodes")).toBe(1);
    expect(await count("alpha", "edges")).toBe(0);
  });

  it("read-only grantee is forbidden and writes nothing", async () => {
    const r: any = await run(beta, "mind_observe", { mind_id: "alpha", content: "x", texture });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("forbidden");
    expect(await count("alpha", "events")).toBe(0);
    expect(await count("alpha", "nodes")).toBe(0);
  });

  it("RLS hides the node and edge from the other mind, and linking across minds fails", async () => {
    const a: any = await observe();
    await observe({ linked_to: [a.receipt.projection.node_id] });
    expect(await count("beta", "nodes")).toBe(0);
    expect(await count("beta", "edges")).toBe(0);
    expect(await count("beta", "events")).toBe(0);
    const r: any = await run(beta, "mind_observe", {
      mind_id: "beta", content: "x", texture, linked_to: [a.receipt.projection.node_id],
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("not_found");
  });
});

const text = (mind: string, sql: string, params: unknown[] = []) => q<any>(mind, sql, params);

describe("unicode and blank input", () => {
  it("mind_observe truncates the derived label by code points and stays well-formed", async () => {
    const content = "a".repeat(119) + "\u{1F600}" + "tail";
    const r: any = await observe({ content });
    expect(r.ok).toBe(true);
    const [n] = await q("alpha", "select label from nodes");
    expect(n.label).toBe("a".repeat(119) + "\u{1F600}");
    expect(n.label.isWellFormed()).toBe(true);
    const [ev] = await q("alpha", "select payload from events");
    expect(ev.payload.label).toBe(n.label);
  });

  it("a lone surrogate in any text field is invalid_input", async () => {
    for (const bad of ["a\uD800b", "\uDC00", "tail\uD83D"]) {
      const r1: any = await observe({ content: bad });
      expect(r1.ok).toBe(false);
      expect(r1.error.code).toBe("invalid_input");
      expect(r1.error.field).toBe("content");
      const r2: any = await run(alpha, "mind_write", { mind_id: "alpha", type: "note", text: bad });
      expect(r2.ok).toBe(false);
      expect(r2.error.code).toBe("invalid_input");
      expect(r2.error.field).toBe("text");
    }
    expect(await count("alpha", "events")).toBe(0);
  });

  it("blank content, an empty label and blank charge entries are invalid_input", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ content: "   \n\t " }, "content"],
      [{ content: "" }, "content"],
      [{ label: "" }, "label"],
      [{ label: "   " }, "label"],
      [{ texture: { charge: [" "] } }, "texture.charge.0"],
    ];
    for (const [extra, field] of cases) {
      const r: any = await observe(extra);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("invalid_input");
      expect(r.error.field).toBe(field);
    }
    expect(await count("alpha", "events")).toBe(0);
  });

  it("an absent texture reports texture.charge", async () => {
    const r: any = await run(alpha, "mind_observe", { mind_id: "alpha", content: "x" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("texture.charge");
  });
});

describe("mind_observe linked_to", () => {
  it("dedupes case-insensitively and stores the deduped list", async () => {
    const a: any = await observe();
    const id: string = a.receipt.projection.node_id;
    const r: any = await observe({ linked_to: [id, id.toUpperCase(), id] });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.edges).toHaveLength(1);
    expect(await count("alpha", "edges")).toBe(1);
    const [ev] = await text("alpha", "select payload from events where id = $1", [r.receipt.event_id]);
    expect(ev.payload.linked_to).toEqual([id]);
  });

  it("locks the linked node row (for share) so a concurrent invalidation must wait", async () => {
    const a: any = await observe();
    const id: string = a.receipt.projection.node_id;
    const verb = registry.find((v) => v.name === "mind_observe")!;
    await withMind(pool, "alpha", "alpha", "write", async (tx) => {
      const ctx = { caller: alpha, mind_id: "alpha", tx, now: () => new Date(), registry, embedder: NONE_EMBEDDER, sinks: [], coolingMs: 0 };
      const res: any = await verb.handler(ctx, verb.schema.parse({ mind_id: "alpha", content: "x", texture, linked_to: [id] }));
      expect(res.ok).toBe(true);
      // Transaction still open: another connection cannot invalidate the node meanwhile.
      await withMind(pool, "alpha", "alpha", "write", async (tx2) => {
        await tx2.query("set local lock_timeout = '300ms'");
        await expect(tx2.query("update nodes set invalidated_at = now() where id = $1", [id])).rejects.toMatchObject({
          code: "55P03",
        });
      });
    });
  });
});

describe("event_time and recorded_at", () => {
  const w = (extra: Record<string, unknown>) =>
    run(alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x", ...extra });
  const rejected = async (extra: Record<string, unknown>, field: string) => {
    const r: any = await w(extra);
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe(field);
  };

  it("keeps microseconds and rejects sub-millisecond end before start", async () => {
    await rejected(
      { event_time: { start: "2026-01-01T00:00:00.000500Z", end: "2026-01-01T00:00:00.000400Z" } },
      "event_time.end",
    );
    const r: any = await w({ event_time: { start: "2026-01-01T00:00:00.000123Z", end: "2026-01-01T00:00:00.000124Z" } });
    expect(r.ok).toBe(true);
    const [row] = await q("alpha", "select event_time_start::text as s, event_time_end::text as e from events");
    expect(row.s).toMatch(/00:00:00\.000123\+00$/);
    expect(row.e).toMatch(/00:00:00\.000124\+00$/);
  });

  it("accepts 0 to 6 fractional digits and rejects 7", async () => {
    for (const f of ["", ".1", ".123", ".123456"]) {
      expect(((await w({ recorded_at: `2026-01-01T00:00:00${f}Z` })) as any).ok).toBe(true);
    }
    await rejected({ recorded_at: "2026-01-01T00:00:00.1234567Z" }, "recorded_at");
  });

  it("converts offsets to UTC before storage", async () => {
    const r: any = await w({
      recorded_at: "2026-01-01T05:30:00+05:30",
      event_time: { start: "2026-01-01T00:00:00-08:00" },
    });
    expect(r.ok).toBe(true);
    const [row] = await q("alpha", "select recorded_at, event_time_start, event_time_end from events");
    expect(row.recorded_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(row.event_time_start.toISOString()).toBe("2026-01-01T08:00:00.000Z");
    expect(row.event_time_end.toISOString()).toBe("2026-01-01T08:00:00.000Z");
  });

  it("compares end and start after offset conversion", async () => {
    await rejected(
      { event_time: { start: "2026-01-01T10:00:00+00:00", end: "2026-01-01T11:00:00+02:00" } },
      "event_time.end",
    );
  });

  it("bounds UTC years to 0001..9999 for start, end and recorded_at", async () => {
    await rejected({ recorded_at: "0000-12-31T23:59:59Z" }, "recorded_at");
    await rejected({ recorded_at: "10000-01-01T00:00:00Z" }, "recorded_at");
    await rejected({ recorded_at: "9999-12-31T23:59:59-05:00" }, "recorded_at");
    await rejected({ recorded_at: "0001-01-01T00:00:00+01:00" }, "recorded_at");
    await rejected({ event_time: { start: "0000-01-01" } }, "event_time.start");
    await rejected({ event_time: { start: "2026-01-01", end: "10000-01-01T00:00:00Z" } }, "event_time.end");
    const r: any = await w({ recorded_at: "0001-01-01T00:00:00Z", event_time: { start: "9999-12-31T23:59:59.999999Z" } });
    expect(r.ok).toBe(true);
  });

  it("date-only start and end mean day granularity at 00:00:00Z", async () => {
    const r: any = await w({ event_time: { start: "2026-03-04", end: "2026-03-06" } });
    expect(r.ok).toBe(true);
    const r2: any = await w({ event_time: { start: "2026-03-04", granularity: "month" } });
    expect(r2.ok).toBe(true);
    const r3: any = await w({ event_time: { start: "2026-03-04T12:00:00Z" } });
    expect(r3.ok).toBe(true);
    const rows = await q("alpha", "select * from events order by seq");
    expect(rows[0].event_time_start.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect(rows[0].event_time_end.toISOString()).toBe("2026-03-06T00:00:00.000Z");
    expect(rows[0].event_time_granularity).toBe("day");
    expect(rows[1].event_time_granularity).toBe("month");
    expect(rows[2].event_time_granularity).toBeNull();
    await rejected({ event_time: { start: "2026-03-04", end: "2026-03-03" } }, "event_time.end");
    await rejected({ event_time: { start: "2026-02-30" } }, "event_time.start");
  });

  it("mind_observe carries the same times to the node, including microseconds", async () => {
    const r: any = await observe({ event_time: { start: "2026-03-04T00:00:00.000001+01:00" } });
    expect(r.ok).toBe(true);
    const [n] = await q("alpha", "select event_time_start::text as s from nodes");
    expect(n.s).toMatch(/2026-03-03 23:00:00\.000001\+00$/);
  });
});
