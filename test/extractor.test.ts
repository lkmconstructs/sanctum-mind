// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, queryLegacy, resetDatabase, testAppUrl, testDatabaseUrl } from "./helpers.js";
import { upsertMinds } from "../src/auth.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool, withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { vectorLiteral } from "../src/verbs/common.js";
import { ALL_PASSES, MODEL_PASSES, PASSES, runDaemonOnce, startDaemon, type AnyPass } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import { NONE_RERANKER } from "../src/rerank/none.js";
import { httpReranker } from "../src/rerank/http.js";
import type { Reranker } from "../src/rerank/types.js";
import type { Caller, Embedder } from "../src/verbs/types.js";
import { exportMind } from "../src/export.js";
import { importMind } from "../src/import-mind.js";
import { purgeMind } from "../src/purge.js";
import { extractorReport, formatExtractorReport, setExtractorState } from "../src/extractor-admin.js";
import { EXTRACTOR_PASSES, noticeExpire, noticeExtract, noticeTrain } from "../src/extractor/index.js";
import { EXTRACTOR_EVENT_SHAPES } from "../src/extractor/events.js";
import { checkExtractorEnv, extractorLookbackDays, extractorMaxCandidates, extractorReproposeDays } from "../src/extractor/config.js";
import { FEATURE_NAMES, computeFeatures } from "../src/extractor/features.js";
import { PRIOR_WEIGHTS, PRIOR_BIAS } from "../src/extractor/prior.js";
import { PRIOR_MODEL, loadModel, parseWeights, scoreOf } from "../src/extractor/scorer.js";
import { scheduledAt } from "../src/extractor/schedule.js";
import { summaryOf, termsLabel, verdictFor, snippetOf, type Item } from "../src/extractor/candidates.js";
import { EPOCHS, EXPIRED_WEIGHT, fitLogistic, split, trainModel } from "../src/extractor/train.js";

/** the event kinds src/extractor may append (the static guard in test/extractor_guard.test.ts holds the same list) */
const WHITELISTED_KINDS = ["notice.proposed", "notice.expired", "notice.model.trained"];
const HOUR = 3_600_000;
const DAY = 86_400_000;
const alpha: Caller = { bearer: "alpha", grants: {} };

let admin: Pool;
let pool: Pool;
/** local noon today: the injected clock. The schedule gate compares in the process's local time, so tests pin the hour. */
let clock: Date;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  const d = new Date();
  clock = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  for (const k of ["EXTRACTOR_REPROPOSE_DAYS", "EXTRACTOR_MAX_CANDIDATES", "EXTRACTOR_TTL_DAYS", "EXTRACTOR_LOOKBACK_DAYS"]) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});
afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

// ---------------------------------------------------------------------------------------------------------------
// helpers

const at = (offsetMs: number, from: Date = clock): Date => new Date(from.getTime() + offsetMs);
const run = (name: string, input: unknown, c: Date = clock, embedder: Embedder = FAKE_EMBEDDER) =>
  runVerb({ pool, registry, now: () => c, embedder }, alpha, name, input) as Promise<any>;
const q = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, "alpha", "alpha", "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const A = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as any[];

interface Opts {
  context?: string;
  charge?: string[];
  salience?: string;
  /** created this long before the clock */
  ageH?: number;
  session?: string;
  kind?: string;
  by?: string;
}

async function vecOf(text: string): Promise<string> {
  return vectorLiteral((await FAKE_EMBEDDER.embed([text]))[0])!;
}

async function mkEv(text: string, o: Opts & { novec?: boolean } = {}, mind = "alpha"): Promise<string> {
  const created = at(-(o.ageH ?? 24) * HOUR);
  const texture = o.charge || o.salience ? { ...(o.charge ? { charge: o.charge } : {}), ...(o.salience ? { salience: o.salience } : {}) } : null;
  const r = await queryAs(
    pool, mind, o.by ?? mind,
    `insert into events (mind_id, kind, payload, texture, context, session_id, written_by, recorded_at, created_at, embedding, embedding_model)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $8, $9::vector, $10) returning id`,
    [mind, o.kind ?? "observe", JSON.stringify({ content: text }), texture ? JSON.stringify(texture) : null, o.context ?? null, o.session ?? null, o.by ?? mind, created, o.novec ? null : await vecOf(text), o.novec ? null : "fake"],
  );
  return r.rows[0].id;
}

