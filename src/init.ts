import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { isValidMindId, mindIdProblem, upsertMinds } from "./auth.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";

export interface InitOptions {
  /** Admin connection string. */
  databaseUrl: string | undefined;
  mind: string;
  /** Password for the sanctum_app login. Generated on first setup when omitted. */
  appPassword?: string | undefined;
  port: number;
  httpUrl: string;
  json: boolean;
  rotate: boolean;
  /** Write ./.env (never overwrites). */
  writeEnv: boolean;
  /** Directory for the .env file. */
  envDir?: string;
  /** Change the password of a sanctum_app login that already exists. */
  force?: boolean;
  /** host:port shown in the printed configs instead of the connection's own (Docker: the host-side address). */
  publicDbHost?: string | undefined;
  /** The cli entry that the stdio config should launch; default: the running one. */
  cliPath?: string;
}

export type MindStatus = "created" | "exists" | "rotated";
export type PasswordStatus = "generated" | "set" | "unchanged";

export interface InitResult {
  migrations: { applied: string[]; skipped: string[] };
  app_role: { name: "sanctum_app"; login: true; password: PasswordStatus; generated_password?: string };
  /** Present only on the run that generated the sanctum_app password. */
  generated_password?: string;
  mind: { id: string; status: MindStatus; bearer?: string };
  /** Contains the real password only when it was generated this run; otherwise a placeholder. */
  app_database_url: string;
  mcp: {
    stdio: { mcpServers: { "sanctum-mind": { _note: string; command: string; args: string[]; env: Record<string, string> } } };
    http: { mcpServers: { "sanctum-mind": { type: "http"; url: string; headers: { Authorization: string } } } };
  };
  curl: string;
  env_file: { path: string; status: "written" | "exists" | "skipped"; reason?: string } | null;
  notes: string[];
}

export class InitError extends Error {}

const APP_PW_PLACEHOLDER = "<app-password>";
const BEARER_PLACEHOLDER = "<bearer-key>";

export function parseInitArgs(argv: string[], env: Record<string, string | undefined>): InitOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        mind: { type: "string" },
        "app-password": { type: "string" },
        port: { type: "string" },
        "http-url": { type: "string" },
        json: { type: "boolean", default: false },
        rotate: { type: "boolean", default: false },
        "write-env": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "public-db-host": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (e) {
    throw new InitError(`${e instanceof Error ? e.message : String(e)}\n${INIT_USAGE}`);
  }
  if (values.mind === undefined) throw new InitError(`--mind <id> is required\n${INIT_USAGE}`);
  const port = values.port === undefined ? 8002 : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InitError(`invalid --port "${values.port}"`);
  if (values["app-password"] === "") throw new InitError("--app-password must not be empty");
  const appPassword = values["app-password"] ?? (env.SANCTUM_APP_PASSWORD || undefined);
  const publicDbHost = values["public-db-host"];
  if (publicDbHost !== undefined) checkHostPort(publicDbHost);
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    mind: values.mind,
    appPassword,
    port,
    httpUrl: values["http-url"] ?? `http://localhost:${port}`,
    json: values.json ?? false,
    rotate: values.rotate ?? false,
    writeEnv: values["write-env"] ?? false,
    force: values.force ?? false,
    publicDbHost,
  };
}

