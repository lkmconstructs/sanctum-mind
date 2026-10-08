#!/usr/bin/env node
// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { parseArgs } from "node:util";
import { seedMindsFromFile } from "./auth.js";
import { assertRlsEnforced, createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { createHttpServer, DEFAULT_HOST, startStdio } from "./server.js";
import { embedderFromEnv } from "./embed/index.js";
import { backfillEmbeddings } from "./embed/backfill.js";
import { formatInit, InitError, INIT_USAGE, parseInitArgs, runInit } from "./init.js";
import { registry } from "./verbs/registry.js";
import { runDaemonOnce, startDaemon } from "./daemon/index.js";
import { importRevien } from "./adapters/revien.js";
import { ArgError, parseDaemonArgs, parseImportArgs } from "./cli-args.js";
import { GRANT_USAGE, parseGrantArgs, runGrantCommand } from "./grants-admin.js";
import { exportMind, parseExportArgs } from "./export.js";
import { importMind, parseImportMindArgs } from "./import-mind.js";
import { formatPurge, parsePurgeArgs, purgeMind } from "./purge.js";
import { defaultCoolingMs } from "./verbs/cooling.js";
import { DEPRECATED_TOGGLE_ALIASES, formatMindToggle, isSuspendCommand, MINDS_ADMIN_USAGE, parseMindToggleArgs, setMindDisabled, type MindToggleCommand } from "./minds-admin.js";
import { loadSinks } from "./sinks/config.js";
import { sinksRequeue, sinksStatus, sinksTest } from "./sinks/cli.js";

const USAGE = `usage: sanctum-mind <command>

commands:
  init --mind <id>  one-step setup: migrate, sanctum_app login, a mind and its key, MCP client configs
                    (needs an ADMIN DATABASE_URL; see "init" options below)
  migrate           apply database migrations (needs an ADMIN DATABASE_URL)
  seed-keys <file>  upsert minds from a "<mind_id> <key>" file (needs an ADMIN DATABASE_URL)
  http              serve HTTP and MCP Streamable HTTP (needs the sanctum_app DATABASE_URL; PORT default 8002,
                    HOST default 127.0.0.1, MAX_CONNECTIONS default 256; plain HTTP, put TLS in front)
  embed-backfill [--batch N]
                    embed rows that have no vector yet (default batch 64); idempotent
  stdio             serve MCP over stdio (needs the sanctum_app DATABASE_URL and SANCTUM_BEARER)
  daemon [--once] [--interval <minutes>] [--mind <id>]
                    run the deterministic metabolism passes for every enabled mind (sanctum_app URL;
                    default every 30 minutes; --once runs one pass set and exits 0 if all passes were ok, 2 otherwise or when no mind with active access matched)
  import-revien <file> --mind <id> [--source <id>]... [--dry-run]
                    import a Revien graph export (its public JSON format) into one mind (sanctum_app URL)
  grant add|revoke|list ...
                    manage grants between minds (ADMIN URL; see "grant" usage below)
  export-mind --mind <id> [--out <file>]
                    write one mind (ledger, graph, projections) to a JSON file (sanctum_app URL)
  import-mind <file> --mind <target> [--dry-run] [--allow-core] [--strict] [--with-letters]
                    load an export into a mind; idempotent by id; letters to other minds only with --with-letters (sanctum_app URL)
  suspend-access --mind <id> | restore-access --mind <id>
                    suspend access to a mind (its key stops working, grants from it stop applying) or restore it (ADMIN URL);
                    an infrastructure duty, not a power over the mind (disable-mind / enable-mind are deprecated aliases)
  purge-mind --mind <id> --confirm <id> [--sever-letters]
                    delete a mind completely; the only deletion path (ADMIN URL)
  sinks test|status run every configured sink once, or show pending/failing/delivered counts (sanctum_app URL)
  sinks requeue --sink <name>
                    reset the parked (gave-up) rows of one sink so the daemon retries them

migrate and seed-keys run as the database admin; http and stdio run as the unprivileged
sanctum_app login, which cannot modify keys or grants.

${INIT_USAGE}

${GRANT_USAGE}

${MINDS_ADMIN_USAGE}
`;

function fail(message: string): never {
  console.error(`sanctum-mind: ${message}`);
  process.exit(1);
}

function argsOrFail<T>(parse: () => T): T {
  try {
    return parse();
  } catch (e) {
    if (e instanceof ArgError) fail(e.message);
    throw e;
  }
}

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) fail("DATABASE_URL is not set");
  return url;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "init": {
      let opts;
      try {
        opts = parseInitArgs(process.argv.slice(3), process.env);
        const result = await runInit(opts);
        console.log(opts.json ? JSON.stringify(result, null, 2) : formatInit(result));
      } catch (e) {
        if (e instanceof InitError) fail(e.message);
        throw e;
      }
      process.exit(0);
    }
    case "migrate": {
      const { applied, skipped } = await runMigrations(requireDatabaseUrl());
      console.log(`applied: ${applied.length ? applied.join(", ") : "(none)"}`);
      console.log(`skipped: ${skipped.length ? skipped.join(", ") : "(none)"}`);
      return;
    }
    case "seed-keys": {
      const file = process.argv[3];
      if (!file) fail("usage: sanctum-mind seed-keys <file>");
      const pool = createPool(requireDatabaseUrl());
      try {
        const { upserted, suspended } = await seedMindsFromFile(pool, file);
        console.log(`seeded ${upserted} mind(s)`);
        for (const m of suspended) console.log(`note: mind "${m}" is suspended: access remains suspended; run restore-access --mind ${m}`);
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "http": {
      defaultCoolingMs(); // fail fast on a bad IDENTITY_COOLING_HOURS
      const pool = createPool(requireDatabaseUrl());
      await assertRlsEnforced(pool);
      const port = Number(process.env.PORT ?? 8002);
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid PORT "${process.env.PORT}"`);
      const server = createHttpServer({ pool, registry, embedder: embedderFromEnv(process.env), sinks: loadSinks(process.env) });
      const host = process.env.HOST === undefined || process.env.HOST === "" ? DEFAULT_HOST : process.env.HOST;
      server.listen(port, host, () => {
        console.error(`sanctum-mind: http listening on ${host}:${port} with ${registry.length} verbs`);
      });
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        server.close(() => void pool.end().finally(() => process.exit(0)));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }
    case "stdio": {
      if (!process.env.SANCTUM_BEARER) {
        fail("SANCTUM_BEARER is not set; stdio needs the mind's key (under Docker: set SANCTUM_BEARER in the client's environment and run docker exec -i -e SANCTUM_BEARER <container> node dist/cli.js stdio)");
      }
      defaultCoolingMs();
      const pool = createPool(requireDatabaseUrl());
      await assertRlsEnforced(pool);
      await startStdio({ pool, registry, embedder: embedderFromEnv(process.env), sinks: loadSinks(process.env) }, process.env.SANCTUM_BEARER);
      return;
    }
    case "embed-backfill": {
      const bi = process.argv.indexOf("--batch");
      const batch = bi === -1 ? 64 : Number(process.argv[bi + 1]);
      if (!Number.isInteger(batch) || batch < 1 || batch > 1000) fail("--batch must be an integer from 1 to 1000");
      const embedder = embedderFromEnv(process.env);
      if (embedder.name === "none") fail("no embedder configured (EMBEDDER=none); nothing to backfill");
      const pool = createPool(requireDatabaseUrl());
      try {
        const c = await backfillEmbeddings(pool, embedder, batch);
        console.log(`embedded ${c.events} event(s) and ${c.nodes} node(s) with ${embedder.name}; ${c.skipped} skipped`);
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "daemon": {
      defaultCoolingMs(); // fail fast on a bad IDENTITY_COOLING_HOURS
      const args = argsOrFail(() => parseDaemonArgs(process.argv.slice(3)));
      const minds = args.mind ? [args.mind] : undefined;
      const pool = createPool(requireDatabaseUrl());
      await assertRlsEnforced(pool);
      const embedder = embedderFromEnv(process.env);
      if (args.once) {
        const reports = await runDaemonOnce({ pool, embedder, sinks: loadSinks(process.env) }, { trigger: "manual", ...(minds ? { minds } : {}) });
        for (const r of reports) {
          const failed = r.passes.filter((p) => !p.ok).map((p) => `${p.pass}: ${p.error ?? "failed"}`);
          const changed = r.passes.reduce((n, p) => n + p.changed, 0);
          console.log(`${r.mind_id}: ${r.ok ? "ok" : "FAILED"} (${r.passes.length} passes, ${changed} changes)${failed.length ? "\n  " + failed.join("\n  ") : ""}`);
        }
        await pool.end();
        if (reports.length === 0) {
          console.error(`sanctum-mind: no mind with active access matched${args.mind ? ` "${args.mind}"` : ""}; nothing was run`);
          process.exit(2);
        }
        process.exit(reports.every((r) => r.ok) ? 0 : 2);
      }
      const handle = startDaemon({ pool, embedder, sinks: loadSinks(process.env) }, { intervalMinutes: args.interval, ...(minds ? { minds } : {}) });
      console.error(`sanctum-mind: daemon running every ${args.interval} minute(s)${args.mind ? ` for ${args.mind}` : ""}`);
      let stopping = false;
      const stop = async () => {
        if (stopping) return; // a second signal while stopping must not start a second shutdown
        stopping = true;
        await handle.stop();
        await pool.end();
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      break;
    }
    case "import-revien": {
      const args = argsOrFail(() => parseImportArgs(process.argv.slice(3)));
      const pool = createPool(requireDatabaseUrl());
      try {
        await assertRlsEnforced(pool);
        const found = await pool.query<{ disabled_at: Date | null }>("select disabled_at from minds where mind_id = $1", [args.mind]);
        if (found.rows.length === 0) fail(`mind "${args.mind}" does not exist (create it with init or seed-keys first)`);
        if (found.rows[0]!.disabled_at !== null) fail(`mind "${args.mind}" has access suspended; nothing was imported`);
        const embedder = embedderFromEnv(process.env);
        const report = await importRevien(
          { pool, embedder },
          { mind_id: args.mind, file: args.file, dry_run: args.dryRun, ...(args.sources.length ? { source_filter: args.sources } : {}) },
        );
        console.log(JSON.stringify(report, null, 2));
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "grant": {
      const args = parseGrantArgs(process.argv.slice(3));
      const pool = createPool(requireDatabaseUrl());
      try {
        console.log(await runGrantCommand(pool, args));
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "export-mind": {
      const args = parseExportArgs(process.argv.slice(3));
      const pool = createPool(requireDatabaseUrl());
      await assertRlsEnforced(pool);
      try {
        const r = await exportMind(pool, args.mind, args.out);
        console.log(`exported ${r.mind_id} to ${r.file}: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "import-mind": {
      const args = parseImportMindArgs(process.argv.slice(3));
      const pool = createPool(requireDatabaseUrl());
      await assertRlsEnforced(pool);
      try {
        const r = await importMind(pool, args.file, args.mind, { dry_run: args.dryRun, allow_core: args.allowCore, strict: args.strict, with_letters: args.withLetters });
        console.log(JSON.stringify(r, null, 2));
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "suspend-access":
    case "restore-access":
    case "disable-mind": // deprecated aliases
    case "enable-mind": {
      const alias = DEPRECATED_TOGGLE_ALIASES[cmd];
      if (alias !== undefined) console.error(`sanctum-mind: ${cmd} is deprecated; use ${alias}`);
      const args = argsOrFail(() => parseMindToggleArgs(process.argv.slice(3), cmd as MindToggleCommand));
      const pool = createPool(requireDatabaseUrl());
      try {
        let r;
        try {
          r = await setMindDisabled(pool, args.mind, isSuspendCommand(cmd as MindToggleCommand));
        } catch (e) {
          if (e instanceof ArgError) fail(e.message);
          throw e;
        }
        console.log(formatMindToggle(r, cmd as MindToggleCommand));
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "purge-mind": {
      const args = parsePurgeArgs(process.argv.slice(3));
      const pool = createPool(requireDatabaseUrl());
      try {
        const r = await purgeMind(pool, args.mind, { sever_letters: args.sever_letters, confirm: args.confirm });
        console.log(formatPurge(r));
      } finally {
        await pool.end();
      }
      process.exit(0);
    }
    case "sinks": {
      const sub = process.argv[3];
      const sinks = loadSinks(process.env);
      if (sub === "test") {
        const results = await sinksTest(sinks);
        for (const r of results) console.log(JSON.stringify(r));
        process.exit(results.every((r) => r.ok) ? 0 : 2);
      }
      if (sub === "status") {
        const pool = createPool(requireDatabaseUrl());
        await assertRlsEnforced(pool);
        try {
          for (const r of await sinksStatus(pool, sinks)) console.log(JSON.stringify(r));
        } finally {
          await pool.end();
        }
        process.exit(0);
      }
      if (sub === "requeue") {
        let sinkName: string | undefined;
        try {
          sinkName = parseArgs({ args: process.argv.slice(4), options: { sink: { type: "string" } }, strict: true, allowPositionals: false }).values.sink;
        } catch (e) {
          fail(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\nusage: sanctum-mind sinks requeue --sink <name>`);
        }
        if (sinkName === undefined || sinkName === "") fail("usage: sanctum-mind sinks requeue --sink <name>");
        const pool = createPool(requireDatabaseUrl());
        try {
          const r = await sinksRequeue(pool, sinkName);
          console.log(JSON.stringify({ sink: sinkName, requeued: r.total, minds: r.minds }));
        } finally {
          await pool.end();
        }
        process.exit(0);
      }
      fail("usage: sanctum-mind sinks test|status|requeue");
    }
    default:
      console.error(USAGE);
      process.exit(cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
