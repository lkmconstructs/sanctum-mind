// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { appPool, closePool, lanePool, laneUrl, queryAs, resetDatabase, testAppUrl, testLaneRole } from "./helpers.js";
import { assertRlsEnforced, createPool, withMind } from "../src/db/pool.js";
import { classifyRole, judgeLane, LANES, LANE_ROLES, laneMismatch, LaneError, laneRole, requireLane } from "../src/db/lanes.js";
import type { Actor } from "../src/db/lanes.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { addGrant, listGrants, revokeGrant } from "../src/grants-admin.js";
import { extractorReport, repairBackfill, setExtractorState } from "../src/extractor-admin.js";

let admin: Pool;
let legacy: Pool;
const lanes = {} as Record<Actor, Pool>;

beforeAll(async () => {
  admin = await resetDatabase();
  legacy = appPool();
  for (const lane of LANES) lanes[lane] = lanePool(lane);
});

afterAll(async () => {
  for (const lane of LANES) if (lanes[lane]) await closePool(lanes[lane]);
  if (legacy) await closePool(legacy);
  if (admin) await closePool(admin);
});

/** One statement in a transaction carrying the three settings by hand, the way withMind sets them (actor may be "" for none). */
async function inTx(db: Pool, mind: string, bearer: string, actor: string, sql: string, params: unknown[] = []) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.mind_id', $1, true), set_config('app.bearer', $2, true), set_config('app.actor', $3, true)", [mind, bearer, actor]);
    const r = await client.query(sql, params);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const actorOn = async (db: Pool, setting: string): Promise<string | null> =>
  (await inTx(db, "alpha", "alpha", setting, "select sanctum_actor() as a")).rows[0].a;

// ---- seeding, as the mind itself on the legacy lane (these inserts do not depend on the actor) ----

