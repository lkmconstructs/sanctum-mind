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
import { runDaemonOnce } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import { setExtractorState } from "../src/extractor-admin.js";
import { exportMind } from "../src/export.js";
import { importMind } from "../src/import-mind.js";
import { purgeMind } from "../src/purge.js";
import { noticeMetabolise, EXTRACTOR_EVENT_SHAPES } from "../src/extractor/index.js";
import { answerFrom, httpMetaboliser, NONE_METABOLISER, type Metaboliser, type MetaboliseAnswer } from "../src/extractor/metaboliser.js";
import { metaboliserConfig } from "../src/extractor/metabolise_config.js";
import { composeStretch, metaboliseSystemPrompt } from "../src/extractor/metabolise_prompt.js";
import { noticeAcceptedPayload, noticeRejectedPayload } from "../src/verbs/notice_events.js";
import { stretchPayload } from "../src/verbs/mind_metabolise.js";
import type { Caller } from "../src/verbs/types.js";

const DAY = 86_400_000;
const alpha: Caller = { bearer: "alpha", grants: {} };
const betaWrite: Caller = { bearer: "beta", grants: { alpha: ["read", "write"] } };
const MIND_ONLY = "memory is authored by the mind";

let admin: Pool;
let pool: Pool;
let clock: Date;

const run = (caller: Caller, name: string, input: unknown, embedder = NONE_EMBEDDER) =>
  runVerb({ pool, registry, now: () => clock, embedder }, caller, name, input) as Promise<any>;
const stretchVerb = (input: Record<string, unknown>, caller = alpha, embedder = NONE_EMBEDDER) => run(caller, "mind_metabolise", { mind_id: "alpha", ...input }, embedder);
const notice = (input: Record<string, unknown>, embedder = NONE_EMBEDDER) => run(alpha, "mind_notice", { mind_id: "alpha", ...input }, embedder);
const q = <T = any>(sql: string, params: unknown[] = [], mind = "alpha"): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const expectErr = (r: any, code: string, field?: string) => {
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe(code);
  if (field !== undefined) expect(r.error.field).toBe(field);
};

const TURNS = [
  { speaker: "other", name: "Rowan", text: "I got the job. I start Monday." },
  { speaker: "self", text: "That is wonderful. I am so glad for you." },
];

/** A metaboliser that records what it was asked and answers as told (an Error is thrown). */
function fake(answer: MetaboliseAnswer | null | Error | ((user: string) => MetaboliseAnswer | null)): Metaboliser & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    async metabolise(system, user) {
      calls.push({ system, user });
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(user) : answer;
    },
  };
}

const feeling = (emotion: string, content = `I felt ${emotion}.`) => ({ emotion, weight: "medium" as const, pillar: "bond", content });
const relation = (subject: string, note = `${subject} matters to me.`, o: { alias?: string; warmth?: boolean } = {}) => ({
  subject, note, ...(o.alias === undefined ? {} : { alias: o.alias }), warmth: o.warmth ?? false,
});
const answer = (feelings: any[] = [], relations: any[] = []): MetaboliseAnswer => ({ feelings, relations });

const go = async (m: Metaboliser = NONE_METABOLISER, now = clock) => {
  const r = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, metaboliser: m, now: () => now }, { trigger: "manual", minds: ["alpha"], passes: [noticeMetabolise] });
  return r[0]!.passes[0]!;
};
const enable = (stage: "shadow" | "propose" = "propose") => setExtractorState(admin, "alpha", "enable", { stage, schedule: "23:59" });
const queued = async (turns: unknown[] = TURNS): Promise<{ event_id: string; queued_id: string }> => {
  const r = await stretchVerb({ turns });
  expect(r.ok).toBe(true);
  return r.receipt.projection;
};
const noticings = () => q("select * from noticings order by created_at, id");
const queueRows = () => q("select * from metabolise_queue order by created_at, id");

