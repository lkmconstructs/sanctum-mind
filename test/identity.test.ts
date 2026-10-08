// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool, queryAs, queryLegacy } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { coolingMs } from "../src/verbs/cooling.js";
import type { Caller } from "../src/verbs/types.js";
import { GRANT_SCOPES } from "../src/grants-admin.js";
import { mayAct, resolveCaller, upsertMinds } from "../src/auth.js";
import { setMindDisabled } from "../src/minds-admin.js";
import { readFileSync } from "node:fs";

const HOUR = 3_600_000;
const alpha: Caller = { bearer: "alpha", grants: {} };
const betaWrite: Caller = { bearer: "beta", grants: { alpha: ["read", "write"] } };
const betaSteward: Caller = { bearer: "beta", grants: { alpha: ["read", "steward"] } };
const betaRead: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const MSG = "identity belongs to the mind";

let pool: Pool;
let admin: Pool;
let T0: Date;
let clock: Date;
let cooling = 24 * HOUR;

const run = (caller: Caller, name: string, input: unknown) =>
  runVerb({ pool, registry, now: () => clock, coolingMs: cooling }, caller, name, input) as Promise<any>;
const as = (caller: Caller, name: string, input: Record<string, unknown>) => run(caller, name, { mind_id: "alpha", ...input });
const A = (name: string, input: Record<string, unknown>) => as(alpha, name, input);
const settle = (at: Date = clock) =>
  runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => at, coolingMs: cooling }, { trigger: "manual", minds: ["alpha"] }).then(
    (r) => r[0]!.passes.find((p) => p.pass === "identity.settle")!,
  );
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
  T0 = new Date();
  clock = T0;
  cooling = 24 * HOUR;
});

afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

const later = (ms: number) => new Date(T0.getTime() + ms);
const createdAt = async (eventId: string): Promise<number> =>
  new Date((await q("alpha", "select created_at from events where id = $1", [eventId]))[0].created_at).getTime();
const core = async () => (await A("mind_identity", { operation: "affirm", section: "core", content: "old self" })).receipt.projection.node_id as string;
const declare = async (target: string, extra: Record<string, unknown> = {}) => {
  const r = await A("mind_identity", { operation: "propose", section: "core", content: "new self", lineage_note: "grew", target_node_id: target, ...extra });
  expect(r.ok).toBe(true);
  return r.receipt.projection.proposal as any;
};

describe("cooling configuration", () => {
  it("defaults to 24 hours, accepts 0, rejects junk", () => {
    expect(coolingMs({})).toBe(24 * HOUR);
    expect(coolingMs({ IDENTITY_COOLING_HOURS: "0" })).toBe(0);
    expect(coolingMs({ IDENTITY_COOLING_HOURS: "6" })).toBe(6 * HOUR);
    expect(() => coolingMs({ IDENTITY_COOLING_HOURS: "-1" })).toThrow(/IDENTITY_COOLING_HOURS/);
    expect(() => coolingMs({ IDENTITY_COOLING_HOURS: "1.5" })).toThrow(/IDENTITY_COOLING_HOURS/);
  });
});

