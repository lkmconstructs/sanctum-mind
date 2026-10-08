import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { mind_identity } from "../src/verbs/mind_identity.js";
import { mind_vow } from "../src/verbs/mind_vow.js";
import { mind_anchor } from "../src/verbs/mind_anchor.js";
import { mind_desire } from "../src/verbs/mind_desire.js";
import { mind_rethink } from "../src/verbs/mind_rethink.js";
import { mind_observe } from "../src/verbs/mind_observe.js";
import type { Caller } from "../src/verbs/types.js";

const registry = [mind_identity, mind_vow, mind_anchor, mind_desire, mind_rethink, mind_observe];

const alpha: Caller = { bearer: "alpha", grants: {} };
const betaRead: Caller = { bearer: "beta", grants: { alpha: ["read"] } };
const betaWrite: Caller = { bearer: "beta", grants: { alpha: ["read", "write"] } };

let pool: Pool;
const run = (caller: Caller, name: string, input: unknown) => runVerb({ pool, registry }, caller, name, input);
const A = (name: string, input: Record<string, unknown>) => run(alpha, name, { mind_id: "alpha", ...input }) as Promise<any>;

const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);

beforeEach(async () => {
  if (pool) await closePool(pool);
  const admin = await resetDatabase();
  await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'write')");
  await closePool(admin);
  pool = appPool();
});

afterAll(async () => {
  if (pool) await closePool(pool);
});

const expectErr = (r: any, code: string, field?: string) => {
  expect(r.ok).toBe(false);
  expect(r.error.code).toBe(code);
  if (field !== undefined) expect(r.error.field).toBe(field);
};