async function mkNode(text: string, o: Opts & { type?: string } = {}, mind = "alpha"): Promise<string> {
  const created = at(-(o.ageH ?? 24) * HOUR);
  const meta: Record<string, unknown> = { context: o.context ?? null };
  if (o.charge || o.salience) meta.texture = { ...(o.charge ? { charge: o.charge } : {}), ...(o.salience ? { salience: o.salience } : {}) };
  const r = await queryAs(
    pool, mind, mind,
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, metadata, created_at, embedding, embedding_model)
     values ($1, $2, $3, $4, $1, 'extracted', 1.0, $5::jsonb, $6, $7::vector, 'fake') returning id`,
    [mind, o.type ?? "observation", text.slice(0, 50), text, JSON.stringify(meta), created, await vecOf(text)],
  );
  return r.rows[0].id;
}

async function mkEdge(a: string, b: string): Promise<void> {
  await queryAs(pool, "alpha", "alpha", `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'related_to', 'alpha', $1, $2)`, [a, b]);
}

/** The scenario most tests share: one clear link pair, one 3-event cluster sharing a context and a charge tag, one high-salience pair. */
const HERON_A = "the heron stands in the shallow river at dawn";
const HERON_B = "a heron stands still in the river at dawn";
const BILL = "invoice for the printer cartridge";
const GARDEN = ["planted the tomato seedlings along the south fence", "watered the seedlings again and the soil felt cold", "frost warning tonight so I covered everything with sheets"];
const TRUTH = ["I told her the truth about the money and it was a relief", "telling her the truth about the money was a relief"];

async function seedScenario(): Promise<{ a: string; b: string; c: string; garden: string[]; truth: string[] }> {
  const a = await mkNode(HERON_A, { ageH: 30 });
  const b = await mkNode(HERON_B, { ageH: 29 });
  const c = await mkNode(BILL, { ageH: 28 });
  const garden: string[] = [];
  for (const [i, t] of GARDEN.entries()) garden.push(await mkEv(t, { context: "garden", charge: ["tender"], ageH: 50 - i, session: `s${i}` }));
  const truth: string[] = [];
  for (const [i, t] of TRUTH.entries()) truth.push(await mkEv(t, { salience: i === 0 ? "foundational" : "active", ageH: 20 - i }));
  return { a, b, c, garden, truth };
}

function fakeReranker(score: (query: string, doc: string) => number, name = "fake"): Reranker & { calls: Array<{ query: string; documents: string[] }> } {
  const calls: Array<{ query: string; documents: string[] }> = [];
  return {
    name,
    calls,
    async rerank(query, documents) {
      calls.push({ query, documents });
      return documents.map((d) => score(query, d));
    },
  };
}
const byWords: Reranker & { calls: unknown[] } = fakeReranker((qy, d) => (/heron/.test(qy + d) ? 0.9 : /seedlings|frost/.test(qy + d) ? 0.6 : /truth/.test(qy + d) ? 0.8 : 0.3));

const enable = (stage: "shadow" | "propose" = "shadow", schedule = "03:00") => setExtractorState(admin, "alpha", "enable", { stage, schedule });

/** One daemon run with the given passes, as the app role; returns alpha's pass reports. */
async function go(passes: readonly AnyPass[], c: Date = clock, o: { embedder?: Embedder; reranker?: Reranker } = {}) {
  const reports = await runDaemonOnce(
    { pool, embedder: o.embedder ?? FAKE_EMBEDDER, ...(o.reranker ? { reranker: o.reranker } : {}), now: () => c },
    { trigger: "manual", minds: ["alpha"], passes },
  );
  expect(reports).toHaveLength(1);
  return reports[0]!;
}
const extract = async (c: Date = clock, o: { embedder?: Embedder; reranker?: Reranker } = {}) => (await go([noticeExtract], c, { reranker: byWords, ...o })).passes[0]!;
const train = async (c: Date = clock) => (await go([noticeTrain], c)).passes[0]!;

const noticings = (where = "true") => A(`select * from noticings where ${where} order by created_at, score desc, id`);
const runsOf = (pass: string) => A(`select * from extractor_runs where pass = $1 order by started_at`, [pass]);

// ---------------------------------------------------------------------------------------------------------------

describe("the passes are registered, separately", () => {
  it("notice.expire and notice.repair are among the twelve deterministic passes; extract and train are the model-backed ones, run after them", () => {
    expect(PASSES).toHaveLength(12);
    expect(PASSES.map((p) => p.name)).toContain("notice.expire");
    expect(MODEL_PASSES.map((p) => p.name)).toEqual(["notice.extract", "notice.train"]);
    expect(ALL_PASSES).toHaveLength(14);
    expect(EXTRACTOR_PASSES.map((p) => p.name)).toEqual(["notice.expire", "notice.repair", "notice.extract", "notice.train"]);
    expect(PASSES.some((p) => MODEL_PASSES.includes(p))).toBe(false);
  });
});

describe("notice.extract: when it runs", () => {
  it("skips with a note and writes nothing when there is no extractor_state row, it is disabled, or it is paused", async () => {
    await seedScenario();
    let p = await extract();
    expect(p).toMatchObject({ ok: true, changed: 0 });
    expect(p.notes!.join(" ")).toMatch(/skipped: the extractor is not enabled/);
    await enable();
    await setExtractorState(admin, "alpha", "disable");
    p = await extract();
    expect(p.notes!.join(" ")).toMatch(/not enabled/);
    await enable();
    await setExtractorState(admin, "alpha", "pause");
    p = await extract();
    expect(p.notes!.join(" ")).toMatch(/paused/);
    expect(await noticings()).toHaveLength(0);
    expect(await runsOf("notice.extract")).toHaveLength(0);
    expect(await A("select 1 from events where kind = 'notice.proposed'")).toHaveLength(0);
  });

  it("with EMBEDDER=none it skips with a note, inserts nothing, and records one skipped row (not one per tick)", async () => {
    await seedScenario();
    await enable();
    const p = await extract(clock, { embedder: NONE_EMBEDDER });
    expect(p).toMatchObject({ ok: true, changed: 0 });
    expect(p.notes!.join(" ")).toMatch(/EMBEDDER=none/);
    await extract(at(HOUR), { embedder: NONE_EMBEDDER });
    expect(await noticings()).toHaveLength(0);
    expect(await A("select 1 from events where kind = 'notice.proposed'")).toHaveLength(0);
    const rows = await runsOf("notice.extract");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, notes: { skipped: true } });
    expect(rows[0].notes.reason).toMatch(/EMBEDDER=none/);
    // fixing the embedder the same day lets the day's run happen: a skip does not use the day up
    const again = await extract(at(2 * HOUR));
    expect(again.changed).toBe(3);
    expect(await runsOf("notice.extract")).toHaveLength(2);
  });

  it("runs once a day at the schedule, in the service's local time: not before it, once after it, again the next day", async () => {
    await seedScenario();
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await enable("shadow", hhmm(at(HOUR))); // 13:00, the clock is 12:00
    let p = await extract();
    expect(p.changed).toBe(0);
    expect(p.notes!.join(" ")).toMatch(/not due until 13:00/);
    expect(await runsOf("notice.extract")).toHaveLength(0);

    await setExtractorState(admin, "alpha", "enable", { schedule: "11:00" });
    p = await extract();
    expect(p.changed).toBe(3);
    const first = (await runsOf("notice.extract"))[0];
    expect(first.started_at.getTime()).toBe(clock.getTime());

    p = await extract(at(2 * HOUR)); // later the same day
    expect(p).toMatchObject({ ok: true, changed: 0 });
    expect(p.notes!.join(" ")).toMatch(/already ran today/);
    expect(await runsOf("notice.extract")).toHaveLength(1);

    p = await extract(at(DAY)); // tomorrow noon: a new day, due again (nothing new in the window, so nothing proposed)
    expect(p.ok).toBe(true);
    expect(p.notes!.join(" ")).not.toMatch(/already ran/);
    expect(await runsOf("notice.extract")).toHaveLength(2);
    expect(scheduledAt(clock, "11:00").getHours()).toBe(11);
  });

  it("a suspended mind is skipped by the daemon; a mind with nothing enabled is untouched", async () => {
    await seedScenario();
    await enable();
    await A("update minds set disabled_at = now() where mind_id = 'alpha'");
    const reports = await runDaemonOnce({ pool, embedder: FAKE_EMBEDDER, now: () => clock }, { trigger: "manual", minds: ["alpha"], passes: MODEL_PASSES });
    expect(reports).toEqual([]);
    expect(await noticings()).toHaveLength(0);
    expect(await runsOf("notice.extract")).toHaveLength(0);
    // beta never enabled it: its run is a skip with no rows
    const b = await runDaemonOnce({ pool, embedder: FAKE_EMBEDDER, now: () => clock }, { trigger: "manual", minds: ["beta"], passes: MODEL_PASSES });
    expect(b[0]!.passes.map((x) => [x.pass, x.ok, x.changed])).toEqual([["notice.extract", true, 0], ["notice.train", true, 0]]);
    expect(await A("select 1 from extractor_runs")).toHaveLength(0);
  });
});

describe("notice.extract: shadow stage", () => {
  it("records the clear link, the context-and-charge pattern and the high-salience distillation as shadow noticings, with ids-only events, and shows the mind nothing", async () => {
    const s = await seedScenario();
    await enable("shadow");
    const nodesBefore = await A("select to_jsonb(n)::text j from nodes n order by id");
    const edgesBefore = await A("select count(*)::int n from edges");
    const eventsBefore = (await A("select count(*)::int n from events"))[0].n;

    const p = await extract();
    expect(p).toMatchObject({ ok: true, changed: 3 });
    expect(p.notes!.join(" ")).toMatch(/3 proposed at stage shadow \(link 1, pattern 1, distillation 1\)/);

    const rows = await noticings();
    expect(rows.map((r) => r.kind).sort()).toEqual(["distillation", "link", "pattern"]);
    for (const r of rows) {
      expect(r).toMatchObject({ stage: "shadow", status: "pending", model_version: 0 });
      expect(Object.keys(r.features).sort()).toEqual([...FEATURE_NAMES].sort());
      expect(r.expires_at.getTime()).toBe(clock.getTime() + 14 * DAY);
      expect(r.created_at.getTime()).toBe(clock.getTime());
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThan(1);
    }
    const link = rows.find((r) => r.kind === "link");
    const pattern = rows.find((r) => r.kind === "pattern");
    const distill = rows.find((r) => r.kind === "distillation");
    expect([...link.sources].sort()).toEqual([s.a, s.b].sort());
    expect(link.payload.edge_type).toBe("related_to");
    expect(link.payload.reason).toMatch(/^cosine 0\.\d\d; no shared context$/);
    expect(link.payload.reason).not.toMatch(/heron/);
    expect(link.features).toMatchObject({ kind_link: 1, kind_pattern: 0, rerank: 0.9, rerank_missing: 0 });
    expect([...pattern.sources].sort()).toEqual([...s.garden].sort());
    expect(Object.keys(pattern.payload).sort()).toEqual(["label", "summary", "window"]);
    expect(pattern.payload.label.length).toBeLessThanOrEqual(80);
    expect(pattern.payload.label).toMatch(/seedlings|tomato|soil|frost/);
    expect(pattern.payload.summary).toBe(GARDEN.join(" / "));
    // the window is the span of the sources: the period the pattern recurred across
    expect(pattern.payload.window).toEqual({ start: at(-50 * HOUR).toISOString(), end: at(-48 * HOUR).toISOString() });
    expect(pattern.features).toMatchObject({ shared_context: 1, charge_overlap: 1, kind_pattern: 1, source_count: 0.3 });
    expect(pattern.features.cooccurrence).toBe(0); // sessions only (a shared context is shared_context, not counted twice); theirs differ
    expect([...distill.sources].sort()).toEqual([...s.truth].sort());
    expect(distill.payload.content).toBe(TRUTH.join(" / "));
    expect([...distill.payload.lineage.noticing_source_event_ids].sort()).toEqual([...s.truth].sort());
    expect(distill.features.salience_mean).toBeCloseTo((1 + 0.7) / 2);

    // events carry ids and numbers only, parse against the zod shape, and point at their noticing
    const evs = await A("select * from events where kind = 'notice.proposed' order by seq");
    expect(evs).toHaveLength(3);
    for (const e of evs) {
      expect(EXTRACTOR_EVENT_SHAPES["notice.proposed"].safeParse(e.payload).success).toBe(true);
      expect(Object.keys(e.payload).sort()).toEqual(["model_version", "noticing_id", "noticing_kind", "score", "source_count", "stage"]);
      expect(e).toMatchObject({ written_by: "alpha", mind_id: "alpha", subject_id: e.payload.noticing_id });
      const n = rows.find((r) => r.id === e.payload.noticing_id)!;
      expect(n.proposed_event_id).toBe(e.id);
      expect(e.payload.source_count).toBe(n.sources.length);
      expect(JSON.stringify(e.payload)).not.toMatch(/heron|tomato|truth|seedlings/);
    }

    // memory is untouched: no node, edge or ledger event beyond the three proposals
    expect(await A("select to_jsonb(n)::text j from nodes n order by id")).toEqual(nodesBefore);
    expect((await A("select count(*)::int n from edges"))[0].n).toBe(edgesBefore[0].n);
    expect((await A("select count(*)::int n from events"))[0].n).toBe(eventsBefore + 3);

    // the mind sees nothing at shadow: list is empty, orient has no noticings
    expect((await run("mind_notice", { mind_id: "alpha", operation: "list" })).receipt.projection).toEqual({ noticings: [], stage: "shadow" });
    expect((await run("mind_orient", { mind_id: "alpha", depth: "full" })).receipt.projection.sections.noticings).toEqual([]);
    expect((await run("mind_health", { mind_id: "alpha" })).receipt.projection.extractor).toMatchObject({ pending: 0, stage: "shadow", last_run: { pass: "notice.extract", ok: true, skipped: false } });

    // the run is on record: counts, no memory text
    const [r] = await runsOf("notice.extract");
    expect(r).toMatchObject({ ok: true });
    expect(r.notes).toMatchObject({ stage: "shadow", reranker: "fake", rerank_missing: 0, model_version: 0, proposed_total: 3, candidates: 3, proposed: { link: 1, pattern: 1, distillation: 1 } });
    expect(JSON.stringify(r.notes)).not.toMatch(/heron|tomato|truth/);
  });

  it("does not propose a node and an event together, a pair that already shares an edge (either direction), or a stranger's words", async () => {
    const a = await mkNode(HERON_A);
    const b = await mkNode(HERON_B);
    await mkEv(HERON_B); // an event with the same words as the node: links join nodes only
    await mkEdge(b, a); // already linked, reversed
    const x = await mkNode("a lantern swinging above the dark harbour");
    const y = await mkNode("lantern swinging above the harbour in the dark");
    await enable();
    await extract();
    const links = await noticings("kind = 'link'");
    expect(links).toHaveLength(1);
    expect([...links[0].sources].sort()).toEqual([x, y].sort());
  });

  it("a protected self node, an invalidated node and events of the bookkeeping kinds are never candidates", async () => {
    const live = await mkNode(HERON_A);
    await mkNode(HERON_B, { type: "identity" });
    const dead = await mkNode("a heron stands in the river at dawn again");
    await queryLegacy(admin, "update nodes set invalidated_at = now() where id = $1", [dead]);
    for (const k of ["notice.accepted", "daemon.something", "pattern", "distill", "letter.send"]) await mkEv(HERON_A, { kind: k, context: "x", charge: ["c"] });
    for (let i = 0; i < 3; i++) await mkEv(HERON_A, { kind: "pattern" });
    await enable();
    const p = await extract();
    expect(p.changed).toBe(0);
    expect(live).toBeTruthy();
    expect(await noticings()).toHaveLength(0);
  });

  it("a distillation can come from a sit the mind resolved as metabolized, with the window's events that read like it", async () => {
    const o = (content: string) => run("mind_observe", { mind_id: "alpha", content, texture: { charge: ["warm"] } });
    const e1 = (await o("the ferry crossing was slow and the water was grey")).receipt.projection.event_id;
    await o("the grey water under the slow ferry crossing");
    await o("an invoice for the printer cartridge");
    const sit = await run("mind_resolve", { mind_id: "alpha", subject_id: e1, outcome: "metabolized", resolution_note: "done with it" });
    expect(sit.ok).toBe(true);
    await enable();
    await extract();
    const d = await noticings("kind = 'distillation'");
    expect(d).toHaveLength(1);
    expect(d[0].sources).toContain(e1);
    expect(d[0].sources).toHaveLength(2);
    expect(d[0].payload.lineage.noticing_source_event_ids.sort()).toEqual([...d[0].sources].sort());
    expect(d[0].payload.content).toMatch(/ferry/);
  });
});

describe("notice.extract: propose stage, dedupe and ranking", () => {
  it("does not propose an identical source set again; new candidates appear at stage propose, ranked by score, and shown to the mind", async () => {
    await seedScenario();
    await enable("shadow");
    expect((await extract()).changed).toBe(3);

    await setExtractorState(admin, "alpha", "stage", { stage: "propose" });
    // the previous run reached back three days: the same rows are in the window again, and must not be proposed again
    await A("update extractor_runs set started_at = started_at - interval '3 days'");
    const x = await mkNode("a lantern swinging above the dark harbour", { ageH: 2 });
    const y = await mkNode("lantern swinging above the harbour in the dark", { ageH: 2 });
    const l = await mkNode("zebra crossing marker paint fresh", { ageH: 2 });
    const m = await mkNode("fresh paint on the zebra crossing marker", { ageH: 2 });
    const p = await extract(at(DAY));
    expect(p.changed).toBe(2); // the two new pairs; the three shadow-stage source sets are not re-proposed
    const rows = await noticings("stage = 'propose'");
    expect(rows.map((r) => r.kind)).toEqual(["link", "link"]);
    expect(rows.map((r) => [...r.sources].sort().join()).sort()).toEqual([[x, y].sort().join(), [l, m].sort().join()].sort());
    expect(await noticings("stage = 'shadow'")).toHaveLength(3);
    expect((await runsOf("notice.extract"))[1].notes).toMatchObject({ stage: "propose", proposed_total: 2, generated: { link: 3, pattern: 1, distillation: 1 } });

    const listed = (await run("mind_notice", { mind_id: "alpha", operation: "list" }, at(DAY))).receipt.projection;
    expect(listed.stage).toBe("propose");
    expect(listed.noticings).toHaveLength(2);
    expect(listed.noticings.map((n: any) => n.score)).toEqual([...listed.noticings.map((n: any) => n.score)].sort((u: number, v: number) => v - u));
    expect(listed.noticings.every((n: any) => n.kind === "link")).toBe(true);
    expect((await run("mind_orient", { mind_id: "alpha", depth: "quick" }, at(DAY))).receipt.projection.sections.noticings).toHaveLength(2);
    expect((await run("mind_health", { mind_id: "alpha" }, at(DAY))).receipt.projection.extractor.pending).toBe(2);
  });

  it("the prior ranks a pair with a high rerank score above one with a low rerank score, and the list is ordered by it", async () => {
    const hi = [await mkNode(HERON_A, { ageH: 30 }), await mkNode(HERON_B, { ageH: 29 })];
    const lo = [await mkNode("the otter slides down the muddy bank at dusk", { ageH: 30 }), await mkNode("an otter slides along the muddy bank at dusk", { ageH: 29 })];
    await enable("propose");
    const rr = fakeReranker((qy, d) => (/heron/.test(qy + d) ? 0.95 : 0.05));
    await extract(clock, { reranker: rr });
    const rows = await noticings();
    const hiRow = rows.find((r) => r.sources.includes(hi[0]))!;
    const loRow = rows.find((r) => r.sources.includes(lo[0]))!;
    expect(hiRow.features.rerank).toBeCloseTo(0.95);
    expect(loRow.features.rerank).toBeCloseTo(0.05);
    expect(hiRow.score).toBeGreaterThan(loRow.score);
    // the two pairs have near-equal cosine, so the order is the reranker's doing
    expect(Math.abs(hiRow.features.cosine - loRow.features.cosine)).toBeLessThan(0.1);
    const listed = (await run("mind_notice", { mind_id: "alpha", operation: "list" })).receipt.projection.noticings;
    expect(listed.map((n: any) => n.id)).toEqual([hiRow.id, loRow.id]);
    // the reranker was asked the first source's opening against the other sources
    expect(rr.calls.map((c) => c.documents.length)).toEqual([1, 1]);
    expect(rr.calls.some((c) => c.query === HERON_A && c.documents[0] === HERON_B)).toBe(true);
  });

  it("with RERANKER none it says so in its notes and scores on cosine and the other features (rerank_missing 1)", async () => {
    await seedScenario();
    await enable();
    const p = await extract(clock, { reranker: NONE_RERANKER });
    expect(p.changed).toBe(3);
    expect(p.notes!.join(" ")).toMatch(/reranker none: candidates scored on cosine and the other features only/);
    for (const r of await noticings()) expect(r.features).toMatchObject({ rerank: 0, rerank_missing: 1 });
    expect((await runsOf("notice.extract"))[0].notes).toMatchObject({ reranker: "none", rerank_missing: 3 });
  });

  it("an accepted proposal from the extractor becomes the mind's own memory through the ordinary verb (the payload shapes fit)", async () => {
    const s = await seedScenario();
    await enable("propose");
    await extract();
    const listed = (await run("mind_notice", { mind_id: "alpha", operation: "list" })).receipt.projection.noticings;
    expect(listed).toHaveLength(3);
    for (const n of listed) {
      const r = await run("mind_notice", { mind_id: "alpha", operation: "accept", noticing_id: n.id });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    expect((await A("select count(*)::int n from edges where metadata ? 'noticing_id'"))[0].n).toBeGreaterThanOrEqual(1);
    const types = (await A("select node_type, written_by from nodes where node_type in ('pattern', 'distillation') order by node_type")).map((r) => [r.node_type, r.written_by]);
    expect(types).toEqual([["distillation", "alpha"], ["pattern", "alpha"]]);
    expect(s.garden).toHaveLength(3);
  });

  it("EXTRACTOR_MAX_CANDIDATES caps candidates per kind before reranking, best first", async () => {
    process.env.EXTRACTOR_MAX_CANDIDATES = "2";
    for (let i = 0; i < 4; i++) {
      await mkNode(`wq${i}a wq${i}b wq${i}c wq${i}d one`);
      await mkNode(`wq${i}a wq${i}b wq${i}c wq${i}d two`);
    }
    await enable();
    const rr = fakeReranker(() => 0.5);
    const p = await extract(clock, { reranker: rr });
    expect(p.changed).toBe(2);
    expect(rr.calls).toHaveLength(2);
    expect((await runsOf("notice.extract"))[0].notes).toMatchObject({ generated: { link: 4 }, candidates: 2 });
  });
});

describe("notice.extract: a reranker that fails degrades, it does not fail the tick", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("an HTTP reranker that answers 500: noticings are still proposed with a null rerank (rerank_missing 1), after three failures it stops asking, and the note says so", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let hits = 0;
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rerank`;
    for (let i = 0; i < 5; i++) {
      await mkNode(`wq${i}a wq${i}b wq${i}c wq${i}d one`);
      await mkNode(`wq${i}a wq${i}b wq${i}c wq${i}d two`);
    }
    await enable();
    const p = await extract(clock, { reranker: httpReranker(url) });
    expect(p).toMatchObject({ ok: true, changed: 5 });
    expect(hits).toBe(3);
    expect(p.notes!.join(" ")).toMatch(/returned no scores: candidates scored without it \(rerank_missing\)/);
    for (const r of await noticings()) expect(r.features).toMatchObject({ rerank: 0, rerank_missing: 1 });
    expect(warn).toHaveBeenCalled();
    expect((await runsOf("notice.extract"))[0]).toMatchObject({ ok: true, notes: { rerank_missing: 5 } });
  });

  it("a reranker that answers for some and not others is noted with the counts", async () => {
    await seedScenario();
    await enable();
    const flaky: Reranker = {
      name: "flaky",
      async rerank(qy, docs) {
        return docs.map(() => (/heron/.test(qy) ? 0.9 : null));
      },
    };
    const p = await extract(clock, { reranker: flaky });
    expect(p.notes!.join(" ")).toMatch(/reranker flaky scored 1 of 3 candidates/);
    const link = (await noticings("kind = 'link'"))[0];
    expect(link.features).toMatchObject({ rerank: 0.9, rerank_missing: 0 });
  });

  it("any other failure is recorded as ok:false in extractor_runs with a short reason, returns a note, and the day is used up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedScenario();
    await enable();
    const boom: Reranker = {
      name: "boom",
      async rerank() {
        throw new Error("reranker exploded");
      },
    };
    const p = await extract(clock, { reranker: boom });
    expect(p).toMatchObject({ ok: true, changed: 0 }); // the tick is not failed
    expect(p.notes!.join(" ")).toMatch(/failed: reranker exploded; tomorrow's run tries again/);
    expect(await noticings()).toHaveLength(0);
    const rows = await runsOf("notice.extract");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, notes: { error: "reranker exploded" } });
    expect((await extract(at(HOUR))).notes!.join(" ")).toMatch(/already ran today/);
    expect((await extract(at(DAY))).changed).toBe(3); // tomorrow it tries again
  });
});

