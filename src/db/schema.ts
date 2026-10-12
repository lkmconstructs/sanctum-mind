// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { readdir } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { DEFAULT_MIGRATIONS_DIR } from "./migrate.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/** Which migrations this build carries, which the database has recorded, and the difference. */
export interface SchemaStatus {
  /** every migration file in this build, sorted */
  files: string[];
  /** the recorded filenames, sorted (empty when schema_migrations does not exist yet) */
  applied: string[];
  /** files the database has not recorded, in the order they would run */
  pending: string[];
  /** the last recorded migration without its .sql, or null */
  latest: string | null;
  /** recorded filenames this build does not carry: the database was migrated by a newer version */
  unknown: string[];
}

/** schema_migrations exists but this login may not read it: a database that has never been migrated or upgraded by this version. */
export class SchemaUnreadable extends Error {}

/** The database and this build disagree about the migrations; the message is what the operator is told. */
export class SchemaRefusal extends Error {}

/** The database is behind this build. */
export class SchemaAhead extends SchemaRefusal {}

export class SchemaBehind extends SchemaRefusal {
  constructor(
    message: string,
    readonly pending: number,
  ) {
    super(message);
  }
}

export async function migrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

export const migrationId = (file: string): string => file.replace(/\.sql$/, "");

export async function appliedMigrations(q: Queryable): Promise<string[]> {
  try {
    const r = await q.query<{ filename: string }>("select filename from schema_migrations order by filename");
    return r.rows.map((x) => x.filename);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "42P01") return []; // undefined_table: nothing has been migrated
    if (code === "42501") throw new SchemaUnreadable("this login cannot read schema_migrations");
    throw e;
  }
}

export async function schemaStatus(q: Queryable, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<SchemaStatus> {
  const files = await migrationFiles(dir);
  const applied = await appliedMigrations(q);
  const have = new Set(applied);
  const known = new Set(files);
  const last = applied[applied.length - 1];
  return { files, applied, pending: files.filter((f) => !have.has(f)), latest: last === undefined ? null : migrationId(last), unknown: applied.filter((f) => !known.has(f)) };
}

export const UPGRADE_HINT = "run `sanctum-mind upgrade` with the admin URL";

/** What to say when the database records migrations this build does not carry (shared by upgrade and the startup check). */
export function aheadMessage(unknown: string[]): string {
  return `database records migration(s) this build does not carry (${unknown.join(", ")}): it was migrated by a newer version. There is no downgrade: check out that version again, or restore a backup taken before it was applied`;
}

/**
 * Why this build must not run on this database, or null when the migrations agree. Newer than the build is refused as firmly as
 * behind it: older code on a newer schema is no safer than the reverse.
 */
export async function schemaProblem(q: Queryable, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<{ message: string; kind: "ahead" | "behind"; pending: number } | null> {
  let s: SchemaStatus;
  try {
    s = await schemaStatus(q, dir);
  } catch (e) {
    if (e instanceof SchemaUnreadable) {
      return { message: `cannot tell whether the database is current (${e.message}; migrate makes it readable): ${UPGRADE_HINT}`, kind: "behind", pending: 1 };
    }
    throw e;
  }
  if (s.unknown.length > 0) return { message: aheadMessage(s.unknown), kind: "ahead", pending: 0 };
  if (s.pending.length > 0) return { message: `database is ${s.pending.length} migration(s) behind: ${UPGRADE_HINT}`, kind: "behind", pending: s.pending.length };
  return null;
}

/**
 * The startup check of http, stdio, daemon and the commands that write: refuse to run on a database that is missing migrations of
 * this build, or has migrations it lacks. Running new code on a half-migrated schema is how data gets hurt; the fix is one command
 * (or, for a newer database, the newer version). A login that cannot read schema_migrations is a database that predates the grant
 * `migrate` now makes, which is behind by definition.
 */
export async function assertSchemaCurrent(q: Queryable, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<void> {
  const p = await schemaProblem(q, dir);
  if (p === null) return;
  throw p.kind === "ahead" ? new SchemaAhead(p.message) : new SchemaBehind(p.message, p.pending);
}
