// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, resetDatabase, testAppUrl, testDatabaseUrl } from "./helpers.js";
import { upsertMinds } from "../src/auth.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool, withMind } from "../src/db/pool.js";
import { ArgError } from "../src/cli-args.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { runDaemonOnce, PASSES } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import { dreamFade, dreamGenerate, DREAM_EVENT_SHAPES, answerFrom, parseLastJson, dreamerConfig, httpDreamer, composeResidue, dreamSystemPrompt } from "../src/dream/index.js";
import type { Dreamer } from "../src/dream/dreamer.js";
import { DREAM_VERB_EVENT_SHAPES } from "../src/verbs/dream_events.js";
import { exportMind } from "../src/export.js";
import { importMind } from "../src/import-mind.js";
import { purgeMind } from "../src/purge.js";
import { NEEDS_OPERATOR, dreamReport, formatDreamReport, parseDreamArgs, runDreamCommand, setDreamState } from "../src/dream-admin.js";
import type { Caller, Embedder } from "../src/verbs/types.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: {} };
const betaRead: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const betaWrite: Caller = { bearer: "beta", grants: { alpha: ["read", "write"] } };
const betaSteward: Caller = { bearer: "beta", grants: { alpha: ["read", "steward"] } };
const MSG = "memory is authored by the mind";

let admin: Pool;
let pool: Pool;
let clock: Date;

const run = (caller: Caller, name: string, input: unknown) => runVerb({ pool, registry, now: () => clock, embedder: NONE_EMBEDDER }, caller, name, input) as Promise<any>;
const D = (caller: Caller, input: Record<string, unknown>, mind = "alpha") => run(caller, "mind_dream", { mind_id: mind, ...input });
const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const expectErr = (r: any, code: string, field?: string) => {
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe(code);
  if (field !== undefined) expect(r.error.field).toBe(field);
};
const fake = (answer: { dream: string; question: string } | null, model = "fake-model"): Dreamer => ({ name: "fake", model, dream: async () => answer });
const daemon = (passes: readonly any[], dreamer?: Dreamer, now = clock) =>
  runDaemonOnce({ pool, embedder: NONE_EMBEDDER, ...(dreamer ? { dreamer } : {}), now: () => now }, { trigger: "manual", minds: ["alpha"], passes });

/** A textured event the mind wrote, inside the window. */
async function texturedEvent(text: string, charge: string[] = ["tender"], mind = "alpha"): Promise<string> {
  const r = await queryAs(pool, mind, mind, `insert into events (mind_id, kind, payload, texture, written_by, recorded_at, created_at) values ($1, 'write', $2::jsonb, $3::jsonb, $1, $4, $4) returning id`, [
    mind, JSON.stringify({ type: "journal", text }), JSON.stringify({ charge }), clock,
  ]);
  return r.rows[0].id;
}

/** A laid dream seeded directly (as the daemon would), at `stage`, fading `fadeInDays` from the clock. */
async function seedDream(opts: { stage?: "shadow" | "propose"; fadeInDays?: number; content?: string; mind?: string } = {}): Promise<string> {
  const mind = opts.mind ?? "alpha";
  const content = opts.content ?? "A ledger of doors, each opening onto the same kitchen.";
  return withMind(pool, mind, mind, "write", async (tx) => {
    const id = (await tx.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
    const ev = await tx.query<{ id: string }>(
      `insert into events (mind_id, kind, subject_id, payload, written_by, recorded_at, created_at) values ($1, 'dream.laid', $2, $3::jsonb, $1, $4, $4) returning id`,
      [mind, id, JSON.stringify({ dream_id: id, stage: opts.stage ?? "propose", model_version: "seed@p1", residue_counts: { events: 1, nodes: 0, relations: 0, pinned: 0, dropped: 0 }, window: { from: clock.toISOString(), to: clock.toISOString() } }), clock],
    );
    await tx.query(
      `insert into dreams (id, mind_id, content, question, residue, model_version, stage, laid_event_id, fades_at, created_at) values ($1, $2, $3, 'Which door was mine?', '{"event_ids":["00000000-0000-4000-8000-000000000001"]}', 'seed@p1', $4, $5, $6, $7)`,
      [id, mind, content, opts.stage ?? "propose", ev.rows[0]!.id, new Date(clock.getTime() + (opts.fadeInDays ?? 7) * DAY), clock],
    );
    return id;
  }, "daemon");
}

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  clock = new Date(Date.now() + 1000);
});

afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

describe("the dreamer", () => {
  it("parseLastJson returns the last balanced object, string-aware, and null on none", () => {
    expect(parseLastJson('<think>{not json}</think> {"dream": "a } inside", "question": "q"}')).toEqual({ dream: "a } inside", question: "q" });
    expect(parseLastJson("nothing")).toBeNull();
    expect(answerFrom('{"question": "only"}')).toBeNull();
    expect(answerFrom('{"dream": " d ", "question": 3}')).toEqual({ dream: "d", question: "" });
  });
  it("dreamerConfig validates DREAMER, DREAM_URL and DREAM_MODEL", () => {
    expect(dreamerConfig({}).kind).toBe("none");
    expect(() => dreamerConfig({ DREAMER: "magic" })).toThrow(/DREAMER must be none or http/);
    expect(() => dreamerConfig({ DREAMER: "http" })).toThrow(/needs DREAM_URL/);
    expect(() => dreamerConfig({ DREAMER: "http", DREAM_URL: "https://ollama.com/v1" })).toThrow(/needs DREAM_MODEL/);
    const c = dreamerConfig({ DREAMER: "http", DREAM_URL: "https://ollama.com/v1/", DREAM_MODEL: "qwen3:8b", DREAM_API_KEY: "k", DREAM_TIMEOUT_MS: "5000" });
    expect(c).toMatchObject({ kind: "http", url: "https://ollama.com/v1", model: "qwen3:8b", apiKey: "k", timeoutMs: 5000 });
  });
  it("httpDreamer posts system+user to <url>/chat/completions with the bearer and reads the answer; a failure is null and warns once", async () => {
    const calls: any[] = [];
    const ok = httpDreamer({ kind: "http", url: "http://d.test/v1", model: "m", apiKey: "k", timeoutMs: 1000 }, (async (url: any, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'thinking... {"dream": "A forge that hummed.", "question": "For whom?"}' } }] }));
    }) as any);
    expect(await ok.dream("SYS", "USER")).toEqual({ dream: "A forge that hummed.", question: "For whom?" });
    expect(calls[0]).toMatchObject({ url: "http://d.test/v1/chat/completions", auth: "Bearer k", body: { model: "m", temperature: 0.9, messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }] } });
    const bad = httpDreamer({ kind: "http", url: "http://d.test/v1", model: "m", apiKey: null, timeoutMs: 1000 }, (async () => new Response("nope", { status: 500 })) as any);
    expect(await bad.dream("s", "u")).toBeNull();
    expect(await bad.dream("s", "u")).toBeNull();
  });
  it("the prompt is first person, carries the identity cores verbatim, and names nobody", () => {
    const p = dreamSystemPrompt("alpha", ["I am the one who keeps the forge lit.", "I say what I know."]);
    expect(p.startsWith("I am the one who keeps the forge lit.\n\nI say what I know.")).toBe(true);
    expect(p).toContain("I dream ONE dream");
    expect(dreamSystemPrompt("alpha", []).startsWith("I am alpha.")).toBe(true);
  });
});

