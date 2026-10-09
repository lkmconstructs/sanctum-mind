// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { FAKE_EMBEDDER } from "./fake-embedder.js";
import { ALL_PASSES, MODEL_PASSES, PASSES, loadDaemonConfig, runDaemonOnce, startDaemon, type DaemonPass, type RunReport } from "../src/daemon/index.js";
import type { Caller, Embedder } from "../src/verbs/types.js";

const alpha: Caller = { bearer: "alpha", grants: {} };
const DAY = 86_400_000;
const HOUR = 3_600_000;

let pool: Pool;
let admin: Pool;
let NOW = new Date();
const at = (days: number, from: Date = NOW) => new Date(from.getTime() - days * DAY);

const daemon = (opts: Parameters<typeof runDaemonOnce>[1] = { trigger: "manual" }, embedder: Embedder = NONE_EMBEDDER, now: Date = NOW) =>
  runDaemonOnce({ pool, embedder, now: () => now }, opts);
const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const events = (mind: string, kind: string) =>
  q(mind, `select * from events where mind_id = $1 and kind = $2 order by seq`, [mind, kind]);
const passOf = (reports: RunReport[], mind: string, name: string) =>
  reports.find((r) => r.mind_id === mind)!.passes.find((p) => p.pass === name)!;

/** Fixture rows go in as the superuser with explicit timestamps; the daemon under test uses the app role. */
async function mkEvent(mind: string, kind: string, created: Date, extra: { text?: string; writtenBy?: string } = {}): Promise<string> {
  const r = await admin.query(
    `insert into events (mind_id, kind, payload, written_by, recorded_at, created_at)
     values ($1, $2, $3::jsonb, $4, $5, $5) returning id`,
    [mind, kind, JSON.stringify(extra.text ? { text: extra.text } : {}), extra.writtenBy ?? mind, created],
  );
  return r.rows[0].id;
}
async function mkLoop(mind: string, label: string, urgency: string, created: Date, resolved = false): Promise<string> {
  const ev = await mkEvent(mind, "loop.create", created);
  const r = await admin.query(
    `insert into loops (mind_id, label, urgency, created_event_id, created_at, resolved_at) values ($1, $2, $3, $4, $5, $6) returning id`,
    [mind, label, urgency, ev, created, resolved ? created : null],
  );
  return r.rows[0].id;
}
async function mkHolding(mind: string, state: string, updated: Date): Promise<string> {
  const ev = await mkEvent(mind, "sit", updated);
  const subject = await mkEvent(mind, "note", updated);
  await admin.query(
    `insert into holdings (mind_id, subject_id, subject_kind, state, note, last_event_id, updated_at) values ($1, $2, 'event', $3, 'n', $4, $5)`,
    [mind, subject, state, ev, updated],
  );
  return subject;
}
async function mkNode(mind: string, type: string, label: string, created: Date, metadata: object = {}, writtenBy = mind): Promise<string> {
  const r = await admin.query(
    `insert into nodes (mind_id, node_type, label, content, written_by, metadata, created_at) values ($1, $2, $3, $3, $4, $5::jsonb, $6) returning id`,
    [mind, type, label, writtenBy, JSON.stringify(metadata), created],
  );
  return r.rows[0].id;
}
async function mkLetter(from: string, to: string, sent: Date, read = false): Promise<string> {
  const ev = await mkEvent(from, "letter.send", sent);
  const r = await admin.query(
    `insert into letters (from_mind, to_mind, letter_type, subject, body, sent_event_id, sent_at, read_at) values ($1, $2, 'personal', 's', 'b', $3, $4, $5) returning id`,
    [from, to, ev, sent, read ? sent : null],
  );
  return r.rows[0].id;
}
async function mkDrive(mind: string, context: string, drive: string, intensity: number, updated: Date): Promise<void> {
  const ev = await mkEvent(mind, "drive.nudge", updated);
  await admin.query(
    `insert into drive_state (mind_id, context, drive, intensity, frustration, satisfaction, baseline_intensity, baseline_frustration, baseline_satisfaction, last_event_id, updated_at)
     values ($1, $2, $3, $4, 2, 5, 5, 2, 5, $5, $6)`,
    [mind, context, drive, intensity, ev, updated],
  );
}

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  NOW = new Date();
});

afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