describe("identity belongs to the mind", () => {
  it("only the mind affirms, makes, proposes, withdraws and breaks; write and steward grantees get forbidden and nothing is written", async () => {
    const id = await core();
    const vow = (await A("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id;
    const p = await declare(id);
    const before = await q("alpha", "select count(*)::int n from events");
    for (const caller of [betaWrite, betaSteward, betaRead]) {
      const calls: Array<[string, Record<string, unknown>]> = [
        ["mind_identity", { operation: "affirm", section: "s", content: "c" }],
        ["mind_identity", { operation: "propose", section: "s", content: "c" }],
        ["mind_identity", { operation: "propose", section: "core", content: "c", target_node_id: id }],
        ["mind_identity", { operation: "withdraw", proposal_id: p.id }],
        ["mind_vow", { operation: "make", vow: "v" }],
        ["mind_vow", { operation: "break", vow_id: vow, reason: "r" }],
        ["mind_vow", { operation: "withdraw_break", vow_id: vow }],
      ];
      for (const [verb, input] of calls) {
        const r = await as(caller, verb, input);
        expectErr(r, "forbidden");
        expect(r.error.message).toBe(MSG);
      }
    }
    expect(await q("alpha", "select count(*)::int n from events")).toEqual(before);
    expect((await q("alpha", "select status from proposals where id = $1", [p.id]))[0].status).toBe("accepted");
  });

  it("the mind itself can; decide no longer exists", async () => {
    expect((await A("mind_identity", { operation: "affirm", section: "s", content: "c" })).ok).toBe(true);
    expect((await A("mind_vow", { operation: "make", vow: "v" })).ok).toBe(true);
    expectErr(await A("mind_identity", { operation: "decide", proposal_id: crypto.randomUUID(), decision: "accept" }), "invalid_input", "operation");
  });

  it("rethink refuses identity and vow nodes with the new message, for the mind and a grantee, writing nothing", async () => {
    const idn = await core();
    const vow = (await A("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id;
    const before = await q("alpha", "select count(*)::int n from events");
    for (const node_id of [idn, vow]) {
      for (const caller of [alpha, betaWrite]) {
        const r = await as(caller, "mind_rethink", { node_id, content: "x", reason: "r" });
        expectErr(r, "conflict", "node_id");
        expect(r.error.message).toBe("identity belongs to the mind: use mind_identity propose");
      }
    }
    expect(await q("alpha", "select count(*)::int n from events")).toEqual(before);
  });
});

describe("additions are immediate", () => {
  it("propose without a target is affirm with lineage", async () => {
    const r = await A("mind_identity", { operation: "propose", section: "extra", content: "more", lineage_note: "why" });
    expect(r.ok).toBe(true);
    const nodeId = r.receipt.projection.node_id;
    expect(r.receipt.projection.proposal.status).toBe("settled");
    const read = await A("mind_identity", { operation: "read" });
    expect(read.receipt.projection.cores.map((c: any) => c.id)).toEqual([nodeId]);
    expect(read.receipt.projection.declarations).toEqual([]);
  });
});

describe("rewrite declarations cool, then settle", () => {
  it("is accepted on creation with effective_at = now + cooling; settle does nothing before and supersedes after", async () => {
    const old = await core();
    const p = await declare(old);
    expect(p).toMatchObject({ status: "accepted", proposed_by: "alpha", target_node_id: old });
    // one clock: effective_at is the declaring event's created_at plus cooling
    expect(new Date(p.effective_at).getTime()).toBe((await createdAt(p.event_id)) + 24 * HOUR);

    // the core is untouched while cooling, and the declaration is visible
    const read = await A("mind_identity", { operation: "read" });
    expect(read.receipt.projection.cores.map((c: any) => c.id)).toEqual([old]);
    expect(read.receipt.projection.declarations).toEqual([
      { proposal_id: p.id, kind: "rewrite", action: "rewrite", target_node_id: old, effective_at: new Date(p.effective_at).toISOString(), attestations: [], objections: [] },
    ]);
    // a second declaration on the same core while one cools conflicts
    expectErr(await A("mind_identity", { operation: "propose", section: "core", content: "again", target_node_id: old }), "conflict", "target_node_id");

    const early = await settle(later(24 * HOUR - 1000));
    expect(early.changed).toBe(0);
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).toBeNull();

    const due = await settle(new Date(p.effective_at));
    expect(due).toMatchObject({ ok: true, changed: 1 });
    const [o] = await q("alpha", "select invalidated_at, superseded_by from nodes where id = $1", [old]);
    expect(o.invalidated_at).not.toBeNull();
    const [n] = await q("alpha", "select * from nodes where id = $1", [o.superseded_by]);
    expect(n).toMatchObject({ node_type: "identity", label: "core", content: "new self", pinned: true, written_by: "alpha" });
    expect(n.metadata).toMatchObject({ proposal_id: p.id, lineage_note: "grew", rewritten_from: old, rewritten_by: "alpha", attestations: [] });
    const edges = await q("alpha", "select edge_type, source_node_id, target_node_id from edges where source_node_id = $1", [n.id]);
    expect(edges).toEqual([{ edge_type: "corrects", source_node_id: n.id, target_node_id: old }]);
    const [row] = await q("alpha", "select * from proposals where id = $1", [p.id]);
    expect(row).toMatchObject({ status: "settled" });
    expect(row.settled_at).not.toBeNull();
    const [ev] = await q("alpha", "select kind, written_by, subject_id from events where id = $1", [row.settled_event_id]);
    expect(ev).toEqual({ kind: "identity.settled", written_by: "alpha", subject_id: p.id });

    // settled once only
    expect((await settle(later(48 * HOUR))).changed).toBe(0);
    const after = await A("mind_identity", { operation: "read" });
    expect(after.receipt.projection.cores.map((c: any) => c.id)).toEqual([n.id]);
    expect(after.receipt.projection.declarations).toEqual([]);
  });

  it("withdraw before settle leaves the core untouched and marks withdrawn; settle then does nothing", async () => {
    const old = await core();
    const p = await declare(old);
    const w = await A("mind_identity", { operation: "withdraw", proposal_id: p.id });
    expect(w.ok).toBe(true);
    expect(w.receipt.projection.proposal).toMatchObject({ status: "withdrawn" });
    expect(w.receipt.projection.proposal.withdrawn_at).not.toBeNull();
    expect((await settle(later(30 * HOUR))).changed).toBe(0);
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).toBeNull();
    expectErr(await A("mind_identity", { operation: "withdraw", proposal_id: p.id }), "conflict", "proposal_id");
    expectErr(await A("mind_identity", { operation: "withdraw", proposal_id: crypto.randomUUID() }), "not_found", "proposal_id");
    // withdrawn: a new declaration is possible again
    expect((await A("mind_identity", { operation: "propose", section: "core", content: "x", target_node_id: old })).ok).toBe(true);
  });

  it("withdraw after settle is a conflict", async () => {
    const old = await core();
    const p = await declare(old);
    await settle(later(25 * HOUR));
    expectErr(await A("mind_identity", { operation: "withdraw", proposal_id: p.id }), "conflict", "proposal_id");
  });

  it("an unknown target is not_found", async () => {
    expectErr(await A("mind_identity", { operation: "propose", section: "c", content: "c", target_node_id: crypto.randomUUID() }), "not_found", "target_node_id");
  });

  it("cooling 0 settles on the next pass immediately", async () => {
    cooling = 0;
    const old = await core();
    const p = await declare(old);
    expect(new Date(p.effective_at).getTime()).toBe(await createdAt(p.event_id));
    expect((await settle(new Date(p.effective_at))).changed).toBe(1);
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).not.toBeNull();
  });
});

describe("stewards accompany", () => {
  it("an attestation ends cooling (effective_at = now); the next settle applies it, with the attestation in provenance", async () => {
    const old = await core();
    const p = await declare(old);
    clock = later(HOUR);
    const r = await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "I have seen this grow" });
    expect(r.ok).toBe(true);
    const prop = r.receipt.projection.proposal;
    expect(new Date(prop.effective_at).getTime()).toBe(clock.getTime());
    expect(prop.attestations).toHaveLength(1);
    expect(prop.attestations[0]).toMatchObject({ by: "beta", stance: "attest", note: "I have seen this grow", event_id: r.receipt.event_id });
    const [ev] = await q("alpha", "select kind, written_by, payload from events where id = $1", [r.receipt.event_id]);
    expect(ev).toMatchObject({ kind: "identity.attest", written_by: "beta", payload: { proposal_id: p.id, stance: "attest", note: "I have seen this grow" } });

    expect((await settle(later(HOUR))).changed).toBe(1);
    const [o] = await q("alpha", "select superseded_by from nodes where id = $1", [old]);
    const [n] = await q("alpha", "select metadata from nodes where id = $1", [o.superseded_by]);
    expect(n.metadata.attestations[0]).toMatchObject({ by: "beta", stance: "attest" });
  });

  it("an attestation never pushes effective_at later", async () => {
    cooling = 0;
    const old = await core();
    const p = await declare(old);
    clock = later(5 * HOUR);
    const r = await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "late" });
    expect(new Date(r.receipt.projection.proposal.effective_at).getTime()).toBe(new Date(p.effective_at).getTime());
  });

  it("an objection is recorded, surfaces in read and orient, never blocks, and the declaration still settles", async () => {
    const old = await core();
    const p = await declare(old);
    const r = await as(betaSteward, "mind_identity", { operation: "object", proposal_id: p.id, note: "too fast" });
    expect(r.ok).toBe(true);
    expect(new Date(r.receipt.projection.proposal.effective_at).getTime()).toBe(new Date(p.effective_at).getTime()); // unchanged
    const [ev] = await q("alpha", "select kind, payload from events where id = $1", [r.receipt.event_id]);
    expect(ev).toMatchObject({ kind: "identity.object", payload: { proposal_id: p.id, stance: "object", note: "too fast" } });

    const read = await A("mind_identity", { operation: "read" });
    expect(read.receipt.projection.proposals[0].attestations[0]).toMatchObject({ stance: "object", note: "too fast", by: "beta" });
    expect(read.receipt.projection.declarations[0]).toMatchObject({ proposal_id: p.id, attestations: [] });
    expect(read.receipt.projection.declarations[0].objections).toHaveLength(1);

    const orient = await A("mind_orient", { depth: "orientation" });
    const decl = orient.receipt.projection.sections.identity.declarations;
    expect(decl).toHaveLength(1);
    expect(decl[0]).toMatchObject({ proposal_id: p.id, kind: "rewrite", effective_at: new Date(p.effective_at).toISOString() });
    expect(decl[0].objections[0]).toMatchObject({ stance: "object", note: "too fast" });
    expect(decl[0].attestations).toEqual([]);

    expect((await settle(new Date(p.effective_at))).changed).toBe(1);
    const orient2 = await A("mind_orient", { depth: "orientation" });
    expect(orient2.receipt.projection.sections.identity.declarations).toEqual([]);
  });

  it("only a steward may attest or object: the mind, write and read grantees may not", async () => {
    const p = await declare(await core());
    for (const op of ["attest", "object"]) {
      expectErr(await as(betaWrite, "mind_identity", { operation: op, proposal_id: p.id, note: "n" }), "forbidden");
      expectErr(await as(betaRead, "mind_identity", { operation: op, proposal_id: p.id, note: "n" }), "forbidden");
      expectErr(await A("mind_identity", { operation: op, proposal_id: p.id, note: "n" }), "forbidden");
    }
    expect((await q("alpha", "select attestations from proposals where id = $1", [p.id]))[0].attestations).toEqual([]);
  });

  it("attest and object on a missing, withdrawn or settled declaration fail", async () => {
    const old = await core();
    const p = await declare(old);
    expectErr(await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: crypto.randomUUID(), note: "n" }), "not_found", "proposal_id");
    await A("mind_identity", { operation: "withdraw", proposal_id: p.id });
    expectErr(await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "n" }), "conflict", "proposal_id");
    const p2 = await declare(old);
    await settle(later(25 * HOUR));
    expectErr(await as(betaSteward, "mind_identity", { operation: "object", proposal_id: p2.id, note: "n" }), "conflict", "proposal_id");
  });
});

