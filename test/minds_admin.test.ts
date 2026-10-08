import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, resetDatabase, testAppUrl, TEST_KEYS } from "./helpers.js";
import { resolveCaller } from "../src/auth.js";
import { ArgError } from "../src/cli-args.js";
import { formatMindToggle, parseMindToggleArgs, setMindDisabled } from "../src/minds-admin.js";

let admin: Pool;
let app: Pool;

beforeEach(async () => {
  if (app) await closePool(app);
  if (admin) await closePool(admin);
  admin = await resetDatabase(); // alpha -> beta read is pre-seeded
  app = appPool();
});

afterAll(async () => {
  if (app) await closePool(app);
  if (admin) await closePool(admin);
});

describe("suspend-access / restore-access", () => {
  it("parses --mind and rejects missing, invalid or extra arguments", () => {
    expect(parseMindToggleArgs(["--mind", "alpha"], "suspend-access")).toEqual({ mind: "alpha" });
    expect(() => parseMindToggleArgs([], "suspend-access")).toThrow(ArgError);
    expect(() => parseMindToggleArgs(["--mind", "bad id!"], "restore-access")).toThrow(/invalid mind_id/);
    expect(() => parseMindToggleArgs(["--mind", "alpha", "extra"], "restore-access")).toThrow(ArgError);
  });

  it("disabling sets disabled_at; the bearer no longer resolves; grants from the mind stop applying; enabling reverses it", async () => {
    expect(await resolveCaller(app, TEST_KEYS.alpha)).not.toBeNull();
    expect((await resolveCaller(app, TEST_KEYS.beta))?.grants).toEqual({ alpha: ["read"] });

    const d = await setMindDisabled(admin, "alpha", true);
    expect(d).toEqual({ mind: "alpha", status: "suspended" });
    expect(formatMindToggle(d, "suspend-access")).toBe('mind "alpha" access suspended');
    expect((await admin.query("select disabled_at from minds where mind_id = 'alpha'")).rows[0].disabled_at).not.toBeNull();
    expect(await resolveCaller(app, TEST_KEYS.alpha)).toBeNull();
    expect(await resolveCaller(app, TEST_KEYS.beta)).toEqual({ bearer: "beta", grants: {} });

    const again = await setMindDisabled(admin, "alpha", true);
    expect(again.status).toBe("unchanged");
    expect(formatMindToggle(again, "suspend-access")).toMatch(/access was already suspended/);

    const e = await setMindDisabled(admin, "alpha", false);
    expect(e).toEqual({ mind: "alpha", status: "restored", shifted: 0 });
    expect((await admin.query("select disabled_at from minds where mind_id = 'alpha'")).rows[0].disabled_at).toBeNull();
    expect(await resolveCaller(app, TEST_KEYS.alpha)).not.toBeNull();
    expect((await resolveCaller(app, TEST_KEYS.beta))?.grants).toEqual({ alpha: ["read"] });
    expect((await setMindDisabled(admin, "alpha", false)).status).toBe("unchanged");
  });

  it("an unknown mind is an error and the app role cannot do it", async () => {
    await expect(setMindDisabled(admin, "nobody", true)).rejects.toThrow(/does not exist/);
    await expect(setMindDisabled(app, "alpha", true)).rejects.toThrow(/permission denied/);
  });
});