/** One stretch run through the pass with `a`; the extractor at `stage`. */
async function proposed(a: MetaboliseAnswer, stage: "shadow" | "propose" = "propose", turns: unknown[] = TURNS) {
  await enable(stage);
  const s = await queued(turns);
  const p = await go(fake(a));
  expect(p).toMatchObject({ ok: true });
  return { s, p, rows: await noticings() };
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

describe("the metaboliser (model dependency)", () => {
  it("metaboliserConfig validates METABOLISER, METABOLISE_URL and METABOLISE_MODEL", () => {
    expect(metaboliserConfig({}).kind).toBe("none");
    expect(() => metaboliserConfig({ METABOLISER: "magic" })).toThrow(/METABOLISER must be none or http/);
    expect(() => metaboliserConfig({ METABOLISER: "http" })).toThrow(/needs METABOLISE_URL/);
    expect(() => metaboliserConfig({ METABOLISER: "http", METABOLISE_URL: "https://ollama.com/v1" })).toThrow(/needs METABOLISE_MODEL/);
    expect(() => metaboliserConfig({ METABOLISE_TIMEOUT_MS: "0" })).toThrow(/METABOLISE_TIMEOUT_MS/);
    expect(metaboliserConfig({ METABOLISER: "http", METABOLISE_URL: "https://ollama.com/v1/", METABOLISE_MODEL: "qwen3:8b", METABOLISE_API_KEY: "k", METABOLISE_TIMEOUT_MS: "5000" }))
      .toMatchObject({ kind: "http", url: "https://ollama.com/v1", model: "qwen3:8b", apiKey: "k", timeoutMs: 5000 });
  });

  it("answerFrom coerces strictly: malformed entries are dropped, an empty answer is an answer, prose is none", () => {
    const text = `thinking {not json} ${JSON.stringify({
      feelings: [
        { emotion: "joy", weight: "heavy", pillar: "bond", content: "I felt joy." },
        { emotion: "joy", weight: "huge", pillar: "bond", content: "bad weight" },
        { emotion: "", weight: "light", pillar: "x", content: "no emotion" },
        { emotion: "calm", weight: "light", content: "no pillar" },
        "nope",
      ],
      relations: [
        { subject: "Rowan", note: "Starts a new job.", alias: "Ro", warmth: true },
        { subject: "Rowan", note: "alias is the name itself", alias: "rowan", warmth: "yes" },
        { subject: "", note: "no subject" },
        { subject: "Sam" },
      ],
    })}`;
    expect(answerFrom(text)).toEqual({
      feelings: [{ emotion: "joy", weight: "heavy", pillar: "bond", content: "I felt joy." }],
      relations: [
        { subject: "Rowan", note: "Starts a new job.", alias: "Ro", warmth: true },
        { subject: "Rowan", note: "alias is the name itself", warmth: false },
      ],
    });
    expect(answerFrom('{"feelings": [], "relations": []}')).toEqual({ feelings: [], relations: [] });
    expect(answerFrom('{"other": 1}')).toBeNull();
    expect(answerFrom("nothing here")).toBeNull();
  });

  it("httpMetaboliser posts system+user to <url>/chat/completions with the bearer, temperature 0.4 and max_tokens 1200; a failure is null", async () => {
    const calls: any[] = [];
    const ok = httpMetaboliser({ kind: "http", url: "http://m.test/v1", model: "m", apiKey: "k", timeoutMs: 1000 }, (async (url: any, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok {"feelings": [], "relations": []}' } }] }));
    }) as any);
    expect(await ok.metabolise("SYS", "USER")).toEqual({ feelings: [], relations: [] });
    expect(calls[0]).toMatchObject({ url: "http://m.test/v1/chat/completions", auth: "Bearer k", body: { model: "m", temperature: 0.4, max_tokens: 1200, messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }] } });
    const bad = httpMetaboliser({ kind: "http", url: "http://m.test/v1", model: "m", apiKey: null, timeoutMs: 1000 }, (async () => new Response("no", { status: 500 })) as any);
    expect(await bad.metabolise("s", "u")).toBeNull();
    expect(await NONE_METABOLISER.metabolise("s", "u")).toBeNull();
  });

  it("the prompt is first person with the identity cores as preamble (or 'I am <mind>'), labels turns from the turns alone, and keeps Lantern's restraint", () => {
    const p = metaboliseSystemPrompt("alpha", ["I am the one who keeps the forge lit.", "I say what I know."]);
    expect(p.startsWith("I am the one who keeps the forge lit.\n\nI say what I know.")).toBe(true);
    expect(p).toContain("a pet name is an alias, never a fact");
    expect(p).toContain("A passing mood is not biography");
    expect(p).toContain("Most stretches add nothing new here, and that's right");
    expect(p).toContain("An empty list is a complete answer");
    expect(metaboliseSystemPrompt("alpha", []).startsWith("I am alpha.")).toBe(true);
    const user = composeStretch([{ speaker: "other", name: "Rowan", text: "hi" }, { speaker: "self", text: "hello" }, { speaker: "other", text: "who?" }], "the kitchen");
    expect(user).toBe("Where this was: the kitchen\n\nThe stretch:\nRowan: hi\nme: hello\nthem: who?");
    expect(readFileSync(new URL("../src/extractor/metabolise_prompt.ts", import.meta.url), "utf8")).toContain("Required Notice: Copyright 2026 Nana & Vex");
  });
});