describe("runner", () => {
  it("runs the twelve deterministic passes in spec order, then the two model-backed ones, and records a daemon_runs row per mind", async () => {
    expect(PASSES.map((p) => p.name)).toEqual([
      "drives.decay", "context.expire", "loops.stale", "holdings.settle",
      "desires.fade", "identity.settle", "graph.orphans", "embeddings.backfill", "outbox.deliver", "letters.expire", "notice.expire", "notice.repair",
    ]);
    expect(MODEL_PASSES.map((p) => p.name)).toEqual(["notice.extract", "notice.train"]);
    expect(ALL_PASSES.map((p) => p.name)).toEqual([...PASSES, ...MODEL_PASSES].map((p) => p.name));
    const reports = await daemon({ trigger: "timer" });
    expect(reports.map((r) => r.mind_id)).toEqual(["alpha", "beta"]);
    for (const r of reports) {
      expect(r.ok).toBe(true);
      expect(r.passes.map((p) => p.pass)).toEqual(ALL_PASSES.map((p) => p.name));
    }
    const runs = await q("alpha", `select * from daemon_runs`);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("timer");
    expect(runs[0].finished_at).not.toBeNull();
    expect(runs[0].passes).toHaveLength(14);
    expect(runs[0].passes.every((p: any) => p.ok === true && typeof p.ms === "number" && p.changed === 0)).toBe(true);
  });

  it("a pass that throws is recorded ok:false (rolled back) and the following passes still run and commit", async () => {
    const boom: DaemonPass = {
      name: "test.boom",
      async run(ctx) {
        await ctx.tx.query(
          `insert into events (mind_id, kind, payload, written_by, recorded_at) values ($1, 'daemon.test.rolledback', '{}', $1, now())`,
          [ctx.mind_id],
        );
        throw new Error("secret detail\nwith newline");
      },
    };
    const after: DaemonPass = {
      name: "test.after",
      async run(ctx) {
        await ctx.tx.query(
          `insert into events (mind_id, kind, payload, written_by, recorded_at) values ($1, 'daemon.test.committed', '{}', $1, now())`,
          [ctx.mind_id],
        );
        return { changed: 1 };
      },
    };
    const reports = await daemon({ trigger: "manual", minds: ["alpha"], passes: [boom, after] });
    const r = reports[0]!;
    expect(r.ok).toBe(false);
    expect(r.passes.map((p) => [p.pass, p.ok])).toEqual([["test.boom", false], ["test.after", true]]);
    expect(r.passes[0]!.error).toBe("secret detail with newline");
    expect(await events("alpha", "daemon.test.rolledback")).toHaveLength(0);
    expect(await events("alpha", "daemon.test.committed")).toHaveLength(1);
    const run = (await q("alpha", `select * from daemon_runs`))[0];
    expect(run.passes.map((p: any) => [p.pass, p.ok])).toEqual([["test.boom", false], ["test.after", true]]);
    expect(run.passes[0].error).toBeTypeOf("string");
  });

  it("a database failure is reported as a sanitised code, not row data", async () => {
    const dbFail: DaemonPass = {
      name: "test.db",
      async run(ctx) {
        await ctx.tx.query(`select * from table_that_does_not_exist`);
        return { changed: 0 };
      },
    };
    const r = (await daemon({ trigger: "manual", minds: ["alpha"], passes: [dbFail] }))[0]!;
    expect(r.passes[0]).toMatchObject({ ok: false, error: "database error 42P01" });
  });

  it("two concurrent runs on one mind do not double-apply and both complete", async () => {
    await mkLoop("alpha", "old nag", "nagging", at(20));
    const [a, b] = await Promise.all([daemon({ trigger: "manual", minds: ["alpha"] }), daemon({ trigger: "manual", minds: ["alpha"] })]);
    expect(a[0]!.ok && b[0]!.ok).toBe(true);
    expect(await events("alpha", "daemon.loop.stale")).toHaveLength(1);
    const total = passOf(a, "alpha", "loops.stale").changed + passOf(b, "alpha", "loops.stale").changed;
    expect(total).toBe(1);
    expect(await q("alpha", `select 1 from daemon_runs`)).toHaveLength(2);
  });

  it("skips disabled minds and honours the minds filter", async () => {
    await admin.query(`update minds set disabled_at = now() where mind_id = 'beta'`);
    expect((await daemon()).map((r) => r.mind_id)).toEqual(["alpha"]);
    await admin.query(`update minds set disabled_at = null where mind_id = 'beta'`);
    expect((await daemon({ trigger: "manual", minds: ["beta"] })).map((r) => r.mind_id)).toEqual(["beta"]);
    expect(await q("beta", `select 1 from daemon_runs`)).toHaveLength(1);
  });

  it("RLS: a run for alpha never touches beta's rows, and daemon_runs is mind-only", async () => {
    await mkLoop("beta", "beta nag", "nagging", at(20));
    await mkLoop("alpha", "alpha nag", "nagging", at(20));
    await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(await events("alpha", "daemon.loop.stale")).toHaveLength(1);
    expect(await events("beta", "daemon.loop.stale")).toHaveLength(0);
    expect(await q("beta", `select 1 from daemon_runs`)).toHaveLength(0);
    const wrong = await withMind(pool, "beta", "beta", "read", async (tx) =>
      (await tx.query(`select 1 from daemon_runs where mind_id = 'alpha'`)).rows,
    );
    expect(wrong).toHaveLength(0);
    // and the full run keeps each mind's work in its own ledger, authored by that mind
    await daemon();
    const all = await admin.query(`select mind_id, written_by, kind from events where kind like 'daemon.%'`);
    expect(all.rows.length).toBeGreaterThan(0);
    for (const e of all.rows) expect(e.written_by).toBe(e.mind_id);
    expect(await events("beta", "daemon.loop.stale")).toHaveLength(1);
  });

  it("never throws: an invalid config override yields a failed run-level report", async () => {
    const reports = await daemon({ trigger: "manual", config: { loopStaleDays: 0 } });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ mind_id: "*", ok: false });
    expect(reports[0]!.error).toContain("loopStaleDays");
    const dead = await runDaemonOnce({ pool: { query: async () => { throw new Error("down"); } } as unknown as Pool, embedder: NONE_EMBEDDER }, { trigger: "manual" });
    expect(dead[0]!.ok).toBe(false);
  });

  it("startDaemon ticks once immediately with trigger timer and stops cleanly", async () => {
    let resolveSeen!: (r: RunReport[]) => void;
    const seen = new Promise<RunReport[]>((resolve) => (resolveSeen = resolve));
    const h = startDaemon({ pool, embedder: NONE_EMBEDDER, now: () => NOW }, { intervalMinutes: 60, onRun: (r) => resolveSeen(r) });
    const reports = await seen;
    await h.stop();
    expect(reports.map((r) => r.mind_id)).toEqual(["alpha", "beta"]);
    expect((await q("alpha", `select trigger from daemon_runs`))[0].trigger).toBe("timer");
    expect(() => startDaemon({ pool, embedder: NONE_EMBEDDER }, { intervalMinutes: 0 })).toThrow();
  });
});

