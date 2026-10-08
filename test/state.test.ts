import { NONE_EMBEDDER } from "../src/embed/none.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { mind_drive } from "../src/verbs/mind_drive.js";
import { mind_weather } from "../src/verbs/mind_weather.js";
import { mind_context } from "../src/verbs/mind_context.js";
import { mind_handoff } from "../src/verbs/mind_handoff.js";
import { mind_write } from "../src/verbs/mind_write.js";
import { mind_observe } from "../src/verbs/mind_observe.js";
import { AXES, DRIVES, decay, levelsAt, type DriveRow } from "../src/verbs/drives.js";
import type { Caller } from "../src/verbs/types.js";

const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: { alpha: ["read"] } };

let pool: Pool;
let admin: Pool;
let clock = new Date();
const registry = [mind_drive, mind_weather, mind_context, mind_handoff, mind_write, mind_observe];
const run = (caller: Caller, name: string, input: unknown, session?: string) =>
  runVerb({ pool, registry, now: () => clock }, caller, name, input, session);

const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const HOUR = 3_600_000;
const after = (d: Date, hours: number) => new Date(d.getTime() + hours * HOUR);

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  clock = new Date();
});

afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
});

describe("decay function", () => {
  it("is exact at 0h, 24h and 48h", () => {
    expect(decay(9, 5, 0)).toBe(9);
    expect(decay(9, 5, 24)).toBeCloseTo(7, 12);
    expect(decay(9, 5, 48)).toBeCloseTo(6, 12);
    expect(decay(1, 5, 24)).toBeCloseTo(3, 12);
    expect(decay(9, 5, 24 * 40)).toBeCloseTo(5, 6);
  });
  it("treats negative elapsed time as zero and a value at baseline as stable", () => {
    expect(decay(9, 5, -10)).toBe(9);
    expect(decay(5, 5, 100)).toBe(5);
  });
  it("levelsAt gives baselines for a missing row and decays all axes of a row", () => {
    expect(levelsAt(undefined, new Date())).toEqual({
      intensity: 5, frustration: 2, satisfaction: 5,
      baselines: { intensity: 5, frustration: 2, satisfaction: 5 },
    });
    const t0 = new Date("2026-01-01T00:00:00Z");
    const row = {
      intensity: 9, frustration: 6, satisfaction: 1,
      baseline_intensity: 5, baseline_frustration: 2, baseline_satisfaction: 5,
      updated_at: t0,
    } as DriveRow;
    const l = levelsAt(row, after(t0, 24));
    expect(l.intensity).toBeCloseTo(7, 12);
    expect(l.frustration).toBeCloseTo(4, 12);
    expect(l.satisfaction).toBeCloseTo(3, 12);
  });
  it("exports eight drives and three axes", () => {
    expect(DRIVES).toHaveLength(8);
    expect(AXES).toEqual(["intensity", "frustration", "satisfaction"]);
  });
});