describe("mind_metabolise", () => {
  it("is the 28th verb, in the Remember region, and writes ONE metabolise.stretch event and ONE queue row, not embedded", async () => {
    expect(registry).toHaveLength(28);
    const r = await stretchVerb({ turns: TURNS, context: "the kitchen" }, alpha, FAKE_EMBEDDER);
    expect(r.ok).toBe(true);
    const { event_id, queued_id } = r.receipt.projection;
    expect(r.receipt.event_id).toBe(event_id);
    const ev = await q("select kind, payload, embedding is null as no_vec, embedding_model, written_by from events where kind like 'metabolise.%'");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "metabolise.stretch", no_vec: true, embedding_model: null, written_by: "alpha", payload: { turns: TURNS, context: "the kitchen" } });
    expect(stretchPayload.safeParse(ev[0].payload).success).toBe(true);
    const rows = await queueRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: queued_id, stretch_event_id: event_id, status: "queued", note: null, done_at: null });
    // the stretch writes nothing else: no node, no noticing
    expect(await q("select count(*)::int n from nodes")).toEqual([{ n: 0 }]);
    expect(await noticings()).toEqual([]);
  });

  it("refuses a bearer that is not the mind (even a write grantee), and writes nothing", async () => {
    expectErr(await stretchVerb({ turns: TURNS }, betaWrite), "forbidden");
    expect((await stretchVerb({ turns: TURNS }, betaWrite)).error.message).toBe(MIND_ONLY);
    expect(await queueRows()).toEqual([]);
    expect(await q("select 1 from events where kind = 'metabolise.stretch'")).toEqual([]);
  });

  it("refuses more than 24000 characters across the turns, more than 60 turns, an empty list, an unknown speaker; accepts exactly 24000", async () => {
    expectErr(await stretchVerb({ turns: [{ speaker: "other", text: "a".repeat(8001) }, { speaker: "self", text: "b".repeat(8001) }, { speaker: "other", text: "c".repeat(8001) }] }), "invalid_input", "turns");
    expectErr(await stretchVerb({ turns: [{ speaker: "other", text: "a".repeat(12001) }] }), "invalid_input", "turns.0.text");
    expectErr(await stretchVerb({ turns: Array.from({ length: 61 }, () => ({ speaker: "self", text: "x" })) }), "invalid_input");
    expectErr(await stretchVerb({ turns: [] }), "invalid_input");
    expectErr(await stretchVerb({ turns: [{ speaker: "narrator", text: "x" }] }), "invalid_input");
    expectErr(await stretchVerb({ turns: [{ speaker: "self", text: "x", extra: 1 }] }), "invalid_input");
    expect(await queueRows()).toEqual([]);
    expect((await stretchVerb({ turns: [{ speaker: "other", text: "a".repeat(12000) }, { speaker: "self", text: "b".repeat(12000) }] })).ok).toBe(true);
  });

  it("records the stretch even when the extractor is off, paused or at shadow", async () => {
    await queued();
    await enable("shadow");
    await queued([{ speaker: "self", text: "again" }]);
    await setExtractorState(admin, "alpha", "pause");
    await queued([{ speaker: "self", text: "and again" }]);
    expect((await queueRows()).map((r) => r.status)).toEqual(["queued", "queued", "queued"]);
    expect(await q("select count(*)::int n from events where kind = 'metabolise.stretch'")).toEqual([{ n: 3 }]);
  });

  it("the database guard: only the mind's own verb call queues a stretch, only its daemon finishes one, and a finished one is final", async () => {
    const s = await queued();
    const stretchEvent = s.event_id;
    const insert = (actor: any, bearer = "alpha", mind = "alpha", status = "queued", ev = stretchEvent) =>
      withMind(pool, mind, bearer, "write", (tx) => tx.query(`insert into metabolise_queue (mind_id, stretch_event_id, status, done_at) values ($1, $2, $3, $4)`, [mind, ev, status, status === "queued" ? null : clock]), actor);
    // a second row for the same stretch is refused by the unique key whatever the actor
    await expect(insert("verb")).rejects.toThrow(/unique|duplicate/i);
    // another event of the mind is not a stretch
    const mkOther = await withMind(pool, "alpha", "alpha", "write", async (tx) => (await tx.query(`insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'write', '{}', 'alpha', now()) returning id`)).rows[0].id, "verb");
    await expect(insert("verb", "alpha", "alpha", "queued", mkOther)).rejects.toThrow(/its own metabolise\.stretch event/);
    // a daemon or an operator may not queue; a verb may not queue it done
    await expect(insert("daemon", "alpha", "alpha", "queued", mkOther)).rejects.toThrow(/queued by the mind's own call/);
    await expect(insert(undefined, "alpha", "alpha", "queued", mkOther)).rejects.toThrow(/queued by the mind's own call/);
    // updates
    const upd = (actor: any, set: string, bearer = "alpha") => withMind(pool, "alpha", bearer, "write", (tx) => tx.query(`update metabolise_queue set ${set} where id = $1`, [s.queued_id]), actor);
    await expect(upd("verb", "status = 'done', done_at = now()")).rejects.toThrow(/only the mind's own daemon works through the queue/);
    await expect(upd("daemon", "status = 'done', done_at = now()", "beta")).rejects.toThrow(/only the mind's own daemon/);
    await expect(upd("daemon", "stretch_event_id = gen_random_uuid()")).rejects.toThrow();
    await expect(upd("daemon", "status = 'done'")).rejects.toThrow(/carries the time it finished/);
    await expect(upd("daemon", "status = 'queued', note = 'x'")).rejects.toThrow(/note and time change only with its status/);
    await upd("daemon", "status = 'failed', done_at = now(), note = 'x'");
    await expect(upd("daemon", "status = 'done', done_at = now()")).rejects.toThrow(/final/);
  });
});

describe("notice.metabolise", () => {
  it("is the last model-backed pass, detached", () => {
    expect(noticeMetabolise.detached).toBe(true);
    expect(noticeMetabolise.name).toBe("notice.metabolise");
  });

  it("skips with a note when the extractor is not enabled or is paused; the stretch stays queued and the model is not asked", async () => {
    await queued();
    const m = fake(answer([feeling("joy")]));
    expect(await go(m)).toMatchObject({ ok: true, changed: 0, notes: ["skipped: the extractor is not enabled for this mind"] });
    await enable();
    await setExtractorState(admin, "alpha", "pause");
    expect((await go(m)).notes).toEqual(["skipped: the extractor is paused"]);
    expect(m.calls).toHaveLength(0);
    expect((await queueRows())[0]).toMatchObject({ status: "queued" });
    expect(await noticings()).toEqual([]);
  });

  it("ignores the extractor's schedule: a stretch is worked at any hour, and again the same day", async () => {
    await enable("propose"); // schedule 23:59
    await queued();
    expect((await go(fake(answer([feeling("joy")])))).changed).toBe(1);
    await queued([{ speaker: "self", text: "later" }]);
    expect((await go(fake(answer([feeling("calm")])))).changed).toBe(1);
  });

  it("METABOLISER=none skips with a note and leaves the stretch queued; with nothing queued it says so", async () => {
    await enable();
    expect((await go(NONE_METABOLISER)).notes![0]).toMatch(/skipped: METABOLISER=none/);
    expect((await go(fake(answer()))).notes).toEqual(["skipped: no stretch is queued"]);
    await queued();
    expect((await go(NONE_METABOLISER)).notes![0]).toMatch(/METABOLISER=none/);
    expect((await queueRows())[0]).toMatchObject({ status: "queued" });
    expect(await q("select 1 from extractor_runs where pass = 'notice.metabolise'")).toEqual([]);
  });

  it("proposes a feeling and a relation with notice.proposed events (ids and numbers only), scored, from the stretch, and marks the row done", async () => {
    const { s, p, rows } = await proposed(answer([feeling("joy", "I felt joy for Rowan.")], [relation("Rowan", "Starts a new job on Monday.", { alias: "Ro", warmth: true })]));
    expect(p).toMatchObject({ ok: true, changed: 2 });
    expect(rows).toHaveLength(2);
    const f = rows.find((r) => r.kind === "feeling");
    const r = rows.find((x) => x.kind === "relation");
    expect(f).toMatchObject({ sources: [s.event_id], stage: "propose", status: "pending", model_version: 0, payload: { emotion: "joy", weight: "medium", pillar: "bond", content: "I felt joy for Rowan.", prompt_version: 1 } });
    expect(r).toMatchObject({ sources: [s.event_id], payload: { subject: "Rowan", note: "Starts a new job on Monday.", alias: "Ro", warmth: true, prompt_version: 1 } });
    expect(f.score).toBeGreaterThan(0);
    expect(f.score).toBeLessThan(1);
    expect(f.features).toMatchObject({ kind_feeling: 1, kind_relation: 0, kind_link: 0, rerank_missing: 1 });
    expect(r.features).toMatchObject({ kind_feeling: 0, kind_relation: 1 });
    expect(Object.keys(f.features)).toHaveLength(15);
    expect(new Date(f.expires_at).getTime()).toBe(clock.getTime() + 14 * DAY);
    // the events: ids and numbers, never the text
    const evs = await q("select id, subject_id, payload from events where kind = 'notice.proposed' order by seq");
    expect(evs).toHaveLength(2);
    for (const e of evs) {
      expect(EXTRACTOR_EVENT_SHAPES["notice.proposed"].safeParse(e.payload).success).toBe(true);
      expect(JSON.stringify(e.payload)).not.toMatch(/Rowan|joy|Ro\b/);
      expect(Object.keys(e.payload).sort()).toEqual(["model_version", "noticing_id", "noticing_kind", "score", "source_count", "stage"]);
    }
    expect(f.proposed_event_id).toBe(evs.find((e) => e.subject_id === f.id).id);
    const row = (await queueRows())[0];
    expect(row).toMatchObject({ status: "done", note: "1 feeling(s), 1 relation(s) proposed" });
    expect(row.done_at).not.toBeNull();
    // one run row, counts only
    const runs = await q("select * from extractor_runs where pass = 'notice.metabolise'");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ok: true, notes: { stage: "propose", model: "fake-model", prompt_version: 1, done: 1, failed: 0, expired: 0, proposed: { feeling: 1, relation: 1 } } });
  });

  it("empty arrays propose nothing and mark the row done", async () => {
    const { rows } = await proposed(answer());
    expect(rows).toEqual([]);
    expect((await queueRows())[0]).toMatchObject({ status: "done", note: "0 feeling(s), 0 relation(s) proposed" });
    expect(await q("select 1 from events where kind = 'notice.proposed'")).toEqual([]);
  });

  it("a null answer, or a throw, marks the row failed with a note and proposes nothing; the next stretch is still worked", async () => {
    await enable();
    await queued();
    const p = await go(fake(null));
    expect(p).toMatchObject({ ok: true, changed: 0 });
    expect((await queueRows())[0]).toMatchObject({ status: "failed", note: "the metaboliser gave no usable answer" });
    await queued([{ speaker: "self", text: "second" }]);
    expect(await go(fake(new Error("boom")))).toMatchObject({ ok: true, changed: 0 });
    expect((await queueRows())[1]).toMatchObject({ status: "failed" });
    await queued([{ speaker: "self", text: "third" }]);
    expect((await go(fake(answer([feeling("calm")])))).changed).toBe(1);
    expect((await queueRows()).map((r) => r.status)).toEqual(["failed", "failed", "done"]);
    expect(await q("select ok from extractor_runs where pass = 'notice.metabolise' order by started_at")).toEqual([{ ok: false }, { ok: false }, { ok: true }]);
  });

  it("attribution: the prompt labels a self turn 'me' and an other turn by its name, carries the cores and the context; a pet name rides as an alias, never as a feeling", async () => {
    await enable();
    expect((await run(alpha, "mind_identity", { mind_id: "alpha", operation: "affirm", section: "core", content: "I am the keeper of the quiet hours." })).ok).toBe(true);
    await queued([
      { speaker: "other", name: "Rowan", text: "Call me Ro, everyone does." },
      { speaker: "self", text: "I will, Ro." },
      { speaker: "other", text: "who is this?" },
    ]);
    await stretchVerb({ turns: TURNS, context: "the porch" });
    const m = fake(answer([], [relation("Rowan", "Goes by Ro.", { alias: "Ro" })]));
    await go(m);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.system.startsWith("I am the keeper of the quiet hours.")).toBe(true);
    expect(m.calls[0]!.user).toBe("The stretch:\nRowan: Call me Ro, everyone does.\nme: I will, Ro.\nthem: who is this?");
    expect(m.calls[1]!.user).toBe("Where this was: the porch\n\nThe stretch:\nRowan: I got the job. I start Monday.\nme: That is wonderful. I am so glad for you.");
    const rows = await noticings();
    expect(rows.filter((r) => r.kind === "feeling")).toEqual([]);
    expect(rows.filter((r) => r.kind === "relation").map((r) => r.payload.alias)).toEqual(["Ro", "Ro"]);
    expect(rows.every((r) => r.payload.subject === "Rowan")).toBe(true);
  });

  it("dedupes within an answer (kind, lowercased emotion or subject) and against what is already proposed for the stretch", async () => {
    await enable();
    const s = await queued();
    // something already proposed for this stretch: a feeling "Joy" (a racing daemon, a crash after the insert)
    const pe = await withMind(pool, "alpha", "alpha", "write", async (tx) => (await tx.query(`insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'notice.proposed', '{}', 'alpha', now()) returning id`)).rows[0].id, "daemon");
    await queryAs(pool, "alpha", "alpha", `insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at) values ('alpha', 'feeling', $1::uuid[], '{"emotion":"Joy"}', 0.5, 'propose', $2, $3)`, [[s.event_id], pe, new Date(clock.getTime() + DAY)]);
    const m = fake(answer(
      [feeling("joy"), feeling("pride"), feeling("PRIDE"), feeling("Pride")],
      [relation("Rowan"), relation("rowan", "again"), relation("Sam")],
    ));
    const p = await go(m);
    expect(p.changed).toBe(3);
    const rows = (await noticings()).filter((r) => r.payload.prompt_version === 1);
    expect(rows.map((r) => [r.kind, (r.payload.emotion ?? r.payload.subject)]).sort()).toEqual([["feeling", "pride"], ["relation", "Rowan"], ["relation", "Sam"]]);
  });

  it("caps a stretch at five feelings and five relations", async () => {
    const { rows } = await proposed(answer(
      Array.from({ length: 7 }, (_, i) => feeling(`e${i}`)),
      Array.from({ length: 7 }, (_, i) => relation(`person${i}`)),
    ));
    expect(rows.filter((r) => r.kind === "feeling").map((r) => r.payload.emotion).sort()).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect(rows.filter((r) => r.kind === "relation").map((r) => r.payload.subject).sort()).toEqual(["person0", "person1", "person2", "person3", "person4"]);
  });

  it("works the oldest three queued stretches a tick", async () => {
    await enable();
    for (let i = 0; i < 4; i++) await queued([{ speaker: "self", text: `s${i}` }]);
    const m = fake(answer());
    await go(m);
    expect(m.calls).toHaveLength(3);
    expect(m.calls.map((c) => c.user)).toEqual(["The stretch:\nme: s0", "The stretch:\nme: s1", "The stretch:\nme: s2"]);
    expect((await queueRows()).map((r) => r.status)).toEqual(["done", "done", "done", "queued"]);
    await go(m);
    expect((await queueRows()).map((r) => r.status)).toEqual(["done", "done", "done", "done"]);
  });

  it("a stretch queued more than seven days is marked failed 'expired unprocessed' without asking the model; one inside the week is still worked", async () => {
    await enable();
    await queued([{ speaker: "self", text: "first" }]);
    const m = fake(answer([feeling("joy")]));
    // six days on: still inside the week
    expect((await go(m, new Date(Date.now() + 6 * DAY))).changed).toBe(1);
    expect(m.calls).toHaveLength(1);
    // eight days on: a stretch queued now has waited more than seven days
    await queued([{ speaker: "self", text: "second" }]);
    await queued([{ speaker: "self", text: "third" }]);
    const p = await go(m, new Date(Date.now() + 8 * DAY));
    expect(p.notes![0]).toMatch(/2 expired unprocessed/);
    expect(m.calls).toHaveLength(1);
    expect((await queueRows()).map((x) => [x.status, x.note])).toEqual([["done", "1 feeling(s), 0 relation(s) proposed"], ["failed", "expired unprocessed"], ["failed", "expired unprocessed"]]);
    expect(await go(m, new Date(Date.now() + 8 * DAY))).toMatchObject({ notes: ["skipped: no stretch is queued"] });
    expect((await q("select notes from extractor_runs where pass = 'notice.metabolise' order by started_at desc limit 1"))[0].notes).toMatchObject({ expired: 2, done: 0, failed: 0 });
  });

  it("the gate is checked again under the lock: an extractor paused while the model worked leaves the stretch queued and writes nothing", async () => {
    await enable();
    await queued();
    const m: Metaboliser = {
      name: "fake", model: "m",
      async metabolise() {
        await setExtractorState(admin, "alpha", "pause");
        return answer([feeling("joy")]);
      },
    };
    const p = await go(m);
    expect(p).toMatchObject({ ok: true, changed: 0 });
    expect(p.notes![0]).toMatch(/1 left queued/);
    expect((await queueRows())[0]).toMatchObject({ status: "queued" });
    expect(await noticings()).toEqual([]);
  });

  it("leaves nodes and edges byte-identical and appends only notice.proposed events", async () => {
    const ids: string[] = [];
    for (const c of ["one", "two"]) ids.push((await queryAs(pool, "alpha", "alpha", `insert into nodes (mind_id, node_type, label, content, written_by) values ('alpha', 'observation', $1, $1, 'alpha') returning id`, [c])).rows[0].id);
    await queryAs(pool, "alpha", "alpha", `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'related_to', 'alpha', $1, $2)`, ids);
    await enable();
    await queued();
    const snap = async () => ({
      nodes: (await admin.query("select to_jsonb(n)::text j from nodes n order by id")).rows.map((r) => r.j),
      edges: (await admin.query("select to_jsonb(e)::text j from edges e order by id")).rows.map((r) => r.j),
    });
    const before = await snap();
    const maxSeq = (await admin.query("select max(seq)::bigint s from events")).rows[0].s;
    expect((await go(fake(answer([feeling("joy")], [relation("Rowan")])))).changed).toBe(2);
    expect(await snap()).toEqual(before);
    const kinds = (await admin.query("select distinct kind from events where seq > $1", [maxSeq])).rows.map((r) => r.kind);
    expect(kinds).toEqual(["notice.proposed"]);
  });
});

