// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const LOCK_KEY = "7264938110245";
export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * Checksums that databases recorded for a migration file when its comment-only header was briefly different.
 * Only differences in comments may ever be listed here: a recorded value in this list is accepted and overwritten with
 * the current checksum, so listing a file whose SQL differs would hide real drift. Each entry names the commits.
 *   0013_govern.sql: header reworded in db41280 (kept through 6292229), restored afterwards. f00d63e is the current text.
 *   0018_identity_guard.sql: header reworded in f00d63e..6292229 (7746705a...), restored afterwards.
 * Between f00d63e and 6292229 (commits f00d63e, db41280, 6292229) databases migrated in that window recorded these.
 */
export const SUPERSEDED_CHECKSUMS: Record<string, string[]> = {
  "0013_govern.sql": [
    "a9bdd3ec61ef2457f17ec7df8bd449d7cc2f3ccadbaee22514320aec016918f5", // db41280, 6292229
  ],
  "0018_identity_guard.sql": [
    "7746705a8c744e5863ce75bd8adae640169fef2e0bdc5cacbe742e459514668c", // f00d63e, db41280, 6292229
  ],
};

export async function runMigrations(
  databaseUrl: string,
  dir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<{ applied: string[]; skipped: string[] }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  let locked = false;
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [LOCK_KEY]);
    locked = true;
    await client.query(
      `create table if not exists schema_migrations (
         filename text primary key,
         checksum text not null,
         applied_at timestamptz not null default now()
       )`,
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "select checksum from schema_migrations where filename = $1",
        [file],
      );
      const recorded = existing.rows[0];
      if (recorded) {
        if (recorded.checksum !== checksum) {
          if (SUPERSEDED_CHECKSUMS[file]?.includes(recorded.checksum)) {
            try {
              await client.query("begin");
              await client.query("update schema_migrations set checksum = $2 where filename = $1", [file, checksum]);
              await client.query("commit");
            } catch (err) {
              await client.query("rollback").catch(() => {});
              throw new Error(`Migration ${file} checksum update failed: ${(err as Error).message}`, { cause: err });
            }
            console.log(`migration ${file}: recorded a superseded comment-only checksum; updated`);
            skipped.push(file);
            continue;
          }
          throw new Error(
            `Migration ${file} was already applied but its checksum has changed (recorded ${recorded.checksum}, now ${checksum}). Refusing to re-run; add a new migration instead.`,
          );
        }
        skipped.push(file);
        continue;
      }
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query(
          "insert into schema_migrations (filename, checksum, applied_at) values ($1, $2, now())",
          [file, checksum],
        );
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    // The services run on unprivileged logins. They read schema_migrations to learn which migrations are applied (the startup check,
    // GET /health, mind_health), so that one table is readable by sanctum_app and by the lanes through it. Runs every time, so a
    // database that was migrated before this grant existed gets it on its next migrate, init or upgrade.
    try {
      await client.query(
        `do $$ begin
           if exists (select 1 from pg_roles where rolname = 'sanctum_app') then grant select on schema_migrations to sanctum_app; end if;
         end $$`,
      );
    } catch (err) {
      console.error(`migrate: could not make schema_migrations readable to sanctum_app: ${(err as Error).message}`);
    }
    return { applied, skipped };
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock($1::bigint)", [LOCK_KEY]).catch(() => {});
    }
    await client.end();
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  runMigrations(url)
    .then((r) => {
      console.log(`applied: ${r.applied.join(", ") || "(none)"}; skipped: ${r.skipped.join(", ") || "(none)"}`);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
