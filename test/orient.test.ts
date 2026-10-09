// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { err } from "../src/result.js";
import { runVerb } from "../src/verbs/run.js";
import { defineVerb } from "../src/verbs/types.js";
import type { Caller, Registry, Verb } from "../src/verbs/types.js";
import { mindIdSchema } from "../src/verbs/common.js";
import { registry as realRegistry } from "../src/verbs/registry.js";
import { mind_vow } from "../src/verbs/mind_vow.js";
import { mind_anchor } from "../src/verbs/mind_anchor.js";

const ORDER = {
  orientation: ["identity", "vows", "state", "handoff", "health"],
  quick: ["loops", "threads", "tasks", "relations", "drives", "inbox", "weather", "anchors", "noticings"],
  full: ["desires", "holdings", "recent", "orphans"],
};

/** The real registry, optionally with replacements/extras (a stub replaces the verb of the same name). */
const reg = (...extra: Verb[]): Registry => [
  ...realRegistry.filter((v) => !extra.some((e) => e.name === v.name)),
  ...extra,
];

const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: {} };
const betaRead: Caller = { bearer: "beta", grants: { alpha: ["read"] } };

let pool: Pool;
const run = (registry: Registry, caller: Caller, input: unknown) => runVerb({ pool, registry }, caller, "mind_orient", input) as Promise<any>;
const V = (caller: Caller, mind: string, name: string, input: Record<string, unknown>) =>
  runVerb({ pool, registry: reg() }, caller, name, { mind_id: mind, ...input }) as Promise<any>;
const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);

beforeEach(async () => {
  if (pool) await closePool(pool);
  const admin = await resetDatabase();
  await closePool(admin);
  pool = appPool();
});

afterAll(async () => {
  if (pool) await closePool(pool);
});

async function seed(): Promise<{ eventId: string }> {
  await V(alpha, "alpha", "mind_identity", { operation: "affirm", section: "core", content: "I am steady" });
  await V(alpha, "alpha", "mind_vow", { operation: "make", vow: "keep my word" });
  await V(alpha, "alpha", "mind_state", { operation: "set", mood: "calm" });
  await V(alpha, "alpha", "mind_loop", { operation: "create", label: "slow one" });
  await V(alpha, "alpha", "mind_loop", { operation: "create", label: "hot one", urgency: "burning" });
  await V(alpha, "alpha", "mind_relate", { operation: "set", subject: "beta", state: "warm" });
  await V(alpha, "alpha", "mind_anchor", { operation: "create", trigger: "storm", response: "breathe" });
  await V(alpha, "alpha", "mind_desire", { operation: "register", want: "a long walk" });
  await V(beta, "beta", "mind_letter", { operation: "send", to: "alpha", subject: "hi", body: "secret body text" });
  const w = await V(alpha, "alpha", "mind_write", { type: "note", text: "something to hold" });
  expect(w.ok).toBe(true);
  const eventId = w.receipt.event_id as string;
  const s = await V(alpha, "alpha", "mind_sit", { subject_id: eventId, state: "active" });
  expect(s.ok).toBe(true);
  return { eventId };
}

const keys = (r: any) => Object.keys(r.receipt.projection.sections);
const clean = (section: unknown) => {
  expect(section).not.toHaveProperty("error");
  expect(section).not.toHaveProperty("skipped");
};

