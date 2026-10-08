import { parseArgs } from "node:util";
import type { Pool } from "pg";
import { isValidMindId, mindIdProblem } from "./auth.js";
import { ArgError } from "./cli-args.js";

export class PurgeError extends Error {}

export const PURGE_USAGE = "usage: sanctum-mind purge-mind --mind <id> --confirm <id> [--sever-letters]";

export interface PurgeArgs {
  mind: string;
  confirm: string;
  sever_letters: boolean;
}

/** --confirm must equal --mind exactly; a purge cannot be undone. */
export function parsePurgeArgs(argv: string[]): PurgeArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { mind: { type: "string" }, confirm: { type: "string" }, "sever-letters": { type: "boolean" } },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${PURGE_USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 0) throw new ArgError(`purge-mind takes no positional arguments (got "${positionals.join(" ")}")\n${PURGE_USAGE}`);
  if (values.mind === undefined || values.mind === "") throw new ArgError(`--mind <id> is required\n${PURGE_USAGE}`);
  if (!isValidMindId(values.mind)) throw new ArgError(mindIdProblem(values.mind));
  if (values.confirm === undefined) throw new ArgError(`--confirm <id> is required: repeat the mind id exactly to confirm the purge\n${PURGE_USAGE}`);
  if (values.confirm !== values.mind) {
    throw new ArgError(`--confirm "${values.confirm}" does not equal --mind "${values.mind}"; nothing was purged\n${PURGE_USAGE}`);
  }
  return { mind: values.mind, confirm: values.confirm, sever_letters: values["sever-letters"] === true };
}

export interface PurgeResult {
  mind_id: string;
  /** rows deleted per table, plus letters, letters_severed (letters of other minds removed), grants and minds */
  counts: Record<string, number>;
}

/**
 * Deletes a mind and everything of its own through the admin-only purge_mind() SQL function, in one
 * transaction. `adminPool` must connect as the role that owns the schema; the unprivileged
 * sanctum_app login cannot call it. This is the one deletion path in the system (the events table is
 * append-only for everyone else). The function refuses, deleting nothing, when other minds hold
 * letters involving this mind (unless sever_letters) or when this mind authored rows inside other minds.
 */
export async function purgeMind(
  adminPool: Pool,
  mind_id: string,
  opts: { sever_letters?: boolean; confirm?: string } = {},
): Promise<PurgeResult> {
  if (!isValidMindId(mind_id)) throw new PurgeError(mindIdProblem(mind_id));
  if (opts.confirm !== undefined && opts.confirm !== mind_id) {
    throw new PurgeError(`confirmation "${opts.confirm}" does not equal the mind id "${mind_id}"; nothing was purged`);
  }
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    let raw: Record<string, number>;
    try {
      const r = await client.query<{ counts: Record<string, number> }>("select purge_mind($1, $2) as counts", [mind_id, opts.sever_letters === true]);
      raw = r.rows[0]!.counts;
    } catch (e) {
      await client.query("rollback").catch(() => undefined);
      const err = e as { code?: string; message?: string };
      if (err.code === "42501") throw new PurgeError("purge needs the ADMIN database connection (the role that owns the schema); this role may not run purge_mind");
      if (err.code === "42883") throw new PurgeError("purge_mind() does not exist; run the migrations first (sanctum-mind migrate)");
      throw new PurgeError(err.message ?? String(e));
    }
    await client.query("commit");
    return { mind_id, counts: raw };
  } finally {
    client.release();
  }
}

export function formatPurge(r: PurgeResult): string {
  const lines = [`purged mind "${r.mind_id}"`];
  for (const [t, n] of Object.entries(r.counts)) lines.push(`  ${t.padEnd(18)} ${n}`);
  return lines.join("\n");
}