describe("config", () => {
  it("reads DAEMON_* env with positive-integer validation", () => {
    expect(loadDaemonConfig({}).loopStaleDays).toBe(14);
    expect(loadDaemonConfig({ DAEMON_LOOP_STALE_DAYS: "3", DAEMON_BACKFILL_ROWS: " 10 " })).toMatchObject({ loopStaleDays: 3, backfillRows: 10 });
    for (const bad of ["0", "-1", "1.5", "abc", "1e3"]) {
      expect(() => loadDaemonConfig({ DAEMON_LOOP_STALE_DAYS: bad })).toThrow(/DAEMON_LOOP_STALE_DAYS/);
    }
  });
});

describe("tick budget and fair rotation across minds", () => {
  it("DAEMON_TICK_BUDGET_MS defaults to 0 (unlimited), accepts 0 and whole milliseconds, and refuses the rest", () => {
    expect(loadDaemonConfig({}).tickBudgetMs).toBe(0);
    expect(loadDaemonConfig({ DAEMON_TICK_BUDGET_MS: "0" }).tickBudgetMs).toBe(0);
    expect(loadDaemonConfig({ DAEMON_TICK_BUDGET_MS: " 1500 " }).tickBudgetMs).toBe(1500);
    for (const bad of ["-1", "1.5", "abc", "1e3", "90000000"]) expect(() => loadDaemonConfig({ DAEMON_TICK_BUDGET_MS: bad })).toThrow(/DAEMON_TICK_BUDGET_MS/);
  });

  it("with a budget the minds are processed in rotating order, the rest wait with a note, and the next tick starts after the last one processed (fake clock)", async () => {
    await admin.query("insert into minds (mind_id, key_hash, display_name) values ('gamma', 'g', 'Gamma')");
    let clock = new Date("2026-06-15T12:00:00.000Z");
    const ran: string[] = [];
    // a pass that takes one second of the fake clock
    const slow: DaemonPass = { name: "test.slow", async run(ctx) { ran.push(ctx.mind_id); clock = new Date(clock.getTime() + 1000); return { changed: 0 }; } };
    const rotation = { last: null as string | null };
    const tick = () => runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => clock, rotation }, { trigger: "manual", passes: [slow], config: { tickBudgetMs: 1500 } });

    const t1 = await tick();
    expect(ran.splice(0)).toEqual(["alpha", "beta"]); // 1000 ms used after alpha, under 1500: beta runs; 2000 used: gamma waits
    expect(t1.map((r) => [r.mind_id, r.deferred === true])).toEqual([["alpha", false], ["beta", false], ["gamma", true]]);
    expect(t1[2]!.note).toMatch(/tick budget \(1500 ms\) spent: 1 mind\(s\) wait for the next tick, which starts at gamma/);
    expect(t1[2]!.passes).toEqual([]);
    expect(rotation.last).toBe("beta");

    const t2 = await tick();
    expect(ran.splice(0)).toEqual(["gamma", "alpha"]); // starts after beta
    expect(t2.map((r) => [r.mind_id, r.deferred === true])).toEqual([["gamma", false], ["alpha", false], ["beta", true]]);

    const t3 = await tick();
    expect(ran.splice(0)).toEqual(["beta", "gamma"]);
    expect(t3.filter((r) => r.deferred).map((r) => r.mind_id)).toEqual(["alpha"]);

    // every mind ran in two of three ticks: nobody starves
    // at least one mind always runs, however small the budget
    const t4 = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => clock, rotation }, { trigger: "manual", passes: [slow], config: { tickBudgetMs: 1 } });
    expect(t4.filter((r) => !r.deferred)).toHaveLength(1);
    expect(t4.filter((r) => r.deferred)).toHaveLength(2);
    ran.length = 0;

    // no budget (the default), or no rotation object: everyone runs, in order, every time
    const all = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => clock }, { trigger: "manual", passes: [slow] });
    expect(all.map((r) => r.mind_id)).toEqual(["alpha", "beta", "gamma"]);
    expect(all.some((r) => r.deferred)).toBe(false);
  });
});