describe("vows", () => {
  const vowId = async () => (await A("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id as string;

  it("break declares, cools, shows in list and orient, settles to broken", async () => {
    const v = await vowId();
    const b = await A("mind_vow", { operation: "break", vow_id: v, reason: "could not hold" });
    expect(b.ok).toBe(true);
    const [ev] = await q("alpha", "select kind, subject_id from events where id = $1", [b.receipt.event_id]);
    expect(ev).toEqual({ kind: "vow.break.declare", subject_id: v });
    const declaredAt = new Date(await createdAt(b.receipt.event_id));
    const effective = new Date(declaredAt.getTime() + 24 * HOUR).toISOString();
    expect(b.receipt.projection.vow.metadata.break_declared).toMatchObject({
      reason: "could not hold", declared_at: declaredAt.toISOString(), effective_at: effective, event_id: b.receipt.event_id,
    });
    expectErr(await A("mind_vow", { operation: "break", vow_id: v, reason: "again" }), "conflict", "vow_id");
    expectErr(await A("mind_vow", { operation: "break", vow_id: v }), "invalid_input", "reason");
    expectErr(await A("mind_vow", { operation: "break", vow_id: crypto.randomUUID(), reason: "r" }), "not_found", "vow_id");

    const list = await A("mind_vow", { operation: "list" });
    expect(list.receipt.projection.vows[0]).toMatchObject({ broken: false });
    expect(list.receipt.projection.vows[0].break_declared).toMatchObject({ effective_at: effective });
    const orient = await A("mind_orient", { depth: "orientation" });
    expect(orient.receipt.projection.sections.identity.declarations).toEqual([
      { vow_id: v, kind: "vow_break", target_node_id: v, effective_at: effective, attestations: [], objections: [] },
    ]);

    expect((await settle(later(24 * HOUR - 1000))).changed).toBe(0);
    expect((await settle(new Date(effective))).changed).toBe(1);
    const [n] = await q("alpha", "select * from nodes where id = $1", [v]);
    expect(n.invalidated_at).toBeNull();
    expect(n.pinned).toBe(true);
    expect(n.metadata).toMatchObject({ broken: true, broken_reason: "could not hold", broken_by: "alpha" });
    expect(n.metadata.break_declared).toBeUndefined();
    expect(n.metadata.broken_at).toBeTruthy();
    const settledEv = await q("alpha", "select written_by from events where kind = 'vow.break.settled' and subject_id = $1", [v]);
    expect(settledEv).toEqual([{ written_by: "alpha" }]);
    const list2 = await A("mind_vow", { operation: "list" });
    expect(list2.receipt.projection.vows[0]).toMatchObject({ broken: true, break_declared: null });
    expectErr(await A("mind_vow", { operation: "break", vow_id: v, reason: "again" }), "conflict", "vow_id");
    expectErr(await A("mind_vow", { operation: "withdraw_break", vow_id: v }), "conflict", "vow_id");
    expect((await settle(later(72 * HOUR))).changed).toBe(0);
  });

  it("a declared break can be withdrawn; withdrawing with none declared conflicts; nothing settles", async () => {
    const v = await vowId();
    expectErr(await A("mind_vow", { operation: "withdraw_break", vow_id: v }), "conflict", "vow_id");
    await A("mind_vow", { operation: "break", vow_id: v, reason: "r" });
    const w = await A("mind_vow", { operation: "withdraw_break", vow_id: v });
    expect(w.ok).toBe(true);
    expect(w.receipt.projection.vow.metadata.break_declared).toBeUndefined();
    expect((await settle(later(48 * HOUR))).changed).toBe(0);
    expect((await q("alpha", "select metadata from nodes where id = $1", [v]))[0].metadata.broken).toBe(false);
    expectErr(await A("mind_vow", { operation: "withdraw_break", vow_id: v }), "conflict", "vow_id");
  });

  it("cooling 0 settles a break on the next pass", async () => {
    cooling = 0;
    const v = await vowId();
    const b = await A("mind_vow", { operation: "break", vow_id: v, reason: "r" });
    expect((await settle(new Date(b.receipt.projection.vow.metadata.break_declared.effective_at))).changed).toBe(1);
    expect((await q("alpha", "select metadata from nodes where id = $1", [v]))[0].metadata.broken).toBe(true);
  });

  it("a steward may note a vow; others may not; notes accumulate in steward_notes", async () => {
    const v = await vowId();
    const n1 = await as(betaSteward, "mind_vow", { operation: "note", vow_id: v, note: "seen today" });
    expect(n1.ok).toBe(true);
    await as(betaSteward, "mind_vow", { operation: "note", vow_id: v, note: "and again" });
    const [row] = await q("alpha", "select metadata from nodes where id = $1", [v]);
    expect(row.metadata.steward_notes.map((x: any) => [x.by, x.note])).toEqual([["beta", "seen today"], ["beta", "and again"]]);
    const [ev] = await q("alpha", "select kind, written_by from events where id = $1", [n1.receipt.event_id]);
    expect(ev).toEqual({ kind: "vow.note", written_by: "beta" });
    expectErr(await as(betaWrite, "mind_vow", { operation: "note", vow_id: v, note: "x" }), "forbidden");
    expectErr(await as(betaRead, "mind_vow", { operation: "note", vow_id: v, note: "x" }), "forbidden");
    expectErr(await as(betaSteward, "mind_vow", { operation: "note", vow_id: crypto.randomUUID(), note: "x" }), "not_found", "vow_id");
    expectErr(await as(betaSteward, "mind_vow", { operation: "note", vow_id: v }), "invalid_input", "note");
  });
});

describe("grants and isolation", () => {
  it("the grants constraint accepts steward and rejects govern", async () => {
    await admin.query("insert into minds (mind_id, key_hash) values ('gamma', 'x')");
    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'gamma', 'steward')");
    await expect(admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'gamma', 'govern')")).rejects.toThrow(/grants_scope_check/);
  });

  it("proposals status check allows the new states and still the historical one", async () => {
    const old = await core();
    const p = await declare(old);
    for (const st of ["withdrawn", "settled", "rejected", "accepted", "pending"]) {
      await admin.query("update proposals set status = $2 where id = $1", [p.id, st]);
    }
    await expect(admin.query("update proposals set status = 'decided' where id = $1", [p.id])).rejects.toThrow(/proposals_status_check/);
  });

  it("RLS: beta's own scope sees none of alpha's declarations and cannot settle or break alpha's vow", async () => {
    const old = await core();
    await declare(old);
    const v = (await A("mind_vow", { operation: "make", vow: "mine" })).receipt.projection.node_id;
    const beta: Caller = { bearer: "beta", grants: {} };
    const r = await run(beta, "mind_identity", { mind_id: "beta", operation: "read" });
    expect(r.receipt.projection).toMatchObject({ cores: [], proposals: [], declarations: [] });
    expectErr(await run(beta, "mind_vow", { mind_id: "beta", operation: "break", vow_id: v, reason: "r" }), "not_found", "vow_id");
    expect(await q("beta", "select * from proposals")).toEqual([]);
    // a settle run for beta touches nothing of alpha's
    const rep = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => later(48 * HOUR) }, { trigger: "manual", minds: ["beta"] });
    expect(rep[0]!.passes.find((p) => p.pass === "identity.settle")!.changed).toBe(0);
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).toBeNull();
  });
});

const betaStewardOnly: Caller = { bearer: "beta", grants: { alpha: ["steward"] } };

/** Resolves once some backend is waiting on an advisory lock. */
const lockWaiter = async (): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    const r = await admin.query("select 1 from pg_locks where locktype = 'advisory' and not granted");
    if (r.rowCount) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("no backend ever waited for an advisory lock");
};