describe("mind_identity", () => {
  it("affirm writes an event and a pinned identity node; read and read_section see it", async () => {
    const r = await A("mind_identity", { operation: "affirm", section: "core", content: "I am steady", lineage_note: "first" });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.receipt.projection).sort()).toEqual(["event_id", "node_id"]);
    const [n] = await q("alpha", "select * from nodes where id = $1", [r.receipt.projection.node_id]);
    expect(n).toMatchObject({ node_type: "identity", label: "core", pinned: true, source_type: "extracted", confidence: 1, written_by: "alpha" });
    expect(n.metadata).toMatchObject({ lineage_note: "first", event_id: r.receipt.event_id, affirmed_by: "alpha" });
    const [ev] = await q("alpha", "select kind, payload from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("identity.affirm");

    const all: any = await A("mind_identity", { operation: "read" });
    expect(all.receipt.event_id).toBeUndefined();
    expect(all.receipt.projection.cores).toHaveLength(1);
    expect((await A("mind_identity", { operation: "read_section", section: "core" })).receipt.projection.cores).toHaveLength(1);
    expect((await A("mind_identity", { operation: "read_section", section: "none" })).receipt.projection.cores).toEqual([]);
  });

  it("is strict and reports required fields per operation", async () => {
    expectErr(await A("mind_identity", { operation: "read", extra: 1 }), "invalid_input", "extra");
    expectErr(await A("mind_identity", { operation: "read_section" }), "invalid_input", "section");
    expectErr(await A("mind_identity", { operation: "affirm", section: "s" }), "invalid_input", "content");
    expectErr(await A("mind_identity", { operation: "propose", content: "c" }), "invalid_input", "section");
    expectErr(await A("mind_identity", { operation: "withdraw" }), "invalid_input", "proposal_id");
    expectErr(await A("mind_identity", { operation: "attest", proposal_id: crypto.randomUUID() }), "invalid_input", "note");
    expectErr(await A("mind_identity", { operation: "decide", proposal_id: crypto.randomUUID() }), "invalid_input", "operation");
  });

  it("read grantee may read but not write", async () => {
    await A("mind_identity", { operation: "affirm", section: "core", content: "x" });
    const rd: any = await run(betaRead, "mind_identity", { mind_id: "alpha", operation: "read" });
    expect(rd.ok).toBe(true);
    expect(rd.receipt.projection.cores).toHaveLength(1);
    expectErr(await run(betaRead, "mind_identity", { mind_id: "alpha", operation: "affirm", section: "s", content: "c" }), "forbidden");
    expectErr(await run(betaRead, "mind_identity", { mind_id: "alpha", operation: "propose", section: "s", content: "c" }), "forbidden");
  });

  it("RLS hides alpha's identity from beta's own scope", async () => {
    await A("mind_identity", { operation: "affirm", section: "core", content: "x" });
    const r: any = await run(betaRead, "mind_identity", { mind_id: "beta", operation: "read" });
    expect(r.receipt.projection.cores).toEqual([]);
    expect(await q("beta", "select * from proposals")).toEqual([]);
  });

  it("an untargeted propose is an addition with lineage: immediate node, settled proposal; a write grantee cannot propose", async () => {
    expectErr(await run(betaWrite, "mind_identity", { mind_id: "alpha", operation: "propose", section: "core", content: "new core" }), "forbidden");
    const p: any = await A("mind_identity", { operation: "propose", section: "core", content: "new core", lineage_note: "n" });
    expect(p.ok).toBe(true);
    const proposal = p.receipt.projection.proposal;
    expect(proposal).toMatchObject({ status: "settled", proposed_by: "alpha", kind: "identity", event_id: p.receipt.event_id });
    const [n] = await q("alpha", "select * from nodes where id = $1", [p.receipt.projection.node_id]);
    expect(n).toMatchObject({ node_type: "identity", label: "core", content: "new core", written_by: "alpha" });
    expect(n.metadata).toMatchObject({ proposal_id: proposal.id, lineage_note: "n" });
    expect((await A("mind_identity", { operation: "read" })).receipt.projection.proposals).toEqual([]);
    expect((await A("mind_identity", { operation: "read", include_settled: true })).receipt.projection.proposals).toHaveLength(1);
  });

  it("withdraw: unknown proposal is not_found; a settled one conflicts", async () => {
    const p: any = await A("mind_identity", { operation: "propose", section: "s", content: "c" });
    expectErr(await A("mind_identity", { operation: "withdraw", proposal_id: p.receipt.projection.proposal.id }), "conflict", "proposal_id");
    expectErr(await A("mind_identity", { operation: "withdraw", proposal_id: crypto.randomUUID() }), "not_found", "proposal_id");
  });
});

describe("mind_vow", () => {
  it("make, list and recall", async () => {
    const long = "keep   my word ".repeat(20);
    const r = await A("mind_vow", { operation: "make", vow: long, context: "ctx" });
    expect(r.ok).toBe(true);
    const [n] = await q("alpha", "select * from nodes where id = $1", [r.receipt.projection.node_id]);
    expect(n).toMatchObject({ node_type: "vow", pinned: true, content: long });
    expect(n.label).toBe(long.replace(/\s+/g, " ").trim().slice(0, 120));
    expect(n.metadata).toMatchObject({ context: "ctx", event_id: r.receipt.event_id, broken: false });
    expect(n.metadata.made_at).toBeTruthy();

    const l = await A("mind_vow", { operation: "list" });
    expect(l.receipt.projection.vows).toHaveLength(1);
    const rc = await A("mind_vow", { operation: "recall", vow_id: n.id });
    expect(rc.ok).toBe(true);
    expect(rc.receipt.projection.vow.id).toBe(n.id);
    expectErr(await A("mind_vow", { operation: "recall", vow_id: crypto.randomUUID() }), "not_found", "vow_id");
  });

  it("strict schema, required fields, grantee scopes, RLS", async () => {
    expectErr(await A("mind_vow", { operation: "list", nope: 1 }), "invalid_input", "nope");
    expectErr(await A("mind_vow", { operation: "make" }), "invalid_input", "vow");
    expectErr(await A("mind_vow", { operation: "recall" }), "invalid_input", "vow_id");
    const r = await A("mind_vow", { operation: "make", vow: "v" });
    expectErr(await run(betaRead, "mind_vow", { mind_id: "alpha", operation: "make", vow: "v" }), "forbidden");
    const l: any = await run(betaRead, "mind_vow", { mind_id: "alpha", operation: "list" });
    expect(l.receipt.projection.vows).toHaveLength(1);
    const rc: any = await run(betaRead, "mind_vow", { mind_id: "alpha", operation: "recall", vow_id: r.receipt.projection.node_id });
    expect(rc.ok).toBe(true);
    const own: any = await run(betaRead, "mind_vow", { mind_id: "beta", operation: "list" });
    expect(own.receipt.projection.vows).toEqual([]);
  });
});

