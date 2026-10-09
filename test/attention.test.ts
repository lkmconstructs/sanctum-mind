// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, resetDatabase, testAppUrl, testDatabaseUrl } from "./helpers.js";
import { upsertMinds } from "../src/auth.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool, withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import { vectorLiteral } from "../src/verbs/common.js";
import { attentionWeight, weightTerms, KIND_PRIOR } from "../src/verbs/attention.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { noticeExtract } from "../src/extractor/index.js";
import { setExtractorState } from "../src/extractor-admin.js";
import { FEATURE_NAMES, computeFeatures } from "../src/extractor/features.js";
import { PRIOR_MODEL, parseWeights, scoreOf } from "../src/extractor/scorer.js";
import { PRIOR_WEIGHTS } from "../src/extractor/prior.js";
import { exportMind } from "../src/export.js";
import { importMind } from "../src/import-mind.js";
import { purgeMind } from "../src/purge.js";
import type { Caller } from "../src/verbs/types.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: {} };
const betaRead: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const betaWrite: Caller = { bearer: "beta", grants: { alpha: ["read", "write"] } };
const betaSteward: Caller = { bearer: "beta", grants: { alpha: ["read", "steward"] } };
const MSG = "attention is directed by the mind";

let admin: Pool;
let pool: Pool;
/** when set, the verbs' clock; otherwise the real time at each call */
let fixed: Date | null = null;

const run = (caller: Caller, name: string, input: unknown, at?: Date) =>
  runVerb({ pool, registry, now: () => at ?? fixed ?? new Date(), embedder: NONE_EMBEDDER }, caller, name, input) as Promise<any>;
const V = (name: string, input: Record<string, unknown>, caller: Caller = alpha, mind = "alpha") => run(caller, name, { mind_id: mind, ...input });
const attend = (input: Record<string, unknown>, caller: Caller = alpha, mind = "alpha") => run(caller, "mind_attend", { mind_id: mind, ...input });
const list = async (input: Record<string, unknown> = {}, caller: Caller = alpha, mind = "alpha"): Promise<{ items: any[]; pins: number }> => {
  const r = await attend({ operation: "list", ...input }, caller, mind);
  expect(r.ok).toBe(true);
  return r.receipt.projection;
};
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
  fixed = null;
});
afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

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

// ---- seeding with controlled times: rows are inserted directly as the mind (the verbs stamp the database clock) ----