async function mkEvent(kind: string, payload: object = {}, subject: string | null = null, mind = "alpha"): Promise<string> {
  const r = await queryAs(
    legacy, mind, mind,
    `insert into events (mind_id, kind, payload, subject_id, written_by, recorded_at) values ($1, $2, $3::jsonb, $4, $1, now()) returning id`,
    [mind, kind, JSON.stringify(payload), subject],
  );
  return r.rows[0].id;
}
async function mkNode(content: string, mind = "alpha"): Promise<string> {
  const r = await queryAs(
    legacy, mind, mind,
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence) values ($1, 'observation', $2, $2, $1, 'extracted', 1.0) returning id`,
    [mind, content],
  );
  return r.rows[0].id;
}
async function mkNoticing(sources: string[], mind = "alpha"): Promise<string> {
  const ev = await mkEvent("notice.proposed", { kind: "link" }, null, mind);
  const r = await queryAs(
    legacy, mind, mind,
    `insert into noticings (mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at)
     values ($1, 'link', $2::uuid[], '{"edge_type":"related_to","reason":"r"}'::jsonb, 0.5, '{}', 0, 'propose', 'pending', $3, now() + interval '14 days') returning id`,
    [mind, sources, ev],
  );
  return r.rows[0].id;
}
const decide = async (db: Pool, setting: string, id: string, status: "accepted" | "rejected" | "expired", bearer = "alpha") => {
  const ev = await mkEvent(`notice.${status}`, {}, id);
  return inTx(db, "alpha", bearer, setting, `update noticings set status = $2, decided_event_id = $3, decided_at = now() where id = $1`, [id, status, ev]);
};
async function pinOn(db: Pool, setting: string, itemId: string): Promise<void> {
  const pin = randomUUID();
  const ev = await mkEvent("attend.pin", { item_type: "node", item_id: itemId, pin_id: pin }, itemId);
  await inTx(db, "alpha", "alpha", setting,
    `insert into attention_pins (id, mind_id, item_type, item_id, pinned_event_id, pinned_at) values ($1, 'alpha', 'node', $2, $3, now())`, [pin, itemId, ev]);
}

describe("the lane roles (migration 0026)", () => {
  it("the real lane roles are members of sanctum_app and never given a login by the suite; the test logins sit on the lanes by direct membership", async () => {
    for (const lane of LANES) {
      const r = await admin.query("select rolsuper, rolbypassrls from pg_roles where rolname = $1", [laneRole(lane)]);
      expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const m = await admin.query("select 1 from pg_auth_members where roleid = 'sanctum_app'::regrole and member = $1::regrole", [laneRole(lane)]);
      expect(m.rowCount).toBe(1);
      // the stand-in login: a direct member of its lane role and of sanctum_app, plain, able to log in
      const t = await admin.query("select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = $1", [testLaneRole(lane)]);
      expect(t.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: true });
      const direct = await admin.query("select 1 from pg_auth_members where roleid = $1::regrole and member = $2::regrole", [laneRole(lane), testLaneRole(lane)]);
      expect(direct.rowCount).toBe(1);
      await expect(assertRlsEnforced(lanes[lane])).resolves.toBeUndefined();
    }
  });

  it("a login that is a direct member of two lane roles, or of none, is on no lane (legacy rules)", async () => {
    await admin.query("create role sanctum_test_both login password 'x'");
    try {
      await admin.query("grant sanctum_verb to sanctum_test_both; grant sanctum_daemon to sanctum_test_both; grant sanctum_app to sanctum_test_both");
      const u = new URL(laneUrl("verb"));
      u.username = "sanctum_test_both";
      u.password = "x";
      const both = createPool(u.toString());
      try {
        expect((await inTx(both, "alpha", "alpha", "daemon", "select sanctum_lane() l, sanctum_actor() a")).rows[0]).toEqual({ l: null, a: "daemon" });
      } finally {
        await closePool(both);
      }
      // inheriting through sanctum_app is not a direct membership of a lane
      expect((await inTx(legacy, "alpha", "alpha", "verb", "select sanctum_lane() l")).rows[0].l).toBeNull();
    } finally {
      await admin.query("drop owned by sanctum_test_both; drop role sanctum_test_both");
    }
  });

  it("find every row level security policy applying to public, so membership in sanctum_app is enough", async () => {
    const named = await admin.query("select polname from pg_policy where polroles <> '{0}'::oid[]");
    expect(named.rows).toEqual([]);
  });

  it("each lane is confined by row level security to the mind it selected", async () => {
    await mkEvent("observe", { n: 1 }, null, "alpha");
    await mkEvent("observe", { n: 2 }, null, "beta");
    for (const lane of LANES) {
      const mine = (s: string) => inTx(lanes[lane], s, s, "", "select distinct mind_id from events").then((r) => r.rows.map((x) => x.mind_id));
      expect(await mine("alpha")).toEqual(["alpha"]);
      expect(await mine("beta")).toEqual(["beta"]);
      expect((await inTx(lanes[lane], "", "", "", "select count(*)::int n from events")).rows[0].n).toBe(0);
      // and cannot write another mind's rows
      await expect(inTx(lanes[lane], "alpha", "alpha", "", `insert into events (mind_id, kind, payload, written_by, recorded_at) values ('beta', 'x', '{}', 'beta', now())`)).rejects.toThrow();
    }
  });
});

describe("sanctum_actor()", () => {
  it("returns the lane for each lane role, whatever app.actor says", async () => {
    for (const lane of LANES) {
      for (const setting of ["", "verb", "daemon", "operator", "import", "nonsense"]) expect(await actorOn(lanes[lane], setting)).toBe(lane);
    }
  });

  it("returns the setting for the legacy shared lane and for the admin connection (the old behaviour)", async () => {
    // sanctum_test_app is a member of sanctum_app like the production sanctum_app login: any role but a lane takes the setting
    for (const db of [legacy, admin]) {
      expect(await actorOn(db, "daemon")).toBe("daemon");
      expect(await actorOn(db, "verb")).toBe("verb");
      expect(await actorOn(db, "")).toBeNull();
    }
  });

  it("is derived from session_user: set role sanctum_app inside a lane changes nothing", async () => {
    for (const lane of LANES) {
      const c = await lanes[lane].connect();
      try {
        await c.query("begin");
        await c.query("select set_config('app.actor', 'daemon', true)");
        await c.query("set local role sanctum_app");
        expect((await c.query("select current_user::text u, session_user::text s, sanctum_actor() a")).rows[0]).toEqual({ u: "sanctum_app", s: testLaneRole(lane), a: lane });
        await c.query("rollback");
      } finally {
        c.release();
      }
    }
  });

  it("is security definer, stable, with a fixed search_path, executable by sanctum_app and not by public", async () => {
    const r = await admin.query(
      `select p.prosecdef, p.provolatile, p.proconfig, has_function_privilege('sanctum_app', p.oid, 'execute') app_ok,
              has_function_privilege('public', p.oid, 'execute') public_ok
         from pg_proc p where proname = 'sanctum_actor'`,
    );
    const lane = await admin.query("select p.prosecdef, p.provolatile, p.proconfig from pg_proc p where proname = 'sanctum_lane'");
    expect(lane.rows[0]).toEqual({ prosecdef: true, provolatile: "s", proconfig: ["search_path=pg_catalog, pg_temp"] });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ prosecdef: true, provolatile: "s", app_ok: true, public_ok: false });
    expect(r.rows[0].proconfig).toEqual(["search_path=pg_catalog, pg_temp"]); // pg_temp last, public not at all
  });

  it("is the only function whose live body reads current_setting('app.actor'); every guard reads sanctum_actor()", async () => {
    const readers = await admin.query("select proname from pg_proc where prosrc like '%app.actor%' order by proname");
    expect(readers.rows.map((r) => r.proname)).toEqual(["sanctum_actor"]);
    const raw = await admin.query("select proname from pg_proc where prosrc like '%current_setting(''app.actor''%' order by proname");
    expect(raw.rows.map((r) => r.proname)).toEqual(["sanctum_actor"]);
    for (const guard of ["attention_pins_guard", "extractor_state_guard", "noticings_decision_guard", "repair_work_guard"]) {
      const body = (await admin.query("select prosrc from pg_proc where proname = $1", [guard])).rows[0].prosrc as string;
      expect(body).toContain("sanctum_actor()");
    }
  });
});

describe("the guards under the lanes", () => {
  it("a verb-lane connection with app.actor = 'daemon' set by hand is still verb, and cannot expire a noticing", async () => {
    const a = await mkNode("a1");
    const n = await mkNoticing([a]);
    await expect(decide(lanes.verb, "daemon", n, "expired")).rejects.toThrow(/only the mind's own daemon expires/);
    await expect(decide(lanes.operator, "daemon", n, "expired")).rejects.toThrow(/only the mind's own daemon expires/);
    // the daemon lane and the import lane can, with the setting empty or anything else
    await decide(lanes.daemon, "", n, "expired");
    const n2 = await mkNoticing([a]);
    await decide(lanes.import, "verb", n2, "expired");
    expect((await admin.query("select status from noticings where id = any($1::uuid[]) order by status", [[n, n2]])).rows.map((r) => r.status)).toEqual(["expired", "expired"]);
  });

  it("a daemon-lane connection with app.actor = 'verb' set by hand (the claim from SECURITY) cannot accept a noticing or place a pin", async () => {
    const a = await mkNode("a2");
    const n = await mkNoticing([a]);
    await expect(decide(lanes.daemon, "verb", n, "accepted")).rejects.toThrow(/only the mind decides/);
    await expect(decide(lanes.daemon, "verb", n, "rejected")).rejects.toThrow(/only the mind decides/);
    await expect(pinOn(lanes.daemon, "verb", a)).rejects.toThrow(/attention is directed by the mind/);
    await expect(pinOn(lanes.operator, "verb", a)).rejects.toThrow(/attention is directed by the mind/);
    expect((await admin.query("select status from noticings where id = $1", [n])).rows[0].status).toBe("pending");
    expect((await admin.query("select count(*)::int c from attention_pins")).rows[0].c).toBe(0);
    // the verb lane does both
    await pinOn(lanes.verb, "", a);
    await decide(lanes.verb, "daemon", n, "accepted");
    expect((await admin.query("select status from noticings where id = $1", [n])).rows[0].status).toBe("accepted");
  });

  it("the import lane can place a pin (an import brings pins in) but cannot act as the daemon on repair work", async () => {
    const a = await mkNode("a3");
    await pinOn(lanes.import, "daemon", a);
    const dead = await mkNode("dead");
    await queryAs(legacy, "alpha", "alpha", "update nodes set invalidated_at = now() where id = $1", [dead]);
    const ev = await mkEvent("rethink");
    const ins = `insert into repair_work (mind_id, upstream_id, upstream_state, created_event_id) values ('alpha', $1, 'retired', $2) returning id`;
    // import is not among the actors that record repair work
    await expect(inTx(lanes.import, "alpha", "alpha", "daemon", ins, [dead, ev])).rejects.toThrow(/own scope/);
    const w = (await inTx(lanes.verb, "alpha", "alpha", "", ins, [dead, ev])).rows[0].id;
    const upd = "update repair_work set next_offset = 1, claimed_at = now() where id = $1";
    await expect(inTx(lanes.import, "alpha", "alpha", "daemon", upd, [w])).rejects.toThrow(/only the mind's own daemon/);
    await expect(inTx(lanes.verb, "alpha", "alpha", "daemon", upd, [w])).rejects.toThrow(/only the mind's own daemon/);
    await inTx(lanes.daemon, "alpha", "alpha", "verb", upd, [w]);
    expect((await admin.query("select next_offset from repair_work where id = $1", [w])).rows[0].next_offset).toBe(1);
  });

  it("only the operator lane enables the extractor, whatever the other lanes set", async () => {
    const ins = "insert into extractor_state (mind_id, enabled, stage) values ('beta', true, 'shadow')";
    for (const lane of ["verb", "daemon", "import"] as const) {
      await expect(inTx(lanes[lane], "beta", "beta", "operator", ins)).rejects.toThrow(/only the operator enables the extractor/);
    }
    await inTx(lanes.operator, "beta", "beta", "", ins);
    expect((await admin.query("select enabled from extractor_state where mind_id = 'beta'")).rows[0].enabled).toBe(true);
    await admin.query("delete from extractor_state");
  });

  it("the legacy shared lane still can claim any actor, exactly as before 0026 (documented in SECURITY)", async () => {
    const a = await mkNode("a4");
    const n = await mkNoticing([a]);
    await decide(legacy, "verb", n, "accepted"); // a legacy client may claim to be the verb
    expect((await admin.query("select status from noticings where id = $1", [n])).rows[0].status).toBe("accepted");
    await pinOn(legacy, "verb", a);
    await expect(inTx(legacy, "beta", "beta", "operator", "insert into extractor_state (mind_id, enabled, stage) values ('beta', true, 'shadow')")).resolves.toBeTruthy();
    await admin.query("delete from extractor_state");
  });
});

describe("inserts by lane (sanctum_lane())", () => {
  it("sanctum_lane() answers the lane for a lane login and null for the legacy lane and admin", async () => {
    for (const lane of LANES) expect((await inTx(lanes[lane], "alpha", "alpha", "daemon", "select sanctum_lane() as l")).rows[0].l).toBe(lane);
    for (const db of [legacy, admin]) expect((await inTx(db, "alpha", "alpha", "daemon", "select sanctum_lane() as l")).rows[0].l).toBeNull();
  });

  const propose = async (db: Pool, setting: string, bearer = "alpha") => {
    const ev = await mkEvent("identity.propose", {});
    return inTx(db, "alpha", bearer, setting,
      `insert into proposals (mind_id, kind, section, content, proposed_by, event_id, status, created_at)
       values ('alpha', 'identity', 'who', 'I am', 'alpha', $1, 'pending', now()) returning id`, [ev]);
  };
  const notice = async (db: Pool, setting: string, sources: string[]) => {
    const ev = await mkEvent("notice.proposed", { kind: "link" });
    return inTx(db, "alpha", "alpha", setting,
      `insert into noticings (mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at)
       values ('alpha', 'link', $1::uuid[], '{"edge_type":"related_to","reason":"r"}'::jsonb, 0.5, '{}', 0, 'propose', 'pending', $2, now() + interval '14 days') returning id`,
      [sources, ev]);
  };

  it("the daemon lane with the bearer and actor 'verb' set by hand cannot declare an identity proposal or place a pin", async () => {
    const a = await mkNode("lane-a");
    await expect(propose(lanes.daemon, "verb")).rejects.toThrow(/declared by the mind through a verb/);
    await expect(propose(lanes.operator, "verb")).rejects.toThrow(/declared by the mind through a verb/);
    await expect(pinOn(lanes.daemon, "verb", a)).rejects.toThrow(/attention is directed by the mind/);
    // the bearer and scope checks still apply on the verb lane
    await expect(propose(lanes.verb, "", "beta")).rejects.toThrow(/declared by the mind itself/);
    await expect(propose(lanes.verb, "daemon")).resolves.toBeTruthy(); // the lane decides, not the setting
  });

  it("the verb lane cannot insert a noticing; the daemon lane can", async () => {
    const a = await mkNode("lane-b");
    await expect(notice(lanes.verb, "daemon", [a])).rejects.toThrow(/proposed by the daemon or an import/);
    await expect(notice(lanes.operator, "daemon", [a])).rejects.toThrow(/proposed by the daemon or an import/);
    await expect(notice(lanes.daemon, "verb", [a])).resolves.toBeTruthy();
  });

  it("the import lane can insert proposals and noticings (an import's shape) but cannot decide a noticing", async () => {
    const a = await mkNode("lane-c");
    await expect(propose(lanes.import, "")).resolves.toBeTruthy();
    const n = (await notice(lanes.import, "", [a])).rows[0].id;
    await expect(decide(lanes.import, "verb", n, "accepted")).rejects.toThrow(/only the mind decides/);
    await expect(decide(lanes.import, "", n, "rejected")).rejects.toThrow(/only the mind decides/);
  });

  it("the legacy lane and admin are unchanged: any actor setting may insert a proposal or a noticing", async () => {
    const a = await mkNode("lane-d");
    for (const db of [legacy, admin]) {
      for (const setting of ["", "daemon", "verb"]) {
        await expect(propose(db, setting)).resolves.toBeTruthy();
        await expect(notice(db, setting, [a])).resolves.toBeTruthy();
      }
    }
    // (repair_work and attention_pins already refuse by actor on insert, and the actor is now the lane: see the tests above)
  });
});

describe("identity on the lanes (nodes_core_guard, proposals_update_guard)", () => {
  const MSG = /identity is settled only from the mind's own declaration/;
  const alpha = { bearer: "alpha", grants: {} };
  // verbs run on the legacy pool; cooling 0 makes a declaration due at once, 24 hours makes it not due
  const verb = (name: string, input: Record<string, unknown>, coolingMs = 0) =>
    runVerb({ pool: legacy, registry, now: () => new Date(), coolingMs }, alpha, name, { mind_id: "alpha", ...input }) as Promise<any>;
  const core = async (content = "old self") => (await verb("mind_identity", { operation: "affirm", section: "core", content })).receipt.projection.node_id as string;
  const declare = async (target: string, coolingMs: number, content = "new self") => {
    const r = await verb("mind_identity", { operation: "propose", section: "core", content, lineage_note: "grew", target_node_id: target }, coolingMs);
    expect(r.ok).toBe(true);
    return r.receipt.projection.proposal as { id: string };
  };
  const insertCore = (db: Pool, setting: string, content: string, type = "identity", label = "core") =>
    inTx(db, "alpha", "alpha", setting, `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence)
                                          values ('alpha', $2, $3, $1, 'alpha', 'extracted', 1.0) returning id`, [content, type, label]);
  const settleOn = async (db: Pool) => {
    const reports = await runDaemonOnce({ pool: db, embedder: NONE_EMBEDDER, coolingMs: 0 }, { trigger: "manual", minds: ["alpha"] });
    return reports[0]!.passes.find((p) => p.pass === "identity.settle")!;
  };
  const withSettling = async (db: Pool, id: string, sql: string, params: unknown[] = []) => {
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.mind_id', 'alpha', true), set_config('app.bearer', 'alpha', true), set_config('app.settling', $1, true)", [id]);
      const r = await c.query(sql, params);
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };

  it("the daemon lane cannot insert an identity or vow node, update a core, or rewrite an open declaration", async () => {
    const id = await core();
    const p = await declare(id, 24 * 3_600_000);
    await expect(insertCore(lanes.daemon, "verb", "forged self")).rejects.toThrow(MSG);
    await expect(insertCore(lanes.daemon, "", "forged vow", "vow")).rejects.toThrow(MSG);
    await expect(inTx(lanes.daemon, "alpha", "alpha", "verb", "update nodes set content = 'rewritten' where id = $1", [id])).rejects.toThrow(MSG);
    await expect(inTx(lanes.daemon, "alpha", "alpha", "verb", "update nodes set invalidated_at = now() where id = $1", [id])).rejects.toThrow(MSG);
    await expect(inTx(lanes.daemon, "alpha", "alpha", "", "update proposals set content = 'forged' where id = $1", [p.id])).rejects.toThrow(/only the mind changes its declaration/);
    await expect(inTx(lanes.daemon, "alpha", "alpha", "", "update proposals set effective_at = now() where id = $1", [p.id])).rejects.toThrow(/only the mind changes its declaration/);
    await expect(inTx(lanes.daemon, "alpha", "alpha", "", "update proposals set status = 'withdrawn', withdrawn_at = now() where id = $1", [p.id])).rejects.toThrow(/only the mind changes its declaration/);
    // settling a declaration that is not yet due is refused too (status only, no time/event: also refused)
    await expect(inTx(lanes.daemon, "alpha", "alpha", "", "update proposals set status = 'settled' where id = $1", [p.id])).rejects.toThrow(/only the mind changes its declaration/);
    // bookkeeping the daemon does on a core (a vector) is not an identity write
    await inTx(lanes.daemon, "alpha", "alpha", "", "update nodes set embedding_model = 'm' where id = $1", [id]);
    expect((await admin.query("select content from nodes where id = $1", [id])).rows[0].content).toBe("old self");
  });

  it("the operator lane never writes identity or declarations", async () => {
    const id = await core();
    const p = await declare(id, 24 * 3_600_000);
    await expect(insertCore(lanes.operator, "verb", "x")).rejects.toThrow(MSG);
    await expect(inTx(lanes.operator, "alpha", "alpha", "operator", "update nodes set invalidated_at = now() where id = $1", [id])).rejects.toThrow(MSG);
    await expect(inTx(lanes.operator, "alpha", "alpha", "operator", "update proposals set attestations = attestations where id = $1", [p.id])).rejects.toThrow(/only the mind changes its declaration/);
  });

  it("the verb and import lanes keep writing identity (and the bearer rule of 0018 still holds)", async () => {
    await expect(insertCore(lanes.verb, "", "a self")).resolves.toBeTruthy();
    await expect(insertCore(lanes.import, "", "an imported self")).resolves.toBeTruthy();
    const id = (await insertCore(lanes.verb, "", "mine")).rows[0].id;
    await expect(inTx(lanes.verb, "alpha", "alpha", "", "update nodes set content = 'revised' where id = $1", [id])).resolves.toBeTruthy();
    await expect(inTx(lanes.verb, "alpha", "beta", "", "update nodes set content = 'by a grantee' where id = $1", [id])).rejects.toThrow(/identity belongs to the mind/);
  });

  it("the daemon lane settles a due rewrite end to end: the new node equals the declaration, the old one is superseded", async () => {
    const id = await core("old self");
    const p = await declare(id, 0, "the new self");
    const r = await settleOn(lanes.daemon);
    expect(r).toMatchObject({ ok: true, changed: 1 });
    const sup = (await admin.query("select n.id, n.content, n.invalidated_at is null as live from nodes o join nodes n on n.id = o.superseded_by where o.id = $1", [id])).rows;
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ content: "the new self", live: true });
    expect((await admin.query("select status, settled_at is not null as t, settled_event_id is not null as e from proposals where id = $1", [p.id])).rows[0]).toEqual({ status: "settled", t: true, e: true });
  });

  it("the daemon lane settles a due retirement end to end", async () => {
    const id = await core("to retire");
    const r = await verb("mind_identity", { operation: "retire", section: "core", lineage_note: "done", target_node_id: id }, 0);
    expect(r.ok).toBe(true);
    expect(await settleOn(lanes.daemon)).toMatchObject({ ok: true, changed: 1 });
    expect((await admin.query("select invalidated_at is not null as gone from nodes where id = $1", [id])).rows[0].gone).toBe(true);
  });

  it("the daemon lane settles a due vow break end to end, and cannot touch a vow without the marker", async () => {
    const vow = (await verb("mind_vow", { operation: "make", vow: "keep faith" })).receipt.projection.node_id as string;
    await expect(inTx(lanes.daemon, "alpha", "alpha", "", `update nodes set metadata = metadata || '{"broken":true}'::jsonb where id = $1`, [vow])).rejects.toThrow(MSG);
    // a break that is declared but not yet due: the marker does not help
    const notDue = (await verb("mind_vow", { operation: "make", vow: "later" })).receipt.projection.node_id as string;
    expect((await verb("mind_vow", { operation: "break", vow_id: notDue, reason: "r" }, 24 * 3_600_000)).ok).toBe(true);
    await expect(withSettling(lanes.daemon, notDue, `update nodes set metadata = metadata || '{"broken":true}'::jsonb where id = $1`, [notDue])).rejects.toThrow(MSG);
    // the due one settles through the daemon pass
    expect((await verb("mind_vow", { operation: "break", vow_id: vow, reason: "could not hold" })).ok).toBe(true);
    expect(await settleOn(lanes.daemon)).toMatchObject({ ok: true, changed: 1 });
    expect((await admin.query("select metadata->>'broken' as b from nodes where id = $1", [vow])).rows[0].b).toBe("true");
    expect((await admin.query("select metadata->>'broken' as b from nodes where id = $1", [notDue])).rows[0].b).toBe("false");
    // and the marker never opens a vow that is due to a content change
    await expect(withSettling(lanes.daemon, vow, "update nodes set content = 'x' where id = $1", [vow])).rejects.toThrow(MSG);
  });

  it("app.settling naming a not-due, withdrawn or someone else's declaration does not open the door", async () => {
    const id = await core();
    const notDue = await declare(id, 24 * 3_600_000, "later self");
    const ins = (label: string, content: string) => `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence) values ('alpha', 'identity', '${label}', '${content}', 'alpha', 'extracted', 1.0)`;
    await expect(withSettling(lanes.daemon, notDue.id, ins("core", "later self"))).rejects.toThrow(MSG);
    // withdrawn
    const w = (await verb("mind_identity", { operation: "withdraw", proposal_id: notDue.id })).ok;
    expect(w).toBe(true);
    const id2 = await core("second");
    const due = await declare(id2, 0, "due self");
    await verb("mind_identity", { operation: "withdraw", proposal_id: due.id });
    await expect(withSettling(lanes.daemon, due.id, ins("core", "due self"))).rejects.toThrow(MSG);
    await expect(withSettling(lanes.daemon, due.id, "update nodes set invalidated_at = now() where id = $1", [id2])).rejects.toThrow(MSG);
    // a live due declaration opens only the write it matches: another content or label is refused
    const id3 = await core("third");
    const live = await declare(id3, 0, "live self");
    await expect(withSettling(lanes.daemon, live.id, ins("core", "something else"))).rejects.toThrow(MSG);
    await expect(withSettling(lanes.daemon, live.id, ins("other", "live self"))).rejects.toThrow(MSG);
    await expect(withSettling(lanes.daemon, live.id, "update nodes set invalidated_at = now() where id = $1", [id])).rejects.toThrow(MSG); // not its target
    await expect(withSettling(lanes.daemon, live.id, ins("core", "live self"))).rejects.toThrow(MSG); // the words alone are not enough: the replacement carries the proposal id
    await expect(withSettling(lanes.daemon, live.id, `${ins("core", "live self")}`.replace("written_by, source_type, confidence)", "written_by, source_type, confidence, metadata)").replace("'extracted', 1.0)", `'extracted', 1.0, '{"proposal_id":"${live.id}"}'::jsonb)`))).resolves.toBeTruthy(); // exactly the declaration
    await admin.query("update proposals set status = 'withdrawn', withdrawn_at = now() where id = $1", [live.id]);
  });

  const inSettling = async (db: Pool, id: string, fn: (c: import("pg").PoolClient) => Promise<void>) => {
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.mind_id', 'alpha', true), set_config('app.bearer', 'alpha', true), set_config('app.settling', $1, true)", [id]);
      await fn(c);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const INS = (content: string, meta: string) =>
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, metadata) values ('alpha', 'identity', 'core', '${content}', 'alpha', 'extracted', 1.0, '${meta}'::jsonb) returning id`;

  it("a settlement must match the declaration: one tagged replacement, the target pointed at it, nothing else", async () => {
    const id = await core("target");
    const p = await declare(id, 0, "the replacement");
    const tag = JSON.stringify({ proposal_id: p.id });
    // wrong or missing tag, wrong words: refused
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("the replacement", "{}")); })).rejects.toThrow(MSG);
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("other words", tag)); })).rejects.toThrow(MSG);
    // a second replacement under one settling is refused, and so is a replacement for a retirement
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("the replacement", tag)); await c.query(INS("the replacement", tag)); })).rejects.toThrow(MSG);
    // the update: node_type change, a retire-shaped invalidation (no replacement), a replacement that is not the tagged one: refused
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("the replacement", tag)); await c.query("update nodes set node_type = 'observation', invalidated_at = now() where id = $1", [id]); })).rejects.toThrow(MSG);
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("the replacement", tag)); await c.query("update nodes set invalidated_at = now() where id = $1", [id]); })).rejects.toThrow(MSG);
    const other = (await insertCore(legacy, "", "unrelated")).rows[0].id;
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("the replacement", tag)); await c.query("update nodes set invalidated_at = now(), superseded_by = $2 where id = $1", [id, other]); })).rejects.toThrow(MSG);
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("the replacement", tag)); await c.query("update nodes set superseded_by = (select id from nodes where metadata->>'proposal_id' = $2), invalidated_at = now(), metadata = metadata || '{\"x\":1}' where id = $1", [id, p.id]); })).rejects.toThrow(MSG);
    // exactly the settlement passes
    await inSettling(lanes.daemon, p.id, async (c) => {
      const n = (await c.query(INS("the replacement", tag))).rows[0].id;
      await c.query("update nodes set invalidated_at = now(), superseded_by = $2 where id = $1", [id, n]);
    });
    expect((await admin.query("select count(*)::int n from nodes where metadata->>'proposal_id' = $1", [p.id])).rows[0].n).toBe(1);
    await admin.query("update proposals set status = 'withdrawn', withdrawn_at = now() where id = $1", [p.id]); // keep later daemon passes out of this hand-made settlement
  });

  it("a retirement is settled by invalidating the target without a replacement, and a replacement pointer is refused", async () => {
    const id = await core("to retire");
    const r = await verb("mind_identity", { operation: "retire", section: "core", lineage_note: "done", target_node_id: id }, 0);
    const pid = (r.receipt.projection.proposal as { id: string }).id;
    const repl = (await insertCore(legacy, "", "pointed at")).rows[0].id;
    await expect(inSettling(lanes.daemon, pid, async (c) => { await c.query("update nodes set invalidated_at = now(), superseded_by = $2 where id = $1", [id, repl]); })).rejects.toThrow(MSG);
    await inSettling(lanes.daemon, pid, async (c) => { await c.query("update nodes set invalidated_at = now() where id = $1", [id]); });
    expect((await admin.query("select invalidated_at is not null as gone, superseded_by from nodes where id = $1", [id])).rows[0]).toEqual({ gone: true, superseded_by: null });
  });

  it("the daemon lane can mark a declaration settled only when it is due, with its own settlement event and an invalidated target", async () => {
    const id = await core("t");
    const notDue = await declare(id, 24 * 3_600_000, "later");
    const settledEv = (pid: string, kind = "identity.settled") => mkEvent(kind, {}, pid);
    const mark = (db: Pool, pid: string, ev: string) =>
      inTx(db, "alpha", "alpha", "", "update proposals set status = 'settled', settled_at = now(), settled_event_id = $2 where id = $1", [pid, ev]);
    await expect(mark(lanes.daemon, notDue.id, await settledEv(notDue.id))).rejects.toThrow(/only the mind changes its declaration/); // not due
    const id2 = await core("t2");
    const due = await declare(id2, 0, "now");
    await expect(mark(lanes.daemon, due.id, await mkEvent("observe", {}, due.id))).rejects.toThrow(/only the mind changes its declaration/); // unrelated event
    await expect(mark(lanes.daemon, due.id, await settledEv(due.id, "identity.settled").then(async () => mkEvent("identity.settled", {}, notDue.id)))).rejects.toThrow(/only the mind changes its declaration/); // another declaration's event
    await expect(mark(lanes.daemon, due.id, await settledEv(due.id))).rejects.toThrow(/only the mind changes its declaration/); // the target is still live
    expect((await admin.query("select status from proposals where id = $1", [due.id])).rows[0].status).toBe("accepted");
    // the real settlement (end to end) still passes
    expect(await settleOn(lanes.daemon)).toMatchObject({ ok: true });
    expect((await admin.query("select status from proposals where id = $1", [due.id])).rows[0].status).toBe("settled");
  });

  it("a vow break settles only into broken with the declared reason; a {broken: false} or extra keys are refused", async () => {
    const vow = (await verb("mind_vow", { operation: "make", vow: "hold" })).receipt.projection.node_id as string;
    expect((await verb("mind_vow", { operation: "break", vow_id: vow, reason: "tired" })).ok).toBe(true);
    const upd = (meta: string) => withSettling(lanes.daemon, vow, `update nodes set metadata = ${meta} where id = $1`, [vow]);
    await expect(upd(`(metadata - 'break_declared') || '{"broken": false}'::jsonb`)).rejects.toThrow(MSG);
    await expect(upd(`(metadata - 'break_declared') || '{"broken": true, "broken_at": "2026-01-01", "broken_reason": "other", "broken_by": "alpha"}'::jsonb`)).rejects.toThrow(MSG);
    await expect(upd(`(metadata - 'break_declared') || '{"broken": true, "broken_at": "2026-01-01", "broken_reason": "tired", "broken_by": "alpha", "extra": 1}'::jsonb`)).rejects.toThrow(MSG);
    await expect(upd(`metadata || '{"broken": true, "broken_at": "2026-01-01", "broken_reason": "tired", "broken_by": "alpha"}'::jsonb`)).rejects.toThrow(MSG); // break_declared left in place
    expect(await settleOn(lanes.daemon)).toMatchObject({ ok: true, changed: 1 });
    expect((await admin.query("select metadata->>'broken' b, metadata->>'broken_reason' r, metadata ? 'break_declared' d from nodes where id = $1", [vow])).rows[0]).toEqual({ b: "true", r: "tired", d: false });
  });

  it("the clock the daemon reports can move 'due' forward by five minutes at most", async () => {
    const MIN = 60_000;
    const run = async (now: Date) =>
      (await runDaemonOnce({ pool: lanes.daemon, embedder: NONE_EMBEDDER, coolingMs: 0, now: () => now }, { trigger: "manual", minds: ["alpha"] }))[0]!.passes.find((p) => p.pass === "identity.settle")!;
    const declareIn = async (target: string, ms: number, content: string) => {
      const r = await verb("mind_identity", { operation: "propose", section: "core", content, lineage_note: "x", target_node_id: target }, ms);
      expect(r.ok).toBe(true);
      return r.receipt.projection.proposal as { id: string };
    };
    // due in an hour: a daemon claiming it is year 2099 does not settle it (the pass fails closed, nothing changes)
    const id = await core("clock");
    const hour = await declareIn(id, 60 * MIN, "an hour away");
    const far = await run(new Date("2099-01-01T00:00:00Z"));
    expect(far.ok).toBe(false);
    expect((await admin.query("select status from proposals where id = $1", [hour.id])).rows[0].status).toBe("accepted");
    expect((await admin.query("select superseded_by from nodes where id = $1", [id])).rows[0].superseded_by).toBeNull();
    await admin.query("update proposals set status = 'withdrawn', withdrawn_at = now() where id = $1", [hour.id]);
    // due in three minutes: a clock four minutes ahead (drift) settles it
    const id2 = await core("clock2");
    await declareIn(id2, 3 * MIN, "future self");
    const ok = await run(new Date(Date.now() + 4 * MIN));
    expect(ok).toMatchObject({ ok: true, changed: 1 });
    expect((await admin.query("select content from nodes where id = (select superseded_by from nodes where id = $1)", [id2])).rows[0].content).toBe("future self");
  });

  it("a replacement is born live: already invalidated or with superseded_by set is refused; a settled mark needs the event of its own action", async () => {
    const id = await core("born");
    const p = await declare(id, 0, "born live");
    const tag = JSON.stringify({ proposal_id: p.id });
    const other = (await insertCore(legacy, "", "elsewhere")).rows[0].id;
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("born live", tag).replace("returning id", "").replace("metadata) values", "metadata, invalidated_at) values").replace("::jsonb)", "::jsonb, now())")); })).rejects.toThrow(MSG);
    await expect(inSettling(lanes.daemon, p.id, async (c) => { await c.query(INS("born live", tag).replace("returning id", "").replace("metadata) values", "metadata, superseded_by) values").replace("::jsonb)", `::jsonb, '${other}')`)); })).rejects.toThrow(MSG);
    // a rewrite is marked settled with identity.settled, not identity.retired
    await inTx(admin, "alpha", "alpha", "", "update nodes set invalidated_at = now() where id = $1", [id]);
    const mark = (ev: string) => inTx(lanes.daemon, "alpha", "alpha", "", "update proposals set status = 'settled', settled_at = now(), settled_event_id = $2 where id = $1", [p.id, ev]);
    await expect(mark(await mkEvent("identity.retired", {}, p.id))).rejects.toThrow(/only the mind changes its declaration/);
    await expect(mark(await mkEvent("identity.settled", {}, p.id))).resolves.toBeTruthy();
  });

  it("a vow break settles only with a believable broken_at", async () => {
    const vow = (await verb("mind_vow", { operation: "make", vow: "dated" })).receipt.projection.node_id as string;
    expect((await verb("mind_vow", { operation: "break", vow_id: vow, reason: "r" })).ok).toBe(true);
    const meta = (at: string) => `(metadata - 'break_declared') || '{"broken": true, "broken_at": "${at}", "broken_reason": "r", "broken_by": "alpha"}'::jsonb`;
    for (const at of ["2020-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
      await expect(withSettling(lanes.daemon, vow, `update nodes set metadata = ${meta(at)} where id = $1`, [vow])).rejects.toThrow(MSG);
    }
    await expect(withSettling(lanes.daemon, vow, `update nodes set metadata = ${meta(new Date().toISOString())} where id = $1`, [vow])).resolves.toBeTruthy();
  });

  it("the legacy lane and admin are unchanged: no lane rule, only the 0018 bearer rule", async () => {
    await expect(insertCore(legacy, "daemon", "legacy self")).resolves.toBeTruthy();
    await expect(insertCore(admin, "", "admin self")).resolves.toBeTruthy();
    const id = await core("x");
    await expect(inTx(legacy, "alpha", "alpha", "daemon", "update nodes set invalidated_at = now() where id = $1", [id])).resolves.toBeTruthy();
    await expect(inTx(legacy, "alpha", "beta", "", "update nodes set content = 'by a grantee' where node_type = 'identity' and mind_id = 'alpha' and content = 'legacy self'")).rejects.toThrow(/identity belongs to the mind/);
  });
});

