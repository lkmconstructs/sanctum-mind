import { parseArgs } from "node:util";
import type { Pool } from "pg";
import { isValidMindId, mindIdProblem } from "./auth.js";
import { ArgError } from "./cli-args.js";

/**
 * Suspend or restore access to a mind. ADMIN ONLY: the app role can only read `minds`.
 * This is an infrastructure duty of whoever runs the service, not a power over the mind: while access is
 * suspended the mind's bearer is `unauthorized`, and grants from it stop applying (resolveCaller ignores
 * grants whose grantor is suspended). Nothing is deleted; `restore-access` reverses it.
 * `disable-mind` / `enable-mind` remain as deprecated aliases.
 */

export const MINDS_ADMIN_USAGE =
  "usage: sanctum-mind suspend-access --mind <id>\n       sanctum-mind restore-access --mind <id>";

export type MindToggleCommand = "suspend-access" | "restore-access" | "disable-mind" | "enable-mind";

/** The deprecated spellings and what they now mean. */
export const DEPRECATED_TOGGLE_ALIASES: Readonly<Record<string, "suspend-access" | "restore-access">> = {
  "disable-mind": "suspend-access",
  "enable-mind": "restore-access",
};

export const isSuspendCommand = (command: MindToggleCommand): boolean => command === "suspend-access" || command === "disable-mind";

export interface MindToggleArgs {
  mind: string;
}

export function parseMindToggleArgs(argv: string[], command: MindToggleCommand): MindToggleArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: { mind: { type: "string" } }, strict: true, allowPositionals: false });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\nusage: sanctum-mind ${command} --mind <id>`);
  }
  const mind = parsed.values.mind;
  if (mind === undefined || mind === "") throw new ArgError(`--mind <id> is required\nusage: sanctum-mind ${command} --mind <id>`);
  if (!isValidMindId(mind)) throw new ArgError(mindIdProblem(mind));
  return { mind };
}

export type MindToggleStatus = "suspended" | "restored" | "unchanged";

export interface MindToggleResult {
  mind: string;
  status: MindToggleStatus;
  /** restore only: open declarations (rewrites, retirements and vow breaks) whose effective time was pushed back by the suspended time */
  shifted?: number;
}

/**
 * Sets or clears minds.disabled_at. Unknown mind is an error; an already-correct state is "unchanged".
 * Restoring pushes every open declaration of the mind back by the time access was suspended (a mind that could
 * not act could not withdraw, so its cooling must not run out unseen): accepted unsettled proposals get
 * effective_at += now() - disabled_at, and so does metadata.break_declared.effective_at on its live vows.
 */
export async function setMindDisabled(pool: Pool, mind: string, disabled: boolean): Promise<MindToggleResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // the mind's own scope, so row level security holds for an admin role that does not bypass it
    await client.query("select set_config('app.mind_id', $1, true), set_config('app.bearer', $1, true)", [mind]);
    const cur = await client.query<{ disabled_at: Date | null }>("select disabled_at from minds where mind_id = $1 for update", [mind]);
    const row = cur.rows[0];
    if (!row) throw new ArgError(`mind "${mind}" does not exist`);
    if ((row.disabled_at !== null) === disabled) {
      await client.query("commit");
      return { mind, status: "unchanged" };
    }
    if (disabled) {
      await client.query("update minds set disabled_at = now() where mind_id = $1", [mind]);
      await client.query("commit");
      return { mind, status: "suspended" };
    }
    const props = await client.query(
      `update proposals set effective_at = effective_at + (now() - $2::timestamptz)
        where mind_id = $1 and status = 'accepted' and settled_at is null and withdrawn_at is null and effective_at is not null`,
      [mind, row.disabled_at],
    );
    const vows = await client.query(
      `update nodes set metadata = jsonb_set(
           metadata, '{break_declared,effective_at}',
           to_jsonb(to_char(((metadata->'break_declared'->>'effective_at')::timestamptz + (now() - $2::timestamptz)) at time zone 'UTC',
                            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
        where mind_id = $1 and node_type = 'vow' and invalidated_at is null
          and jsonb_typeof(metadata->'break_declared') = 'object' and metadata->'break_declared' ? 'effective_at'`,
      [mind, row.disabled_at],
    );
    await client.query("update minds set disabled_at = null where mind_id = $1", [mind]);
    await client.query("commit");
    return { mind, status: "restored", shifted: (props.rowCount ?? 0) + (vows.rowCount ?? 0) };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export function formatMindToggle(r: MindToggleResult, command: MindToggleCommand): string {
  if (r.status === "unchanged") return `mind "${r.mind}" access was already ${isSuspendCommand(command) ? "suspended" : "restored"}; nothing changed`;
  if (r.status === "suspended") return `mind "${r.mind}" access suspended`;
  return `mind "${r.mind}" access restored; ${r.shifted ?? 0} open declaration(s) pushed back by the suspended time`;
}