describe("mind_anchor", () => {
  it("create with a response, then check case-insensitively", async () => {
    const r = await A("mind_anchor", { operation: "create", trigger: "Rain Day", response: "breathe" });
    expect(r.ok).toBe(true);
    const [n] = await q("alpha", "select * from nodes where id = $1", [r.receipt.projection.node_id]);
    expect(n).toMatchObject({ node_type: "anchor", label: "Rain Day", content: "breathe" });
    expect(n.metadata).toMatchObject({ trigger: "Rain Day", trigger_lc: "rain day", memory_id: null, response: "breathe" });
    expect(await q("alpha", "select id from edges")).toEqual([]);

    const hit = await A("mind_anchor", { operation: "check", text: "it was a RAIN DAY again" });
    expect(hit.receipt.event_id).toBeUndefined();
    expect(hit.receipt.projection.fired).toHaveLength(1);
    expect(hit.receipt.projection.fired[0].anchor.id).toBe(r.receipt.projection.node_id);
    expect(hit.receipt.projection.fired[0].memory).toBeUndefined();
    expect((await A("mind_anchor", { operation: "check", text: "sunny" })).receipt.projection.fired).toEqual([]);
  });

  it("create bound to a memory links it with a references edge and check returns it", async () => {
    const m: any = await A("mind_observe", { content: "a warm kitchen", texture: { charge: ["warm"] } });
    const mem = m.receipt.projection.node_id;
    const r = await A("mind_anchor", { operation: "create", trigger: "kitchen", memory_id: mem });
    expect(r.ok).toBe(true);
    const edges = await q("alpha", "select * from edges where source_node_id = $1", [r.receipt.projection.node_id]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ edge_type: "references", target_node_id: mem });
    const hit = await A("mind_anchor", { operation: "check", text: "The KITCHEN smelled of bread" });
    expect(hit.receipt.projection.fired[0].memory).toEqual({ id: mem, label: "a warm kitchen", content: "a warm kitchen" });
    expect((await A("mind_anchor", { operation: "list" })).receipt.projection.anchors).toHaveLength(1);
  });

  it("validates inputs", async () => {
    expectErr(await A("mind_anchor", { operation: "list", x: 1 }), "invalid_input", "x");
    expectErr(await A("mind_anchor", { operation: "create", response: "r" }), "invalid_input", "trigger");
    expectErr(await A("mind_anchor", { operation: "create", trigger: "t" }), "invalid_input", "memory_id");
    expectErr(
      await A("mind_anchor", { operation: "create", trigger: "t", response: "r", memory_id: crypto.randomUUID() }),
      "invalid_input",
      "memory_id",
    );
    expectErr(await A("mind_anchor", { operation: "check" }), "invalid_input", "text");
    expectErr(await A("mind_anchor", { operation: "create", trigger: "t", memory_id: crypto.randomUUID() }), "not_found", "memory_id");
  });

  it("grantee scopes and RLS", async () => {
    await A("mind_anchor", { operation: "create", trigger: "t", response: "r" });
    expectErr(await run(betaRead, "mind_anchor", { mind_id: "alpha", operation: "create", trigger: "t", response: "r" }), "forbidden");
    const c: any = await run(betaRead, "mind_anchor", { mind_id: "alpha", operation: "check", text: "T" });
    expect(c.receipt.projection.fired).toHaveLength(1);
    const own: any = await run(betaRead, "mind_anchor", { mind_id: "beta", operation: "check", text: "t" });
    expect(own.receipt.projection.fired).toEqual([]);
  });
});