describe("the operator lane's commands", () => {
  it("holds update on extractor_state and insert/update on grants directly; sanctum_app and the other lanes do not", async () => {
    const can = async (role: string, table: string, priv: string) =>
      (await admin.query("select has_table_privilege($1, $2, $3) as ok", [role, table, priv])).rows[0].ok as boolean;
    for (const priv of ["insert", "update"]) {
      expect(await can(testLaneRole("operator"), "grants", priv)).toBe(true);
      expect(await can("sanctum_app", "grants", priv)).toBe(false);
    }
    expect(await can(testLaneRole("operator"), "extractor_state", "update")).toBe(true);
    for (const lane of ["verb", "daemon", "import"] as const) {
      expect(await can(testLaneRole(lane), "extractor_state", "update")).toBe(false);
      expect(await can(testLaneRole(lane), "grants", "insert")).toBe(false);
    }
  });

  it("extractor enable, stage, pause, resume, disable, report and repair-backfill run on the operator lane", async () => {
    const op = lanes.operator;
    expect((await setExtractorState(op, "beta", "enable")).changed).toBe(true);
    expect((await setExtractorState(op, "beta", "stage", { stage: "propose" })).state.stage).toBe("propose");
    expect((await setExtractorState(op, "beta", "pause")).state.paused).toBe(true);
    expect((await setExtractorState(op, "beta", "resume")).state.paused).toBe(false);
    expect((await setExtractorState(op, "beta", "disable")).state.enabled).toBe(false);
    expect((await setExtractorState(op, "beta", "enable", { schedule: "04:30" })).state.schedule).toBe("04:30"); // re-enabling an existing row is the guarded update
    expect((await extractorReport(op, "beta")).all_time.total).toBe(0);
    await expect(repairBackfill(op, "beta", { dryRun: true })).resolves.toMatchObject({ dry_run: true });
    await expect(repairBackfill(op, "beta")).resolves.toMatchObject({ dry_run: false });
    expect((await admin.query("select count(*)::int n from events where kind like 'daemon.extractor.%' and mind_id = 'beta'")).rows[0].n).toBe(6);
    // the other lanes cannot flip the switch (they lack the grant, and the guard names the operator)
    await expect(setExtractorState(lanes.daemon, "beta", "disable")).rejects.toThrow(/admin DATABASE_URL/);
    await admin.query("delete from extractor_state");
  });

  it("grant add, revoke and list run on the operator lane; the other lanes cannot write grants", async () => {
    const op = lanes.operator;
    expect((await addGrant(op, "beta", "alpha", "steward")).status).toBe("created");
    expect((await addGrant(op, "beta", "alpha", "steward")).status).toBe("exists");
    expect((await listGrants(op, "beta")).some((g) => g.scope === "steward")).toBe(true);
    expect((await revokeGrant(op, "beta", "alpha", "steward")).status).toBe("revoked");
    for (const lane of ["verb", "daemon", "import"] as const) await expect(addGrant(lanes[lane], "beta", "alpha", "read")).rejects.toThrow(/permission denied/);
    await expect(addGrant(legacy, "beta", "alpha", "read")).rejects.toThrow(/permission denied/);
  });
});