describe("notice.extract: expired proposals come back only after EXTRACTOR_REPROPOSE_DAYS and only with a higher score", () => {
  it("defaults to 60 days, validates its value, and is honoured on a timeline with an injected clock", async () => {
    delete process.env.EXTRACTOR_REPROPOSE_DAYS;
    expect(extractorReproposeDays()).toBe(60);
    process.env.EXTRACTOR_REPROPOSE_DAYS = "10";
    expect(extractorReproposeDays()).toBe(10);

    const a = await mkNode(HERON_A);
    const b = await mkNode(HERON_B);
    await enable("propose");
    const level = { v: 0.5 };
    const rr = fakeReranker(() => level.v);
    const touch = (c: Date) => queryLegacy(admin, "update nodes set created_at = $2 where id = any($1::uuid[])", [[a, b], at(-HOUR, c)]);
    const day = (n: number) => at(n * DAY);

    expect((await extract(clock, { reranker: rr })).changed).toBe(1);
    const first = (await noticings())[0];
    expect(first).toMatchObject({ status: "pending", stage: "propose" });

    // the mind lets it lapse (ttl 14 days)
    const expired = await go([noticeExpire], day(16));
    expect(expired.passes[0]!.changed).toBe(1);
    expect((await noticings())[0].status).toBe("expired");

    // 5 days after it expired: too soon, though the score would rise
    await touch(day(19));
    level.v = 0.95;
    expect((await extract(day(19), { reranker: rr })).changed).toBe(0);
    expect(await noticings()).toHaveLength(1);

    // 11 days after: allowed by the clock, but the score did not rise (lower rerank): not proposed, and the note says why
    await touch(day(26));
    level.v = 0.1;
    const lower = await extract(day(26), { reranker: rr });
    expect(lower.changed).toBe(0);
    expect(lower.notes!.join(" ")).toMatch(/1 expired source set\(s\) were not proposed again: their score had not risen/);
    expect(await noticings()).toHaveLength(1);

    // and when the score has risen: proposed again, as a NEW row; the expired one stays as the record
    await touch(day(27));
    level.v = 0.95;
    expect((await extract(day(27), { reranker: rr })).changed).toBe(1);
    const all = await noticings();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.status)).toEqual(["expired", "pending"]);
    expect(all[1].score).toBeGreaterThan(all[0].score);
    expect(all[1].id).not.toBe(first.id);
  });

  it("an accepted or rejected source set is never proposed again, and a pending shadow one holds it back while an expired shadow one does not", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const mk = (status: string, stage: string, score = 0.5, daysAgo = 100) => ({ kind: "link", sources: ["a", "b"], status, stage, score, expires_at: new Date(now.getTime() - daysAgo * DAY) });
    expect(verdictFor(undefined, now, 60)).toEqual({ action: "new" });
    expect(verdictFor([mk("accepted", "propose")], now, 60)).toEqual({ action: "blocked" });
    expect(verdictFor([mk("rejected", "propose", 0.5, 1000)], now, 60)).toEqual({ action: "blocked" });
    expect(verdictFor([mk("pending", "shadow")], now, 60)).toEqual({ action: "blocked" });
    expect(verdictFor([mk("expired", "shadow")], now, 60)).toEqual({ action: "new" });
    expect(verdictFor([mk("expired", "propose", 0.4, 59)], now, 60)).toEqual({ action: "blocked" });
    expect(verdictFor([mk("expired", "propose", 0.4, 60)], now, 60)).toEqual({ action: "repropose", mustExceed: 0.4 });
    // the latest expiry decides
    expect(verdictFor([mk("expired", "propose", 0.4, 200), mk("expired", "propose", 0.7, 61)], now, 60)).toEqual({ action: "repropose", mustExceed: 0.7 });
    expect(verdictFor([mk("expired", "propose", 0.4, 200), mk("expired", "propose", 0.7, 10)], now, 60)).toEqual({ action: "blocked" });
    // a source set that was accepted once blocks forever even if an older copy expired
    expect(verdictFor([mk("expired", "propose", 0.4, 300), mk("accepted", "propose")], now, 60)).toEqual({ action: "blocked" });
  });
});

