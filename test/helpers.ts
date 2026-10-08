// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

export const TEST_KEYS = { alpha: "alpha-test-key", beta: "beta-test-key" } as const;

/** The password of the unprivileged test role: random per run, set by test/global-setup.ts. */
export function testAppPassword(): string {
  const pw = process.env.SANCTUM_TEST_APP_PASSWORD;
  if (!pw) throw new Error("SANCTUM_TEST_APP_PASSWORD is not set; it is created by test/global-setup.ts (run the suite through vitest)");
  return pw;
}

/** A URL for `db` on the test cluster as the unprivileged test role (database defaults to TEST_DATABASE_URL's). */
export function testAppUrl(db?: string): string {
  const u = new URL(testDatabaseUrl());
  if (db !== undefined) u.pathname = `/${db}`;
  u.username = "sanctum_test_app";
  u.password = testAppPassword();
  return u.toString();
}

/** The app-role URL is TEST_DATABASE_URL with the user swapped to the unprivileged test role. */
function appUrl(): string {
  const u = new URL(testAppUrl());
  u.searchParams.set("application_name", "sanctum-test-app");
  return u.toString();
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set; point it at a disposable Postgres, e.g. postgresql://postgres@localhost:5433/sanctum_test",
    );
  }
  return url;
}

export async function resetDatabase(): Promise<Pool> {
  const url = testDatabaseUrl();
  const pool = createPool(url);
  // Extensions live outside the schema drop, so recreate them explicitly and idempotently.
  await pool.query("drop extension if exists vector cascade; drop extension if exists pgcrypto cascade;");
  await pool.query("drop schema public cascade; create schema public;");
  await pool.query("create extension if not exists vector schema public; create extension if not exists pgcrypto schema public;");
  await runMigrations(url);
  // The role is cluster-wide: create it with this run's random password (or re-key a leftover one);
  // test/global-setup.ts drops it when the run ends.
  const pw = testAppPassword().replaceAll("'", "''");
  const have = await pool.query("select 1 from pg_roles where rolname = 'sanctum_test_app'");
  await pool.query(`${have.rowCount ? "alter" : "create"} role sanctum_test_app login password '${pw}'`);
  await pool.query("grant sanctum_app to sanctum_test_app");
  await pool.query(
    "insert into minds (mind_id, key_hash, display_name) values ('alpha', $1, 'Alpha'), ('beta', $2, 'Beta')",
    [sha256(TEST_KEYS.alpha), sha256(TEST_KEYS.beta)],
  );
  await pool.query(
    "insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'read')",
  );
  return pool;
}

export function appPool(): Pool {
  return createPool(appUrl());
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}

/**
 * Insert rows shaped like an earlier schema left them (for example a pre-0017 declaration made by another bearer),
 * which the 0020 guards rightly refuse today. Runs as the superuser with ordinary triggers off for the one
 * statement; only tests that model legacy data use it.
 */
export async function queryLegacy(db: Pool, sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const r = await client.query(sql, params);
    await client.query("commit");
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Run one statement on `db` inside a transaction that carries the mind scope (app.mind_id, app.bearer), as a verb
 * would. The proposals insert guard (0020) requires it: a bare admin connection may not insert a proposal.
 */
export async function queryAs(
  db: Pool,
  mind: string,
  bearer: string,
  sql: string,
  params: unknown[] = [],
): Promise<{ rows: any[]; rowCount: number | null }> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.mind_id', $1, true), set_config('app.bearer', $2, true)", [mind, bearer]);
    const r = await client.query(sql, params);
    await client.query("commit");
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
