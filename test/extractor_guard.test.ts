// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { appPool, closePool, queryAs, resetDatabase } from "./helpers.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { DREAM_FORBIDDEN_TABLES, violations, WHITELISTED_KINDS } from "./guard_scan.js";
import { EXTRACTOR_PASSES, noticeMetabolise } from "../src/extractor/index.js";
import { setExtractorState } from "../src/extractor-admin.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import type { Metaboliser } from "../src/extractor/metaboliser.js";

/**
 * The extractor proposes; it never writes memory. Two layers check that, and neither is the real boundary (that is the
 * database, migration 0021, and the verb `mind_notice accept`, mind only):
 *
 * 1. A static scan of the SOURCE TEXT of every file under src/extractor/ (recursively). A small scanner blanks comments
 *    but keeps strings (strings are scanned too, since SQL lives in them), and handles strings BEFORE comments so a
 *    `"/*"` in a string cannot hide code. Then it fails on:
 *    - SQL that inserts, updates, merges, copies, deletes or truncates the memory tables nodes, events or edges, in any
 *      case, with optional `public.` and quotes, across whitespace and string concatenation ("insert " + "into nodes"),
 *      and a table name that is not a literal (`insert into ${t}`, `"insert into " + t`);
 *    - imports from ../verbs/ other than types.js and `import { appendEvent } from "../verbs/common.js"` (unaliased),
 *      including re-exports, dynamic import() and require(); a non-literal dynamic import;
 *    - the identifiers `registry`, `runVerb`, `.handler(`, `linkNodes`, `insertSelfNode`, `supersedeNode`;
 *    - any `appendEvent` that is not a direct call with an object literal; inside such a call, a spread, a computed key,
 *      a shorthand `kind`, no `kind:` at all, and EVERY `kind:` (at any depth) must be a string literal from the whitelist.
 *    Limits, stated: regex literals containing quotes and nested backticks inside `${}` are not understood by the scanner.
 * 2. A runtime test below: run every extractor pass over a seeded mind and compare nodes and edges (all columns) before
 *    and after, and check that every event the passes appended is of a whitelisted kind.
 */
