// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { parseArgs } from "node:util";
import { ArgError } from "./cli-args.js";
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from "./db/migrate.js";
import type { Pool } from "pg";
import { createPool } from "./db/pool.js";
import { aheadMessage, schemaStatus } from "./db/schema.js";
import { repairBackfill } from "./extractor-admin.js";
import { laneRoleProblems, repairLaneRoles } from "./init.js";
import { LANES, laneRole } from "./db/lanes.js";
import { packageInfo } from "./version.js";

export const UPGRADE_USAGE = `usage: DATABASE_URL=<admin url> sanctum-mind upgrade [--dry-run] [--no-backfill]

  --dry-run      print what would happen and change nothing (exit 0)
  --no-backfill  do not run the belief-repair backfill; print the command for each mind instead

The URL must be a superuser connection (for example the postgres user). Applies pending migrations, repairs the lane roles and
their grants (no passwords are changed), adds the repair work that rewrites and retirements made before migration 0025 are missing
(for every mind, on every run), and prints the steps that still need you. What is left is read from the database each time, not
from what this run did. Exit 0: nothing detectable is left. Exit 3: manual steps remain. Exit 1: it failed, or the database was
migrated by a newer version. A second run on a finished install prints "nothing to do".`;

export interface UpgradeOptions {
  databaseUrl: string | undefined;
  dryRun: boolean;
  noBackfill: boolean;
  /** the migrations directory (tests); default: the one that ships with this build */
  dir?: string;
}