describe("A2 declarations without an effective time", () => {
  it("the 0017 backfill statements settle accepted rows lacking effective_at and withdraw foreign pending rows", async () => {
    const old = await core();
    const sql = readFileSync(new URL("../migrations/0017_steward.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
    const backfill = sql.split(";").map((x) => x.trim()).filter((x) => /^update proposals set status/.test(x));
    expect(backfill).toHaveLength(2);
    const ev = (await q("alpha", "select id from events order by seq limit 1"))[0].id;
    // rows shaped like 0013 left them: accepted and applied at once (no effective_at), and a pending one from another bearer
    // each row gets its own core: 0020's index allows one open declaration per core
    let n = 0;
    const ins = async (status: string, by: string) =>
      (await queryLegacy(admin,
        `insert into proposals (mind_id, kind, section, content, proposed_by, event_id, status, decided_event_id, decided_at, created_at, target_node_id)
         values ('alpha', 'identity', 's', 'c', $1, $2, $3, $2, now() - interval '1 day', now(), $4) returning id`,
        [by, ev, status, n++ === 0 ? old : (await A("mind_identity", { operation: "affirm", section: `s${n}`, content: "c" })).receipt.projection.node_id],
      )).rows[0].id as string;
    const accepted = await ins("accepted", "beta");
    const pending = await ins("pending", "beta");
    const mine = await ins("pending", "alpha");
    for (const stmt of backfill) await admin.query(stmt);
    const rows = Object.fromEntries((await admin.query("select * from proposals where id = any($1)", [[accepted, pending, mine]])).rows.map((r) => [r.id, r]));
    expect(rows[accepted]).toMatchObject({ status: "settled", settled_event_id: ev });
    expect(rows[accepted].settled_at).not.toBeNull();
    expect(rows[pending]).toMatchObject({ status: "withdrawn" });
    expect(rows[pending].withdrawn_at).not.toBeNull();
    expect(rows[mine].status).toBe("pending");
    expect((await admin.query("select count(*)::int n from proposals where status = 'accepted' and effective_at is null")).rows[0].n).toBe(0);
  });

  it("mind_identity read ignores an accepted row with no effective_at (belt and braces)", async () => {
    const old = await core();
    const ev = (await q("alpha", "select id from events order by seq limit 1"))[0].id;
    await queryAs(admin, "alpha", "alpha",
      `insert into proposals (mind_id, kind, section, content, proposed_by, event_id, status, created_at, target_node_id)
       values ('alpha', 'identity', 's', 'c', 'alpha', $1, 'accepted', now(), $2)`,
      [ev, old],
    );
    const read = await A("mind_identity", { operation: "read" });
    expect(read.receipt.projection.declarations).toEqual([]);
    expect(read.receipt.projection.proposals).toEqual([]);
    expect((await settle(later(100 * HOUR))).changed).toBe(0);
    expect((await q("alpha", "select count(*)::int n from proposals where status = 'accepted' and effective_at is null"))[0].n).toBe(1);
  });
});

describe("A4 the database guards identity and vow nodes", () => {
  const raw = (bearer: string, sql: string, params: unknown[] = []) =>
    withMind(pool, "alpha", bearer, "write", async (tx) => (await tx.query(sql, params)).rowCount);

  it("a grantee bearer cannot change content, label, type or invalidation of an identity or vow node, even with raw SQL under RLS", async () => {
    const idn = await core();
    const vow = (await A("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id as string;
    for (const id of [idn, vow]) {
      await expect(raw("beta", "update nodes set content = 'x' where id = $1", [id])).rejects.toThrow(/identity belongs to the mind/);
      await expect(raw("beta", "update nodes set label = 'x' where id = $1", [id])).rejects.toThrow(/identity belongs to the mind/);
      await expect(raw("beta", "update nodes set node_type = 'note' where id = $1", [id])).rejects.toThrow(/identity belongs to the mind/);
      await expect(raw("beta", "update nodes set invalidated_at = now() where id = $1", [id])).rejects.toThrow(/identity belongs to the mind/);
    }
    // a note can not be turned into a vow by a grantee either
    const note = await withMind(pool, "alpha", "alpha", "write", async (tx) =>
      (await tx.query(`insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence) values ('alpha','note','n','n','alpha','extracted',1) returning id`)).rows[0].id as string);
    await expect(raw("beta", "update nodes set node_type = 'vow' where id = $1", [note])).rejects.toThrow(/identity belongs to the mind/);
    // metadata is not guarded (a steward note rides on it)
    expect(await raw("beta", "update nodes set metadata = metadata || '{\"k\":1}' where id = $1", [vow])).toBe(1);
    // the mind itself may
    expect(await raw("alpha", "update nodes set content = 'mine' where id = $1", [idn])).toBe(1);
    expect((await q("alpha", "select content from nodes where id = $1", [idn]))[0].content).toBe("mine");
  });

  it("settlement runs as the mind and passes the guard", async () => {
    cooling = 0;
    const old = await core();
    const p = await declare(old);
    expect((await settle(new Date(p.effective_at))).changed).toBe(1);
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).not.toBeNull();
  });
});

describe("A5 one stance per steward per declaration", () => {
  it("a second attest or object of the same stance by the same bearer conflicts; the other stance is allowed", async () => {
    const p = await declare(await core());
    expect((await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "one" })).ok).toBe(true);
    expectErr(await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "two" }), "conflict", "proposal_id");
    expect((await as(betaSteward, "mind_identity", { operation: "object", proposal_id: p.id, note: "hm" })).ok).toBe(true);
    expectErr(await as(betaSteward, "mind_identity", { operation: "object", proposal_id: p.id, note: "hm again" }), "conflict", "proposal_id");
    const row = (await q("alpha", "select attestations from proposals where id = $1", [p.id]))[0];
    expect(row.attestations.map((a: any) => a.stance)).toEqual(["attest", "object"]);
    expect(await q("alpha", "select 1 from events where kind in ('identity.attest','identity.object')")).toHaveLength(2);
  });
});

