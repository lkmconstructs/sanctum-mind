// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { connectionOf, isMissingFunction, laneMismatch, LaneError, type Actor } from "./lanes.js";

export function createPool(databaseUrl: string): Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // An idle client can die (server restart, pg_terminate_backend). Without a listener
  // the 'error' event is unhandled and kills the process; the pool discards the client.
  pool.on("error", (e) => {
    console.error("postgres pool: idle client error:", e.message);
  });
  return pool;
}

export type MindMode = "read" | "write";

/**
 * Who is acting in a transaction, recorded as the per-transaction setting `app.actor` beside `app.mind_id` and
 * `app.bearer`: a verb call (`verb`), a daemon pass (`daemon`), the operator CLI (`operator`) or import-mind (`import`).
 * The database guards on the extractor's tables read it (migration 0021): only a verb call decides a proposal, only the
 * daemon or an import expires one, only the operator enables the extractor. Unset (empty) for everything else.
 *
 * Since migration 0026 the database derives the actor from the login role (sanctum_actor()), so on a lane login the setting
 * is only a statement of intent: withMind asserts that the two agree and throws when they do not (the daemon started on the
 * verb URL, say). On the legacy sanctum_app login and on an admin connection sanctum_actor() is the setting itself.
 */
export type { Actor };

/** Pools whose lane has been confirmed against sanctum_actor() in the database itself (once per pool, in its first transaction). */
const verified = new WeakSet<object>();

export async function withMind<T>(
  pool: Pool,
  mind_id: string,
  bearer: string,
  mode: MindMode,
  fn: (tx: PoolClient) => Promise<T>,
  actor?: Actor,
): Promise<T> {
  const connection = await connectionOf(pool);
  const client = await pool.connect();
  try {
    await client.query("begin");
    // mode read makes the database itself refuse every write in this transaction
    if (mode === "read") await client.query("set transaction read only");
    await client.query(
      "select set_config('app.mind_id', $1, true), set_config('app.bearer', $2, true), set_config('app.actor', $3, true)",
      [mind_id, bearer, actor ?? ""],
    );
    // On a lane login, what the database takes the actor to be must be what this code path intended. Asked of the database
    // itself in a pool's first transaction, then known from the login role (one query per pool, not per transaction).
    const mismatch = laneMismatch(connection, actor);
    if (mismatch !== null) throw new LaneError(mismatch);
    if (connection.kind === "lane" && !verified.has(pool)) {
      let seen: string | null;
      try {
        seen = (await client.query<{ a: string | null }>("select sanctum_actor() as a")).rows[0]?.a ?? null;
      } catch (e) {
        if (isMissingFunction(e)) throw new LaneError(`connected as ${connection.role} (lane ${connection.lane}), but sanctum_actor() is missing: is migration 0026 applied? Run init, then start again`);
        throw e;
      }
      if (seen !== connection.lane) {
        throw new LaneError(`the database reports actor ${seen === null ? "(none)" : seen} for ${connection.role}, expected ${connection.lane}: is migration 0026 applied?`);
      }
      verified.add(pool);
    }
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // connection may already be broken; the original error matters more
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Row level security is the isolation boundary between minds, and Postgres lets a
 * superuser or a BYPASSRLS role walk straight through it. A service connected that way
 * would see every mind's rows. Refuse to serve rather than serve wrong.
 */
export async function assertRlsEnforced(pool: Pool): Promise<void> {
  const r = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
  );
  const role = r.rows[0];
  if (!role) throw new Error("could not determine the connected database role");
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `refusing to serve as role "${role.rolname}": it is a superuser or has BYPASSRLS, so row level security would not isolate minds. Connect as a plain role: one of the lane logins init prints (sanctum_verb, sanctum_daemon, sanctum_operator, sanctum_import), or the legacy sanctum_app.`,
    );
  }
}