describe("drives.decay", () => {
  it("persists decay for lanes with a row older than an hour, one drive.decay event per lane; young lanes are untouched", async () => {
    await mkDrive("alpha", "", "play", 9, new Date(NOW.getTime() - 3 * HOUR));
    await mkDrive("alpha", "work", "play", 9, new Date(NOW.getTime() - 10 * 60_000));
    await mkDrive("beta", "", "play", 9, new Date(NOW.getTime() - 3 * HOUR));
    const reports = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(reports, "alpha", "drives.decay").changed).toBe(8);
    const ev = await events("alpha", "drive.decay");
    expect(ev).toHaveLength(1);
    expect(ev[0].written_by).toBe("alpha");
    const row = (await q("alpha", `select intensity, updated_at from drive_state where context = '' and drive = 'play'`))[0];
    expect(row.intensity).toBeCloseTo(5 + 4 * Math.pow(0.5, 3 / 24), 9);
    expect(row.updated_at.getTime()).toBe(NOW.getTime());
    const work = (await q("alpha", `select intensity from drive_state where context = 'work'`));
    expect(work).toHaveLength(1);
    expect(work[0].intensity).toBe(9);
    // beta untouched, and a second run is a no-op
    expect(await q("beta", `select intensity from drive_state`)).toEqual([{ intensity: 9 }]);
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }), "alpha", "drives.decay").changed).toBe(0);
    expect(await events("alpha", "drive.decay")).toHaveLength(1);
  });

  it("matches `mind_drive decay` (one code path)", async () => {
    await mkDrive("alpha", "", "care", 1, new Date(NOW.getTime() - 5 * HOUR));
    const viaVerb = (await runVerb({ pool, registry, now: () => NOW }, alpha, "mind_drive", { mind_id: "alpha", operation: "decay" })) as any;
    expect(viaVerb.ok).toBe(true);
    const verbVal = (await q("alpha", `select intensity from drive_state where drive = 'care'`))[0].intensity;
    expect(verbVal).toBeCloseTo(5 - 4 * Math.pow(0.5, 5 / 24), 9);
  });
});