const DIR = fileURLToPath(new URL("../src/extractor", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("src/extractor never writes memory (static)", () => {
  const all = files(DIR);

  it("contains the files this stage ships (so the scan below is not scanning nothing)", () => {
    expect(all.map((f) => path.basename(f)).sort()).toEqual(expect.arrayContaining(["config.ts", "events.ts", "expire.ts", "index.ts"]));
  });

  for (const f of all) {
    it(`${path.relative(DIR, f)} has no memory writes, no verb imports and appends only whitelisted event kinds`, () => {
      expect(violations(readFileSync(f, "utf8"))).toEqual([]);
    });
  }

  describe("the checker catches what it is meant to catch", () => {
    const bad: Array<[string, string]> = [
      ["insert, upper case and spacing", `await tx.query("INSERT   INTO nodes (a) values (1)")`],
      ["insert across a newline in a template", "await tx.query(`insert into\n events (a) values (1)`)"],
      ["insert into edges", `insert into edges (a)`],
      ["schema-qualified and quoted", `await tx.query('insert into public."nodes" (a) values (1)')`],
      ["quoted only", `await tx.query('INSERT INTO "events" (a)')`],
      ["update nodes", `update nodes set pinned = true`],
      ["update only", `update only edges set weight = 1`],
      ["delete from", `delete from events where true`],
      ["merge", `merge into nodes using x on true when not matched then insert default values`],
      ["copy", `copy nodes from stdin`],
      ["truncate", `truncate table edges`],
      ["a cte write", `with x as (insert into events (a) values (1) returning id) select * from x`],
      ["insert into relations", `await tx.query("insert into relations (mind_id, subject) values ('a', 'b')")`],
      ["update relations", `await tx.query("update relations set note = 'x'")`],
      ["delete from drive_state", `await tx.query("delete from drive_state where true")`],
      ["update drive_state, quoted", `await tx.query('update public."drive_state" set level = 1')`],
      ["insert into attention_pins", `await tx.query("insert into attention_pins (a) values (1)")`],
      ["update dream_preferences", `await tx.query("update dream_preferences set a = 1")`],
      ["insert into dreams", `await tx.query("insert into dreams (id) values (1)")`],
      ["update dreams", `await tx.query("update dreams set status = 'faded'")`],
      ["insert into metabolise_queue", `await tx.query("insert into metabolise_queue (mind_id) values ('a')")`],
      ["delete from metabolise_queue", `await tx.query("delete from metabolise_queue where true")`],
      ["insert into repair_work", `await tx.query("insert into repair_work (a) values (1)")`],
      ["insert into repair_work, quoted and qualified", `await tx.query('INSERT INTO public."repair_work" (a)')`],
      ["delete from repair_work", `await tx.query("delete from repair_work where true")`],
      ["split string", `await tx.query("insert " + "into nodes (a)")`],
      ["dynamic table by concatenation", `await tx.query("insert into " + table + " (a)")`],
      ["dynamic table by template", "await tx.query(`insert into ${table} (a)`)"],
      ["a string hiding code from a naive comment stripper", `const a = "/*"; await tx.query("insert into nodes (a)"); const b = "*/";`],
      ["a url-looking string before the write", `const u = "http://x"; await tx.query("insert into nodes (a)")`],
      ["insertSelfNode", `insertSelfNode(ctx, {})`],
      ["supersedeNode", `await supersedeNode(ctx, id, {})`],
      ["registry", `const v = ctx.registry.find(x => x)`],
      ["runVerb", `await runVerb(deps, caller, "mind_link", {})`],
      ["handler", `await mind_link.handler(ctx, {})`],
      ["linkNodes", `await linkNodes(ctx, {})`],
      ["verb import", `import { mind_link } from "../verbs/mind_link.js";`],
      ["verb namespace import", `import * as v from "../verbs/self_common.js";`],
      ["common.js beyond appendEvent", `import { appendEvent, deriveLabel } from "../verbs/common.js";`],
      ["aliased appendEvent", `import { appendEvent as a } from "../verbs/common.js";`],
      ["type-modified common import", `import type { appendEvent } from "../verbs/common.js";`],
      ["re-export", `export { insertSelfNode } from "../verbs/self_common.js";`],
      ["side-effect import", `import "../verbs/registry.js";`],
      ["dynamic import", `const m = await import("../verbs/mind_link.js");`],
      ["dynamic import by variable", `const m = await import(p);`],
      ["require", `const m = require("../verbs/registry.js");`],
      ["wrong kind", `await appendEvent(ctx, { kind: "observe", payload: {} })`],
      ["kind from a variable", `await appendEvent(ctx, { kind: someKind, payload: {} })`],
      ["kind from a template", "await appendEvent(ctx, { kind: `notice.${x}`, payload: {} })"],
      ["kind after other keys", `await appendEvent(ctx, { subject_id: id,\n kind: "distill" })`],
      ["a second, bad kind nested in the payload", `await appendEvent(ctx, { kind: "notice.expired", payload: { kind: "observe" } })`],
      ["a variable kind nested in the payload", `await appendEvent(ctx, { kind: "notice.expired", payload: { kind: n.kind } })`],
      ["a spread", `await appendEvent(ctx, { kind: "notice.expired", ...extra })`],
      ["a spread carrying a kind", `await appendEvent(ctx, { ...ev })`],
      ["a computed key", `await appendEvent(ctx, { kind: "notice.expired", ["kind"]: "x" })`],
      ["a shorthand kind", `await appendEvent(ctx, { kind, payload: {} })`],
      ["no kind at all", `await appendEvent(ctx, { payload: {} })`],
      ["a non-literal argument", `await appendEvent(ctx, ev)`],
      ["an alias of appendEvent", `const w = appendEvent; await w(ctx, { kind: "observe" })`],
      ["a quoted key", `await appendEvent(ctx, { "kind": "observe" })`],
    ];
    for (const [name, sample] of bad) {
      it(`flags: ${name}`, () => {
        expect(violations(sample).length).toBeGreaterThan(0);
      });
    }
  });

  describe("and allows what the extractor legitimately does", () => {
    for (const k of WHITELISTED_KINDS) {
      it(`appendEvent with kind ${k}`, () => {
        expect(violations(`await appendEvent(ctx, { kind: "${k}", subject_id: n.id, payload: f.parse({ noticing_kind: n.kind }) })`)).toEqual([]);
      });
    }
    it("imports of appendEvent from common.js and types from types.js", () => {
      expect(violations(`import { appendEvent } from "../verbs/common.js";\nimport type { VerbContext } from "../verbs/types.js";`)).toEqual([]);
    });
    it("claiming and acknowledging repair_work (updates and reads)", () => {
      expect(violations(`await tx.query("select id from repair_work where done_at is null"); await tx.query("update repair_work set next_offset = 1, done_at = now() where id = $1")`)).toEqual([]);
    });
    it("the noticing tables", () => {
      expect(violations(`await tx.query("insert into noticings (a) values (1)"); await tx.query("update noticings set status = 'expired'"); await tx.query("insert into extractor_models (a)")`)).toEqual([]);
      expect(violations(`await tx.query("select id from nodes where id = $1"); await tx.query("select * from events e join edges d on true")`)).toEqual([]);
      expect(violations(`on conflict (id) do update set status = excluded.status`)).toEqual([]);
    });
    it("updating a metabolise_queue row's status, and reading the tables it may not write", () => {
      expect(violations(`await tx.query("update metabolise_queue set status = 'done', done_at = now() where id = $1")`)).toEqual([]);
      expect(violations(`await tx.query("select subject, state from relations where mind_id = $1"); await tx.query("select relations from dream_preferences"); await tx.query("select 1 from dreams")`)).toEqual([]);
    });
    it("the dream directory's own table list lets dreams be laid and decided, and still bars the rest", () => {
      expect(violations(`await tx.query("insert into dreams (id) values (1)"); await tx.query("update dreams set status = 'faded'")`, ["dream.laid"], DREAM_FORBIDDEN_TABLES)).toEqual([]);
      expect(violations(`await tx.query("insert into relations (a) values (1)")`, ["dream.laid"], DREAM_FORBIDDEN_TABLES).length).toBeGreaterThan(0);
      expect(violations(`await tx.query("update drive_state set a = 1")`, ["dream.laid"], DREAM_FORBIDDEN_TABLES).length).toBeGreaterThan(0);
    });
    it("mentions in comments", () => {
      expect(violations(`// never insert into nodes here\n/* appendEvent(ctx, { kind: "observe" }) and registry */\nconst x = 1;`)).toEqual([]);
    });
  });
});

describe("src/extractor never writes memory (runtime)", () => {
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

  it("every extractor pass leaves nodes and edges byte-identical and appends only whitelisted event kinds", async () => {
    const now = new Date();
    const as = (sql: string, params: unknown[] = []) => queryAs(pool, "alpha", "alpha", sql, params);
    const nodes: string[] = [];
    for (const c of ["one", "two", "three"]) {
      nodes.push((await as(`insert into nodes (mind_id, node_type, label, content, written_by) values ('alpha', 'observation', $1, $1, 'alpha') returning id`, [c])).rows[0].id);
    }
    await as(`insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'related_to', 'alpha', $1, $2)`, [nodes[0], nodes[1]]);
    const pe = (await as(`insert into events (mind_id, kind, payload, written_by, recorded_at) values ('alpha', 'notice.proposed', '{}', 'alpha', now()) returning id`)).rows[0].id;
    const past = new Date(now.getTime() - 60_000);
    for (const stage of ["propose", "shadow"]) {
      await as(
        `insert into noticings (mind_id, kind, sources, payload, score, stage, proposed_event_id, expires_at) values ('alpha', 'link', $1::uuid[], '{}', 0.5, $2, $3, $4)`,
        [[nodes[0], nodes[1]], stage, pe, past],
      );
    }
    const snap = async () => ({
      nodes: (await admin.query("select to_jsonb(n)::text j from nodes n order by id")).rows.map((r) => r.j),
      edges: (await admin.query("select to_jsonb(e)::text j from edges e order by id")).rows.map((r) => r.j),
    });
    const before = await snap();
    const maxSeq = (await admin.query("select max(seq)::bigint s from events")).rows[0].s;

    const reports = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, now: () => now }, { trigger: "manual", minds: ["alpha"], passes: EXTRACTOR_PASSES });
    expect(reports[0]!.passes.map((p) => [p.pass, p.ok])).toEqual(EXTRACTOR_PASSES.map((p) => [p.name, true]));
    expect(reports[0]!.passes.reduce((n, p) => n + p.changed, 0)).toBe(2); // not vacuous: both proposals expired

    expect(await snap()).toEqual(before);
    const kinds = (await admin.query("select distinct kind from events where seq > $1", [maxSeq])).rows.map((r) => r.kind);
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(WHITELISTED_KINDS).toContain(k);
  });

  for (const stage of ["shadow", "propose"] as const) {
    it(`the metabolise pass at ${stage} proposes but leaves nodes, edges, relations and drive_state byte-identical`, async () => {
      const now = new Date(Date.now() + 1000);
      const run = (name: string, input: Record<string, unknown>) =>
        runVerb({ pool, registry, now: () => now, embedder: NONE_EMBEDDER }, { bearer: "alpha", grants: {} }, name, { mind_id: "alpha", ...input }) as Promise<any>;
      const as = (sql: string, params: unknown[] = []) => queryAs(pool, "alpha", "alpha", sql, params);
      const ns: string[] = [];
      for (const c of ["one", "two"]) ns.push((await as(`insert into nodes (mind_id, node_type, label, content, written_by) values ('alpha', 'observation', $1, $1, 'alpha') returning id`, [c])).rows[0].id);
      await as(`insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id) values ('alpha', 'related_to', 'alpha', $1, $2)`, ns);
      expect((await run("mind_relate", { operation: "set", subject: "Rowan", state: "close", intensity: 0.7, note: "Old friend." })).ok).toBe(true);
      expect((await run("mind_drive", { operation: "nudge", drive: "play", axis: "intensity", delta: 1 })).ok).toBe(true);
      await setExtractorState(admin, "alpha", "enable", { stage, schedule: "23:59" });
      const queued = await run("mind_metabolise", { turns: [{ speaker: "other", name: "Rowan", text: "I got the job." }, { speaker: "self", text: "I am so glad." }] });
      expect(queued.ok).toBe(true);

      const snap = async () => ({
        nodes: (await admin.query("select to_jsonb(n)::text j from nodes n order by id")).rows.map((r) => r.j),
        edges: (await admin.query("select to_jsonb(e)::text j from edges e order by id")).rows.map((r) => r.j),
        relations: (await admin.query("select to_jsonb(r)::text j from relations r order by mind_id, subject")).rows.map((r) => r.j),
        drive_state: (await admin.query("select to_jsonb(d)::text j from drive_state d order by mind_id, context, drive")).rows.map((r) => r.j),
      });
      const before = await snap();
      expect(before.relations.length).toBeGreaterThan(0);
      expect(before.drive_state.length).toBeGreaterThan(0);
      const maxSeq = (await admin.query("select max(seq)::bigint s from events")).rows[0].s;

      const metaboliser: Metaboliser = {
        name: "fake",
        model: "fake-model",
        async metabolise() {
          return { feelings: [{ emotion: "joy", weight: "medium", pillar: "bond", content: "I felt joy for Rowan." }], relations: [{ subject: "Rowan", note: "Starts a new job.", warmth: true }] };
        },
      };
      const reports = await runDaemonOnce({ pool, embedder: NONE_EMBEDDER, metaboliser, now: () => now }, { trigger: "manual", minds: ["alpha"], passes: [noticeMetabolise] });
      expect(reports[0]!.passes[0]).toMatchObject({ ok: true, changed: 2 }); // not vacuous: a feeling and a relation were proposed
      expect((await admin.query("select count(*)::int c from noticings where stage = $1", [stage])).rows[0].c).toBe(2);

      expect(await snap()).toEqual(before);
      const kinds = (await admin.query("select distinct kind from events where seq > $1", [maxSeq])).rows.map((r) => r.kind);
      expect(kinds).toEqual(["notice.proposed"]);
    });
  }
});
