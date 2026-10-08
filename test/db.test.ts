import { readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPERSEDED_CHECKSUMS, runMigrations } from "../src/db/migrate.js";
import { withMind } from "../src/db/pool.js";
import { appPool, closePool, resetDatabase, testDatabaseUrl } from "./helpers.js";

let admin: Pool;
let app: Pool;

const insertEvent = (mind: string) =>
  `insert into events (mind_id, kind, payload, written_by, recorded_at)
   values ('${mind}', 'observe', '{}', '${mind}', now()) returning id`;

beforeAll(async () => {
  admin = await resetDatabase();
  app = appPool();
});
afterAll(async () => {
  await closePool(app);
  await closePool(admin);
});

function migrationFiles(): string[] {
  return readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
}

describe("migrations", () => {
  it("are skipped on a second run", async () => {
    const r = await runMigrations(testDatabaseUrl());
    expect(r.applied).toEqual([]);
    expect(r.skipped).toEqual(migrationFiles());
  });

  it("applied exactly once on a fresh database", async () => {
    const { rows } = await admin.query("select filename from schema_migrations order by filename");
    expect(rows).toEqual(migrationFiles().map((filename) => ({ filename })));
  });

  it("throw naming the file when the checksum is tampered", async () => {
    const { rows } = await admin.query("select checksum from schema_migrations where filename = '0001_core.sql'");
    const original = rows[0].checksum;
    await admin.query("update schema_migrations set checksum = 'bogus' where filename = '0001_core.sql'");
    try {
      await expect(runMigrations(testDatabaseUrl())).rejects.toThrow(/0001_core\.sql/);
    } finally {
      await admin.query("update schema_migrations set checksum = $1 where filename = '0001_core.sql'", [original]);
    }
  });

  it("superseded comment-only checksums are repaired; any other mismatch still refuses", async () => {
    const file = "0013_govern.sql";
    const current = (await admin.query("select checksum from schema_migrations where filename = $1", [file])).rows[0].checksum;
    for (const [f, list] of Object.entries(SUPERSEDED_CHECKSUMS)) {
      const now = (await admin.query("select checksum from schema_migrations where filename = $1", [f])).rows[0].checksum;
      expect(list.length, f).toBeGreaterThan(0);
      for (const c of list) expect(c, f).not.toBe(now);
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await admin.query("update schema_migrations set checksum = $2 where filename = $1", [file, SUPERSEDED_CHECKSUMS[file]![0]]);
      const r = await runMigrations(testDatabaseUrl());
      expect(r.applied).toEqual([]);
      expect((await admin.query("select checksum from schema_migrations where filename = $1", [file])).rows[0].checksum).toBe(current);
      expect(log).toHaveBeenCalledWith(`migration ${file}: recorded a superseded comment-only checksum; updated`);
      await admin.query("update schema_migrations set checksum = $2 where filename = $1", [file, "f".repeat(64)]);
      await expect(runMigrations(testDatabaseUrl())).rejects.toThrow(/0013_govern\.sql was already applied but its checksum has changed/);
    } finally {
      log.mockRestore();
      await admin.query("update schema_migrations set checksum = $2 where filename = $1", [file, current]);
    }
  });

  it("throw naming the file when the file on disk changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mig-"));
    await writeFile(path.join(dir, "0099_probe.sql"), "select 1;");
    const first = await runMigrations(testDatabaseUrl(), dir);
    expect(first.applied).toEqual(["0099_probe.sql"]);
    await writeFile(path.join(dir, "0099_probe.sql"), "select 2;");
    await expect(runMigrations(testDatabaseUrl(), dir)).rejects.toThrow(/0099_probe\.sql/);
    await admin.query("delete from schema_migrations where filename = '0099_probe.sql'");
  });
});