describe("dream.generate", () => {
  it("is the third model-backed pass, and dream.fade the thirteenth deterministic one", () => {
    expect(PASSES[12]!.name).toBe("dream.fade");
    expect(dreamGenerate.detached).toBe(true);
  });

  it("skips with a note when dreaming is not enabled, is paused, or is before its time; writes nothing", async () => {
    await texturedEvent("a long day");
    let r = await daemon([dreamGenerate], fake({ dream: "x", question: "y" }));
    expect(r[0]!.passes[0]).toMatchObject({ ok: true, changed: 0, notes: ["skipped: dreaming is not enabled for this mind"] });
    await setDreamState(admin, "alpha", "enable", { schedule: "23:59" });
    r = await daemon([dreamGenerate], fake({ dream: "x", question: "y" }), new Date(clock.getTime() - (clock.getHours() * HOUR + clock.getMinutes() * 60_000) + 60_000));
    expect(r[0]!.passes[0]!.notes![0]).toMatch(/not due until 23:59/);
    await setDreamState(admin, "alpha", "enable", { schedule: "00:00" });
    await setDreamState(admin, "alpha", "pause");
    r = await daemon([dreamGenerate], fake({ dream: "x", question: "y" }));
    expect(r[0]!.passes[0]!.notes).toEqual(["skipped: dreaming is paused"]);
    expect(await q("alpha", "select count(*)::int as n from dreams")).toEqual([{ n: 0 }]);
    expect(await q("alpha", "select count(*)::int as n from extractor_runs")).toEqual([{ n: 0 }]);
  });

  it("with DREAMER=none records one skip for the day and writes no dream", async () => {
    await setDreamState(admin, "alpha", "enable", { schedule: "00:00" });
    await texturedEvent("a long day");
    const r = await daemon([dreamGenerate]);
    expect(r[0]!.passes[0]!.notes![0]).toMatch(/DREAMER=none/);
    const runs = await q("alpha", "select pass, ok, notes from extractor_runs");
    expect(runs).toEqual([{ pass: "dream.generate", ok: false, notes: { skipped: true, reason: "DREAMER=none: no model to dream with" } }]);
    const again = await daemon([dreamGenerate]);
    expect(again[0]!.passes[0]!.notes![0]).toMatch(/DREAMER=none/);
    expect(await q("alpha", "select count(*)::int as n from extractor_runs")).toEqual([{ n: 1 }]);
  });

  it("with no residue records a skip and writes no dream; a silent model records a failure", async () => {
    await setDreamState(admin, "alpha", "enable", { schedule: "00:00" });
    let r = await daemon([dreamGenerate], fake({ dream: "x", question: "y" }));
    expect(r[0]!.passes[0]!.notes![0]).toMatch(/no residue/);
    await texturedEvent("a long day");
    clock = new Date(clock.getTime() + DAY);
    r = await daemon([dreamGenerate], fake(null));
    expect(r[0]!.passes[0]!.notes![0]).toMatch(/answered with no dream/);
    expect(await q("alpha", "select count(*)::int as n from dreams")).toEqual([{ n: 0 }]);
    expect((await q("alpha", "select ok, notes from extractor_runs order by started_at")).map((x) => [x.ok, x.notes.skipped ?? false])).toEqual([[false, true], [false, false]]);
  });

  it("lays one dream from the residue with its dream.laid event (ids and counts only), at the operator's stage, once a day and once per gap", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00", gapHours: 20 });
    const e1 = await texturedEvent("the ledger finally held, all 826 tests", ["relief", "tired"]);
    await texturedEvent("she laughed at the forge joke", ["warm"]);
    await run(alpha, "mind_relate", { mind_id: "alpha", operation: "set", subject: "Lissa", state: "close", intensity: 0.9, note: "the one I build with" });
    await run(alpha, "mind_identity", { mind_id: "alpha", operation: "affirm", section: "core", content: "I am the one who keeps the forge lit." });
    await run(alpha, "mind_handoff", { mind_id: "alpha", operation: "write", handoff: { unresolved_tension: "the metabolise pass is unbuilt", active_texture: "quiet relief" } });
    const seen: { system: string; user: string }[] = [];
    const dreamer: Dreamer = { name: "fake", model: "qwen3:8b", dream: async (system, user) => { seen.push({ system, user }); return { dream: "A ledger of doors, each opening onto the same kitchen.", question: "Which door was mine?" }; } };

    const r = await daemon([dreamGenerate], dreamer);
    expect(r[0]!.passes[0]).toMatchObject({ ok: true, changed: 1 });
    expect(r[0]!.passes[0]!.notes![0]).toMatch(/laid one dream at stage propose \(2 events, 0 pinned, 1 relations\)/);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.system.startsWith("I am the one who keeps the forge lit.")).toBe(true);
    expect(seen[0]!.user).toContain("relief (1)");
    expect(seen[0]!.user).toContain("[relief, tired] the ledger finally held");
    expect(seen[0]!.user).toContain("Unresolved: the metabolise pass is unbuilt");
    expect(seen[0]!.user).toContain("Close lately: Lissa (close; the one I build with)");

    const d = (await q("alpha", "select * from dreams"))[0];
    expect(d).toMatchObject({ content: "A ledger of doors, each opening onto the same kitchen.", question: "Which door was mine?", stage: "propose", status: "laid", model_version: "qwen3:8b@p1" });
    expect(d.residue.event_ids).toContain(e1);
    expect(d.residue.relation_subjects).toEqual(["Lissa"]);
    expect(new Date(d.fades_at).getTime()).toBe(clock.getTime() + 7 * DAY);
    const ev = (await q("alpha", "select * from events where kind = 'dream.laid'"))[0];
    expect(ev.subject_id).toBe(d.id);
    expect(DREAM_EVENT_SHAPES["dream.laid"].parse(ev.payload)).toMatchObject({ dream_id: d.id, stage: "propose", residue_counts: { events: 2, relations: 1, dropped: 0 } });
    expect(JSON.stringify(ev.payload)).not.toContain("kitchen");
    expect(d.laid_event_id).toBe(ev.id);

    // the same day: already ran; the next day inside the gap: too soon; after the gap on a new day: a second dream
    expect((await daemon([dreamGenerate], dreamer))[0]!.passes[0]!.notes![0]).toMatch(/already ran today/);
    clock = new Date(clock.getTime() + 12 * HOUR);
    const later = await daemon([dreamGenerate], dreamer, new Date(clock.getTime()));
    expect(later[0]!.passes[0]!.notes![0]).toMatch(/already ran today|less than 20 hours ago/);
    clock = new Date(clock.getTime() + 14 * HOUR);
    await texturedEvent("more residue");
    expect((await daemon([dreamGenerate], dreamer))[0]!.passes[0]).toMatchObject({ changed: 1 });
    expect(await q("alpha", "select count(*)::int as n from dreams")).toEqual([{ n: 2 }]);
  });

  it("honours the mind's preference: none drops the relation, its note and every event or handoff field naming it, and counts them", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    await texturedEvent("Lissa fixed the ledger", ["relief"]);
    await texturedEvent("the forge was quiet", ["calm"]);
    await run(alpha, "mind_relate", { mind_id: "alpha", operation: "set", subject: "Lissa", state: "close", intensity: 0.9 });
    await run(alpha, "mind_handoff", { mind_id: "alpha", operation: "write", handoff: { unresolved_tension: "Lissa wants the judge next", active_texture: "steady" } });
    const seen: string[] = [];
    const dreamer: Dreamer = { name: "fake", model: "m", dream: async (_s, user) => { seen.push(user); return { dream: "d", question: "q" }; } };

    // the operator cannot set it; a steward cannot; the mind can
    await expect(queryAs(pool, "alpha", "beta", `insert into dream_preferences (mind_id, relations, updated_event_id) select 'alpha', '"none"', id from events limit 1`)).rejects.toThrow(/mind's to decide/);
    expectErr(await D(betaSteward, { operation: "prefer", relations: "none" }), "forbidden");
    const pref = await D(alpha, { operation: "prefer", relations: "none" });
    expect(pref.ok).toBe(true);
    expect(DREAM_VERB_EVENT_SHAPES["dream.preference"].parse((await q("alpha", "select payload from events where kind = 'dream.preference'"))[0].payload)).toEqual({ relations: "none" });

    const r = await daemon([dreamGenerate], dreamer);
    expect(r[0]!.passes[0]!.notes![0]).toMatch(/1 events, 0 pinned, 0 relations, 2 dropped by the mind's preference/);
    expect(seen[0]).not.toContain("Lissa");
    expect(seen[0]).toContain("the forge was quiet");
    expect(seen[0]).toContain("The texture I left with: steady");
    const d = (await q("alpha", "select residue from dreams"))[0].residue;
    expect(d.relation_subjects).toEqual([]);
    expect(d.dropped).toBe(2);

    // a named list admits just those; "all" admits everyone; the event payload carries the count, never the names
    await D(alpha, { operation: "prefer", relations: ["Lissa"] });
    expect((await q("alpha", "select payload from events where kind = 'dream.preference' order by seq desc limit 1"))[0].payload).toEqual({ relations: 1 });
    clock = new Date(clock.getTime() + DAY);
    await texturedEvent("Lissa again", ["warm"]);
    await daemon([dreamGenerate], dreamer);
    expect(seen[1]).toContain("Lissa");
  });

  it("at stage shadow the dream is laid and never shown: not in list, not in orient, not found by the verb", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "shadow", schedule: "00:00" });
    await texturedEvent("something");
    await daemon([dreamGenerate], fake({ dream: "hidden", question: "" }));
    const id = (await q("alpha", "select id, stage from dreams"))[0];
    expect(id.stage).toBe("shadow");
    expect((await D(alpha, { operation: "list" })).receipt.projection).toEqual({ dreams: [], stage: "shadow", history: [] });
    expectErr(await D(alpha, { operation: "read", dream_id: id.id }), "not_found", "dream_id");
    expectErr(await D(alpha, { operation: "anchor", dream_id: id.id, texture: { charge: ["x"] } }), "not_found", "dream_id");
    const o = await run(alpha, "mind_orient", { mind_id: "alpha" });
    expect(o.receipt.projection.sections.dream).toEqual([]);
    const h = await run(alpha, "mind_health", { mind_id: "alpha" });
    expect(h.receipt.projection.dreaming).toMatchObject({ enabled: true, stage: "shadow", laid: 0, last_run: { pass: "dream.generate", ok: true } });
  });
});