describe("drives.decay baselines", () => {
  it("skips a lane that is already at its baselines, with no event", async () => {
    // intensity 5, frustration 2, satisfaction 5 are the baselines in mkDrive
    await mkDrive("alpha", "", "play", 5, new Date(NOW.getTime() - 3 * HOUR));
    const r = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(r, "alpha", "drives.decay")).toMatchObject({ ok: true, changed: 0 });
    expect(await events("alpha", "drive.decay")).toHaveLength(0);
    // a lane that has not yet decayed to its baselines still persists
    await mkDrive("alpha", "work", "play", 9, new Date(NOW.getTime() - 3 * HOUR));
    const r2 = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(r2, "alpha", "drives.decay").changed).toBe(8);
    expect(await events("alpha", "drive.decay")).toHaveLength(1);
    // a value that decayed to within 1e-6 of its baseline over a long time also counts as at baseline
    await mkDrive("alpha", "old", "play", 9, new Date(NOW.getTime() - 24 * 40 * HOUR));
    const r3 = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(r3, "alpha", "drives.decay").changed).toBe(0);
    expect(await events("alpha", "drive.decay")).toHaveLength(1);
  });
});

describe("context.expire", () => {
  it("clears expired keys with one event listing them; live and already-cleared keys are untouched", async () => {
    const ev = await mkEvent("alpha", "context.set", at(1));
    const put = (key: string, expires: Date | null, cleared: Date | null = null) =>
      admin.query(
        `insert into kv_contexts (mind_id, key, value, expires_at, last_event_id, updated_at, cleared_at) values ('alpha', $1, '1', $2, $3, $4, $5)`,
        [key, expires, ev, at(1), cleared],
      );
    await put("old-a", at(0.5));
    await put("old-b", new Date(NOW.getTime() - 1000));
    await put("live", new Date(NOW.getTime() + HOUR));
    await put("forever", null);
    await put("done", at(0.5), at(0.4));
    await mkEvent("beta", "context.set", at(1));
    const reports = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(reports, "alpha", "context.expire").changed).toBe(2);
    const evs = await events("alpha", "daemon.context.expire");
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.keys).toEqual(["old-a", "old-b"]);
    expect(evs[0].written_by).toBe("alpha");
    const rows = await q("alpha", `select key, cleared_at is not null as cleared from kv_contexts order by key`);
    expect(rows.map((r) => [r.key, r.cleared])).toEqual([["done", true], ["forever", false], ["live", false], ["old-a", true], ["old-b", true]]);
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }), "alpha", "context.expire").changed).toBe(0);
    expect(await events("alpha", "daemon.context.expire")).toHaveLength(1);
  });
});

describe("loops.stale", () => {
  it("flags only nagging loops open over 14 days, once per 7 days per loop; resolves nothing", async () => {
    const old = await mkLoop("alpha", "old nag", "nagging", at(15));
    const young = await mkLoop("alpha", "young nag", "nagging", at(13));
    await mkLoop("alpha", "burning", "burning", at(30));
    await mkLoop("alpha", "resolved", "nagging", at(30), true);
    await mkLoop("beta", "beta nag", "nagging", at(30));

    const r1 = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(r1, "alpha", "loops.stale").changed).toBe(1);
    const ev = await events("alpha", "daemon.loop.stale");
    expect(ev).toHaveLength(1);
    expect(ev[0].subject_id).toBe(old);
    expect(ev[0].payload).toEqual({ loop_id: old, age_days: 15 });
    expect(ev[0].written_by).toBe("alpha");

    // dedupe: inside the 7 day window nothing more is written for the old loop
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }, NONE_EMBEDDER, new Date(NOW.getTime() + 6 * DAY)), "alpha", "loops.stale").changed).toBe(1); // the young loop crossed 14d
    const later = await events("alpha", "daemon.loop.stale");
    expect(later.map((e) => e.subject_id).sort()).toEqual([old, young].sort());

    // after the window the old loop is flagged again
    const r3 = await daemon({ trigger: "manual", minds: ["alpha"] }, NONE_EMBEDDER, new Date(NOW.getTime() + 8 * DAY));
    expect(passOf(r3, "alpha", "loops.stale").changed).toBe(1);
    expect((await events("alpha", "daemon.loop.stale")).filter((e) => e.subject_id === old)).toHaveLength(2);
    expect((await q("alpha", `select count(*)::int as n from loops where resolved_at is null`))[0].n).toBe(3);
  });
});