describe("search_path of the guards", () => {
  it("a session's temporary events table cannot stand in for the real one in the decision guard", async () => {
    const a = await mkNode("sp-a");
    const n = await mkNoticing([a]);
    // lanes have no TEMP privilege; grant it to this one login for the attempt, so the functions are what is tested
    await expect(inTx(lanes.verb, "alpha", "alpha", "", "create temp table nope (i int)")).rejects.toThrow(/permission denied to create temporary tables/);
    await admin.query(`grant temporary on database ${new URL(laneUrl("verb")).pathname.slice(1)} to ${testLaneRole("verb")}`);
    const c = await lanes.verb.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.mind_id', 'alpha', true), set_config('app.bearer', 'alpha', true)");
      // a fake ledger row that says exactly what the guard looks for
      await c.query("create temp table events (id uuid, mind_id text, subject_id uuid, kind text) on commit drop");
      const fake = randomUUID();
      await c.query("insert into pg_temp.events values ($1, 'alpha', $2, 'notice.accepted')", [fake, n]);
      await expect(c.query("update noticings set status = 'accepted', decided_event_id = $2, decided_at = now() where id = $1", [n, fake])).rejects.toThrow(
        /decision must reference its own notice\.\* event/,
      );
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
      await admin.query(`revoke temporary on database ${new URL(laneUrl("verb")).pathname.slice(1)} from ${testLaneRole("verb")}`);
    }
    const cfg = await admin.query(
      `select p.proname, p.proconfig from pg_proc p join pg_namespace s on s.oid = p.pronamespace
        where s.nspname = 'public' and p.proname = any($1::text[]) order by p.proname`,
      [["events_append_only", "written_by_immutable", "nodes_core_guard", "proposals_insert_guard", "proposals_update_guard", "noticings_insert_guard", "noticings_decision_guard", "extractor_state_guard", "attention_pins_guard", "repair_work_guard", "purge_mind"]],
    );
    expect(cfg.rows).toHaveLength(11);
    for (const r of cfg.rows) expect(r.proconfig, r.proname).toEqual(["search_path=pg_catalog, public, pg_temp"]);
  });

  it("a daemon-lane member cannot become verb with temporary pg_roles and pg_auth_members tables; and has no TEMP privilege anyway", async () => {
    const dbname = new URL(laneUrl("daemon")).pathname.slice(1);
    for (const lane of LANES) {
      expect((await admin.query("select has_database_privilege($1, $2, 'temporary') as t", [testLaneRole(lane), dbname])).rows[0].t).toBe(false);
    }
    expect((await admin.query("select has_database_privilege('sanctum_app', $1, 'temporary') as t", [dbname])).rows[0].t).toBe(false);
    await admin.query(`grant temporary on database ${dbname} to ${testLaneRole("daemon")}`);
    try {
      const c = await lanes.daemon.connect();
      try {
        await c.query("begin");
        // the exact spoof: shadow the catalog views with temp tables that say this login is the verb lane, and put pg_temp first
        await c.query("create temp table pg_roles (oid oid, rolname name, rolsuper boolean, rolbypassrls boolean) on commit drop");
        await c.query("create temp table pg_auth_members (roleid oid, member oid) on commit drop");
        await c.query("insert into pg_temp.pg_roles values (1, 'sanctum_verb', false, false), (2, session_user, false, false)");
        await c.query("insert into pg_temp.pg_auth_members values (1, 2)");
        await c.query("set local search_path = pg_temp, pg_catalog, public");
        expect((await c.query("select sanctum_lane() as l, sanctum_actor() as a")).rows[0]).toEqual({ l: "daemon", a: "daemon" });
        await c.query("select set_config('app.mind_id', 'alpha', true), set_config('app.bearer', 'alpha', true)");
        await expect(c.query(`insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence) values ('alpha', 'identity', 'core', 'spoofed', 'alpha', 'extracted', 1.0)`)).rejects.toThrow(/identity is settled only/);
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    } finally {
      await admin.query(`revoke temporary on database ${dbname} from ${testLaneRole("daemon")}`);
    }
  });
});

