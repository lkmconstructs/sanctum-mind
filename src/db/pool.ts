// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import pg from "pg";
import type { Pool, PoolClient } from "pg";

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

export async function withMind<T>(
  pool: Pool,
  mind_id: string,
  bearer: string,
  mode: MindMode,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // mode read makes the database itself refuse every write in this transaction
    if (mode === "read") await client.query("set transaction read only");
    await client.query("select set_config('app.mind_id', $1, true), set_config('app.bearer', $2, true)", [
      mind_id,
      bearer,
    ]);
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
      `refusing to serve as role "${role.rolname}": it is a superuser or has BYPASSRLS, so row level security would not isolate minds. Connect as a plain role such as sanctum_app.`,
    );
  }
}