describe("mind_drive", () => {
  const drive = (extra: Record<string, unknown>, caller = alpha) =>
    run(caller, "mind_drive", { mind_id: "alpha", ...extra });

  it("read on an empty mind returns eight drives at baselines, no event", async () => {
    const r: any = await drive({ operation: "read" });
    expect(r.ok).toBe(true);
    expect(r.receipt.event_id).toBeUndefined();
    const p = r.receipt.projection;
    expect(p.context).toBe("");
    expect(p.drives.map((d: any) => d.drive)).toEqual([...DRIVES]);
    for (const d of p.drives) {
      expect(d).toMatchObject({ intensity: 5, frustration: 2, satisfaction: 5, updated_at: null });
      expect(d.baselines).toEqual({ intensity: 5, frustration: 2, satisfaction: 5 });
    }
    expect(await q("alpha", "select * from events")).toHaveLength(0);
  });

  it("nudge then read after 24h shows half the excursion; read persists nothing", async () => {
    const n: any = await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 4, source: "test" });
    expect(n.ok).toBe(true);
    const row = n.receipt.projection.drive;
    expect(row).toEqual({
      drive: "play", intensity: 9, frustration: 2, satisfaction: 5,
      baselines: { intensity: 5, frustration: 2, satisfaction: 5 }, updated_at: clock,
    });
    const ev = (await q("alpha", "select * from events where id = $1", [n.receipt.event_id]))[0];
    expect(ev.kind).toBe("drive.nudge");
    expect(ev.written_by).toBe("alpha");
    expect(ev.payload).toMatchObject({ context: "", drive: "play", axis: "intensity", delta: 4, source: "test", before: 5, after: 9 });
    const stored = (await q("alpha", "select last_event_id, updated_at from drive_state where drive = 'play'"))[0];
    expect(stored.last_event_id).toBe(n.receipt.event_id);
    expect(stored.updated_at.getTime()).toBe(row.updated_at.getTime());

    clock = after(row.updated_at, 24);
    const r: any = await drive({ operation: "read" });
    const play = r.receipt.projection.drives.find((d: any) => d.drive === "play");
    expect(play.intensity).toBeCloseTo(7, 9);
    const raw = (await q("alpha", "select intensity from drive_state where drive = 'play'"))[0];
    expect(raw.intensity).toBe(9);

    // a second nudge applies to the decayed value
    const n2: any = await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 1 });
    expect(n2.receipt.projection.drive.intensity).toBe(8);
  });

  it("nudge then read at the same injected instant is exact; 24h later is the half-decay to 3 decimals", async () => {
    const n: any = await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 4 });
    expect(n.receipt.projection.drive.intensity).toBe(9);
    const same: any = await drive({ operation: "read" });
    expect(same.receipt.projection.drives.find((d: any) => d.drive === "play").intensity).toBe(9);
    const t = n.receipt.projection.drive.updated_at as Date;
    expect(t.getTime()).toBe(clock.getTime());
    clock = after(t, 24);
    const later: any = await drive({ operation: "read" });
    expect(later.receipt.projection.drives.find((d: any) => d.drive === "play").intensity).toBe(7);
    // a second write at the same instant sees no phantom decay either
    const n2: any = await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 0 });
    expect(n2.receipt.projection.drive.intensity).toBe(7);
    const again: any = await drive({ operation: "read" });
    expect(again.receipt.projection.drives.find((d: any) => d.drive === "play").intensity).toBe(7);
  });

  it("projections round to 3 decimals while the table keeps raw doubles", async () => {
    const n: any = await drive({ operation: "nudge", drive: "care", axis: "intensity", delta: 4 });
    clock = after(n.receipt.projection.drive.updated_at, 7);
    const r: any = await drive({ operation: "read" });
    const v = r.receipt.projection.drives.find((d: any) => d.drive === "care").intensity;
    expect(v).toBe(Math.round(v * 1000) / 1000);
    expect(String(v).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(3);
    const raw = (await q("alpha", "select intensity from drive_state where drive = 'care'"))[0].intensity;
    expect(raw).toBe(9);
  });

  it("nudge, set_baseline and decay return the same drive view shape as read", async () => {
    const shape = ["baselines", "drive", "frustration", "intensity", "satisfaction", "updated_at"];
    const n: any = await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 1 });
    const b: any = await drive({ operation: "set_baseline", drive: "play", axis: "intensity", value: 3 });
    const d: any = await drive({ operation: "decay" });
    const r: any = await drive({ operation: "read" });
    expect(Object.keys(n.receipt.projection.drive).sort()).toEqual(shape);
    expect(Object.keys(b.receipt.projection.drive).sort()).toEqual(shape);
    expect(Object.keys(d.receipt.projection.drives[0]).sort()).toEqual(shape);
    expect(Object.keys(r.receipt.projection.drives[0]).sort()).toEqual(shape);
  });

  it("clamps at 10 and at 0", async () => {
    const hi: any = await drive({ operation: "nudge", drive: "care", axis: "satisfaction", delta: 10 });
    expect(hi.receipt.projection.drive.satisfaction).toBe(10);
    const lo: any = await drive({ operation: "nudge", drive: "care", axis: "frustration", delta: -10 });
    expect(lo.receipt.projection.drive.frustration).toBe(0);
    const ev = (await q("alpha", "select payload from events where id = $1", [hi.receipt.event_id]))[0];
    expect(ev.payload.after).toBe(10);
  });

  it("8 parallel nudges end serial: highest-seq event is last_event_id and value is the serial sum", async () => {
    const results: any[] = await Promise.all(
      Array.from({ length: 8 }, () => drive({ operation: "nudge", drive: "anchor", axis: "intensity", delta: 0.5 })),
    );
    for (const r of results) expect(r.ok).toBe(true);
    const row = (await q("alpha", "select * from drive_state where drive = 'anchor'"))[0];
    expect(row.intensity).toBeCloseTo(9, 9);
    const evs = await q("alpha", "select id from events where kind = 'drive.nudge' order by seq desc");
    expect(evs).toHaveLength(8);
    expect(row.last_event_id).toBe(evs[0].id);
    expect(await q("alpha", "select 1 from drive_state where drive = 'anchor'")).toHaveLength(1);
  });

  it("set_baseline shifts the rest point and persists decayed current values", async () => {
    const n: any = await drive({ operation: "nudge", drive: "desire", axis: "intensity", delta: 4 });
    clock = after(n.receipt.projection.drive.updated_at, 24);
    const b: any = await drive({ operation: "set_baseline", drive: "desire", axis: "intensity", value: 1 });
    expect(b.ok).toBe(true);
    const row = b.receipt.projection.drive;
    expect(row.baselines).toEqual({ intensity: 1, frustration: 2, satisfaction: 5 });
    expect(row.intensity).toBeCloseTo(7, 9);
    const ev = (await q("alpha", "select kind, payload from events where id = $1", [b.receipt.event_id]))[0];
    expect(ev.kind).toBe("drive.baseline");
    expect(ev.payload).toMatchObject({ context: "", drive: "desire", axis: "intensity", value: 1 });

    clock = after(row.updated_at, 24 * 30);
    const r: any = await drive({ operation: "read" });
    const d = r.receipt.projection.drives.find((x: any) => x.drive === "desire");
    expect(d.intensity).toBeCloseTo(1, 5);
    expect(d.baselines.intensity).toBe(1);
  });

  it("decay persists all eight drives under one event", async () => {
    const n: any = await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 4 });
    clock = after(n.receipt.projection.drive.updated_at, 24);
    const d: any = await drive({ operation: "decay" });
    expect(d.ok).toBe(true);
    expect(d.receipt.projection.drives).toHaveLength(8);
    const rows = await q("alpha", "select * from drive_state order by drive");
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r: any) => r.last_event_id))).toEqual(new Set([d.receipt.event_id]));
    expect(rows.find((r: any) => r.drive === "play").intensity).toBeCloseTo(7, 9);
    const evs = await q("alpha", "select kind, payload from events where kind = 'drive.decay'");
    expect(evs).toHaveLength(1);
    expect(evs[0].payload.context).toBe("");
    expect(typeof evs[0].payload.as_of).toBe("string");
  });

  it("contexts are independent", async () => {
    await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 3, context: "lane-a" });
    await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: -3, context: "lane-b" });
    const a: any = await drive({ operation: "read", context: "lane-a" });
    const b: any = await drive({ operation: "read", context: "lane-b" });
    const shared: any = await drive({ operation: "read" });
    const get = (r: any) => r.receipt.projection.drives.find((d: any) => d.drive === "play").intensity;
    expect(get(a)).toBeCloseTo(8, 6);
    expect(get(b)).toBeCloseTo(2, 6);
    expect(get(shared)).toBe(5);
    expect(a.receipt.projection.context).toBe("lane-a");
  });

  it("validates per operation", async () => {
    expect(await drive({ operation: "nudge", axis: "intensity", delta: 1 })).toMatchObject({ ok: false, error: { code: "invalid_input", field: "drive" } });
    expect(await drive({ operation: "nudge", drive: "play", delta: 1 })).toMatchObject({ error: { field: "axis" } });
    expect(await drive({ operation: "nudge", drive: "play", axis: "intensity" })).toMatchObject({ error: { field: "delta" } });
    expect(await drive({ operation: "set_baseline", drive: "play", axis: "intensity" })).toMatchObject({ error: { field: "value" } });
    expect(await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 11 })).toMatchObject({ error: { field: "delta" } });
    expect(await drive({ operation: "nudge", drive: "mystery", axis: "intensity", delta: 1 })).toMatchObject({ error: { field: "drive" } });
    expect(await drive({ operation: "read", bogus: 1 })).toMatchObject({ error: { code: "invalid_input" } });
  });

  it("read grantee can read, cannot nudge; RLS hides rows", async () => {
    await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 2 });
    const r: any = await drive({ operation: "read" }, beta);
    expect(r.ok).toBe(true);
    const f: any = await drive({ operation: "nudge", drive: "play", axis: "intensity", delta: 2 }, beta);
    expect(f).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const other = await q("beta", "select * from drive_state");
    expect(other).toHaveLength(0);
    expect(await q("alpha", "select * from drive_state")).toHaveLength(1);
  });
});