async function mkEvent(kind: string, payload: object = {}, subject: string | null = null, mind = "alpha"): Promise<string> {
  const r = await queryAs(
    pool, mind, mind,
    `insert into events (mind_id, kind, payload, subject_id, written_by, recorded_at) values ($1, $2, $3::jsonb, $4, $1, now()) returning id`,
    [mind, kind, JSON.stringify(payload), subject],
  );
  return r.rows[0].id;
}
async function mkLoop(label: string, urgency: "burning" | "nagging", at: Date, id?: string): Promise<string> {
  const ev = await mkEvent("loop.create", { label });
  const r = await queryAs(
    pool, "alpha", "alpha",
    `insert into loops (id, mind_id, label, urgency, created_event_id, created_at) values (coalesce($1::uuid, gen_random_uuid()), 'alpha', $2, $3, $4, $5) returning id`,
    [id ?? null, label, urgency, ev, at],
  );
  return r.rows[0].id;
}
async function mkThread(label: string, priority: string, at: Date): Promise<string> {
  const ev = await mkEvent("thread.add", { label });
  return (await queryAs(pool, "alpha", "alpha",
    `insert into threads (mind_id, label, priority, created_event_id, created_at, updated_at) values ('alpha', $1, $2, $3, $4, $4) returning id`, [label, priority, ev, at])).rows[0].id;
}
async function mkTask(title: string, priority: string, at: Date): Promise<string> {
  const ev = await mkEvent("task.create", { title });
  return (await queryAs(pool, "alpha", "alpha",
    `insert into tasks (mind_id, title, priority, created_event_id, created_at, updated_at) values ('alpha', $1, $2, $3, $4, $4) returning id`, [title, priority, ev, at])).rows[0].id;
}
async function mkNode(content: string, o: { type?: string; at?: Date; vec?: boolean; salience?: string; mind?: string } = {}): Promise<string> {
  const mind = o.mind ?? "alpha";
  const vec = o.vec ? vectorLiteral((await FAKE_EMBEDDER.embed([content]))[0]) : null;
  const meta = o.salience ? { texture: { salience: o.salience } } : {};
  const r = await queryAs(
    pool, mind, mind,
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, metadata, created_at, embedding, embedding_model)
     values ($1, $2, $3, $4, $1, 'extracted', 1.0, $5::jsonb, $6, $7::vector, $8) returning id`,
    [mind, o.type ?? "observation", content.slice(0, 50), content, JSON.stringify(meta), o.at ?? new Date(), vec, vec ? "fake" : null],
  );
  return r.rows[0].id;
}
async function mkNoticing(kind: "link" | "repair", sources: string[], payload: object, o: { score?: number; stage?: string; expires?: Date } = {}): Promise<string> {
  const ev = await mkEvent("notice.proposed", { kind });
  const r = await queryAs(
    pool, "alpha", "alpha",
    `insert into noticings (mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at, created_at)
     values ('alpha', $1, $2::uuid[], $3::jsonb, $4, '{}', 0, $5, 'pending', $6, $7, now()) returning id`,
    [kind, sources, JSON.stringify(payload), o.score ?? 0.6, o.stage ?? "propose", ev, o.expires ?? new Date(Date.now() + 14 * DAY)],
  );
  return r.rows[0].id;
}
const stageState = (stage: "shadow" | "propose") => setExtractorState(admin, "alpha", "enable", { stage, schedule: "03:00" });

const expected = (since: Date, now: Date, charge: number, kind: number, pin: number): number => {
  const age = Math.max(0, now.getTime() - since.getTime()) / DAY;
  return 0.35 * Math.exp(-age / 7) + 0.25 * charge + 0.2 * kind + 0.2 * pin;
};

// ---------------------------------------------------------------------------------------------------------------

describe("the weight", () => {
  it("is 0.35 recency + 0.25 charge + 0.20 kind + 0.20 pin; exact numbers for three items under an injected clock", async () => {
    const T = new Date("2026-06-15T12:00:00.000Z");
    fixed = T;
    const loop = await mkLoop("keep the lamp lit", "burning", new Date(T.getTime() - 7 * DAY));
    const thread = await mkThread("the long project", "high", new Date(T.getTime() - 3.5 * DAY));
    const task = await mkTask("answer the letter", "normal", new Date(T.getTime() - 14 * DAY));
    expectErr(await attend({ operation: "pin", item_type: "task", item_id: "00000000-0000-4000-8000-000000000000" }), "not_found", "item_id");
    expect((await attend({ operation: "pin", item_type: "task", item_id: task, note: "do not forget" })).ok).toBe(true);

    // by hand: recency = exp(-age_days / 7)
    const wLoop = 0.35 * Math.exp(-1) + 0.25 * 1.0 + 0.2 * 0.9 + 0.2 * 0; //        burning loop, 7 days old
    const wThread = 0.35 * Math.exp(-0.5) + 0.25 * 0.7 + 0.2 * 0.6 + 0.2 * 0; //    high thread, 3.5 days old
    const wTask = 0.35 * Math.exp(-2) + 0.25 * 0.4 + 0.2 * 0.7 + 0.2 * 1; //        normal task, 14 days old, pinned
    expect(wLoop).toBeCloseTo(0.558758, 5);
    expect(wThread).toBeCloseTo(0.507286, 5);
    expect(wTask).toBeCloseTo(0.487367, 5);

    const p = await list();
    expect(p.items.map((i) => [i.type, i.id])).toEqual([["loop", loop], ["thread", thread], ["task", task]]);
    expect(p.items[0].weight).toBeCloseTo(wLoop, 4);
    expect(p.items[1].weight).toBeCloseTo(wThread, 4);
    expect(p.items[2].weight).toBeCloseTo(wTask, 4);
    expect(p.items.map((i) => i.pinned)).toEqual([false, false, true]);
    expect(p.items[2].note).toBe("do not forget");
    expect(p.items[0]).not.toHaveProperty("note");
    expect(p.pins).toBe(1);
    // the same numbers from the exported function, and the terms behind them
    expect(attentionWeight({ since: new Date(T.getTime() - 7 * DAY), now: T, charge: 1, type: "loop", pinned: false })).toBeCloseTo(wLoop, 4);
    expect(weightTerms({ since: new Date(T.getTime() - 14 * DAY), now: T, charge: 0.4, type: "task", pinned: true })).toEqual({ recency: Math.exp(-2), charge: 0.4, kind: 0.7, pin: 1 });

    // releasing drops the pin term and nothing else: the task loses exactly 0.20
    expect((await attend({ operation: "release", item_type: "task", item_id: task })).ok).toBe(true);
    const after = await list();
    expect(after.items[2].weight).toBeCloseTo(wTask - 0.2, 4);
    expect(after.items[2].pinned).toBe(false);
    expect(after.pins).toBe(0);
  });

  it("the kind priors are the specified table, and a weight stays within 0..1", () => {
    expect(KIND_PRIOR).toMatchObject({ declaration: 1.0, loop: 0.9, sit: 0.8, task: 0.7, repair: 0.7, thread: 0.6, desire: 0.5, noticing: 0.4 });
    const T = new Date();
    expect(attentionWeight({ since: T, now: T, charge: 5, type: "declaration", pinned: true })).toBe(1); // everything at its maximum
    expect(attentionWeight({ since: new Date(T.getTime() + DAY), now: T, charge: -3, type: "noticing", pinned: false })).toBeCloseTo(0.35 + 0.08, 6); // the future counts as now; charge floors at 0
    expect(attentionWeight({ since: new Date(T.getTime() - 400 * DAY), now: T, charge: 0, type: "noticing", pinned: false })).toBeCloseTo(0.08, 4);
  });

  it("orders by weight, then since (newest first), then id", async () => {
    const T = new Date("2026-06-15T12:00:00.000Z");
    fixed = T;
    const t1 = new Date(T.getTime() - DAY);
    // identical inputs: the weights are equal, so the ids decide (inserted in the opposite order)
    const b = await mkLoop("b", "nagging", t1, "00000000-0000-4000-8000-000000000002");
    const a = await mkLoop("a", "nagging", t1, "00000000-0000-4000-8000-000000000001");
    expect((await list()).items.map((i) => i.id)).toEqual([a, b]);
    // one millisecond apart: equal at six decimals, so the newer comes first even though its id is larger
    const older = await mkLoop("older", "burning", new Date(T.getTime() - 2 * DAY), "00000000-0000-4000-8000-0000000000aa");
    const newer = await mkLoop("newer", "burning", new Date(T.getTime() - 2 * DAY + 1), "ffffffff-ffff-4fff-8fff-ffffffffffff");
    const p = await list();
    expect(p.items.map((i) => i.id)).toEqual([newer, older, a, b]);
    expect(p.items[0].weight).toBe(p.items[1].weight);
    // the heavier a thing, the earlier; a quiet urgent task outranks an old nagging loop
    const urgent = await mkTask("now", "urgent", new Date(T.getTime() - 60 * 1000));
    expect((await list()).items[0].id).toBe(urgent);
  });

  it("list limits: default 12, at most 50, at least 1", async () => {
    for (let i = 0; i < 14; i++) await mkLoop(`l${i}`, "nagging", new Date(Date.now() - i * HOUR));
    expect((await list()).items).toHaveLength(12);
    expect((await list({ limit: 3 })).items).toHaveLength(3);
    expect((await list({ limit: 50 })).items).toHaveLength(14);
    expectErr(await attend({ operation: "list", limit: 51 }), "invalid_input");
    expectErr(await attend({ operation: "list", limit: 0 }), "invalid_input");
  });
});

describe("what is an item", () => {
  async function seedEverything() {
    const loop = (await V("mind_loop", { operation: "create", label: "keep the lamp lit", urgency: "burning" })).receipt.projection.id as string;
    const thread = (await V("mind_thread", { operation: "add", label: "the long project", priority: "high" })).receipt.projection.thread.id as string;
    const task = (await V("mind_task", { operation: "create", title: "file the form", priority: "urgent" })).receipt.projection.task.id as string;
    const desire = (await V("mind_desire", { operation: "register", want: "a quiet week", intensity: 0.8 })).receipt.projection.node_id as string;
    const core = (await V("mind_identity", { operation: "affirm", section: "core", content: "I am steady" })).receipt.projection.node_id as string;
    const rewrite = (await V("mind_identity", { operation: "propose", section: "core", content: "I am steadier", lineage_note: "grew", target_node_id: core })).receipt.projection.proposal.id as string;
    const vow = (await V("mind_vow", { operation: "make", vow: "keep my word" })).receipt.projection.node_id as string;
    expect((await V("mind_vow", { operation: "break", vow_id: vow, reason: "tired" })).ok).toBe(true);
    const writ = (await V("mind_write", { type: "note", text: "something to hold" })).receipt.event_id as string;
    expect((await V("mind_sit", { subject_id: writ, state: "processing" })).ok).toBe(true);
    await stageState("propose");
    const a = await mkNode("one");
    const b = await mkNode("two");
    const noticing = await mkNoticing("link", [a, b], { edge_type: "related_to", reason: "both mention rain" }, { score: 0.6 });
    const repair = await mkNoticing("repair", [a, b], { dependant_type: "observation", relation: "derived_from", upstream_state: "superseded", dependant_id: a, upstream_id: b }, { score: 1.0 });
    return { loop, thread, task, desire, core, rewrite, vow, writ, noticing, repair };
  }

  it("each type appears with its label, its charge and its since", async () => {
    const ids = await seedEverything();
    const now = new Date();
    fixed = now;
    const p = await list({ limit: 50 });
    expect(p.items).toHaveLength(9); // loop, thread, task, desire, two declarations, sit, noticing, repair
    const by = (type: string, id: string) => p.items.find((i) => i.type === type && i.id === id);
    const w = (item: any, charge: number, kind: number) => expect(item.weight).toBeCloseTo(expected(new Date(item.since), now, charge, kind, 0), 4);

    const loop = by("loop", ids.loop);
    expect(loop.label).toBe("keep the lamp lit");
    w(loop, 1.0, 0.9);
    const thread = by("thread", ids.thread);
    expect(thread.label).toBe("the long project");
    w(thread, 0.7, 0.6);
    const task = by("task", ids.task);
    expect(task.label).toBe("file the form");
    w(task, 1.0, 0.7);
    const desire = by("desire", ids.desire);
    expect(desire.label).toBe("a quiet week");
    w(desire, 0.8, 0.5); // mind_desire stores intensity as 0..1
    const rewrite = by("declaration", ids.rewrite);
    expect(rewrite.label).toBe("core");
    w(rewrite, 1.0, 1.0);
    const brk = by("declaration", ids.vow);
    expect(brk.label).toBe((await q("alpha", "select label from nodes where id = $1", [ids.vow]))[0].label);
    w(brk, 1.0, 1.0);
    const sit = by("sit", ids.writ);
    expect(sit.label).toBe("write: something to hold");
    w(sit, 0.8, 0.8); // processing
    const noticing = by("noticing", ids.noticing);
    expect(noticing.label).toBe("link: both mention rain");
    w(noticing, 0.6, 0.4); // the noticing's own score
    const repair = by("repair", ids.repair);
    expect(repair.label).toBe("repair: observation derived_from a superseded node");
    w(repair, 1.0, 0.7);

    // since: a loop is as old as its row, a thread as its last update, a declaration as the break was declared
    expect(new Date(loop.since).getTime()).toBe(new Date((await q("alpha", "select created_at from loops where id = $1", [ids.loop]))[0].created_at).getTime());
    expect(new Date(thread.since).getTime()).toBe(new Date((await q("alpha", "select updated_at from threads where id = $1", [ids.thread]))[0].updated_at).getTime());
    const declared = (await q("alpha", "select metadata->'break_declared'->>'declared_at' as d from nodes where id = $1", [ids.vow]))[0].d;
    expect(new Date(brk.since).getTime()).toBe(Date.parse(declared));
    // a thread update is a touch
    await new Promise((r) => setTimeout(r, 5));
    expect((await V("mind_thread", { operation: "update", thread_id: ids.thread, note: "moved on" })).ok).toBe(true);
    fixed = new Date();
    const again = (await list({ limit: 50 })).items.find((i) => i.id === ids.thread);
    expect(new Date(again.since).getTime()).toBeGreaterThan(new Date(thread.since).getTime());
  });

  it("an active sit weighs 0.6, a processing one 0.8; a pinned node and event are items of their own", async () => {
    const e = (await V("mind_write", { type: "note", text: "a held thought" })).receipt.event_id as string;
    expect((await V("mind_sit", { subject_id: e, state: "active" })).ok).toBe(true);
    const n = await mkNode("a pinned memory", { salience: "foundational", at: new Date(Date.now() - 3 * DAY) });
    const ev = await mkEvent("write", { text: "x".repeat(200) });
    expect((await attend({ operation: "pin", item_type: "node", item_id: n, note: "this matters" })).ok).toBe(true);
    expect((await attend({ operation: "pin", item_type: "event", item_id: ev })).ok).toBe(true);
    const now = new Date();
    fixed = now;
    const p = await list();
    const sit = p.items.find((i) => i.type === "sit");
    expect(sit.weight).toBeCloseTo(expected(new Date(sit.since), now, 0.6, 0.8, 0), 4);
    const node = p.items.find((i) => i.type === "node");
    expect(node).toMatchObject({ id: n, label: "a pinned memory", pinned: true, note: "this matters" });
    expect(node.weight).toBeCloseTo(expected(new Date(node.since), now, 1.0, 0.5, 1), 4); // texture salience foundational
    const event = p.items.find((i) => i.type === "event");
    expect(event.id).toBe(ev);
    expect(event.label).toBe(`write: ${"x".repeat(80)}`); // kind and the first 80 characters
    expect(event.weight).toBeCloseTo(expected(new Date(event.since), now, 0.5, 0.5, 1), 4); // no salience: 0.5
    expect(p.pins).toBe(2);
  });

  it("a pin on something already an item marks that item; it does not add a second", async () => {
    const e = (await V("mind_write", { type: "note", text: "held and pinned" })).receipt.event_id as string;
    expect((await V("mind_sit", { subject_id: e, state: "active" })).ok).toBe(true);
    expect((await attend({ operation: "pin", item_type: "event", item_id: e })).ok).toBe(true);
    const p = await list();
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ type: "sit", id: e, pinned: true });
  });

  it("a resolved loop, an archived or resolved thread, a done or cancelled task, a fulfilled desire, a settled declaration, a decided noticing and a resolved sit drop out", async () => {
    const ids = await seedEverything();
    expect((await list({ limit: 50 })).items).toHaveLength(9);
    const t2 = (await V("mind_thread", { operation: "add", label: "another" })).receipt.projection.thread.id as string;
    const k2 = (await V("mind_task", { operation: "create", title: "another task" })).receipt.projection.task.id as string;
    expect((await list({ limit: 50 })).items).toHaveLength(11);

    expect((await V("mind_loop", { operation: "resolve", loop_id: ids.loop })).ok).toBe(true);
    expect((await V("mind_thread", { operation: "archive", thread_id: ids.thread })).ok).toBe(true);
    expect((await V("mind_thread", { operation: "resolve", thread_id: t2 })).ok).toBe(true);
    expect((await V("mind_task", { operation: "update", task_id: ids.task, status: "done" })).ok).toBe(true);
    expect((await V("mind_task", { operation: "update", task_id: k2, status: "cancelled" })).ok).toBe(true);
    expect((await V("mind_desire", { operation: "fulfill", desire_id: ids.desire })).ok).toBe(true);
    expect((await V("mind_resolve", { subject_id: ids.writ, outcome: "metabolized" })).ok).toBe(true);
    expect((await V("mind_notice", { operation: "reject", noticing_id: ids.noticing })).ok).toBe(true);
    expect((await V("mind_notice", { operation: "reject", noticing_id: ids.repair })).ok).toBe(true);
    // both declarations are still cooling until they settle; settling them (a day and an hour on) ends them
    expect((await list({ limit: 50 })).items.map((i) => i.type).sort()).toEqual(["declaration", "declaration"]);
    expect((await run(alpha, "mind_identity", { mind_id: "alpha", operation: "settle" }, new Date(Date.now() + DAY + HOUR))).ok).toBe(true);
    expect((await list({ limit: 50 })).items).toEqual([]);
  });

  it("a withdrawn declaration and a withdrawn vow break drop out; an expired or shadow-stage noticing is not carried, a repair is whatever the extractor's state", async () => {
    const core = (await V("mind_identity", { operation: "affirm", section: "core", content: "I am steady" })).receipt.projection.node_id as string;
    const rewrite = (await V("mind_identity", { operation: "propose", section: "core", content: "steadier", target_node_id: core })).receipt.projection.proposal.id as string;
    const vow = (await V("mind_vow", { operation: "make", vow: "keep my word" })).receipt.projection.node_id as string;
    await V("mind_vow", { operation: "break", vow_id: vow, reason: "tired" });
    expect((await list()).items).toHaveLength(2);
    expect((await V("mind_identity", { operation: "withdraw", proposal_id: rewrite })).ok).toBe(true);
    expect((await V("mind_vow", { operation: "withdraw_break", vow_id: vow })).ok).toBe(true);
    expect((await list()).items).toEqual([]);

    const a = await mkNode("one");
    const b = await mkNode("two");
    await mkNoticing("link", [a, b], { reason: "r" }, { stage: "shadow" });
    await mkNoticing("link", [a, b], { reason: "r" }, { expires: new Date(Date.now() - HOUR) });
    expect((await list()).items).toEqual([]);
    // a pending link at stage propose is only carried while the operator's stage is propose; a repair is carried either way
    await mkNoticing("link", [a, b], { reason: "visible when proposing" });
    const repair = await mkNoticing("repair", [a, b], { dependant_type: "observation", relation: "derived_from", upstream_state: "retired" });
    expect((await list()).items.map((i) => [i.type, i.id])).toEqual([["repair", repair]]);
    await stageState("shadow");
    expect((await list()).items.map((i) => i.type)).toEqual(["repair"]);
    await stageState("propose");
    expect((await list()).items.map((i) => i.type).sort()).toEqual(["noticing", "repair"]);
  });

  it("everything is scoped to the mind: another mind's things are not carried", async () => {
    await mkLoop("mine", "burning", new Date());
    await queryAs(pool, "beta", "beta", `insert into loops (mind_id, label, urgency, created_event_id, created_at)
       values ('beta', 'beta loop', 'burning', $1, now())`, [await mkEvent("loop.create", {}, null, "beta")]);
    expect((await list()).items.map((i) => i.label)).toEqual(["mine"]);
    expect((await list({}, beta, "beta")).items.map((i) => i.label)).toEqual(["beta loop"]);
    // a read grantee sees alpha's set, and nothing of its own mixed in
    expect((await list({}, betaRead, "alpha")).items.map((i) => i.label)).toEqual(["mine"]);
  });
});

describe("one thing is one item", () => {
  it("a desire pinned as node and as desire, a vow with a declared break pinned as node, and a desire also held by a sit: one item each", async () => {
    const desire = (await V("mind_desire", { operation: "register", want: "a quiet week", intensity: 0.5 })).receipt.projection.node_id as string;
    const vow = (await V("mind_vow", { operation: "make", vow: "keep my word" })).receipt.projection.node_id as string;
    expect((await V("mind_vow", { operation: "break", vow_id: vow, reason: "tired" })).ok).toBe(true);
    const plain = await mkNode("a plain pinned memory");
    expect((await V("mind_sit", { subject_id: desire, state: "processing" })).ok).toBe(true);
    // before any pin: the desire is held and a desire, still one item
    let p = await list({ limit: 50 });
    expect(p.items.map((i) => i.id).sort()).toEqual([desire, vow].sort());
    expect(p.items.find((i) => i.id === desire)).toMatchObject({ type: "desire", pinned: false });
    expect(p.items.find((i) => i.id === vow)).toMatchObject({ type: "declaration", pinned: false });

    expect((await attend({ operation: "pin", item_type: "node", item_id: desire })).ok).toBe(true);
    expect((await attend({ operation: "pin", item_type: "desire", item_id: desire })).ok).toBe(true);
    expect((await attend({ operation: "pin", item_type: "node", item_id: vow })).ok).toBe(true);
    expect((await attend({ operation: "pin", item_type: "node", item_id: plain })).ok).toBe(true);
    const now = new Date();
    fixed = now;
    p = await list({ limit: 50 });
    expect(p.items).toHaveLength(3); // the desire, the vow's declaration, the plain node
    expect(p.pins).toBe(4);
    expect(p.items.every((i) => i.pinned)).toBe(true);
    const d = p.items.find((i) => i.id === desire);
    expect(d.type).toBe("desire"); // desire > sit
    // charge and kind prior: the higher of desire (0.5 / 0.5) and sit (processing 0.8 / 0.8); since the later of the two
    expect(d.weight).toBeCloseTo(expected(new Date(d.since), now, 0.8, 0.8, 1), 4);
    const v = p.items.find((i) => i.id === vow);
    expect(v.type).toBe("declaration");
    expect(v.weight).toBeCloseTo(expected(new Date(v.since), now, 1.0, 1.0, 1), 4);
    expect(p.items.find((i) => i.id === plain).type).toBe("node");
    expect((await V("mind_weather", {})).receipt.projection.attention_load).toMatchObject({ items: 3, pinned: 3 });
    // releasing one of the two pins on the desire leaves it pinned; releasing the other unpins it
    expect((await attend({ operation: "release", item_type: "node", item_id: desire })).ok).toBe(true);
    expect((await list({ limit: 50 })).items.find((i) => i.id === desire).pinned).toBe(true);
    expect((await attend({ operation: "release", item_type: "desire", item_id: desire })).ok).toBe(true);
    expect((await list({ limit: 50 })).items.find((i) => i.id === desire).pinned).toBe(false);
  });
});

describe("pin and release", () => {
  it("are the mind's own: a read, write or steward grantee and a stranger are forbidden with the mind-only message; a read grantee may list", async () => {
    const loop = await mkLoop("x", "burning", new Date());
    for (const c of [betaWrite, betaSteward, beta]) {
      const r = await attend({ operation: "pin", item_type: "loop", item_id: loop }, c);
      expectErr(r, "forbidden");
      expect(r.error.message).toBe(MSG);
      expectErr(await attend({ operation: "release", item_type: "loop", item_id: loop }, c), "forbidden");
    }
    expectErr(await attend({ operation: "pin", item_type: "loop", item_id: loop }, betaRead), "forbidden");
    expect((await list({}, betaRead)).items).toHaveLength(1);
    expect((await list({}, betaWrite)).items).toHaveLength(1);
    expect((await list({}, betaSteward)).items).toHaveLength(1); // this grantee also holds read
    // a steward grant alone is not read scope for this verb
    expectErr(await attend({ operation: "list" }, { bearer: "beta", grants: { alpha: ["steward"] } }), "forbidden");
  });

  it("a pin writes attend.pin (subject the item, payload type, id and note); a release writes attend.release; the item is untouched", async () => {
    const loop = await mkLoop("hold on", "nagging", new Date(Date.now() - DAY));
    const before = (await q("alpha", "select to_jsonb(l)::text j from loops l where id = $1", [loop]))[0].j;
    const pinned = await attend({ operation: "pin", item_type: "loop", item_id: loop, note: "mine" });
    expect(pinned.ok).toBe(true);
    const ev = (await q("alpha", "select * from events where id = $1", [pinned.receipt.event_id]))[0];
    expect(ev).toMatchObject({ kind: "attend.pin", subject_id: loop, written_by: "alpha", payload: { item_type: "loop", item_id: loop, note: "mine" } });
    expect(pinned.receipt.projection.pin).toMatchObject({ item_type: "loop", item_id: loop, note: "mine", released_at: null, pinned_event_id: ev.id });
    expect((await list()).items[0]).toMatchObject({ pinned: true, note: "mine" });

    const pinId = pinned.receipt.projection.pin.id;
    const rel = await attend({ operation: "release", pin_id: pinId });
    expect(rel.ok).toBe(true);
    const rev = (await q("alpha", "select * from events where id = $1", [rel.receipt.event_id]))[0];
    expect(rev).toMatchObject({ kind: "attend.release", subject_id: loop, payload: { item_type: "loop", item_id: loop, pin_id: pinId } });
    const row = (await q("alpha", "select * from attention_pins where id = $1", [pinId]))[0];
    expect(row.released_event_id).toBe(rev.id);
    expect(row.released_at).not.toBeNull();
    expect((await list()).items[0].pinned).toBe(false);
    expect((await q("alpha", "select to_jsonb(l)::text j from loops l where id = $1", [loop]))[0].j).toBe(before);
    // pinned again after a release: allowed, a new pin row
    expect((await attend({ operation: "pin", item_type: "loop", item_id: loop })).ok).toBe(true);
    expect(await q("alpha", "select 1 from attention_pins where item_id = $1", [loop])).toHaveLength(2);
  });

  it("conflict on a double pin, not_found on release of nothing, on pinning what does not exist or is no longer live", async () => {
    const loop = await mkLoop("x", "burning", new Date());
    expect((await attend({ operation: "pin", item_type: "loop", item_id: loop })).ok).toBe(true);
    expectErr(await attend({ operation: "pin", item_type: "loop", item_id: loop }), "conflict", "item_id");
    expect((await attend({ operation: "release", item_type: "loop", item_id: loop })).ok).toBe(true);
    expectErr(await attend({ operation: "release", item_type: "loop", item_id: loop }), "not_found", "item_id");
    expectErr(await attend({ operation: "release", pin_id: "00000000-0000-4000-8000-000000000000" }), "not_found", "pin_id");
    expectErr(await attend({ operation: "pin", item_type: "thread", item_id: loop }), "not_found", "item_id"); // right id, wrong type
    expect((await V("mind_loop", { operation: "resolve", loop_id: loop })).ok).toBe(true);
    expectErr(await attend({ operation: "pin", item_type: "loop", item_id: loop }), "not_found", "item_id");
    const node = await mkNode("gone");
    await queryAs(pool, "alpha", "alpha", "update nodes set invalidated_at = now() where id = $1", [node]);
    expectErr(await attend({ operation: "pin", item_type: "node", item_id: node }), "not_found", "item_id");
    // a thing of another mind is not found either
    const other = await mkNode("beta's", { mind: "beta" });
    expectErr(await attend({ operation: "pin", item_type: "node", item_id: other }), "not_found", "item_id");
  });

  it("a pinned thing that stops being live drops out of the list but the pin stays until released", async () => {
    const loop = await mkLoop("x", "burning", new Date());
    expect((await attend({ operation: "pin", item_type: "loop", item_id: loop })).ok).toBe(true);
    expect((await V("mind_loop", { operation: "resolve", loop_id: loop })).ok).toBe(true);
    expect(await list()).toMatchObject({ items: [], pins: 1 });
    expect((await attend({ operation: "release", item_type: "loop", item_id: loop })).ok).toBe(true);
    expect((await list()).pins).toBe(0);
  });

  it("pinned items float: the pin term adds exactly 0.20", async () => {
    const T = new Date("2026-06-15T12:00:00.000Z");
    fixed = T;
    const a = await mkLoop("a", "burning", new Date(T.getTime() - DAY));
    const b = await mkThread("b", "low", new Date(T.getTime() - 10 * DAY));
    const before = (await list()).items;
    expect(before.map((i) => i.id)).toEqual([a, b]);
    expect((await attend({ operation: "pin", item_type: "thread", item_id: b })).ok).toBe(true);
    const after = (await list()).items;
    expect(after.find((i) => i.id === b).weight).toBeCloseTo(before.find((i) => i.id === b).weight + 0.2, 5);
    expect(after.find((i) => i.id === a).weight).toBe(before.find((i) => i.id === a).weight);
  });

  it("input shapes: pin needs an item, release needs a pin or an item, not both", async () => {
    expectErr(await attend({ operation: "pin" }), "invalid_input", "item_type");
    expectErr(await attend({ operation: "pin", item_type: "loop" }), "invalid_input", "item_id");
    expectErr(await attend({ operation: "pin", item_type: "bogus", item_id: "00000000-0000-4000-8000-000000000000" }), "invalid_input");
    expectErr(await attend({ operation: "release" }), "invalid_input");
    expectErr(await attend({ operation: "release", pin_id: "00000000-0000-4000-8000-000000000000", item_type: "loop", item_id: "00000000-0000-4000-8000-000000000000" }), "invalid_input");
    expectErr(await attend({ operation: "list", item_type: "loop" }), "invalid_input");
  });
});

describe("the pin table guards itself (migration 0024)", () => {
  async function livePin() {
    const loop = await mkLoop("x", "burning", new Date());
    const r = await attend({ operation: "pin", item_type: "loop", item_id: loop });
    return { loop, pin: r.receipt.projection.pin, ev: r.receipt.event_id as string };
  }
  const insertSql = `insert into attention_pins (mind_id, item_type, item_id, pinned_event_id, pinned_at) values ('alpha', 'loop', $1, $2, now())`;

  it("refuses a pin from anyone but the mind in a verb call: bare connection, no actor, a grantee's bearer, the daemon, the operator", async () => {
    const loop = await mkLoop("x", "burning", new Date());
    const ev = await mkEvent("attend.pin", { item_type: "loop", item_id: loop }, loop);
    await expect(admin.query(insertSql, [loop, ev])).rejects.toThrow(MSG);
    for (const [bearer, actor] of [["alpha", ""], ["beta", "verb"], ["alpha", "daemon"], ["alpha", "operator"]] as const) {
      await expect(inTx(pool, "alpha", bearer, actor, insertSql, [loop, ev])).rejects.toThrow(MSG);
    }
    // the mind in a verb call may (the verb does exactly this)
    await inTx(pool, "alpha", "alpha", "verb", insertSql, [loop, ev]);
    expect(await q("alpha", "select 1 from attention_pins")).toHaveLength(1);
  });

  it("refuses a pin whose event is not its own attend.pin event, and a pin that arrives released from a verb", async () => {
    const loop = await mkLoop("x", "burning", new Date());
    const wrongKind = await mkEvent("write", { text: "x" }, loop);
    const wrongSubject = await mkEvent("attend.pin", { item_type: "loop" }, "00000000-0000-4000-8000-000000000009");
    const good = await mkEvent("attend.pin", { item_type: "loop" }, loop);
    const wrongType = await mkEvent("attend.pin", { item_type: "thread" }, loop);
    const rel = await mkEvent("attend.release", { item_type: "loop" }, loop);
    await expect(inTx(pool, "alpha", "alpha", "verb", insertSql, [loop, wrongKind])).rejects.toThrow("a pin must reference its own attend.pin event");
    await expect(inTx(pool, "alpha", "alpha", "verb", insertSql, [loop, wrongSubject])).rejects.toThrow("a pin must reference its own attend.pin event");
    await expect(inTx(pool, "alpha", "alpha", "verb", insertSql, [loop, wrongType])).rejects.toThrow("a pin must reference its own attend.pin event"); // its payload names another item_type
    await expect(inTx(pool, "alpha", "alpha", "verb",
      `insert into attention_pins (mind_id, item_type, item_id, pinned_event_id, pinned_at, released_event_id, released_at) values ('alpha', 'loop', $1, $2, now(), $3, now())`,
      [loop, good, rel])).rejects.toThrow("a new pin is live");
    // the table's own check: released_at and released_event_id come together
    await expect(inTx(pool, "alpha", "alpha", "import",
      `insert into attention_pins (mind_id, item_type, item_id, pinned_event_id, pinned_at, released_at) values ('alpha', 'loop', $1, $2, now(), now())`,
      [loop, good])).rejects.toThrow();
    // another mind's scope cannot insert alpha's row (row level security)
    await expect(inTx(pool, "beta", "beta", "verb", insertSql, [loop, good])).rejects.toThrow();
  });

  it("allows import to insert a pin, live or already released, citing its events; and nothing more", async () => {
    const loop = await mkLoop("x", "burning", new Date());
    const ev = await mkEvent("attend.pin", { item_type: "loop" }, loop);
    const rel = await mkEvent("attend.release", { item_type: "loop" }, loop);
    await inTx(pool, "alpha", "alpha", "import", insertSql, [loop, ev]);
    const ev2 = await mkEvent("attend.pin", { item_type: "loop" }, loop);
    await inTx(pool, "alpha", "alpha", "import",
      `insert into attention_pins (mind_id, item_type, item_id, pinned_event_id, pinned_at, released_event_id, released_at) values ('alpha', 'loop', $1, $2, now(), $3, now())`,
      [loop, ev2, rel]);
    // but not with a missing or wrong release event, a wrong bearer, or the import marker from a stranger's scope
    await expect(inTx(pool, "alpha", "alpha", "import",
      `insert into attention_pins (mind_id, item_type, item_id, pinned_event_id, pinned_at, released_event_id, released_at) values ('alpha', 'loop', $1, $2, now(), $2, now())`,
      [loop, ev2])).rejects.toThrow("a release must reference its own attend.release event");
    await expect(inTx(pool, "alpha", "beta", "import", insertSql, [loop, ev2])).rejects.toThrow(MSG);
    // import cannot release a live pin: an update is the verb's alone
    const pin = (await q("alpha", "select id from attention_pins where released_at is null"))[0].id;
    await expect(inTx(pool, "alpha", "alpha", "import", "update attention_pins set released_at = now(), released_event_id = $2 where id = $1", [pin, rel])).rejects.toThrow(MSG);
  });

  it("an update is a release and nothing else, once, by the mind in a verb call, citing its attend.release event", async () => {
    const { loop, pin } = await livePin();
    const rel = await mkEvent("attend.release", { item_type: "loop" }, loop);
    const release = "update attention_pins set released_at = now(), released_event_id = $2 where id = $1";
    await expect(admin.query(release, [pin.id, rel])).rejects.toThrow(MSG);
    await expect(inTx(pool, "alpha", "alpha", "", release, [pin.id, rel])).rejects.toThrow(MSG);
    await expect(inTx(pool, "alpha", "beta", "verb", release, [pin.id, rel])).rejects.toThrow();
    await expect(inTx(pool, "alpha", "alpha", "daemon", release, [pin.id, rel])).rejects.toThrow(MSG);
    // every other column is fixed, null-safely
    for (const set of ["note = 'changed'", "item_type = 'thread'", "item_id = gen_random_uuid()", "pinned_at = now() + interval '1 day'", "pinned_event_id = '" + rel + "'", "mind_id = 'beta'"]) {
      await expect(inTx(pool, "alpha", "alpha", "verb", `update attention_pins set ${set} where id = $1`, [pin.id])).rejects.toThrow();
    }
    await expect(inTx(pool, "alpha", "alpha", "verb", `update attention_pins set note = 'x', released_at = now(), released_event_id = $2 where id = $1`, [pin.id, rel])).rejects.toThrow("a pin is fixed once made; it can only be released");
    // a release needs its own event, with both columns
    const wrong = await mkEvent("attend.pin", { item_type: "loop" }, loop);
    await expect(inTx(pool, "alpha", "alpha", "verb", release, [pin.id, wrong])).rejects.toThrow("a release must reference its own attend.release event");
    await expect(inTx(pool, "alpha", "alpha", "verb", "update attention_pins set released_at = now() where id = $1", [pin.id])).rejects.toThrow();
    await expect(inTx(pool, "alpha", "alpha", "verb", "update attention_pins set released_event_id = $2 where id = $1", [pin.id, rel])).rejects.toThrow();
    // the real thing passes, once; a released pin is final and never goes back
    await inTx(pool, "alpha", "alpha", "verb", release, [pin.id, rel]);
    const rel2 = await mkEvent("attend.release", { item_type: "loop" }, loop);
    await expect(inTx(pool, "alpha", "alpha", "verb", release, [pin.id, rel2])).rejects.toThrow("a released pin is final");
    await expect(inTx(pool, "alpha", "alpha", "verb", "update attention_pins set released_at = null, released_event_id = null where id = $1", [pin.id])).rejects.toThrow("a released pin is final");
  });

  it("allows one live pin per item (the index), and the app role cannot delete", async () => {
    const { loop } = await livePin();
    const ev = await mkEvent("attend.pin", { item_type: "loop" }, loop);
    await expect(inTx(pool, "alpha", "alpha", "verb", insertSql, [loop, ev])).rejects.toThrow(/attention_pins_one_live/);
    await expect(inTx(pool, "alpha", "alpha", "verb", "delete from attention_pins")).rejects.toThrow(/permission denied/);
  });

  it("row level security: another mind sees none of alpha's pins", async () => {
    await livePin();
    expect(await q("alpha", "select 1 from attention_pins")).toHaveLength(1);
    expect(await q("beta", "select 1 from attention_pins")).toHaveLength(0);
    expect((await list({}, beta, "beta")).pins).toBe(0);
    expect((await list({}, betaRead, "alpha")).pins).toBe(1);
  });
});

describe("surfaces", () => {
  it("there are twenty-six verbs; mind_attend is one", () => {
    expect(registry).toHaveLength(26);
    expect(registry.map((v) => v.name)).toContain("mind_attend");
    expect(new Set(registry.map((v) => v.name)).size).toBe(26);
  });

  it("mind_orient quick and full carry attention (top 7, with the pin count) before noticings; orientation does not", async () => {
    for (let i = 0; i < 9; i++) await mkLoop(`loop ${i}`, "nagging", new Date(Date.now() - i * HOUR));
    const loop = await mkLoop("pinned one", "nagging", new Date(Date.now() - 20 * DAY));
    await attend({ operation: "pin", item_type: "loop", item_id: loop });
    for (const depth of ["quick", "full"]) {
      const r = await V("mind_orient", { depth });
      const keys = Object.keys(r.receipt.projection.sections);
      expect(keys.indexOf("attention")).toBe(keys.indexOf("noticings") - 1);
      expect(keys.indexOf("attention")).toBeGreaterThan(keys.indexOf("anchors"));
      const a = r.receipt.projection.sections.attention;
      expect(a).not.toHaveProperty("error");
      expect(a.items).toHaveLength(7);
      expect(a.pins).toBe(1);
      expect(Object.keys(a.items[0]).sort()).toEqual(["id", "label", "pinned", "since", "type", "weight"]);
    }
    expect(Object.keys((await V("mind_orient", { depth: "orientation" })).receipt.projection.sections)).not.toContain("attention");
    // empty is a shape, not an error
    const empty = (await V("mind_orient", { depth: "quick" }, beta, "beta")).receipt.projection.sections.attention;
    expect(empty).toEqual({ items: [], pins: 0 });
  });

  it("mind_weather carries attention_load: items, pinned and the top weight", async () => {
    expect((await V("mind_weather", {})).receipt.projection.attention_load).toEqual({ items: 0, pinned: 0, top_weight: 0 });
    const T = new Date("2026-06-15T12:00:00.000Z");
    fixed = T;
    const a = await mkLoop("a", "burning", new Date(T.getTime() - 7 * DAY));
    await mkThread("b", "low", T);
    await attend({ operation: "pin", item_type: "loop", item_id: a });
    const w = (await V("mind_weather", {})).receipt.projection.attention_load;
    expect(w.items).toBe(2);
    expect(w.pinned).toBe(1);
    expect(w.top_weight).toBeCloseTo(0.35 * Math.exp(-1) + 0.25 + 0.2 * 0.9 + 0.2, 4);
    // a read grantee sees the same
    expect((await V("mind_weather", {}, betaRead, "alpha")).receipt.projection.attention_load.items).toBe(2);
  });

  it("attend.pin and attend.release are bookkeeping: left out of recent, weather's counts and search", async () => {
    const loop = await mkLoop("a", "burning", new Date());
    expect((await attend({ operation: "pin", item_type: "loop", item_id: loop, note: "findable-pin-note" })).ok).toBe(true);
    expect((await attend({ operation: "release", item_type: "loop", item_id: loop })).ok).toBe(true);
    await V("mind_write", { type: "note", text: "a plain note" });
    expect(await q("alpha", "select 1 from events where kind like 'attend.%'")).toHaveLength(2);
    const recent = (await V("mind_orient", { depth: "full" })).receipt.projection.sections.recent.events;
    expect(recent.some((e: any) => String(e.kind).startsWith("attend."))).toBe(false);
    expect(recent.some((e: any) => e.kind === "write")).toBe(true);
    const weather = (await V("mind_weather", {})).receipt.projection;
    expect(Object.keys(weather.kinds).some((k) => k.startsWith("attend."))).toBe(false);
    const found = await V("mind_search", { query: "findable-pin-note", scope: "events", mode: "text" });
    expect(found.ok).toBe(true);
    expect(found.receipt.projection.hits).toEqual([]);
    // the search does find a plain event
    expect((await V("mind_search", { query: "plain", scope: "events", mode: "text" })).receipt.projection.hits).toHaveLength(1);
  });
});

describe("the extractor attends to what the mind attends to", () => {
  let clock: Date;
  const HERON_A = "the heron stands in the shallow river at dawn";
  const HERON_B = "a heron stands still in the river at dawn";
  const go = async () => {
    const reports = await runDaemonOnce({ pool, embedder: FAKE_EMBEDDER, now: () => clock }, { trigger: "manual", minds: ["alpha"], passes: [noticeExtract] });
    return reports[0]!.passes[0]!;
  };
  const noticings = async () => (await admin.query("select * from noticings order by created_at, id")).rows;

  beforeEach(() => {
    const d = new Date();
    clock = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0); // local noon: the schedule gate compares local time
  });

  it("a link pair older than the window is not a candidate; pinning one of them makes it one, with attended = 1", async () => {
    await mkNode(HERON_A, { vec: true, at: new Date(clock.getTime() - 10 * DAY) });
    const b = await mkNode(HERON_B, { vec: true, at: new Date(clock.getTime() - 10 * DAY) });
    await stageState("shadow");
    expect((await go()).changed).toBe(0);
    expect(await noticings()).toHaveLength(0);

    // a second day: still nothing, then the pin
    clock = new Date(clock.getTime() + DAY);
    expect((await go()).changed).toBe(0);
    expect((await attend({ operation: "pin", item_type: "node", item_id: b })).ok).toBe(true);
    clock = new Date(clock.getTime() + DAY);
    const p = await go();
    expect(p.changed).toBe(1);
    const rows = await noticings();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("link");
    expect(rows[0].features.attended).toBe(1);
    expect(rows[0].sources).toContain(b);
  });

  it("a held charge (an active sit on a node) is under a top attention item, so its node counts as new; a pair with no attention keeps attended = 0", async () => {
    const a = await mkNode(HERON_A, { vec: true, at: new Date(clock.getTime() - 10 * DAY) });
    await mkNode(HERON_B, { vec: true, at: new Date(clock.getTime() - 10 * DAY) });
    // a fresh pair, new on its own
    await mkNode("planted the tomato seedlings along the south fence", { vec: true, at: new Date(clock.getTime() - 2 * HOUR) });
    await mkNode("planted tomato seedlings along the south fence today", { vec: true, at: new Date(clock.getTime() - 1 * HOUR) });
    expect((await V("mind_sit", { subject_id: a, state: "active" })).ok).toBe(true);
    await stageState("shadow");
    const p = await go();
    expect(p.changed).toBe(2);
    const rows = await noticings();
    const attended = rows.filter((r) => r.features.attended === 1);
    expect(attended).toHaveLength(1);
    expect(attended[0].sources).toContain(a);
    expect(rows.filter((r) => r.features.attended === 0)).toHaveLength(1);
  });

  it("a pin does not make an ineligible row a candidate (a node without a vector)", async () => {
    await mkNode(HERON_A, { vec: false, at: new Date(clock.getTime() - 10 * DAY) });
    const b = await mkNode(HERON_B, { vec: true, at: new Date(clock.getTime() - 10 * DAY) });
    await attend({ operation: "pin", item_type: "node", item_id: b });
    await stageState("shadow");
    expect((await go()).changed).toBe(0);
  });

  it("the attended feature is 0 or 1, the prior weight is +0.3, and a model or stored row from before it reads 0", () => {
    expect(FEATURE_NAMES).toContain("attended");
    expect(FEATURE_NAMES).toHaveLength(13);
    expect(PRIOR_WEIGHTS.attended).toBe(0.3);
    const src = (attended: boolean) => ({ created_at: clock, context: null, keys: [], charge: [], salience: null, attended });
    const f = (a: boolean, b: boolean) => computeFeatures({ kind: "link", rerank: 0.5, cosine: 0.7, now: clock, sources: [src(a), src(b)] });
    expect(f(false, false).attended).toBe(0);
    expect(f(true, false).attended).toBe(1);
    expect(f(false, true).attended).toBe(1);
    expect(computeFeatures({ kind: "link", rerank: 0.5, cosine: 0.7, now: clock, sources: [{ created_at: clock, context: null, keys: [], charge: [], salience: null }] }).attended).toBe(0);
    // the prior adds 0.3 to the logit
    const logit = (s: number) => Math.log(s / (1 - s));
    expect(logit(scoreOf(PRIOR_MODEL, f(true, false))) - logit(scoreOf(PRIOR_MODEL, f(false, false)))).toBeCloseTo(0.3, 6);
    // a model that never had the weight: parsed with 0, and the same score whether or not the feature is on
    const old = parseWeights({ bias: -1, weights: Object.fromEntries(FEATURE_NAMES.filter((k) => k !== "attended").map((k) => [k, 0.5])) });
    expect(old).not.toBeNull();
    expect(old!.weights.attended).toBe(0);
    expect(scoreOf(old!, f(true, true))).toBe(scoreOf(old!, f(false, false)));
  });
});

describe("export, import and purge", () => {
  const dir = mkdtempSync(join(tmpdir(), "attend-"));
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
  async function secondDb(): Promise<{ a2: Pool; p2: Pool }> {
    const name = `attend_import_${process.pid}_${seq++}`;
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
  async function seedPins() {
    const loop = (await V("mind_loop", { operation: "create", label: "kept loop", urgency: "burning" })).receipt.projection.id as string;
    const thread = (await V("mind_thread", { operation: "add", label: "kept thread" })).receipt.projection.thread.id as string;
    const node = (await V("mind_observe", { content: "a kept memory", texture: { charge: ["tender"] } })).receipt.projection.node_id as string;
    const live = (await attend({ operation: "pin", item_type: "loop", item_id: loop, note: "live" })).receipt.projection.pin;
    const released = (await attend({ operation: "pin", item_type: "thread", item_id: thread })).receipt.projection.pin;
    await attend({ operation: "release", pin_id: released.id });
    const liveNode = (await attend({ operation: "pin", item_type: "node", item_id: node })).receipt.projection.pin;
    return { loop, thread, node, live, released, liveNode };
  }

  it("export carries attention_pins; import keeps live pins live and released ones released, and a second import changes nothing", async () => {
    const s = await seedPins();
    const f = join(dir, `x${seq++}.json`);
    const exp = await exportMind(pool, "alpha", f);
    expect(exp.counts.attention_pins).toBe(3);
    const { a2, p2 } = await secondDb();
    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.attention_pins).toMatchObject({ inserted: 3, already_present: 0 });
    expect(rep.tables.attention_pins!.skipped_foreign_ref).toBeUndefined();
    const rows = (await a2.query("select id, item_type, item_id, note, released_at, released_event_id, pinned_event_id from attention_pins order by pinned_at, id")).rows;
    expect(rows.map((r) => [r.id, r.released_at === null])).toEqual([[s.live.id, true], [s.released.id, false], [s.liveNode.id, true]]);
    expect(rows[1].released_event_id).not.toBeNull();
    expect(rows[0]).toMatchObject({ item_type: "loop", item_id: s.loop, note: "live" });
    // the pin events travelled with the ledger and the live pins still count: the imported mind carries them
    expect((await a2.query("select count(*)::int n from events where kind like 'attend.%'")).rows[0].n).toBe(4);
    const imported = (await runVerb({ pool: p2, registry, now: () => new Date() }, alpha, "mind_attend", { mind_id: "alpha", operation: "list" })) as any;
    expect(imported.receipt.projection.pins).toBe(2);
    expect(imported.receipt.projection.items.filter((i: any) => i.pinned).map((i: any) => i.id).sort()).toEqual([s.loop, s.node].sort());
    // again: nothing new
    const events = (await a2.query("select count(*)::int n from events")).rows[0].n;
    const again = await importMind(p2, f, "alpha");
    expect(again.tables.attention_pins).toMatchObject({ inserted: 0, already_present: 3 });
    expect((await a2.query("select count(*)::int n from events")).rows[0].n).toBe(events);
    // a dry run counts without writing
    const { p2: p3 } = await secondDb();
    const dry = await importMind(p3, f, "alpha", { dry_run: true });
    expect(dry.tables.attention_pins).toMatchObject({ inserted: 3 });
  });

  it("a pin naming something outside the file is refused as a foreign reference, not imported", async () => {
    const s = await seedPins();
    const f = join(dir, `x${seq++}.json`);
    await exportMind(pool, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    doc.projections.attention_pins.find((p: any) => p.id === s.live.id).item_id = "00000000-0000-4000-8000-0000000000ff";
    writeFileSync(f, JSON.stringify(doc));
    const { a2, p2 } = await secondDb();
    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.attention_pins).toMatchObject({ inserted: 2, skipped_foreign_ref: 1 });
    expect((await a2.query("select count(*)::int n from attention_pins")).rows[0].n).toBe(2);
  });

  it("import keeps the cross-mind id check for pins, and tolerates only a clash on the partial unique index for the same mind", async () => {
    const s = await seedPins();
    const f = join(dir, `x${seq++}.json`);
    await exportMind(pool, "alpha", f);
    // a pin id that already belongs to another mind: refused, nothing imported
    const bn = await mkNode("beta thing", { mind: "beta" });
    const bpin = (await attend({ operation: "pin", item_type: "node", item_id: bn }, beta, "beta")).receipt.projection.pin;
    const doc = JSON.parse(readFileSync(f, "utf8"));
    doc.projections.attention_pins.find((p: any) => p.id === s.released.id).id = bpin.id;
    const bad = join(dir, `x${seq++}.json`);
    writeFileSync(bad, JSON.stringify(doc));
    await expect(importMind(pool, bad, "alpha")).rejects.toThrow(/already exists in another mind/);
    // a re-id'd live pin on an item the target already holds a live pin on: not an error, not brought in
    const doc2 = JSON.parse(readFileSync(f, "utf8"));
    doc2.projections.attention_pins.find((p: any) => p.id === s.live.id).id = "00000000-0000-4000-8000-0000000000aa";
    const ok = join(dir, `x${seq++}.json`);
    writeFileSync(ok, JSON.stringify(doc2));
    const before = (await admin.query("select count(*)::int n from attention_pins where mind_id = 'alpha'")).rows[0].n;
    const rep = await importMind(pool, ok, "alpha");
    expect(rep.tables.attention_pins!.inserted).toBe(0);
    expect((await admin.query("select count(*)::int n from attention_pins where mind_id = 'alpha'")).rows[0].n).toBe(before);
  });

  it("purge removes the mind's pins and only that mind's", async () => {
    await seedPins();
    const n = await mkNode("beta thing", { mind: "beta" });
    await attend({ operation: "pin", item_type: "node", item_id: n }, beta, "beta");
    expect((await admin.query("select count(*)::int c from attention_pins where mind_id = 'alpha'")).rows[0].c).toBe(3);
    const r = await purgeMind(admin, "alpha", { confirm: "alpha" });
    expect(r.counts).toMatchObject({ attention_pins: 3 });
    expect((await admin.query("select count(*)::int c from attention_pins where mind_id = 'alpha'")).rows[0].c).toBe(0);
    expect((await admin.query("select count(*)::int c from attention_pins where mind_id = 'beta'")).rows[0].c).toBe(1);
  });
});

describe("belief repair leaves pins out of its context", () => {
  it("pinning a core, rewriting it and settling does not put attend.* events in a repair's context_event_ids", async () => {
    const core = (await V("mind_identity", { operation: "affirm", section: "core", content: "I am steady" })).receipt.projection.node_id as string;
    const dep = await mkNode("depends on the core");
    await queryAs(pool, "alpha", "alpha", `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'derived_from', 'alpha', $1, $2)`, [dep, core]);
    expect((await attend({ operation: "pin", item_type: "node", item_id: core })).ok).toBe(true);
    expect((await V("mind_identity", { operation: "propose", section: "core", content: "I am steadier", target_node_id: core })).ok).toBe(true);
    expect((await run(alpha, "mind_identity", { mind_id: "alpha", operation: "settle" }, new Date(Date.now() + DAY + HOUR))).ok).toBe(true);
    const pass = await import("../src/daemon/index.js").then((m) => m.PASSES.find((x) => x.name === "notice.repair")!);
    const reports = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => new Date(Date.now() + DAY + 2 * HOUR) }, { trigger: "manual", minds: ["alpha"], passes: [pass] });
    expect(reports[0]!.passes[0]!.ok).toBe(true);
    const rows = (await admin.query("select payload from noticings where kind = 'repair'")).rows;
    expect(rows.length).toBeGreaterThan(0);
    const ids: string[] = rows.flatMap((r) => r.payload.context_event_ids ?? []);
    expect(ids.length).toBeGreaterThan(0); // the proposal's own events are there
    const kinds = (await admin.query("select kind from events where id = any($1::uuid[])", [ids])).rows.map((r) => r.kind);
    expect(kinds.some((k) => String(k).startsWith("attend."))).toBe(false);
    expect((await admin.query("select 1 from events where kind = 'attend.pin' and subject_id = $1", [core])).rows).toHaveLength(1);
  });
});