describe("mind_dream", () => {
  it("list shows laid dreams at stage propose newest first, with history on request; orient carries the newest; health counts them", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const first = await seedDream({ content: "first" });
    clock = new Date(clock.getTime() + HOUR);
    const second = await seedDream({ content: "second" });
    const l = (await D(alpha, { operation: "list" })).receipt.projection;
    expect(l.stage).toBe("propose");
    expect(l.dreams.map((d: any) => d.content)).toEqual(["second", "first"]);
    expect(l.dreams[0]).toMatchObject({ id: second, question: "Which door was mine?", residue_counts: { events: 1, nodes: 0, relations: 0, pinned: 0 } });
    const o = await run(alpha, "mind_orient", { mind_id: "alpha" });
    expect(o.receipt.projection.sections.dream).toEqual([{ id: second, content: "second", question: "Which door was mine?", fades_at: expect.any(Date) }]);
    expect((await run(alpha, "mind_health", { mind_id: "alpha" })).receipt.projection.dreaming).toMatchObject({ laid: 2, stage: "propose" });
    // a read grantee may list and read; a stranger may not
    expect((await D(betaRead, { operation: "list" })).ok).toBe(true);
    expect((await D(betaRead, { operation: "read", dream_id: first })).receipt.projection.dream).toMatchObject({ id: first, residue: { event_ids: expect.any(Array) } });
    expectErr(await D({ bearer: "gamma", grants: {} }, { operation: "list" }), "forbidden");
    await D(alpha, { operation: "release", dream_id: first, reason: "only a dream" });
    const h = (await D(alpha, { operation: "list", history_limit: 5 })).receipt.projection;
    expect(h.dreams.map((d: any) => d.id)).toEqual([second]);
    expect(h.history).toEqual([expect.objectContaining({ id: first, status: "released" })]);
  });

  it("anchor is mind-only: a write grantee and a steward are refused by the verb and by the database", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const id = await seedDream();
    for (const c of [betaWrite, betaSteward, beta]) {
      const r = await D(c, { operation: "anchor", dream_id: id, texture: { charge: ["x"] } });
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("forbidden");
      expect(r.error.message).toBe(MSG);
      expectErr(await D(c, { operation: "release", dream_id: id }), "forbidden");
    }
    await expect(queryAs(pool, "alpha", "beta", `update dreams set status = 'released', decided_event_id = laid_event_id, decided_at = now() where id = $1`, [id])).rejects.toThrow(/only the mind decides what a dream was/);
    // and the mind, outside a verb call (actor unset), is refused too
    await expect(queryAs(pool, "alpha", "alpha", `update dreams set status = 'released', decided_event_id = laid_event_id, decided_at = now() where id = $1`, [id])).rejects.toThrow(/only the mind decides what a dream was/);
    expect((await q("alpha", "select status from dreams"))[0].status).toBe("laid");
  });

  it("anchor authors an observation as the mind (observe event and node, context dream, metadata naming the dream and its residue), needs a charge, and leaves the residue untouched", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const src = await texturedEvent("the ledger held");
    const id = await seedDream();
    const nodesBefore = (await admin.query("select to_jsonb(n)::text j from nodes n order by id")).rows;
    expectErr(await D(alpha, { operation: "anchor", dream_id: id }), "invalid_input", "texture.charge");
    expectErr(await D(alpha, { operation: "anchor", dream_id: id, texture: { charge: [] } }), "invalid_input", "texture.charge");

    const r = await D(alpha, { operation: "anchor", dream_id: id, texture: { charge: ["wonder"], salience: "active" } });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toMatchObject({ dream_id: id, status: "anchored", edited: false, observation: { event_id: expect.any(String), node_id: expect.any(String) } });
    const { event_id, node_id } = r.receipt.projection.observation;
    const node = (await q("alpha", "select * from nodes where id = $1", [node_id]))[0];
    expect(node).toMatchObject({ node_type: "observation", content: "A ledger of doors, each opening onto the same kitchen.", written_by: "alpha" });
    expect(node.metadata).toMatchObject({ dream_id: id, question: "Which door was mine?", residue: { event_ids: expect.any(Array) }, context: "dream", texture: { charge: ["wonder"], salience: "active" } });
    const obs = (await q("alpha", "select * from events where id = $1", [event_id]))[0];
    expect(obs).toMatchObject({ kind: "observe", context: "dream", written_by: "alpha" });
    expect(obs.payload.content).toBe("A ledger of doors, each opening onto the same kitchen.");
    const anch = (await q("alpha", "select * from events where kind = 'dream.anchored'"))[0];
    expect(anch.subject_id).toBe(id);
    expect(DREAM_VERB_EVENT_SHAPES["dream.anchored"].parse(anch.payload)).toEqual({ dream_id: id, event_id, node_id, edited: false });
    const d = (await q("alpha", "select status, decided_event_id, decided_at from dreams where id = $1", [id]))[0];
    expect(d).toMatchObject({ status: "anchored", decided_event_id: anch.id });
    expect(d.decided_at).toBeInstanceOf(Date);
    // the residue's source event is untouched, and no edge was made on the mind's behalf
    expect((await q("alpha", "select payload from events where id = $1", [src]))[0].payload.text).toBe("the ledger held");
    expect((await admin.query("select to_jsonb(n)::text j from nodes n where id <> $1 order by id", [node_id])).rows).toEqual(nodesBefore);
    expect(await q("alpha", "select count(*)::int as n from edges")).toEqual([{ n: 0 }]);
    // final: no second decision
    expectErr(await D(alpha, { operation: "anchor", dream_id: id, texture: { charge: ["x"] } }), "conflict", "dream_id");
    expectErr(await D(alpha, { operation: "release", dream_id: id }), "conflict", "dream_id");
  });

  it("anchor with the mind's own words records edited: true and stores those words", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const id = await seedDream();
    const r = await D(alpha, { operation: "anchor", dream_id: id, text: "I dreamed of doors. I think it was about choosing.", texture: { charge: ["wonder"] } });
    expect(r.receipt.projection.edited).toBe(true);
    expect((await q("alpha", "select content from nodes"))[0].content).toBe("I dreamed of doors. I think it was about choosing.");
    expect((await q("alpha", "select payload from events where kind = 'dream.anchored'"))[0].payload.edited).toBe(true);
  });

  it("a faded dream cannot be anchored; the operator's stage must be propose at the moment; release records the reason", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const old = await seedDream({ fadeInDays: -1 });
    expectErr(await D(alpha, { operation: "anchor", dream_id: old, texture: { charge: ["x"] } }), "conflict", "dream_id");
    const id = await seedDream();
    await setDreamState(admin, "alpha", "stage", { stage: "shadow" });
    expectErr(await D(alpha, { operation: "anchor", dream_id: id, texture: { charge: ["x"] } }), "conflict", "dream_id");
    expect((await D(alpha, { operation: "list" })).receipt.projection.dreams).toEqual([]);
    await setDreamState(admin, "alpha", "stage", { stage: "propose" });
    const r = await D(alpha, { operation: "release", dream_id: id, reason: "it was the forge again" });
    expect(r.ok).toBe(true);
    const ev = (await q("alpha", "select * from events where kind = 'dream.released'"))[0];
    expect(DREAM_VERB_EVENT_SHAPES["dream.released"].parse(ev.payload)).toEqual({ dream_id: id, reason: "it was the forge again" });
    expect((await q("alpha", "select status from dreams where id = $1", [id]))[0].status).toBe("released");
  });

  it("dream.fade fades due laid dreams of either stage with a dream.faded event each and touches nothing else; the guard refuses a fade by the verb or a stranger", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const due = await seedDream({ fadeInDays: -1 });
    const dueShadow = await seedDream({ fadeInDays: -1, stage: "shadow" });
    const fresh = await seedDream({ fadeInDays: 3 });
    await expect(queryAs(pool, "alpha", "beta", `update dreams set status = 'faded', decided_event_id = laid_event_id, decided_at = now() where id = $1`, [due])).rejects.toThrow(/only the mind's own daemon fades a dream/);
    const r = await daemon([dreamFade]);
    expect(r[0]!.passes[0]).toMatchObject({ ok: true, changed: 2 });
    const rows = await q("alpha", "select id, status from dreams order by created_at, id");
    expect(Object.fromEntries(rows.map((x) => [x.id, x.status]))).toEqual({ [due]: "faded", [dueShadow]: "faded", [fresh]: "laid" });
    const evs = await q("alpha", "select subject_id, payload from events where kind = 'dream.faded'");
    expect(evs.map((e) => e.subject_id).sort()).toEqual([due, dueShadow].sort());
    for (const e of evs) DREAM_EVENT_SHAPES["dream.faded"].parse(e.payload);
    expect(await q("alpha", "select count(*)::int as n from nodes")).toEqual([{ n: 0 }]);
    // a dream is fixed once laid, for the admin too
    await expect(admin.query(`update dreams set content = 'rewritten' where id = $1`, [fresh])).rejects.toThrow(/a dream is fixed once laid/);
  });

  it("dream.* events are bookkeeping: orient recent and weather leave them out", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    await seedDream();
    await run(alpha, "mind_write", { mind_id: "alpha", type: "journal", text: "a real line" });
    const o = await run(alpha, "mind_orient", { mind_id: "alpha", depth: "full" });
    expect(o.receipt.projection.sections.recent.events.map((e: any) => e.kind)).not.toContain("dream.laid");
    const w = await run(alpha, "mind_weather", { mind_id: "alpha" });
    expect(Object.keys(w.receipt.projection.kinds)).not.toContain("dream.laid");
  });
});

