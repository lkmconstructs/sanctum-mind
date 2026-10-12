// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { isValidMindId, mindIdProblem, upsertMinds } from "./auth.js";
import { createPool } from "./db/pool.js";
import { LANES, laneRole, type Actor } from "./db/lanes.js";
import { runMigrations } from "./db/migrate.js";

export interface InitOptions {
  /** Admin connection string. */
  databaseUrl: string | undefined;
  mind: string;
  /** Password for the sanctum_app login. Generated on first setup when omitted. */
  appPassword?: string | undefined;
  /** Passwords for the four lane logins (sanctum_verb, sanctum_daemon, sanctum_operator, sanctum_import). Generated on first setup when omitted. */
  lanePasswords?: Partial<Record<Actor, string>>;
  /** Issue new passwords for the four lane logins that already have one (shown once). */
  rotateLanes?: boolean;
  port: number;
  httpUrl: string;
  json: boolean;
  rotate: boolean;
  /** Write ./.env (never overwrites). */
  writeEnv: boolean;
  /** Directory for the .env file. */
  envDir?: string;
  /** Also enable a login on the legacy shared sanctum_app role (a fresh install does not need one; an existing login is left alone). */
  legacyLogin?: boolean;
  /** Change the password of a sanctum_app login that already exists. */
  force?: boolean;
  /** host:port shown in the printed configs instead of the connection's own (Docker: the host-side address). */
  publicDbHost?: string | undefined;
  /** The cli entry that the stdio config should launch; default: the running one. */
  cliPath?: string;
  /** Running under compose: print the HTTP and stdio (Docker) configs, not the host-path stdio one. */
  docker?: boolean;
  /** The running mind service container named in the stdio (Docker) config. */
  container?: string;
}

export type MindStatus = "created" | "exists" | "rotated";
export type PasswordStatus = "generated" | "set" | "unchanged" | "none";

export interface LaneRoleResult {
  name: string;
  login: true;
  password: Exclude<PasswordStatus, "none">;
  /** Present only on the run that generated this lane's password. */
  generated_password?: string;
}

export interface InitResult {
  migrations: { applied: string[]; skipped: string[] };
  /** The legacy shared lane: it still works, and warns. */
  app_role: { name: "sanctum_app"; login: boolean; password: PasswordStatus; generated_password?: string };
  /** The four lane logins. */
  lane_roles: Record<Actor, LaneRoleResult>;
  /** One database URL per lane. A URL carries the real password only when it was generated this run; otherwise a placeholder. */
  lanes: Record<Actor, string>;
  /** Present only on the run that generated the sanctum_app password. */
  generated_password?: string;
  mind: { id: string; status: MindStatus; bearer?: string };
  /** The legacy shared sanctum_app URL (works, warns); empty when sanctum_app has no login. Contains the real password only when it was generated this run; otherwise a placeholder. */
  app_database_url: string;
  mcp: {
    /** Host-path stdio for a clone; absent under --docker, where the path cannot exist on the host. */
    stdio?: { mcpServers: { "sanctum-mind": { _note: string; command: string; args: string[]; env: Record<string, string> } } };
    /** `docker exec` into the running mind container; present only under --docker. */
    stdio_docker?: { mcpServers: { "sanctum-mind": { command: "docker"; args: string[]; env: { SANCTUM_BEARER: string } } } };
    http: { mcpServers: { "sanctum-mind": { type: "http"; url: string; headers: { Authorization: string } } } };
  };
  curl: string;
  env_file: { path: string; status: "written" | "exists" | "skipped"; reason?: string } | null;
  notes: string[];
}

export class InitError extends Error {}

const APP_PW_PLACEHOLDER = "<app-password>";
const LANE_PW_PLACEHOLDER = "<lane-password>";
const BEARER_PLACEHOLDER = "<bearer-key>";
/** Matches container_name of the mind service in docker-compose.yml. */
export const DEFAULT_CONTAINER = "sanctum-mind";