describe("events append-only", () => {
  it("rejects UPDATE and DELETE even for a superuser", async () => {
    const { rows } = await admin.query(insertEvent("alpha"));
    await expect(admin.query("update events set kind = 'x' where id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(admin.query("delete from events where id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
  });
});

const count = (tx: PoolClient, table: string) =>
  tx.query(`select count(*)::int as n from ${table}`).then((r) => r.rows[0].n as number);

describe("row level security", () => {
  beforeEach(async () => {
    await admin.query("truncate brain_state, edges, nodes, events cascade");
  });

  it("isolates events between minds", async () => {
    await withMind(app, "alpha", "alpha", "write", (tx) => tx.query(insertEvent("alpha")));
    expect(await withMind(app, "beta", "beta", "write", (tx) => count(tx, "events"))).toBe(0);
    expect(await withMind(app, "alpha", "alpha", "write", (tx) => count(tx, "events"))).toBe(1);
  });

  it("returns nothing with no app.mind_id set", async () => {
    await withMind(app, "alpha", "alpha", "write", (tx) => tx.query(insertEvent("alpha")));
    const { rows } = await app.query("select count(*)::int as n from events");
    expect(rows[0].n).toBe(0);
  });

  it("rejects an insert for another mind via WITH CHECK", async () => {
    await expect(withMind(app, "beta", "beta", "write", (tx) => tx.query(insertEvent("alpha")))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("rolls back and releases the client on throw", async () => {
    await expect(
      withMind(app, "alpha", "alpha", "write", async (tx) => {
        await tx.query(insertEvent("alpha"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await withMind(app, "alpha", "alpha", "write", (tx) => count(tx, "events"))).toBe(0);
  });

  it("rejects an event whose written_by differs from app.bearer", async () => {
    // beta is the bearer, acting on alpha's scope, but forges written_by = alpha
    await expect(
      withMind(app, "alpha", "beta", "write", (tx) =>
        tx.query(
          `insert into events (mind_id, kind, payload, written_by, recorded_at)
           values ('alpha', 'observe', '{}', 'alpha', now())`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // an honest written_by = bearer is accepted by the policy (grants are mayAct's job)
    await withMind(app, "alpha", "beta", "write", (tx) =>
      tx.query(
        `insert into events (mind_id, kind, payload, written_by, recorded_at)
         values ('alpha', 'observe', '{}', 'beta', now())`,
      ),
    );
    expect(await withMind(app, "alpha", "alpha", "write", (tx) => count(tx, "events"))).toBe(1);
  });

  it("refuses any write in a read-mode transaction", async () => {
    await expect(
      withMind(app, "alpha", "beta", "read", (tx) =>
        tx.query(
          `insert into events (mind_id, kind, payload, written_by, recorded_at)
           values ('alpha', 'observe', '{}', 'beta', now())`,
        ),
      ),
    ).rejects.toThrow(/read-only transaction/);
    // a read-mode transaction can still read
    expect(await withMind(app, "alpha", "beta", "read", (tx) => count(tx, "events"))).toBe(0);
  });

  const insertNode = (mind: string, by: string) =>
    `insert into nodes (mind_id, node_type, label, content, written_by) values ('${mind}', 't', 'l', 'c', '${by}') returning id`;

  it("isolates nodes and edges and checks their mind and author", async () => {
    const ids = await withMind(app, "alpha", "alpha", "write", async (tx) => {
      const a = (await tx.query(insertNode("alpha", "alpha"))).rows[0].id;
      const b = (await tx.query(insertNode("alpha", "alpha"))).rows[0].id;
      await tx.query(
        `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'r', 'alpha', $1, $2)`,
        [a, b],
      );
      return [a, b];
    });
    expect(await withMind(app, "beta", "beta", "write", (tx) => count(tx, "nodes"))).toBe(0);
    expect(await withMind(app, "beta", "beta", "write", (tx) => count(tx, "edges"))).toBe(0);
    expect(await withMind(app, "alpha", "alpha", "write", (tx) => count(tx, "nodes"))).toBe(2);
    expect(await withMind(app, "alpha", "alpha", "write", (tx) => count(tx, "edges"))).toBe(1);
    // wrong mind
    await expect(withMind(app, "beta", "beta", "write", (tx) => tx.query(insertNode("alpha", "beta")))).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      withMind(app, "beta", "beta", "write", (tx) =>
        tx.query(
          `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'r', 'beta', $1, $2)`,
          ids,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // forged author
    await expect(withMind(app, "alpha", "beta", "write", (tx) => tx.query(insertNode("alpha", "alpha")))).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      withMind(app, "alpha", "beta", "write", (tx) =>
        tx.query(
          `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'r', 'alpha', $1, $2)`,
          ids,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("isolates brain_state between minds", async () => {
    const ev = await withMind(app, "alpha", "alpha", "write", async (tx) => {
      const id = (await tx.query(insertEvent("alpha"))).rows[0].id;
      await tx.query(
        `insert into brain_state (mind_id, mood, last_event_id, updated_at) values ('alpha', 'calm', $1, now())`,
        [id],
      );
      return id;
    });
    expect(await withMind(app, "beta", "beta", "write", (tx) => count(tx, "brain_state"))).toBe(0);
    expect(await withMind(app, "alpha", "alpha", "write", (tx) => count(tx, "brain_state"))).toBe(1);
    await expect(
      withMind(app, "beta", "beta", "write", (tx) =>
        tx.query(
          `insert into brain_state (mind_id, mood, last_event_id, updated_at) values ('alpha', 'x', $1, now())`,
          [ev],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // an update under the wrong mind touches zero rows
    const upd = await withMind(app, "beta", "beta", "write", (tx) =>
      tx.query(`update brain_state set mood = 'hijack' where mind_id = 'alpha'`),
    );
    expect(upd.rowCount).toBe(0);
  });
});

describe("integrity constraints (0005)", () => {
  const nodeSql = (mind: string) =>
    `insert into nodes (mind_id, node_type, label, content, written_by) values ('${mind}', 'observation', 'l', 'c', '${mind}') returning id`;
  const edgeSql = `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ($1, 'related_to', $2, $3, $4)`;

  beforeEach(async () => {
    await admin.query("truncate brain_state, edges, nodes, events cascade");
  });

  it("rejects an edge from a beta node to an alpha node with a foreign key violation", async () => {
    const a = (await withMind(app, "alpha", "alpha", "write", (tx) => tx.query(nodeSql("alpha")))).rows[0].id;
    const b = (await withMind(app, "beta", "beta", "write", (tx) => tx.query(nodeSql("beta")))).rows[0].id;
    await expect(
      withMind(app, "beta", "beta", "write", (tx) => tx.query(edgeSql, ["beta", "beta", b, a])),
    ).rejects.toMatchObject({ code: "23503", constraint: "edges_target_same_mind" });
    await expect(
      withMind(app, "beta", "beta", "write", (tx) => tx.query(edgeSql, ["beta", "beta", a, b])),
    ).rejects.toMatchObject({ code: "23503", constraint: "edges_source_same_mind" });
    const b2 = (await withMind(app, "beta", "beta", "write", (tx) => tx.query(nodeSql("beta")))).rows[0].id;
    await withMind(app, "beta", "beta", "write", (tx) => tx.query(edgeSql, ["beta", "beta", b, b2]));
  });

  it("rejects event_time_end before event_time_start on events and nodes", async () => {
    await expect(
      withMind(app, "alpha", "alpha", "write", (tx) =>
        tx.query(
          `insert into events (mind_id, kind, payload, written_by, recorded_at, event_time_start, event_time_end)
           values ('alpha', 'write', '{}', 'alpha', now(), '2026-01-02', '2026-01-01')`,
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "events_event_time_order" });
    await expect(
      withMind(app, "alpha", "alpha", "write", (tx) =>
        tx.query(
          `insert into nodes (mind_id, node_type, label, content, written_by, event_time_start, event_time_end)
           values ('alpha', 'observation', 'l', 'c', 'alpha', '2026-01-02', '2026-01-01')`,
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "nodes_event_time_order" });
  });
});

describe("role privileges", () => {
  it("the app role cannot write grants or minds", async () => {
    await expect(
      app.query("insert into grants (grantor_mind, grantee_mind, scope) values ('beta', 'alpha', 'write')"),
    ).rejects.toThrow(/permission denied/);
    await expect(app.query("update grants set scope = 'write'")).rejects.toThrow(/permission denied/);
    await expect(app.query("update minds set key_hash = 'x'")).rejects.toThrow(/permission denied/);
    await expect(app.query("insert into minds (mind_id, key_hash) values ('evil', 'h')")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("the app role cannot delete anywhere", async () => {
    for (const t of ["events", "nodes", "edges", "brain_state", "minds", "grants"]) {
      await expect(app.query(`delete from ${t}`)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("pool errors", () => {
  it("an idle client killed by the server does not crash the process", async () => {
    const pool = appPool();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await pool.query("select 1"); // leaves one idle client
      const killed = await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'sanctum-test-app' and pid <> pg_backend_pid()",
      );
      expect(killed.rowCount).toBeGreaterThan(0);
      await new Promise((r) => setTimeout(r, 300));
      expect((await pool.query("select 1 as n")).rows[0].n).toBe(1);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("idle client error"))).toBe(true);
    } finally {
      spy.mockRestore();
      await closePool(pool);
    }
  });
});

describe("assertRlsEnforced", () => {
  it("refuses a superuser connection and accepts the app role", async () => {
    const { assertRlsEnforced } = await import("../src/db/pool.js");
    const admin = await resetDatabase();
    await expect(assertRlsEnforced(admin)).rejects.toThrow(/BYPASSRLS|superuser/);
    await closePool(admin);
    const app = appPool();
    await expect(assertRlsEnforced(app)).resolves.toBeUndefined();
    await closePool(app);
  });
});
