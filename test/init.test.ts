import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse as parsePgUrl } from "pg-connection-string";
import pg from "pg";
import { resolveCaller } from "../src/auth.js";
import { assertRlsEnforced, createPool } from "../src/db/pool.js";
import { deriveAppUrl, formatInit, InitError, parseInitArgs, runInit, verifierMatches, type InitOptions } from "../src/init.js";
import { testDatabaseUrl } from "./helpers.js";

/** sanctum_app is cluster-wide: remember its login and password at the start and put them back at the end. */
let savedRole: { rolpassword: string | null; rolcanlogin: boolean } | null = null;
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
    ...over,
  };
}

function track(p: pg.Pool): pg.Pool {
  pools.push(p);
  return p;
}

async function resetRole(admin: pg.Pool): Promise<void> {
  const has = await admin.query("select 1 from pg_roles where rolname = 'sanctum_app'");
  if (has.rowCount) await admin.query("alter role sanctum_app nologin password null");
}

beforeAll(async () => {
  const admin = createPool(testDatabaseUrl());
  try {
    const r = await admin.query("select rolpassword, rolcanlogin from pg_authid where rolname = 'sanctum_app'");
    savedRole = r.rows[0] ?? null;
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
    const has = await admin.query("select 1 from pg_roles where rolname = 'sanctum_app'");
    if (has.rowCount) {
      if (savedRole === null) {
        await admin.query("alter role sanctum_app nologin password null");
      } else {
        const stmt = await admin.query(
          `select format('alter role sanctum_app %s password %s', case when $1::boolean then 'login' else 'nologin' end,
                         coalesce(quote_literal($2::text), 'null')) as sql`,
          [savedRole.rolcanlogin, savedRole.rolpassword],
        );
        await admin.query(stmt.rows[0].sql);
      }
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
    expect(JSON.stringify(stdio)).not.toContain("-y");
    expect(stdio._note).toMatch(/not published yet/);
    expect(stdio.env.SANCTUM_BEARER).toBe(r.mind.bearer);
    expect(stdio.env.DATABASE_URL).toContain("sanctum_app");
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

  it("writes .env only with --write-env and never overwrites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sanctum-init-"));
    dirs.push(dir);
    const without = await runInit(opts({ appPassword: "pw", envDir: dir }));
    expect(without.env_file).toBeNull();
    await expect(readFile(join(dir, ".env"), "utf8")).rejects.toThrow();

    const written = await runInit(opts({ appPassword: "pw", envDir: dir, writeEnv: true, rotate: true }));
    expect(written.env_file?.status).toBe("written");
    const text = await readFile(join(dir, ".env"), "utf8");
    expect(text).toContain(`DATABASE_URL=${deriveAppUrl(testDatabaseUrl(), "pw")}`);
    expect(text).toContain(`SANCTUM_BEARER=${written.mind.bearer}`);

    await writeFile(join(dir, ".env"), "KEEP=1\n");
    const again = await runInit(opts({ appPassword: "pw", envDir: dir, writeEnv: true, rotate: true }));
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

describe("parseInitArgs", () => {
  it("applies defaults and reads flags", () => {
    const o = parseInitArgs(["--mind", "alpha"], { DATABASE_URL: "postgresql://x/y" });
    expect(o).toMatchObject({ mind: "alpha", port: 8002, httpUrl: "http://localhost:8002", json: false, rotate: false, writeEnv: false });
    const p = parseInitArgs(["--mind", "a", "--port", "9", "--json", "--rotate", "--write-env", "--app-password", "s"], {});
    expect(p).toMatchObject({ port: 9, httpUrl: "http://localhost:9", json: true, rotate: true, writeEnv: true, appPassword: "s" });
  });

  it("requires --mind and a sane port", () => {
    expect(() => parseInitArgs([], {})).toThrow(/--mind/);
    expect(() => parseInitArgs(["--mind", "a", "--port", "99999"], {})).toThrow(/invalid --port/);
    expect(() => parseInitArgs(["--mind", "a", "--bogus"], {})).toThrow(InitError);
  });
});

describe("stdio config", () => {
  it("runs the local checkout, never the unpublished npm package", async () => {
    const dist = await runInit(opts({ appPassword: "pw", cliPath: new URL("../dist/cli.js", import.meta.url).pathname }));
    const d = dist.mcp.stdio.mcpServers["sanctum-mind"];
    expect(d.command).toBe("node");
    expect(d.args).toEqual([new URL("../dist/cli.js", import.meta.url).pathname, "stdio"]);
    expect(d._note).toBe("replace the path if you move the checkout; the npm package is not published yet");

    const ts = await runInit(opts({ appPassword: "pw", cliPath: new URL("../src/cli.ts", import.meta.url).pathname }));
    const t = ts.mcp.stdio.mcpServers["sanctum-mind"];
    expect(t.command).toBe("npx");
    expect(t.args).toEqual(["tsx", new URL("../src/cli.ts", import.meta.url).pathname, "stdio"]);

    for (const r of [dist, ts, await runInit(opts({ appPassword: "pw" }))]) {
      expect(JSON.stringify(r.mcp.stdio)).not.toContain("sanctum-mind\",\"stdio");
      expect(formatInit(r)).not.toContain("npx -y");
      expect(r.mcp.stdio.mcpServers["sanctum-mind"].args).not.toContain("-y");
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
    expect(r.mcp.stdio.mcpServers["sanctum-mind"].env.DATABASE_URL).toContain("db.example.test:6543");
    expect(r.migrations.applied.length).toBeGreaterThan(0); // the real connection still worked
    expect(parseInitArgs(["--mind", "a", "--public-db-host", "localhost:5432"], {}).publicDbHost).toBe("localhost:5432");
    expect(() => parseInitArgs(["--mind", "a", "--public-db-host", "bad host/x"], {})).toThrow(/public-db-host/);
  });
});