describe("mind_desire", () => {
  it("register defaults intensity, lists by intensity desc, hides fulfilled", async () => {
    const lo: any = await A("mind_desire", { operation: "register", want: "low", intensity: 0.2 });
    const hi: any = await A("mind_desire", { operation: "register", want: "high", intensity: 0.9, somatic: "chest", context: "c" });
    const mid: any = await A("mind_desire", { operation: "register", want: "mid" });
    expect(hi.ok).toBe(true);
    const [n] = await q("alpha", "select * from nodes where id = $1", [hi.receipt.projection.node_id]);
    expect(n).toMatchObject({ node_type: "desire", label: "high", content: "high", pinned: false });
    expect(n.metadata).toMatchObject({ intensity: 0.9, somatic: "chest", context: "c", fulfilled: false, event_id: hi.receipt.event_id });

    const l: any = await A("mind_desire", { operation: "list" });
    expect(l.receipt.projection.desires.map((d: any) => d.label)).toEqual(["high", "mid", "low"]);

    const f: any = await A("mind_desire", { operation: "fulfill", desire_id: hi.receipt.projection.node_id });
    expect(f.ok).toBe(true);
    expect(f.receipt.projection.node.metadata).toMatchObject({ fulfilled: true, fulfill_event_id: f.receipt.event_id });
    expect(f.receipt.projection.node.metadata.fulfilled_at).toBeTruthy();
    expect((await A("mind_desire", { operation: "list" })).receipt.projection.desires.map((d: any) => d.label)).toEqual(["mid", "low"]);
    expect((await A("mind_desire", { operation: "list", include_fulfilled: true })).receipt.projection.desires).toHaveLength(3);
    expectErr(await A("mind_desire", { operation: "fulfill", desire_id: hi.receipt.projection.node_id }), "conflict", "desire_id");
    void lo;
    void mid;
  });

  it("validates inputs, not_found, grantee scopes, RLS", async () => {
    expectErr(await A("mind_desire", { operation: "list", x: 1 }), "invalid_input", "x");
    expectErr(await A("mind_desire", { operation: "register" }), "invalid_input", "want");
    expectErr(await A("mind_desire", { operation: "register", want: "w", intensity: 2 }), "invalid_input", "intensity");
    expectErr(await A("mind_desire", { operation: "fulfill" }), "invalid_input", "desire_id");
    expectErr(await A("mind_desire", { operation: "fulfill", desire_id: crypto.randomUUID() }), "not_found", "desire_id");
    await A("mind_desire", { operation: "register", want: "w" });
    expectErr(await run(betaRead, "mind_desire", { mind_id: "alpha", operation: "register", want: "w" }), "forbidden");
    expect(((await run(betaRead, "mind_desire", { mind_id: "alpha", operation: "list" })) as any).receipt.projection.desires).toHaveLength(1);
    expect(((await run(betaRead, "mind_desire", { mind_id: "beta", operation: "list" })) as any).receipt.projection.desires).toEqual([]);
  });
});