describe("withMind and the lane", () => {
  it("throws a clear error when the connection is a lane that is not the actor this code path intended", async () => {
    await expect(withMind(lanes.daemon, "alpha", "alpha", "read", async () => 1, "verb")).rejects.toThrow(
      /connected as lane daemon .* but this code path acts as verb/,
    );
    await expect(withMind(lanes.verb, "alpha", "alpha", "write", async () => 1, "daemon")).rejects.toBeInstanceOf(LaneError);
    for (const lane of LANES) {
      await expect(withMind(lanes[lane], "alpha", "alpha", "read", async (tx) => (await tx.query("select sanctum_actor() a")).rows[0].a, lane)).resolves.toBe(lane);
    }
  });

  it("makes no claim when the code path states no actor, and no error on the legacy lane or the admin connection", async () => {
    await expect(withMind(lanes.import, "alpha", "alpha", "read", async () => "ok")).resolves.toBe("ok");
    for (const db of [legacy, admin]) {
      for (const actor of LANES) {
        await expect(withMind(db, "alpha", "alpha", "read", async (tx) => (await tx.query("select sanctum_actor() a")).rows[0].a, actor)).resolves.toBe(actor);
      }
    }
  });

  it("asks the database about the actor once per pool, not once per transaction", async () => {
    const pool = lanePool("verb");
    let asked = 0;
    const connect = pool.connect.bind(pool) as (...a: unknown[]) => Promise<any>;
    (pool as any).connect = async (...a: unknown[]) => {
      if (typeof a[0] === "function") return connect(...a); // the pool's own internal use (pool.query)
      const c = await connect(...a);
      const q = c.query.bind(c);
      c.query = (...args: any[]) => {
        if (typeof args[0] === "string" && args[0].includes("sanctum_actor()")) asked++;
        return q(...args);
      };
      return c;
    };
    try {
      for (let i = 0; i < 4; i++) await withMind(pool, "alpha", "alpha", "read", async () => i, "verb");
      expect(asked).toBe(1);
    } finally {
      await closePool(pool);
    }
  });
});

