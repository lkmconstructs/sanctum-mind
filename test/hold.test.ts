import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { CHARGE_STATES, canTransition } from "../src/verbs/charge.js";
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

const newNode = async (): Promise<string> => {
  const r: any = await run(alpha, "mind_observe", {
    mind_id: "alpha",
    content: "something held",
    texture: { charge: ["warm"] },
  });
  return r.receipt.projection.node_id;
};
const newEvent = async (): Promise<string> => {
  const r: any = await run(alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x" });
  return r.receipt.event_id;
};
const sit = (subject_id: string, extra: Record<string, unknown> = {}) =>
  run(alpha, "mind_sit", { mind_id: "alpha", subject_id, ...extra });
const resolve = (subject_id: string, extra: Record<string, unknown> = {}) =>
  run(alpha, "mind_resolve", { mind_id: "alpha", subject_id, ...extra });

describe("charge state machine", () => {
  it("lists states in forward order", () => {
    expect([...CHARGE_STATES]).toEqual(["fresh", "active", "processing", "metabolized", "deferred", "released"]);
  });

  const allowed = new Set([
    "fresh>active", "fresh>processing", "fresh>metabolized", "fresh>deferred", "fresh>released",
    "active>processing", "active>metabolized", "active>deferred", "active>released",
    "processing>metabolized", "processing>deferred", "processing>released",
  ]);
  for (const from of CHARGE_STATES) {
    for (const to of CHARGE_STATES) {
      it(`${from} -> ${to} is ${allowed.has(`${from}>${to}`) ? "allowed" : "refused"}`, () => {
        expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
      });
    }
  }
});

describe("mind_sit", () => {
  it("sits a node: event, holdings row and receipt", async () => {
    const node = await newNode();
    const r: any = await sit(node, { note: "turning it over" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toMatchObject({
      mind_id: "alpha", subject_id: node, subject_kind: "node", state: "active",
      note: "turning it over", last_event_id: r.receipt.event_id,
    });
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("sit");
    expect(ev.subject_id).toBe(node);
    expect(ev.written_by).toBe("alpha");
    expect(ev.payload).toEqual({ state: "active", note: "turning it over", subject_kind: "node" });
    const [h] = await q("alpha", "select * from holdings");
    expect(h.updated_at.getTime()).toBe(ev.created_at.getTime());
  });

  it("sits an event subject and defaults state to active", async () => {
    const e = await newEvent();
    const r: any = await sit(e);
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.subject_kind).toBe("event");
    expect(r.receipt.projection.state).toBe("active");
  });

  it("moves forward active -> processing", async () => {
    const node = await newNode();
    await sit(node);
    const r: any = await sit(node, { state: "processing" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.state).toBe("processing");
    expect(await count("alpha", "holdings")).toBe(1);
  });

  it("same state without a note is a no-op with no event", async () => {
    const node = await newNode();
    await sit(node);
    const before = await count("alpha", "events");
    const r: any = await sit(node);
    expect(r.ok).toBe(true);
    expect(r.receipt.warnings).toEqual(["no-op"]);
    expect(r.receipt.event_id).toBeUndefined();
    expect(r.receipt.projection.state).toBe("active");
    expect(await count("alpha", "events")).toBe(before);
  });

  it("same state with a note annotates", async () => {
    const node = await newNode();
    await sit(node);
    const r: any = await sit(node, { note: "more thoughts" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.state).toBe("active");
    expect(r.receipt.projection.note).toBe("more thoughts");
    expect(r.receipt.projection.last_event_id).toBe(r.receipt.event_id);
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("sit.annotate");
    expect(ev.payload).toEqual({ note: "more thoughts" });
  });

  it("backward move is a conflict and persists nothing", async () => {
    const node = await newNode();
    await sit(node, { state: "processing" });
    const before = await count("alpha", "events");
    const r: any = await sit(node, { state: "active" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("conflict");
    expect(await count("alpha", "events")).toBe(before);
  });

  it("sitting a resolved subject is a conflict", async () => {
    const node = await newNode();
    await resolve(node);
    const r: any = await sit(node);
    expect(r.error.code).toBe("conflict");
  });

  it("unknown, invalidated and foreign subjects are not_found", async () => {
    const unknown: any = await sit("11111111-1111-4111-8111-111111111111");
    expect(unknown.error).toMatchObject({ code: "not_found", field: "subject_id" });

    const node = await newNode();
    await withMind(pool, "alpha", "alpha", "write", (tx) =>
      tx.query("update nodes set invalidated_at = now() where id = $1", [node]),
    );
    const inv: any = await sit(node);
    expect(inv.error).toMatchObject({ code: "not_found", field: "subject_id" });

    const foreign: any = await run(beta, "mind_write", { mind_id: "beta", type: "note", text: "mine" });
    const f: any = await sit(foreign.receipt.event_id);
    expect(f.error).toMatchObject({ code: "not_found", field: "subject_id" });
    expect(await count("alpha", "holdings")).toBe(0);
  });

  it("validates input and rejects unknown keys and NUL", async () => {
    const node = await newNode();
    const bad: any = await sit("not-a-uuid");
    expect(bad.error).toMatchObject({ code: "invalid_input", field: "subject_id" });
    const st: any = await sit(node, { state: "released" });
    expect(st.error).toMatchObject({ code: "invalid_input", field: "state" });
    const extra: any = await sit(node, { bogus: 1 });
    expect(extra.error).toMatchObject({ code: "invalid_input", field: "bogus" });
    const nul: any = await sit(node, { note: "a\u0000b" });
    expect(nul.error).toMatchObject({ code: "invalid_input", field: "note" });
  });

  it("read grantee is forbidden; RLS hides holdings from the other mind", async () => {
    const node = await newNode();
    await sit(node);
    const f: any = await run(beta, "mind_sit", { mind_id: "alpha", subject_id: node });
    expect(f.error.code).toBe("forbidden");
    expect(await count("alpha", "holdings")).toBe(1);
    expect(await q("beta", "select * from holdings")).toHaveLength(0);
    const viaWrongScope = await withMind(pool, "beta", "beta", "read", async (tx) =>
      (await tx.query("select * from holdings where mind_id = 'alpha'")).rows,
    );
    expect(viaWrongScope).toHaveLength(0);
  });

  it("concurrent sits end in one holdings row pointing at the newest event", async () => {
    const node = await newNode();
    const results: any[] = await Promise.all(
      Array.from({ length: 8 }, (_, i) => sit(node, { state: i % 2 === 0 ? "active" : "processing" })),
    );
    for (const r of results) {
      if (!r.ok) expect(r.error.code).toBe("conflict");
      else expect(r.receipt.warnings === undefined || r.receipt.warnings[0] === "no-op").toBe(true);
      expect(r.ok === false && r.error.code === "storage").toBe(false);
    }
    expect(results.some((r) => r.ok && r.receipt.warnings === undefined)).toBe(true);
    const rows = await q("alpha", "select * from holdings where subject_id = $1", [node]);
    expect(rows).toHaveLength(1);
    const [latest] = await q(
      "alpha",
      "select id from events where subject_id = $1 order by seq desc limit 1",
      [node],
    );
    expect(rows[0].last_event_id).toBe(latest.id);
  });
});

describe("mind_resolve", () => {
  it("defaults to metabolized and records the event", async () => {
    const node = await newNode();
    await sit(node);
    const r: any = await resolve(node, { resolution_note: "done with it" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toMatchObject({ state: "metabolized", note: "done with it", subject_kind: "node" });
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("resolve");
    expect(ev.subject_id).toBe(node);
    expect(ev.payload).toEqual({ outcome: "metabolized", resolution_note: "done with it", subject_kind: "node" });
  });

  it("resolves straight from fresh to deferred and released", async () => {
    const a = await newNode();
    const b = await newEvent();
    expect(((await resolve(a, { outcome: "deferred" })) as any).receipt.projection.state).toBe("deferred");
    expect(((await resolve(b, { outcome: "released" })) as any).receipt.projection.state).toBe("released");
  });

  it("a terminal state accepts no further resolve", async () => {
    const node = await newNode();
    await resolve(node, { outcome: "deferred" });
    const before = await count("alpha", "events");
    const r: any = await resolve(node, { outcome: "released" });
    expect(r.error.code).toBe("conflict");
    expect(await count("alpha", "events")).toBe(before);
  });

  it("not_found, invalid outcome and forbidden", async () => {
    const nf: any = await resolve("11111111-1111-4111-8111-111111111111");
    expect(nf.error).toMatchObject({ code: "not_found", field: "subject_id" });
    const node = await newNode();
    const bad: any = await resolve(node, { outcome: "active" });
    expect(bad.error).toMatchObject({ code: "invalid_input", field: "outcome" });
    const f: any = await run(beta, "mind_resolve", { mind_id: "alpha", subject_id: node });
    expect(f.error.code).toBe("forbidden");
    expect(await count("alpha", "holdings")).toBe(0);
  });
});

describe("mind_loop", () => {
  const loop = (extra: Record<string, unknown>) => run(alpha, "mind_loop", { mind_id: "alpha", ...extra });

  it("creates a loop with event and projection", async () => {
    const r: any = await loop({ operation: "create", label: "call back", context: "work" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toMatchObject({
      mind_id: "alpha", label: "call back", urgency: "nagging", context: "work",
      created_event_id: r.receipt.event_id, resolved_at: null,
    });
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("loop.create");
    expect(ev.payload).toEqual({ label: "call back", urgency: "nagging", context: "work" });
    expect(r.receipt.projection.created_at.getTime()).toBe(ev.created_at.getTime());
  });

  it("requires label for create and loop_id for resolve", async () => {
    const a: any = await loop({ operation: "create" });
    expect(a.error).toMatchObject({ code: "invalid_input", field: "label" });
    const b: any = await loop({ operation: "resolve" });
    expect(b.error).toMatchObject({ code: "invalid_input", field: "loop_id" });
    const c: any = await loop({ operation: "list", limit: 0 });
    expect(c.error).toMatchObject({ code: "invalid_input", field: "limit" });
  });

  it("resolves a loop; resolving again is a conflict; unknown is not_found", async () => {
    const c: any = await loop({ operation: "create", label: "x" });
    const id = c.receipt.projection.id;
    const r: any = await loop({ operation: "resolve", loop_id: id, resolution: "settled" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toMatchObject({ resolution: "settled", resolved_event_id: r.receipt.event_id });
    expect(r.receipt.projection.resolved_at).toBeInstanceOf(Date);
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("loop.resolve");
    expect(ev.subject_id).toBe(id);
    const before = await count("alpha", "events");
    const again: any = await loop({ operation: "resolve", loop_id: id });
    expect(again.error.code).toBe("conflict");
    expect(await count("alpha", "events")).toBe(before);
    const nf: any = await loop({ operation: "resolve", loop_id: "11111111-1111-4111-8111-111111111111" });
    expect(nf.error).toMatchObject({ code: "not_found", field: "loop_id" });
  });

  it("lists burning first then oldest first; include_resolved and limit", async () => {
    const mk = async (label: string, urgency: string) =>
      ((await loop({ operation: "create", label, urgency })) as any).receipt.projection.id as string;
    const n1 = await mk("n1", "nagging");
    const b1 = await mk("b1", "burning");
    const n2 = await mk("n2", "nagging");
    const b2 = await mk("b2", "burning");
    const list: any = await loop({ operation: "list" });
    expect(list.receipt.event_id).toBeUndefined();
    expect(list.receipt.projection.loops.map((l: any) => l.label)).toEqual(["b1", "b2", "n1", "n2"]);
    await loop({ operation: "resolve", loop_id: b1 });
    const open: any = await loop({ operation: "list" });
    expect(open.receipt.projection.loops.map((l: any) => l.id)).toEqual([b2, n1, n2]);
    const all: any = await loop({ operation: "list", include_resolved: true });
    expect(all.receipt.projection.loops.map((l: any) => l.id)).toEqual([b1, b2, n1, n2]);
    const lim: any = await loop({ operation: "list", limit: 2 });
    expect(lim.receipt.projection.loops).toHaveLength(2);
  });

  it("read grantee can list but not create or resolve; RLS hides loops", async () => {
    const c: any = await loop({ operation: "create", label: "private" });
    const l: any = await run(beta, "mind_loop", { mind_id: "alpha", operation: "list" });
    expect(l.ok).toBe(true);
    expect(l.receipt.projection.loops).toHaveLength(1);
    const f: any = await run(beta, "mind_loop", { mind_id: "alpha", operation: "create", label: "nope" });
    expect(f.error.code).toBe("forbidden");
    const g: any = await run(beta, "mind_loop", { mind_id: "alpha", operation: "resolve", loop_id: c.receipt.projection.id });
    expect(g.error.code).toBe("forbidden");
    expect(await count("alpha", "loops")).toBe(1);
    expect(await q("beta", "select * from loops")).toHaveLength(0);
  });
});