describe("mind_rethink", () => {
  const observe = async () =>
    (await A("mind_observe", { content: "the sky was green", label: "sky", texture: { charge: ["odd"] } })).receipt.projection.node_id as string;

  it("replaces a node: invalidates old, merges metadata with provenance winning, adds corrects edge", async () => {
    const old = await observe();
    const r = await A("mind_rethink", {
      node_id: old, content: "the sky was blue", reason: "misremembered",
      metadata: { extra: 1, reason: "spoofed", rewritten_by: "nobody" },
    });
    expect(r.ok).toBe(true);
    const p = r.receipt.projection;
    expect(p).toMatchObject({ event_id: r.receipt.event_id, superseded: old });

    const [o] = await q("alpha", "select * from nodes where id = $1", [old]);
    expect(o.invalidated_at).not.toBeNull();
    expect(o.superseded_by).toBe(p.node_id);
    const [n] = await q("alpha", "select * from nodes where id = $1", [p.node_id]);
    expect(n).toMatchObject({ label: "sky", node_type: "observation", content: "the sky was blue", source_type: "extracted", confidence: 1, pinned: false });
    expect(n.metadata).toMatchObject({
      extra: 1, rewritten_from: old, rewritten_by: "alpha", reason: "misremembered", event_id: r.receipt.event_id,
    });
    expect(n.metadata.texture).toEqual({ charge: ["odd"] });
    const edges = await q("alpha", "select * from edges where edge_type = 'corrects'");
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source_node_id: p.node_id, target_node_id: old });
    expect(edges[0].metadata).toEqual({ event_id: r.receipt.event_id });
    const [ev] = await q("alpha", "select kind, subject_id from events where id = $1", [r.receipt.event_id]);
    expect(ev).toMatchObject({ kind: "rethink", subject_id: old });

    expectErr(await A("mind_rethink", { node_id: old, content: "again", reason: "r" }), "conflict", "node_id");
  });

  it("honours label and node_type overrides; unknown node is not_found; schema is strict", async () => {
    const old = await observe();
    const r = await A("mind_rethink", { node_id: old, content: "c", reason: "r", label: "new", node_type: "belief" });
    const [n] = await q("alpha", "select label, node_type from nodes where id = $1", [r.receipt.projection.node_id]);
    expect(n).toEqual({ label: "new", node_type: "belief" });
    expectErr(await A("mind_rethink", { node_id: crypto.randomUUID(), content: "c", reason: "r" }), "not_found", "node_id");
    expectErr(await A("mind_rethink", { node_id: old, content: "c" }), "invalid_input", "reason");
    expectErr(await A("mind_rethink", { node_id: old, content: "c", reason: "r", z: 1 }), "invalid_input", "z");
  });

  it("read grantee is forbidden; write grantee may rethink the owner's node (relaxed update policy)", async () => {
    const old = await observe();
    expectErr(await run(betaRead, "mind_rethink", { mind_id: "alpha", node_id: old, content: "c", reason: "r" }), "forbidden");
    const r: any = await run(betaWrite, "mind_rethink", { mind_id: "alpha", node_id: old, content: "by beta", reason: "r" });
    expect(r.ok).toBe(true);
    const [o] = await q("alpha", "select written_by, invalidated_at from nodes where id = $1", [old]);
    expect(o.written_by).toBe("alpha");
    expect(o.invalidated_at).not.toBeNull();
    const [n] = await q("alpha", "select written_by, metadata from nodes where id = $1", [r.receipt.projection.node_id]);
    expect(n.written_by).toBe("beta");
    expect(n.metadata.rewritten_by).toBe("beta");
  });

  it("rethink is invisible to another mind (RLS)", async () => {
    const old = await observe();
    expectErr(await run(betaWrite, "mind_rethink", { mind_id: "beta", node_id: old, content: "c", reason: "r" }), "not_found", "node_id");
  });

  it("written_by cannot be rewritten via raw SQL under the app role", async () => {
    const old = await observe();
    await expect(
      withMind(pool, "alpha", "alpha", "write", (tx) => tx.query("update nodes set written_by = 'beta' where id = $1", [old])),
    ).rejects.toThrow(/written_by/);
    await expect(
      withMind(pool, "alpha", "alpha", "write", (tx) => tx.query("update edges set written_by = 'beta'")),
    ).resolves.toBeTruthy();
    // inserts still require authorship to match the bearer
    await expect(
      withMind(pool, "alpha", "beta", "write", (tx) =>
        tx.query("insert into nodes (mind_id, node_type, label, content, written_by) values ('alpha','x','l','c','alpha')"),
      ),
    ).rejects.toThrow();
  });
});