describe("startup lane checks", () => {
  const fake = (role: string, m = false) => ({ query: async () => ({ rows: [{ u: role, m, f: true, l: LANE_ROLES[role] ?? null }] }) }) as unknown as Pick<Pool, "query">;

  it("maps what the database reports to connections", () => {
    expect(classifyRole({ role: "sanctum_test_verb", lane: "verb", appMember: true })).toEqual({ kind: "lane", role: "sanctum_test_verb", lane: "verb" });
    expect(classifyRole({ role: "sanctum_import", lane: "import", appMember: true })).toMatchObject({ kind: "lane", lane: "import" });
    expect(classifyRole({ role: "sanctum_app", lane: null, appMember: false })).toEqual({ kind: "legacy", role: "sanctum_app" });
    expect(classifyRole({ role: "postgres", lane: null, appMember: false })).toEqual({ kind: "admin", role: "postgres" });
    // a differently named plain member of sanctum_app is the legacy lane too
    expect(classifyRole({ role: "my_app_login", lane: null, appMember: true })).toEqual({ kind: "legacy", role: "my_app_login" });
    expect(classifyRole({ role: "x", lane: "constructor", appMember: false })).toEqual({ kind: "admin", role: "x" });
  });

  it("a lane login on a database without 0026 gets the migration message, not a raw error", async () => {
    const old = { query: async () => ({ rows: [{ u: "sanctum_verb", m: true, f: false }] }) } as unknown as Pick<Pool, "query">;
    await expect(requireLane(old, { command: "http", lanes: ["verb"] })).rejects.toThrow(/is migration 0026 applied\?/);
    // an older database with the legacy login still works as before
    const legacyOld = { query: async () => ({ rows: [{ u: "sanctum_app", m: true, f: false }] }) } as unknown as Pick<Pool, "query">;
    expect((await requireLane(legacyOld, { command: "http", lanes: ["verb"] })).warning).toMatch(/legacy/);
    const undefinedFn = { query: async (sql: string) => { if (sql.includes("sanctum_lane() as l")) throw Object.assign(new Error("function sanctum_lane() does not exist"), { code: "42883" }); return { rows: [{ u: "sanctum_verb", m: true, f: true }] }; } } as unknown as Pick<Pool, "query">;
    await expect(requireLane(undefinedFn, { command: "http", lanes: ["verb"] })).rejects.toThrow(/is migration 0026 applied\?/);
  });

  it("http and stdio need the verb lane; daemon the daemon lane; the tools the import lane", async () => {
    const need = { http: ["verb"], stdio: ["verb"], daemon: ["daemon"], "export-mind": ["import"], "import-mind": ["import"], "embed-backfill": ["import"], "sinks requeue": ["import"] } as const;
    for (const [command, wanted] of Object.entries(need)) {
      for (const lane of LANES) {
        const run = requireLane(fake(laneRole(lane)), { command, lanes: wanted });
        if (wanted.includes(lane as never)) {
          expect((await run).warning).toBeNull();
        } else {
          await expect(run).rejects.toThrow(new RegExp(`${command} must run as ${laneRole(wanted[0])}, but DATABASE_URL connects as ${laneRole(lane)}`));
          await expect(requireLane(fake(laneRole(lane)), { command, lanes: wanted })).rejects.toBeInstanceOf(LaneError);
        }
      }
      // the admin connection is not a lane: refused where the command never took the admin URL
      await expect(requireLane(fake("postgres"), { command, lanes: wanted })).rejects.toThrow(/not a lane login/);
      // the legacy lane works with one warning that names the hardening
      const v = await requireLane(fake("sanctum_app"), { command, lanes: wanted });
      expect(v.warning).toMatch(/legacy sanctum_app lane/);
      expect(v.warning).toContain("SECURITY");
    }
  });

  it("extractor and grant run as operator or as the admin connection", async () => {
    const req = { command: "extractor", lanes: ["operator"], allowAdmin: true } as const;
    expect((await requireLane(fake("sanctum_operator"), req)).warning).toBeNull();
    expect((await requireLane(fake("postgres"), req)).warning).toBeNull();
    expect((await requireLane(fake("sanctum_app"), req)).warning).toMatch(/legacy/);
    for (const lane of ["verb", "daemon", "import"] as const) await expect(requireLane(fake(laneRole(lane)), req)).rejects.toThrow(/must run as sanctum_operator/);
  });

  it("judges a connection and reports a mismatch without a database", () => {
    expect(judgeLane({ kind: "admin", role: "postgres" }, { command: "grant", lanes: ["operator"], allowAdmin: true }).warning).toBeNull();
    expect(laneMismatch({ kind: "lane", role: "sanctum_daemon", lane: "daemon" }, "verb")).toMatch(/connected as lane daemon .* acts as verb/);
    expect(laneMismatch({ kind: "lane", role: "sanctum_daemon", lane: "daemon" }, "daemon")).toBeNull();
    expect(laneMismatch({ kind: "legacy", role: "sanctum_app" }, "verb")).toBeNull();
  });

  it("the real pools report lane, legacy (a plain member of sanctum_app) and admin", async () => {
    expect(await requireLane(legacy, { command: "http", lanes: ["verb"] })).toMatchObject({ connection: { kind: "legacy", role: "sanctum_test_app" } });
    expect(await requireLane(admin, { command: "grant", lanes: ["operator"], allowAdmin: true })).toMatchObject({ connection: { kind: "admin" }, warning: null });
    await expect(requireLane(admin, { command: "http", lanes: ["verb"] })).rejects.toThrow(/not a lane login/);
  });

  it("the real pool reports its lane through requireLane", async () => {
    await expect(requireLane(lanes.verb, { command: "http", lanes: ["verb"] })).resolves.toMatchObject({ warning: null });
    await expect(requireLane(lanes.verb, { command: "daemon", lanes: ["daemon"] })).rejects.toThrow(/daemon must run as sanctum_daemon, but DATABASE_URL connects as sanctum_test_verb/);
  });

  describe("through the command line", () => {
    const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    const run = (url: string, ...args: string[]) =>
      spawnSync(tsx, [cli, ...args], { env: { ...process.env, DATABASE_URL: url, EMBEDDER: "none" }, encoding: "utf8", timeout: 30_000 });

    it("refuses to start http on the daemon lane and the daemon on the verb lane, naming both", () => {
      const http = run(laneUrl("daemon"), "http");
      expect(http.status).toBe(1);
      expect(http.stderr).toContain("http must run as sanctum_verb, but DATABASE_URL connects as sanctum_test_daemon");
      const daemon = run(laneUrl("verb"), "daemon", "--once");
      expect(daemon.status).toBe(1);
      expect(daemon.stderr).toContain("daemon must run as sanctum_daemon, but DATABASE_URL connects as sanctum_test_verb");
      const exp = run(laneUrl("verb"), "export-mind", "--mind", "alpha", "--out", "/tmp/never-written.json");
      expect(exp.status).toBe(1);
      expect(exp.stderr).toContain("export-mind must run as sanctum_import");
    });

    // sanctum_app is NOLOGIN in the test cluster; give it a login for the one test that needs the real legacy role, then put it back
    let saved: { rolpassword: string | null; rolcanlogin: boolean } | undefined;
    const legacyPw = randomUUID().replaceAll("-", "");
    const legacyUrl = (() => {
      const u = new URL(testAppUrl());
      u.username = "sanctum_app";
      u.password = legacyPw;
      return u.toString();
    })();
    beforeAll(async () => {
      saved = (await admin.query("select rolpassword, rolcanlogin from pg_authid where rolname = 'sanctum_app'")).rows[0];
      await admin.query(`alter role sanctum_app login password '${legacyPw}'`);
    });
    afterAll(async () => {
      if (!saved) return;
      const stmt = await admin.query(
        `select format('alter role sanctum_app %s password %s', case when $1::boolean then 'login' else 'nologin' end, coalesce(quote_literal($2::text), 'null')) as sql`,
        [saved.rolcanlogin, saved.rolpassword],
      );
      await admin.query(stmt.rows[0].sql);
    });

    it("grant list runs on the operator lane and on the legacy lane (with one warning), and is refused on the verb lane", () => {
      const op = run(laneUrl("operator"), "grant", "list");
      expect(op.status).toBe(0);
      expect(op.stderr).not.toContain("warning");
      const old = run(legacyUrl, "grant", "list");
      expect(old.status).toBe(0);
      expect(old.stderr.match(/warning/g)).toHaveLength(1);
      expect(old.stderr).toContain("legacy sanctum_app lane");
      const verb = run(laneUrl("verb"), "grant", "list");
      expect(verb.status).toBe(1);
      expect(verb.stderr).toContain("grant must run as sanctum_operator");
    });
  });
});