describe("holdings.settle", () => {
  it("moves active/processing holdings idle over 30 days to deferred with one event each; others are untouched", async () => {
    const a = await mkHolding("alpha", "active", at(31));
    const p = await mkHolding("alpha", "processing", at(45));
    const young = await mkHolding("alpha", "active", at(29));
    const fresh = await mkHolding("alpha", "fresh", at(60));
    const done = await mkHolding("alpha", "metabolized", at(60));
    const other = await mkHolding("beta", "active", at(40));
    const r = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(r, "alpha", "holdings.settle").changed).toBe(2);
    const states = Object.fromEntries((await q("alpha", `select subject_id, state from holdings`)).map((h) => [h.subject_id, h.state]));
    expect(states).toMatchObject({ [a]: "deferred", [p]: "deferred", [young]: "active", [fresh]: "fresh", [done]: "metabolized" });
    expect((await q("beta", `select state from holdings where subject_id = $1`, [other]))[0].state).toBe("active");
    const ev = await events("alpha", "daemon.holding.settle");
    expect(ev.map((e) => e.subject_id).sort()).toEqual([a, p].sort());
    expect(ev.every((e) => e.written_by === "alpha")).toBe(true);
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }), "alpha", "holdings.settle").changed).toBe(0);
    expect(await events("alpha", "daemon.holding.settle")).toHaveLength(2);
  });
});

describe("desires.fade", () => {
  it("fades unfulfilled desires older than 60 days; mind_desire list hides them unless include_fulfilled", async () => {
    const meta = (extra: object = {}) => ({ intensity: 0.5, fulfilled: false, ...extra });
    const old = await mkNode("alpha", "desire", "old wish", at(61), meta());
    const young = await mkNode("alpha", "desire", "young wish", at(59), meta());
    const ful = await mkNode("alpha", "desire", "done wish", at(90), meta({ fulfilled: true }));
    const betaOld = await mkNode("beta", "desire", "beta wish", at(90), meta());
    const r = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(r, "alpha", "desires.fade").changed).toBe(1);
    const nodes = Object.fromEntries((await q("alpha", `select id, metadata from nodes where node_type = 'desire'`)).map((n) => [n.id, n.metadata]));
    expect(nodes[old].faded).toBe(true);
    expect(nodes[old].faded_at).toBe(NOW.toISOString());
    expect(nodes[old].fulfilled).toBe(false);
    expect(nodes[young].faded).toBeUndefined();
    expect(nodes[ful].faded).toBeUndefined();
    expect((await q("beta", `select metadata from nodes where id = $1`, [betaOld]))[0].metadata.faded).toBeUndefined();
    const ev = await events("alpha", "daemon.desire.fade");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ subject_id: old, written_by: "alpha" });

    const list = (include: boolean) =>
      runVerb({ pool, registry, now: () => NOW }, alpha, "mind_desire", { mind_id: "alpha", operation: "list", include_fulfilled: include }) as Promise<any>;
    expect((await list(false)).receipt.projection.desires.map((d: any) => d.id)).toEqual([young]);
    expect((await list(true)).receipt.projection.desires.map((d: any) => d.id).sort()).toEqual([old, young, ful].sort());
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }), "alpha", "desires.fade").changed).toBe(0);
    expect(await events("alpha", "daemon.desire.fade")).toHaveLength(1);
  });
});

