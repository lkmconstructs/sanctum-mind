import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import type { Caller, GrantScope } from "./verbs/types.js";

const MIND_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_MIND_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function isValidMindId(id: string): boolean {
  return MIND_ID_RE.test(id) && !RESERVED_MIND_IDS.has(id);
}

export function mindIdProblem(id: string): string {
  return `invalid mind_id "${id}" (allowed: a-z A-Z 0-9 _ -, 1 to 64 chars)`;
}

/** Bearer keys shorter than this are refused when a mind is seeded or created. */
export const MIN_KEY_LENGTH = 32;

/** sha256 hex of the bearer key. Only the hash is ever stored. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Resolve a bearer key to a Caller, or null when the key is missing, unknown or disabled.
 * Loads the bearer's live grants (revoked_at is null), grouped by grantor mind.
 */
export async function resolveCaller(pool: Pool, bearer: string | undefined): Promise<Caller | null> {
  if (bearer === undefined || bearer === "") return null;
  const found = await pool.query<{ mind_id: string }>(
    "select mind_id from minds where key_hash = $1 and disabled_at is null",
    [hashKey(bearer)],
  );
  const row = found.rows[0];
  if (!row) return null;
  const grantRows = await pool.query<{ grantor_mind: string; scope: GrantScope }>(
    `select g.grantor_mind, g.scope from grants g
       join minds grantor on grantor.mind_id = g.grantor_mind
      where g.grantee_mind = $1 and g.revoked_at is null and grantor.disabled_at is null
      order by g.granted_at`,
    [row.mind_id],
  );
  const grants: Record<string, GrantScope[]> = Object.create(null);
  for (const g of grantRows.rows) {
    const list = (grants[g.grantor_mind] ??= []);
    if (!list.includes(g.scope)) list.push(g.scope);
  }
  return { bearer: row.mind_id, grants };
}

/** The mind acting as itself may do anything in its own scope; anyone else needs a live grant with the scope. */
export function mayAct(caller: Caller, mind_id: string, scope: GrantScope, opts: { stewardMayRead?: boolean } = {}): boolean {
  if (caller.bearer === mind_id) return true;
  if (!Object.prototype.hasOwnProperty.call(caller.grants, mind_id)) return false;
  const held = caller.grants[mind_id] ?? [];
  if (held.includes(scope)) return true;
  // a steward grant opens identity and vows for reading, only through verbs that opt in
  return scope === "read" && opts.stewardMayRead === true && held.includes("steward");
}

/**
 * Seed or rotate minds from a keys file: one "<mind_id> <key>" per line, blank lines and
 * lines starting with # ignored. Re-seeding sets the new key hash only: it never lifts a suspension
 * (`restore-access` is the one path that does, and it pushes open declarations back); `suspended` names the
 * minds that are still suspended after the upsert.
 * Every line is validated before anything is written.
 *
 * ADMIN ONLY: the app role has no write access to minds, so this must be called with a pool
 * connected as the admin role (the `seed-keys` CLI subcommand), never with the service pool.
 */
export async function seedMindsFromFile(pool: Pool, path: string): Promise<{ upserted: number; suspended: string[] }> {
  const text = await readFile(path, "utf8");
  const entries: Array<{ mind_id: string; key: string; line: number }> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const lineNo = i + 1;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) {
      throw new Error(`${path}: line ${lineNo}: expected "<mind_id> <key>"`);
    }
    const [mind_id, key] = parts as [string, string];
    if (!isValidMindId(mind_id)) {
      throw new Error(`${path}: line ${lineNo}: ${mindIdProblem(mind_id)}`);
    }
    if (key.length < MIN_KEY_LENGTH) {
      throw new Error(`${path}: line ${lineNo}: key for "${mind_id}" is too short (${key.length} characters; at least ${MIN_KEY_LENGTH} required)`);
    }
    entries.push({ mind_id, key, line: lineNo });
  }
  return upsertMinds(pool, entries);
}

/**
 * Upsert (mind_id, key) rows in one transaction, hashing each key. A conflict rotates the key only and leaves `disabled_at` alone.
 * Keys shorter than MIN_KEY_LENGTH are refused before anything is written (the error names the
 * entry, with its line number when it came from a file). Shared by seedMindsFromFile and `init`.
 * ADMIN ONLY, for the same reason.
 */
export async function upsertMinds(
  pool: Pool,
  entries: Array<{ mind_id: string; key: string; line?: number }>,
): Promise<{ upserted: number; suspended: string[] }> {
  if (entries.length === 0) return { upserted: 0, suspended: [] };
  for (const [i, e] of entries.entries()) {
    if (e.key.length < MIN_KEY_LENGTH) {
      throw new Error(`${e.line === undefined ? `entry ${i + 1}` : `line ${e.line}`}: key for "${e.mind_id}" is too short (${e.key.length} characters; at least ${MIN_KEY_LENGTH} required)`);
    }
  }
  const client = await pool.connect();
  const suspended: string[] = [];
  try {
    await client.query("begin");
    for (const e of entries) {
      const r = await client.query<{ disabled_at: Date | null }>(
        `insert into minds (mind_id, key_hash) values ($1, $2)
         on conflict (mind_id) do update set key_hash = excluded.key_hash
         returning disabled_at`,
        [e.mind_id, hashKey(e.key)],
      );
      if (r.rows[0]!.disabled_at !== null && !suspended.includes(e.mind_id)) suspended.push(e.mind_id);
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return { upserted: entries.length, suspended };
}
