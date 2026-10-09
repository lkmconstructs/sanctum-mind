// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, queryLegacy, resetDatabase, testAppUrl, testDatabaseUrl } from "./helpers.js";
import { upsertMinds } from "../src/auth.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool, withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { ALL_PASSES, PASSES, runDaemonOnce } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { exportMind } from "../src/export.js";
import { importMind } from "../src/import-mind.js";
import { purgeMind } from "../src/purge.js";
import { extractorReport, formatExtractorReport, setExtractorState } from "../src/extractor-admin.js";
import { noticeRepair, repairScore } from "../src/extractor/repair.js";
import { noticeExpire } from "../src/extractor/expire.js";
import { EXTRACTOR_EVENT_SHAPES } from "../src/extractor/events.js";
import { noticeAcceptedPayload, noticeRejectedPayload, repairKeptPayload, repairRethoughtPayload, repairRetiredPayload } from "../src/verbs/notice_events.js";
import type { AnyPass } from "../src/daemon/index.js";
import type { Caller } from "../src/verbs/types.js";

const DAY = 86_400_000;
const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: {} };
const betaRead: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const betaWrite: Caller = { bearer: "beta", grants: { alpha: ["read", "write"] } };
const IDENTITY_MSG = "identity belongs to the mind";

let admin: Pool;
let pool: Pool;
let T0: Date;
let clock: Date;
let cooling = 24 * 3_600_000;

const run = (caller: Caller, name: string, input: unknown) =>
  runVerb({ pool, registry, now: () => clock, embedder: NONE_EMBEDDER, coolingMs: cooling }, caller, name, input) as Promise<any>;
const A = (name: string, input: Record<string, unknown>) => run(alpha, name, { mind_id: "alpha", ...input });
const N = (input: Record<string, unknown>, caller: Caller = alpha, mind = "alpha") => run(caller, "mind_notice", { mind_id: mind, ...input });
const q = <T = any>(sql: string, params: unknown[] = [], mind = "alpha"): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const expectErr = (r: any, code: string, field?: string) => {
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe(code);
  if (field !== undefined) expect(r.error.field).toBe(field);
};
const daemon = (passes?: readonly AnyPass[], at: Date = clock) =>
  runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => at, coolingMs: cooling }, { trigger: "manual", minds: ["alpha"], ...(passes ? { passes } : {}) });
const repairPass = async (at: Date = clock) => (await daemon([noticeRepair], at))[0]!.passes[0]!;
const repairs = (where = "true") => q(`select * from noticings where kind = 'repair' and ${where} order by score desc, created_at, id`);
const countOf = async (table: string, where = "true"): Promise<number> => (await admin.query(`select count(*)::int n from ${table} where ${where}`)).rows[0].n;

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  T0 = new Date();
  clock = T0;
  cooling = 24 * 3_600_000;
});
afterEach(() => {
  delete process.env.EXTRACTOR_REPROPOSE_DAYS;
});
afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

async function mkNode(content: string, type = "observation", metadata: object = {}, mind = "alpha"): Promise<string> {
  const r = await queryAs(
    pool, mind, mind,
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, metadata) values ($1, $2, $3, $4, $1, 'extracted', 1.0, $5::jsonb) returning id`,
    [mind, type, content.slice(0, 50), content, JSON.stringify(metadata)],
  );
  return r.rows[0].id;
}
async function mkEdge(source: string, target: string, type: string): Promise<string> {
  const r = await queryAs(
    pool, "alpha", "alpha",
    `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', $3, 'alpha', $1, $2) returning id`,
    [source, target, type],
  );
  return r.rows[0].id;
}
const rethink = async (node: string, content = "a corrected view") => {
  const r = await A("mind_rethink", { node_id: node, content, reason: "learned better" });
  expect(r.ok).toBe(true);
  return r.receipt.projection.node_id as string;
};
const snap = async (ids: string[]) => (await admin.query(`select to_jsonb(n)::text j from nodes n where id = any($1::uuid[]) order by id`, [ids])).rows.map((r) => r.j);
const memorySnap = async () => ({
  nodes: (await admin.query("select to_jsonb(n)::text j from nodes n order by id")).rows.map((r) => r.j),
  edges: (await admin.query("select to_jsonb(e)::text j from edges e order by id")).rows.map((r) => r.j),
});
const setState = async (stage: "shadow" | "propose", enabled = true) => {
  await setExtractorState(admin, "alpha", "enable", { stage });
  if (!enabled) await setExtractorState(admin, "alpha", "disable");
};

/** U (superseded) with a derived_from dependant by edge and a dependant by metadata.sources. */
async function twoDependants() {
  const u = await mkNode("the sky is green");
  const d1 = await mkNode("so the grass must be blue", "belief");
  const d2 = await mkNode("a note built on the sky", "distillation", { sources: [u] });
  const other = await mkNode("unrelated");
  await mkEdge(d1, u, "derived_from");
  const r = await rethink(u, "the sky is blue");
  return { u, d1, d2, other, r };
}