describe("shadow and propose", () => {
  it("a shadow row is scored and recorded but is invisible: not in list, not found on accept, even after the operator moves to propose", async () => {
    const { rows } = await proposed(answer([feeling("joy")], [relation("Rowan")]), "shadow");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.stage === "shadow")).toBe(true);
    expect((await notice({ operation: "list" })).receipt.projection.noticings).toEqual([]);
    for (const r of rows) expectErr(await notice({ operation: "accept", noticing_id: r.id, state: "close" }), "not_found", "noticing_id");
    await setExtractorState(admin, "alpha", "stage", { stage: "propose" });
    expect((await notice({ operation: "list" })).receipt.projection.noticings).toEqual([]);
    for (const r of rows) expectErr(await notice({ operation: "accept", noticing_id: r.id, state: "close" }), "not_found", "noticing_id");
    expect(await q("select 1 from relations")).toEqual([]);
  });

  it("at propose they are listed, ranked with the rest, each source shown as 'stretch of N turns' (not an empty snippet), and filterable by kind", async () => {
    const { s } = await proposed(answer([feeling("joy")], [relation("Rowan")]));
    const all = (await notice({ operation: "list" })).receipt.projection;
    expect(all.stage).toBe("propose");
    expect(all.noticings.map((n: any) => n.kind).sort()).toEqual(["feeling", "relation"]);
    for (const n of all.noticings) expect(n.sources).toEqual([{ id: s.event_id, type: "event", snippet: "stretch of 2 turns" }]);
    expect((await notice({ operation: "list", kind: "feeling" })).receipt.projection.noticings).toHaveLength(1);
    expect((await notice({ operation: "list", kind: "relation" })).receipt.projection.noticings[0].payload.subject).toBe("Rowan");
    // a one-turn stretch reads in the singular
    await queued([{ speaker: "self", text: "x" }]);
    await go(fake(answer([feeling("calm")])));
    const n = (await notice({ operation: "list", kind: "feeling" })).receipt.projection.noticings.find((x: any) => x.payload.emotion === "calm");
    expect(n.sources[0].snippet).toBe("stretch of 1 turn");
    // mind_orient carries them beside links and patterns
    const o = await run(alpha, "mind_orient", { mind_id: "alpha", depth: "quick" });
    expect(o.receipt.projection.sections.noticings.map((x: any) => x.kind).sort()).toEqual(["feeling", "feeling", "relation"]);
  });
});

