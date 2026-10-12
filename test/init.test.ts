// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parsePgUrl } from "pg-connection-string";
import pg from "pg";
import { resolveCaller } from "../src/auth.js";
import { assertRlsEnforced, createPool } from "../src/db/pool.js";
import { deriveAppUrl, deriveRoleUrl, formatInit, InitError, parseInitArgs, runInit, verifierMatches, type InitOptions } from "../src/init.js";
import { testDatabaseUrl } from "./helpers.js";

/**
 * sanctum_app and the four real lane roles are cluster-wide. Remember whether each could log in and put that back at the end.
 * The passwords cannot be read back as the plaintext they were set from, so they are not restored: they are cleared (the test
 * logins other files use are the test-prefixed roles with their own passwords; the real roles never carry one from the harness).
 */
const ROLES = ["sanctum_app", "sanctum_verb", "sanctum_daemon", "sanctum_operator", "sanctum_import"] as const;
const savedRoles = new Map<string, { rolcanlogin: boolean }>();
const dirs: string[] = [];
const pools: pg.Pool[] = [];

function opts(over: Partial<InitOptions> = {}): InitOptions {
  return {
    databaseUrl: testDatabaseUrl(),
    mind: "gamma",
    port: 8002,
    httpUrl: "http://localhost:8002",
    json: false,
    rotate: false,
    writeEnv: false,
    legacyLogin: true, // most tests use the legacy sanctum_app login; "a fresh install" below leaves it out
    ...over,
  };
}

function track(p: pg.Pool): pg.Pool {
  pools.push(p);
  return p;
}

async function resetRole(admin: pg.Pool): Promise<void> {
  for (const role of ROLES) {
    const has = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
    if (has.rowCount) await admin.query(`alter role ${role} nologin password null`);
  }
}