describe("the pass", () => {
  it("is the twelfth deterministic pass and the fourteenth of a normal tick", () => {
    expect(PASSES).toHaveLength(12);
    expect(PASSES[11]!.name).toBe("notice.repair");
    expect(ALL_PASSES).toHaveLength(14);
    expect(PASSES.some((p) => p.name === "notice.repair" && "detached" in p)).toBe(false);
  });

  it("superseding a node with two dependants (an edge, metadata.sources) proposes two repairs with the right payloads and no memory text in the event", async () => {
    const { u, d1, d2, other, r } = await twoDependants();
    const out = await repairPass();
    expect(out).toMatchObject({ ok: true, changed: 2 });
    const rows = await repairs();
    expect(rows).toHaveLength(2);
    const by = new Map(rows.map((x) => [x.payload.dependant_id, x]));
    expect([...by.keys()].sort()).toEqual([d1, d2].sort());
    expect(by.has(other)).toBe(false);
    expect(by.has(r)).toBe(false); // the replacement is not a dependant, though a corrects edge joins it to U
    const x1 = by.get(d1)!;
    expect(x1).toMatchObject({ kind: "repair", stage: "propose", status: "pending", score: 1, model_version: 0, sources: [d1, u] });
    expect(x1.payload).toMatchObject({ upstream_id: u, upstream_state: "superseded", replacement_id: r, dependant_id: d1, dependant_type: "belief", relation: "derived_from" });
    expect(by.get(d2)!.payload).toMatchObject({ upstream_id: u, replacement_id: r, dependant_type: "distillation", relation: "sources" });
    expect(by.get(d2)!.score).toBe(1);
    expect(x1.expires_at.getTime()).toBe(clock.getTime() + 14 * DAY);
    // the row's payload shows a snippet of the replacement (the mind's own words, in the proposal only); the events carry ids
    for (const x of rows) {
      expect(x.payload.replacement_snippet).toBe("the sky is blue");
      const { replacement_snippet: _snippet, ...rest } = x.payload;
      for (const w of ["green", "blue", "grass", "sky"]) expect(JSON.stringify(rest)).not.toContain(w);
    }
    for (const e of (await admin.query("select payload from events where kind = 'notice.proposed'")).rows) {
      for (const w of ["green", "blue", "grass", "sky"]) expect(JSON.stringify(e.payload)).not.toContain(w);
    }
    const evs = (await admin.query("select * from events where kind = 'notice.proposed'")).rows;
    expect(evs).toHaveLength(2);
    for (const e of evs) {
      expect(EXTRACTOR_EVENT_SHAPES["notice.proposed"].parse(e.payload)).toMatchObject({ noticing_kind: "repair", stage: "propose", source_count: 2, model_version: 0, score: 1 });
      expect(rows.some((x) => x.id === e.subject_id && x.proposed_event_id === e.id)).toBe(true);
    }
    expect(await countOf("events", "kind like 'repair.%'")).toBe(0);
  });

  it("scores 1.0 for derived_from, instance_of, sources and corrects, and 0.8 for the rest; reports edge types and noticing links, either direction", async () => {
    expect([repairScore("derived_from"), repairScore("instance_of"), repairScore("sources"), repairScore("corrects")]).toEqual([1, 1, 1, 1]);
    const u = await mkNode("upstream");
    const inst = await mkNode("an instance", "observation");
    const sup = await mkNode("supported by it", "observation");
    const odd = await mkNode("odd link", "observation");
    const viaNoticing = await mkNode("made from a noticing", "pattern");
    const corr = await mkNode("corrects it, uncorrected node", "observation");
    await mkEdge(inst, u, "instance_of");
    await mkEdge(u, sup, "supports");
    await mkEdge(odd, u, "mentions");
    await mkEdge(corr, u, "corrects");
    const ev = (await queryAs(pool, "alpha", "alpha", `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'notice.proposed', '{}', 'alpha', now()) returning id`)).rows[0].id;
    const nid = (await queryAs(pool, "alpha", "alpha",
      `insert into noticings (mind_id, kind, sources, payload, score, stage, status, proposed_event_id, expires_at, decided_event_id, decided_at)
       values ('alpha', 'pattern', $1::uuid[], '{}', 0.5, 'propose', 'expired', $2, now(), $2, now()) returning id`, [[u, inst], ev])).rows[0].id;
    await queryAs(pool, "alpha", "alpha", `update nodes set metadata = metadata || $2::jsonb where id = $1`, [viaNoticing, JSON.stringify({ noticing_id: nid })]);
    await rethink(u);
    await repairPass();
    const rel = Object.fromEntries((await repairs()).map((x) => [x.payload.dependant_id, [x.payload.relation, x.score]]));
    expect(rel).toEqual({
      [inst]: ["instance_of", 1],
      [sup]: ["supports", 0.8],
      [odd]: ["mentions", 0.8],
      [corr]: ["corrects", 1],
      [viaNoticing]: ["noticing", 0.8],
    });
  });

  it("retiring a core proposes repairs for nodes deriving from it (a settled mind_identity retire, in one daemon tick)", async () => {
    cooling = 0;
    const core = (await A("mind_identity", { operation: "affirm", section: "core", content: "who I was" })).receipt.projection.node_id as string;
    await A("mind_identity", { operation: "affirm", section: "other", content: "who I also am" });
    const d = await mkNode("a habit that followed from it", "pattern");
    await mkEdge(d, core, "derived_from");
    const rr = await A("mind_identity", { operation: "retire", target_node_id: core, lineage_note: "enough" });
    expect(rr.ok).toBe(true);
    const report = (await daemon(undefined, new Date(rr.receipt.projection.proposal.effective_at)))[0]!;
    expect(report.ok).toBe(true);
    expect((await q("select invalidated_at, superseded_by from nodes where id = $1", [core]))[0].invalidated_at).not.toBeNull();
    const rows = await repairs();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ upstream_id: core, upstream_state: "retired", replacement_id: null, replacement_snippet: null, dependant_id: d, dependant_type: "pattern", relation: "derived_from" });
    // the retirement itself (an event about the proposal, not the node) is among the context events
    const kinds = (await admin.query("select kind from events where id = any($1::uuid[])", [rows[0].payload.context_event_ids])).rows.map((r) => r.kind);
    expect(kinds).toContain("identity.retired");
  });

  it("runs with the extractor off, shows its repairs there, and shadow stage does not hide them", async () => {
    const { d1, d2 } = await twoDependants();
    expect(await countOf("extractor_state")).toBe(0);
    await repairPass();
    expect(await repairs()).toHaveLength(2);
    expect(await repairs("stage = 'propose'")).toHaveLength(2);
    const off = (await N({ operation: "list" })).receipt.projection;
    expect(off.stage).toBe("off");
    expect(off.noticings.map((n: any) => n.payload.dependant_id).sort()).toEqual([d1, d2].sort());
    // sources carry the dependant and the (invalidated) upstream, with snippets
    expect(off.noticings[0].sources.map((s: any) => s.type)).toEqual(["node", "node"]);
    // a link proposal at stage shadow is still not shown, the repairs are
    await setState("shadow");
    const sh = (await N({ operation: "list" })).receipt.projection;
    expect(sh.stage).toBe("shadow");
    expect(sh.noticings).toHaveLength(2);
    expect(sh.noticings.every((n: any) => n.kind === "repair")).toBe(true);
    // disabled and paused again: still shown
    await setState("propose", false);
    expect((await N({ operation: "list", kind: "repair" })).receipt.projection.noticings).toHaveLength(2);
    expect((await N({ operation: "list", kind: "link" })).receipt.projection.noticings).toHaveLength(0);
  });

  it("repairs rank first in the list, and the orient noticings section, repairs {pending} and health.repairs_pending count them", async () => {
    await setState("propose");
    const a = await mkNode("link end one");
    const b = await mkNode("link end two");
    const ev = (await queryAs(pool, "alpha", "alpha", `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'notice.proposed', '{}', 'alpha', now()) returning id`)).rows[0].id;
    const linkId = (await queryAs(pool, "alpha", "alpha",
      `insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at)
       values ('alpha', 'link', $1::uuid[], '{"edge_type":"related_to","reason":"x"}', 0.99, 'propose', $2, now() + interval '1 day') returning id`, [[a, b], ev])).rows[0].id;
    const { d1 } = await twoDependants();
    await mkEdge(await mkNode("loosely tied"), d1, "mentions");
    const u2 = await mkNode("another upstream");
    const w = await mkNode("weakly tied", "observation");
    await mkEdge(u2, w, "supports");
    await rethink(u2);
    await repairPass();
    const list = (await N({ operation: "list" })).receipt.projection.noticings;
    expect(list.map((n: any) => n.kind)).toEqual(["repair", "repair", "repair", "link"]);
    expect(list.map((n: any) => n.score)).toEqual([1, 1, 0.8, 0.99]);
    expect(list[3].id).toBe(linkId);
    const quick = (await A("mind_orient", { depth: "quick" })).receipt.projection.sections;
    expect(quick.noticings.map((n: any) => n.kind)).toEqual(["repair", "repair", "repair", "link"]);
    expect(quick.repairs).toEqual({ pending: 3 });
    expect((await A("mind_orient", { depth: "full" })).receipt.projection.sections.repairs).toEqual({ pending: 3 });
    expect(quick.health.extractor).toMatchObject({ pending: 1, repairs_pending: 3 }); // pending is the extractor's own
    expect((await A("mind_orient", { depth: "orientation" })).receipt.projection.sections.repairs).toBeUndefined();
    // with the extractor off the repairs remain, the link does not
    await setState("propose", false);
    await admin.query("delete from extractor_state");
    const off = (await A("mind_orient", { depth: "quick" })).receipt.projection.sections;
    expect(off.noticings.map((n: any) => n.kind)).toEqual(["repair", "repair", "repair"]);
    expect(off.repairs).toEqual({ pending: 3 });
    expect(off.health.extractor).toMatchObject({ stage: "off", pending: 0, repairs_pending: 3 });
  });

  it("looks only at what changed since it last ran, caps at 30 upstream nodes a run, ignores the quiet, and writes a run row when it looked at something", async () => {
    expect(await repairPass()).toMatchObject({ ok: true, changed: 0 });
    expect(await countOf("extractor_runs")).toBe(0);
    // 32 retired nodes (inserted directly, invalidated now), each with a dependant by metadata.sources; one more 40 days ago
    const mk = async (i: number, ago: number) => {
      const u = (await admin.query(
        `insert into nodes (mind_id, node_type, label, content, written_by, source_type, invalidated_at, metadata)
         values ('alpha', 'observation', $1, $1, 'alpha', 'extracted', now() - $2::interval, '{"retired": true}') returning id`,
        [`gone ${i}`, `${ago} days`],
      )).rows[0].id;
      await mkNode(`dep ${i}`, "observation", { sources: [u] });
      return u;
    };
    const old = await mk(99, 40);
    for (let i = 0; i < 32; i++) await mk(i, 0);
    // a revien-style invalidated node (no superseded_by, not retired) is not an upstream
    await admin.query(`insert into nodes (mind_id, node_type, label, content, written_by, source_type, invalidated_at) values ('alpha', 'observation', 'old', 'old', 'alpha', 'extracted', now())`);
    const first = await repairPass();
    expect(first.changed).toBe(30);
    const row1 = (await q("select notes from extractor_runs where pass = 'notice.repair'"))[0].notes;
    expect(row1).toMatchObject({ upstreams: 30, proposed: 30, capped: true });
    const second = await repairPass();
    expect(second.changed).toBe(2);
    expect((await q("select notes from extractor_runs where pass = 'notice.repair' order by started_at desc limit 1"))[0].notes).toMatchObject({ proposed: 2, capped: false });
    expect(await repairs(`sources @> array['${old}'::uuid]`)).toHaveLength(0); // beyond the 30-day first window
    expect(await repairPass()).toMatchObject({ changed: 0 });
    expect(await countOf("extractor_runs", "pass = 'notice.repair'")).toBe(2);
    expect(await repairs()).toHaveLength(32);
  });

  it("dedupes: a second run proposes nothing, and a pair is not proposed again even when its window is covered again", async () => {
    await twoDependants();
    await repairPass();
    expect(await repairPass()).toMatchObject({ changed: 0 });
    await admin.query("delete from extractor_runs");
    expect(await repairPass()).toMatchObject({ changed: 0 });
    expect(await repairs()).toHaveLength(2);
    expect(await countOf("events", "kind = 'notice.proposed'")).toBe(2);
  });

  it("an expired repair is proposed again only after EXTRACTOR_REPROPOSE_DAYS", async () => {
    process.env.EXTRACTOR_REPROPOSE_DAYS = "3";
    const { d1 } = await twoDependants();
    await repairPass();
    const expiry = new Date(T0.getTime() + 15 * DAY);
    expect((await daemon([noticeExpire], expiry))[0]!.passes[0]!.changed).toBe(2);
    await admin.query("delete from extractor_runs");
    // two days after the expiry: held back
    expect(await repairPass(new Date(expiry.getTime() + 1 * DAY))).toMatchObject({ changed: 0 });
    // after the hold, and with the window covering the node again (a reset run history, as after an import): both come back as new rows; the expired ones stay
    await admin.query("delete from extractor_runs");
    expect(await repairPass(new Date(expiry.getTime() + 4 * DAY))).toMatchObject({ changed: 2 });
    expect(await repairs("status = 'expired'")).toHaveLength(2);
    expect(await repairs("status = 'pending'")).toHaveLength(2);
    expect((await repairs("status = 'pending'")).some((x) => x.payload.dependant_id === d1)).toBe(true);
  });
});

