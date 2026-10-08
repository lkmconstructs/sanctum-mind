// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { mind_relate } from "../src/verbs/mind_relate.js";
import { mind_letter } from "../src/verbs/mind_letter.js";
import { mind_link } from "../src/verbs/mind_link.js";
import { mind_observe } from "../src/verbs/mind_observe.js";
import type { Caller } from "../src/verbs/types.js";

const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const gamma: Caller = { bearer: "gamma", grants: {} };

let pool: Pool;
let admin: Pool;
let clock = new Date();
const registry = [mind_relate, mind_letter, mind_link, mind_observe];
const run = (caller: Caller, name: string, input: unknown) =>
  runVerb({ pool, registry, now: () => clock }, caller, name, input);

const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const count = async (mind: string, table: string) =>
  Number((await q(mind, `select count(*) as n from ${table}`))[0].n);

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  clock = new Date();
});

afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

const relate = (extra: Record<string, unknown>, caller = alpha) =>
  run(caller, "mind_relate", { mind_id: "alpha", ...extra });

describe("mind_relate", () => {
  it("set then read returns the row and history newest first", async () => {
    const s1: any = await relate({ operation: "set", subject: "river", state: "wary", intensity: 0.3 });
    expect(s1.ok).toBe(true);
    expect(s1.receipt.projection.relation).toMatchObject({ subject: "river", state: "wary", intensity: 0.3, cleared_at: null });
    const s2: any = await relate({ operation: "set", subject: "river", state: "warm", intensity: 0.8, note: "thawed" });
    const r: any = await relate({ operation: "read", subject: "river" });
    expect(r.receipt.event_id).toBeUndefined();
    expect(r.receipt.projection.relation).toMatchObject({ state: "warm", intensity: 0.8, note: "thawed", last_event_id: s2.receipt.event_id });
    expect(r.receipt.projection.history.map((e: any) => e.id)).toEqual([s2.receipt.event_id, s1.receipt.event_id]);
    expect(r.receipt.projection.history[0].kind).toBe("relate.set");
    const limited: any = await relate({ operation: "read", subject: "river", history_limit: 1 });
    expect(limited.receipt.projection.history).toHaveLength(1);
  });

  it("read without subject lists live relations newest first", async () => {
    await relate({ operation: "set", subject: "a", state: "x" });
    await relate({ operation: "set", subject: "b", state: "y" });
    const r: any = await relate({ operation: "read" });
    expect(r.receipt.projection.relations.map((x: any) => x.subject)).toEqual(["b", "a"]);
  });

  it("clear hides the row from read and the list; set after clear revives it", async () => {
    await relate({ operation: "set", subject: "river", state: "warm" });
    const c: any = await relate({ operation: "clear", subject: "river" });
    expect(c.ok).toBe(true);
    expect(c.receipt.projection.relation.cleared_at).toBeInstanceOf(Date);
    const one: any = await relate({ operation: "read", subject: "river" });
    expect(one.receipt.projection.relation).toBeNull();
    expect(one.receipt.projection.history.map((e: any) => e.kind)).toEqual(["relate.clear", "relate.set"]);
    const all: any = await relate({ operation: "read" });
    expect(all.receipt.projection.relations).toEqual([]);
    const again: any = await relate({ operation: "clear", subject: "river" });
    expect(again).toMatchObject({ ok: false, error: { code: "not_found", field: "subject" } });
    const missing: any = await relate({ operation: "clear", subject: "nothing" });
    expect(missing.error.code).toBe("not_found");
    await relate({ operation: "set", subject: "river", state: "new" });
    const back: any = await relate({ operation: "read", subject: "river" });
    expect(back.receipt.projection.relation).toMatchObject({ state: "new", cleared_at: null });
  });

  it("validates per operation", async () => {
    expect(await relate({ operation: "set", subject: "x" })).toMatchObject({ ok: false, error: { code: "invalid_input", field: "state" } });
    expect(await relate({ operation: "set", state: "x" })).toMatchObject({ ok: false, error: { field: "subject" } });
    expect(await relate({ operation: "clear" })).toMatchObject({ ok: false, error: { field: "subject" } });
    expect(await relate({ operation: "set", subject: "x", state: "y", intensity: 2 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("read grantee may read but not set; relate grantee may set", async () => {
    await relate({ operation: "set", subject: "river", state: "warm" });
    const read: any = await relate({ operation: "read", subject: "river" }, beta);
    expect(read.ok).toBe(true);
    const denied: any = await relate({ operation: "set", subject: "x", state: "y" }, beta);
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect((await relate({ operation: "clear", subject: "river" }, beta) as any).error.code).toBe("forbidden");

    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'relate')");
    const betaRelate: Caller = { bearer: "beta", grants: { alpha: ["read", "relate"] } };
    const set: any = await relate({ operation: "set", subject: "x", state: "y" }, betaRelate);
    expect(set.ok).toBe(true);
    const [ev] = await q("alpha", "select written_by, mind_id from events where id = $1", [set.receipt.event_id]);
    expect(ev).toEqual({ written_by: "beta", mind_id: "alpha" });
  });
});

const send = (extra: Record<string, unknown> = {}, caller = alpha, mind = "alpha") =>
  run(caller, "mind_letter", { mind_id: mind, operation: "send", to: "beta", body: "dear beta", subject: "hi", ...extra });
const inbox = (extra: Record<string, unknown> = {}) =>
  run(beta, "mind_letter", { mind_id: "beta", operation: "inbox", ...extra });
const readLetter = (caller: Caller, mind: string, letter_id: string) =>
  run(caller, "mind_letter", { mind_id: mind, operation: "read_letter", letter_id });

describe("mind_letter", () => {
  it("sends, shows in the recipient inbox without body, and recipient read marks read", async () => {
    const s: any = await send({ letter_type: "handoff" });
    expect(s.ok).toBe(true);
    const id = s.receipt.projection.letter.id;
    expect(s.receipt.projection.letter).toMatchObject({ to: "beta", letter_type: "handoff", subject: "hi", deliver_at: null });
    expect(s.receipt.projection.letter.body).toBeUndefined();
    expect(await count("beta", "events")).toBe(0);
    const [ev] = await q("alpha", "select kind, payload from events where id = $1", [s.receipt.event_id]);
    expect(ev.kind).toBe("letter.send");
    expect(ev.payload).toEqual({ to: "beta", letter_type: "handoff", subject: "hi", deliver_at: null });

    const box: any = await inbox();
    expect(box.receipt.event_id).toBeUndefined();
    expect(box.receipt.projection.letters).toHaveLength(1);
    expect(box.receipt.projection.letters[0]).toMatchObject({ id, from_mind: "alpha", subject: "hi" });
    expect(box.receipt.projection.letters[0].body).toBeUndefined();

    const r: any = await readLetter(beta, "beta", id);
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.letter).toMatchObject({ id, body: "dear beta", from_mind: "alpha" });
    expect(r.receipt.event_id).toBeDefined();
    expect(r.receipt.projection.event_id).toBe(r.receipt.event_id);
    const [rev] = await q("beta", "select kind, subject_id, payload, written_by from events");
    expect(rev).toMatchObject({ kind: "letter.read", subject_id: id, payload: { from: "alpha" }, written_by: "beta" });
    const [row] = await q("beta", "select read_at, read_event_id from letters where id = $1", [id]);
    expect(row.read_at).toBeInstanceOf(Date);
    expect(row.read_event_id).toBe(r.receipt.event_id);

    // second read writes nothing; inbox hides read unless include_read
    const r2: any = await readLetter(beta, "beta", id);
    expect(r2.ok).toBe(true);
    expect(r2.receipt.event_id).toBeUndefined();
    expect(await count("beta", "events")).toBe(1);
    expect(((await inbox()) as any).receipt.projection.letters).toHaveLength(0);
    expect(((await inbox({ include_read: true })) as any).receipt.projection.letters).toHaveLength(1);
  });

  it("sender reads own letter without writing an event or marking read", async () => {
    const s: any = await send();
    const id = s.receipt.projection.letter.id;
    const before = await count("alpha", "events");
    const r: any = await readLetter(alpha, "alpha", id);
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.letter.body).toBe("dear beta");
    expect(r.receipt.event_id).toBeUndefined();
    expect(await count("alpha", "events")).toBe(before);
    const [row] = await q("alpha", "select read_at from letters where id = $1", [id]);
    expect(row.read_at).toBeNull();
  });

  it("holds a future letter back until the time passes", async () => {
    const at = new Date(clock.getTime() + 3600_000);
    const s: any = await send({ deliver_at: at.toISOString() });
    const id = s.receipt.projection.letter.id;
    expect(((await inbox()) as any).receipt.projection.letters).toHaveLength(0);
    expect(await readLetter(beta, "beta", id)).toMatchObject({ ok: false, error: { code: "not_found", field: "letter_id" } });
    expect(await count("beta", "events")).toBe(0);
    // the sender can still see it
    expect(((await readLetter(alpha, "alpha", id)) as any).ok).toBe(true);
    clock = new Date(at.getTime() + 1000);
    expect(((await inbox()) as any).receipt.projection.letters).toHaveLength(1);
    expect(((await readLetter(beta, "beta", id)) as any).ok).toBe(true);
  });

  it("rejects self, unknown and disabled recipients, and bad input", async () => {
    expect(await send({ to: "alpha" })).toMatchObject({ ok: false, error: { code: "invalid_input", field: "to" } });
    expect(await send({ to: "nobody" })).toMatchObject({ ok: false, error: { code: "not_found", field: "to" } });
    await admin.query("update minds set disabled_at = now() where mind_id = 'beta'");
    expect(await send()).toMatchObject({ ok: false, error: { code: "not_found", field: "to" } });
    expect(await count("alpha", "events")).toBe(0);
    expect(await run(alpha, "mind_letter", { mind_id: "alpha", operation: "send", to: "beta" })).toMatchObject({ ok: false, error: { field: "body" } });
    expect(await run(alpha, "mind_letter", { mind_id: "alpha", operation: "send", body: "x" })).toMatchObject({ ok: false, error: { field: "to" } });
    expect(await run(alpha, "mind_letter", { mind_id: "alpha", operation: "read_letter" })).toMatchObject({ ok: false, error: { field: "letter_id" } });
  });

  it("sending as another mind needs the letter grant, not read", async () => {
    // beta holds only read on alpha
    expect(await send({ to: "beta" }, beta, "alpha")).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(((await run(beta, "mind_letter", { mind_id: "alpha", operation: "inbox" })) as any).ok).toBe(true);
    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'letter')");
    const letterBeta: Caller = { bearer: "beta", grants: { alpha: ["read", "letter"] } };
    // alpha sending to beta as alpha, written by beta
    const s: any = await send({}, letterBeta, "alpha");
    expect(s.ok).toBe(true);
    const [ev] = await q("alpha", "select written_by from events where id = $1", [s.receipt.event_id]);
    expect(ev.written_by).toBe("beta");
  });

  it("RLS: a third mind sees neither the relation nor the letter", async () => {
    await admin.query("insert into minds (mind_id, key_hash) values ('gamma', 'g-hash')");
    await relate({ operation: "set", subject: "river", state: "warm" });
    const s: any = await send();
    const id = s.receipt.projection.letter.id;
    expect(await count("gamma", "letters")).toBe(0);
    expect(await count("gamma", "relations")).toBe(0);
    expect(await count("alpha", "letters")).toBe(1);
    expect(await count("beta", "letters")).toBe(1);
    expect(await count("alpha", "relations")).toBe(1);
    expect(await count("beta", "relations")).toBe(0);
    expect(await readLetter(gamma, "gamma", id)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(((await run(gamma, "mind_letter", { mind_id: "gamma", operation: "inbox", include_read: true })) as any).receipt.projection.letters).toEqual([]);

    // raw SQL under the app role: gamma cannot update, and cannot insert as another sender
    await withMind(pool, "gamma", "gamma", "write", async (tx) => {
      const u = await tx.query("update letters set read_at = now() where id = $1", [id]);
      expect(u.rowCount).toBe(0);
    });
    await expect(
      withMind(pool, "gamma", "gamma", "write", async (tx) => {
        await tx.query(
          `insert into letters (from_mind, to_mind, letter_type, body, sent_event_id, sent_at)
           values ('alpha', 'beta', 'personal', 'spoofed', $1, now())`,
          [s.receipt.event_id],
        );
      }),
    ).rejects.toThrow();
    // the sender cannot mark the recipient's receipt either
    await withMind(pool, "alpha", "alpha", "write", async (tx) => {
      const u = await tx.query("update letters set read_at = now() where id = $1", [id]);
      expect(u.rowCount).toBe(0);
    });
    const [row] = await q("beta", "select read_at from letters where id = $1", [id]);
    expect(row.read_at).toBeNull();
  });
});

describe("mind_link", () => {
  const node = async (mind: "alpha" | "beta" = "alpha"): Promise<string> => {
    const caller = mind === "alpha" ? alpha : { bearer: "beta", grants: {} };
    const r: any = await run(caller, "mind_observe", { mind_id: mind, content: `c-${Math.random()}`, texture: { charge: ["warm"] } });
    return r.receipt.projection.node_id;
  };
  const link = (extra: Record<string, unknown>) => run(alpha, "mind_link", { mind_id: "alpha", ...extra });

  it("links two nodes with defaults and records the event", async () => {
    const a = await node();
    const b = await node();
    const r: any = await link({ source_id: a, target_id: b, note: "because" });
    expect(r.ok).toBe(true);
    const [e] = await q("alpha", "select * from edges where id = $1", [r.receipt.projection.edge_id]);
    expect(e).toMatchObject({ edge_type: "related_to", weight: 0.5, confidence: 1, written_by: "alpha", source_node_id: a, target_node_id: b });
    expect(e.metadata).toEqual({ note: "because", event_id: r.receipt.event_id });
    const [ev] = await q("alpha", "select kind from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("link");
  });

  it("rejects a self-link", async () => {
    const a = await node();
    expect(await link({ source_id: a, target_id: a })).toMatchObject({ ok: false, error: { code: "invalid_input", field: "target_id" } });
  });

  it("not_found for a missing or foreign node, naming the field", async () => {
    const a = await node();
    const foreign = await node("beta");
    expect(await link({ source_id: a, target_id: foreign })).toMatchObject({ ok: false, error: { code: "not_found", field: "target_id" } });
    expect(await link({ source_id: foreign, target_id: a })).toMatchObject({ ok: false, error: { code: "not_found", field: "source_id" } });
    expect(await link({ source_id: a, target_id: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ error: { field: "target_id" } });
    expect(await count("alpha", "edges")).toBe(0);
  });

  it("duplicate returns the existing edge with a warning and no new event; other type is new", async () => {
    const a = await node();
    const b = await node();
    const first: any = await link({ source_id: a, target_id: b, edge_type: "corrects" });
    const events = await count("alpha", "events");
    const dup: any = await link({ source_id: a, target_id: b, edge_type: "corrects", weight: 0.9 });
    expect(dup.ok).toBe(true);
    expect(dup.receipt.projection).toEqual({ edge_id: first.receipt.projection.edge_id, existing: true });
    expect(dup.receipt.warnings).toEqual(["exists"]);
    expect(dup.receipt.event_id).toBeUndefined();
    expect(await count("alpha", "events")).toBe(events);
    const other: any = await link({ source_id: a, target_id: b, edge_type: "references" });
    expect(other.receipt.projection.edge_id).not.toBe(first.receipt.projection.edge_id);
    const rev: any = await link({ source_id: b, target_id: a, edge_type: "corrects" });
    expect(rev.receipt.projection.existing).toBeUndefined();
  });

  it("a read grantee cannot link", async () => {
    const a = await node();
    const b = await node();
    expect(await run(beta, "mind_link", { mind_id: "alpha", source_id: a, target_id: b })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