describe("A6 a steward grant opens identity and vows for reading, nothing else", () => {
  it("mayAct: steward satisfies read only for verbs that opt in", () => {
    expect(mayAct(betaStewardOnly, "alpha", "read")).toBe(false);
    expect(mayAct(betaStewardOnly, "alpha", "read", { stewardMayRead: true })).toBe(true);
    expect(mayAct(betaStewardOnly, "alpha", "write", { stewardMayRead: true })).toBe(false);
    expect(mayAct(betaRead, "alpha", "steward", { stewardMayRead: true })).toBe(false);
  });

  it("a steward-only grantee reads identity and vows, and cannot read mind_state or search", async () => {
    const idn = await core();
    const vow = (await A("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id as string;
    expect((await as(betaStewardOnly, "mind_identity", { operation: "read" })).receipt.projection.cores.map((c: any) => c.id)).toEqual([idn]);
    expect((await as(betaStewardOnly, "mind_identity", { operation: "read_section", section: "core" })).receipt.projection.cores).toHaveLength(1);
    expect((await as(betaStewardOnly, "mind_vow", { operation: "list" })).receipt.projection.vows).toHaveLength(1);
    expect((await as(betaStewardOnly, "mind_vow", { operation: "recall", vow_id: vow })).receipt.projection.vow.id).toBe(vow);
    expectErr(await as(betaStewardOnly, "mind_state", { operation: "read" }), "forbidden");
    expectErr(await as(betaStewardOnly, "mind_search", { query: "faith" }), "forbidden");
    expectErr(await as(betaStewardOnly, "mind_orient", { depth: "orientation" }), "forbidden");
    // reading does not make writing possible
    expectErr(await as(betaStewardOnly, "mind_identity", { operation: "affirm", section: "s", content: "c" }), "forbidden");
  });
});

describe("A7 one clock for declarations", () => {
  it("effective_at is the declaring event's created_at plus cooling for a rewrite and for a vow break", async () => {
    const p = await declare(await core());
    const [pe] = await q("alpha", "select created_at, payload from events where id = $1", [p.event_id]);
    expect(new Date(p.effective_at).getTime()).toBe(new Date(pe.created_at).getTime() + 24 * HOUR);
    expect(pe.payload.cooling_ms).toBe(24 * HOUR);
    const v = (await A("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id;
    const b = await A("mind_vow", { operation: "break", vow_id: v, reason: "r" });
    const [be] = await q("alpha", "select created_at from events where id = $1", [b.receipt.event_id]);
    const d = b.receipt.projection.vow.metadata.break_declared;
    expect(new Date(d.declared_at).getTime()).toBe(new Date(be.created_at).getTime());
    expect(new Date(d.effective_at).getTime()).toBe(new Date(be.created_at).getTime() + 24 * HOUR);
  });
});

describe("mutation gaps: locks and the migration constraint", () => {
  it("settle re-reads under the proposal lock: a withdrawal that commits between its select and its lock wins", async () => {
    const old = await core();
    const p = await declare(old);
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext($1))", [`proposal:${p.id}`]);
      const pending = settle(new Date(p.effective_at));
      await lockWaiter(); // settle has selected the proposal and now waits for the lock
      await holder.query("update proposals set status = 'withdrawn', withdrawn_at = now() where id = $1", [p.id]);
      await holder.query("commit");
      expect((await pending).changed).toBe(0);
    } finally {
      holder.release();
    }
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).toBeNull();
    expect((await q("alpha", "select status from proposals where id = $1", [p.id]))[0].status).toBe("withdrawn");
    expect(await q("alpha", "select 1 from events where kind = 'identity.settled'")).toEqual([]);
  });

  it("withdraw takes the proposal lock: it blocks while another connection holds it and then proceeds", async () => {
    const p = await declare(await core());
    const holder = await admin.connect();
    let done = false;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext($1))", [`proposal:${p.id}`]);
      const w = A("mind_identity", { operation: "withdraw", proposal_id: p.id }).then((r) => {
        done = true;
        return r;
      });
      await lockWaiter();
      await new Promise((res) => setTimeout(res, 150));
      expect(done).toBe(false);
      expect((await q("alpha", "select status from proposals where id = $1", [p.id]))[0].status).toBe("accepted");
      await holder.query("commit");
      expect((await w).ok).toBe(true);
    } finally {
      holder.release();
    }
    expect((await q("alpha", "select status from proposals where id = $1", [p.id]))[0].status).toBe("withdrawn");
  });

  it("0017 left no govern scope: the constraint rejects it and accepts steward, and GRANT_SCOPES has no govern", async () => {
    expect(GRANT_SCOPES).toContain("steward");
    expect(GRANT_SCOPES as readonly string[]).not.toContain("govern");
    await admin.query("insert into minds (mind_id, key_hash) values ('delta', 'x')");
    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'delta', 'steward')");
    await expect(admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'delta', 'govern')")).rejects.toThrow(/grants_scope_check/);
    expect((await admin.query("select count(*)::int n from grants where scope = 'govern'")).rows[0].n).toBe(0);
  });
});

describe("key rotation does not lift a suspension", () => {
  it("suspend, rotate, mature a declaration: still suspended and unsettled; restore pushes it back", async () => {
    const old = await core();
    const p = await declare(old);
    const due = new Date(p.effective_at);
    await setMindDisabled(admin, "alpha", true);

    const up = await upsertMinds(admin, [{ mind_id: "alpha", key: "rotated-alpha-key-0123456789abcdefghij" }]);
    expect(up).toEqual({ upserted: 1, suspended: ["alpha"] });
    expect((await admin.query("select disabled_at from minds where mind_id = 'alpha'")).rows[0].disabled_at).not.toBeNull();
    expect(await resolveCaller(pool, "rotated-alpha-key-0123456789abcdefghij")).toBeNull();

    // the declaration matures on the injected clock; a suspended mind is not run, so nothing settles
    const reports = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => later(25 * HOUR), coolingMs: cooling }, { trigger: "manual", minds: ["alpha"] });
    expect(reports).toEqual([]);
    expect((await admin.query("select status from proposals where id = $1", [p.id])).rows[0].status).toBe("accepted");

    await new Promise((r) => setTimeout(r, 25));
    const r = await setMindDisabled(admin, "alpha", false);
    expect(r).toMatchObject({ status: "restored", shifted: 1 });
    const [row] = (await admin.query("select status, effective_at from proposals where id = $1", [p.id])).rows;
    expect(row.status).toBe("accepted");
    expect(new Date(row.effective_at).getTime()).toBeGreaterThan(due.getTime());
    // pushed back: not due at the original time
    expect((await settle(due)).changed).toBe(0);
    expect(await resolveCaller(pool, "rotated-alpha-key-0123456789abcdefghij")).toEqual({ bearer: "alpha", grants: {} });
  });

  it("an upsert of a mind that is not suspended reports none suspended", async () => {
    expect(await upsertMinds(admin, [{ mind_id: "alpha", key: "another-alpha-key-0123456789abcdefghijk" }])).toEqual({ upserted: 1, suspended: [] });
  });
});

describe("mind_identity settle", () => {
  const settleVerb = (caller: Caller = alpha) => as(caller, "mind_identity", { operation: "settle" });

  it("settles a due rewrite and a due vow break; nothing before they are due", async () => {
    const old = await core();
    const p = await declare(old);
    const vow = (await A("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id as string;
    expect((await A("mind_vow", { operation: "break", vow_id: vow, reason: "changed" })).ok).toBe(true);

    clock = later(24 * HOUR - 60_000);
    const early = await settleVerb();
    expect(early.ok).toBe(true);
    expect(early.receipt.projection).toEqual({ settled: 0, declarations: [] });
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).toBeNull();

    clock = later(25 * HOUR);
    const r = await settleVerb();
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.settled).toBe(2);
    expect(r.receipt.projection.declarations).toEqual([
      expect.objectContaining({ kind: "rewrite", proposal_id: p.id, target_node_id: old }),
      { kind: "vow_break", vow_id: vow, target_node_id: vow },
    ]);
    const [o] = await q("alpha", "select invalidated_at, superseded_by from nodes where id = $1", [old]);
    expect(o.invalidated_at).not.toBeNull();
    expect((await q("alpha", "select content from nodes where id = $1", [o.superseded_by]))[0].content).toBe("new self");
    expect((await q("alpha", "select status from proposals where id = $1", [p.id]))[0].status).toBe("settled");
    expect((await q("alpha", "select metadata from nodes where id = $1", [vow]))[0].metadata).toMatchObject({ broken: true, broken_by: "alpha" });
    // once only, and the daemon pass finds nothing left
    expect((await settleVerb()).receipt.projection.settled).toBe(0);
    expect((await settle(clock)).changed).toBe(0);
  });

  it("does not settle a withdrawn declaration", async () => {
    const old = await core();
    const p = await declare(old);
    await A("mind_identity", { operation: "withdraw", proposal_id: p.id });
    clock = later(30 * HOUR);
    expect((await settleVerb()).receipt.projection.settled).toBe(0);
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).toBeNull();
  });

  it("is forbidden for write, steward and read grantees, and settles nothing", async () => {
    const old = await core();
    await declare(old);
    clock = later(30 * HOUR);
    for (const caller of [betaWrite, betaSteward, betaRead]) {
      const r = await settleVerb(caller);
      expectErr(r, "forbidden");
      expect(r.error.message).toBe(MSG);
    }
    expect((await q("alpha", "select invalidated_at from nodes where id = $1", [old]))[0].invalidated_at).toBeNull();
  });
});