describe("mind_notice accept: feeling", () => {
  it("makes an observation authored by the mind: charge [emotion, ...extra], context metabolised, metadata {noticing_id, sources}; notice.accepted carries ids only", async () => {
    const { s, rows } = await proposed(answer([feeling("joy", "I felt joy for Rowan.")]));
    const id = rows[0].id;
    const r = await notice({ operation: "accept", noticing_id: id, charge: ["proud", "joy", "relief"] });
    expect(r.ok).toBe(true);
    const { node_id, observe_event_id } = r.receipt.projection;
    expect(r.receipt.projection).toMatchObject({ noticing_id: id, status: "accepted" });
    const node = (await q("select * from nodes where id = $1", [node_id]))[0];
    expect(node).toMatchObject({ node_type: "observation", content: "I felt joy for Rowan.", written_by: "alpha" });
    expect(node.metadata).toMatchObject({ noticing_id: id, sources: [s.event_id], context: "metabolised", event_id: observe_event_id, texture: { charge: ["joy", "proud", "relief"] } });
    const obs = (await q("select kind, payload, texture, context, written_by from events where id = $1", [observe_event_id]))[0];
    expect(obs).toMatchObject({ kind: "observe", context: "metabolised", written_by: "alpha", payload: { content: "I felt joy for Rowan." }, texture: { charge: ["joy", "proud", "relief"] } });
    const acc = (await q("select payload from events where kind = 'notice.accepted'"))[0].payload;
    expect(noticeAcceptedPayload.safeParse(acc).success).toBe(true);
    expect(acc).toEqual({ noticing_id: id, kind: "feeling", sources: [s.event_id], observe_event_id, node_id, edited: false });
    expect(JSON.stringify(acc)).not.toMatch(/Rowan|joy/);
    expect((await noticings())[0]).toMatchObject({ status: "accepted" });
    // the stretch itself is untouched
    expect((await q("select payload from events where id = $1", [s.event_id]))[0].payload.turns).toHaveLength(2);
    expectErr(await notice({ operation: "accept", noticing_id: id }), "conflict", "noticing_id");
  });

  it("the mind may edit the content; the edit is marked", async () => {
    const { rows } = await proposed(answer([feeling("joy")]));
    const r = await notice({ operation: "accept", noticing_id: rows[0].id, content: "Gladness, and a small ache." });
    expect(r.ok).toBe(true);
    expect((await q("select content from nodes where id = $1", [r.receipt.projection.node_id]))[0].content).toBe("Gladness, and a small ache.");
    expect((await q("select payload from events where kind = 'notice.accepted'"))[0].payload.edited).toBe(true);
  });

  it("is embedded from the proposal's content when the mind gives none, and from the mind's own words when it does", async () => {
    const { rows } = await proposed(answer([feeling("joy", "I felt a bright lantern light for Rowan."), feeling("calm", "A quiet harbour settled in me.")]));
    const [f1, f2] = [rows.find((r) => r.payload.emotion === "joy"), rows.find((r) => r.payload.emotion === "calm")];
    const vec = async (text: string) => `[${[...(await FAKE_EMBEDDER.embed([text]))[0]!].join(",")}]`;
    const a = await notice({ operation: "accept", noticing_id: f1.id }, FAKE_EMBEDDER);
    expect(a.ok).toBe(true);
    const d1 = (await q("select (embedding <=> $2::vector) as d, embedding_model m from nodes where id = $1", [a.receipt.projection.node_id, await vec("I felt a bright lantern light for Rowan.")]))[0];
    expect(d1.m).toBe("fake");
    expect(d1.d).toBeCloseTo(0, 5);
    expect((await q("select embedding is not null as e from events where id = $1", [a.receipt.projection.observe_event_id]))[0].e).toBe(true);
    const b = await notice({ operation: "accept", noticing_id: f2.id, content: "Something entirely different in my words." }, FAKE_EMBEDDER);
    const d2 = (await q("select (embedding <=> $2::vector) as d from nodes where id = $1", [b.receipt.projection.node_id, await vec("Something entirely different in my words.")]))[0];
    expect(d2.d).toBeCloseTo(0, 5);
    // with no embedder nothing is embedded
    const { rows: more } = await proposed(answer([feeling("hope", "Hope, lightly.")]));
    const c = await notice({ operation: "accept", noticing_id: more.find((r) => r.payload.emotion === "hope").id });
    expect((await q("select embedding is null as e from nodes where id = $1", [c.receipt.projection.node_id]))[0].e).toBe(true);
  });

  it("refuses the inputs that belong to other kinds (note, state, intensity, decision, label, edge_type, weight) and is mind-only", async () => {
    const { rows } = await proposed(answer([feeling("joy")]));
    const id = rows[0].id;
    expectErr(await notice({ operation: "accept", noticing_id: id, note: "x" }), "invalid_input", "note");
    expectErr(await notice({ operation: "accept", noticing_id: id, state: "close" }), "invalid_input", "state");
    expectErr(await notice({ operation: "accept", noticing_id: id, intensity: 0.4 }), "invalid_input", "intensity");
    expectErr(await notice({ operation: "accept", noticing_id: id, decision: "keep" }), "invalid_input", "decision");
    expectErr(await notice({ operation: "accept", noticing_id: id, label: "x" }), "invalid_input", "label");
    expectErr(await notice({ operation: "accept", noticing_id: id, edge_type: "related_to" }), "invalid_input", "edge_type");
    expectErr(await notice({ operation: "accept", noticing_id: id, weight: 0.5 }), "invalid_input", "weight");
    expectErr(await run(betaWrite, "mind_notice", { mind_id: "alpha", operation: "accept", noticing_id: id }), "forbidden");
    expect((await noticings())[0]).toMatchObject({ status: "pending" });
    expect(await q("select 1 from nodes")).toEqual([]);
  });

  it("charge belongs to feelings only", async () => {
    const { rows } = await proposed(answer([], [relation("Rowan")]));
    expectErr(await notice({ operation: "accept", noticing_id: rows[0].id, state: "close", charge: ["x"] }), "invalid_input", "charge");
  });

  it("reject records the reason, writes notice.rejected with the kind, and changes nothing else", async () => {
    const { rows } = await proposed(answer([feeling("joy")], [relation("Rowan")]));
    for (const r of rows) {
      const x = await notice({ operation: "reject", noticing_id: r.id, reason: "not mine" });
      expect(x.ok).toBe(true);
    }
    const evs = await q("select payload from events where kind = 'notice.rejected' order by seq");
    expect(evs.map((e) => e.payload.kind).sort()).toEqual(["feeling", "relation"]);
    for (const e of evs) expect(noticeRejectedPayload.safeParse(e.payload).success).toBe(true);
    expect(await q("select 1 from nodes")).toEqual([]);
    expect(await q("select 1 from relations")).toEqual([]);
  });
});