describe("chains, paging, caps and authorship", () => {
  it("chains through the replacement: a dependant rethought against U is asked again when U' is superseded", async () => {
    const u = await mkNode("first premise");
    const d = await mkNode("built on the first premise", "belief");
    await mkEdge(d, u, "derived_from");
    const u1 = await rethink(u, "second premise");
    await repairPass();
    const row = (await repairs())[0]!;
    const res = await N({ operation: "accept", noticing_id: row.id, decision: "rethink", content: "built on the second premise" });
    const d1 = res.receipt.projection.node_id as string;
    await repairPass();
    expect(await repairs("status = 'pending'")).toHaveLength(0);
    const u2 = await rethink(u1, "third premise");
    await repairPass();
    const rows = await repairs("status = 'pending'");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ upstream_id: u1, replacement_id: u2, dependant_id: d1, relation: "replacement", upstream_state: "superseded" });
    expect(rows[0].score).toBe(0.8);
  });

  it("chains through the replacement for a kept dependant too (the keep records the replacement)", async () => {
    const u = await mkNode("first premise");
    const d = await mkNode("built on the first premise", "belief");
    await mkEdge(d, u, "derived_from");
    const u1 = await rethink(u, "second premise");
    await repairPass();
    const row = (await repairs())[0]!;
    expect((await N({ operation: "accept", noticing_id: row.id, decision: "keep" })).ok).toBe(true);
    expect((await q("select metadata->'repair_reviewed'->0->>'replacement_id' r from nodes where id = $1", [d]))[0].r).toBe(u1);
    await repairPass();
    expect(await repairs("status = 'pending'")).toHaveLength(0);
    const u2 = await rethink(u1, "third premise");
    await repairPass();
    const rows = await repairs("status = 'pending'");
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ upstream_id: u1, replacement_id: u2, dependant_id: d, relation: "replacement" });
  });

  it("pages on (invalidated_at, id): 32 upstreams with the same timestamp are all proposed across ticks", async () => {
    const ids = (await admin.query(
      `insert into nodes (mind_id, node_type, label, content, written_by, source_type, invalidated_at, metadata)
       select 'alpha', 'observation', 'gone ' || g, 'gone ' || g, 'alpha', 'extracted', now(), '{"retired": true}' from generate_series(1, 32) g returning id`,
    )).rows.map((r) => r.id);
    expect(new Set((await admin.query("select invalidated_at from nodes")).rows.map((r) => r.invalidated_at.getTime())).size).toBe(1);
    for (const id of ids) await mkNode(`dep of ${id}`, "observation", { sources: [id] });
    expect((await repairPass()).changed).toBe(30);
    expect((await repairPass()).changed).toBe(2);
    expect((await repairPass()).changed).toBe(0);
    expect(new Set((await repairs()).map((x) => x.payload.upstream_id)).size).toBe(32);
  });

  it("reads back a minute: an invalidation with an earlier timestamp that committed after a run is picked up on the next tick", async () => {
    const mk = async (secondsAgo: number) => {
      const u = (await admin.query(
        `insert into nodes (mind_id, node_type, label, content, written_by, source_type, invalidated_at, metadata)
         values ('alpha', 'observation', 'gone', 'gone', 'alpha', 'extracted', now() - $1::interval, '{"retired": true}') returning id`,
        [`${secondsAgo} seconds`],
      )).rows[0].id;
      await mkNode(`dep of ${u}`, "observation", { sources: [u] });
      return u;
    };
    await mk(0);
    expect((await repairPass()).changed).toBe(1);
    expect((await repairPass()).changed).toBe(0);
    const late = await mk(10); // stamped before the run's newest node, committed after the run
    expect((await repairPass()).changed).toBe(1);
    expect((await repairs(`sources @> array['${late}'::uuid]`))).toHaveLength(1);
    expect((await repairPass()).changed).toBe(0);
    expect(await repairs()).toHaveLength(2);
  });

  it("proposes at most 25 repairs per upstream node per tick and continues on the next", async () => {
    const u = (await admin.query(
      `insert into nodes (mind_id, node_type, label, content, written_by, source_type, invalidated_at, metadata)
       values ('alpha', 'observation', 'gone', 'gone', 'alpha', 'extracted', now(), '{"retired": true}') returning id`,
    )).rows[0].id;
    for (let i = 0; i < 30; i++) await mkNode(`dep ${i}`, "observation", { sources: [u] });
    expect((await repairPass()).changed).toBe(25);
    expect((await repairPass()).changed).toBe(5);
    expect((await repairPass()).changed).toBe(0);
    expect(await repairs()).toHaveLength(30);
    expect(new Set((await repairs()).map((x) => x.payload.dependant_id)).size).toBe(30);
  });

  it("only nodes the mind wrote are asked about: a grantee's node tied to the upstream is not a dependant", async () => {
    const u = await mkNode("upstream");
    const mine = await mkNode("mine", "belief", { sources: [u] });
    const theirs = (await admin.query(
      `insert into nodes (mind_id, node_type, label, content, written_by, source_type, metadata) values ('alpha', 'belief', 'theirs', 'theirs', 'beta', 'extracted', $1::jsonb) returning id`,
      [JSON.stringify({ sources: [u] })],
    )).rows[0].id;
    await mkEdge(theirs, u, "derived_from");
    await rethink(u);
    await repairPass();
    expect((await repairs()).map((x) => x.payload.dependant_id)).toEqual([mine]);
  });

  it("repair.retired is a change to memory and shows in recent; repair.kept and repair.rethought do not", async () => {
    const { d1, d2 } = await twoDependants();
    await repairPass();
    const by = (d: string) => repairs().then((r) => r.find((x) => x.payload.dependant_id === d)!.id);
    expect((await N({ operation: "accept", noticing_id: await by(d1), decision: "retire" })).ok).toBe(true);
    expect((await N({ operation: "accept", noticing_id: await by(d2), decision: "keep" })).ok).toBe(true);
    const kinds = ((await A("mind_orient", { depth: "full" })).receipt.projection.sections.recent.events as any[]).map((e) => e.kind);
    expect(kinds).toContain("repair.retired");
    expect(kinds).not.toContain("repair.kept");
    expect(kinds.some((k) => k.startsWith("notice."))).toBe(false);
    clock = new Date(Date.now() + 5000); // the weather window ends at the verb clock; events are stamped with the real time
    const weather = JSON.stringify((await A("mind_weather", { lookback_hours: 24 })).receipt.projection);
    expect(weather).toContain("repair.retired");
    expect(weather).not.toContain("repair.kept");
  });

  it("keep and retire work on a dependant whose metadata is not an object", async () => {
    const { d1, d2 } = await twoDependants();
    await repairPass();
    await queryLegacy(admin, "update nodes set metadata = '[]'::jsonb where id = any($1::uuid[])", [[d1, d2]]);
    const by = (d: string) => repairs().then((r) => r.find((x) => x.payload.dependant_id === d)!.id);
    expect((await N({ operation: "accept", noticing_id: await by(d1), decision: "keep" })).ok).toBe(true);
    expect((await N({ operation: "accept", noticing_id: await by(d2), decision: "retire" })).ok).toBe(true);
    const a = (await admin.query("select metadata, invalidated_at from nodes where id = $1", [d1])).rows[0];
    expect(a.metadata.repair_reviewed).toHaveLength(1);
    expect(a.invalidated_at).toBeNull();
    const b = (await admin.query("select metadata, invalidated_at from nodes where id = $1", [d2])).rows[0];
    expect(b.metadata).toMatchObject({ retired: true });
    expect(b.invalidated_at).not.toBeNull();
  });
});