describe("graph.orphans", () => {
  it("reports observation nodes older than 7 days with no edges, once per 30 days per node; orient full shows them", async () => {
    const orphan = await mkNode("alpha", "observation", "lonely", at(8));
    const linkedOut = await mkNode("alpha", "observation", "has out edge", at(8));
    const linkedIn = await mkNode("alpha", "observation", "has in edge", at(8));
    await mkNode("alpha", "observation", "too young", at(6));
    await mkNode("alpha", "fact", "not an observation", at(20));
    const invalid = await mkNode("alpha", "observation", "invalidated", at(20));
    await admin.query(`update nodes set invalidated_at = now() where id = $1`, [invalid]);
    await admin.query(
      `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'relates', 'alpha', $1, $2)`,
      [linkedOut, linkedIn],
    );
    await mkNode("beta", "observation", "beta lonely", at(20));

    const r = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(r, "alpha", "graph.orphans").changed).toBe(1);
    const ev = await events("alpha", "daemon.graph.orphan");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ subject_id: orphan, written_by: "alpha", payload: { node_id: orphan, label: "lonely" } });
    expect(await events("beta", "daemon.graph.orphan")).toHaveLength(0);

    // dedupe inside the window, again after it
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }, NONE_EMBEDDER, new Date(NOW.getTime() + 29 * DAY)), "alpha", "graph.orphans").changed).toBe(1); // "too young" crossed 7d; "lonely" not repeated
    expect(await events("alpha", "daemon.graph.orphan")).toHaveLength(2);
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }, NONE_EMBEDDER, new Date(NOW.getTime() + 31 * DAY)), "alpha", "graph.orphans").changed).toBe(1); // lonely again, 31d after its first sighting
    expect((await events("alpha", "daemon.graph.orphan")).filter((e) => e.subject_id === orphan)).toHaveLength(2);

    const orient = (await runVerb({ pool, registry, now: () => NOW }, alpha, "mind_orient", { mind_id: "alpha", depth: "full" })) as any;
    const sec = orient.receipt.projection.sections.orphans;
    expect(sec.events.length).toBe(3);
    expect(sec.events[0].seq > sec.events[1].seq || Number(sec.events[0].seq) > Number(sec.events[1].seq)).toBe(true);
    const quick = (await runVerb({ pool, registry, now: () => NOW }, alpha, "mind_orient", { mind_id: "alpha", depth: "quick" })) as any;
    expect(quick.receipt.projection.sections.orphans).toBeUndefined();
  });

  it("orient shows at most the last 20 sightings", async () => {
    for (let i = 0; i < 25; i++) await mkNode("alpha", "observation", `o${i}`, at(10));
    await daemon({ trigger: "manual", minds: ["alpha"] });
    const orient = (await runVerb({ pool, registry, now: () => NOW }, alpha, "mind_orient", { mind_id: "alpha", depth: "full" })) as any;
    expect(orient.receipt.projection.sections.orphans.events).toHaveLength(20);
  });
});

describe("embeddings.backfill", () => {
  it("embeds this mind's own null-embedding rows, bounded per run; none embedder does nothing", async () => {
    for (let i = 0; i < 3; i++) await mkEvent("alpha", "note", at(1), { text: `event ${i}` });
    await mkNode("alpha", "fact", "a node", at(1));
    await mkEvent("alpha", "note", at(1), { text: "granted write", writtenBy: "beta" });
    await mkEvent("beta", "note", at(1), { text: "beta event" });

    const none = await daemon({ trigger: "manual", minds: ["alpha"] });
    expect(passOf(none, "alpha", "embeddings.backfill")).toMatchObject({ ok: true, changed: 0 });
    expect((await q("alpha", `select count(*)::int n from events where embedding is not null`))[0].n).toBe(0);

    const r1 = await daemon({ trigger: "manual", minds: ["alpha"], config: { backfillRows: 2 } }, FAKE_EMBEDDER);
    expect(passOf(r1, "alpha", "embeddings.backfill").changed).toBe(2);
    const r2 = await daemon({ trigger: "manual", minds: ["alpha"], config: { backfillRows: 2 } }, FAKE_EMBEDDER);
    expect(passOf(r2, "alpha", "embeddings.backfill").changed).toBe(2);
    // 3 events + 1 node = 4 own rows: the two bounded runs took them all
    const r3 = await daemon({ trigger: "manual", minds: ["alpha"] }, FAKE_EMBEDDER);
    expect(passOf(r3, "alpha", "embeddings.backfill").changed).toBe(0);
    expect(passOf(await daemon({ trigger: "manual", minds: ["alpha"] }, FAKE_EMBEDDER), "alpha", "embeddings.backfill").changed).toBe(0);

    const ev = await q("alpha", `select written_by, embedding is not null as e, embedding_model from events where kind = 'note' order by written_by, created_at`);
    const own = ev.filter((e) => e.written_by === "alpha" && e.embedding_model === "fake");
    expect(own).toHaveLength(3);
    expect(ev.find((e) => e.written_by === "beta")!.e).toBe(false); // authored by another mind: left for the whole-database backfill
    expect((await q("alpha", `select embedding_model from nodes where label = 'a node'`))[0].embedding_model).toBe("fake");
    // beta's own row is untouched by alpha's run
    expect((await q("beta", `select embedding is not null as e from events where kind = 'note'`))[0].e).toBe(false);
  });
});