describe("mind_orient", () => {
  it("orientation returns exactly its five sections, in order", async () => {
    await seed();
    const r = await run(reg(), alpha, { mind_id: "alpha", depth: "orientation" });
    expect(r.ok).toBe(true);
    expect(r.receipt.event_id).toBeUndefined();
    expect(keys(r)).toEqual(ORDER.orientation);
    const p = r.receipt.projection;
    expect(p).toMatchObject({ mind_id: "alpha", depth: "orientation", context: null });
    expect(Number.isNaN(Date.parse(p.as_of))).toBe(false);
    expect(p.sections.identity.cores).toHaveLength(1);
    expect(p.sections.vows.vows).toHaveLength(1);
    expect(p.sections.health.counts.events).toBeGreaterThan(0);
    for (const k of ORDER.orientation) clean(p.sections[k]);
    expect(p.sections.handoff).toHaveProperty("handoff");
  });

  it("quick is the default and adds the nine", async () => {
    await seed();
    const r = await run(reg(), alpha, { mind_id: "alpha" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.depth).toBe("quick");
    expect(keys(r)).toEqual([...ORDER.orientation, ...ORDER.quick]);
    const s = r.receipt.projection.sections;
    // burning loop first
    expect(s.loops.loops.map((l: any) => l.label)).toEqual(["hot one", "slow one"]);
    for (const k of ORDER.quick) clean(s[k]);
    expect(s.anchors.anchors).toHaveLength(1);
    // inbox: letters without bodies
    expect(s.inbox.letters).toHaveLength(1);
    expect(s.inbox.letters[0]).not.toHaveProperty("body");
    expect(JSON.stringify(s.inbox)).not.toContain("secret body text");
  });

  it("full adds desires, holdings and recent", async () => {
    const { eventId } = await seed();
    const r = await run(reg(), alpha, { mind_id: "alpha", depth: "full", limits: { recent: 3 } });
    expect(r.ok).toBe(true);
    expect(keys(r)).toEqual([...ORDER.orientation, ...ORDER.quick, ...ORDER.full]);
    const s = r.receipt.projection.sections;
    expect(s.desires.desires).toHaveLength(1);
    expect(s.holdings.holdings).toHaveLength(1);
    expect(s.holdings.holdings[0]).toMatchObject({ subject_id: eventId, state: "active" });
    expect(s.recent.events).toHaveLength(3);
    const seqs = s.recent.events.map((e: any) => Number(e.seq));
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    expect(Object.keys(s.recent.events[0]).sort()).toEqual(["context", "created_at", "id", "kind", "payload", "seq"]);
  });

  it("passes context through to the lane-aware sections", async () => {
    await V(alpha, "alpha", "mind_observe", { content: "in a", context: "lane-a", texture: { charge: ["tender"] } });
    await V(alpha, "alpha", "mind_observe", { content: "in b", context: "lane-b", texture: { charge: ["fierce"] } });
    await V(alpha, "alpha", "mind_handoff", { operation: "write", context: "lane-a", handoff: { tone: "a-tone" } });
    await V(alpha, "alpha", "mind_handoff", { operation: "write", context: "lane-b", handoff: { tone: "b-tone" } });
    await V(alpha, "alpha", "mind_drive", { operation: "nudge", context: "lane-a", drive: "play", axis: "intensity", delta: 3 });
    const r = await run(reg(), alpha, { mind_id: "alpha", depth: "quick", context: "lane-a" });
    expect(r.ok).toBe(true);
    const s = r.receipt.projection.sections;
    expect(r.receipt.projection.context).toBe("lane-a");
    for (const k of ["handoff", "drives", "weather"]) clean(s[k]);
    expect(s.weather.charge_counts).toEqual({ tender: 1 });
    // lane-a only: its observe, handoff.write and drive.nudge, nothing from lane-b
    expect(s.weather.event_count).toBe(3);
    expect(s.weather.textured_count).toBe(1);
    expect(s.handoff.handoff.handoff).toEqual({ tone: "a-tone" });
    expect(s.drives.context).toBe("lane-a");
    expect(s.drives.drives.find((d: any) => d.drive === "play").intensity).toBeGreaterThan(5);
  });

  it("refuses to compose a section whose verb is not read-scoped", async () => {
    let called = false;
    const writer = defineVerb({
      name: "mind_anchor",
      description: "stub",
      schema: mind_anchor.schema,
      scopeFor: () => "write",
      handler: async () => {
        called = true;
        return err("storage", "must not run");
      },
    }) as unknown as Verb;
    const r = await run(reg(writer), alpha, { mind_id: "alpha", depth: "quick" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.sections.anchors).toEqual({ error: { code: "forbidden", message: "section is not read-scoped" } });
    expect(called).toBe(false);
    clean(r.receipt.projection.sections.vows);
  });

  it("does not accept session_id", async () => {
    expect((await run(reg(), alpha, { mind_id: "alpha", session_id: "s" })).error.field).toBe("session_id");
  });

  it("a registry missing mind_weather yields skipped for that section only", async () => {
    await seed();
    const registry = reg().filter((v) => v.name !== "mind_weather");
    const r = await run(registry, alpha, { mind_id: "alpha", depth: "quick" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.sections.weather).toEqual({ skipped: "not registered" });
    expect(r.receipt.projection.sections.vows.vows).toHaveLength(1);
    clean(r.receipt.projection.sections.drives);
    expect(keys(r)).toEqual([...ORDER.orientation, ...ORDER.quick]);
  });

  it("a section whose verb returns an error yields error and the wake still succeeds", async () => {
    await seed();
    const boom = defineVerb({
      name: "mind_vow",
      description: "stub",
      schema: mind_vow.schema,
      scopeFor: () => "read",
      handler: async () => err("storage", "boom"),
    }) as unknown as Verb;
    const registry = reg().filter((v) => v.name !== "mind_vow").concat(boom);
    const r = await run(registry, alpha, { mind_id: "alpha", depth: "quick" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.sections.vows).toEqual({ error: { code: "storage", message: "boom" } });
    expect(r.receipt.projection.sections.identity.cores).toHaveLength(1);
    clean(r.receipt.projection.sections.identity);
    expect(keys(r)).toEqual([...ORDER.orientation, ...ORDER.quick]);
  });

  it("surfaces invalid_input when the constructed input drifts from a verb's schema", async () => {
    const drifted = defineVerb({
      name: "mind_state",
      description: "stub",
      schema: z.strictObject({ mind_id: mindIdSchema, operation: z.literal("never") }),
      scopeFor: () => "read",
      handler: async () => err("storage", "unreachable"),
    }) as unknown as Verb;
    const registry = reg().filter((v) => v.name !== "mind_state").concat(drifted);
    const r = await run(registry, alpha, { mind_id: "alpha", depth: "orientation" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.sections.state.error.code).toBe("invalid_input");
    expect(r.receipt.projection.sections.vows).toHaveProperty("vows");
    clean(r.receipt.projection.sections.vows);
  });

  it("a section that throws becomes a storage error and later sections still run", async () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      const thrower = defineVerb({
        name: "mind_vow",
        description: "stub",
        schema: mind_vow.schema,
        scopeFor: () => "read",
        handler: async (ctx) => {
          await ctx.tx.query("select * from no_such_table");
          return err("storage", "unreachable");
        },
      }) as unknown as Verb;
      const registry = reg().filter((v) => v.name !== "mind_vow").concat(thrower);
      const r = await run(registry, alpha, { mind_id: "alpha", depth: "orientation" });
      expect(r.ok).toBe(true);
      const s = r.receipt.projection.sections;
      expect(s.vows).toEqual({ error: { code: "storage", message: "section failed" } });
      expect(s.state === null || !("error" in s.state)).toBe(true);
      expect(s.health.counts).toBeDefined();
    } finally {
      console.error = quiet;
    }
  });

  it("a read grantee may orient another mind; a stranger may not", async () => {
    await seed();
    const r = await run(reg(), betaRead, { mind_id: "alpha", depth: "full" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.sections.vows.vows).toHaveLength(1);
    const denied = await run(reg(), beta, { mind_id: "alpha" });
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("forbidden");
  });

  it("RLS: holdings and recent show only the target mind's own rows", async () => {
    const { eventId } = await seed();
    await V(beta, "beta", "mind_write", { type: "note", text: "beta's own" });
    const b = await run(reg(), beta, { mind_id: "beta", depth: "full" });
    expect(b.ok).toBe(true);
    expect(b.receipt.projection.sections.holdings.holdings).toEqual([]);
    const recent = b.receipt.projection.sections.recent.events;
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((e: any) => e.id !== eventId)).toBe(true);
    const mine = await q("beta", "select id from events");
    expect(recent.map((e: any) => e.id).sort()).toEqual(mine.map((e) => e.id).sort());
    const a = await run(reg(), alpha, { mind_id: "alpha", depth: "full" });
    expect(a.receipt.projection.sections.holdings.holdings).toHaveLength(1);
    expect(a.receipt.projection.sections.recent.events.some((e: any) => e.payload?.text === "beta's own")).toBe(false);
  });

  it("writes no event and mutates no row", async () => {
    await seed();
    const before = await q("alpha", "select (select count(*) from events) e, (select count(*) from nodes) n, (select count(*) from holdings) h");
    for (const depth of ["orientation", "quick", "full"]) {
      expect((await run(reg(), alpha, { mind_id: "alpha", depth })).ok).toBe(true);
    }
    const after = await q("alpha", "select (select count(*) from events) e, (select count(*) from nodes) n, (select count(*) from holdings) h");
    expect(after).toEqual(before);
  });

  it("is strict about input", async () => {
    const r = await run(reg(), alpha, { mind_id: "alpha", depth: "deep" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect((await run(reg(), alpha, { mind_id: "alpha", extra: 1 })).error.field).toBe("extra");
    expect((await run(reg(), alpha, { mind_id: "alpha", limits: { loops: 0 } })).ok).toBe(false);
  });
});
