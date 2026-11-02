// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, resetDatabase } from "./helpers.js";
import { violations } from "./extractor_guard.test.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { DREAM_PASSES } from "../src/dream/index.js";
import type { Dreamer } from "../src/dream/dreamer.js";

/**
 * Dreaming lays down residue; it never writes memory. The extractor's two layers, applied to src/dream/: the static scan
 * (test/extractor_guard.test.ts, `violations`, with dreaming's own whitelist) over every file, and a runtime test that runs
 * every dream pass over a seeded mind with a dreamer that answers, and compares nodes and edges before and after. The real
 * boundary is the database (migration 0027) and the verb `mind_dream anchor`, mind only.
 */
export const DREAM_WHITELISTED_KINDS = ["dream.laid", "dream.faded"];
const DIR = fileURLToPath(new URL("../src/dream", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("src/dream never writes memory (static scan)", () => {
  const all = files(DIR);
  it("scans every file under src/dream (there are some)", () => {
    expect(all.length).toBeGreaterThan(0);
  });
  for (const f of all) {
    it(`${path.relative(DIR, f)} has no memory writes, no verb imports and appends only dream.laid / dream.faded`, () => {
      expect(violations(readFileSync(f, "utf8"), DREAM_WHITELISTED_KINDS)).toEqual([]);
    });
  }
});

describe("src/dream never writes memory (runtime)", () => {
  let admin: Pool;
  let pool: Pool;
  beforeEach(async () => {
    if (pool) await closePool(pool);
    if (admin) await closePool(admin);
    admin = await resetDatabase();
    pool = appPool();
  });
  afterAll(async () => {
    if (pool) await closePool(pool);
    if (admin) await closePool(admin);
  });

  it("every dream pass leaves nodes and edges byte-identical and appends only whitelisted event kinds", async () => {
    const now = new Date(Date.now() + 1000);
    const as = (sql: string, params: unknown[] = []) => queryAs(pool, "alpha", "alpha", sql, params);
    const nodes: string[] = [];
    for (const c of ["one", "two"]) nodes.push((await as(`insert into nodes (mind_id, node_type, label, content, written_by) values ('alpha', 'observation', $1, $1, 'alpha') returning id`, [c])).rows[0].id);
    await as(`insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'related_to', 'alpha', $1, $2)`, [nodes[0], nodes[1]]);
    // residue: one textured event; a laid dream past its fade so dream.fade has something to do
    await as(`insert into events (mind_id, kind, payload, texture, written_by, recorded_at) values ('alpha', 'write', '{"text":"a long day at the forge"}', '{"charge":["tired"]}', 'alpha', now())`);
    const le = (await as(`insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'dream.laid', '{}', 'alpha', now()) returning id`)).rows[0].id;
    await admin.query(`insert into dream_state (mind_id, enabled, stage, schedule) values ('alpha', false, 'propose', '00:00')`);
    await admin.query(`update dream_state set enabled = true where mind_id = 'alpha'`).catch(() => undefined);
    await admin.query("select set_config('app.actor', 'operator', false)");
    await admin.query(`update dream_state set enabled = true where mind_id = 'alpha'`);
    const past = new Date(now.getTime() - 60_000);
    await as(`insert into dreams (mind_id, content, question, model_version, stage, laid_event_id, fades_at) values ('alpha', 'old', '', 'test@p1', 'propose', $1, $2)`, [le, past]);
    const snap = async () => ({
      nodes: (await admin.query("select to_jsonb(n)::text j from nodes n order by id")).rows.map((r) => r.j),
      edges: (await admin.query("select to_jsonb(e)::text j from edges e order by id")).rows.map((r) => r.j),
    });
    const before = await snap();
    const maxSeq = (await admin.query("select max(seq)::bigint s from events")).rows[0].s;
    const dreamer: Dreamer = { name: "fake", model: "fake-model", dream: async () => ({ dream: "A forge that hummed a lullaby.", question: "Who was it for?" }) };

    const reports = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, dreamer, now: () => now }, { trigger: "manual", minds: ["alpha"], passes: DREAM_PASSES });
    expect(reports[0]!.passes.map((p) => [p.pass, p.ok])).toEqual(DREAM_PASSES.map((p) => [p.name, true]));
    expect(reports[0]!.passes.reduce((n, p) => n + p.changed, 0)).toBe(2); // not vacuous: one faded, one laid

    expect(await snap()).toEqual(before);
    const kinds = (await admin.query("select distinct kind from events where seq > $1", [maxSeq])).rows.map((r) => r.kind);
    expect(kinds.sort()).toEqual(DREAM_WHITELISTED_KINDS.slice().sort());
  });
});
