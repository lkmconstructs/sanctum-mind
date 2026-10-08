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

export function setup(): void {
  process.env.SANCTUM_TEST_APP_PASSWORD = randomBytes(24).toString("hex");
}

export async function teardown(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const role = TEST_APP_ROLE;
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
    if (exists.rowCount === 0) return;
    // revoke membership first so the role holds nothing, then remove what it owns here and the role itself
    const parent = await client.query("select 1 from pg_roles where rolname = 'sanctum_app'");
    if (parent.rowCount) await client.query(`revoke sanctum_app from ${role}`);
    await client.query(`drop owned by ${role}`);
    await client.query(`drop role ${role}`);
  } catch (e) {
    console.warn(`global teardown: could not drop role ${TEST_APP_ROLE}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}