function checkHostPort(v: string): void {
  let ok = false;
  try {
    const u = new URL(`postgresql://${v}`);
    ok = u.hostname !== "" && u.pathname === "" && u.search === "" && u.username === "" && `${u.host}`.length > 0 && !/[/?#@\s]/.test(v);
  } catch {
    ok = false;
  }
  if (!ok) throw new InitError(`invalid --public-db-host "${v}" (expected host or host:port, for example localhost:5432)`);
}

export const INIT_USAGE = `usage: DATABASE_URL=<admin url> sanctum-mind init --mind <id> [options]

options:
  --mind <id>            mind to create (required; a-z A-Z 0-9 _ -, 1 to 64 chars)
  --app-password <pw>    password for the sanctum_app login (default: generated on first setup;
                         SANCTUM_APP_PASSWORD is read when the flag is absent and is preferred,
                         because command-line arguments are visible to other users in ps)
  --force                change the password of a sanctum_app login that already exists
                         (the login is shared by every mind in the cluster)
  --public-db-host <h:p> database host:port to print in the configs (the connection itself is unchanged;
                         use it when the service and your client reach the database at different addresses)
  --port <n>             HTTP port (default 8002)
  --http-url <url>       public URL of the HTTP service (default http://localhost:<port>)
  --rotate               replace the key of a mind that already exists
  --write-env            write ./.env with the app settings (never overwrites)
  --json                 machine-readable output`;

function newSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** The connection must be able to create roles and extensions; checked before anything is changed. */
async function assertAdmin(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (e) {
    throw new InitError(`could not connect to DATABASE_URL: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const me = await client.query<{ rolname: string; ok: boolean }>(
      "select rolname, (rolsuper or rolcreaterole) as ok from pg_roles where rolname = current_user",
    );
    const role = me.rows[0];
    let denied = !role?.ok;
    if (!denied) {
      try {
        await client.query("create extension if not exists pgcrypto");
      } catch {
        denied = true;
      }
    }
    if (denied) {
      throw new InitError(
        `DATABASE_URL must be an admin connection (a superuser or a role that can create roles and extensions), but "${role?.rolname ?? "?"}" cannot. ` +
          "Use the admin URL here (for example the postgres user); the service itself later runs as sanctum_app.",
      );
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The sanctum_app URL for an admin URL: same host, database and query, with the admin's own
 * credentials (userinfo or user/password query parameters) replaced. The password is percent-encoded.
 * A URL with an empty host (a unix socket, host given in the query) cannot carry userinfo, so the
 * credentials go in the user and password query parameters, which node-postgres reads.
 */
export function deriveAppUrl(adminUrl: string, password: string): string {
  const u = new URL(adminUrl);
  u.searchParams.delete("user");
  u.searchParams.delete("password");
  if (u.hostname === "") {
    u.username = "";
    u.password = "";
    u.searchParams.set("user", "sanctum_app");
    u.searchParams.set("password", password);
  } else {
    u.username = "sanctum_app";
    u.password = encodeURIComponent(password);
  }
  return u.toString();
}

/** The URL with the given host:port in place of its own (printing only). */
function withPublicHost(url: string, hostPort: string | undefined): string {
  if (hostPort === undefined) return url;
  const u = new URL(url);
  if (u.hostname === "") {
    // socket URL: the host lives in the query; the public address replaces it
    u.searchParams.delete("host");
    u.searchParams.delete("port");
    const pub = new URL(`postgresql://${hostPort}`);
    const user = u.searchParams.get("user");
    const pw = u.searchParams.get("password");
    u.searchParams.delete("user");
    u.searchParams.delete("password");
    const out = new URL(u.toString());
    out.username = user ?? "";
    out.password = pw === null ? "" : encodeURIComponent(pw);
    out.host = pub.host;
    return out.toString();
  }
  u.host = new URL(`postgresql://${hostPort}`).host;
  return u.toString();
}

const MASK_SENTINEL = "PWSENTINELx0x";

function maskedAppUrl(adminUrl: string, hostPort: string | undefined): string {
  return withPublicHost(deriveAppUrl(adminUrl, MASK_SENTINEL), hostPort).replace(MASK_SENTINEL, APP_PW_PLACEHOLDER);
}

/** True when `password` is the one behind a pg_authid verifier (SCRAM-SHA-256 or md5). */
export function verifierMatches(verifier: string | null | undefined, role: string, password: string): boolean {
  if (!verifier) return false;
  if (verifier.startsWith("md5")) {
    return verifier === "md5" + createHash("md5").update(password + role).digest("hex");
  }
  const m = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
  if (!m) return false;
  const salted = pbkdf2Sync(password, Buffer.from(m[2]!, "base64"), Number(m[1]), 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(clientKey).digest();
  const want = Buffer.from(m[3]!, "base64");
  return want.length === stored.length && timingSafeEqual(want, stored);
}

/** The cli file that is running, resolved through symlinks; null when it cannot be determined. */
function runningCli(override?: string): string | null {
  const raw = override ?? process.argv[1];
  if (!raw) return null;
  try {
    return realpathSync(resolve(raw));
  } catch {
    return resolve(raw);
  }
}

const STDIO_NOTE = "replace the path if you move the checkout; the npm package is not published yet";

/** The stdio launch command for the local checkout: node on dist, or tsx on src when running under tsx. */
export function stdioLaunch(cliPath?: string): { command: string; args: string[] } {
  const cli = runningCli(cliPath);
  const fallback = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const file = cli !== null && /^\.(js|mjs|cjs|ts|mts)$/.test(extname(cli)) ? cli : fallback;
  if (extname(file) === ".ts" || extname(file) === ".mts") return { command: "npx", args: ["tsx", file, "stdio"] };
  return { command: "node", args: [file, "stdio"] };
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  if (!opts.databaseUrl) {
    throw new InitError("DATABASE_URL is not set; init needs an admin connection string");
  }
  if (!isValidMindId(opts.mind)) throw new InitError(mindIdProblem(opts.mind));
  try {
    new URL(opts.databaseUrl);
  } catch {
    throw new InitError("DATABASE_URL is not a valid connection URL");
  }
  const notes: string[] = [];

  await assertAdmin(opts.databaseUrl);

  // sanctum_app is one login for the whole cluster. Do not change its password behind another
  // deployment's back: check before anything else is touched.
  const pre = createPool(opts.databaseUrl);
  let hadLogin = false;
  let passwordMatches = false;
  try {
    const role = await pre.query<{ rolcanlogin: boolean }>("select rolcanlogin from pg_roles where rolname = 'sanctum_app'");
    hadLogin = role.rows[0]?.rolcanlogin === true;
    if (hadLogin && opts.appPassword !== undefined) {
      try {
        const v = await pre.query<{ rolpassword: string | null }>("select rolpassword from pg_authid where rolname = 'sanctum_app'");
        passwordMatches = verifierMatches(v.rows[0]?.rolpassword, "sanctum_app", opts.appPassword);
      } catch {
        passwordMatches = false; // pg_authid is superuser-only; unknown counts as different
      }
      if (!passwordMatches && opts.force !== true) {
        throw new InitError(
          "the sanctum_app login already exists and a different password was supplied. That login is shared by every " +
            "sanctum-mind database in this Postgres cluster, so changing its password would lock the others out. " +
            "Nothing was changed. Re-run without a password to keep the current one, or add --force to change it.",
        );
      }
    }
  } finally {
    await pre.end();
  }

  const migrations = await runMigrations(opts.databaseUrl);

  const pool = createPool(opts.databaseUrl);
  try {
    // 1. app role login + password
    let password: string | undefined = opts.appPassword;
    let passwordStatus: PasswordStatus;
    let generated: string | undefined;
    let apply = true; // whether the role's password is written
    if (password === undefined && !hadLogin) {
      password = generated = newSecret(24);
      passwordStatus = "generated";
    } else if (password !== undefined && hadLogin && passwordMatches) {
      passwordStatus = "unchanged"; // the supplied password is already the current one
      apply = false;
    } else if (password !== undefined) {
      passwordStatus = "set";
      if (hadLogin) notes.push("sanctum_app already had a login; its password was changed (--force)");
    } else {
      passwordStatus = "unchanged";
      apply = false;
    }
    if (apply && password !== undefined) {
      // ALTER ROLE cannot take bind parameters; quote the literal server side.
      const stmt = await pool.query<{ sql: string }>("select format('alter role sanctum_app login password %L', $1::text) as sql", [password]);
      await pool.query(stmt.rows[0]!.sql);
    } else {
      await pool.query("alter role sanctum_app login");
      if (password === undefined) {
        notes.push("sanctum_app already had a login; its password was left unchanged (pass --app-password to set one, with --force)");
      }
    }

    // 2. the mind and its key, through the same upsert as seed-keys
    const exists = (await pool.query("select 1 from minds where mind_id = $1", [opts.mind])).rowCount === 1;
    let status: MindStatus;
    let bearer: string | undefined;
    if (exists && !opts.rotate) {
      status = "exists";
      notes.push(`mind "${opts.mind}" already exists; its key was not changed (pass --rotate to issue a new one)`);
    } else {
      bearer = newSecret(32);
      const up = await upsertMinds(pool, [{ mind_id: opts.mind, key: bearer }]);
      if (up.suspended.length > 0) notes.push(`mind "${opts.mind}" is suspended: access remains suspended; run restore-access --mind ${opts.mind}`);
      status = exists ? "rotated" : "created";
    }

    // 3. outputs
    const appUrlReal = password === undefined ? undefined : deriveAppUrl(opts.databaseUrl, password);
    const appUrlShown = generated !== undefined ? withPublicHost(appUrlReal!, opts.publicDbHost) : maskedAppUrl(opts.databaseUrl, opts.publicDbHost);
    const bearerShown = bearer ?? BEARER_PLACEHOLDER;
    const httpBase = opts.httpUrl.replace(/\/+$/, "");
    const mcp: InitResult["mcp"] = {
      stdio: {
        mcpServers: {
          "sanctum-mind": {
            _note: STDIO_NOTE,
            ...stdioLaunch(opts.cliPath),
            env: { DATABASE_URL: appUrlShown, SANCTUM_BEARER: bearerShown },
          },
        },
      },
      http: {
        mcpServers: {
          "sanctum-mind": { type: "http", url: `${httpBase}/mcp`, headers: { Authorization: `Bearer ${bearerShown}` } },
        },
      },
    };
    const curl =
      `curl -s ${httpBase}/verbs/mind_orient -H 'Authorization: Bearer ${bearerShown}' ` +
      `-H 'content-type: application/json' -d '{"mind_id":"${opts.mind}","depth":"quick"}'`;

    let env_file: InitResult["env_file"] = null;
    if (opts.writeEnv) {
      const path = `${opts.envDir ?? process.cwd()}/.env`;
      if (appUrlReal === undefined) {
        env_file = { path, status: "skipped", reason: "the sanctum_app password is not known on this run; pass --app-password" };
      } else {
        const body =
          `DATABASE_URL=${appUrlReal}\nPORT=${opts.port}\nSANCTUM_BEARER=${bearer ?? ""}\nEMBEDDER=local\n`;
        try {
          await writeFile(path, body, { flag: "wx", mode: 0o600 });
          env_file = { path, status: "written" };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") env_file = { path, status: "exists", reason: "left untouched" };
          else throw e;
        }
      }
    }

    const result: InitResult = {
      migrations,
      app_role: { name: "sanctum_app", login: true, password: passwordStatus, ...(generated ? { generated_password: generated } : {}) },
      ...(generated ? { generated_password: generated } : {}),
      mind: { id: opts.mind, status, ...(bearer ? { bearer } : {}) },
      app_database_url: appUrlShown,
      mcp,
      curl,
      env_file,
      notes,
    };
    return result;
  } finally {
    await pool.end();
  }
}

export function formatInit(r: InitResult): string {
  const L: string[] = [];
  L.push("sanctum-mind init");
  L.push(`  migrations   applied ${r.migrations.applied.length}, already applied ${r.migrations.skipped.length}`);
  const pw = {
    generated: "login enabled, password generated (shown below, once)",
    set: "login enabled, password set (not shown)",
    unchanged: "login enabled, password unchanged",
  }[r.app_role.password];
  L.push(`  sanctum_app  ${pw}`);
  const ms = {
    created: "created, key shown below (once)",
    rotated: "key rotated, new key shown below (once)",
    exists: "already exists, key unchanged",
  }[r.mind.status];
  L.push(`  mind ${r.mind.id}  ${ms}`);
  if (r.env_file) L.push(`  .env         ${r.env_file.status}${r.env_file.reason ? ` (${r.env_file.reason})` : ""}: ${r.env_file.path}`);
  for (const n of r.notes) L.push(`  note: ${n}`);
  L.push("");
  if (r.generated_password) {
    L.push("");
    L.push("Generated sanctum_app password (shown once):");
    L.push(r.generated_password);
  }
  L.push("");
  L.push("Run the service with this DATABASE_URL (the unprivileged sanctum_app login):");
  L.push(`  ${r.app_database_url}`);
  if (r.mind.bearer) {
    L.push("");
    L.push("Bearer key for this mind (store it now; only its hash is kept):");
    L.push(`  ${r.mind.bearer}`);
  }
  L.push("");
  L.push("MCP client config, stdio (Claude Desktop / Claude Code):");
  L.push(JSON.stringify(r.mcp.stdio, null, 2));
  L.push("");
  L.push("MCP client config, Streamable HTTP:");
  L.push(JSON.stringify(r.mcp.http, null, 2));
  L.push("");
  L.push("First wake:");
  L.push(`  ${r.curl}`);
  return L.join("\n");
}
