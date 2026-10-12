// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { Pool } from "pg";

/**
 * Per-lane database roles (migration 0026, CONTRACTS.md "Per-lane database roles"). The login role a process connects as
 * fixes who the database takes it to be: sanctum_actor() maps session_user to the actor. This file is the TypeScript side:
 * which role is which lane, and the startup check that a command runs on the lane it belongs to.
 */
export type Actor = "verb" | "daemon" | "operator" | "import";

/** The four lane login roles and the actor each one is. */
export const LANE_ROLES: Readonly<Record<string, Actor>> = {
  sanctum_verb: "verb",
  sanctum_daemon: "daemon",
  sanctum_operator: "operator",
  sanctum_import: "import",
};
export const LANES: readonly Actor[] = ["verb", "daemon", "operator", "import"];
export const LEGACY_ROLE = "sanctum_app";
export function laneRole(lane: Actor): string {
  return `sanctum_${lane}`;
}

/** What a connection is: one of the four lanes, the legacy shared sanctum_app login, or any other role (the admin connection). */
export type Connection =
  | { kind: "lane"; role: string; lane: Actor }
  | { kind: "legacy"; role: string }
  | { kind: "admin"; role: string };

/** What the database says about a login: its name, whether it sits on a lane (sanctum_lane()), and whether it is a plain member of sanctum_app. */
export interface RoleFacts {
  role: string;
  /** the lane sanctum_lane() reports, or null */
  lane: string | null;
  /** a plain (not superuser, not BYPASSRLS) member of sanctum_app */
  appMember: boolean;
}

/**
 * A lane login is one whose sanctum_lane() names a lane (it is a lane role or a direct member of exactly one). The legacy lane is
 * sanctum_app and any other plain member of sanctum_app that is not on a lane (a deployment that logs in under another name keeps
 * working exactly as before, with the warning). Everything else is the admin connection.
 */
export function classifyRole(f: RoleFacts): Connection {
  const lane = f.lane !== null && (LANES as readonly string[]).includes(f.lane) ? (f.lane as Actor) : undefined;
  if (lane !== undefined) return { kind: "lane", role: f.role, lane };
  if (f.role === LEGACY_ROLE || f.appMember) return { kind: "legacy", role: f.role };
  return { kind: "admin", role: f.role };
}

type Queryable = Pick<Pool, "query">;

export class LaneError extends Error {}

const NEEDS_0026 = "is migration 0026 applied? Run init (or migrate) with the admin DATABASE_URL, then start again";

/** True for Postgres' "undefined function" (42883): a database that does not have migration 0026 yet. */
export function isMissingFunction(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "42883";
}

/**
 * What the pool's connections log in as (session_user, which `set role` cannot change) and the lane the database derives from it.
 * A login named like a lane role on a database without sanctum_lane() gets the "migration 0026" message instead of a raw error.
 */
export async function connectedRole(pool: Queryable): Promise<RoleFacts> {
  const r = await pool.query<{ u: string; m: boolean | null; f: boolean | null; l?: string | null }>(
    `select session_user::text as u,
            coalesce(pg_has_role(session_user, to_regrole('sanctum_app')::oid, 'member'), false)
              and not exists (select 1 from pg_roles where rolname = session_user and (rolsuper or rolbypassrls)) as m,
            to_regprocedure('sanctum_lane()') is not null as f`,
  );
  const u = r.rows[0]?.u;
  if (!u) throw new Error("could not determine the connected database role");
  const appMember = r.rows[0]?.m === true;
  if (r.rows[0]?.f !== true) {
    if (Object.hasOwn(LANE_ROLES, u)) throw new LaneError(`connected as ${u}, but the database has no sanctum_lane(): ${NEEDS_0026}`);
    return { role: u, lane: null, appMember }; // an older database: only the legacy and admin connections exist
  }
  try {
    const l = await pool.query<{ l: string | null }>("select sanctum_lane() as l");
    return { role: u, lane: l.rows[0]?.l ?? null, appMember };
  } catch (e) {
    if (isMissingFunction(e)) throw new LaneError(`sanctum_lane() is missing: ${NEEDS_0026}`);
    throw e;
  }
}

const cache = new WeakMap<object, Promise<Connection>>();

/** The connection kind of a pool, asked once per pool and remembered. A failed query is not remembered. */
export function connectionOf(pool: Queryable): Promise<Connection> {
  let p = cache.get(pool);
  if (p === undefined) {
    p = connectedRole(pool).then(classifyRole);
    cache.set(pool, p);
    p.catch(() => cache.delete(pool));
  }
  return p;
}
export interface LaneRequirement {
  /** the command, as the user typed it, for the message */
  command: string;
  /** the lane this command belongs to (several are allowed for commands that two lanes may run) */
  lanes: readonly Actor[];
  /** the admin connection is allowed (commands that take the admin URL today) */
  allowAdmin?: boolean;
}

export interface LaneVerdict {
  connection: Connection;
  /** one warning line to print (the legacy shared lane), or null */
  warning: string | null;
}

const HARDENING =
  "the legacy shared lane cannot tell its callers apart; give each service its own lane login (run init once to create them, then use the lane URLs; see SECURITY, \"What the database guards do and do not cover\")";

/**
 * Decides whether a connection may run a command. Throws LaneError with a clear message on the wrong lane. The legacy
 * sanctum_app login is accepted with a warning; the admin connection only where `allowAdmin` says the command takes the admin URL.
 */
export function judgeLane(connection: Connection, req: LaneRequirement): LaneVerdict {
  const want = req.lanes.map(laneRole).join(" or ");
  if (connection.kind === "lane") {
    if (req.lanes.includes(connection.lane)) return { connection, warning: null };
    throw new LaneError(
      `${req.command} must run as ${want}, but DATABASE_URL connects as ${connection.role} (the ${connection.lane} lane). Use the ${req.lanes[0]} lane URL printed by init.`,
    );
  }
  if (connection.kind === "legacy") {
    return { connection, warning: `${req.command} is running on the legacy sanctum_app lane (it should use ${want}): ${HARDENING}` };
  }
  if (req.allowAdmin === true) return { connection, warning: null };
  throw new LaneError(
    `${req.command} must run as ${want}, but DATABASE_URL connects as ${connection.role}, which is not a lane login. Use the ${req.lanes[0]} lane URL printed by init.`,
  );
}

/** Looks up the pool's login role and judges it; returns the one warning line (if any) for the caller to print. */
export async function requireLane(pool: Queryable, req: LaneRequirement): Promise<LaneVerdict> {
  return judgeLane(await connectionOf(pool), req);
}

/**
 * The check inside a transaction: a pool on a lane may only act as that lane. `intended` undefined means the code path does not
 * claim an actor (it only reads or does bookkeeping the guards do not look at), so nothing is asserted. Legacy and admin
 * connections are not asserted: sanctum_actor() equals app.actor there by construction.
 */
export function laneMismatch(connection: Connection, intended: Actor | undefined): string | null {
  if (connection.kind !== "lane" || intended === undefined || connection.lane === intended) return null;
  return `connected as lane ${connection.lane} (${connection.role}) but this code path acts as ${intended}; use the ${intended} lane URL for it`;
}