describe("letters.expire", () => {
  it("writes aging events into the RECIPIENT's ledger for letters unread over 90 days, once per 30 days; deletes nothing", async () => {
    const old = await mkLetter("beta", "alpha", at(91));
    await mkLetter("beta", "alpha", at(89));
    await mkLetter("beta", "alpha", at(200), true);
    const toBeta = await mkLetter("alpha", "beta", at(100));

    const r = await daemon();
    expect(passOf(r, "alpha", "letters.expire").changed).toBe(1);
    expect(passOf(r, "beta", "letters.expire").changed).toBe(1);
    const a = await events("alpha", "daemon.letter.aging");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ subject_id: old, written_by: "alpha", mind_id: "alpha" });
    expect(a[0].payload).toMatchObject({ letter_id: old, from: "beta", age_days: 91 });
    const b = await events("beta", "daemon.letter.aging");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ subject_id: toBeta, written_by: "beta" });

    expect((await admin.query(`select count(*)::int n, count(read_at)::int r from letters`)).rows[0]).toEqual({ n: 4, r: 1 });
    expect(passOf(await daemon(), "alpha", "letters.expire").changed).toBe(0);
    const again = await daemon({ trigger: "manual" }, NONE_EMBEDDER, new Date(NOW.getTime() + 31 * DAY));
    expect(passOf(again, "alpha", "letters.expire").changed).toBe(2); // old again, plus the 89 day one now 120 days old
    expect(await events("alpha", "daemon.letter.aging")).toHaveLength(3);
  });
});

describe("mind_health", () => {
  it("reports null before any run and the last run's pass tally after; orient's health section shows it", async () => {
    const health = async () => ((await runVerb({ pool, registry, now: () => NOW }, alpha, "mind_health", { mind_id: "alpha" })) as any).receipt.projection;
    expect((await health()).last_daemon_run).toBeNull();
    const boom: DaemonPass = { name: "test.boom", run: async () => { throw new Error("x"); } };
    await daemon({ trigger: "manual", minds: ["alpha"] });
    let h = (await health()).last_daemon_run;
    expect(h).toMatchObject({ passes_ok: 14, passes_failed: 0 });
    expect(h.started_at).toBeInstanceOf(Date);
    expect(h.finished_at).toBeInstanceOf(Date);
    const later = new Date(NOW.getTime() + HOUR);
    await daemon({ trigger: "manual", minds: ["alpha"], passes: [...PASSES, boom] }, NONE_EMBEDDER, later);
    h = (await health()).last_daemon_run;
    expect(h).toMatchObject({ passes_ok: 12, passes_failed: 1 });
    expect(h.started_at.getTime()).toBe(later.getTime());
    const orient = (await runVerb({ pool, registry, now: () => NOW }, alpha, "mind_orient", { mind_id: "alpha", depth: "orientation" })) as any;
    expect(orient.receipt.projection.sections.health.last_daemon_run).toMatchObject({ passes_ok: 12, passes_failed: 1 });
    // beta's health says nothing of alpha's runs
    const bh = (await runVerb({ pool, registry, now: () => NOW }, { bearer: "beta", grants: {} }, "mind_health", { mind_id: "beta" })) as any;
    expect(bh.receipt.projection.last_daemon_run).toBeNull();
  });

  it("marks a run that started over an hour ago and never finished as stale", async () => {
    const health = async () => ((await runVerb({ pool, registry }, alpha, "mind_health", { mind_id: "alpha" })) as any).receipt.projection.last_daemon_run;
    await admin.query(`insert into daemon_runs (mind_id, started_at, trigger) values ('alpha', now() - interval '30 minutes', 'timer')`);
    expect(await health()).toMatchObject({ finished_at: null, stale: false });
    await admin.query(`delete from daemon_runs where mind_id = 'alpha'`);
    await admin.query(`insert into daemon_runs (mind_id, started_at, trigger) values ('alpha', now() - interval '2 hours', 'timer')`);
    expect(await health()).toMatchObject({ finished_at: null, stale: true });
    await admin.query(`update daemon_runs set finished_at = now() where mind_id = 'alpha'`);
    expect(await health()).toMatchObject({ stale: false });
  });
});