describe("deciding: keep", () => {
  it("writes repair.kept and the notice.accepted decision, appends to the dependant's metadata, and changes nothing else", async () => {
    const { u, d1, d2 } = await twoDependants();
    await repairPass();
    const row = (await repairs()).find((x) => x.payload.dependant_id === d1)!;
    const before = await memorySnap();
    const others = await snap([u, d2]);
    const events0 = await countOf("events");

    const r = await N({ operation: "accept", noticing_id: row.id, decision: "keep" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toMatchObject({ noticing_id: row.id, status: "accepted", decision: "keep" });
    const evs = (await admin.query("select * from events order by seq offset $1", [events0])).rows;
    expect(evs.map((e) => e.kind)).toEqual(["repair.kept", "notice.accepted"]);
    expect(evs[0]).toMatchObject({ subject_id: d1, written_by: "alpha" });
    expect(repairKeptPayload.parse(evs[0].payload)).toEqual({ noticing_id: row.id, upstream_id: u });
    expect(evs[1]).toMatchObject({ subject_id: row.id });
    expect(evs[1].payload).toEqual({ noticing_id: row.id, kind: "repair", decision: "keep" });
    expect(noticeAcceptedPayload.parse(evs[1].payload)).toBeTruthy();
    expect(r.receipt.event_id).toBe(evs[1].id);
    const noticing = (await admin.query("select status, decided_event_id from noticings where id = $1", [row.id])).rows[0];
    expect(noticing).toEqual({ status: "accepted", decided_event_id: evs[1].id });

    const after = await memorySnap();
    expect(after.edges).toEqual(before.edges);
    const d = (await admin.query("select * from nodes where id = $1", [d1])).rows[0];
    expect(d.invalidated_at).toBeNull();
    expect(d.metadata.repair_reviewed).toHaveLength(1);
    expect(d.metadata.repair_reviewed[0]).toMatchObject({ upstream_id: u, event_id: evs[0].id });
    expect(typeof d.metadata.repair_reviewed[0].at).toBe("string");
    // every node but d1, and every column of d1 but metadata, is byte-identical
    const strip = (j: string) => { const o = JSON.parse(j); delete o.metadata; return o; };
    expect(after.nodes.map((j) => (JSON.parse(j).id === d1 ? strip(j) : JSON.parse(j)))).toEqual(before.nodes.map((j) => (JSON.parse(j).id === d1 ? strip(j) : JSON.parse(j))));
    expect(await snap([u, d2])).toEqual(others);
    expect(await countOf("nodes")).toBe(5);

    // a node kept for U is not asked about U again, and a second keep appends to the list
    await admin.query("delete from extractor_runs");
    await repairPass();
    expect(await repairs(`sources @> array['${d1}'::uuid] and status = 'pending'`)).toHaveLength(0);
  });

  it("works with the extractor off, refuses content and label, and needs live dependant", async () => {
    const { d1 } = await twoDependants();
    await repairPass();
    const id = (await repairs()).find((x) => x.payload.dependant_id === d1)!.id;
    expectErr(await N({ operation: "accept", noticing_id: id, decision: "keep", content: "words" }), "invalid_input", "content");
    expectErr(await N({ operation: "accept", noticing_id: id, decision: "keep", label: "l" }), "invalid_input", "label");
    expectErr(await N({ operation: "accept", noticing_id: id, decision: "keep", weight: 0.5 }), "invalid_input", "weight");
    expect(await countOf("events", "kind like 'repair.%'")).toBe(0);
    expect((await N({ operation: "accept", noticing_id: id, decision: "keep" })).ok).toBe(true);
    expectErr(await N({ operation: "accept", noticing_id: id, decision: "keep" }), "conflict", "noticing_id");
    // a dependant that has since been invalidated cannot be reviewed; the proposal stays until rejected or expired
    const other = (await repairs("status = 'pending'"))[0]!;
    await queryAs(pool, "alpha", "alpha", "update nodes set invalidated_at = now() where id = $1", [other.payload.dependant_id]);
    expectErr(await N({ operation: "accept", noticing_id: other.id, decision: "keep" }), "conflict", "noticing_id");
    expect((await N({ operation: "reject", noticing_id: other.id })).ok).toBe(true);
  });
});

describe("deciding: rethink", () => {
  it("supersedes the dependant exactly as mind_rethink does, with provenance and both events, leaving the upstream and its replacement alone", async () => {
    const { u, d1, d2, r } = await twoDependants();
    await repairPass();
    const row = (await repairs()).find((x) => x.payload.dependant_id === d1)!;
    const untouched = await snap([u, r, d2]);
    const events0 = await countOf("events");

    expectErr(await N({ operation: "accept", noticing_id: row.id, decision: "rethink" }), "invalid_input", "content");
    expect(await countOf("events")).toBe(events0);

    const res = await N({ operation: "accept", noticing_id: row.id, decision: "rethink", content: "so the grass is green after all", label: "grass" });
    expect(res.ok).toBe(true);
    const nodeId = res.receipt.projection.node_id as string;
    expect(res.receipt.projection).toMatchObject({ status: "accepted", decision: "rethink", superseded: d1 });

    const evs = (await admin.query("select * from events order by seq offset $1", [events0])).rows;
    expect(evs.map((e) => e.kind)).toEqual(["rethink", "repair.rethought", "notice.accepted"]);
    expect(evs[0]).toMatchObject({ subject_id: d1 });
    expect(evs[0].payload).toMatchObject({ content: "so the grass is green after all", label: "grass", reason: `repair of ${u}` });
    expect(repairRethoughtPayload.parse(evs[1].payload)).toEqual({ noticing_id: row.id, upstream_id: u, node_id: nodeId });
    expect(evs[1].subject_id).toBe(d1);
    expect(evs[2].payload).toEqual({ noticing_id: row.id, kind: "repair", decision: "rethink", node_id: nodeId });

    const old = (await admin.query("select * from nodes where id = $1", [d1])).rows[0];
    expect(old.invalidated_at).not.toBeNull();
    expect(old.superseded_by).toBe(nodeId);
    const fresh = (await admin.query("select * from nodes where id = $1", [nodeId])).rows[0];
    expect(fresh).toMatchObject({ content: "so the grass is green after all", label: "grass", node_type: "belief", written_by: "alpha", invalidated_at: null });
    expect(fresh.metadata).toMatchObject({ noticing_id: row.id, upstream_id: u, replacement_id: r, rewritten_from: d1, reason: `repair of ${u}`, event_id: evs[0].id });
    expect((await admin.query("select edge_type, source_node_id, target_node_id from edges where edge_type = 'corrects' and target_node_id = $1", [d1])).rows).toEqual([
      { edge_type: "corrects", source_node_id: nodeId, target_node_id: d1 },
    ]);
    expect(await snap([u, r, d2])).toEqual(untouched);
    expect((await admin.query("select status, decided_event_id from noticings where id = $1", [row.id])).rows[0]).toEqual({ status: "accepted", decided_event_id: evs[2].id });

    // the new node is not asked about U again, and what depended on the old one is now asked about it (cascade)
    const e = await mkNode("depends on the old belief");
    await mkEdge(e, d1, "derived_from");
    await admin.query("delete from extractor_runs");
    await repairPass();
    expect(await repairs(`sources @> array['${nodeId}'::uuid]`)).toHaveLength(0);
    const casc = await repairs(`sources @> array['${e}'::uuid]`);
    expect(casc).toHaveLength(1);
    expect(casc[0].payload).toMatchObject({ upstream_id: d1, upstream_state: "superseded", replacement_id: nodeId, dependant_id: e });
  });
});

describe("deciding: retire", () => {
  it("invalidates the dependant with the metadata and the event, no replacement, and the sources untouched", async () => {
    const { u, d1, d2, r } = await twoDependants();
    await repairPass();
    const row = (await repairs()).find((x) => x.payload.dependant_id === d1)!;
    const untouched = await snap([u, r, d2]);
    const nodes0 = await countOf("nodes");
    const events0 = await countOf("events");
    const res = await N({ operation: "accept", noticing_id: row.id, decision: "retire" });
    expect(res.ok).toBe(true);
    expect(await countOf("nodes")).toBe(nodes0);
    const evs = (await admin.query("select * from events order by seq offset $1", [events0])).rows;
    expect(evs.map((e) => e.kind)).toEqual(["repair.retired", "notice.accepted"]);
    expect(repairRetiredPayload.parse(evs[0].payload)).toEqual({ noticing_id: row.id, upstream_id: u });
    expect(evs[0].subject_id).toBe(d1);
    expect(evs[1].payload).toEqual({ noticing_id: row.id, kind: "repair", decision: "retire" });
    const d = (await admin.query("select * from nodes where id = $1", [d1])).rows[0];
    expect(d.invalidated_at).not.toBeNull();
    expect(d.superseded_by).toBeNull();
    expect(d.metadata).toMatchObject({ retired: true, retired_reason: `repair of ${u}`, repair_noticing_id: row.id });
    expect(new Date(d.metadata.retired_at).getTime()).toBe(d.invalidated_at.getTime());
    expect(await snap([u, r, d2])).toEqual(untouched);
    expectErr(await N({ operation: "accept", noticing_id: row.id, decision: "retire" }), "conflict");

    // the retired dependant is itself an upstream for the next run
    const e = await mkNode("hangs from the retired belief");
    await mkEdge(e, d1, "supports");
    await repairPass();
    expect((await repairs(`sources @> array['${e}'::uuid]`))[0]?.payload).toMatchObject({ upstream_id: d1, upstream_state: "retired", replacement_id: null });
  });
});

describe("deciding: identity and vow dependants", () => {
  it("rethink and retire are refused with the identity message and leave everything pending; keep is allowed", async () => {
    const u = await mkNode("an old premise");
    const core = (await A("mind_identity", { operation: "affirm", section: "core", content: "I rely on the premise" })).receipt.projection.node_id as string;
    const vow = await mkNode("I vow to keep to the premise", "vow");
    await mkEdge(core, u, "derived_from");
    await mkEdge(vow, u, "derived_from");
    await rethink(u);
    await repairPass();
    const rows = await repairs();
    expect(rows.map((x) => x.payload.dependant_type).sort()).toEqual(["identity", "vow"]);
    const before = { ...(await memorySnap()), events: await countOf("events") };
    for (const row of rows) {
      for (const input of [{ decision: "rethink", content: "new words" }, { decision: "retire" }]) {
        const r = await N({ operation: "accept", noticing_id: row.id, ...input });
        expectErr(r, "conflict");
        expect(r.error.message).toContain(IDENTITY_MSG);
      }
    }
    expect({ ...(await memorySnap()), events: await countOf("events") }).toEqual(before);
    expect(await repairs("status = 'pending'")).toHaveLength(2);
    for (const row of rows) expect((await N({ operation: "accept", noticing_id: row.id, decision: "keep" })).ok).toBe(true);
    expect((await q("select metadata->'repair_reviewed' r from nodes where id = $1", [core]))[0].r).toHaveLength(1);
    expect((await q("select invalidated_at from nodes where id = any($1::uuid[])", [[core, vow]])).every((n) => n.invalidated_at === null)).toBe(true);
  });
});

describe("the verb", () => {
  it("decision is required for a repair and refused for any other kind; only the mind may decide", async () => {
    const { d1 } = await twoDependants();
    await repairPass();
    const id = (await repairs()).find((x) => x.payload.dependant_id === d1)!.id;
    expectErr(await N({ operation: "accept", noticing_id: id }), "invalid_input", "decision");
    expectErr(await N({ operation: "accept", noticing_id: id, decision: "maybe" }), "invalid_input", "decision");
    for (const caller of [betaWrite, betaRead, beta]) {
      const r = await N({ operation: "accept", noticing_id: id, decision: "keep" }, caller);
      expectErr(r, "forbidden");
      expect(r.error.message).toBe("memory is authored by the mind");
    }
    expect((await admin.query("select status from noticings where id = $1", [id])).rows[0].status).toBe("pending");
    // a link: decision refused, with nothing written
    await setState("propose");
    const a = await mkNode("end a");
    const b = await mkNode("end b");
    const ev = (await queryAs(pool, "alpha", "alpha", `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'notice.proposed', '{}', 'alpha', now()) returning id`)).rows[0].id;
    const link = (await queryAs(pool, "alpha", "alpha",
      `insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at)
       values ('alpha', 'link', $1::uuid[], '{"edge_type":"related_to","reason":"x"}', 0.5, 'propose', $2, now() + interval '1 day') returning id`, [[a, b], ev])).rows[0].id;
    const edges0 = await countOf("edges");
    expectErr(await N({ operation: "accept", noticing_id: link, decision: "keep" }), "invalid_input", "decision");
    expectErr(await N({ operation: "accept", noticing_id: link, label: "x" }), "invalid_input", "label");
    expect(await countOf("edges")).toBe(edges0);
    expect((await N({ operation: "accept", noticing_id: link })).ok).toBe(true);
  });

  it("an expired repair cannot be accepted; reject records and removes nothing but the proposal; the daemon expires a repair like any other", async () => {
    const { d1, d2 } = await twoDependants();
    await repairPass();
    const rows = await repairs();
    const rej = rows.find((x) => x.payload.dependant_id === d1)!;
    const before = await memorySnap();
    const r = await N({ operation: "reject", noticing_id: rej.id, reason: "not now" });
    expect(r.ok).toBe(true);
    expect(noticeRejectedPayload.parse((await admin.query("select payload from events where id = $1", [r.receipt.event_id])).rows[0].payload)).toEqual({ noticing_id: rej.id, kind: "repair", reason: "not now" });
    expect(await memorySnap()).toEqual(before);
    expect((await q("select status from noticings where id = $1", [rej.id]))[0].status).toBe("rejected");
    // rejected holds the pair, as for other kinds
    await admin.query("delete from extractor_runs");
    await repairPass();
    expect(await repairs(`sources @> array['${d1}'::uuid]`)).toHaveLength(1);
    // expiry
    const late = new Date(T0.getTime() + 15 * DAY);
    clock = late;
    const other = rows.find((x) => x.payload.dependant_id === d2)!;
    expectErr(await N({ operation: "accept", noticing_id: other.id, decision: "keep" }), "conflict", "noticing_id");
    expect((await daemon([noticeExpire], late))[0]!.passes[0]!.changed).toBe(1);
    expect((await q("select status from noticings where id = $1", [other.id]))[0].status).toBe("expired");
    expect(EXTRACTOR_EVENT_SHAPES["notice.expired"].parse((await admin.query("select payload from events where kind = 'notice.expired'")).rows[0].payload)).toMatchObject({ noticing_kind: "repair", stage: "propose" });
  });

  it("repair.kept and repair.rethought are bookkeeping: left out of orient recent, weather and search", async () => {
    const { d1 } = await twoDependants();
    await repairPass();
    const id = (await repairs()).find((x) => x.payload.dependant_id === d1)!.id;
    await N({ operation: "accept", noticing_id: id, decision: "keep" });
    expect(await countOf("events", "kind = 'repair.kept'")).toBe(1);
    const recent = (await A("mind_orient", { depth: "full" })).receipt.projection.sections.recent.events as any[];
    expect(recent.some((e) => e.kind.startsWith("repair.") || e.kind.startsWith("notice."))).toBe(false);
    expect(recent.some((e) => e.kind === "rethink")).toBe(true);
    const weather = (await A("mind_weather", { lookback_hours: 24 })).receipt.projection;
    expect(JSON.stringify(weather)).not.toContain("repair.");
  });
});

describe("the guards", () => {
  it("noticings.kind accepts repair, still refuses anything else, and stays immutable; extractor_runs accepts the pass", async () => {
    const { d1 } = await twoDependants();
    await repairPass();
    const id = (await repairs())[0]!.id;
    await expect(queryAs(pool, "alpha", "alpha", "update noticings set kind = 'link' where id = $1", [id])).rejects.toThrow(/a proposal is fixed once made/);
    await expect(admin.query("update noticings set kind = 'dream' where id = $1", [id])).rejects.toThrow(/noticings_kind_check|fixed/);
    expect(await countOf("extractor_runs", "pass = 'notice.repair'")).toBe(1);
    await expect(admin.query("insert into extractor_runs (mind_id, pass, started_at, ok) values ('alpha', 'notice.dream', now(), true)")).rejects.toThrow(/extractor_runs_pass_check/);
    void d1;
  });

  it("the insert guard holds: a write grantee cannot plant a repair and the mind's own scope can", async () => {
    const u = await mkNode("u");
    const d = await mkNode("d");
    const ev = (await queryAs(pool, "alpha", "alpha", `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'notice.proposed', '{}', 'alpha', now()) returning id`)).rows[0].id;
    const ins = (bearer: string) => queryAs(pool, "alpha", bearer,
      `insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at) values ('alpha', 'repair', $1::uuid[], '{}', 1, 'propose', $2, now() + interval '1 day')`, [[d, u], ev]);
    await expect(ins("beta")).rejects.toThrow(/own scope/);
    await expect(ins("alpha")).resolves.toBeTruthy();
  });

  it("RLS: another mind never sees or decides a repair; a read grantee sees it in a list but cannot decide it", async () => {
    const { d1 } = await twoDependants();
    await repairPass();
    const id = (await repairs()).find((x) => x.payload.dependant_id === d1)!.id;
    expect(await q("select id from noticings", [], "beta")).toEqual([]);
    expectErr(await N({ operation: "accept", noticing_id: id, decision: "keep" }, beta, "beta"), "not_found", "noticing_id");
    expect((await N({ operation: "list" }, betaRead)).receipt.projection.noticings).toHaveLength(2);
    expect((await N({ operation: "list" }, beta, "beta")).receipt.projection.noticings).toEqual([]);
    expect((await admin.query("select status from noticings where id = $1", [id])).rows[0].status).toBe("pending");
    // beta's own daemon pass proposes nothing about alpha's nodes
    const out = (await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => clock }, { trigger: "manual", minds: ["beta"], passes: [noticeRepair] }))[0]!.passes[0]!;
    expect(out.changed).toBe(0);
  });

  it("the runtime guard holds with the pass registered: nodes and edges are identical after it, and only notice.proposed is appended", async () => {
    await twoDependants();
    const before = await memorySnap();
    const maxSeq = (await admin.query("select max(seq)::bigint s from events")).rows[0].s;
    const reports = await daemon();
    expect(reports[0]!.ok).toBe(true);
    expect(reports[0]!.passes.find((p) => p.pass === "notice.repair")).toMatchObject({ ok: true, changed: 2 });
    expect(await memorySnap()).toEqual(before);
    const kinds = (await admin.query("select distinct kind from events where seq > $1", [maxSeq])).rows.map((r) => r.kind);
    expect(kinds).toContain("notice.proposed");
    expect(kinds.every((k) => k === "notice.proposed" || k.startsWith("daemon."))).toBe(true);
  });
});