describe("mind_notice accept: relation", () => {
  const pick = (rows: any[], subject: string) => rows.find((r) => r.payload.subject === subject);

  it("creates a relation when the mind gives a state: relate.set with the aliases, the alias recorded, intensity 0.5 by default; ids only in notice.accepted", async () => {
    const { s, rows } = await proposed(answer([], [relation("Rowan", "Starts a new job on Monday.", { alias: "Ro" })]));
    const id = rows[0].id;
    const r = await notice({ operation: "accept", noticing_id: id, state: "close" });
    expect(r.ok).toBe(true);
    const rel = (await q("select * from relations where subject = 'Rowan'"))[0];
    expect(rel).toMatchObject({ state: "close", intensity: 0.5, note: "Starts a new job on Monday.", aliases: ["Ro"], cleared_at: null });
    const ev = (await q("select * from events where id = $1", [r.receipt.projection.relate_event_id]))[0];
    expect(ev).toMatchObject({ kind: "relate.set", written_by: "alpha", payload: { subject: "Rowan", state: "close", intensity: 0.5, note: "Starts a new job on Monday.", aliases: ["Ro"] } });
    const acc = (await q("select payload from events where kind = 'notice.accepted'"))[0].payload;
    expect(noticeAcceptedPayload.safeParse(acc).success).toBe(true);
    expect(acc).toEqual({ noticing_id: id, kind: "relation", sources: [s.event_id], relate_event_id: ev.id, edited: false });
    expect(JSON.stringify(acc)).not.toMatch(/Rowan|Ro\b|job/);
    expect(r.receipt.projection.drive_event_id).toBeUndefined();
    expect(await q("select 1 from events where kind = 'drive.nudge'")).toEqual([]);
  });

  it("a new relation without a state is invalid_input and nothing is written; intensity may be given", async () => {
    const { rows } = await proposed(answer([], [relation("Rowan")]));
    expectErr(await notice({ operation: "accept", noticing_id: rows[0].id }), "invalid_input", "state");
    expect((await notice({ operation: "accept", noticing_id: rows[0].id })).error.message).toBe("a new relation needs a state");
    expect(await q("select 1 from relations")).toEqual([]);
    expect((await noticings())[0]).toMatchObject({ status: "pending" });
    expect((await notice({ operation: "accept", noticing_id: rows[0].id, state: "fond", intensity: 0.8 })).ok).toBe(true);
    expect((await q("select state, intensity from relations"))[0]).toEqual({ state: "fond", intensity: 0.8 });
  });

  it("an existing relation keeps its state and intensity, gets the note on a new line and the alias; state and intensity apply when given", async () => {
    expect((await run(alpha, "mind_relate", { mind_id: "alpha", operation: "set", subject: "Rowan", state: "devoted", intensity: 0.9, note: "Old friend." })).ok).toBe(true);
    const { rows } = await proposed(answer([], [relation("Rowan", "Starts a new job on Monday.", { alias: "Ro" }), relation("Rowan2", "x")]));
    const id = pick(rows, "Rowan").id;
    const r = await notice({ operation: "accept", noticing_id: id });
    expect(r.ok).toBe(true);
    expect((await q("select state, intensity, note, aliases from relations where subject = 'Rowan'"))[0]).toEqual({
      state: "devoted", intensity: 0.9, note: "Old friend.\nStarts a new job on Monday.", aliases: ["Ro"],
    });
    // a second proposal with the same alias adds nothing twice and keeps the earlier aliases; the mind's edited note and new state apply
    await queued([{ speaker: "other", name: "Rowan", text: "Ro again" }]);
    await go(fake(answer([], [relation("Rowan", "Calls from the road.", { alias: "ro" })])));
    const second = (await noticings()).filter((x) => x.payload.subject === "Rowan" && x.status === "pending")[0]!;
    expect(second.payload.note).toBe("Calls from the road.");
    const r2 = await notice({ operation: "accept", noticing_id: second.id, note: "Phones from the road.", state: "tender", intensity: 0.7 });
    expect(r2.ok).toBe(true);
    expect((await q("select state, intensity, note, aliases from relations where subject = 'Rowan'"))[0]).toEqual({
      state: "tender", intensity: 0.7, note: "Old friend.\nStarts a new job on Monday.\nPhones from the road.", aliases: ["Ro"],
    });
    expect((await q("select payload from events where kind = 'notice.accepted' order by seq desc limit 1"))[0].payload.edited).toBe(true);
  });

  it("warmth nudges connection satisfaction by +0.5 (source metabolised, note = the noticing id); no warmth, no nudge", async () => {
    const { rows } = await proposed(answer([], [relation("Rowan", "Glad.", { warmth: true }), relation("Sam", "Neutral.")]));
    const warm = pick(rows, "Rowan");
    const cold = pick(rows, "Sam");
    const r = await notice({ operation: "accept", noticing_id: warm.id, state: "close" });
    expect(r.ok).toBe(true);
    const nudge = (await q("select payload from events where id = $1", [r.receipt.projection.drive_event_id]))[0].payload;
    expect(nudge).toMatchObject({ drive: "connection", axis: "satisfaction", delta: 0.5, source: "metabolised", note: warm.id, before: 5, after: 5.5 });
    const acc = (await q("select payload from events where kind = 'notice.accepted'"))[0].payload;
    expect(acc.drive_event_id).toBe(r.receipt.projection.drive_event_id);
    expect(noticeAcceptedPayload.safeParse(acc).success).toBe(true);
    const drive = (await q("select satisfaction from drive_state where drive = 'connection' and context = ''"))[0];
    expect(drive.satisfaction).toBeCloseTo(5.5, 3);
    await notice({ operation: "accept", noticing_id: cold.id, state: "acquaintance" });
    expect(await q("select 1 from events where kind = 'drive.nudge'")).toHaveLength(1);
    // the verb path still works the same: mind_drive nudge goes through the same helper
    const n = await run(alpha, "mind_drive", { mind_id: "alpha", operation: "nudge", drive: "play", axis: "intensity", delta: 1 });
    expect(n.ok).toBe(true);
    expect(n.receipt.projection.drive).toMatchObject({ drive: "play", intensity: 6 });
  });

  it("refuses content (a relation takes note) and the other kinds' inputs", async () => {
    const { rows } = await proposed(answer([], [relation("Rowan")]));
    const id = rows[0].id;
    expectErr(await notice({ operation: "accept", noticing_id: id, content: "x", state: "close" }), "invalid_input", "content");
    expectErr(await notice({ operation: "accept", noticing_id: id, state: "close", decision: "keep" }), "invalid_input", "decision");
    expectErr(await notice({ operation: "accept", noticing_id: id, state: "close", weight: 0.2 }), "invalid_input", "weight");
    expectErr(await notice({ operation: "accept", noticing_id: id, state: "close", edge_type: "related_to" }), "invalid_input", "edge_type");
    expectErr(await run(betaWrite, "mind_notice", { mind_id: "alpha", operation: "accept", noticing_id: id, state: "close" }), "forbidden");
    expect(await q("select 1 from relations")).toEqual([]);
  });

  it("mind_relate set still works as before (aliases are kept when a plain set overwrites state and note) and relate.set has no aliases key unless given", async () => {
    const { rows } = await proposed(answer([], [relation("Rowan", "Hello.", { alias: "Ro" })]));
    await notice({ operation: "accept", noticing_id: rows[0].id, state: "close" });
    const s = await run(alpha, "mind_relate", { mind_id: "alpha", operation: "set", subject: "Rowan", state: "steady", intensity: 0.4, note: "Rewritten." });
    expect(s.ok).toBe(true);
    expect((await q("select state, note, aliases from relations"))[0]).toEqual({ state: "steady", note: "Rewritten.", aliases: ["Ro"] });
    expect((await q("select payload from events where id = $1", [s.receipt.event_id]))[0].payload).toEqual({ subject: "Rowan", state: "steady", intensity: 0.4, note: "Rewritten." });
  });
});