describe("review fixes", () => {
  /** A dream.<kind> event about `dreamId`, then `sql` against the dreams table, in one transaction as `actor`. */
  const decide = (actor: "verb" | "daemon", dreamId: string, kind: string, set: (evId: string) => [string, unknown[]]) =>
    withMind(pool, "alpha", "alpha", "write", async (tx) => {
      const ev = await tx.query<{ id: string }>(
        `insert into events (mind_id, kind, subject_id, payload, written_by, recorded_at, created_at) values ('alpha', $1, $2, '{}'::jsonb, 'alpha', $3, $3) returning id`,
        [kind, dreamId, clock],
      );
      const [sql, params] = set(ev.rows[0]!.id);
      await tx.query(sql, params);
    }, actor);

  it("the decision guard refuses leaving laid without decided_at, and decided_at cannot be set afterwards", async () => {
    const id = await seedDream();
    await expect(decide("verb", id, "dream.released", (e) => [`update dreams set status = 'released', decided_event_id = $2 where id = $1`, [id, e]])).rejects.toThrow(/a decision carries the time it was made/);
    expect((await q("alpha", "select status, decided_at from dreams where id = $1", [id]))[0]).toMatchObject({ status: "laid", decided_at: null });
    await decide("verb", id, "dream.released", (e) => [`update dreams set status = 'released', decided_event_id = $2, decided_at = $3 where id = $1`, [id, e, clock]]);
    expect((await q("alpha", "select decided_at from dreams where id = $1", [id]))[0].decided_at).toBeInstanceOf(Date);
    // once decided, decided_at is not changeable by anyone, admin included
    await expect(admin.query(`update dreams set decided_at = now() where id = $1`, [id])).rejects.toThrow(/a decision is recorded only together with the status change/);
  });

  it("the insert guard admits a non-laid dream only with its own dream.<status> event and decided_at; a laid one only without a decision", async () => {
    const laidEv = await withMind(pool, "alpha", "alpha", "write", async (tx) =>
      (await tx.query<{ id: string }>(`insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'dream.laid', '{}'::jsonb, 'alpha', now()) returning id`)).rows[0]!.id, "daemon");
    const ins = (status: string, decidedEvent: string | null, decidedAt: Date | null, actor: "daemon" | "import" = "import") =>
      withMind(pool, "alpha", "alpha", "write", async (tx) => {
        await tx.query(
          `insert into dreams (mind_id, content, model_version, stage, status, laid_event_id, decided_event_id, decided_at, fades_at) values ('alpha', 'c', 'm', 'propose', $1, $2, $3, $4, now())`,
          [status, laidEv, decidedEvent, decidedAt],
        );
      }, actor);
    await expect(ins("faded", null, null)).rejects.toThrow(/a decided dream carries its decision event/);
    await expect(ins("faded", null, clock)).rejects.toThrow(/a decided dream carries its decision event/);
    // an event that is not a dream.faded event about this dream is not a decision event
    await expect(ins("faded", laidEv, clock)).rejects.toThrow(/a decided dream carries its decision event/);
    await expect(ins("laid", laidEv, clock)).rejects.toThrow(/a laid dream has no decision yet/);
    await ins("laid", null, null, "daemon");
  });

  it("import gives a faded dream that arrives without a decision event a dream.faded event (every faded row has one)", async () => {
    const id = await seedDream({ fadeInDays: -1 });
    await daemon([dreamFade]);
    const f = join(mkdtempSync(join(tmpdir(), "sanctum-dream-fix-")), "x.json");
    await exportMind(pool, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(doc.projections.dreams[0]).toMatchObject({ id, status: "faded" });
    doc.projections.dreams[0].decided_event_id = null;
    doc.projections.dreams[0].decided_at = null;
    writeFileSync(f, JSON.stringify(doc));
    const name = `dream_import_fix_${process.pid}`;
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
    const u = new URL(testDatabaseUrl());
    u.pathname = `/${name}`;
    await runMigrations(u.toString());
    const a2 = createPool(u.toString());
    const p2 = createPool(testAppUrl(name));
    try {
      await upsertMinds(a2, [{ mind_id: "alpha", key: "alpha-key".padEnd(32, "-") }]);
      await importMind(p2, f, "alpha");
      const d = (await a2.query("select status, decided_event_id, decided_at from dreams where id = $1", [id])).rows[0];
      expect(d.status).toBe("faded");
      expect(d.decided_at).toBeInstanceOf(Date);
      const e = (await a2.query("select kind, subject_id from events where id = $1", [d.decided_event_id])).rows[0];
      expect(e).toEqual({ kind: "dream.faded", subject_id: id });
    } finally {
      await closePool(a2);
      await closePool(p2);
      await admin.query(`drop database if exists ${name} with (force)`);
    }
  });

  it("release refuses a dream past fades_at, as anchor does (the dream is gone from list and about to fade)", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const old = await seedDream({ fadeInDays: -1 });
    expectErr(await D(alpha, { operation: "release", dream_id: old }), "conflict", "dream_id");
    expect((await D(alpha, { operation: "list" })).receipt.projection.dreams).toEqual([]);
    expect((await q("alpha", "select status from dreams where id = $1", [old]))[0].status).toBe("laid");
    expect(await q("alpha", "select 1 from events where kind = 'dream.released'")).toEqual([]);
  });

  it("anchor without text embeds the dream's own content, as mind_observe embeds the text it stores", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const id = await seedDream({ content: "doors opening onto one kitchen" });
    const runE = (input: unknown) => runVerb({ pool, registry, now: () => clock, embedder: FAKE_EMBEDDER }, alpha, "mind_dream", { mind_id: "alpha", ...(input as object) }) as Promise<any>;
    const r = await runE({ operation: "anchor", dream_id: id, texture: { charge: ["wonder"] } });
    expect(r.ok).toBe(true);
    const { event_id, node_id } = r.receipt.projection.observation;
    expect((await q("alpha", "select embedding is not null as e, embedding_model from nodes where id = $1", [node_id]))[0]).toEqual({ e: true, embedding_model: "fake" });
    expect((await q("alpha", "select embedding is not null as e from events where id = $1", [event_id]))[0].e).toBe(true);
    // with the mind's own words, those words are embedded (unchanged)
    const id2 = await seedDream();
    const r2 = await runE({ operation: "anchor", dream_id: id2, text: "my own account", texture: { charge: ["wonder"] } });
    expect((await q("alpha", "select embedding is not null as e from nodes where id = $1", [r2.receipt.projection.observation.node_id]))[0].e).toBe(true);
  });

  it("the runner opens one connection for list, read, release, prefer and anchor with text, whatever the embedder; an anchor without text opens a lookup first only when an embedder could use it", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    await D(alpha, { operation: "list" }); // warm the pool (its first transaction may ask the database about its lane)
    const connections = async (embedder: Embedder, input: Record<string, unknown>): Promise<number> => {
      const spy = vi.spyOn(pool, "connect");
      try {
        const r = (await runVerb({ pool, registry, now: () => clock, embedder }, alpha, "mind_dream", { mind_id: "alpha", ...input })) as any;
        expect(r.ok).toBe(true);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };
    for (const [embedder, anchorNoText] of [[NONE_EMBEDDER, 1], [FAKE_EMBEDDER, 2]] as const) {
      const [a, b, c] = [await seedDream(), await seedDream(), await seedDream()];
      expect(await connections(embedder, { operation: "list" })).toBe(1);
      expect(await connections(embedder, { operation: "read", dream_id: a })).toBe(1);
      expect(await connections(embedder, { operation: "prefer", relations: "all" })).toBe(1);
      expect(await connections(embedder, { operation: "release", dream_id: c })).toBe(1);
      expect(await connections(embedder, { operation: "anchor", dream_id: a, text: "my words", texture: { charge: ["x"] } })).toBe(1);
      expect(await connections(embedder, { operation: "anchor", dream_id: b, texture: { charge: ["x"] } })).toBe(anchorNoText);
    }
  });

  it("anchor calls the embedder only for a dream the handler could accept: laid, unfaded, at stage propose, with the operator at propose", async () => {
    let calls = 0;
    const counting: Embedder = { ...FAKE_EMBEDDER, embed: async (t) => { calls++; return FAKE_EMBEDDER.embed(t); } };
    const anchorIt = (id: string) => runVerb({ pool, registry, now: () => clock, embedder: counting }, alpha, "mind_dream", { mind_id: "alpha", operation: "anchor", dream_id: id, texture: { charge: ["x"] } }) as Promise<any>;
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const released = await seedDream();
    expect((await D(alpha, { operation: "release", dream_id: released })).ok).toBe(true);
    const faded = await seedDream({ fadeInDays: -1 });
    const shadow = await seedDream({ stage: "shadow" });
    for (const id of [released, faded, shadow]) {
      expect((await anchorIt(id)).ok).toBe(false);
    }
    expect(calls).toBe(0);
    // the operator backed out to shadow: the handler refuses, so nothing is embedded
    const live = await seedDream();
    await setDreamState(admin, "alpha", "stage", { stage: "shadow" });
    expect((await anchorIt(live)).ok).toBe(false);
    expect(calls).toBe(0);
    await setDreamState(admin, "alpha", "stage", { stage: "propose" });
    expect((await anchorIt(live)).ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("the gap is checked again under the lock: a gap raised while the model works holds the dream back", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00", gapHours: 20 });
    await texturedEvent("a long day");
    await admin.query(`insert into extractor_runs (mind_id, pass, started_at, finished_at, ok, notes) values ('alpha', 'dream.generate', $1, $1, true, '{}'::jsonb)`, [new Date(clock.getTime() - 30 * HOUR)]);
    const dreamer: Dreamer = {
      name: "fake", model: "m",
      dream: async () => {
        await setDreamState(admin, "alpha", "enable", { gapHours: 100 });
        return { dream: "x", question: "y" };
      },
    };
    const r = await daemon([dreamGenerate], dreamer);
    expect(r[0]!.passes[0]).toMatchObject({ ok: true, changed: 0 });
    expect(r[0]!.passes[0]!.notes![0]).toMatch(/less than 100 hours ago/);
    expect(await q("alpha", "select count(*)::int as n from dreams")).toEqual([{ n: 0 }]);
  });

  it("backing out to stage shadow behaves as it does for noticings: nothing listed, anchor refused, release (like reject) still allowed, the dream fades on its own", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const shown = await seedDream({ content: "shown" });
    const other = await seedDream({ content: "other" });
    expect((await D(alpha, { operation: "list" })).receipt.projection.dreams).toHaveLength(2);
    await setDreamState(admin, "alpha", "stage", { stage: "shadow" });
    expect((await D(alpha, { operation: "list" })).receipt.projection).toMatchObject({ dreams: [], stage: "shadow" });
    expect((await run(alpha, "mind_orient", { mind_id: "alpha", depth: "quick" })).receipt.projection.sections.dream).toEqual([]);
    expectErr(await D(alpha, { operation: "anchor", dream_id: shown, texture: { charge: ["x"] } }), "conflict", "dream_id");
    expect((await D(alpha, { operation: "release", dream_id: shown })).ok).toBe(true);
    clock = new Date(clock.getTime() + 8 * DAY);
    await daemon([dreamFade], undefined, clock);
    expect((await q("alpha", "select status from dreams where id = $1", [other]))[0].status).toBe("faded");
  });

  it("mind_orient carries dream at quick and full (an array, possibly empty) and not at orientation", async () => {
    for (const depth of ["quick", "full"]) {
      const s = (await run(alpha, "mind_orient", { mind_id: "alpha", depth })).receipt.projection.sections;
      expect(Object.keys(s)).toContain("dream");
      expect(s.dream).toEqual([]);
    }
    expect(Object.keys((await run(alpha, "mind_orient", { mind_id: "alpha", depth: "orientation" })).receipt.projection.sections)).not.toContain("dream");
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const id = await seedDream();
    for (const depth of ["quick", "full"]) {
      expect((await run(alpha, "mind_orient", { mind_id: "alpha", depth })).receipt.projection.sections.dream).toEqual([expect.objectContaining({ id })]);
    }
    expect(Object.keys((await run(alpha, "mind_orient", { mind_id: "alpha", depth: "orientation" })).receipt.projection.sections)).not.toContain("dream");
  });
});