export function parseUpgradeArgs(argv: string[], env: Record<string, string | undefined>): UpgradeOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "dry-run": { type: "boolean", default: false }, "no-backfill": { type: "boolean", default: false } },
      allowPositionals: false,
    }));
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${UPGRADE_USAGE}`);
  }
  return { databaseUrl: env.DATABASE_URL || undefined, dryRun: values["dry-run"] === true, noBackfill: values["no-backfill"] === true };
}

export class UpgradeError extends Error {}

/**
 * What still needs a human after a migration, keyed by migration number. This table is the one source: `upgrade` prints from it
 * and UPGRADING.md carries a copy of it that test/upgrade.test.ts compares against `manualStepsMarkdown()`.
 *   when "state": printed on every run while the database is in the state the step is about (here: a lane login is missing),
 *                 and the exit code is 3 until it is not. It is read from the database, not from what this run applied.
 *   when "refused": printed when the migration refuses (its error mentions `refusedOn`) or a check before it finds why it would.
 */
export interface ManualStep {
  /** the release that introduced the migration */
  release: string;
  /** the migration number, "0026" */
  migration: string;
  when: "state" | "refused";
  refusedOn?: string;
  text: string;
}

export const MANUAL_STEPS: readonly ManualStep[] = [
  {
    release: "0.1.0",
    migration: "0020",
    when: "refused",
    refusedOn: "proposals_one_open_per_core",
    text: "if the migration refused on proposals_one_open_per_core, withdraw one of the two open declarations on that core through the still-running old version (the new service refuses to start while the database is behind), or as the database admin with update proposals set status='withdrawn', withdrawn_at=now() where id='<proposal id>' (an admin action, not the mind's), then run upgrade again",
  },
  {
    release: "0.2.0",
    migration: "0026",
    when: "state",
    text: "services now log in as lanes: run init with the admin URL to create the lane logins (Docker: docker compose run --rm init), then set DATABASE_URL per service to the lane URLs init printed; until then they run on the legacy login with a warning",
  },
];

export const BEGIN_STEPS_TABLE = "<!-- manual-steps:begin (generated from MANUAL_STEPS in src/upgrade.ts; test/upgrade.test.ts keeps it in sync) -->";
export const END_STEPS_TABLE = "<!-- manual-steps:end -->";

const WHEN_TEXT: Record<ManualStep["when"], string> = {
  state: "while sanctum_verb or sanctum_daemon has no login",
  refused: "when it refuses",
};

/** The Markdown table UPGRADING.md carries between its two markers. */
export function manualStepsMarkdown(): string {
  const rows = MANUAL_STEPS.map((s) => `| ${s.release} | ${s.migration} | ${WHEN_TEXT[s.when]} | ${s.text} |`);
  return ["| Release | Migration | When | What you do |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

const idOf = (file: string): string => file.slice(0, 4);
/** A long list (a fresh install is 26 files) is shown as its first and last entries. */
const listed = (files: string[]): string => (files.length <= 8 ? files.join(", ") : `${files[0]} ... ${files[files.length - 1]}`);

export function backfillCommand(mind: string): string {
  return `sanctum-mind extractor repair-backfill --mind ${mind}`;
}
const BACKFILL_FORMS =
  "(from a clone: DATABASE_URL=<admin> npm start -- extractor repair-backfill --mind <id>; under Docker: docker compose run --rm init node dist/cli.js extractor repair-backfill --mind <id>)";

const LOGIN_STEP = MANUAL_STEPS.find((s) => s.migration === "0026")!;
const CORE_STEP = MANUAL_STEPS.find((s) => s.migration === "0020")!;

/** Lane logins the services need: verb (http, stdio) and daemon. Missing or NOLOGIN counts as no login. */
async function lanesWithoutLogin(pool: Pool): Promise<string[]> {
  const r = await pool.query<{ role: string }>(
    `select r as role from unnest(array['sanctum_verb', 'sanctum_daemon']) r
      where not exists (select 1 from pg_roles where rolname = r and rolcanlogin) order by r`,
  );
  return r.rows.map((x) => x.role);
}

export interface CoreConflict {
  mind: string;
  core: string;
  proposals: string[];
}

/** Cores with two open (pending or accepted) declarations: what migration 0020's unique index cannot be built over. */
export async function openCoreConflicts(pool: Pool): Promise<CoreConflict[]> {
  const has = await pool.query<{ ok: boolean }>(
    "select exists (select 1 from pg_attribute where attrelid = to_regclass('proposals') and attname = 'target_node_id' and not attisdropped) as ok",
  );
  if (has.rows[0]?.ok !== true) return [];
  const r = await pool.query<{ mind_id: string; target_node_id: string; ids: string[] }>(
    `select mind_id, target_node_id, array_agg(id::text order by created_at, id) as ids
       from proposals where target_node_id is not null and status in ('pending', 'accepted')
      group by mind_id, target_node_id having count(*) > 1 order by mind_id, target_node_id`,
  );
  return r.rows.map((x) => ({ mind: x.mind_id, core: x.target_node_id, proposals: x.ids }));
}

function printConflicts(out: (line: string) => void, conflicts: CoreConflict[]): void {
  out("cores with two open declarations (migration 0020 cannot build its index over them):");
  for (const c of conflicts) {
    out(`  mind ${c.mind}, core ${c.core}: proposals ${c.proposals.join(", ")}`);
    for (const id of c.proposals.slice(1)) out(`    admin: update proposals set status='withdrawn', withdrawn_at=now() where id='${id}';`);
  }
  out(`next: ${CORE_STEP.text}`);
}

export interface UpgradeResult {
  /** 0: nothing detectable is left; 3: manual steps remain */
  exitCode: 0 | 3;
  dryRun: boolean;
  applied: string[];
  pending: string[];
  lanesCreated: string[];
  lanesRepaired: string[];
  /** minds the backfill ran for (or, in a dry run, would run for), with the work rows added */
  backfilled: { mind: string; count: number }[];
  manual: string[];
  /** sessions connected as the legacy sanctum_app login (information only) */
  legacySessions: number;
  /** true when the run changed nothing and left nothing to do */
  nothingToDo: boolean;
}

/**
 * `sanctum-mind upgrade`: bring an existing install to this build. In order: report where the database is, apply pending migrations,
 * repair the lane roles and grants, add the repair work that is missing, and print what still needs a human. What is outstanding
 * is read from the database on every run, not remembered from the run that applied a migration, so an install whose 0025 was
 * applied long ago still gets its backfill and a second run reports the same open steps until they are done.
 * Lines go to `out` as they happen. Throws UpgradeError when it cannot continue (nothing after the failure ran).
 */
export async function runUpgrade(opts: UpgradeOptions, out: (line: string) => void = console.log): Promise<UpgradeResult> {
  const url = opts.databaseUrl;
  if (!url) throw new UpgradeError("DATABASE_URL is not set; upgrade needs the admin connection string");
  try {
    new URL(url);
  } catch {
    throw new UpgradeError("DATABASE_URL is not a valid connection URL");
  }
  const dir = opts.dir ?? DEFAULT_MIGRATIONS_DIR;
  const pool = createPool(url);
  const manual: string[] = [];
  let lanesWouldChange = false;
  let backfillOutstanding = 0;
  const result: UpgradeResult = { exitCode: 0, dryRun: opts.dryRun, applied: [], pending: [], lanesCreated: [], lanesRepaired: [], backfilled: [], manual, legacySessions: 0, nothingToDo: false };
  try {
    let me;
    try {
      me = (await pool.query<{ rolname: string; ok: boolean }>("select rolname, rolsuper as ok from pg_roles where rolname = current_user")).rows[0];
    } catch (e) {
      throw new UpgradeError(`could not connect to DATABASE_URL: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (me?.ok !== true) {
      throw new UpgradeError(`upgrade needs a superuser connection (for example the postgres user), but "${me?.rolname ?? "?"}" is not one: migrations create roles and extensions and change what they own. Use the admin URL here, not a lane URL.`);
    }

    // (a) where the database is
    const before = await schemaStatus(pool, dir);
    result.pending = before.pending;
    out(`sanctum-mind ${packageInfo().version}${opts.dryRun ? " (dry run: nothing will be changed)" : ""}`);
    out(`database: ${before.applied.length} migration(s) applied${before.latest ? `, schema ${before.latest}` : ""}; this build carries ${before.files.length}`);
    out(before.pending.length === 0 ? "pending: none" : `pending (${before.pending.length}): ${listed(before.pending)}`);
    if (before.unknown.length > 0) throw new UpgradeError(aheadMessage(before.unknown));

    // (b) migrations. 0020 builds a unique index that cannot exist over two open declarations on one core: look first, name them,
    // and stop before anything is applied (the old version can still withdraw one; the new service will not start on this database).
    if (before.pending.some((f) => idOf(f) === "0020")) {
      const conflicts = await openCoreConflicts(pool);
      if (conflicts.length > 0) {
        printConflicts(out, conflicts);
        if (!opts.dryRun) throw new UpgradeError("migration 0020 would refuse; nothing was applied. Withdraw one declaration per core as above, then run upgrade again");
      }
    }
    let applied: string[] = [];
    if (before.pending.length > 0) {
      if (opts.dryRun) {
        out(`would apply ${before.pending.length} migration(s)`);
      } else {
        try {
          applied = (await runMigrations(url, dir)).applied;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const detail = (e instanceof Error ? (e.cause as { detail?: string } | undefined)?.detail : undefined) ?? null;
          const after = await schemaStatus(pool, dir).catch(() => null);
          const done = after ? before.pending.filter((f) => after.applied.includes(f)) : [];
          if (done.length > 0) out(`applied before the failure: ${listed(done)}`);
          if (detail) out(`detail: ${detail}`);
          const failed = /^Migration (\d{4})_/.exec(message)?.[1];
          for (const st of MANUAL_STEPS) {
            if (st.when === "refused" && st.migration === failed && st.refusedOn !== undefined && (message.includes(st.refusedOn) || (detail ?? "").includes(st.refusedOn))) {
              const conflicts = await openCoreConflicts(pool).catch(() => []);
              if (conflicts.length > 0) printConflicts(out, conflicts);
              else out(`next: ${st.text}`);
            }
          }
          throw new UpgradeError(message);
        }
        out(`applied ${applied.length} migration(s): ${listed(applied)}`);
        result.applied = applied;
        result.pending = [];
      }
    }

    // (c) lane roles and their grants. They need the tables of the migrations before them, so a dry run with migrations pending
    // can only say that it will look.
    if (opts.dryRun && before.pending.length > 0) {
      out("lane roles: would be checked after the migrations apply");
    } else if (opts.dryRun) {
      const problems: string[] = [];
      for (const lane of LANES) {
        const p = await laneRoleProblems(pool, laneRole(lane));
        if (p.length > 0) problems.push(`${laneRole(lane)} (${p.join(", ")})`);
      }
      lanesWouldChange = problems.length > 0;
      out(problems.length === 0 ? "lane roles: present, grants intact" : `lane roles: would repair ${problems.join(", ")}`);
    } else {
      const lanes = await repairLaneRoles(pool);
      result.lanesCreated = lanes.created;
      result.lanesRepaired = lanes.repaired;
      if (lanes.created.length > 0) out(`lane roles: created ${lanes.created.join(", ")} (no login; init gives them one)`);
      if (lanes.repaired.length > 0) out(`lane roles: repaired ${lanes.repaired.join(", ")}`);
      if (lanes.created.length === 0 && lanes.repaired.length === 0) out("lane roles: present, grants intact");
    }

    // (d) belief-repair work that is missing, checked for every mind on every run. Rewrites and retirements made before 0025, and
    // nodes an import brought in, have no repair_work row; the dry-run count of the backfill is exactly that gap.
    const ready = (await pool.query<{ t: string | null }>("select to_regclass('repair_work')::text as t")).rows[0]?.t != null;
    if (!ready) {
      out("backfill: repair work is checked for every mind once 0025 is applied");
    } else {
      const minds = (await pool.query<{ mind_id: string; disabled_at: Date | null }>("select mind_id, disabled_at from minds order by mind_id")).rows;
      const todo: { mind: string; count: number }[] = [];
      for (const m of minds) {
        if (m.disabled_at !== null) {
          manual.push(`mind "${m.mind_id}" has access suspended, so its repair work cannot be checked or added: sanctum-mind restore-access --mind ${m.mind_id}, then run upgrade again`);
          continue;
        }
        try {
          const c = await repairBackfill(pool, m.mind_id, { dryRun: true });
          if (c.count > 0) todo.push({ mind: m.mind_id, count: c.count });
        } catch (e) {
          manual.push(`the repair work for mind "${m.mind_id}" could not be checked (${e instanceof Error ? e.message : String(e)}): ${backfillCommand(m.mind_id)}`);
        }
      }
      backfillOutstanding = todo.reduce((n, t) => n + t.count, 0);
      if (todo.length === 0) {
        out(minds.length === 0 ? "backfill: no minds yet" : "backfill: no repair work outstanding");
      } else if (opts.dryRun) {
        out("backfill: would add repair work for rewrites and retirements that have none");
        for (const t of todo) out(`  ${t.mind}: ${t.count} repair work row(s) would be added`);
        result.backfilled = todo;
      } else if (opts.noBackfill) {
        out("backfill: skipped (--no-backfill)");
        for (const t of todo) manual.push(`repair work not added for mind "${t.mind}" (${t.count} row(s) outstanding): ${backfillCommand(t.mind)}`);
      } else {
        out("backfill: adding repair work for rewrites and retirements that have none");
        for (const t of todo) {
          try {
            const b = await repairBackfill(pool, t.mind);
            result.backfilled.push({ mind: t.mind, count: b.count });
            out(`  ${t.mind}: ${b.count} repair work row(s) added`);
          } catch (e) {
            out(`  ${t.mind}: failed: ${e instanceof Error ? e.message : String(e)}`);
            manual.push(`the repair backfill failed for mind "${t.mind}": ${backfillCommand(t.mind)}`);
          }
        }
        out("  the daemon works through the new rows under EXTRACTOR_REPAIR_BUDGET per tick");
      }
    }

    // (e) what still needs a human, from the database's state
    const noLogin = await lanesWithoutLogin(pool);
    if (noLogin.length > 0) manual.push(`(${LOGIN_STEP.migration}) no login on ${noLogin.join(", ")}: ${LOGIN_STEP.text}`);
    if (manual.length > 0) {
      out(opts.dryRun ? "you would still need to:" : "still needs you:");
      manual.forEach((m, i) => out(`  ${i + 1}. ${m}`));
      if (manual.some((m) => m.includes("repair-backfill"))) out(`  ${BACKFILL_FORMS}`);
    }

    // information only: sessions that have not moved to a lane
    try {
      const n = (await pool.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where usename = 'sanctum_app' and datname = current_database()")).rows[0]?.n ?? 0;
      result.legacySessions = n;
      if (n > 0) out(`info: ${n} session(s) still connected as sanctum_app (the legacy login); point those services at their lane URLs`);
    } catch {
      // pg_stat_activity is informational; never fail the upgrade over it
    }

    // (f) the verdict
    const changed = result.applied.length > 0 || result.lanesCreated.length > 0 || result.lanesRepaired.length > 0 || (!opts.dryRun && result.backfilled.length > 0);
    if (opts.dryRun) {
      result.nothingToDo = before.pending.length === 0 && !lanesWouldChange && backfillOutstanding === 0 && manual.length === 0;
      out(result.nothingToDo ? "nothing to do" : "dry run: nothing was changed");
    } else if (manual.length > 0) {
      out(`upgrade done; ${manual.length} manual step(s) remain (exit 3)`);
      result.exitCode = 3;
    } else if (changed) {
      out("upgrade done. Restart the services so they run the new version (Docker: docker compose up -d; a clone: restart http, stdio and daemon).");
    } else {
      out("nothing to do");
      result.nothingToDo = true;
    }
    return result;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