describe("mind_health", () => {
  it("reports metabolise {queued, done, failed, last_run}", async () => {
    const h0 = await run(alpha, "mind_health", { mind_id: "alpha" });
    expect(h0.receipt.projection.metabolise).toEqual({ queued: 0, done: 0, failed: 0, last_run: null });
    await enable();
    await queued();
    await queued([{ speaker: "self", text: "b" }]);
    await queued([{ speaker: "self", text: "c" }]);
    await go(fake(null)); // the three stretches are worked together: all fail
    await queued([{ speaker: "self", text: "d" }]);
    await go(fake(answer()));
    const h = (await run(alpha, "mind_health", { mind_id: "alpha" })).receipt.projection.metabolise;
    expect(h).toMatchObject({ queued: 0, done: 1, failed: 3 });
    expect(h.last_run).toMatchObject({ pass: "notice.metabolise", ok: true });
  });
});

describe("events", () => {
  it("every metabolise.* and notice.* event in the ledger parses through its zod shape", async () => {
    const { s, rows } = await proposed(answer([feeling("joy"), feeling("calm")], [relation("Rowan", "n", { warmth: true }), relation("Sam")]));
    await notice({ operation: "accept", noticing_id: rows.find((r) => r.payload.emotion === "joy").id });
    await notice({ operation: "accept", noticing_id: rows.find((r) => r.payload.subject === "Rowan").id, state: "close" });
    await notice({ operation: "reject", noticing_id: rows.find((r) => r.payload.emotion === "calm").id, reason: "no" });
    const evs = await q("select kind, payload from events where kind like 'metabolise.%' or kind like 'notice.%' order by seq");
    expect(evs.map((e) => e.kind)).toContain("metabolise.stretch");
    const seen = new Set<string>();
    for (const e of evs) {
      seen.add(e.kind);
      const shape =
        e.kind === "metabolise.stretch" ? stretchPayload
        : e.kind === "notice.proposed" ? EXTRACTOR_EVENT_SHAPES["notice.proposed"]
        : e.kind === "notice.accepted" ? noticeAcceptedPayload
        : e.kind === "notice.rejected" ? noticeRejectedPayload
        : null;
      expect(shape, e.kind).not.toBeNull();
      expect(shape!.safeParse(e.payload).success, `${e.kind} ${JSON.stringify(e.payload)}`).toBe(true);
    }
    expect([...seen].sort()).toEqual(["metabolise.stretch", "notice.accepted", "notice.proposed", "notice.rejected"]);
    expect(s.event_id).toBeTruthy();
  });
});

