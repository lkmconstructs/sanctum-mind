// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { randomBytes } from "node:crypto";
import pg from "pg";

/**
 * Runs once per `vitest run`, before any test file.
 *
 * The suite needs an unprivileged login role (sanctum_test_app) so row level security applies; a
 * superuser bypasses it. The role is a cluster-wide object, so it gets a random password for this
 * run only (exported to the workers as SANCTUM_TEST_APP_PASSWORD) and is dropped again afterwards.
 */
export const TEST_APP_ROLE = "sanctum_test_app";
/**
 * Stand-ins for the four lane logins (migration 0026): sanctum_test_verb, _daemon, _operator and _import, each a DIRECT member of
 * the matching real lane role (and of sanctum_app), which is how the database puts a login on a lane. They get random passwords
 * for this run (SANCTUM_TEST_LANE_PASSWORD_<LANE>), are created by resetDatabase and dropped below. The real lane roles are
 * never given a login, re-passworded or dropped by the suite.
 */
export const TEST_LANE_ROLES = ["sanctum_test_verb", "sanctum_test_daemon", "sanctum_test_operator", "sanctum_test_import"] as const;

export function setup(): void {
  process.env.SANCTUM_TEST_APP_PASSWORD = randomBytes(24).toString("hex");
  for (const role of TEST_LANE_ROLES) {
    process.env[`SANCTUM_TEST_LANE_PASSWORD_${role.slice("sanctum_test_".length).toUpperCase()}`] = randomBytes(24).toString("hex");
  }
}

export async function teardown(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    for (const role of [TEST_APP_ROLE, ...TEST_LANE_ROLES]) {
      try {
        const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
        if (exists.rowCount === 0) continue;
        // revoke membership first so the role holds nothing, then remove what it owns here and the role itself
        const parent = await client.query("select 1 from pg_roles where rolname = 'sanctum_app'");
        if (parent.rowCount) await client.query(`revoke sanctum_app from ${role}`);
        await client.query(`drop owned by ${role}`);
        await client.query(`drop role ${role}`);
      } catch (e) {
        console.warn(`global teardown: could not drop role ${role}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    console.warn(`global teardown: could not connect to drop the test roles: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