describe("restore-access pushes open declarations back by the suspended time", () => {
  const HOUR = 3_600_000;
  it("shifts accepted unsettled proposals and declared vow breaks, and nothing else; prints the count", async () => {
    const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;
    const ev = (await q("insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha','k','{}','alpha',now()) returning id"))[0].id;
    const node = async (type: string, meta: object) =>
      (await q(
        `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, pinned, metadata)
         values ('alpha', $1, 'l', 'c', 'alpha', 'extracted', 1, true, $2::jsonb) returning id`,
        [type, JSON.stringify(meta)],
      ))[0].id as string;
    const idn = await node("identity", {});
    const eff = new Date(Date.now() + 24 * HOUR);
    const prop = async (status: string, extra = "") =>
      (await queryAs(admin, "alpha", "alpha",
        `insert into proposals (mind_id, kind, section, content, proposed_by, event_id, status, created_at, target_node_id, effective_at ${extra ? ", " + extra.split("=")[0] : ""})
         values ('alpha','identity','s','c','alpha',$1,$2,now(),$3,$4 ${extra ? ", now()" : ""}) returning id`,
        [ev, status, idn, eff],
      )).rows[0].id as string;
    const open = await prop("accepted");
    const done = await prop("settled", "settled_at=1");
    const withdrawn = await prop("withdrawn", "withdrawn_at=1");
    const vowOpen = await node("vow", { broken: false, break_declared: { reason: "r", declared_at: new Date().toISOString(), effective_at: eff.toISOString(), event_id: ev } });
    const vowPlain = await node("vow", { broken: false });

    await setMindDisabled(admin, "alpha", true);
    await admin.query("update minds set disabled_at = now() - interval '5 hours' where mind_id = 'alpha'");
    const r = await setMindDisabled(admin, "alpha", false);
    expect(r).toEqual({ mind: "alpha", status: "restored", shifted: 2 });
    expect(formatMindToggle(r, "restore-access")).toBe('mind "alpha" access restored; 2 open declaration(s) pushed back by the suspended time');

    const shifted = (d: Date | string) => Math.round((new Date(d).getTime() - eff.getTime()) / 1000);
    const near = (secs: number) => Math.abs(secs - 5 * 3600) < 30;
    const rows = Object.fromEntries((await q("select id, effective_at from proposals")).map((x) => [x.id, x.effective_at]));
    expect(near(shifted(rows[open]))).toBe(true);
    expect(shifted(rows[done])).toBe(0);
    expect(shifted(rows[withdrawn])).toBe(0);
    const metas = Object.fromEntries((await q("select id, metadata from nodes where node_type = 'vow'")).map((x) => [x.id, x.metadata]));
    expect(near(shifted(metas[vowOpen].break_declared.effective_at))).toBe(true);
    expect(metas[vowOpen].break_declared.effective_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(metas[vowOpen].break_declared.reason).toBe("r");
    expect(metas[vowPlain]).toEqual({ broken: false });
  });
});

describe("CLI names", () => {
  const cli = (...args: string[]) =>
    spawnSync("node_modules/.bin/tsx", ["src/cli.ts", ...args], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      encoding: "utf8",
    });
  const disabledAt = async () => (await admin.query("select disabled_at from minds where mind_id = 'alpha'")).rows[0].disabled_at;

  it("suspend-access and restore-access behave as the old commands did, with no deprecation notice", async () => {
    const s = cli("suspend-access", "--mind", "alpha");
    expect(s.status).toBe(0);
    expect(s.stdout).toContain('mind "alpha" access suspended');
    expect(s.stderr).not.toMatch(/deprecated/);
    expect(await disabledAt()).not.toBeNull();
    const r = cli("restore-access", "--mind", "alpha");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('mind "alpha" access restored');
    expect(await disabledAt()).toBeNull();
  });

  it("disable-mind and enable-mind remain as aliases that print a one-line deprecation to stderr", async () => {
    const d = cli("disable-mind", "--mind", "alpha");
    expect(d.status).toBe(0);
    expect(d.stderr.trim().split("\n")).toHaveLength(1);
    expect(d.stderr).toMatch(/disable-mind is deprecated; use suspend-access/);
    expect(await disabledAt()).not.toBeNull();
    const e = cli("enable-mind", "--mind", "alpha");
    expect(e.stderr).toMatch(/enable-mind is deprecated; use restore-access/);
    expect(await disabledAt()).toBeNull();
  });

  it("the usage text names the new commands and not the old ones", () => {
    const u = cli("help");
    expect(u.stdout + u.stderr).toMatch(/suspend-access --mind <id> \| restore-access --mind <id>/);
  });

  it("seed-keys on a suspended mind rotates the key, prints that access remains suspended, and leaves it suspended", async () => {
    await setMindDisabled(admin, "alpha", true);
    const f = join(mkdtempSync(join(tmpdir(), "seedkeys-")), "keys.txt");
    writeFileSync(f, "alpha rotated-alpha-key-0123456789abcdefghij\n");
    const r = cli("seed-keys", f);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("access remains suspended; run restore-access --mind alpha");
    expect(await disabledAt()).not.toBeNull();
  });

  it("daemon --once names a mind without active access, and a bad IDENTITY_COOLING_HOURS fails before anything runs", async () => {
    await setMindDisabled(admin, "alpha", true);
    const none = spawnSync("node_modules/.bin/tsx", ["src/cli.ts", "daemon", "--once", "--mind", "alpha"], {
      env: { ...process.env, DATABASE_URL: testAppUrl() },
      encoding: "utf8",
    });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('no mind with active access matched "alpha"');
    expect(none.stderr).not.toContain("no enabled mind");
    const bad = spawnSync("node_modules/.bin/tsx", ["src/cli.ts", "daemon", "--once"], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, IDENTITY_COOLING_HOURS: "24h" },
      encoding: "utf8",
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/IDENTITY_COOLING_HOURS must be a non-negative integer/);
  });
});
