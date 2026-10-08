import { parseArgs } from "node:util";
import type { Pool } from "pg";
import { isValidMindId, mindIdProblem } from "./auth.js";
import { ArgError } from "./cli-args.js";
import type { GrantScope } from "./verbs/types.js";

/** Grants administration. ADMIN ONLY: the app role has select on grants and nothing else. */

export const GRANT_SCOPES: readonly GrantScope[] = ["read", "write", "relate", "letter", "steward"];
export const GRANT_USAGE =
  "usage: sanctum-mind grant add --from <grantor> --to <grantee> --scope <read|write|relate|letter|steward> [--json]\n" +
  "       sanctum-mind grant revoke --from <grantor> --to <grantee> --scope <scope> [--json]\n" +
  "       sanctum-mind grant list [--mind <id>] [--json]";

export interface GrantRow {
  id: string;
  grantor_mind: string;
  grantee_mind: string;
  scope: GrantScope;
  granted_at: Date;
  revoked_at: Date | null;
}

export interface GrantArgs {
  action: "add" | "revoke" | "list";
  from?: string;
  to?: string;
  scope?: GrantScope;
  mind?: string;
  json: boolean;
}

export function isGrantScope(s: string): s is GrantScope {
  return (GRANT_SCOPES as readonly string[]).includes(s);
}

export function parseGrantArgs(argv: string[]): GrantArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        from: { type: "string" },
        to: { type: "string" },
        scope: { type: "string" },
        mind: { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${GRANT_USAGE}`);
  }
  const { values, positionals } = parsed;
  const action = positionals[0];
  if (action !== "add" && action !== "revoke" && action !== "list") {
    throw new ArgError(`grant needs a subcommand: add, revoke or list\n${GRANT_USAGE}`);
  }
  if (positionals.length > 1) throw new ArgError(`unexpected argument "${positionals[1]}"\n${GRANT_USAGE}`);
  const checkMind = (flag: string, v: string | undefined): string => {
    if (v === undefined) throw new ArgError(`--${flag} is required\n${GRANT_USAGE}`);
    if (!isValidMindId(v)) throw new ArgError(mindIdProblem(v));
    return v;
  };
  const out: GrantArgs = { action, json: values.json === true };
  if (action === "list") {
    if (values.from !== undefined || values.to !== undefined || values.scope !== undefined) {
      throw new ArgError(`grant list takes only --mind\n${GRANT_USAGE}`);
    }
    if (values.mind !== undefined) out.mind = checkMind("mind", values.mind);
    return out;
  }
  if (values.mind !== undefined) throw new ArgError(`grant ${action} does not take --mind\n${GRANT_USAGE}`);
  out.from = checkMind("from", values.from);
  out.to = checkMind("to", values.to);
  if (values.scope === undefined) throw new ArgError(`--scope is required\n${GRANT_USAGE}`);
  if (!isGrantScope(values.scope)) {
    throw new ArgError(`invalid scope "${values.scope}" (allowed: ${GRANT_SCOPES.join(", ")})`);
  }
  out.scope = values.scope;
  return out;
}

async function requireEnabledMinds(pool: Pool, ids: string[]): Promise<void> {
  for (const id of new Set(ids)) {
    const r = await pool.query<{ disabled_at: Date | null }>("select disabled_at from minds where mind_id = $1", [id]);
    if (r.rows.length === 0) throw new ArgError(`unknown mind "${id}"`);
    if (r.rows[0]!.disabled_at !== null) throw new ArgError(`mind "${id}" is disabled`);
  }
}

function checkScope(scope: string): GrantScope {
  if (!isGrantScope(scope)) throw new ArgError(`invalid scope "${scope}" (allowed: ${GRANT_SCOPES.join(", ")})`);
  return scope;
}

export interface AddGrantResult {
  status: "created" | "exists";
  grant: GrantRow;
}

/** Adds a live grant; an identical live grant is a no-op reported as `exists`. */
export async function addGrant(pool: Pool, from: string, to: string, scope: string): Promise<AddGrantResult> {
  const sc = checkScope(scope);
  await requireEnabledMinds(pool, [from, to]);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`grant:${from}:${to}:${sc}`]);
    const live = await client.query<GrantRow>(
      `select * from grants where grantor_mind = $1 and grantee_mind = $2 and scope = $3 and revoked_at is null`,
      [from, to, sc],
    );
    if (live.rows[0]) {
      await client.query("commit");
      return { status: "exists", grant: live.rows[0] };
    }
    const ins = await client.query<GrantRow>(
      `insert into grants (grantor_mind, grantee_mind, scope) values ($1, $2, $3) returning *`,
      [from, to, sc],
    );
    await client.query("commit");
    return { status: "created", grant: ins.rows[0]! };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export interface RevokeGrantResult {
  status: "revoked" | "none";
  revoked: number;
}

/** Sets revoked_at on every live matching grant; a no-op (`none`) when there is none. */
export async function revokeGrant(pool: Pool, from: string, to: string, scope: string): Promise<RevokeGrantResult> {
  const sc = checkScope(scope);
  const r = await pool.query(
    `update grants set revoked_at = now()
      where grantor_mind = $1 and grantee_mind = $2 and scope = $3 and revoked_at is null`,
    [from, to, sc],
  );
  const n = r.rowCount ?? 0;
  return { status: n > 0 ? "revoked" : "none", revoked: n };
}

/** Live grants, optionally only those touching a mind (as grantor or grantee). */
export async function listGrants(pool: Pool, mind?: string): Promise<GrantRow[]> {
  const r = await pool.query<GrantRow>(
    `select * from grants where revoked_at is null and ($1::text is null or grantor_mind = $1 or grantee_mind = $1)
      order by grantor_mind, grantee_mind, scope, granted_at`,
    [mind ?? null],
  );
  return r.rows;
}

export function formatGrantTable(rows: GrantRow[]): string {
  if (rows.length === 0) return "no live grants";
  const header = ["FROM", "TO", "SCOPE", "GRANTED"];
  const body = rows.map((g) => [g.grantor_mind, g.grantee_mind, g.scope, new Date(g.granted_at).toISOString()]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

/** Runs a parsed `grant` command against an admin pool and returns the text (or JSON) to print. */
export async function runGrantCommand(pool: Pool, args: GrantArgs): Promise<string> {
  const render = (v: unknown, text: string) => (args.json ? JSON.stringify(v, null, 2) : text);
  if (args.action === "add") {
    const r = await addGrant(pool, args.from!, args.to!, args.scope!);
    return render(r, `${r.status === "created" ? "granted" : "already granted (no change)"}: ${args.from} -> ${args.to} ${args.scope}`);
  }
  if (args.action === "revoke") {
    const r = await revokeGrant(pool, args.from!, args.to!, args.scope!);
    return render(r, r.status === "revoked" ? `revoked: ${args.from} -> ${args.to} ${args.scope}` : "no live grant to revoke (no change)");
  }
  const rows = await listGrants(pool, args.mind);
  return render({ grants: rows }, formatGrantTable(rows));
}