describe("mind_weather", () => {
  const weather = (extra: Record<string, unknown> = {}, caller = alpha) =>
    run(caller, "mind_weather", { mind_id: "alpha", ...extra });
  const observe = (charge: string[], extra: Record<string, unknown> = {}) =>
    run(alpha, "mind_observe", {
      mind_id: "alpha",
      content: "something happened",
      texture: { charge, vividness: "soft", grip: "present", salience: "active", somatic: "chest" },
      ...extra,
    });

  it("empty window", async () => {
    const r: any = await weather();
    expect(r.ok).toBe(true);
    expect(r.receipt.event_id).toBeUndefined();
    const p = r.receipt.projection;
    expect(p).toMatchObject({ event_count: 0, textured_count: 0, report: "Quiet: no events in the window.", kinds: {}, charge_counts: {} });
    expect(p.window.hours).toBe(24);
    expect(new Date(p.window.to).getTime() - new Date(p.window.from).getTime()).toBe(24 * HOUR);
  });

  it("counts and report with textured and untextured events", async () => {
    await observe(["tender", "focused"]);
    await observe(["tender"]);
    await observe(["tender", "wary"]);
    await run(alpha, "mind_write", { mind_id: "alpha", type: "note", text: "plain" });
    clock = new Date(Date.now() + 60_000);
    const r: any = await weather();
    const p = r.receipt.projection;
    expect(p.event_count).toBe(4);
    expect(p.textured_count).toBe(3);
    expect(p.kinds).toEqual({ observe: 3, write: 1 });
    expect(p.charge_counts).toEqual({ tender: 3, focused: 1, wary: 1 });
    expect(Object.keys(p.charge_counts)[0]).toBe("tender");
    expect(p.vividness).toEqual({ soft: 3 });
    expect(p.grip).toEqual({ present: 3 });
    expect(p.salience).toEqual({ active: 3 });
    expect(p.somatic).toEqual({ chest: 3 });
    expect(p.report).toBe(
      "Over the last 24 hours: 4 events, 3 carrying texture. Dominant charge: tender (3), focused (1), wary (1). Mostly soft and present.",
    );
  });

  it("context filter", async () => {
    await observe(["tender"], { context: "lane-a" });
    await observe(["fierce"], { context: "lane-b" });
    await observe(["fierce"], { context: "lane-b" });
    clock = new Date(Date.now() + 60_000);
    const a: any = await weather({ context: "lane-a" });
    expect(a.receipt.projection).toMatchObject({ event_count: 1, charge_counts: { tender: 1 } });
    const b: any = await weather({ context: "lane-b" });
    expect(b.receipt.projection).toMatchObject({ event_count: 2, charge_counts: { fierce: 2 } });
    const all: any = await weather();
    expect(all.receipt.projection.event_count).toBe(3);
  });

  it("context empty string is the shared lane", async () => {
    await observe(["tender"]);
    await observe(["fierce"], { context: "lane-a" });
    clock = new Date(Date.now() + 60_000);
    const shared: any = await weather({ context: "" });
    expect(shared.receipt.projection).toMatchObject({ event_count: 1, charge_counts: { tender: 1 } });
    const all: any = await weather();
    expect(all.receipt.projection.event_count).toBe(2);
  });

  it("events after the window end are excluded", async () => {
    await observe(["tender"]);
    const created = (await q("alpha", "select created_at from events"))[0].created_at as Date;
    clock = after(created, -1);
    const r: any = await weather();
    expect(r.receipt.projection).toMatchObject({ event_count: 0, report: "Quiet: no events in the window." });
    clock = new Date(created.getTime() + 1); // pg Dates truncate to ms, so +1ms is the first instant that includes it
    expect(((await weather()) as any).receipt.projection.event_count).toBe(1);
  });

  it("aggregates in SQL: 50 events yield counts, and Node receives no per-event rows", async () => {
    const charges = ["tender", "focused", "wary", "fierce", "calm"];
    for (let i = 0; i < 50; i++) {
      await observe([charges[i % 5]!, "shared"], {});
    }
    await run(alpha, "mind_write", { mind_id: "alpha", type: "note", text: "plain" });
    clock = new Date(Date.now() + 60_000);
    const seen: number[] = [];
    const r: any = await withMind(pool, "alpha", "alpha", "read", async (tx) => {
      const spy = {
        ...tx,
        query: async (...a: any[]) => {
          const res = await (tx.query as any)(...a);
          seen.push(res.rows.length);
          return res;
        },
      } as typeof tx;
      return mind_weather.handler(
        { caller: alpha, mind_id: "alpha", tx: spy, now: () => clock, registry: [mind_weather], embedder: NONE_EMBEDDER, sinks: [], coolingMs: 0 },
        mind_weather.schema.parse({ mind_id: "alpha" }),
      );
    });
    const p = r.receipt.projection;
    expect(p.event_count).toBe(51);
    expect(p.textured_count).toBe(50);
    expect(p.kinds).toEqual({ observe: 50, write: 1 });
    expect(p.charge_counts).toEqual({ shared: 50, calm: 10, fierce: 10, focused: 10, tender: 10, wary: 10 });
    expect(p.salience).toEqual({ active: 50 });
    expect(p.somatic).toEqual({ chest: 50 });
    expect(Math.max(...seen)).toBeLessThanOrEqual(10);
  });

  it("lookback boundary", async () => {
    await observe(["tender"]);
    const created = (await q("alpha", "select created_at from events"))[0].created_at as Date;
    clock = after(created, 0.5);
    expect(((await weather({ lookback_hours: 1 })) as any).receipt.projection.event_count).toBe(1);
    clock = after(created, 1); // from == created_at: inclusive
    expect(((await weather({ lookback_hours: 1 })) as any).receipt.projection.event_count).toBe(1);
    clock = new Date(created.getTime() + HOUR + 1000);
    expect(((await weather({ lookback_hours: 1 })) as any).receipt.projection.event_count).toBe(0);
    expect(((await weather({ lookback_hours: 2 })) as any).receipt.projection.event_count).toBe(1);
  });

  it("validates lookback and allows a read grantee", async () => {
    expect(await weather({ lookback_hours: 0 })).toMatchObject({ ok: false, error: { code: "invalid_input", field: "lookback_hours" } });
    expect(await weather({ lookback_hours: 24 * 30 + 1 })).toMatchObject({ error: { field: "lookback_hours" } });
    await observe(["tender"]);
    clock = new Date(Date.now() + 60_000);
    const r: any = await weather({}, beta);
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.event_count).toBe(1);
  });
});