describe("portability", () => {
  let seq = 0;
  const dir = mkdtempSync(join(tmpdir(), "sanctum-metabolise-"));
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
    const name = `metabolise_import_${process.pid}_${seq++}`;
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

  it("export carries the queue and relations.aliases; import brings every queue row in done ('imported'), once; purge removes the queue", async () => {
    const { rows } = await proposed(answer([], [relation("Rowan", "Hello.", { alias: "Ro" })]));
    await notice({ operation: "accept", noticing_id: rows[0].id, state: "close" });
    const waiting = await queued([{ speaker: "self", text: "still waiting" }]);
    expect((await queueRows()).map((r) => r.status)).toEqual(["done", "queued"]);
    const f = join(dir, `x${seq++}.json`);
    const exp = await exportMind(pool, "alpha", f);
    expect(exp.counts).toMatchObject({ metabolise_queue: 2, relations: 1 });
    const doc = JSON.parse(readFileSync(f, "utf8"));
    expect(Object.keys(doc.projections).indexOf("metabolise_queue")).toBe(Object.keys(doc.projections).indexOf("dream_preferences") + 1);
    expect(doc.projections.relations[0].aliases).toEqual(["Ro"]);
    expect(doc.projections.metabolise_queue.map((r: any) => r.status).sort()).toEqual(["done", "queued"]);

    const { a2, p2 } = await secondDb();
    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.metabolise_queue).toMatchObject({ inserted: 2 });
    const imported = (await a2.query("select id, stretch_event_id, status, note, done_at from metabolise_queue order by created_at, id")).rows;
    expect(imported).toHaveLength(2);
    expect(imported.every((r) => r.status === "done" && r.note === "imported" && r.done_at instanceof Date)).toBe(true);
    expect(imported.map((r) => r.stretch_event_id)).toContain(waiting.event_id);
    expect((await a2.query("select aliases from relations where subject = 'Rowan'")).rows[0].aliases).toEqual(["Ro"]);
    // the imported stretch event is the ledger's, still a metabolise.stretch
    expect((await a2.query("select kind from events where id = $1", [waiting.event_id])).rows[0].kind).toBe("metabolise.stretch");
    // again: nothing doubled
    const again = await importMind(p2, f, "alpha");
    expect(again.tables.metabolise_queue).toMatchObject({ inserted: 0, already_present: 2 });
    // a row whose stretch event is not in the file is refused as a foreign reference
    const bad = JSON.parse(readFileSync(f, "utf8"));
    bad.events = bad.events.filter((e: any) => e.id !== waiting.event_id);
    const fb = join(dir, `x${seq++}.json`);
    writeFileSync(fb, JSON.stringify(bad));
    const { p2: p3 } = await secondDb();
    const repBad = await importMind(p3, fb, "alpha");
    expect(repBad.tables.metabolise_queue).toMatchObject({ inserted: 1, skipped_foreign_ref: 1 });
    // purge takes the queue with everything else
    const pr = await purgeMind(a2, "alpha", { confirm: "alpha" });
    expect(pr.counts).toMatchObject({ metabolise_queue: 2 });
    expect((await a2.query("select count(*)::int as n from metabolise_queue")).rows[0].n).toBe(0);
  });
});