describe("docker-compose.yml", () => {
  const text = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const service = (name: string): string => {
    const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|^volumes:)`, "m").exec(text);
    if (!m) throw new Error(`no service ${name}`);
    return m[1]!;
  };

  it("gives mind the verb URL, daemon the daemon URL and tools the import URL, built from the three passwords with local defaults", () => {
    expect(service("mind")).toContain("DATABASE_URL: postgresql://sanctum_verb:${VERB_PASSWORD:-sanctum_verb_local}@db:5432/sanctum_mind");
    expect(service("daemon")).toContain("DATABASE_URL: postgresql://sanctum_daemon:${DAEMON_PASSWORD:-sanctum_daemon_local}@db:5432/sanctum_mind");
    expect(service("tools")).toContain("DATABASE_URL: postgresql://sanctum_import:${IMPORT_PASSWORD:-sanctum_import_local}@db:5432/sanctum_mind");
    for (const s of ["mind", "daemon", "tools"]) expect(service(s)).not.toContain("sanctum_app");
  });

  it("tells init the passwords through the environment", () => {
    const init = service("init");
    expect(init).toContain("SANCTUM_LANE_PASSWORD_VERB: ${VERB_PASSWORD:-sanctum_verb_local}");
    expect(init).toContain("SANCTUM_LANE_PASSWORD_DAEMON: ${DAEMON_PASSWORD:-sanctum_daemon_local}");
    expect(init).toContain("SANCTUM_LANE_PASSWORD_IMPORT: ${IMPORT_PASSWORD:-sanctum_import_local}");
    expect(init).toContain("SANCTUM_APP_PASSWORD: ${APP_PASSWORD:-sanctum_app_local}");
  });
});