describe("mind_context", () => {
  const ctxv = (extra: Record<string, unknown>, caller = alpha) =>
    run(caller, "mind_context", { mind_id: "alpha", ...extra });

  it("set, get, list, clear", async () => {
    const s: any = await ctxv({ operation: "set", key: "focus", value: { topic: "x", n: [1, 2] } });
    expect(s.ok).toBe(true);
    expect(s.receipt.projection.entry).toMatchObject({ key: "focus", value: { topic: "x", n: [1, 2] }, expires_at: null, cleared_at: null });
    const ev = (await q("alpha", "select kind, payload from events where id = $1", [s.receipt.event_id]))[0];
    expect(ev).toMatchObject({ kind: "context.set", payload: { key: "focus", value: { topic: "x", n: [1, 2] }, ttl_minutes: null } });

    const g: any = await ctxv({ operation: "get", key: "focus" });
    expect(g.receipt.projection).toMatchObject({ expired: false, entry: { key: "focus" } });
    expect(g.receipt.event_id).toBeUndefined();
    const none: any = await ctxv({ operation: "get", key: "nope" });
    expect(none.receipt.projection).toEqual({ entry: null, expired: false });

    await ctxv({ operation: "set", key: "second", value: "text" });
    const l: any = await ctxv({ operation: "list" });
    expect(l.receipt.projection.entries.map((e: any) => e.key)).toEqual(["second", "focus"]);

    const c: any = await ctxv({ operation: "clear", key: "focus" });
    expect(c.ok).toBe(true);
    expect(c.receipt.projection.entry.cleared_at).toBeInstanceOf(Date);
    const g2: any = await ctxv({ operation: "get", key: "focus" });
    expect(g2.receipt.projection.expired).toBe(true);
    expect(g2.receipt.projection.entry.key).toBe("focus");
    const l2: any = await ctxv({ operation: "list" });
    expect(l2.receipt.projection.entries.map((e: any) => e.key)).toEqual(["second"]);
    const again: any = await ctxv({ operation: "clear", key: "focus" });
    expect(again).toMatchObject({ ok: false, error: { code: "not_found", field: "key" } });
    expect(await ctxv({ operation: "clear", key: "ghost" })).toMatchObject({ error: { code: "not_found" } });
  });

  it("accepts falsy and null JSON values", async () => {
    for (const [i, v] of [0, false, null, "", []].entries()) {
      const s: any = await ctxv({ operation: "set", key: `k${i}`, value: v });
      expect(s.ok).toBe(true);
      expect(s.receipt.projection.entry.value).toEqual(v);
    }
  });

  it("TTL expiry via injected now", async () => {
    const s: any = await ctxv({ operation: "set", key: "brief", value: 1, ttl_minutes: 10 });
    const e = s.receipt.projection.entry;
    expect(e.expires_at.getTime() - e.updated_at.getTime()).toBe(10 * 60_000);
    clock = new Date(e.updated_at.getTime() + 9 * 60_000);
    expect(((await ctxv({ operation: "get", key: "brief" })) as any).receipt.projection.expired).toBe(false);
    expect(((await ctxv({ operation: "list" })) as any).receipt.projection.entries).toHaveLength(1);
    clock = new Date(e.updated_at.getTime() + 10 * 60_000);
    const g: any = await ctxv({ operation: "get", key: "brief" });
    expect(g.receipt.projection.expired).toBe(true);
    expect(g.receipt.projection.entry.value).toBe(1);
    expect(((await ctxv({ operation: "list" })) as any).receipt.projection.entries).toHaveLength(0);
    expect(await ctxv({ operation: "clear", key: "brief" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("oversized value is invalid_input on value; boundary in UTF-8 bytes", async () => {
    const big = await ctxv({ operation: "set", key: "big", value: "x".repeat(16384) }); // 16386 bytes with quotes
    expect(big).toMatchObject({ ok: false, error: { code: "invalid_input", field: "value" } });
    const fits: any = await ctxv({ operation: "set", key: "fits", value: "x".repeat(16382) }); // exactly 16384
    expect(fits.ok).toBe(true);
    // multibyte: 6000 three-byte chars = 18000 bytes though only 6000 characters
    const multi = await ctxv({ operation: "set", key: "multi", value: "€".repeat(6000) });
    expect(multi).toMatchObject({ ok: false, error: { field: "value" } });
    expect(await q("alpha", "select 1 from kv_contexts where key in ('big','multi')")).toHaveLength(0);
  });

  it("rejects values Postgres or readers cannot hold faithfully, each as invalid_input on value", async () => {
    const nested = (leaf: unknown) => ({ a: [{ b: leaf }] });
    let deep: unknown = "x";
    for (let i = 0; i < 300; i++) deep = [deep];
    let ok256: unknown = "x";
    for (let i = 0; i < 255; i++) ok256 = [ok256];
    const bad: [string, unknown][] = [
      ["lone surrogate in nested string", nested("a\ud800b")],
      ["NUL in nested string", nested("a\u0000b")],
      ["NUL in a key", { ["k\u0000"]: 1 }],
      ["lone surrogate in a key", { ["k\udc00"]: 1 }],
      ["Infinity", nested(Infinity)],
      ["NaN", [NaN]],
      ["depth 300", deep],
    ];
    for (const [label, value] of bad) {
      const r = await ctxv({ operation: "set", key: "k", value });
      expect(r, label).toMatchObject({ ok: false, error: { code: "invalid_input", field: "value" } });
    }
    expect(await q("alpha", "select 1 from kv_contexts")).toHaveLength(0);
    expect(((await ctxv({ operation: "set", key: "k", value: ok256 })) as any).ok).toBe(true);
    expect(((await ctxv({ operation: "set", key: "k2", value: nested("fine \u{1F600}") })) as any).ok).toBe(true);
  });

  it("requires key and value where specified", async () => {
    expect(await ctxv({ operation: "set", value: 1 })).toMatchObject({ error: { code: "invalid_input", field: "key" } });
    expect(await ctxv({ operation: "set", key: "k" })).toMatchObject({ error: { code: "invalid_input", field: "value" } });
    expect(await ctxv({ operation: "get" })).toMatchObject({ error: { field: "key" } });
    expect(await ctxv({ operation: "clear" })).toMatchObject({ error: { field: "key" } });
    expect(await ctxv({ operation: "set", key: "k".repeat(201), value: 1 })).toMatchObject({ error: { field: "key" } });
    expect(await ctxv({ operation: "set", key: "k", value: 1, ttl_minutes: 0 })).toMatchObject({ error: { field: "ttl_minutes" } });
  });

  it("cleared then set revives, and a set replaces the ttl", async () => {
    await ctxv({ operation: "set", key: "k", value: 1, ttl_minutes: 5 });
    await ctxv({ operation: "clear", key: "k" });
    const s: any = await ctxv({ operation: "set", key: "k", value: 2 });
    expect(s.receipt.projection.entry).toMatchObject({ value: 2, cleared_at: null, expires_at: null });
    const g: any = await ctxv({ operation: "get", key: "k" });
    expect(g.receipt.projection.expired).toBe(false);
    expect(await q("alpha", "select 1 from kv_contexts")).toHaveLength(1);
  });

  it("read grantee can get and list but not set or clear; RLS hides rows", async () => {
    await ctxv({ operation: "set", key: "k", value: 1 });
    expect(((await ctxv({ operation: "get", key: "k" }, beta)) as any).receipt.projection.entry.key).toBe("k");
    expect(((await ctxv({ operation: "list" }, beta)) as any).ok).toBe(true);
    expect(await ctxv({ operation: "set", key: "k", value: 2 }, beta)).toMatchObject({ error: { code: "forbidden" } });
    expect(await ctxv({ operation: "clear", key: "k" }, beta)).toMatchObject({ error: { code: "forbidden" } });
    expect(await q("beta", "select * from kv_contexts")).toHaveLength(0);
  });
});

describe("mind_handoff", () => {
  const hand = (extra: Record<string, unknown>, caller = alpha, session?: string) =>
    run(caller, "mind_handoff", { mind_id: "alpha", ...extra }, session);

  it("read returns null on an empty mind", async () => {
    const r: any = await hand({ operation: "read" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection).toEqual({ handoff: null, history: [] });
  });

  it("write replaces wholesale", async () => {
    const w1: any = await hand(
      { operation: "write", handoff: { tone: "warm", notes: "n1", last_corrections: ["a", "b"] } },
      alpha,
      "sess-1",
    );
    expect(w1.ok).toBe(true);
    expect(w1.receipt.projection.handoff).toMatchObject({
      context: "",
      session_id: "sess-1",
      last_event_id: w1.receipt.event_id,
      handoff: { tone: "warm", notes: "n1", last_corrections: ["a", "b"] },
    });
    const w2: any = await hand({ operation: "write", handoff: { register: "quiet" } }, alpha, "sess-2");
    expect(w2.receipt.projection.handoff.handoff).toEqual({ register: "quiet" });
    expect(w2.receipt.projection.handoff.session_id).toBe("sess-2");
    const r: any = await hand({ operation: "read" });
    expect(r.receipt.projection.handoff.handoff).toEqual({ register: "quiet" });
    expect(await q("alpha", "select 1 from handoffs")).toHaveLength(1);
    const ev = (await q("alpha", "select kind, payload, session_id from events where id = $1", [w2.receipt.event_id]))[0];
    expect(ev).toMatchObject({ kind: "handoff.write", session_id: "sess-2", payload: { context: "", handoff: { register: "quiet" } } });
  });

  it("history is newest first with session ids and honours the limit", async () => {
    const ids: string[] = [];
    for (const i of [1, 2, 3]) {
      const w: any = await hand({ operation: "write", handoff: { notes: `v${i}` } }, alpha, `s${i}`);
      ids.push(w.receipt.event_id);
    }
    const r: any = await hand({ operation: "read", history_limit: 2 });
    const h = r.receipt.projection.history;
    expect(h.map((e: any) => e.event_id)).toEqual([ids[2], ids[1]]);
    expect(h.map((e: any) => e.session_id)).toEqual(["s3", "s2"]);
    expect(h.map((e: any) => e.handoff.notes)).toEqual(["v3", "v2"]);
    expect(h[0].created_at).toBeInstanceOf(Date);
    expect(((await hand({ operation: "read" })) as any).receipt.projection.history).toEqual([]);
  });

  it("contexts are separate", async () => {
    await hand({ operation: "write", handoff: { notes: "shared" } });
    await hand({ operation: "write", context: "lane-a", handoff: { notes: "a" } });
    await hand({ operation: "write", context: "lane-b", handoff: { notes: "b" } });
    const a: any = await hand({ operation: "read", context: "lane-a", history_limit: 5 });
    expect(a.receipt.projection.handoff.handoff.notes).toBe("a");
    expect(a.receipt.projection.history).toHaveLength(1);
    expect(((await hand({ operation: "read" })) as any).receipt.projection.handoff.handoff.notes).toBe("shared");
    expect(((await hand({ operation: "read", context: "lane-c" })) as any).receipt.projection.handoff).toBeNull();
    expect(await q("alpha", "select 1 from handoffs")).toHaveLength(3);
  });

  it("validates", async () => {
    expect(await hand({ operation: "write" })).toMatchObject({ error: { code: "invalid_input", field: "handoff" } });
    expect(await hand({ operation: "write", handoff: {} })).toMatchObject({ error: { code: "invalid_input", field: "handoff" } });
    expect(await hand({ operation: "write", handoff: { mood: "x" } })).toMatchObject({ error: { code: "invalid_input" } });
    expect(await hand({ operation: "write", handoff: { tone: "t".repeat(201) } })).toMatchObject({ error: { field: "handoff.tone" } });
    expect(await hand({ operation: "write", handoff: { last_corrections: Array(51).fill("x") } })).toMatchObject({ error: { field: "handoff.last_corrections" } });
    expect(await hand({ operation: "read", history_limit: 51 })).toMatchObject({ error: { field: "history_limit" } });
  });

  it("read grantee can read, not write; RLS hides rows", async () => {
    await hand({ operation: "write", handoff: { notes: "secret" } });
    const r: any = await hand({ operation: "read" }, beta);
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.handoff.handoff.notes).toBe("secret");
    expect(await hand({ operation: "write", handoff: { notes: "x" } }, beta)).toMatchObject({ error: { code: "forbidden" } });
    expect(await q("beta", "select * from handoffs")).toHaveLength(0);
  });
});
