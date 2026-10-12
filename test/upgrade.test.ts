// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { assertSchemaCurrent, SchemaAhead, SchemaBehind, schemaStatus } from "../src/db/schema.js";
import { ArgError } from "../src/cli-args.js";
import { createHttpServer } from "../src/server.js";
import { registry } from "../src/verbs/registry.js";
import { runVerb } from "../src/verbs/run.js";
import { buildInfo, formatBuildInfo, packageInfo } from "../src/version.js";
import {
  BEGIN_STEPS_TABLE,
  END_STEPS_TABLE,
  MANUAL_STEPS,
  manualStepsMarkdown,
  parseUpgradeArgs,
  runUpgrade,
  type UpgradeResult,
} from "../src/upgrade.js";
import { appPool, laneUrl, resetDatabase, testDatabaseUrl } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const url = (): string => testDatabaseUrl();

let admin: Pool | undefined;
const opened: Pool[] = [];
const track = (p: Pool): Pool => (opened.push(p), p);

/** An empty database: what a first `upgrade` meets (the extensions live outside the schema, as in resetDatabase). */
async function wipe(): Promise<Pool> {
  const p = track(createPool(url()));
  await p.query("drop extension if exists vector cascade; drop extension if exists pgcrypto cascade;");
  await p.query("drop schema public cascade; create schema public;");
  await p.query("create extension if not exists vector schema public; create extension if not exists pgcrypto schema public;");
  return p;
}

async function upgrade(over: { dryRun?: boolean; noBackfill?: boolean; dir?: string } = {}): Promise<{ r: UpgradeResult; text: string }> {
  const lines: string[] = [];
  const r = await runUpgrade({ databaseUrl: url(), dryRun: over.dryRun ?? false, noBackfill: over.noBackfill ?? false, ...(over.dir ? { dir: over.dir } : {}) }, (l) => lines.push(l));
  return { r, text: lines.join("\n") };
}