describe("retiring a core", () => {
  const retire = (target: string, extra: Record<string, unknown> = {}) =>
    A("mind_identity", { operation: "retire", target_node_id: target, lineage_note: "enough", ...extra });
  const declareRetire = async (target: string, extra: Record<string, unknown> = {}) => {
    const r = await retire(target, extra);
    expect(r.ok).toBe(true);
    return r.receipt.projection.proposal as any;
  };
  const invalidatedAt = async (id: string) => (await q("alpha", "select invalidated_at from nodes where id = $1", [id]))[0].invalidated_at;
  /** a second live core, so retiring the first is not the last-core case */
  const second = async () =>
    (await A("mind_identity", { operation: "affirm", section: "other", content: "another self" })).receipt.projection.node_id as string;

  it("only the mind can retire; write and steward grantees are forbidden and nothing is written", async () => {
    const id = await core();
    const before = await q("alpha", "select count(*)::int n from events");
    for (const caller of [betaWrite, betaSteward, betaRead]) {
      const r = await as(caller, "mind_identity", { operation: "retire", target_node_id: id });
      expectErr(r, "forbidden");
      expect(r.error.message).toBe(MSG);
    }
    expect(await q("alpha", "select count(*)::int n from events")).toEqual(before);
    expect(await q("alpha", "select 1 from proposals")).toEqual([]);
    expectErr(await A("mind_identity", { operation: "retire" }), "invalid_input", "target_node_id");
  });

  it("the target must be a live identity node of the mind", async () => {
    await core();
    const note = (await A("mind_desire", { operation: "register", want: "just a want" })).receipt.projection.node_id as string;
    for (const target of [crypto.randomUUID(), note]) expectErr(await retire(target), "not_found", "target_node_id");
    const gone = await second();
    cooling = 0;
    await declareRetire(gone);
    await settle(later(1000));
    expect(await invalidatedAt(gone)).not.toBeNull();
    expectErr(await retire(gone), "not_found", "target_node_id");
    expect(await q("alpha", "select 1 from proposals where action = 'retire'")).toHaveLength(1);
  });

  it("conflicts with a cooling rewrite on the same core, and a rewrite conflicts with a cooling retire", async () => {
    const id = await core();
    const p = await declare(id);
    const r = await retire(id);
    expectErr(r, "conflict", "target_node_id");
    expect(r.error.message).toBe("a declaration for this core is already cooling; withdraw it first");
    await A("mind_identity", { operation: "withdraw", proposal_id: p.id });
    const rp = await declareRetire(id);
    expectErr(await A("mind_identity", { operation: "propose", section: "core", content: "x", target_node_id: id }), "conflict", "target_node_id");
    expectErr(await retire(id), "conflict", "target_node_id");
    await A("mind_identity", { operation: "withdraw", proposal_id: rp.id });
    expect((await retire(id)).ok).toBe(true);
  });

  it("is accepted with effective_at = now + cooling, event identity.retire, and shows in read and orient", async () => {
    const id = await core();
    await second();
    const r = await retire(id);
    expect(r.ok).toBe(true);
    const p = r.receipt.projection.proposal;
    expect(p).toMatchObject({ status: "accepted", action: "retire", proposed_by: "alpha", target_node_id: id, section: "core", content: "old self", lineage_note: "enough" });
    expect(new Date(p.effective_at).getTime()).toBe((await createdAt(p.event_id)) + 24 * HOUR);
    const [ev] = await q("alpha", "select kind, payload, written_by from events where id = $1", [p.event_id]);
    expect(ev).toMatchObject({ kind: "identity.retire", written_by: "alpha", payload: { target_node_id: id, lineage_note: "enough", cooling_ms: 24 * HOUR } });
    const read = await A("mind_identity", { operation: "read" });
    expect(read.receipt.projection.declarations).toEqual([
      { proposal_id: p.id, kind: "retire", action: "retire", target_node_id: id, effective_at: new Date(p.effective_at).toISOString(), attestations: [], objections: [] },
    ]);
    expect(read.receipt.projection.proposals[0]).toMatchObject({ id: p.id, action: "retire" });
    expect(read.receipt.projection.cores).toHaveLength(2);
    const orient = await A("mind_orient", {});
    expect(JSON.stringify(orient.receipt.projection)).toContain(`"action":"retire"`);
  });

  it("settle before the time does nothing; withdraw leaves the core live", async () => {
    const id = await core();
    await second();
    const p = await declareRetire(id);
    expect((await settle(later(24 * HOUR - 1000))).changed).toBe(0);
    expect(await invalidatedAt(id)).toBeNull();
    const w = await A("mind_identity", { operation: "withdraw", proposal_id: p.id });
    expect(w.ok).toBe(true);
    expect(w.receipt.projection.proposal).toMatchObject({ status: "withdrawn" });
    expect((await settle(later(48 * HOUR))).changed).toBe(0);
    expect(await invalidatedAt(id)).toBeNull();
    expect((await A("mind_identity", { operation: "read_section", section: "core" })).receipt.projection.cores).toHaveLength(1);
  });

  it("settles after the time: node invalidated with retired metadata, edges kept, nothing deleted", async () => {
    const id = await core();
    const keep = await second();
    await A("mind_link", { source_node_id: id, target_node_id: keep, edge_type: "related_to" });
    const edgesBefore = await q("alpha", "select id from edges order by id");
    const p = await declareRetire(id);
    const due = await settle(new Date(p.effective_at));
    expect(due).toMatchObject({ ok: true, changed: 1 });
    const [n] = await q("alpha", "select * from nodes where id = $1", [id]);
    expect(n.invalidated_at).not.toBeNull();
    expect(n.superseded_by).toBeNull();
    expect(n.content).toBe("old self");
    expect(n.metadata).toMatchObject({ retired: true, retired_reason: "enough", retire_proposal_id: p.id, retire_attestations: [] });
    expect(new Date(n.metadata.retired_at).getTime()).toBe(new Date(n.invalidated_at).getTime());
    const [row] = await q("alpha", "select * from proposals where id = $1", [p.id]);
    expect(row.status).toBe("settled");
    expect(row.settled_at).not.toBeNull();
    const [ev] = await q("alpha", "select kind, written_by, subject_id, payload from events where id = $1", [row.settled_event_id]);
    expect(ev).toMatchObject({ kind: "identity.retired", written_by: "alpha", subject_id: p.id, payload: { proposal_id: p.id, target_node_id: id, lineage_note: "enough" } });
    expect(await q("alpha", "select id from edges order by id")).toEqual(edgesBefore);
    const read = await A("mind_identity", { operation: "read" });
    expect(read.receipt.projection.cores.map((c: any) => c.id)).toEqual([keep]);
    expect(read.receipt.projection.declarations).toEqual([]);
    expect((await A("mind_identity", { operation: "read_section", section: "core" })).receipt.projection.cores).toEqual([]);
    expect((await settle(later(72 * HOUR))).changed).toBe(0);
  });

  it("a steward may not shorten a retire: attest is a conflict and effective_at does not move; settle waits for the mind's clock", async () => {
    const id = await core();
    await second();
    const p = await declareRetire(id);
    clock = later(HOUR);
    const at = await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "I have seen this" });
    expectErr(at, "conflict", "proposal_id");
    expect(at.error.message).toBe("a retirement cools only on the mind's own clock; a steward may object, not attest");
    const [row] = await q("alpha", "select effective_at, attestations from proposals where id = $1", [p.id]);
    expect(new Date(row.effective_at).getTime()).toBe(new Date(p.effective_at).getTime());
    expect(row.attestations).toEqual([]);
    expect(await q("alpha", "select 1 from events where kind = 'identity.attest'")).toEqual([]);
    expect((await A("mind_identity", { operation: "settle" })).receipt.projection.settled).toBe(0);
    expect(await invalidatedAt(id)).toBeNull();
    clock = later(25 * HOUR);
    expect((await A("mind_identity", { operation: "settle" })).receipt.projection.settled).toBe(1);
    expect(await invalidatedAt(id)).not.toBeNull();
  });

  it("a steward may still object to a retire: it is recorded, effective_at is unchanged, and it never blocks", async () => {
    const id = await core();
    await second();
    const p = await declareRetire(id);
    const r = await as(betaSteward, "mind_identity", { operation: "object", proposal_id: p.id, note: "keep this one" });
    expect(r.ok).toBe(true);
    const [row] = await q("alpha", "select effective_at, attestations from proposals where id = $1", [p.id]);
    expect(row.attestations).toMatchObject([{ by: "beta", stance: "object", note: "keep this one" }]);
    expect(new Date(row.effective_at).getTime()).toBe(new Date(p.effective_at).getTime());
    clock = later(25 * HOUR);
    expect((await A("mind_identity", { operation: "settle" })).receipt.projection.settled).toBe(1);
    expect(await invalidatedAt(id)).not.toBeNull();
  });

  it("with cooling 0 it settles on the next pass", async () => {
    cooling = 0;
    const id = await core();
    await second();
    await declareRetire(id);
    expect((await settle(later(1000))).changed).toBe(1);
    expect(await invalidatedAt(id)).not.toBeNull();
  });

  it("warns when retiring the only live core, and not otherwise", async () => {
    const id = await core();
    const other = await second();
    const first = await retire(id);
    expect(first.ok).toBe(true);
    expect(first.receipt.warnings).toBeUndefined();
    await A("mind_identity", { operation: "withdraw", proposal_id: first.receipt.projection.proposal.id });
    cooling = 0;
    await declareRetire(id);
    await settle(later(1000));
    const last = await retire(other);
    expect(last.ok).toBe(true);
    expect(last.receipt.warnings).toEqual(["last live identity core"]);
  });

  it("warns on the second retire when the two only cores are both declared retired", async () => {
    const a = await core();
    const b = await second();
    const first = await retire(a);
    expect(first.ok).toBe(true);
    expect(first.receipt.warnings).toBeUndefined();
    const then = await retire(b);
    expect(then.ok).toBe(true);
    expect(then.receipt.warnings).toEqual(["last live identity core"]);
  });

  it("the daemon pass identity.settle settles a due retire", async () => {
    const id = await core();
    await second();
    const p = await declareRetire(id);
    const pass = await settle(new Date(p.effective_at));
    expect(pass).toMatchObject({ ok: true, changed: 1 });
    expect(await invalidatedAt(id)).not.toBeNull();
    expect((await q("alpha", "select kind from events where kind = 'identity.retired'"))).toHaveLength(1);
  });

  it("mind_rethink still refuses a core", async () => {
    const id = await core();
    expectErr(await A("mind_rethink", { node_id: id, content: "x", reason: "r" }), "conflict", "node_id");
  });
});