describe("report and portability", () => {
  it("extractor report counts repairs apart from the extractor's proposals, with decision rates", async () => {
    const u = await mkNode("up");
    const ds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = await mkNode(`dep ${i}`, "belief");
      await mkEdge(d, u, "derived_from");
      ds.push(d);
    }
    await rethink(u);
    await repairPass();
    const rows = await repairs();
    const by = (d: string) => rows.find((x) => x.payload.dependant_id === d)!.id;
    expect((await N({ operation: "accept", noticing_id: by(ds[0]!), decision: "keep" })).ok).toBe(true);
    expect((await N({ operation: "accept", noticing_id: by(ds[1]!), decision: "keep" })).ok).toBe(true);
    expect((await N({ operation: "accept", noticing_id: by(ds[2]!), decision: "rethink", content: "again" })).ok).toBe(true);
    expect((await N({ operation: "reject", noticing_id: by(ds[3]!) })).ok).toBe(true);
    const rep = await extractorReport(admin, "alpha", () => clock);
    expect(rep.repairs).toMatchObject({ total: 5, last_30_days: 5, decided: 4, decisions: { keep: 2, rethink: 1, retire: 0 } });
    expect(rep.repairs.by_status).toEqual({ accepted: 3, rejected: 1, pending: 1 });
    expect(rep.repairs.rates).toEqual({ keep: 0.5, rethink: 0.25, retire: 0, rejected: 0.25, expired: 0 });
    // not counted among the extractor's own proposals, its precision or its acceptance by kind
    expect(rep.all_time.total).toBe(0);
    expect(rep.precision).toMatchObject({ value: null, decided: 0 });
    expect(rep.acceptance_by_kind).toEqual({});
    expect(rep.last_runs["notice.repair"]).toMatchObject({ ok: true });
    const text = formatExtractorReport(rep);
    expect(text).toMatch(/repairs \(counted apart\): 5 total .*keep 2 \(50\.0%\), rethink 1 \(25\.0%\), retire 0 \(0\.0%\)/);
    expect(text).toMatch(/last notice\.repair: .*ok .*proposed/);
  });

  it("the extractor's training ignores repairs", async () => {
    // thirty decided repairs would otherwise be enough to refit the scorer
    const u = await mkNode("up");
    for (let i = 0; i < 12; i++) {
      const d = await mkNode(`dep ${i}`);
      await mkEdge(d, u, "derived_from");
    }
    await rethink(u);
    await repairPass();
    for (const row of await repairs()) await N({ operation: "reject", noticing_id: row.id });
    await setExtractorState(admin, "alpha", "enable", { stage: "propose", schedule: "00:00" });
    const reports = await daemon();
    const train = reports[0]!.passes.find((p) => p.pass === "notice.train")!;
    expect(train.ok).toBe(true);
    expect(train.notes?.[0] ?? "").toMatch(/not trained/);
  });

  describe("export, import, purge", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-"));
    let seq = 0;
    const dbs: string[] = [];
    const extra: Pool[] = [];
    const urlFor = (db: string, app = false): string => {
      if (app) return testAppUrl(db);
      const url = new URL(testDatabaseUrl());
      url.pathname = `/${db}`;
      return url.toString();
    };
    afterAll(async () => {
      for (const p of extra.splice(0)) await closePool(p);
      if (admin) for (const d of dbs) await admin.query(`drop database if exists ${d} with (force)`);
    });

    it("repairs travel as noticings: a kept one stays decided, a pending one arrives expired, the run history comes along, and purge removes them", async () => {
      const { d1 } = await twoDependants();
      await repairPass();
      const kept = (await repairs()).find((x) => x.payload.dependant_id === d1)!;
      expect((await N({ operation: "accept", noticing_id: kept.id, decision: "keep" })).ok).toBe(true);
      const f = join(dir, `r${seq++}.json`);
      const exp = await exportMind(pool, "alpha", f);
      expect(exp.counts).toMatchObject({ noticings: 2, extractor_runs: 1 });

      const name = `repair_import_${process.pid}_${seq++}`;
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.query(`create database ${name}`);
      dbs.push(name);
      await runMigrations(urlFor(name));
      const a2 = createPool(urlFor(name));
      const p2 = createPool(urlFor(name, true));
      extra.push(a2, p2);
      await upsertMinds(a2, [{ mind_id: "alpha", key: "alpha-key".padEnd(32, "-") }]);
      const rep = await importMind(p2, f, "alpha");
      expect(rep.tables.noticings).toMatchObject({ inserted: 2 });
      expect(rep.tables.extractor_runs).toMatchObject({ inserted: 1 });
      const rows = (await a2.query("select id, kind, status from noticings order by status")).rows;
      expect(rows.map((r) => [r.kind, r.status])).toEqual([["repair", "accepted"], ["repair", "expired"]]);
      expect(rows.find((r) => r.status === "accepted")!.id).toBe(kept.id);
      expect((await a2.query("select count(*)::int n from events where kind = 'repair.kept'")).rows[0].n).toBe(1);
      // an imported run does not hold the window: a mind brought in from another life looks at its last 30 days afresh
      expect((await a2.query("select notes->>'imported' i from extractor_runs")).rows).toEqual([{ i: "true" }]);
      // and nothing is shown to the mind
      const shown = await runVerb({ pool: p2, registry, now: () => clock }, alpha, "mind_notice", { mind_id: "alpha", operation: "list" });
      expect((shown as any).receipt.projection.noticings).toEqual([]);

      const r = await purgeMind(admin, "alpha", { confirm: "alpha" });
      expect(r.counts).toMatchObject({ noticings: 2, extractor_runs: 1 });
      expect(await countOf("noticings", "mind_id = 'alpha'")).toBe(0);
    });
  });
});