describe("notice.extract: the stage 1 runtime guard still holds with everything enabled", () => {
  it("every extractor pass, enabled and doing real work, leaves nodes and edges byte-identical and appends only whitelisted event kinds", async () => {
    await seedScenario();
    await enable("propose");
    const snap = async () => ({
      nodes: (await A("select to_jsonb(n)::text j from nodes n order by id")).map((r) => r.j),
      edges: (await A("select to_jsonb(e)::text j from edges e order by id")).map((r) => r.j),
    });
    const before = await snap();
    const maxSeq = (await A("select max(seq)::bigint s from events"))[0].s;
    const report = await go(EXTRACTOR_PASSES, clock, { reranker: byWords });
    expect(report.passes.map((p) => [p.pass, p.ok])).toEqual(EXTRACTOR_PASSES.map((p) => [p.name, true]));
    expect(report.passes.find((p) => p.pass === "notice.extract")!.changed).toBe(3);
    expect(await snap()).toEqual(before);
    const kinds = (await A("select distinct kind from events where seq > $1", [maxSeq])).map((r) => r.kind);
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(WHITELISTED_KINDS).toContain(k);
    // and the run goes through the same path as a normal tick: all fourteen passes, none failing
    const tick = await runDaemonOnce({ pool, embedder: FAKE_EMBEDDER, reranker: byWords, now: () => at(DAY) }, { trigger: "manual", minds: ["alpha"] });
    expect(tick[0]!.passes).toHaveLength(14);
    expect(tick[0]!.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// notice.train

interface DecidedSeed {
  status: "accepted" | "rejected" | "expired";
  features: Record<string, number>;
  stage?: "shadow" | "propose";
  imported?: boolean;
  kind?: "link" | "pattern" | "distillation";
  ageH?: number;
}

/** A decided noticing as the stage 1 tests make one: its proposed event and its own decision event, then the row carrying both. */
async function seedDecided(s: DecidedSeed, i: number): Promise<string> {
  const id = randomUUID();
  const kind = s.kind ?? "link";
  const when = at(-(s.ageH ?? 1000 - i) * HOUR);
  const mk = async (k: string, payload: object) =>
    (await queryAs(pool, "alpha", "alpha",
      `insert into events (mind_id, kind, subject_id, payload, written_by, recorded_at, created_at) values ('alpha', $1, $2, $3::jsonb, 'alpha', $4, $4) returning id`,
      [k, id, JSON.stringify(payload), when])).rows[0].id as string;
  const proposed = await mk("notice.proposed", { noticing_id: id });
  const decided = await mk(`notice.${s.status}`, s.imported ? { noticing_id: id, reason: "imported" } : { noticing_id: id });
  const a = await mkNode(`source of ${id} one`, { ageH: 2000 });
  const b = await mkNode(`source of ${id} two`, { ageH: 2000 });
  await queryAs(pool, "alpha", "alpha",
    `insert into noticings (id, mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, decided_event_id, decided_at, expires_at, created_at)
     values ($1, 'alpha', $2, $3::uuid[], '{}', 0.5, $4::jsonb, 0, $5, $6, $7, $8, $9, $9, $9)`,
    [id, kind, [a, b], JSON.stringify(s.features), s.stage ?? "propose", s.status, proposed, decided, when]);
  return id;
}

/** Features a mind that likes shared-charge, high-rerank proposals would produce: accepted ones have them, the others do not. */
function featuresFor(i: number, good: boolean): Record<string, number> {
  return {
    rerank: good ? 0.75 + (i % 5) * 0.04 : 0.15 + (i % 5) * 0.04,
    rerank_missing: 0,
    cosine: 0.6 + (i % 7) * 0.04,
    recency_days: (i % 10) / 10,
    shared_context: i % 3 === 0 ? 1 : 0,
    charge_overlap: good ? 0.8 + (i % 3) * 0.05 : 0.05 + (i % 3) * 0.05,
    cooccurrence: (i % 4) / 4,
    salience_mean: 0.4,
    source_count: 0.2,
    kind_link: 1,
    kind_pattern: 0,
    kind_distillation: 0,
  };
}

async function seedForty(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const status = i % 2 === 0 ? "accepted" : i % 4 === 1 ? "rejected" : "expired";
    await seedDecided({ status, features: featuresFor(i, status === "accepted") }, i);
  }
}

describe("notice.train", () => {
  it("refuses under the threshold, says why, records the run, and leaves the prior in use", async () => {
    await enable();
    for (let i = 0; i < 12; i++) await seedDecided({ status: i % 2 === 0 ? "accepted" : "rejected", features: featuresFor(i, i % 2 === 0) }, i);
    const p = await train();
    expect(p).toMatchObject({ ok: true, changed: 0 });
    expect(p.notes!.join(" ")).toMatch(/not trained: only 12 decided noticing\(s\); 30 are needed/);
    expect(await A("select 1 from extractor_models")).toHaveLength(0);
    expect(await A("select 1 from events where kind = 'notice.model.trained'")).toHaveLength(0);
    expect(await runsOf("notice.train")).toMatchObject([{ ok: true, notes: { trained: false, decided: 12 } }]);
    expect((await train(at(HOUR))).notes!.join(" ")).toMatch(/already ran today/);
    expect((await loadModelAs()).version).toBe(0);
  });

  it("needs five of each class: forty decided noticings that were all accepted, or all let lapse, are not enough", async () => {
    await enable();
    for (let i = 0; i < 36; i++) await seedDecided({ status: "accepted", features: featuresFor(i, true) }, i);
    for (let i = 0; i < 4; i++) await seedDecided({ status: "rejected", features: featuresFor(i, false) }, 100 + i);
    expect((await train()).notes!.join(" ")).toMatch(/only 4 rejected or expired; at least 5 are needed \(40 decided\)/);
    await A("delete from extractor_runs");
    await queryLegacy(admin, "update noticings set status = 'rejected' where status = 'accepted'");
    expect((await train(at(DAY))).notes!.join(" ")).toMatch(/only 0 accepted; at least 5 are needed \(40 decided\)/);
    expect(await A("select 1 from extractor_models")).toHaveLength(0);
  });

  it("counts only what the mind was shown and decided with a real decision: shadow rows, imported expiries and rows with no features are left out", async () => {
    await enable();
    for (let i = 0; i < 40; i++) await seedDecided({ status: i % 2 === 0 ? "accepted" : "rejected", features: featuresFor(i, i % 2 === 0), stage: "shadow" }, i);
    for (let i = 0; i < 40; i++) await seedDecided({ status: "expired", features: featuresFor(i, false), imported: true }, 200 + i);
    for (let i = 0; i < 40; i++) await seedDecided({ status: "rejected", features: {} }, 300 + i);
    expect((await train()).notes!.join(" ")).toMatch(/only 0 decided noticing\(s\)/);
  });

  it("trains above it: a new model row, a notice.model.trained event with the held-out metrics, and the scorer then uses it", async () => {
    await enable();
    await seedForty();
    const p = await train();
    expect(p).toMatchObject({ ok: true, changed: 1 });
    expect(p.notes!.join(" ")).toMatch(/trained model version 1 on 32 noticing\(s\); held-out precision at 5 [01]\.\d\d, log loss \d\.\d+ \(n=8\)/);

    const models = await A("select * from extractor_models order by version");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ mind_id: "alpha", version: 1, trained_on: 32 });
    const w = parseWeights(models[0].weights)!;
    expect(w).not.toBeNull();
    expect(Object.keys(models[0].weights.weights).sort()).toEqual([...FEATURE_NAMES].sort());
    expect(Object.keys(models[0].metrics).sort()).toEqual(["log_loss", "n", "n_train", "precision_at_5", "previous_log_loss", "previous_precision_at_5"]);
    expect(models[0].metrics).toMatchObject({ n: 8, n_train: 32 });
    expect(models[0].metrics.precision_at_5).toBeGreaterThanOrEqual(0);
    expect(models[0].metrics.precision_at_5).toBeLessThanOrEqual(1);
    // the mind's own data is cleanly separable on charge_overlap and rerank, so the fit moved toward them and beat the prior's log loss
    expect(w.weights.charge_overlap).toBeGreaterThan(PRIOR_WEIGHTS.charge_overlap);
    expect(models[0].metrics.log_loss).toBeLessThan(models[0].metrics.previous_log_loss);

    const ev = (await A("select * from events where kind = 'notice.model.trained'"))[0];
    expect(ev).toMatchObject({ written_by: "alpha", mind_id: "alpha" });
    expect(EXTRACTOR_EVENT_SHAPES["notice.model.trained"].safeParse(ev.payload).success).toBe(true);
    expect(ev.payload).toEqual({ version: 1, trained_on: 32, metrics: models[0].metrics });
    expect(models[0].event_id).toBe(ev.id);
    expect(await runsOf("notice.train")).toMatchObject([{ ok: true, notes: { trained: true, version: 1, trained_on: 32, decided: 40 } }]);

    // the scorer picks the latest version: the same features score differently, and the next proposal carries version 1
    const model = await loadModelAs();
    expect(model).toMatchObject({ version: 1, source: "trained" });
    const f = featuresFor(0, true);
    expect(scoreOf(model, f as any)).not.toBeCloseTo(scoreOf(PRIOR_MODEL, f as any), 3);
    await mkNode("lantern swinging above the dark harbour", { ageH: 2 });
    await mkNode("swinging lantern above the harbour in the dark", { ageH: 2 });
    expect((await extract(at(HOUR), { reranker: fakeReranker(() => 0.8) })).changed).toBe(1);
    const fresh = (await noticings("model_version = 1"))[0];
    expect(fresh.score).toBeCloseTo(scoreOf(model, fresh.features), 10);
    expect(fresh.score).not.toBeCloseTo(scoreOf(PRIOR_MODEL, fresh.features), 3);
    expect(EXTRACTOR_EVENT_SHAPES["notice.proposed"].parse((await A("select payload from events where subject_id = $1", [fresh.id]))[0].payload).model_version).toBe(1);

    // a refit on another day is a new version from the same decisions: reproducible, and the old row is kept
    const again = await train(at(DAY));
    expect(again.changed).toBe(1);
    const rows = await A("select version, weights from extractor_models order by version");
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[1].weights).toEqual(rows[0].weights);
  });

  it("only the daemon appends models: the database lets the app role insert but not change or remove one", async () => {
    await enable();
    await seedForty();
    await train();
    await expect(queryAs(pool, "alpha", "alpha", "update extractor_models set trained_on = 0")).rejects.toThrow(/permission denied/);
    await expect(queryAs(pool, "alpha", "alpha", "delete from extractor_models")).rejects.toThrow(/permission denied/);
    await expect(queryAs(pool, "alpha", "alpha", "update extractor_runs set ok = false")).rejects.toThrow(/permission denied/);
    await expect(queryAs(pool, "alpha", "alpha", "delete from extractor_runs")).rejects.toThrow(/permission denied/);
  });

  it("does not run for a disabled or paused extractor", async () => {
    await seedForty();
    expect((await train()).notes!.join(" ")).toMatch(/not enabled/);
    await enable();
    await setExtractorState(admin, "alpha", "pause");
    expect((await train()).notes!.join(" ")).toMatch(/paused/);
    expect(await A("select 1 from extractor_models")).toHaveLength(0);
  });

  describe("the fit itself (pure)", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ status: (i % 2 === 0 ? "accepted" : i % 4 === 1 ? "rejected" : "expired") as "accepted" | "rejected" | "expired", features: featuresFor(i, i % 2 === 0) }));
    it("is deterministic, holds out every 5th row, starts from the prior, and reports numbers", () => {
      const a = trainModel(rows(40), PRIOR_MODEL);
      const b = trainModel(rows(40), PRIOR_MODEL);
      expect(a).toEqual(b);
      expect(a.trained && a.metrics.n).toBe(8);
      expect(split([...Array(10).keys()])).toEqual({ train: [0, 1, 2, 3, 5, 6, 7, 8], test: [4, 9] });
      expect(EPOCHS).toBe(200);
      if (a.trained) for (const v of Object.values(a.metrics)) expect(Number.isFinite(v)).toBe(true);
    });
    it("with no examples it returns the starting point; with all one class it moves the bias the right way", () => {
      const start = { bias: -1, weights: [0.5, 0.5] };
      expect(fitLogistic([], start)).toEqual(start);
      const ones = fitLogistic([{ x: [1, 0], y: 1, w: 1 }, { x: [0, 1], y: 1, w: 1 }], start);
      expect(ones.bias).toBeGreaterThan(start.bias);
    });
    it("an expired row weighs half a rejected one", () => {
      const ex = (w: number) => fitLogistic([{ x: [1], y: 0, w }, { x: [1], y: 1, w: 1 }], { bias: 0, weights: [0] });
      expect(ex(0.5).weights[0]!).toBeGreaterThan(ex(1).weights[0]!);
    });
    it("the weak no is pinned: EXPIRED_WEIGHT is 0.5 and trainModel applies it to expired rows, so a lapse pulls half as hard as a rejection", () => {
      expect(EXPIRED_WEIGHT).toBe(0.5);
      // same features, same labels; the only difference is whether the negatives lapsed or were rejected
      const mk = (neg: "expired" | "rejected") =>
        Array.from({ length: 40 }, (_, i) => ({ status: (i % 2 === 0 ? "accepted" : neg) as "accepted" | "rejected" | "expired", features: featuresFor(i, i % 2 === 0) }));
      const lapsed = trainModel(mk("expired"), PRIOR_MODEL);
      const rejected = trainModel(mk("rejected"), PRIOR_MODEL);
      expect(lapsed.trained && rejected.trained).toBe(true);
      if (lapsed.trained && rejected.trained) {
        // with the negatives weighing less, the fit sits closer to "yes": a higher bias than the rejected fit
        expect(lapsed.model.bias).toBeGreaterThan(rejected.model.bias);
      }
    });
  });
});

