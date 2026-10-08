import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { z } from "zod";
import { err } from "../src/result.js";
import { appendEvent } from "../src/verbs/common.js";
import { defineVerb } from "../src/verbs/types.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import type { Caller } from "../src/verbs/types.js";

const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: { alpha: ["read"] } };

let pool: Pool;
const run = (caller: Caller, name: string, input: unknown) =>
  runVerb({ pool, registry }, caller, name, input);

async function eventCount(mind: string): Promise<number> {
  return withMind(pool, mind, mind, "read", async (tx) => {
    const r = await tx.query<{ n: string }>("select count(*) as n from events");
    return Number(r.rows[0]!.n);
  });
}

beforeEach(async () => {
  if (pool) await closePool(pool);
  const admin = await resetDatabase();
  await closePool(admin);
  pool = appPool();
});

afterAll(async () => {
  if (pool) await closePool(pool);
});

function proj(r: any): any {
  expect(r.ok).toBe(true);
  return r.receipt.projection;
}

describe("mind_state", () => {
  it("set with mood and energy returns a receipt", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "calm", energy: "high" });
    expect(r.ok).toBe(true);
    expect(typeof r.receipt.event_id).toBe("string");
    expect(r.receipt.projection.mood).toBe("calm");
    expect(r.receipt.projection.energy).toBe("high");
    expect(r.receipt.projection.last_event_id).toBe(r.receipt.event_id);
  });

  it("update with only register preserves mood", async () => {
    await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "calm", energy: "high" });
    const r = await run(alpha, "mind_state", { mind_id: "alpha", operation: "update", register: "quiet" });
    const p = proj(r);
    expect(p.mood).toBe("calm");
    expect(p.energy).toBe("high");
    expect(p.register).toBe("quiet");
  });

  it("read returns the row and appends no event", async () => {
    await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "calm" });
    const before = await eventCount("alpha");
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "read" });
    expect(proj(r).mood).toBe("calm");
    expect(r.receipt.event_id).toBeUndefined();
    expect(await eventCount("alpha")).toBe(before);
  });

  it("read with no row returns null projection", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "read" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toBeNull();
  });

  it("set with no fields is invalid_input", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "set" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
  });

  it("invalid energy is invalid_input with field energy", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", energy: "huge" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("energy");
  });

  it("beta set on alpha is forbidden and writes nothing", async () => {
    const r: any = await run(beta, "mind_state", { mind_id: "alpha", operation: "set", mood: "x" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("forbidden");
    expect(await eventCount("alpha")).toBe(0);
  });

  it("beta read on alpha is ok with a read grant", async () => {
    await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "calm" });
    const r: any = await run(beta, "mind_state", { mind_id: "alpha", operation: "read" });
    expect(proj(r).mood).toBe("calm");
  });

  it("bad mind_id is invalid_input with field mind_id", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "bad id!", operation: "read" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("mind_id");
  });
});

describe("strict schemas and text", () => {
  it("an unknown field is invalid_input naming that field", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "ok", enrgy: "low" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("enrgy");
    expect(await eventCount("alpha")).toBe(0);
  });

  it("an unknown field on mind_health is rejected too", async () => {
    const r: any = await run(alpha, "mind_health", { mind_id: "alpha", extra: 1 });
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("extra");
  });

  it("a NUL byte is invalid_input on the field, not a storage error", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "a\u0000b" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("mood");
  });

  it("text over 4000 chars is invalid_input", async () => {
    const r: any = await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", note: "x".repeat(4001) });
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.field).toBe("note");
  });

  it("reserved mind ids are invalid_input", async () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      const r: any = await run(alpha, "mind_state", { mind_id: id, operation: "read" });
      expect(r.error.code).toBe("invalid_input");
      expect(r.error.field).toBe("mind_id");
    }
  });
});

describe("transactions and ordering", () => {
  it("a read grantee calling set on another mind is forbidden and writes nothing", async () => {
    const r: any = await run(beta, "mind_state", { mind_id: "alpha", operation: "update", note: "x" });
    expect(r.error.code).toBe("forbidden");
    expect(await eventCount("alpha")).toBe(0);
  });

  it("a handler returning ok:false rolls back its event", async () => {
    const failing = defineVerb({
      name: "mind_failing",
      description: "test only",
      schema: z.strictObject({ mind_id: z.string() }),
      scopeFor: () => "write",
      handler: async (ctx) => {
        await appendEvent(ctx, { kind: "test.event", payload: {} });
        return err("conflict", "nope");
      },
    });
    const r: any = await runVerb({ pool, registry: [failing] }, alpha, "mind_failing", { mind_id: "alpha" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("conflict");
    expect(await eventCount("alpha")).toBe(0);
  });

  it("concurrent sets leave the projection pointing at the highest-seq event", async () => {
    const moods = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const results: any[] = await Promise.all(
      moods.map((mood) => run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const { latest, state, ordered } = await withMind(pool, "alpha", "alpha", "read", async (tx) => {
      const latest = (await tx.query("select id, payload from events order by seq desc limit 1")).rows[0];
      const state = (await tx.query("select last_event_id, mood, updated_at from brain_state")).rows[0];
      const ev = (await tx.query("select created_at from events order by seq")).rows;
      const ordered = ev.every((e, i) => i === 0 || ev[i - 1].created_at <= e.created_at);
      return { latest, state, ordered };
    });
    expect(state.last_event_id).toBe(latest.id);
    expect(state.mood).toBe(latest.payload.mood);
    expect(ordered).toBe(true);
  });
});

describe("runner", () => {
  it("unknown verb is not_found", async () => {
    const r: any = await run(alpha, "mind_nope", { mind_id: "alpha" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("not_found");
  });
});

describe("mind_health", () => {
  it("counts only the target mind's rows", async () => {
    await run(alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "calm" });
    const a = proj(await run(alpha, "mind_health", { mind_id: "alpha" }));
    expect(a.db).toBe("up");
    expect(a.mind_id).toBe("alpha");
    expect(a.counts).toEqual({ events: 1, nodes: 0, edges: 0 });
    const b = proj(await run(beta, "mind_health", { mind_id: "beta" }));
    expect(b.counts.events).toBe(0);
  });

  it("appends no event", async () => {
    await run(alpha, "mind_health", { mind_id: "alpha" });
    expect(await eventCount("alpha")).toBe(0);
  });
});
