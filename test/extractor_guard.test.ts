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
import { EXTRACTOR_PASSES } from "../src/extractor/index.js";

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
export const WHITELISTED_KINDS = ["notice.proposed", "notice.expired", "notice.model.trained"];

const DIR = fileURLToPath(new URL("../src/extractor", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Index just past the string literal that starts at `i` (a quote or backtick), honouring backslash escapes. */
function endOfString(src: string, i: number): number {
  const q = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") j += 2;
    else if (src[j] === q) return j + 1;
    else if (q !== "`" && src[j] === "\n") return j; // an unterminated plain string ends at the line
    else j++;
  }
  return src.length;
}

/** Blanks line and block comments with spaces (newlines kept), leaving every string literal untouched. Strings first. */
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      const e = endOfString(src, i);
      out += src.slice(i, e);
      i = e;
    } else if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const stop = e === -1 ? src.length : e + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The text between the parenthesis at `open` and its match, skipping strings; null when unbalanced. */
function parenBody(code: string, open: number): string | null {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === "`") { i = endOfString(code, i); continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return code.slice(open + 1, i);
    i++;
  }
  return null;
}

const T = String.raw`(?:public\s*\.\s*)?"?(?:nodes|events|edges)"?(?![\w])`;
const SQL_FORMS: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\binsert\s+into\s+${T}`, "i"), "inserts into a memory table"],
  [new RegExp(String.raw`\bupdate\s+(?:only\s+)?${T}`, "i"), "updates a memory table"],
  [new RegExp(String.raw`\bmerge\s+into\s+${T}`, "i"), "merges into a memory table"],
  [new RegExp(String.raw`\bcopy\s+${T}`, "i"), "copies into a memory table"],
  [new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${T}`, "i"), "deletes from a memory table"],
  [new RegExp(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?${T}`, "i"), "truncates a memory table"],
  [/\b(?:insert\s+into|merge\s+into|delete\s+from|update|copy|truncate)\s*(?:\$\{|["'`]\s*\+)/i, "writes to a table whose name is not a literal"],
];
const FORBIDDEN_IDENTIFIERS: Array<[RegExp, string]> = [
  [/\bregistry\b/, "uses the verb registry"],
  [/\brunVerb\b/, "calls runVerb"],
  [/\.handler\s*\(/, "calls a verb handler"],
  [/\blinkNodes\b/, "uses linkNodes"],
  [/\binsertSelfNode\b/, "uses insertSelfNode"],
  [/\bsupersedeNode\b/, "uses supersedeNode"],
];

export function violations(source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];

  const joined = code.replace(/(["'`])\s*\+\s*(["'`])/g, ""); // "insert " + "into nodes" -> "insert into nodes"
  for (const [re, what] of SQL_FORMS) if (re.test(code) || re.test(joined)) out.push(what);
  for (const [re, what] of FORBIDDEN_IDENTIFIERS) if (re.test(code)) out.push(what);

  // imports, re-exports, dynamic import and require of anything under verbs/
  const checkSpec = (spec: string, clause: string | null) => {
    if (!/(^|\/)verbs\//.test(spec)) return;
    if (/\/verbs\/types\.js$/.test(spec)) return;
    if (/\/verbs\/common\.js$/.test(spec) && clause !== null && clause.replace(/\s+/g, " ").trim() === "{ appendEvent }") return;
    out.push(`imports ${spec}${clause === null ? "" : ` (${clause.replace(/\s+/g, " ").trim()})`}; only types.js and { appendEvent } from common.js are allowed`);
  };
  for (const m of code.matchAll(/\b(?:import|export)\b([^;"'`]*?)\bfrom\s*(["'])([^"']+)\2/g)) checkSpec(m[3]!, m[1]!);
  for (const m of code.matchAll(/\bimport\s*(["'])([^"']+)\1/g)) checkSpec(m[2]!, null);
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*(["'])([^"']+)\1/g)) checkSpec(m[2]!, null);
  if (/\b(?:import|require)\s*\(\s*[^"'\s]/.test(code)) out.push("imports a module by a non-literal specifier");

  // appendEvent: only direct calls with an object literal whose every kind: is a whitelisted literal
  for (const m of code.matchAll(/\bappendEvent\b/g)) {
    const after = code.slice(m.index! + m[0].length).match(/^\s*\(/);
    if (!after) {
      // the only bare mention allowed is the unaliased name inside `import { appendEvent } from ...` (checked above)
      const isImportClause = /import\s*\{\s*$/.test(code.slice(0, m.index!)) && /^\s*\}\s*from\b/.test(code.slice(m.index! + m[0].length));
      if (!isImportClause) out.push("appendEvent used other than as a direct call");
      continue;
    }
    const open = m.index! + m[0].length + after[0].length - 1;
    const args = parenBody(code, open);
    if (args === null) { out.push("appendEvent( call is not balanced"); continue; }
    if (!/^\s*[A-Za-z_$][\w$]*\s*,\s*\{/.test(args)) out.push("appendEvent( without an object literal argument");
    if (args.includes("...")) out.push("appendEvent( call contains a spread");
    if (/[{,]\s*\[/.test(args)) out.push("appendEvent( call contains a computed key");
    if (/[{,]\s*kind\s*[,}]/.test(args)) out.push("appendEvent( call uses a shorthand kind");
    const kinds = [...args.matchAll(/(?:^|[\s,{])["'`]?kind["'`]?\s*:\s*([^,}]*)/g)];
    if (kinds.length === 0) out.push("appendEvent( without a kind");
    for (const k of kinds) {
      const v = /^\s*(["'`])([^"'`$\\]*)\1\s*$/.exec(k[1]!);
      if (!v) out.push(`appendEvent( with a kind that is not a string literal (${k[1]!.trim()})`);
      else if (!WHITELISTED_KINDS.includes(v[2]!)) out.push(`appendEvent( with kind "${v[2]}" (allowed: ${WHITELISTED_KINDS.join(", ")})`);
    }
  }
  return out;
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
    it("the noticing tables", () => {
      expect(violations(`await tx.query("insert into noticings (a) values (1)"); await tx.query("update noticings set status = 'expired'"); await tx.query("insert into extractor_models (a)")`)).toEqual([]);
      expect(violations(`await tx.query("select id from nodes where id = $1"); await tx.query("select * from events e join edges d on true")`)).toEqual([]);
      expect(violations(`on conflict (id) do update set status = excluded.status`)).toEqual([]);
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
});