async function loadModelAs() {
  return withMind(pool, "alpha", "alpha", "read", (tx) => loadModel(tx, "alpha"));
}

// ---------------------------------------------------------------------------------------------------------------

describe("features and scorer", () => {
  const src = (o: Partial<{ created_at: Date; context: string | null; keys: string[]; charge: string[]; salience: number | null }> = {}) => ({
    created_at: clock, context: null, keys: [], charge: [], salience: null, ...o,
  });
  it("names exactly the thirteen features (the twelfth was joined by attended), all in 0..1", () => {
    expect([...FEATURE_NAMES]).toEqual(["rerank", "rerank_missing", "cosine", "recency_days", "shared_context", "charge_overlap", "cooccurrence", "salience_mean", "source_count", "kind_link", "kind_pattern", "kind_distillation", "attended"]);
    const f = computeFeatures({ kind: "pattern", rerank: 0.4, cosine: 0.7, now: clock, sources: [src({ created_at: at(-10 * DAY) }), src({ created_at: at(-50 * DAY) }), src()] });
    expect(Object.keys(f)).toEqual([...FEATURE_NAMES]);
    for (const v of Object.values(f)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(f.recency_days).toBeCloseTo(20 / 30); // the mean age (10, 50 and 0 days) is 20 days
  });
  it("rerank null gives rerank 0 and rerank_missing 1", () => {
    expect(computeFeatures({ kind: "link", rerank: null, cosine: 0.7, now: clock, sources: [src(), src()] })).toMatchObject({ rerank: 0, rerank_missing: 1 });
    expect(computeFeatures({ kind: "link", rerank: 0.3, cosine: 0.7, now: clock, sources: [src(), src()] })).toMatchObject({ rerank: 0.3, rerank_missing: 0 });
  });
  it("recency is the mean age capped at 30 days over 30; shared context, charge overlap, co-occurrence, salience and source count follow the definitions", () => {
    const f = computeFeatures({
      kind: "pattern", rerank: null, cosine: 2, now: clock,
      sources: [
        src({ created_at: at(-15 * DAY), context: "c", keys: ["session:1", "context:c"], charge: ["a", "b"], salience: 1 }),
        src({ created_at: at(-45 * DAY), context: "c", keys: ["session:1", "context:c", "session:2"], charge: ["a"], salience: 0.1 }),
      ],
    });
    expect(f.recency_days).toBe(1); // mean 30 days -> 1
    expect(f.cosine).toBe(1); // clamped
    expect(f.shared_context).toBe(1);
    expect(f.charge_overlap).toBeCloseTo(1 / 2); // {a} / {a, b}
    expect(f.cooccurrence).toBeCloseTo(2 / 5); // session:1 and context:c
    expect(f.salience_mean).toBeCloseTo(0.55);
    expect(f.source_count).toBeCloseTo(0.2);
    expect(computeFeatures({ kind: "link", rerank: 0, cosine: 0, now: clock, sources: [src({ context: "c" }), src({ context: "d" })] }).shared_context).toBe(0);
    expect(computeFeatures({ kind: "link", rerank: 0, cosine: 0, now: clock, sources: [src(), src()] }).shared_context).toBe(0); // no context is not a shared one
    expect(computeFeatures({ kind: "link", rerank: 0, cosine: 0, now: clock, sources: Array.from({ length: 14 }, () => src()) }).source_count).toBe(1);
    expect(computeFeatures({ kind: "link", rerank: 0, cosine: 0, now: clock, sources: [src(), src()] }).salience_mean).toBeCloseTo(0.4);
  });
  it("the prior is a logistic regression: rerank strongest, then cosine, recency mildly positive (a negative weight on age), source_count mild, kind biases 0", () => {
    const sorted = Object.entries(PRIOR_WEIGHTS).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    expect(sorted[0]![0]).toBe("rerank");
    expect(sorted[1]![0]).toBe("cosine");
    expect(PRIOR_WEIGHTS.recency_days).toBeLessThan(0);
    expect(Math.abs(PRIOR_WEIGHTS.source_count)).toBeLessThan(0.5);
    expect([PRIOR_WEIGHTS.kind_link, PRIOR_WEIGHTS.kind_pattern, PRIOR_WEIGHTS.kind_distillation]).toEqual([0, 0, 0]);
    const f = (rerank: number | null, cosine: number) => computeFeatures({ kind: "link", rerank, cosine, now: clock, sources: [{ created_at: clock, context: null, keys: [], charge: [], salience: null }, { created_at: clock, context: null, keys: [], charge: [], salience: null }] });
    const hi = scoreOf(PRIOR_MODEL, f(0.9, 0.8));
    const lo = scoreOf(PRIOR_MODEL, f(0.1, 0.62));
    expect(hi).toBeGreaterThan(0.8);
    expect(lo).toBeLessThan(0.35);
    expect(scoreOf(PRIOR_MODEL, f(0.9, 0.7))).toBeGreaterThan(scoreOf(PRIOR_MODEL, f(0.5, 0.7)));
    expect(scoreOf(PRIOR_MODEL, f(null, 0.7))).toBeGreaterThan(scoreOf(PRIOR_MODEL, f(0.05, 0.7))); // no judgement is better than a bad one
    expect(PRIOR_BIAS).toBeLessThan(0);
  });
  it("loadModel takes the latest valid row, skips one it cannot read, and falls back to the prior", async () => {
    expect(await loadModelAs()).toBe(PRIOR_MODEL);
    const w = (b: number) => JSON.stringify({ bias: b, weights: Object.fromEntries(FEATURE_NAMES.map((k) => [k, 1])) });
    await A(`insert into extractor_models (mind_id, version, weights) values ('alpha', 1, $1), ('alpha', 2, $2), ('alpha', 3, '{"cosine": 1.5}')`, [w(-1), w(-2)]);
    expect(await loadModelAs()).toMatchObject({ version: 2, bias: -2, source: "trained" });
    expect(parseWeights({ bias: 1, weights: { cosine: "x" } })).toBeNull();
    expect(parseWeights({ bias: 1, weights: { cosine: 2 } })!.weights.rerank).toBe(0);
  });
});

describe("candidate text helpers", () => {
  it("a label is the commonest terms of the first lines, at most 80 characters; a summary is the first 240 characters of each source joined by ' / ', at most 1000", () => {
    const l = termsLabel(["Tomato seedlings need water\nsecond line ignored zzz", "the seedlings and the tomato frost", "tomato frost again"]);
    expect(l).toBe("tomato, seedlings, frost, need");
    expect(termsLabel(["the and for"])).toBe("the and for"); // no terms: the opening of the first source
    expect(termsLabel(["x".repeat(500)]).length).toBeLessThanOrEqual(80);
    expect(termsLabel(Array.from({ length: 30 }, (_, i) => `veryveryverylongword${i}${"y".repeat(20)}`)).length).toBeLessThanOrEqual(80);
    const item = (t: string): Item => ({ id: t.slice(0, 4), type: "event", text: t, vec: null, norm: 0, created_at: clock, context: null, keys: [], charge: [], salience: null, isNew: true, attended: false });
    expect(summaryOf([item("a".repeat(300)), item("b b")])).toBe(`${"a".repeat(240)} / b b`);
    expect(summaryOf(Array.from({ length: 12 }, (_, i) => item(`${i}`.padEnd(400, "z")))).length).toBe(1000);
    expect(snippetOf("  many   spaces\n here ")).toBe("many spaces here");
  });
});

describe("EXTRACTOR_* settings", () => {
  it("validate: positive whole numbers, with the defaults", () => {
    delete process.env.EXTRACTOR_REPROPOSE_DAYS;
    delete process.env.EXTRACTOR_MAX_CANDIDATES;
    delete process.env.EXTRACTOR_TTL_DAYS;
    expect(() => checkExtractorEnv()).not.toThrow();
    expect(extractorMaxCandidates()).toBe(50);
    expect(extractorMaxCandidates({ EXTRACTOR_MAX_CANDIDATES: "7" })).toBe(7);
    for (const bad of ["0", "-1", "1.5", "ten", "501", " 5"]) {
      expect(() => extractorMaxCandidates({ EXTRACTOR_MAX_CANDIDATES: bad }), bad).toThrow(/EXTRACTOR_MAX_CANDIDATES/);
    }
    expect(extractorLookbackDays({})).toBe(30);
    for (const bad of ["0", "366", "x", "1.5"]) expect(() => extractorLookbackDays({ EXTRACTOR_LOOKBACK_DAYS: bad }), bad).toThrow(/EXTRACTOR_LOOKBACK_DAYS/);
    expect(() => checkExtractorEnv({ EXTRACTOR_LOOKBACK_DAYS: "0" })).toThrow(/EXTRACTOR_LOOKBACK_DAYS/);
    for (const bad of ["0", "x", "2.5"]) expect(() => extractorReproposeDays({ EXTRACTOR_REPROPOSE_DAYS: bad }), bad).toThrow(/EXTRACTOR_REPROPOSE_DAYS/);
    expect(() => checkExtractorEnv({ EXTRACTOR_TTL_DAYS: "0" })).toThrow(/EXTRACTOR_TTL_DAYS/);
    expect(() => checkExtractorEnv({ EXTRACTOR_REPROPOSE_DAYS: "x" })).toThrow(/EXTRACTOR_REPROPOSE_DAYS/);
    expect(() => checkExtractorEnv({ EXTRACTOR_MAX_CANDIDATES: "0" })).toThrow(/EXTRACTOR_MAX_CANDIDATES/);
  });

  it("the daemon refuses to start on an invalid value, before its first tick", () => {
    process.env.EXTRACTOR_REPROPOSE_DAYS = "soon";
    expect(() => startDaemon({ pool, embedder: NONE_EMBEDDER }, { intervalMinutes: 30 })).toThrow(/EXTRACTOR_REPROPOSE_DAYS/);
  });
});

describe("the shadow report", () => {
  it("shows what shadow mode would have proposed per kind over 30 days, per-kind acceptance, the model and the last runs", async () => {
    await seedScenario();
    await enable("shadow");
    await extract();
    let rep = await extractorReport(admin, "alpha", () => clock);
    expect(rep.shadow_last_30_days).toEqual({ total: 3, by_kind: { link: 1, pattern: 1, distillation: 1 } });
    expect(rep.acceptance_by_kind).toEqual({});
    expect(rep.model).toBeNull();
    expect(rep.last_runs["notice.extract"]).toMatchObject({ ok: true, notes: { proposed_total: 3 } });
    expect(rep.last_runs["notice.train"]).toBeNull();
    let text = formatExtractorReport(rep);
    expect(text).toMatch(/shadow, last 30 days \(recorded, never shown\): would have proposed 3 \(distillation 1, link 1, pattern 1\)/);
    expect(text).toMatch(/model: version 0, the hand-set prior/);
    expect(text).toMatch(/acceptance by kind \(shown to the mind\): nothing shown yet/);
    expect(text).toMatch(/last notice\.extract: .* ok \(3 proposed from 3 candidate\(s\), reranker fake\)/);
    expect(text).toMatch(/last notice\.train: never/);
    expect((await extractorReport(admin, "alpha", () => at(40 * DAY))).shadow_last_30_days.total).toBe(0);

    // once shown, decided and trained on: per-kind acceptance and the model's held-out numbers
    await setExtractorState(admin, "alpha", "stage", { stage: "propose" });
    await seedForty();
    await train();
    rep = await extractorReport(admin, "alpha", () => clock);
    expect(rep.model).toMatchObject({ version: 1, trained_on: 32 });
    expect(rep.acceptance_by_kind.link).toEqual({ accepted: 20, decided: 40, rate: 0.5 });
    text = formatExtractorReport(rep);
    expect(text).toMatch(/model: version 1, fit on 32; held-out precision at 5 \d\.\d{3}, log loss \d\.\d{3} \(n=8\); before it/);
    expect(text).toMatch(/acceptance by kind \(shown to the mind\): link 50\.0% \(20 of 40\)/);
    expect(text).toMatch(/last notice\.train: .* ok \(trained version 1\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("export, import and purge carry extractor_runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "extractor-"));
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

  it("exports the run history, imports it marked as imported (a re-run adds nothing), leaves out rows dated after the import, and purge removes it, only for that mind", async () => {
    clock = at(-3 * DAY); // the run history must lie in the past of the import
    await seedScenario();
    await enable();
    await extract(clock, { embedder: NONE_EMBEDDER }); // a skipped row
    await extract(at(DAY)); // a real one
    await train(at(DAY));
    const rows = await A("select pass, started_at, finished_at, ok, notes from extractor_runs order by pass, started_at");
    expect(rows.map((r) => [r.pass, r.ok])).toEqual([["notice.extract", false], ["notice.extract", true], ["notice.train", true]]);

    await A("insert into extractor_runs (mind_id, pass, started_at, ok, notes) values ('alpha', 'notice.extract', now() + interval '2 days', true, '{}')");
    const f = join(dir, `x${seq++}.json`);
    const exp = await exportMind(pool, "alpha", f);
    expect(exp.counts.extractor_runs).toBe(4);

    const name = `extractor_import_${process.pid}_${seq++}`;
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
    dbs.push(name);
    await runMigrations(urlFor(name));
    const a2 = createPool(urlFor(name));
    const p2 = createPool(urlFor(name, true));
    extra.push(a2, p2);
    await upsertMinds(a2, [{ mind_id: "alpha", key: "alpha-key".padEnd(32, "-") }]);

    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.extractor_runs).toMatchObject({ inserted: 3, already_present: 0 });
    expect(rep.notes.some((n) => /1 extractor_runs row\(s\) in the file were not imported: their started_at is after the time of this import/.test(n))).toBe(true);
    const got = (await a2.query("select pass, started_at, finished_at, ok, notes from extractor_runs order by pass, started_at")).rows;
    expect(got).toEqual(rows.map((r) => ({ ...r, notes: { ...r.notes, imported: true } })));
    const again = await importMind(p2, f, "alpha");
    expect(again.tables.extractor_runs).toMatchObject({ inserted: 0, already_present: 3 });
    expect((await a2.query("select count(*)::int n from extractor_runs")).rows[0].n).toBe(3);

    await admin.query("insert into extractor_runs (mind_id, pass, started_at, ok) values ('beta', 'notice.extract', now(), true)");
    const purged = await purgeMind(admin, "alpha", { confirm: "alpha" });
    expect(purged.counts.extractor_runs).toBe(4);
    expect((await A("select count(*)::int n from extractor_runs where mind_id = 'alpha'"))[0].n).toBe(0);
    expect((await A("select count(*)::int n from extractor_runs where mind_id = 'beta'"))[0].n).toBe(1);
  });

  it("the rows are the mind's own: another mind cannot read or write them (row level security)", async () => {
    await enable();
    await seedScenario();
    await extract();
    const asBeta = await withMind(pool, "beta", "beta", "read", async (tx) => (await tx.query("select * from extractor_runs")).rows);
    expect(asBeta).toEqual([]);
    await expect(queryAs(pool, "beta", "beta", "insert into extractor_runs (mind_id, pass, started_at, ok) values ('alpha', 'notice.extract', now(), true)")).rejects.toThrow(/row-level security/);
    await expect(queryAs(pool, "alpha", "alpha", "insert into extractor_runs (mind_id, pass, started_at, ok) values ('alpha', 'notice.other', now(), true)")).rejects.toThrow(/check constraint/);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("new rows against a lookback", () => {
  it("links a node from ten days ago to a new one; two old nodes are not compared with each other, and nothing older than the lookback is", async () => {
    const old1 = await mkNode(HERON_A, { ageH: 240 });
    const old2 = await mkNode("the heron stands in the river at dawn again", { ageH: 241 }); // also old: old/old is not new
    const gone = await mkNode("heron stands in the shallow river at dawn long ago", { ageH: 24 * 40 }); // past the 30 day lookback
    const fresh = await mkNode(HERON_B, { ageH: 20 });
    await enable();
    expect((await extract()).changed).toBe(2);
    const links = await noticings("kind = 'link'");
    const pairs = links.map((l) => [...l.sources].sort().join());
    expect(pairs.sort()).toEqual([[old1, fresh].sort().join(), [old2, fresh].sort().join()].sort());
    expect(links.every((l) => l.sources.includes(fresh))).toBe(true);
    expect(links.some((l) => l.sources.includes(gone))).toBe(false);
    // the lookback is a setting: at 5 days neither old node is in reach
    await A("delete from noticings; delete from extractor_runs");
    process.env.EXTRACTOR_LOOKBACK_DAYS = "5";
    expect((await extract(at(DAY))).changed).toBe(0);
  });

  it("a pattern can recur across days: two events from earlier runs and one new one make a cluster", async () => {
    await enable();
    const t = (n: number) => `the ferry crossing at dawn was slow, harbour grey ${["one", "two", "three"][n]}`;
    const e0 = await mkEv(t(0), { ageH: 70 });
    const e1 = await mkEv(t(1), { ageH: 46 });
    expect((await extract()).changed).toBe(0); // two are not a pattern
    const e2 = await mkEv(t(2), { ageH: -1 }); // written after that run
    const p = await extract(at(DAY));
    expect(p.changed).toBeGreaterThanOrEqual(1);
    const pat = (await noticings("kind = 'pattern'"))[0];
    expect([...pat.sources].sort()).toEqual([e0, e1, e2].sort());
    expect(pat.payload.window).toEqual({ start: at(-70 * HOUR).toISOString(), end: at(HOUR).toISOString() });
    expect(pat.features.recency_days).toBeGreaterThan(0);
    // and a cluster of rows that are all older than the last run is not proposed again
    await A("delete from noticings");
    expect((await extract(at(2 * DAY))).changed).toBe(0);
  });
});

describe("the schedule gate", () => {
  it("one run per local date: moving the schedule later in the day does not run it twice, and a new date runs again", async () => {
    await seedScenario();
    await enable("shadow", "03:00");
    expect((await extract()).changed).toBe(3);
    await setExtractorState(admin, "alpha", "enable", { schedule: "12:30" }); // moved to after the run, earlier the same day
    const p = await extract(at(HOUR)); // 13:00: past the new schedule, no run since 12:30, but one today
    expect(p.changed).toBe(0);
    expect(p.notes!.join(" ")).toMatch(/already ran today/);
    expect(await runsOf("notice.extract")).toHaveLength(1);
    expect((await extract(at(DAY + HOUR))).notes!.join(" ")).not.toMatch(/already ran/);
    expect(await runsOf("notice.extract")).toHaveLength(2);
  });

  it("train too: one run per local date whatever the schedule", async () => {
    await enable("shadow", "03:00");
    await train();
    await setExtractorState(admin, "alpha", "enable", { schedule: "12:30" });
    expect((await train(at(HOUR))).notes!.join(" ")).toMatch(/already ran today/);
    expect(await runsOf("notice.train")).toHaveLength(1);
  });

  it("an imported run row does not use the day up, and is not where the next window starts", async () => {
    await seedScenario();
    await enable();
    await A("insert into extractor_runs (mind_id, pass, started_at, finished_at, ok, notes) values ('alpha', 'notice.extract', $1, $1, true, '{\"imported\": true}')", [at(-HOUR)]);
    await A("insert into extractor_runs (mind_id, pass, started_at, finished_at, ok, notes) values ('alpha', 'notice.train', $1, $1, true, '{\"imported\": true}')", [at(-HOUR)]);
    expect((await extract()).changed).toBe(3);
    expect((await train()).notes!.join(" ")).toMatch(/not trained/);
    // and the window began seven days back, not at the imported row
    expect((await runsOf("notice.extract")).pop().notes.window.new_since).toBe(at(-7 * DAY).toISOString());
  });
});

describe("sit subjects pass the same eligibility as everything else", () => {
  async function resolved(id: string, kind: "event" | "node", lastEvent: string): Promise<void> {
    await queryAs(pool, "alpha", "alpha",
      `insert into holdings (mind_id, subject_id, subject_kind, state, last_event_id, updated_at) values ('alpha', $1, $2, 'metabolized', $3, $4)`,
      [id, kind, lastEvent, at(-HOUR)]);
  }

  it("a grantee's event, a letter, an identity node, a bookkeeping event and a subject with no vector each make no distillation; an eligible one does", async () => {
    await mkEv("the ferry crossing was slow and the water was grey", { ageH: 5 }); // a related, eligible event
    const granteeEv = await mkEv("the ferry crossing was slow and the water was grey today", { by: "beta", ageH: 3 });
    const letter = await mkEv("the ferry crossing was slow and the water was grey, dear", { kind: "letter.send", ageH: 3 });
    const bookkeeping = await mkEv("the ferry crossing was slow and the water was grey", { kind: "notice.accepted", ageH: 3 });
    const novec = await mkEv("the ferry crossing was slow and the water was grey, no vector", { novec: true, ageH: 3 });
    const identity = await mkNode("the ferry crossing was slow and the water was grey, as I am", { type: "identity", ageH: 3 });
    const good = await mkEv("the ferry crossing was slow and the water was grey, truly", { ageH: 3 });
    for (const id of [granteeEv, letter, bookkeeping, novec]) await resolved(id, "event", id);
    await resolved(identity, "node", granteeEv);
    await enable();
    await extract();
    expect(await noticings("kind = 'distillation'")).toHaveLength(0);
    // the control: the same thing, from an eligible subject, is found
    await A("delete from noticings; delete from extractor_runs");
    await resolved(good, "event", good);
    await extract(at(DAY));
    const d = await noticings("kind = 'distillation'");
    expect(d).toHaveLength(1);
    expect(d[0].sources).toContain(good);
    for (const bad of [granteeEv, letter, bookkeeping, novec, identity]) expect(d[0].sources).not.toContain(bad);
  });
});

describe("importing the scorer's versions", () => {
  const dir = mkdtempSync(join(tmpdir(), "extractor-models-"));
  const extra: Pool[] = [];
  const dbs: string[] = [];
  afterAll(async () => {
    for (const p of extra.splice(0)) await closePool(p);
    if (admin) for (const d of dbs) await admin.query(`drop database if exists ${d} with (force)`);
  });
  const urlFor = (db: string, app = false): string => {
    if (app) return testAppUrl(db);
    const u = new URL(testDatabaseUrl());
    u.pathname = `/${db}`;
    return u.toString();
  };

  it("renumbers after the target's latest, keeps the original in the metrics, says so, drops nothing, and a second import adds none", async () => {
    const w = (b: number) => JSON.stringify({ bias: b, weights: Object.fromEntries(FEATURE_NAMES.map((k) => [k, 1])) });
    await A(`insert into extractor_models (mind_id, version, weights, trained_on, metrics) values ('alpha', 1, $1, 10, '{"n": 1}'), ('alpha', 3, $2, 20, '{"n": 3}')`, [w(-1), w(-3)]);
    const f = join(dir, "models.json");
    await exportMind(pool, "alpha", f);
    const name = `extractor_models_${process.pid}`;
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
    dbs.push(name);
    await runMigrations(urlFor(name));
    const a2 = createPool(urlFor(name));
    const p2 = createPool(urlFor(name, true));
    extra.push(a2, p2);
    await upsertMinds(a2, [{ mind_id: "alpha", key: "alpha-key".padEnd(32, "-") }]);
    await a2.query(`insert into extractor_models (mind_id, version, weights) values ('alpha', 5, $1)`, [w(-5)]);

    const rep = await importMind(p2, f, "alpha");
    expect(rep.tables.extractor_models).toMatchObject({ inserted: 2, already_present: 0 });
    expect(rep.notes.some((n) => /2 extractor model\(s\) were renumbered .*versions 6 to 7.*metrics\.imported_from_version/.test(n))).toBe(true);
    const rows = (await a2.query("select version, trained_on, metrics from extractor_models order by version")).rows;
    expect(rows.map((r) => r.version)).toEqual([5, 6, 7]);
    expect(rows[1]).toMatchObject({ trained_on: 10, metrics: { n: 1, imported_from_version: 1 } });
    expect(rows[2]).toMatchObject({ trained_on: 20, metrics: { n: 3, imported_from_version: 3 } });
    const again = await importMind(p2, f, "alpha");
    expect(again.tables.extractor_models).toMatchObject({ inserted: 0, already_present: 2 });
    expect((await a2.query("select count(*)::int n from extractor_models")).rows[0].n).toBe(3);
  });
});