export function parseInitArgs(argv: string[], env: Record<string, string | undefined>): InitOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        mind: { type: "string" },
        "app-password": { type: "string" },
        "lane-password-verb": { type: "string" },
        "lane-password-daemon": { type: "string" },
        "lane-password-operator": { type: "string" },
        "lane-password-import": { type: "string" },
        "rotate-lanes": { type: "boolean", default: false },
        "legacy-login": { type: "boolean", default: false },
        port: { type: "string" },
        "http-url": { type: "string" },
        json: { type: "boolean", default: false },
        rotate: { type: "boolean", default: false },
        "write-env": { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "public-db-host": { type: "string" },
        docker: { type: "boolean", default: false },
        container: { type: "string" },
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
  const lanePasswords: Partial<Record<Actor, string>> = {};
  for (const lane of LANES) {
    const flag = values[`lane-password-${lane}` as const];
    if (flag === "") throw new InitError(`--lane-password-${lane} must not be empty`);
    const pw = flag ?? (env[`SANCTUM_LANE_PASSWORD_${lane.toUpperCase()}`] || undefined);
    if (pw !== undefined) lanePasswords[lane] = pw;
  }
  const publicDbHost = values["public-db-host"];
  if (publicDbHost !== undefined) checkHostPort(publicDbHost);
  const container = values.container ?? DEFAULT_CONTAINER;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw new InitError(`invalid --container "${container}"`);
  return {
    databaseUrl: env.DATABASE_URL || undefined,
    mind: values.mind,
    appPassword,
    lanePasswords,
    rotateLanes: values["rotate-lanes"] ?? false,
    legacyLogin: values["legacy-login"] ?? false,
    port,
    httpUrl: values["http-url"] ?? `http://localhost:${port}`,
    json: values.json ?? false,
    rotate: values.rotate ?? false,
    writeEnv: values["write-env"] ?? false,
    force: values.force ?? false,
    publicDbHost,
    docker: values.docker ?? false,
    container,
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
  --app-password <pw>    password for the legacy sanctum_app login, with --legacy-login or when it has one (default: generated;
                         SANCTUM_APP_PASSWORD is read when the flag is absent and is preferred,
                         because command-line arguments are visible to other users in ps)
  --lane-password-<lane> <pw>
                         password for a lane login: sanctum_verb (http, stdio), sanctum_daemon, sanctum_operator,
                         sanctum_import (export-mind, import-mind, embed-backfill, sinks requeue); <lane> is verb,
                         daemon, operator or import. Default: generated on first setup, shown once.
                         SANCTUM_LANE_PASSWORD_VERB, _DAEMON, _OPERATOR and _IMPORT are read when the flag is absent
                         and are preferred, because command-line arguments are visible to other users in ps
  --rotate-lanes         issue new passwords for the four lane logins even though they already have one (shown once;
                         the logins are shared by every sanctum-mind database in the cluster, so restart the services
                         with the new URLs)
  --legacy-login         also enable a login on the legacy shared sanctum_app role (a fresh install does not need one;
                         a sanctum_app login that already exists is left alone either way)
  --force                change the password of a sanctum_app or lane login that already exists and was given a
                         different password here (the logins are shared by every mind in the cluster)
  --public-db-host <h:p> database host:port to print in the configs (the connection itself is unchanged;
                         use it when the service and your client reach the database at different addresses)
  --port <n>             HTTP port (default 8002)
  --http-url <url>       public URL of the HTTP service (default http://localhost:<port>)
  --rotate               replace the key of a mind that already exists
  --write-env            write ./.env with the app settings (never overwrites)
  --docker               running under Docker Compose: print the HTTP and stdio (Docker) configs and
                         leave out the host-path stdio config, which cannot work on the host
  --container <name>     only with --docker (ignored otherwise): the mind container the stdio (Docker)
                         config execs into (default sanctum-mind, the container_name in docker-compose.yml)
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
  return deriveRoleUrl(adminUrl, "sanctum_app", password);
}

/** The URL of any login for an admin URL (see deriveAppUrl). */
export function deriveRoleUrl(adminUrl: string, role: string, password: string): string {
  const u = new URL(adminUrl);
  u.searchParams.delete("user");
  u.searchParams.delete("password");
  if (u.hostname === "") {
    u.username = "";
    u.password = "";
    u.searchParams.set("user", role);
    u.searchParams.set("password", password);
  } else {
    u.username = role;
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

function maskedRoleUrl(adminUrl: string, role: string, hostPort: string | undefined, placeholder: string): string {
  return withPublicHost(deriveRoleUrl(adminUrl, role, MASK_SENTINEL), hostPort).replace(MASK_SENTINEL, placeholder);
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

export type LaneRepair = "created" | "membership" | "grants";

/** What is wrong with one lane role, read-only: missing ("created"), not a member of sanctum_app ("membership"), the operator missing its writes ("grants"). */
export async function laneRoleProblems(pool: Pick<pg.Pool, "query">, role: string): Promise<LaneRepair[]> {
  if (!LANES.some((l) => laneRole(l) === role)) throw new Error(`not a lane role: ${role}`);
  if ((await pool.query("select 1 from pg_roles where rolname = $1", [role])).rowCount !== 1) return ["created"];
  // asked only of a role that exists (has_table_privilege raises for an unknown one)
  const r = await pool.query<{ member: boolean; extractor: boolean; grants: boolean }>(
    `select exists (select 1 from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
                     where r.rolname = 'sanctum_app' and u.rolname = $1) as member,
            has_table_privilege($1, 'extractor_state', 'INSERT') and has_table_privilege($1, 'extractor_state', 'UPDATE') as extractor,
            has_table_privilege($1, 'grants', 'INSERT') and has_table_privilege($1, 'grants', 'UPDATE') as grants`,
    [role],
  );
  const f = r.rows[0]!;
  const out: LaneRepair[] = [];
  if (!f.member) out.push("membership");
  if (role === "sanctum_operator" && !(f.extractor && f.grants)) out.push("grants");
  return out;
}

/**
 * Makes one lane role exist and hold what its lane needs, without touching a password or a login: creates it NOLOGIN when missing
 * (a database that recorded 0026 without the roles, or lost one), puts it in sanctum_app, and gives sanctum_operator what the operator
 * commands write (migration 0026). Idempotent. Returns what had to change (see laneRoleProblems). `role` is one of the four lane roles.
 */
export async function repairLaneRole(pool: Pick<pg.Pool, "query">, role: string): Promise<LaneRepair[]> {
  const changed = await laneRoleProblems(pool, role);
  if (changed.includes("created")) await pool.query(`create role ${role} nologin`);
  await pool.query(`grant sanctum_app to ${role}`);
  if (role === "sanctum_operator") {
    // the operator lane also holds what the operator commands write (migration 0026); repair them with the role
    await pool.query("grant select, insert, update on extractor_state to sanctum_operator");
    await pool.query("grant select, insert, update on grants to sanctum_operator");
  }
  return changed;
}

/** repairLaneRole for all four lanes. `created` names the roles that did not exist; `repaired` the ones whose membership or grants were restored. */
export async function repairLaneRoles(pool: Pick<pg.Pool, "query">): Promise<{ created: string[]; repaired: string[] }> {
  const created: string[] = [];
  const repaired: string[] = [];
  for (const lane of LANES) {
    const role = laneRole(lane);
    const changed = await repairLaneRole(pool, role);
    if (changed.includes("created")) created.push(role);
    else if (changed.length > 0) repaired.push(`${role} (${changed.join(", ")})`);
  }
  return { created, repaired };
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

  // sanctum_app and the four lane logins are one login each for the whole cluster. Do not change a password behind another
  // deployment's back: check before anything else is touched.
  const pre = createPool(opts.databaseUrl);
  const had: Record<string, { hadLogin: boolean; matches: boolean }> = {};
  try {
    const wanted: { role: string; password: string | undefined; flag: string; rotating: boolean }[] = [
      { role: "sanctum_app", password: opts.appPassword, flag: "--app-password", rotating: false },
      ...LANES.map((lane) => ({ role: laneRole(lane), password: opts.lanePasswords?.[lane], flag: `--lane-password-${lane}`, rotating: opts.rotateLanes === true })),
    ];
    for (const w of wanted) {
      const role = await pre.query<{ rolcanlogin: boolean }>("select rolcanlogin from pg_roles where rolname = $1", [w.role]);
      const hadLogin = role.rows[0]?.rolcanlogin === true;
      let matches = false;
      if (hadLogin && w.password !== undefined) {
        try {
          const v = await pre.query<{ rolpassword: string | null }>("select rolpassword from pg_authid where rolname = $1", [w.role]);
          matches = verifierMatches(v.rows[0]?.rolpassword, w.role, w.password);
        } catch {
          matches = false; // pg_authid is superuser-only; unknown counts as different
        }
        if (!matches && opts.force !== true && !w.rotating) {
          throw new InitError(
            `the ${w.role} login already exists and a different password was supplied. That login is shared by every ` +
              "sanctum-mind database in this Postgres cluster, so changing its password would lock the others out. " +
              "Nothing was changed. Re-run without a password to keep the current one, or add --force to change it.",
          );
        }
      }
      had[w.role] = { hadLogin, matches };
    }
  } finally {
    await pre.end();
  }

  const migrations = await runMigrations(opts.databaseUrl);

  const pool = createPool(opts.databaseUrl);
  try {
    // 1. logins + passwords: the legacy sanctum_app, then the four lanes
    const provision = async (role: string, supplied: string | undefined, rotating: boolean) => {
      const { hadLogin, matches } = had[role]!;
      if (role === "sanctum_app" && !hadLogin && opts.legacyLogin !== true) {
        return { password: undefined, status: "none" as PasswordStatus, generated: undefined }; // a fresh install runs on the lanes only
      }
      if (role !== "sanctum_app") await repairLaneRole(pool, role);
      let password: string | undefined = supplied;
      let status: PasswordStatus;
      let generated: string | undefined;
      let apply = true; // whether the role's password is written
      if (password === undefined && (!hadLogin || rotating)) {
        password = generated = newSecret(24);
        status = "generated";
        if (hadLogin) notes.push(`${role} already had a login; its password was rotated (shown below, once)`);
      } else if (password !== undefined && hadLogin && matches) {
        status = "unchanged"; // the supplied password is already the current one
        apply = false;
      } else if (password !== undefined) {
        status = "set";
        if (hadLogin) notes.push(`${role} already had a login; its password was changed (${rotating && opts.force !== true ? "--rotate-lanes" : "--force"})`);
      } else {
        status = "unchanged";
        apply = false;
      }
      if (apply && password !== undefined) {
        // ALTER ROLE cannot take bind parameters; quote the literal server side.
        const stmt = await pool.query<{ sql: string }>("select format('alter role %I login password %L', $1::text, $2::text) as sql", [role, password]);
        await pool.query(stmt.rows[0]!.sql);
      } else {
        await pool.query(`alter role ${role} login`); // role is one of the five fixed names above
        if (password === undefined) {
          const flag = role === "sanctum_app" ? "--app-password" : `--lane-password-${role.slice("sanctum_".length)}`;
          notes.push(`${role} already had a login; its password was left unchanged (pass ${flag} to set one, with --force${role === "sanctum_app" ? "" : ", or --rotate-lanes to issue new ones"})`);
        }
      }
      return { password, status, generated };
    };
    const app = await provision("sanctum_app", opts.appPassword, false);
    const password = app.password;
    const passwordStatus = app.status;
    const generated = app.generated;
    const laneProv = {} as Record<Actor, Awaited<ReturnType<typeof provision>>>;
    for (const lane of LANES) laneProv[lane] = await provision(laneRole(lane), opts.lanePasswords?.[lane], opts.rotateLanes === true);

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
    const appLogin = passwordStatus !== "none";
    const appUrlReal = password === undefined ? undefined : deriveAppUrl(opts.databaseUrl, password);
    const appUrlShown = !appLogin ? "" : generated !== undefined ? withPublicHost(appUrlReal!, opts.publicDbHost) : maskedRoleUrl(opts.databaseUrl, "sanctum_app", opts.publicDbHost, APP_PW_PLACEHOLDER);
    const laneUrlReal = {} as Record<Actor, string | undefined>;
    const lanes = {} as Record<Actor, string>;
    const lane_roles = {} as Record<Actor, LaneRoleResult>;
    for (const lane of LANES) {
      const lp = laneProv[lane];
      const role = laneRole(lane);
      laneUrlReal[lane] = lp.password === undefined ? undefined : deriveRoleUrl(opts.databaseUrl, role, lp.password);
      lanes[lane] =
        lp.generated !== undefined ? withPublicHost(laneUrlReal[lane]!, opts.publicDbHost) : maskedRoleUrl(opts.databaseUrl, role, opts.publicDbHost, LANE_PW_PLACEHOLDER);
      lane_roles[lane] = { name: role, login: true, password: lp.status as Exclude<PasswordStatus, "none">, ...(lp.generated ? { generated_password: lp.generated } : {}) };
    }
    const bearerShown = bearer ?? BEARER_PLACEHOLDER;
    const httpBase = opts.httpUrl.replace(/\/+$/, "");
    const http = {
      mcpServers: {
        "sanctum-mind": { type: "http" as const, url: `${httpBase}/mcp`, headers: { Authorization: `Bearer ${bearerShown}` } },
      },
    };
    const mcp: InitResult["mcp"] = opts.docker
      ? {
          http,
          // The mind container already holds the sanctum_verb DATABASE_URL. The key goes in the client's environment and
          // `-e SANCTUM_BEARER` (no value) forwards it, so it never appears on the docker command line (ps, /proc).
          stdio_docker: {
            mcpServers: {
              "sanctum-mind": {
                command: "docker",
                args: ["exec", "-i", "-e", "SANCTUM_BEARER", opts.container ?? DEFAULT_CONTAINER, "node", "dist/cli.js", "stdio"],
                env: { SANCTUM_BEARER: bearerShown },
              },
            },
          },
        }
      : {
          stdio: {
            mcpServers: {
              "sanctum-mind": {
                _note: STDIO_NOTE,
                ...stdioLaunch(opts.cliPath),
                env: { DATABASE_URL: lanes.verb, SANCTUM_BEARER: bearerShown },
              },
            },
          },
          http,
        };
    const curl =
      `curl -s ${httpBase}/verbs/mind_orient -H 'Authorization: Bearer ${bearerShown}' ` +
      `-H 'content-type: application/json' -d '{"mind_id":"${opts.mind}","depth":"quick"}'`;

    let env_file: InitResult["env_file"] = null;
    if (opts.writeEnv) {
      const path = `${opts.envDir ?? process.cwd()}/.env`;
      if (laneUrlReal.verb === undefined) {
        env_file = { path, status: "skipped", reason: "the sanctum_verb password is not known on this run; pass --lane-password-verb" };
      } else {
        const body =
          `DATABASE_URL=${laneUrlReal.verb}\nPORT=${opts.port}\nSANCTUM_BEARER=${bearer ?? ""}\nEMBEDDER=local\n`;
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
      app_role: { name: "sanctum_app", login: appLogin, password: passwordStatus, ...(generated ? { generated_password: generated } : {}) },
      ...(generated ? { generated_password: generated } : {}),
      lane_roles,
      lanes,
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
  const pwText = (st: Exclude<PasswordStatus, "none">) =>
    ({
      generated: "login enabled, password generated (shown below, once)",
      set: "login enabled, password set (not shown)",
      unchanged: "login enabled, password unchanged",
    })[st];
  L.push(r.app_role.login ? `  sanctum_app  ${pwText(r.app_role.password as Exclude<PasswordStatus, "none">)} (legacy shared lane)` : "  sanctum_app  no login (the lanes are enough; --legacy-login adds one)");
  for (const lane of LANES) L.push(`  ${r.lane_roles[lane].name.padEnd(16)} ${pwText(r.lane_roles[lane].password)}`);
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
  for (const lane of LANES) {
    const g = r.lane_roles[lane].generated_password;
    if (g) {
      L.push("");
      L.push(`Generated ${r.lane_roles[lane].name} password (shown once):`);
      L.push(g);
    }
  }
  L.push("");
  L.push("Run each service with its own lane DATABASE_URL (unprivileged logins; the database derives who is acting from the login):");
  L.push(`  verb      http and stdio (and the MCP configs below)   ${r.lanes.verb}`);
  L.push(`  daemon    the daemon                                    ${r.lanes.daemon}`);
  L.push(`  operator  extractor and grant, for an operator who does not hold the admin URL   ${r.lanes.operator}`);
  L.push(`  import    export-mind, import-mind, embed-backfill, sinks requeue   ${r.lanes.import}`);
  if (r.app_role.login) {
    L.push("");
    L.push("Legacy shared lane (works, warns; every service on it is trusted to claim any actor):");
    L.push(`  ${r.app_database_url}`);
  }
  if (r.mind.bearer) {
    L.push("");
    L.push("Bearer key for this mind (store it now; only its hash is kept):");
    L.push(`  ${r.mind.bearer}`);
  }
  L.push("");
  if (r.mcp.stdio) {
    L.push("MCP client config, stdio (Claude Desktop / Claude Code):");
    L.push(JSON.stringify(r.mcp.stdio, null, 2));
    L.push("");
  }
  L.push("MCP client config, Streamable HTTP (for a client that connects to a URL):");
  L.push(JSON.stringify(r.mcp.http, null, 2));
  if (r.mcp.stdio_docker) {
    L.push("");
    L.push("MCP client config, stdio (Docker) (for a client that launches a local command; the mind container must be running):");
    L.push(JSON.stringify(r.mcp.stdio_docker, null, 2));
  }
  L.push("");
  L.push("First wake:");
  L.push(`  ${r.curl}`);
  return L.join("\n");
}