beforeAll(async () => {
  const admin = createPool(testDatabaseUrl());
  try {
    for (const role of ROLES) {
      const r = await admin.query("select rolcanlogin from pg_roles where rolname = $1", [role]);
      if (r.rows[0]) savedRoles.set(role, r.rows[0]);
    }
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  const admin = createPool(testDatabaseUrl());
  try {
    await resetRole(admin);
    await admin.query("drop extension if exists vector cascade; drop extension if exists pgcrypto cascade;");
    await admin.query("drop schema public cascade; create schema public;");
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  const admin = createPool(testDatabaseUrl());
  try {
    for (const role of ROLES) {
      const has = await admin.query("select 1 from pg_roles where rolname = $1", [role]);
      if (!has.rowCount) continue;
      const saved = savedRoles.get(role);
      await admin.query(`alter role ${role} ${saved?.rolcanlogin === true ? "login" : "nologin"} password null`);
    }
  } finally {
    await admin.end();
  }
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("init", () => {
  it("sets up a fresh database end to end", async () => {
    const r = await runInit(opts({ appPassword: "pw-one" }));
    expect(r.migrations.applied.length).toBeGreaterThan(0);
    expect(r.app_role).toEqual({ name: "sanctum_app", login: true, password: "set" });
    expect(r.mind.status).toBe("created");
    expect(r.mind.bearer).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, url-safe base64

    const admin = track(createPool(testDatabaseUrl()));
    const login = await admin.query("select rolcanlogin from pg_roles where rolname = 'sanctum_app'");
    expect(login.rows[0].rolcanlogin).toBe(true);

    const app = track(createPool(deriveAppUrl(testDatabaseUrl(), "pw-one")));
    await assertRlsEnforced(app);
    expect(await resolveCaller(app, r.mind.bearer)).toEqual({ bearer: "gamma", grants: {} });
  });

  it("generates the app password once and prints it only then", async () => {
    // roles outlive the schema reset; put sanctum_app back to its fresh-install state
    await runInit(opts({ appPassword: "tmp" }));
    const reset = track(createPool(testDatabaseUrl()));
    await reset.query("alter role sanctum_app nologin password null");
    const first = await runInit(opts({ rotate: true }));
    expect(first.app_role.password).toBe("generated");
    const pw = first.app_role.generated_password!;
    expect(pw.length).toBeGreaterThanOrEqual(32);
    expect(first.app_database_url).toContain(pw);
    const app = track(createPool(first.app_database_url));
    await assertRlsEnforced(app);
    expect((await app.query("select current_user")).rows[0].current_user).toBe("sanctum_app");

    const second = await runInit(opts());
    expect(second.app_role.password).toBe("unchanged");
    expect(second.app_role.generated_password).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain(pw);
    expect(formatInit(second)).not.toContain(pw);
    // the old password still works because it was left unchanged
    const again = track(createPool(first.app_database_url));
    await assertRlsEnforced(again);
  });

  it("--rotate on a suspended mind rotates the key, keeps access suspended and says so", async () => {
    await runInit(opts({ appPassword: "pw" }));
    const admin = track(createPool(testDatabaseUrl()));
    await admin.query("update minds set disabled_at = now() where mind_id = 'gamma'");
    const r = await runInit(opts({ appPassword: "pw", rotate: true }));
    expect(r.mind.status).toBe("rotated");
    expect(r.notes.join(" ")).toContain("access remains suspended; run restore-access");
    expect(formatInit(r)).toContain("access remains suspended; run restore-access");
    expect((await admin.query("select disabled_at from minds where mind_id = 'gamma'")).rows[0].disabled_at).not.toBeNull();
  });

  it("refuses to rotate an existing mind without --rotate, and rotates with it", async () => {
    const first = await runInit(opts({ appPassword: "pw" }));
    const key1 = first.mind.bearer!;

    const second = await runInit(opts({ appPassword: "pw" }));
    expect(second.mind.status).toBe("exists");
    expect(second.mind.bearer).toBeUndefined();
    expect(second.notes.join(" ")).toContain("--rotate");
    expect(formatInit(second)).not.toContain(key1);
    expect(JSON.stringify(second.mcp)).toContain("<bearer-key>");
    const app = track(createPool(deriveAppUrl(testDatabaseUrl(), "pw")));
    expect(await resolveCaller(app, key1)).not.toBeNull();

    const third = await runInit(opts({ appPassword: "pw", rotate: true }));
    expect(third.mind.status).toBe("rotated");
    const key2 = third.mind.bearer!;
    expect(key2).not.toBe(key1);
    expect(await resolveCaller(app, key1)).toBeNull();
    expect(await resolveCaller(app, key2)).not.toBeNull();
  });

  it("--json output parses and carries both MCP config shapes", async () => {
    const r = await runInit(opts({ appPassword: "pw", httpUrl: "https://mind.example.test/", port: 9000 }));
    const parsed = JSON.parse(JSON.stringify(r));
    const stdio = parsed.mcp.stdio.mcpServers["sanctum-mind"];
    expect(stdio.command).not.toBe("npx"); // run under vitest: node on the running file, never the unpublished package
    expect(stdio.args).not.toContain("-y"); // args only: the random key may legitimately contain "-y"
    expect(stdio._note).toMatch(/not published yet/);
    expect(stdio.env.SANCTUM_BEARER).toBe(r.mind.bearer);
    expect(stdio.env.DATABASE_URL).toContain("sanctum_verb"); // the MCP configs carry the verb lane URL, not the legacy one
    expect(stdio.env.DATABASE_URL).not.toContain("pw@"); // a supplied password is never echoed
    const http = parsed.mcp.http.mcpServers["sanctum-mind"];
    expect(http).toEqual({
      type: "http",
      url: "https://mind.example.test/mcp",
      headers: { Authorization: `Bearer ${r.mind.bearer}` },
    });
    expect(parsed.curl).toContain("https://mind.example.test/verbs/mind_orient");
    expect(parsed.curl).toContain("mind_orient");
  });

  it("--json without --docker has stdio and http, no stdio_docker", async () => {
    const r = await runInit(opts({ appPassword: "pw" }));
    const parsed = JSON.parse(JSON.stringify(r));
    expect(Object.keys(parsed.mcp).sort()).toEqual(["http", "stdio"]);
    expect(parsed.mcp.stdio_docker).toBeUndefined();
    const text = formatInit(r);
    expect(text).toContain("MCP client config, stdio (Claude Desktop");
    expect(text).not.toContain("stdio (Docker)");
  });

  it("--docker prints http and stdio (Docker) only, passing the key per exec", async () => {
    const r = await runInit(opts({ appPassword: "pw", docker: true }));
    const parsed = JSON.parse(JSON.stringify(r));
    expect(Object.keys(parsed.mcp).sort()).toEqual(["http", "stdio_docker"]);
    expect(parsed.mcp.stdio_docker).toEqual({
      mcpServers: {
        "sanctum-mind": {
          command: "docker",
          args: ["exec", "-i", "-e", "SANCTUM_BEARER", "sanctum-mind", "node", "dist/cli.js", "stdio"],
          env: { SANCTUM_BEARER: r.mind.bearer },
        },
      },
    });
    expect(JSON.stringify(parsed.mcp.stdio_docker.mcpServers["sanctum-mind"].args)).not.toContain(r.mind.bearer!); // never on the command line
    expect(JSON.stringify(parsed.mcp)).not.toContain("DATABASE_URL"); // the host never sees a database credential
    expect(JSON.stringify(parsed.mcp)).not.toContain("/app/dist/cli.js");
    const text = formatInit(r);
    expect(text).toContain("stdio (Docker)");
    expect(text).not.toContain("MCP client config, stdio (Claude Desktop");
    expect(text).toContain("Streamable HTTP");
  });

  it("--docker on an existing mind shows the key placeholder, and --container renames the target", async () => {
    await runInit(opts({ appPassword: "pw", docker: true }));
    const again = await runInit(opts({ appPassword: "pw", docker: true, container: "other-mind" }));
    const srv = again.mcp.stdio_docker!.mcpServers["sanctum-mind"];
    expect(srv.env.SANCTUM_BEARER).toBe("<bearer-key>");
    expect(srv.args).toContain("other-mind");
  });

  it("writes .env only with --write-env and never overwrites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-init-"));
    dirs.push(dir);
    const without = await runInit(opts({ appPassword: "pw", lanePasswords: { verb: "verbpw" }, envDir: dir }));
    expect(without.env_file).toBeNull();
    await expect(readFile(join(dir, ".env"), "utf8")).rejects.toThrow();

    const written = await runInit(opts({ appPassword: "pw", lanePasswords: { verb: "verbpw" }, envDir: dir, writeEnv: true, rotate: true }));
    expect(written.env_file?.status).toBe("written");
    const text = await readFile(join(dir, ".env"), "utf8");
    expect(text).toContain(`DATABASE_URL=${deriveRoleUrl(testDatabaseUrl(), "sanctum_verb", "verbpw")}`);
    expect(text).toContain(`SANCTUM_BEARER=${written.mind.bearer}`);

    await writeFile(join(dir, ".env"), "KEEP=1\n");
    const again = await runInit(opts({ appPassword: "pw", lanePasswords: { verb: "verbpw" }, envDir: dir, writeEnv: true, rotate: true }));
    expect(again.env_file?.status).toBe("exists");
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("KEEP=1\n");
  });

  it("refuses a non-admin DATABASE_URL with a clear message", async () => {
    await runInit(opts({ appPassword: "pw" })); // creates schema, extensions and sanctum_app login
    const app = deriveAppUrl(testDatabaseUrl(), "pw");
    await expect(runInit(opts({ databaseUrl: app }))).rejects.toThrow(/must be an admin connection/);
    await expect(runInit(opts({ databaseUrl: app }))).rejects.toBeInstanceOf(InitError);
  });

  it("rejects a missing DATABASE_URL and a bad mind id before touching anything", async () => {
    await expect(runInit(opts({ databaseUrl: undefined }))).rejects.toThrow(/DATABASE_URL is not set/);
    await expect(runInit(opts({ mind: "bad id!" }))).rejects.toThrow(/invalid mind_id/);
    await expect(runInit(opts({ mind: "__proto__" }))).rejects.toThrow(/invalid mind_id/);
  });
});

describe("init and the legacy login", () => {
  it("a fresh install enables no sanctum_app login unless --legacy-login is passed; an existing login is left alone", async () => {
    const admin = track(createPool(testDatabaseUrl()));
    const fresh = await runInit(opts({ legacyLogin: false }));
    expect(fresh.app_role).toEqual({ name: "sanctum_app", login: false, password: "none" });
    expect(fresh.app_database_url).toBe("");
    expect((await admin.query("select rolcanlogin from pg_roles where rolname = 'sanctum_app'")).rows[0].rolcanlogin).toBe(false);
    const text = formatInit(fresh);
    expect(text).toContain("no login");
    expect(text).not.toContain("Legacy shared lane");
    expect(JSON.stringify(fresh.mcp)).toContain("sanctum_verb");
    const withIt = await runInit(opts({ legacyLogin: true }));
    expect(withIt.app_role).toMatchObject({ login: true, password: "generated" });
    expect(formatInit(withIt)).toContain("Legacy shared lane");
    // an upgrade: the login exists, so a run without the flag leaves it alone (same password, still a login)
    const again = await runInit(opts({ legacyLogin: false }));
    expect(again.app_role).toMatchObject({ login: true, password: "unchanged" });
    expect(parseInitArgs(["--mind", "a", "--legacy-login"], {}).legacyLogin).toBe(true);
  });

  it("recreates a lane role that is missing from a database that recorded 0026", async () => {
    await runInit(opts());
    const admin = track(createPool(testDatabaseUrl()));
    await admin.query("drop owned by sanctum_import");
    await admin.query("drop role sanctum_import");
    const r = await runInit(opts()); // migrations are all recorded: only init can repair the role
    expect(r.migrations.applied).toEqual([]);
    expect(r.lane_roles.import).toMatchObject({ name: "sanctum_import", login: true, password: "generated" });
    const member = await admin.query("select 1 from pg_auth_members where roleid = 'sanctum_app'::regrole and member = 'sanctum_import'::regrole");
    expect(member.rowCount).toBe(1);
    const pool = track(createPool(r.lanes.import));
    expect((await pool.query("select sanctum_actor() as a")).rows[0].a).toBe("import");
  });

  it("repairs a missing sanctum_operator fully: membership and its direct grants on extractor_state and grants", async () => {
    await runInit(opts());
    const admin = track(createPool(testDatabaseUrl()));
    await admin.query("drop owned by sanctum_operator");
    await admin.query("drop role sanctum_operator");
    const r = await runInit(opts());
    expect(r.lane_roles.operator).toMatchObject({ name: "sanctum_operator", login: true });
    const can = async (table: string, priv: string) => (await admin.query("select has_table_privilege('sanctum_operator', $1, $2) as ok", [table, priv])).rows[0].ok;
    for (const [t, priv] of [["extractor_state", "update"], ["extractor_state", "insert"], ["grants", "insert"], ["grants", "update"]] as const) expect(await can(t, priv)).toBe(true);
    expect((await admin.query("select 1 from pg_auth_members where roleid = 'sanctum_app'::regrole and member = 'sanctum_operator'::regrole")).rowCount).toBe(1);
    expect(await can("events", "delete")).toBe(false);
  });
});

describe("init and the lane logins", () => {
  const LANE_LIST = ["verb", "daemon", "operator", "import"] as const;

  it("creates the four lane logins, prints four labelled URLs plus the legacy one, and puts the verb URL in the MCP configs", async () => {
    const r = await runInit(opts({ appPassword: "pw" }));
    for (const lane of LANE_LIST) {
      const role = `sanctum_${lane}`;
      expect(r.lane_roles[lane]).toMatchObject({ name: role, login: true, password: "generated" });
      const pw = r.lane_roles[lane].generated_password!;
      expect(pw.length).toBeGreaterThanOrEqual(32);
      expect(r.lanes[lane]).toContain(pw);
      expect(parsePgUrl(r.lanes[lane]).user).toBe(role);
      const pool = track(createPool(r.lanes[lane]));
      await assertRlsEnforced(pool); // plain roles, not superuser or BYPASSRLS
      expect((await pool.query("select session_user::text as u")).rows[0].u).toBe(role);
      expect((await pool.query("select sanctum_actor() as a")).rows[0].a).toBe(lane);
    }
    expect(parsePgUrl(r.app_database_url).user).toBe("sanctum_app");
    // the configs carry the verb URL (stdio), the HTTP config is unchanged
    const stdio = r.mcp.stdio!.mcpServers["sanctum-mind"];
    expect(stdio.env.DATABASE_URL).toBe(r.lanes.verb);
    expect(JSON.stringify(r.mcp.http)).not.toContain("DATABASE_URL");
    const text = formatInit(r);
    for (const lane of LANE_LIST) expect(text).toContain(r.lanes[lane]);
    expect(text).toMatch(/verb\s+http and stdio/);
    expect(text).toMatch(/daemon\s+the daemon/);
    expect(text).toMatch(/operator\s+extractor and grant/);
    expect(text).toMatch(/import\s+export-mind, import-mind, embed-backfill, sinks requeue/);
    expect(text).toContain("Legacy shared lane (works, warns");
    // --json carries lanes: {verb, daemon, operator, import} as URLs
    const parsed = JSON.parse(JSON.stringify(r));
    expect(Object.keys(parsed.lanes).sort()).toEqual([...LANE_LIST].sort());
    expect(parsed.lanes.daemon).toBe(r.lanes.daemon);
  });

  it("uses supplied lane passwords, keeps existing ones on a second run (placeholder, never echoed) and refuses a different one without --force", async () => {
    const pws = { verb: "v-pw", daemon: "d-pw", operator: "o-pw", import: "i-pw" };
    const first = await runInit(opts({ appPassword: "pw", lanePasswords: pws }));
    for (const lane of LANE_LIST) {
      expect(first.lane_roles[lane].password).toBe("set");
      expect(first.lanes[lane]).toContain("<lane-password>");
      const pool = track(createPool(deriveRoleUrl(testDatabaseUrl(), `sanctum_${lane}`, pws[lane])));
      expect((await pool.query("select sanctum_actor() as a")).rows[0].a).toBe(lane);
    }
    const again = await runInit(opts({ appPassword: "pw", lanePasswords: pws }));
    for (const lane of LANE_LIST) expect(again.lane_roles[lane].password).toBe("unchanged");
    const bare = await runInit(opts({ appPassword: "pw" }));
    for (const lane of LANE_LIST) expect(bare.lane_roles[lane].password).toBe("unchanged");
    expect(bare.notes.join(" ")).toContain("--lane-password-verb");
    expect(JSON.stringify(bare)).not.toContain("v-pw");
    await expect(runInit(opts({ appPassword: "pw", lanePasswords: { ...pws, daemon: "other" } }))).rejects.toThrow(/sanctum_daemon login already exists and a different password/);
    const forced = await runInit(opts({ appPassword: "pw", lanePasswords: { ...pws, daemon: "other" }, force: true }));
    expect(forced.lane_roles.daemon.password).toBe("set");
    expect(forced.notes.join(" ")).toContain("sanctum_daemon already had a login");
    // the .env of a run that does not know the verb password is skipped, naming the flag
    const dir = await mkdtemp(join(tmpdir(), "sanctum-init-"));
    dirs.push(dir);
    const skipped = await runInit(opts({ appPassword: "pw", envDir: dir, writeEnv: true }));
    expect(skipped.env_file).toMatchObject({ status: "skipped" });
    expect(skipped.env_file?.reason).toContain("--lane-password-verb");
  });

  it("--rotate-lanes issues new passwords for logins that already have one, shown once", async () => {
    const pws = { verb: "v-pw", daemon: "d-pw", operator: "o-pw", import: "i-pw" };
    await runInit(opts({ appPassword: "pw", lanePasswords: pws }));
    const r = await runInit(opts({ appPassword: "pw", rotateLanes: true }));
    for (const lane of LANE_LIST) {
      expect(r.lane_roles[lane].password).toBe("generated");
      const fresh = track(createPool(r.lanes[lane]));
      expect((await fresh.query("select sanctum_actor() as a")).rows[0].a).toBe(lane);
      // (the test cluster may use trust authentication, so compare the stored verifier rather than trying to log in)
      const stored = (await track(createPool(testDatabaseUrl())).query("select rolpassword from pg_authid where rolname = $1", [`sanctum_${lane}`])).rows[0].rolpassword;
      expect(verifierMatches(stored, `sanctum_${lane}`, pws[lane])).toBe(false);
      expect(verifierMatches(stored, `sanctum_${lane}`, r.lane_roles[lane].generated_password!)).toBe(true);
    }
    expect(r.app_role.password).toBe("unchanged"); // sanctum_app is not a lane and is not rotated
    expect(r.notes.join(" ")).toContain("sanctum_verb already had a login; its password was rotated");
  });

  it("reads lane passwords from flags and from SANCTUM_LANE_PASSWORD_<LANE>, flags first", () => {
    const o = parseInitArgs(["--mind", "a", "--lane-password-daemon", "flag"], {
      SANCTUM_LANE_PASSWORD_VERB: "ev", SANCTUM_LANE_PASSWORD_DAEMON: "ed", SANCTUM_LANE_PASSWORD_OPERATOR: "", SANCTUM_LANE_PASSWORD_IMPORT: "ei",
    });
    expect(o.lanePasswords).toEqual({ verb: "ev", daemon: "flag", import: "ei" });
    expect(o.rotateLanes).toBe(false);
    expect(parseInitArgs(["--mind", "a", "--rotate-lanes"], {}).rotateLanes).toBe(true);
    expect(() => parseInitArgs(["--mind", "a", "--lane-password-verb", ""], {})).toThrow(/--lane-password-verb must not be empty/);
  });
});

describe("parseInitArgs", () => {
  it("applies defaults and reads flags", () => {
    const o = parseInitArgs(["--mind", "alpha"], { DATABASE_URL: "postgresql://x/y" });
    expect(o).toMatchObject({ mind: "alpha", port: 8002, httpUrl: "http://localhost:8002", json: false, rotate: false, writeEnv: false });
    const p = parseInitArgs(["--mind", "a", "--port", "9", "--json", "--rotate", "--write-env", "--app-password", "s"], {});
    expect(p).toMatchObject({ port: 9, httpUrl: "http://localhost:9", json: true, rotate: true, writeEnv: true, appPassword: "s" });
  });

  it("reads --docker and --container", () => {
    const d = parseInitArgs(["--mind", "a"], {});
    expect(d.docker).toBe(false);
    expect(d.container).toBe("sanctum-mind");
    const o = parseInitArgs(["--mind", "a", "--docker", "--container", "x-mind-1"], {});
    expect(o.docker).toBe(true);
    expect(o.container).toBe("x-mind-1");
    expect(() => parseInitArgs(["--mind", "a", "--container", "bad name;"], {})).toThrow(/invalid --container/);
  });

  it("requires --mind and a sane port", () => {
    expect(() => parseInitArgs([], {})).toThrow(/--mind/);
    expect(() => parseInitArgs(["--mind", "a", "--port", "99999"], {})).toThrow(/invalid --port/);
    expect(() => parseInitArgs(["--mind", "a", "--bogus"], {})).toThrow(InitError);
  });
});

describe("stdio config", () => {
  it("stdio exits 1 with a clear message when SANCTUM_BEARER is unset, before any database connection", () => {
    const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none" }; // unreachable: must not be tried
    delete env.SANCTUM_BEARER;
    const r = spawnSync(tsx, [cli, "stdio"], { env, encoding: "utf8", timeout: 15_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("SANCTUM_BEARER is not set");
    expect(r.stderr).toContain("the mind's key");
    expect(r.stdout).toBe(""); // stdout belongs to the MCP protocol
  });

  it("runs the local checkout, never the unpublished npm package", async () => {
    const dist = await runInit(opts({ appPassword: "pw", cliPath: new URL("../dist/cli.js", import.meta.url).pathname }));
    const d = dist.mcp.stdio!.mcpServers["sanctum-mind"];
    expect(d.command).toBe("node");
    expect(d.args).toEqual([new URL("../dist/cli.js", import.meta.url).pathname, "stdio"]);
    expect(d._note).toBe("replace the path if you move the checkout; the npm package is not published yet");

    const ts = await runInit(opts({ appPassword: "pw", cliPath: new URL("../src/cli.ts", import.meta.url).pathname }));
    const t = ts.mcp.stdio!.mcpServers["sanctum-mind"];
    expect(t.command).toBe("npx");
    expect(t.args).toEqual(["tsx", new URL("../src/cli.ts", import.meta.url).pathname, "stdio"]);

    for (const r of [dist, ts, await runInit(opts({ appPassword: "pw" }))]) {
      expect(JSON.stringify(r.mcp.stdio)).not.toContain("sanctum-mind\",\"stdio");
      expect(formatInit(r)).not.toContain("npx -y");
      expect(r.mcp.stdio!.mcpServers["sanctum-mind"].args).not.toContain("-y");
    }
  });
});

describe("deriveAppUrl", () => {
  it("percent-encodes the password so it round-trips", async () => {
    for (const pw of ["a%41b", "p@ss/w:rd?#", "plain", "sp ace&x=1"]) {
      const url = deriveAppUrl("postgresql://postgres:adm@localhost:5433/db", pw);
      expect(parsePgUrl(url).password).toBe(pw);
      expect(parsePgUrl(url).user).toBe("sanctum_app");
    }
    // and it really connects with such a password
    await runInit(opts({ appPassword: "a%41b" }));
    const app = track(createPool(deriveAppUrl(testDatabaseUrl(), "a%41b")));
    await assertRlsEnforced(app);
  });

  it("drops user and password query parameters of the admin URL", () => {
    const url = deriveAppUrl("postgresql://localhost:5433/db?user=postgres&password=secret&sslmode=disable", "newpw");
    expect(url).not.toContain("secret");
    expect(url).not.toContain("user=postgres");
    expect(url).toContain("sslmode=disable");
    const c = parsePgUrl(url);
    expect(c.user).toBe("sanctum_app");
    expect(c.password).toBe("newpw");
    expect(c.host).toBe("localhost");
  });

  it("puts credentials in the query for a socket URL (empty host)", () => {
    const url = deriveAppUrl("postgresql:///sanctum_mind?host=/var/run/postgresql&user=postgres&password=adm", "a%41b&c");
    expect(url).not.toContain("adm");
    const u = new URL(url);
    expect(u.username).toBe("");
    expect(u.searchParams.get("user")).toBe("sanctum_app");
    expect(u.searchParams.get("password")).toBe("a%41b&c");
    expect(u.searchParams.get("host")).toBe("/var/run/postgresql");
    const c = parsePgUrl(url);
    expect(c.user).toBe("sanctum_app");
    expect(c.password).toBe("a%41b&c");
    expect(c.host).toBe("/var/run/postgresql");
  });
});

describe("generated password output", () => {
  it("is on its own line in text and a top-level JSON field, once", async () => {
    await runInit(opts({ appPassword: "tmp" }));
    const reset = track(createPool(testDatabaseUrl()));
    await reset.query("alter role sanctum_app nologin password null");
    const r = await runInit(opts({ rotate: true }));
    const pw = r.generated_password!;
    expect(pw).toBeTruthy();
    expect(JSON.parse(JSON.stringify(r)).generated_password).toBe(pw);
    expect(formatInit(r).split("\n")).toContain(pw);
    const again = await runInit(opts());
    expect(again.generated_password).toBeUndefined();
    expect(formatInit(again)).not.toContain(pw);
  });
});

describe("shared sanctum_app role", () => {
  it("refuses to change the password of an existing login without --force", async () => {
    await runInit(opts({ appPassword: "first" }));
    const err = await runInit(opts({ appPassword: "second" })).catch((e) => e);
    expect(err).toBeInstanceOf(InitError);
    expect(err.message).toMatch(/already exists/);
    expect(err.message).toMatch(/--force/);
    // nothing changed: the old password still works, the new one does not
    const old = track(createPool(deriveAppUrl(testDatabaseUrl(), "first")));
    await assertRlsEnforced(old);
    const admin = track(createPool(testDatabaseUrl()));
    const v = await admin.query("select rolpassword from pg_authid where rolname = 'sanctum_app'");
    expect(verifierMatches(v.rows[0].rolpassword, "sanctum_app", "first")).toBe(true);
    expect(verifierMatches(v.rows[0].rolpassword, "sanctum_app", "second")).toBe(false);

    const forced = await runInit(opts({ appPassword: "second", force: true }));
    expect(forced.app_role.password).toBe("set");
    const v2 = await admin.query("select rolpassword from pg_authid where rolname = 'sanctum_app'");
    expect(verifierMatches(v2.rows[0].rolpassword, "sanctum_app", "second")).toBe(true);
  });

  it("re-running with the same password, or none, leaves the role alone", async () => {
    await runInit(opts({ appPassword: "same" }));
    const admin = track(createPool(testDatabaseUrl()));
    const before = (await admin.query("select rolpassword from pg_authid where rolname = 'sanctum_app'")).rows[0].rolpassword;
    const same = await runInit(opts({ appPassword: "same" }));
    expect(same.app_role.password).toBe("unchanged");
    const none = await runInit(opts());
    expect(none.app_role.password).toBe("unchanged");
    expect((await admin.query("select rolpassword from pg_authid where rolname = 'sanctum_app'")).rows[0].rolpassword).toBe(before);
  });
});

describe("init options", () => {
  it("rejects an empty --app-password", () => {
    expect(() => parseInitArgs(["--mind", "a", "--app-password", ""], {})).toThrow(/must not be empty/);
    expect(() => parseInitArgs(["--mind", "a", "--app-password="], {})).toThrow(/must not be empty/);
  });

  it("--public-db-host changes only the printed configs", async () => {
    const r = await runInit(opts({ appPassword: "pw", publicDbHost: "db.example.test:6543" }));
    expect(r.app_database_url).toContain("db.example.test:6543");
    expect(r.mcp.stdio!.mcpServers["sanctum-mind"].env.DATABASE_URL).toContain("db.example.test:6543");
    expect(r.migrations.applied.length).toBeGreaterThan(0); // the real connection still worked
    expect(parseInitArgs(["--mind", "a", "--public-db-host", "localhost:5432"], {}).publicDbHost).toBe("localhost:5432");
    expect(() => parseInitArgs(["--mind", "a", "--public-db-host", "bad host/x"], {})).toThrow(/public-db-host/);
  });
});