const allFiles = async (): Promise<string[]> => (await readdir(DEFAULT_MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

/** A migrations directory holding only the files up to and including `last` (a number such as "0024"). */
async function dirUpTo(last: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sanctum-migrations-"));
  temp.push(dir);
  for (const f of await allFiles()) if (f.slice(0, 4) <= last) await copyFile(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
  return dir;
}
const temp: string[] = [];

/**
 * The real lane roles are cluster-wide. `upgrade` asks whether sanctum_verb and sanctum_daemon can log in, so these tests set that
 * (login or nologin, never a password) and put each role's original login state back at the end. Any password already on a role is
 * left as it was.
 */
const REAL_LANES = ["sanctum_verb", "sanctum_daemon", "sanctum_operator", "sanctum_import"] as const;
const savedLogin = new Map<string, boolean>();

async function setLogins(on: boolean): Promise<void> {
  const p = track(createPool(url()));
  for (const role of ["sanctum_verb", "sanctum_daemon"]) {
    if ((await p.query("select 1 from pg_roles where rolname = $1", [role])).rowCount) await p.query(`alter role ${role} ${on ? "login" : "nologin"}`);
  }
}

beforeAll(async () => {
  const p = createPool(url());
  try {
    for (const role of REAL_LANES) {
      const r = await p.query("select rolcanlogin from pg_roles where rolname = $1", [role]);
      if (r.rows[0]) savedLogin.set(role, r.rows[0].rolcanlogin);
    }
  } finally {
    await p.end();
  }
});

beforeEach(async () => {
  admin = undefined;
  await setLogins(false); // the state of an install that never ran init: the lanes have no login
});

afterEach(async () => {
  while (opened.length) await opened.pop()!.end().catch(() => undefined);
  while (temp.length) await rm(temp.pop()!, { recursive: true, force: true });
});

afterAll(async () => {
  const p = createPool(url());
  try {
    for (const role of REAL_LANES) {
      if (!(await p.query("select 1 from pg_roles where rolname = $1", [role])).rowCount) continue;
      await p.query(`alter role ${role} ${savedLogin.get(role) === true ? "login" : "nologin"}`);
    }
  } finally {
    await p.end();
  }
});

describe("upgrade on a fresh database", () => {
  it("applies every migration, repairs the lanes, exits 3 while the lane logins are missing and 0 once they exist, then says nothing to do", async () => {
    const db = await wipe();
    const files = await allFiles();
    const first = await upgrade();
    expect(first.r.applied).toEqual(files);
    expect(first.r.exitCode).toBe(3);
    expect(first.r.nothingToDo).toBe(false);
    expect(first.text).toContain(`sanctum-mind ${packageInfo().version}`);
    expect(first.text).toContain("0 migration(s) applied");
    expect(first.text).toContain(`applied ${files.length} migration(s)`);
    expect(first.text).toContain("lane roles: present, grants intact");
    expect(first.text).toContain("(0026) no login on sanctum_daemon, sanctum_verb: services now log in as lanes");
    expect(first.text).not.toContain("backfill: adding"); // no 0025 backfill on a database with no minds
    expect(first.text).toContain("backfill: no minds yet");
    expect((await db.query("select count(*)::int as n from schema_migrations")).rows[0].n).toBe(files.length);
    for (const lane of ["verb", "daemon", "operator", "import"]) expect((await db.query("select 1 from pg_roles where rolname = $1", [`sanctum_${lane}`])).rowCount).toBe(1);

    // the step is read from the database: a second run without logins repeats it and still exits 3
    const repeat = await upgrade();
    expect(repeat.r.applied).toEqual([]);
    expect(repeat.r.exitCode).toBe(3);
    expect(repeat.text).toContain("no login on sanctum_daemon, sanctum_verb");
    expect(repeat.text).not.toContain("nothing to do");

    await setLogins(true);
    const second = await upgrade();
    expect(second.r.exitCode).toBe(0);
    expect(second.r.applied).toEqual([]);
    expect(second.r.nothingToDo).toBe(true);
    expect(second.text).toContain(`${files.length} migration(s) applied`);
    expect(second.text).toContain("pending: none");
    expect(second.text).toContain("nothing to do");
    expect(second.text).not.toContain("still needs you");
  });

  it("repairs a lane role that lost its membership or grants, and recreates one that is gone, without touching a login", async () => {
    const db = await wipe();
    await upgrade();
    await setLogins(true);
    await db.query("revoke sanctum_app from sanctum_daemon");
    await db.query("revoke insert, update on grants from sanctum_operator");
    const asked = await upgrade({ dryRun: true });
    expect(asked.text).toContain("lane roles: would repair");
    expect(asked.text).toContain("sanctum_daemon (membership)");
    expect(asked.text).toContain("sanctum_operator (grants)");
    expect(asked.r.nothingToDo).toBe(false);
    expect((await db.query("select 1 from pg_auth_members where roleid = 'sanctum_app'::regrole and member = 'sanctum_daemon'::regrole")).rowCount).toBe(0); // a dry run repaired nothing

    const fixed = await upgrade();
    expect(fixed.r.applied).toEqual([]);
    expect(fixed.r.lanesRepaired).toEqual(["sanctum_daemon (membership)", "sanctum_operator (grants)"]);
    expect(fixed.text).toContain("lane roles: repaired sanctum_daemon (membership), sanctum_operator (grants)");
    expect(fixed.r.exitCode).toBe(0); // repairs are not manual steps
    expect((await db.query("select 1 from pg_auth_members where roleid = 'sanctum_app'::regrole and member = 'sanctum_daemon'::regrole")).rowCount).toBe(1);
    expect((await db.query("select has_table_privilege('sanctum_operator', 'grants', 'update') as ok")).rows[0].ok).toBe(true);

    // a role's password is not touched (whatever it is: it is read, never set)
    const pw = async (role: string) => (await db.query("select rolpassword from pg_authid where rolname = $1", [role])).rows[0].rolpassword;
    const before = await pw("sanctum_verb");
    await db.query("drop owned by sanctum_import");
    await db.query("drop role sanctum_import");
    try {
      const made = await upgrade();
      expect(made.r.lanesCreated).toEqual(["sanctum_import"]);
      expect(made.text).toContain("lane roles: created sanctum_import");
      expect((await db.query("select rolcanlogin from pg_roles where rolname = 'sanctum_import'")).rows[0].rolcanlogin).toBe(false);
      expect(await pw("sanctum_verb")).toBe(before);
      expect((await upgrade()).r.nothingToDo).toBe(true);
    } finally {
      // the test stand-in login was a member of the dropped role: give that back
      if ((await db.query("select 1 from pg_roles where rolname = 'sanctum_test_import'")).rowCount) await db.query("grant sanctum_import to sanctum_test_import");
    }
  });

  it("--dry-run prints everything and changes nothing", async () => {
    const db = await wipe();
    const d = await upgrade({ dryRun: true });
    expect(d.r.exitCode).toBe(0);
    expect(d.r.dryRun).toBe(true);
    expect(d.r.applied).toEqual([]);
    expect(d.r.pending).toEqual(await allFiles());
    expect(d.text).toContain("dry run");
    expect(d.text).toContain("pending (26): 0001_core.sql ... 0026_lanes.sql");
    expect(d.text).toContain("would apply 26 migration(s)");
    expect(d.text).toContain("repair work is checked for every mind once 0025 is applied");
    expect(d.text).toContain("you would still need to:");
    expect(d.text).toContain("(0026) no login on");
    expect((await db.query("select to_regclass('schema_migrations') as t")).rows[0].t).toBeNull();
    expect((await db.query("select count(*)::int as n from pg_tables where schemaname = 'public'")).rows[0].n).toBe(0);
  });
});

describe("upgrade from 0024", () => {
  /** A database as the release before the repair work left it: migrated to 0024, with a retired node that has no repair work row. */
  async function at0024(): Promise<Pool> {
    const db = await wipe();
    await runMigrations(url(), await dirUpTo("0024"));
    await db.query("insert into minds (mind_id, key_hash, display_name) values ('alpha', 'k1', 'A'), ('beta', 'k2', 'B'), ('gamma', 'k3', 'G')");
    await db.query("update minds set disabled_at = now() where mind_id = 'gamma'");
    await db.query(
      `insert into nodes (mind_id, node_type, label, content, written_by, source_type, invalidated_at, metadata)
       values ('alpha', 'observation', 'retired before 0025', 'retired before 0025', 'alpha', 'extracted', now() - interval '3 days', '{"retired": true}'),
              ('gamma', 'observation', 'retired too', 'retired too', 'gamma', 'extracted', now() - interval '3 days', '{"retired": true}')`,
    );
    return db;
  }

  it("applies 0025 and 0026, backfills the minds it can, lists the suspended one and the missing logins (exit 3), and keeps saying so until they are done", async () => {
    const db = await at0024();
    const { r, text } = await upgrade();
    expect(r.pending).toEqual([]);
    expect(r.applied).toEqual(["0025_repair_work.sql", "0026_lanes.sql"]);
    expect(text).toContain("24 migration(s) applied, schema 0024_attention");
    expect(text).toContain("pending (2): 0025_repair_work.sql, 0026_lanes.sql");
    expect(text).toContain("alpha: 1 repair work row(s) added");
    expect(text).not.toContain("beta:"); // nothing outstanding for beta
    expect(r.backfilled).toEqual([{ mind: "alpha", count: 1 }]);
    expect((await db.query("select count(*)::int as n from repair_work where mind_id = 'alpha'")).rows[0].n).toBe(1);
    expect((await db.query("select count(*)::int as n from repair_work where mind_id = 'gamma'")).rows[0].n).toBe(0);
    expect(text).toContain("still needs you:");
    expect(text).toContain('mind "gamma" has access suspended');
    expect(text).toContain("sanctum-mind restore-access --mind gamma");
    expect(text).toContain("(0026) no login on");
    expect(r.manual).toHaveLength(2);
    expect(r.exitCode).toBe(3);

    // nothing is remembered from this run: the same state gives the same steps
    const again = await upgrade();
    expect(again.r.applied).toEqual([]);
    expect(again.r.exitCode).toBe(3);
    expect(again.r.manual).toHaveLength(2);

    // restore gamma and give the lanes their logins: the next run adds gamma's work, and the one after has nothing to do
    await db.query("update minds set disabled_at = null where mind_id = 'gamma'");
    await setLogins(true);
    const done = await upgrade();
    expect(done.r.backfilled).toEqual([{ mind: "gamma", count: 1 }]);
    expect(done.r.exitCode).toBe(0);
    expect(done.text).toContain("gamma: 1 repair work row(s) added");
    const last = await upgrade();
    expect(last.r.exitCode).toBe(0);
    expect(last.text).toContain("nothing to do");
    expect((await db.query("select count(*)::int as n from repair_work")).rows[0].n).toBe(2);
  });

  it("an install that already has 0025 still gets its backfill (it is state, not the run that applied the migration)", async () => {
    const db = await wipe();
    await upgrade();
    await setLogins(true);
    await db.query("insert into minds (mind_id, key_hash, display_name) values ('alpha', 'k1', 'A')");
    await db.query(
      `insert into nodes (mind_id, node_type, label, content, written_by, source_type, invalidated_at, metadata)
       values ('alpha', 'observation', 'retired by an import', 'x', 'alpha', 'extracted', now() - interval '3 days', '{"retired": true}')`,
    );
    const dry = await upgrade({ dryRun: true });
    expect(dry.text).toContain("alpha: 1 repair work row(s) would be added");
    expect(dry.r.nothingToDo).toBe(false);
    expect((await db.query("select count(*)::int as n from repair_work")).rows[0].n).toBe(0);
    const real = await upgrade();
    expect(real.r.applied).toEqual([]);
    expect(real.r.backfilled).toEqual([{ mind: "alpha", count: 1 }]);
    expect(real.r.exitCode).toBe(0);
    expect((await upgrade()).r.nothingToDo).toBe(true);
  });

  it("--no-backfill leaves repair_work alone and prints the exact command under the steps (exit 3)", async () => {
    const db = await at0024();
    await setLogins(true);
    const { r, text } = await upgrade({ noBackfill: true });
    expect(r.applied).toEqual(["0025_repair_work.sql", "0026_lanes.sql"]);
    expect(r.backfilled).toEqual([]);
    expect(text).toContain("backfill: skipped (--no-backfill)");
    expect(text.indexOf("still needs you:")).toBeLessThan(text.indexOf("sanctum-mind extractor repair-backfill --mind alpha"));
    expect(text).toContain("docker compose run --rm init node dist/cli.js extractor repair-backfill");
    expect(r.exitCode).toBe(3);
    expect((await db.query("select count(*)::int as n from repair_work")).rows[0].n).toBe(0);
    // and the printed command does what it says
    const cli = spawnSync(TSX, [path.join(ROOT, "src/cli.ts"), "extractor", "repair-backfill", "--mind", "alpha"], { env: { ...process.env, DATABASE_URL: url() }, encoding: "utf8", timeout: 30_000 });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("added 1 repair work row(s)");
  });

  it("--dry-run changes nothing, says what it would do, and has no empty header", async () => {
    const db = await at0024();
    const { r, text } = await upgrade({ dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(text).toContain("would apply 2 migration(s)");
    expect(text).toContain("repair work is checked for every mind once 0025 is applied");
    expect(text).toContain("you would still need to:\n  1. (0026) no login on");
    expect((await db.query("select count(*)::int as n from schema_migrations")).rows[0].n).toBe(24);
    expect((await db.query("select to_regclass('repair_work') as t")).rows[0].t).toBeNull();
  });
});

describe("migrations that refuse", () => {
  /** A database at 0019 with two open declarations on one core, which 0020's unique index cannot be built over. */
  async function twoOpenOnOneCore(): Promise<{ db: Pool; core: string; ids: string[] }> {
    const db = await wipe();
    await runMigrations(url(), await dirUpTo("0019"));
    await db.query("insert into minds (mind_id, key_hash, display_name) values ('alpha', 'k1', 'A')");
    const ev = (await db.query(
      `insert into events (mind_id, kind, payload, written_by, recorded_at, created_at) values ('alpha', 'observe', '{}'::jsonb, 'alpha', now(), now()) returning id`,
    )).rows[0].id;
    const core = (await db.query(
      `insert into nodes (mind_id, node_type, label, content, written_by, source_type) values ('alpha', 'identity', 'core', 'core', 'alpha', 'inferred') returning id`,
    )).rows[0].id as string;
    const ids: string[] = [];
    for (const status of ["pending", "accepted"]) {
      ids.push((await db.query(
        `insert into proposals (mind_id, kind, action, section, content, proposed_by, event_id, created_at, target_node_id, status, effective_at)
         values ('alpha', 'identity', 'retire', 's', 'c', 'alpha', $1, now() + ($4::int * interval '1 second'), $2, $3, now() + interval '1 day') returning id`,
        [ev, core, status, ids.length],
      )).rows[0].id);
    }
    return { db, core, ids };
  }

  it("--dry-run names the cores with two open declarations, the proposal ids and the admin statement, and changes nothing", async () => {
    const { db, core, ids } = await twoOpenOnOneCore();
    const { r, text } = await upgrade({ dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(text).toContain(`mind alpha, core ${core}: proposals ${ids.join(", ")}`);
    expect(text).toContain(`update proposals set status='withdrawn', withdrawn_at=now() where id='${ids[1]}'`);
    expect(text).toContain("admin");
    expect(text).toContain("still-running old version");
    expect((await db.query("select count(*)::int as n from schema_migrations")).rows[0].n).toBe(19);
  });

  it("a real run stops before applying anything, and goes through once one declaration is withdrawn with the printed statement", async () => {
    const { db, core, ids } = await twoOpenOnOneCore();
    const lines: string[] = [];
    await expect(runUpgrade({ databaseUrl: url(), dryRun: false, noBackfill: false }, (l) => lines.push(l))).rejects.toThrow(/migration 0020 would refuse; nothing was applied/);
    const text = lines.join("\n");
    expect(text).toContain(`mind alpha, core ${core}: proposals ${ids.join(", ")}`);
    expect((await db.query("select count(*)::int as n from schema_migrations")).rows[0].n).toBe(19);

    const stmt = /admin: (update proposals set status='withdrawn'[^;]*;)/.exec(text)![1]!;
    await db.query(stmt);
    const ok = await upgrade();
    expect(ok.r.applied).toContain("0020_proposals_guard.sql");
    expect((await db.query("select count(*)::int as n from schema_migrations")).rows[0].n).toBe(26);
  });

  it("prints the database's detail when a migration refuses", async () => {
    await wipe();
    const dir = await dirUpTo("9999");
    await writeFile(path.join(dir, "0099_boom.sql"), "create table boom (x int);\ninsert into boom values (1), (1);\ncreate unique index boom_x on boom (x);\n");
    const lines: string[] = [];
    await expect(runUpgrade({ databaseUrl: url(), dryRun: false, noBackfill: false, dir }, (l) => lines.push(l))).rejects.toThrow(/0099_boom\.sql failed/);
    expect(lines.join("\n")).toContain("detail: Key (x)=(1) is duplicated.");
  });
});

describe("a database newer than the build", () => {
  async function withFutureRow(): Promise<Pool> {
    const db = track(await resetDatabase());
    admin = db;
    await db.query("insert into schema_migrations (filename, checksum) values ('0027_future.sql', 'x')");
    return db;
  }

  it("upgrade reports it, says there is no downgrade, and exits through an error", async () => {
    await withFutureRow();
    const lines: string[] = [];
    await expect(runUpgrade({ databaseUrl: url(), dryRun: false, noBackfill: false }, (l) => lines.push(l))).rejects.toThrow(/does not carry \(0027_future\.sql\).*There is no downgrade/);
    await expect(runUpgrade({ databaseUrl: url(), dryRun: true, noBackfill: false }, () => undefined)).rejects.toThrow(/There is no downgrade/);
  });

  it("assertSchemaCurrent refuses it, and so do http, stdio, daemon and the writing commands", async () => {
    await withFutureRow();
    const pool = track(appPool());
    await expect(assertSchemaCurrent(pool)).rejects.toBeInstanceOf(SchemaAhead);
    const env = { ...process.env, DATABASE_URL: laneUrl("verb"), EMBEDDER: "none", SANCTUM_BEARER: "alpha-test-key", PORT: "0" };
    const cli = path.join(ROOT, "src/cli.ts");
    const cases: [string[], NodeJS.ProcessEnv][] = [
      [["http"], env],
      [["stdio"], env],
      [["daemon", "--once"], { ...env, DATABASE_URL: laneUrl("daemon") }],
      [["extractor", "report", "--mind", "alpha"], { ...env, DATABASE_URL: url() }],
      [["import-mind", "none.json", "--mind", "alpha"], { ...env, DATABASE_URL: laneUrl("import") }],
    ];
    for (const [args, e] of cases) {
      const r = spawnSync(TSX, [cli, ...args], { env: e, encoding: "utf8", timeout: 30_000, input: "" });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("There is no downgrade");
    }
    // export-mind only reads: it runs on a database that is out of step and warns
    const exp = spawnSync(TSX, [cli, "export-mind", "--mind", "alpha", "--out", path.join(await mkdtemp(path.join(tmpdir(), "sanctum-export-")), "a.json")], { env: { ...env, DATABASE_URL: laneUrl("import") }, encoding: "utf8", timeout: 30_000 });
    expect(exp.stderr).toContain("warning: database records migration(s) this build does not carry");
  }, 90_000);
});

describe("arguments and errors", () => {
  it("parses the two flags and rejects anything else", () => {
    expect(parseUpgradeArgs([], { DATABASE_URL: "postgresql://x/y" })).toEqual({ databaseUrl: "postgresql://x/y", dryRun: false, noBackfill: false });
    expect(parseUpgradeArgs(["--dry-run", "--no-backfill"], {})).toMatchObject({ dryRun: true, noBackfill: true });
    expect(() => parseUpgradeArgs(["--bogus"], {})).toThrow(ArgError);
    expect(() => parseUpgradeArgs(["alpha"], {})).toThrow(ArgError);
  });

  it("refuses without DATABASE_URL and on a lane URL", async () => {
    await expect(runUpgrade({ databaseUrl: undefined, dryRun: false, noBackfill: false }, () => undefined)).rejects.toThrow(/DATABASE_URL is not set/);
    admin = track(await resetDatabase());
    await expect(runUpgrade({ databaseUrl: laneUrl("verb"), dryRun: false, noBackfill: false }, () => undefined)).rejects.toThrow(/needs a superuser connection/);
  });
});

describe("the manual-steps table", () => {
  it("UPGRADING.md carries exactly the table in src/upgrade.ts", async () => {
    const doc = await readFile(path.join(ROOT, "UPGRADING.md"), "utf8");
    const begin = doc.indexOf(BEGIN_STEPS_TABLE);
    const end = doc.indexOf(END_STEPS_TABLE);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    expect(doc.slice(begin + BEGIN_STEPS_TABLE.length, end).trim()).toBe(manualStepsMarkdown());
  });

  it("every step names a migration this build carries and a release that CHANGELOG.md lists", async () => {
    const files = await allFiles();
    const changelog = await readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
    for (const s of MANUAL_STEPS) {
      expect(files.some((f) => f.startsWith(`${s.migration}_`)), s.migration).toBe(true);
      expect(changelog, s.release).toContain(`## [${s.release}]`);
      expect(s.text).not.toContain("|");
    }
  });

  it("the package version is the newest CHANGELOG release", async () => {
    const changelog = await readFile(path.join(ROOT, "CHANGELOG.md"), "utf8");
    expect(/^## \[([^\]]+)\]/m.exec(changelog)?.[1]).toBe(packageInfo().version);
  });
});

describe("startup refuses a database that is behind", () => {
  it("assertSchemaCurrent names the number of missing migrations and the command", async () => {
    admin = track(await resetDatabase());
    const pool = track(appPool());
    await expect(assertSchemaCurrent(pool)).resolves.toBeUndefined();
    await admin.query("delete from schema_migrations where filename in ('0025_repair_work.sql', '0026_lanes.sql')");
    const e = await assertSchemaCurrent(pool).catch((x) => x);
    expect(e).toBeInstanceOf(SchemaBehind);
    expect(e.message).toBe("database is 2 migration(s) behind: run `sanctum-mind upgrade` with the admin URL");
    expect((await schemaStatus(pool)).pending).toEqual(["0025_repair_work.sql", "0026_lanes.sql"]);
  });

  it("a login that cannot read schema_migrations is told to upgrade", async () => {
    admin = track(await resetDatabase());
    const pool = track(appPool());
    await admin.query("revoke select on schema_migrations from sanctum_app");
    const e = await assertSchemaCurrent(pool).catch((x) => x);
    expect(e).toBeInstanceOf(SchemaBehind);
    expect(e.message).toContain("run `sanctum-mind upgrade` with the admin URL");
    await runMigrations(url()); // migrate makes it readable again
    await expect(assertSchemaCurrent(pool)).resolves.toBeUndefined();
  });

  it("http, stdio and daemon each refuse to start when the last migration is missing", async () => {
    admin = track(await resetDatabase());
    await admin.query("delete from schema_migrations where filename = '0026_lanes.sql'");
    const env = { ...process.env, DATABASE_URL: laneUrl("verb"), EMBEDDER: "none", SANCTUM_BEARER: "alpha-test-key", PORT: "0" };
    const daemonEnv = { ...env, DATABASE_URL: laneUrl("daemon") };
    const cli = path.join(ROOT, "src/cli.ts");
    const cases: [string[], NodeJS.ProcessEnv][] = [
      [["http"], env],
      [["stdio"], env],
      [["daemon", "--once"], daemonEnv],
    ];
    for (const [args, e] of cases) {
      const r = spawnSync(TSX, [cli, ...args], { env: e, encoding: "utf8", timeout: 30_000, input: "" });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain("database is 1 migration(s) behind: run `sanctum-mind upgrade` with the admin URL");
    }
  }, 60_000);

  it("once the database is current they get past the check", async () => {
    admin = track(await resetDatabase());
    const r = spawnSync(TSX, [path.join(ROOT, "src/cli.ts"), "daemon", "--once", "--mind", "alpha"], {
      env: { ...process.env, DATABASE_URL: laneUrl("daemon"), EMBEDDER: "none" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.stderr).not.toContain("migration(s) behind");
  });
});

describe("version", () => {
  it("package.json is the source: 0.2.0 or later in this build, shown by buildInfo and its text", () => {
    const b = buildInfo();
    expect(b.name).toBe("sanctum-mind");
    expect(b.version).toBe(packageInfo().version);
    expect(b.running_from).toBe("src");
    expect(b.migrations.count).toBeGreaterThanOrEqual(26);
    expect(b.migrations.latest).toMatch(/^\d{4}_/);
    const text = formatBuildInfo(b);
    expect(text.split("\n")[0]).toBe(`sanctum-mind ${b.version}`);
    expect(text).toContain("migrations in this build");
  });

  it("`sanctum-mind version` prints it, with --json too, and needs no database", () => {
    const run = (extra: string[]) => spawnSync(TSX, [path.join(ROOT, "src/cli.ts"), "version", ...extra], { env: { ...process.env, DATABASE_URL: "" }, encoding: "utf8", timeout: 30_000 });
    const plain = run([]);
    expect(plain.status).toBe(0);
    expect(plain.stdout.split("\n")[0]).toBe(`sanctum-mind ${packageInfo().version}`);
    expect(JSON.parse(run(["--json"]).stdout)).toMatchObject({ name: "sanctum-mind", version: packageInfo().version });
  });
});

describe("version in mind_health and GET /health", () => {
  it("mind_health reports {package, schema, pending}", async () => {
    admin = track(await resetDatabase());
    const pool = track(appPool());
    const files = await allFiles();
    const r: any = await runVerb({ pool, registry }, { bearer: "alpha", grants: {} }, "mind_health", { mind_id: "alpha" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.version).toEqual({ package: packageInfo().version, schema: files[files.length - 1]!.replace(/\.sql$/, ""), pending: 0 });
    await admin.query("delete from schema_migrations where filename = '0026_lanes.sql'");
    const behind: any = await runVerb({ pool, registry }, { bearer: "alpha", grants: {} }, "mind_health", { mind_id: "alpha" });
    expect(behind.receipt.projection.version).toEqual({ package: packageInfo().version, schema: "0025_repair_work", pending: 1 });
  });

  it("mind_health still answers when the login cannot read schema_migrations", async () => {
    admin = track(await resetDatabase());
    const pool = track(appPool());
    await admin.query("revoke select on schema_migrations from sanctum_app");
    const r: any = await runVerb({ pool, registry }, { bearer: "alpha", grants: {} }, "mind_health", { mind_id: "alpha" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.version).toEqual({ package: packageInfo().version, schema: null, pending: null });
    expect(r.receipt.projection.counts.events).toBe(0);
  });

  it("GET /health carries version and schema", async () => {
    admin = track(await resetDatabase());
    const pool = track(appPool());
    const server = createHttpServer({ pool, registry });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
      expect(res.status).toBe(200);
      const json: any = await res.json();
      const files = await allFiles();
      expect(json.receipt.projection).toEqual({ verbs: registry.length, db: "up", version: packageInfo().version, schema: files[files.length - 1]!.replace(/\.sql$/, "") });
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });
});
