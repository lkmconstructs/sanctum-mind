// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, closePool, appPool } from "./helpers.js";
import { resolveCaller } from "../src/auth.js";
import { addGrant, listGrants, parseGrantArgs, revokeGrant, runGrantCommand } from "../src/grants-admin.js";

let admin: Pool;

beforeEach(async () => {
  if (admin) await closePool(admin);
  admin = await resetDatabase(); // alpha -> beta read is pre-seeded
});

afterAll(async () => {
  if (admin) await closePool(admin);
});

describe("grants admin", () => {
  it("adds a grant, is idempotent, and the grantee resolves it", async () => {
    const a = await addGrant(admin, "alpha", "beta", "steward");
    expect(a.status).toBe("created");
    const b = await addGrant(admin, "alpha", "beta", "steward");
    expect(b.status).toBe("exists");
    expect(b.grant.id).toBe(a.grant.id);
    const live = await admin.query("select 1 from grants where scope = 'steward' and revoked_at is null");
    expect(live.rowCount).toBe(1);
    const app = appPool();
    try {
      const { TEST_KEYS } = await import("./helpers.js");
      const caller = await resolveCaller(app, TEST_KEYS.beta);
      expect(caller?.grants.alpha).toContain("steward");
    } finally {
      await closePool(app);
    }
  });

  it("concurrent adds of the same grant produce exactly one live row (advisory lock)", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => addGrant(admin, "beta", "alpha", "steward")));
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.status === "exists")).toHaveLength(7);
    expect(new Set(results.map((r) => r.grant.id)).size).toBe(1);
    const live = await admin.query("select 1 from grants where grantor_mind = 'beta' and grantee_mind = 'alpha' and scope = 'steward' and revoked_at is null");
    expect(live.rowCount).toBe(1);
  });

  it("add serialises on the per-grant advisory lock: it waits while the lock is held elsewhere", async () => {
    const holder = await admin.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext($1))", ["grant:beta:alpha:letter"]);
      let done = false;
      const pending = addGrant(admin, "beta", "alpha", "letter").then((r) => ((done = true), r));
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
      expect((await admin.query("select 1 from grants where scope = 'letter'")).rowCount).toBe(0);
      await holder.query("commit");
      expect((await pending).status).toBe("created");
    } finally {
      holder.release();
    }
  });

  it("revokes, then revoke is a no-op, and re-add creates a fresh grant", async () => {
    expect((await revokeGrant(admin, "alpha", "beta", "read")).status).toBe("revoked");
    expect(await revokeGrant(admin, "alpha", "beta", "read")).toEqual({ status: "none", revoked: 0 });
    expect(await listGrants(admin)).toEqual([]);
    expect((await addGrant(admin, "alpha", "beta", "read")).status).toBe("created");
  });

  it("lists live grants, optionally by mind", async () => {
    await addGrant(admin, "beta", "alpha", "letter");
    expect((await listGrants(admin)).map((g) => `${g.grantor_mind}>${g.grantee_mind}:${g.scope}`)).toEqual(["alpha>beta:read", "beta>alpha:letter"]);
    await admin.query("insert into minds (mind_id, key_hash) values ('gamma', 'x')");
    await addGrant(admin, "gamma", "beta", "read");
    expect(await listGrants(admin, "gamma")).toHaveLength(1);
    expect(await listGrants(admin, "alpha")).toHaveLength(2);
    expect(await listGrants(admin, "nobody")).toEqual([]);
  });

  it("refuses unknown or disabled minds and invalid scopes", async () => {
    await expect(addGrant(admin, "alpha", "ghost", "read")).rejects.toThrow(/unknown mind "ghost"/);
    await admin.query("update minds set disabled_at = now() where mind_id = 'beta'");
    await expect(addGrant(admin, "alpha", "beta", "write")).rejects.toThrow(/disabled/);
    await expect(addGrant(admin, "alpha", "alpha", "admin")).rejects.toThrow(/invalid scope/);
    await expect(revokeGrant(admin, "alpha", "beta", "root")).rejects.toThrow(/invalid scope/);
  });

  it("parses arguments strictly", () => {
    expect(parseGrantArgs(["add", "--from", "alpha", "--to", "beta", "--scope", "steward", "--json"])).toEqual({
      action: "add", from: "alpha", to: "beta", scope: "steward", json: true,
    });
    expect(parseGrantArgs(["list"])).toEqual({ action: "list", json: false });
    expect(parseGrantArgs(["list", "--mind", "alpha"]).mind).toBe("alpha");
    expect(() => parseGrantArgs([])).toThrow(/subcommand/);
    expect(() => parseGrantArgs(["add", "--from", "alpha", "--to", "beta"])).toThrow(/--scope is required/);
    expect(() => parseGrantArgs(["add", "--from", "alpha", "--to", "beta", "--scope", "x"])).toThrow(/invalid scope/);
    expect(() => parseGrantArgs(["add", "--from", "a b", "--to", "beta", "--scope", "read"])).toThrow(/invalid mind_id/);
    expect(() => parseGrantArgs(["list", "--bogus"])).toThrow();
    expect(() => parseGrantArgs(["revoke", "--mind", "alpha"])).toThrow();
  });

  it("renders a table and json", async () => {
    const text = await runGrantCommand(admin, parseGrantArgs(["list"]));
    expect(text).toMatch(/^FROM\s+TO\s+SCOPE/);
    expect(text).toContain("alpha");
    const json = JSON.parse(await runGrantCommand(admin, parseGrantArgs(["list", "--json"])));
    expect(json.grants).toHaveLength(1);
    expect(await runGrantCommand(admin, parseGrantArgs(["add", "--from", "alpha", "--to", "beta", "--scope", "read"]))).toMatch(/already granted/);
  });
});