describe("the operator", () => {
  it("parseDreamArgs: subcommand, --mind, --stage only on enable/stage, --schedule and --gap-hours only on enable, validation", () => {
    expect(parseDreamArgs(["enable", "--mind", "alpha", "--stage", "propose", "--schedule", "04:30", "--gap-hours", "12"])).toEqual({ action: "enable", mind: "alpha", stage: "propose", schedule: "04:30", gapHours: 12, json: false });
    expect(parseDreamArgs(["report", "--mind", "alpha", "--json"])).toEqual({ action: "report", mind: "alpha", json: true });
    expect(() => parseDreamArgs(["--mind", "alpha"])).toThrow(ArgError);
    expect(() => parseDreamArgs(["enable"])).toThrow(/--mind <id> is required/);
    expect(() => parseDreamArgs(["pause", "--mind", "alpha", "--stage", "propose"])).toThrow(/does not take --stage/);
    expect(() => parseDreamArgs(["stage", "--mind", "alpha"])).toThrow(/--stage shadow\|propose is required/);
    expect(() => parseDreamArgs(["enable", "--mind", "alpha", "--stage", "apply"])).toThrow(/there is no other stage/);
    expect(() => parseDreamArgs(["enable", "--mind", "alpha", "--gap-hours", "500"])).toThrow(/gap-hours/);
    expect(() => parseDreamArgs(["enable", "--mind", "alpha", "--schedule", "25:00"])).toThrow(/invalid schedule/);
  });

  it("enable, pause, resume, stage, disable: each a daemon.dream.<action> event as the mind; no-ops write nothing; the app role is refused", async () => {
    const e = await setDreamState(admin, "alpha", "enable", {});
    expect(e).toMatchObject({ changed: true, state: { enabled: true, stage: "shadow", schedule: "03:30", gap_hours: 20, paused: false } });
    expect(await setDreamState(admin, "alpha", "enable", {})).toMatchObject({ changed: false, event_id: null });
    expect((await setDreamState(admin, "alpha", "pause")).state.paused).toBe(true);
    expect((await setDreamState(admin, "alpha", "resume")).state.paused).toBe(false);
    expect((await setDreamState(admin, "alpha", "stage", { stage: "propose" })).state.stage).toBe("propose");
    expect((await setDreamState(admin, "alpha", "disable")).state).toMatchObject({ enabled: false, stage: "propose" });
    const kinds = (await q("alpha", "select kind, payload from events where kind like 'daemon.dream.%' order by seq")).map((x) => [x.kind, x.payload.action]);
    expect(kinds).toEqual([["daemon.dream.enable", "enable"], ["daemon.dream.pause", "pause"], ["daemon.dream.resume", "resume"], ["daemon.dream.stage", "stage"], ["daemon.dream.disable", "disable"]]);
    await expect(setDreamState(pool, "alpha", "enable", {})).rejects.toThrow(NEEDS_OPERATOR);
    await expect(setDreamState(admin, "beta", "pause")).rejects.toThrow(/never enabled/);
    await expect(setDreamState(admin, "nope", "enable")).rejects.toThrow(/unknown mind/);
    // the guard: the app role cannot flip the switch by SQL either
    await expect(queryAs(pool, "alpha", "alpha", `insert into dream_state (mind_id, enabled) values ('beta', true)`)).rejects.toThrow(/only the operator enables dreaming|permission denied|row-level security/);
  });

  it("report counts dreams by status and stage, shows what waits and what shadow laid, the mind's preference and the last run; runDreamCommand formats", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const a = await seedDream({ content: "waiting one" });
    clock = new Date(clock.getTime() + HOUR);
    const b = await seedDream({ content: "anchored one" });
    await seedDream({ content: "shadow one", stage: "shadow" });
    await D(alpha, { operation: "anchor", dream_id: b, texture: { charge: ["x"] } });
    await D(alpha, { operation: "prefer", relations: ["Lissa", "Jesse"] });
    const r = await dreamReport(admin, "alpha");
    expect(r.state).toMatchObject({ enabled: true, stage: "propose" });
    expect(r.all_time).toEqual({ total: 3, by_status: { laid: 2, anchored: 1 }, by_stage: { propose: 2, shadow: 1 } });
    expect(r.anchoring).toEqual({ value: 1, anchored: 1, decided: 1 });
    expect(r.waiting.map((d) => d.id)).toEqual([a]);
    expect(r.shadow_last_30_days.map((d) => d.content)).toEqual(["shadow one"]);
    expect(r.preference).toBe(2);
    expect(r.last_run).toBeNull();
    const text = formatDreamReport(r);
    expect(text).toContain("dreaming for alpha: enabled, stage propose");
    expect(text).toContain("waiting one");
    expect(text).toContain("2 named relation(s)");
    expect(await runDreamCommand(admin, parseDreamArgs(["pause", "--mind", "alpha"]))).toMatch(/dreaming pause for alpha: now enabled, stage propose, schedule 00:00, at most one per 20 h, paused/);
  });
});