describe("cooling configuration, the daemon's fail-fast", () => {
  it("the parse helper rejects 24h", () => {
    expect(() => coolingMs({ IDENTITY_COOLING_HOURS: "24h" })).toThrow(/IDENTITY_COOLING_HOURS/);
  });
});

describe("proposals are guarded in the database (0020)", () => {
  const OPEN_ARGS = (by: string, target: string, ev: string, status = "accepted", action = "retire") =>
    [by, target, ev, status, action, new Date(Date.now() + 24 * HOUR)] as const;
  const INSERT = `insert into proposals (mind_id, kind, action, section, content, proposed_by, event_id, created_at, target_node_id, status, effective_at)
                  values ('alpha', 'identity', $5, 's', 'c', $1, $3, now(), $2, $4, $6) returning id`;
  const firstEvent = async () => (await q("alpha", "select id from events order by seq limit 1"))[0].id as string;
  const asBeta = (sql: string, params: unknown[] = []) =>
    withMind(pool, "alpha", "beta", "write", async (tx) => (await tx.query(sql, params)).rows as any[]);

  it("insert: only the mind itself writes a declaration; a grantee cannot, in the mind's name or its own", async () => {
    const id = await core();
    const ev = await firstEvent();
    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'write') on conflict do nothing");
    // beta (write grant on alpha) forging an accepted retire "by alpha": refused by the trigger
    await expect(asBeta(INSERT, [...OPEN_ARGS("alpha", id, ev)])).rejects.toThrow(/proposals are declared by the mind itself/);
    await expect(asBeta(INSERT, [...OPEN_ARGS("alpha", id, ev)])).rejects.toMatchObject({ code: "42501" });
    // beta declaring in its own name on alpha's core: refused as well (only the mind declares)
    await expect(asBeta(INSERT, [...OPEN_ARGS("beta", id, ev)])).rejects.toThrow(/proposals are declared by the mind itself/);
    expect(await q("alpha", "select 1 from proposals")).toEqual([]);
    // a row for a mind other than the one the transaction carries is refused too (by the trigger, whatever RLS says)
    await expect(queryAs(pool, "beta", "beta", INSERT, [...OPEN_ARGS("beta", id, ev)])).rejects.toThrow();
    // the mind itself, in its own scope, succeeds
    const mine = await queryAs(pool, "alpha", "alpha", INSERT, [...OPEN_ARGS("alpha", id, ev)]);
    expect(mine.rows).toHaveLength(1);
  });

  it("insert: a bare admin connection with no mind scope is refused as well", async () => {
    const id = await core();
    await expect(admin.query(INSERT, [...OPEN_ARGS("alpha", id, await firstEvent())])).rejects.toThrow(/proposals are declared by the mind itself/);
  });

  it("update: a steward may change attestations and effective_at only", async () => {
    const id = await core();
    const p = await declare(id);
    const soon = new Date(Date.now() + HOUR);
    const entry = JSON.stringify([{ by: "beta", stance: "attest", note: "n" }]);
    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'steward') on conflict do nothing");
    const ok = await asBeta("update proposals set attestations = attestations || $2::jsonb, effective_at = $3 where id = $1 returning *", [p.id, entry, soon]);
    expect(ok[0].attestations).toHaveLength(1);
    expect(new Date(ok[0].effective_at).getTime()).toBe(soon.getTime());
    for (const set of [
      "status = 'withdrawn'",
      "withdrawn_at = now()",
      "settled_at = now()",
      "content = 'rewritten by a steward'",
      "section = 'other'",
      "lineage_note = 'x'",
      "proposed_by = 'beta'",
      "action = 'retire'",
      "target_node_id = null",
      "created_at = now() - interval '1 day'",
    ]) {
      await expect(asBeta(`update proposals set ${set} where id = $1`, [p.id]), set).rejects.toThrow(/only the mind changes its declaration/);
    }
    // the refused updates changed nothing
    expect((await q("alpha", "select status, content from proposals where id = $1", [p.id]))[0]).toEqual({ status: "accepted", content: "new self" });
  });

  describe("update: the steward's narrow window", () => {
    const entry = (n = "n") => JSON.stringify([{ by: "beta", stance: "attest", note: n }]);
    const steward = async () => {
      await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'steward') on conflict do nothing");
    };
    const effective = async (id: string) => new Date((await q("alpha", "select effective_at from proposals where id = $1", [id]))[0].effective_at);

    it("effective_at: later refused, earlier allowed on a rewrite, equal allowed", async () => {
      const p = await declare(await core());
      await steward();
      const eff = await effective(p.id);
      const upd = "update proposals set effective_at = $2 where id = $1";
      await expect(asBeta(upd, [p.id, new Date(eff.getTime() + HOUR)])).rejects.toThrow(/a steward may only add an attestation and bring effective_at forward/);
      await expect(asBeta(upd, [p.id, new Date(eff.getTime() + HOUR)])).rejects.toMatchObject({ code: "42501" });
      await expect(asBeta(upd, [p.id, null])).rejects.toThrow(/bring effective_at forward/);
      await expect(asBeta(upd, [p.id, "infinity"])).rejects.toThrow(/bring effective_at forward/);
      expect((await effective(p.id)).getTime()).toBe(eff.getTime());
      await asBeta(upd, [p.id, eff]); // equal: no change, allowed
      const past = new Date(eff.getTime() - 3 * HOUR);
      await asBeta(upd, [p.id, past]);
      expect((await effective(p.id)).getTime()).toBe(past.getTime());
    });

    it("effective_at: on a retire it may not change at all, earlier or later", async () => {
      const r = await A("mind_identity", { operation: "retire", target_node_id: await core() });
      expect(r.ok).toBe(true);
      const id = (r.receipt.projection.proposal as any).id as string;
      await steward();
      const eff = await effective(id);
      for (const t of [new Date(eff.getTime() - HOUR), new Date(eff.getTime() + HOUR)]) {
        await expect(asBeta("update proposals set effective_at = $2 where id = $1", [id, t])).rejects.toThrow(/a retirement's effective time is the mind's alone/);
      }
      expect((await effective(id)).getTime()).toBe(eff.getTime());
      // appending an attestation (an objection) with effective_at unchanged is fine
      await asBeta("update proposals set attestations = attestations || $2::jsonb where id = $1", [id, entry()]);
    });

    it("attestations only grow: replacing, emptying, rewriting, or appending two are refused; appending one is allowed", async () => {
      const p = await declare(await core());
      await steward();
      const upd = (expr: string) => asBeta(`update proposals set attestations = ${expr} where id = $1`, [p.id]);
      await upd(`attestations || '${entry("one")}'::jsonb`);
      await expect(upd("'[]'::jsonb")).rejects.toThrow(/attestations only grow/);
      await expect(upd("'[]'::jsonb")).rejects.toMatchObject({ code: "42501" });
      await expect(upd(`'${entry("swapped")}'::jsonb`)).rejects.toThrow(/attestations only grow/); // same length, old entry replaced
      await expect(upd(`'${entry("a")}'::jsonb || '${entry("b")}'::jsonb`)).rejects.toThrow(/attestations only grow/); // old entry dropped
      await expect(upd(`attestations || '${entry("x")}'::jsonb || '${entry("y")}'::jsonb`)).rejects.toThrow(/attestations only grow/); // two at once
      await expect(upd(`'${entry("two")}'::jsonb || attestations`)).rejects.toThrow(/attestations only grow/); // old entries reordered
      await expect(upd("'{}'::jsonb")).rejects.toThrow(/attestations only grow/);
      expect((await q("alpha", "select jsonb_array_length(attestations) n from proposals where id = $1", [p.id]))[0].n).toBe(1);
      await upd(`attestations || '${entry("two")}'::jsonb`);
      expect((await q("alpha", "select jsonb_array_length(attestations) n from proposals where id = $1", [p.id]))[0].n).toBe(2);
    });

    it("id, decided_at, decided_event_id and the other columns are refused", async () => {
      const p = await declare(await core());
      await steward();
      const ev = await firstEvent();
      for (const [set, params] of [
        ["id = gen_random_uuid()", []],
        ["decided_at = now()", []],
        ["decided_event_id = $2", [ev]],
        ["settled_event_id = $2", [ev]],
        ["event_id = $2", [ev]],
        ["mind_id = 'beta'", []],
        ["kind = 'identity'", []], // same value: allowed, not a change
      ] as Array<[string, unknown[]]>) {
        const attempt = asBeta(`update proposals set ${set} where id = $1 returning id`, [p.id, ...params]);
        if (set.startsWith("kind")) await attempt;
        else await expect(attempt, set).rejects.toThrow();
      }
      for (const set of ["id = gen_random_uuid()", "decided_at = now()"]) {
        await expect(asBeta(`update proposals set ${set} where id = $1`, [p.id]), set).rejects.toThrow(/only the mind changes its declaration/);
      }
    });

    it("the verbs still work end to end: attest on a rewrite appends and moves effective_at earlier; object on a retire appends and leaves it", async () => {
      const p = await declare(await core());
      const before = await effective(p.id);
      clock = later(HOUR);
      expect((await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "ok" })).ok).toBe(true);
      const row = (await q("alpha", "select effective_at, attestations from proposals where id = $1", [p.id]))[0];
      expect(row.attestations).toHaveLength(1);
      expect(new Date(row.effective_at).getTime()).toBeLessThan(before.getTime());

      const r = await A("mind_identity", { operation: "retire", target_node_id: await core() });
      const rid = (r.receipt.projection.proposal as any).id as string;
      const eff = await effective(rid);
      expect((await as(betaSteward, "mind_identity", { operation: "object", proposal_id: rid, note: "wait" })).ok).toBe(true);
      const after = (await q("alpha", "select effective_at, attestations from proposals where id = $1", [rid]))[0];
      expect(after.attestations).toHaveLength(1);
      expect(new Date(after.effective_at).getTime()).toBe(eff.getTime());
    });
  });

  it("update: the mind itself (withdraw, settle) and the admin connection with no mind scope pass", async () => {
    const id = await core();
    const p = await declare(id);
    // admin pool, no GUCs: the documented operator path (restore-access shifts effective_at) is allowed
    await admin.query("update proposals set effective_at = effective_at + interval '1 hour' where id = $1", [p.id]);
    // the mind withdraws through the verb
    const w = await A("mind_identity", { operation: "withdraw", proposal_id: p.id });
    expect(w.ok).toBe(true);
    // and settle, as the mind, on another declaration
    cooling = 0;
    const id2 = await A("mind_identity", { operation: "affirm", section: "two", content: "second" }).then((r) => r.receipt.projection.node_id as string);
    await declare(id2);
    expect((await settle(later(HOUR))).changed).toBe(1);
  });

  it("a steward's attest through the verb still works under the trigger", async () => {
    const id = await core();
    const p = await declare(id);
    clock = later(HOUR);
    expect((await as(betaSteward, "mind_identity", { operation: "attest", proposal_id: p.id, note: "ok" })).ok).toBe(true);
    expect((await settle(later(2 * HOUR))).changed).toBe(1);
  });

  it("the unique index: a direct second open declaration on one core is refused, while the verb answers conflict first", async () => {
    const id = await core();
    const p = await declare(id);
    expectErr(await A("mind_identity", { operation: "retire", target_node_id: id }), "conflict", "target_node_id");
    expectErr(await A("mind_identity", { operation: "propose", section: "core", content: "x", target_node_id: id }), "conflict", "target_node_id");
    const ev = await firstEvent();
    await expect(queryAs(pool, "alpha", "alpha", INSERT, [...OPEN_ARGS("alpha", id, ev)])).rejects.toThrow(/proposals_one_open_per_core/);
    await expect(queryAs(pool, "alpha", "alpha", INSERT, [...OPEN_ARGS("alpha", id, ev, "pending", "rewrite")])).rejects.toThrow(/proposals_one_open_per_core/);
    // once the first is withdrawn the core is free again
    expect((await A("mind_identity", { operation: "withdraw", proposal_id: p.id })).ok).toBe(true);
    expect((await queryAs(pool, "alpha", "alpha", INSERT, [...OPEN_ARGS("alpha", id, ev)])).rows).toHaveLength(1);
  });
});