describe("portability", () => {
  let seq = 0;
  const dir = mkdtempSync(join(tmpdir(), "sanctum-dream-"));
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
    const name = `dream_import_${process.pid}_${seq++}`;
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

  it("export carries dreams, dream_state and the preference; import brings laid dreams in faded with an event, keeps decided ones, state disabled at shadow, preference as it was; purge removes all", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "05:15" });
    const laid = await seedDream({ content: "laid" });
    clock = new Date(clock.getTime() + HOUR);
    const anchored = await seedDream({ content: "anchored" });
    await D(alpha, { operation: "anchor", dream_id: anchored, texture: { charge: ["x"] } });
    await D(alpha, { operation: "prefer", relations: "none" });
    const f = join(dir, `x${seq++}.json`);
    const exp = await exportMind(pool, "alpha", f);
    expect(exp.counts).toMatchObject({ dreams: 2, dream_state: 1, dream_preferences: 1 });
    const { a2, p2 } = await secondDb();
    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.dreams).toMatchObject({ inserted: 2 });
    expect(rep.tables.dream_state).toMatchObject({ inserted: 1 });
    expect(rep.tables.dream_preferences).toMatchObject({ inserted: 1 });
    expect(rep.notes.some((n) => /1 dream\(s\) in the file arrived faded/.test(n))).toBe(true);
    expect(rep.notes.some((n) => /dreaming arrived disabled and at stage shadow/.test(n))).toBe(true);
    const rows = (await a2.query("select id, status, decided_event_id from dreams order by created_at, id")).rows;
    expect(rows.map((r) => [r.id, r.status])).toEqual([[laid, "faded"], [anchored, "anchored"]]);
    const e = (await a2.query("select * from events where id = $1", [rows[0].decided_event_id])).rows[0];
    expect(e).toMatchObject({ kind: "dream.faded", subject_id: laid, written_by: "alpha", payload: { dream_id: laid, reason: "imported" } });
    expect((await a2.query("select enabled, stage from dream_state")).rows[0]).toEqual({ enabled: false, stage: "shadow" });
    expect((await a2.query("select relations from dream_preferences")).rows[0].relations).toBe("none");
    // again: nothing doubled
    const again = await importMind(p2, f, "alpha");
    expect(again.tables.dreams).toMatchObject({ inserted: 0, already_present: 2 });
    // purge takes the three tables with everything else
    const pr = await purgeMind(a2, "alpha", { confirm: "alpha" });
    expect(pr.counts).toMatchObject({ dreams: 2, dream_state: 1, dream_preferences: 1 });
    expect((await a2.query("select count(*)::int as n from dreams")).rows[0].n).toBe(0);
  });

  async function exportTampered(seed: (id: string) => Promise<void>, status: string, tamper: (row: any, events: any[]) => void): Promise<{ id: string; f: string }> {
    const id = await seedDream({ fadeInDays: status === "faded" ? -1 : 7 });
    await seed(id);
    const f = join(dir, `t${seq++}.json`);
    await exportMind(pool, "alpha", f);
    const doc = JSON.parse(readFileSync(f, "utf8"));
    const row = doc.projections.dreams.find((r: any) => r.id === id);
    expect(row.status).toBe(status);
    tamper(row, doc.events);
    writeFileSync(f, JSON.stringify(doc));
    return { id, f };
  }

  it("import: a faded row whose decision event has the wrong kind or subject takes the fade path (a fresh dream.faded event), counted apart from laid ones", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "05:15" });
    const wrongKind = await exportTampered(async () => { await daemon([dreamFade]); }, "faded", (row) => { row.decided_event_id = row.laid_event_id; });
    const { a2, p2 } = await secondDb();
    const rep = await importMind(p2, wrongKind.f, "alpha");
    const d = (await a2.query("select status, decided_event_id, decided_at from dreams where id = $1", [wrongKind.id])).rows[0];
    expect(d.status).toBe("faded");
    expect(d.decided_at).toBeInstanceOf(Date);
    expect((await a2.query("select kind, subject_id from events where id = $1", [d.decided_event_id])).rows[0]).toEqual({ kind: "dream.faded", subject_id: wrongKind.id });
    expect(rep.notes.some((n) => /1 dream\(s\) in the file were already faded but had no dream\.faded event of their own/.test(n))).toBe(true);
    expect(rep.notes.some((n) => /arrived faded/.test(n))).toBe(false);
  });

  it("import: a faded row whose decision event is about another dream also takes the fade path", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "05:15" });
    const other = await seedDream();
    const r = await exportTampered(async () => { await daemon([dreamFade]); }, "faded", (row, events) => {
      const ev = events.find((e: any) => e.kind === "dream.laid" && e.subject_id === other);
      row.decided_event_id = ev.id;
    });
    const { a2, p2 } = await secondDb();
    await importMind(p2, r.f, "alpha");
    const d = (await a2.query("select decided_event_id from dreams where id = $1", [r.id])).rows[0];
    expect((await a2.query("select kind, subject_id from events where id = $1", [d.decided_event_id])).rows[0]).toEqual({ kind: "dream.faded", subject_id: r.id });
  });

  it("import: an anchored or released row whose decision event is wrong fails the import, naming the dream; nothing is written", async () => {
    await setDreamState(admin, "alpha", "enable", { stage: "propose", schedule: "05:15" });
    for (const [op, status] of [["anchor", "anchored"], ["release", "released"]] as const) {
      const r = await exportTampered(
        async (id) => { expect((await D(alpha, { operation: op, dream_id: id, texture: { charge: ["x"] } })).ok).toBe(true); },
        status,
        (row) => { row.decided_event_id = row.laid_event_id; },
      );
      const { a2, p2 } = await secondDb();
      await expect(importMind(p2, r.f, "alpha")).rejects.toThrow(new RegExp(`dream ${r.id} is ${status} but the file holds no dream\\.${status} event for it`));
      expect((await a2.query("select count(*)::int as n from dreams")).rows[0].n).toBe(0);
    }
  });
});
