// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * The static scanner shared by the extractor guard (test/extractor_guard.test.ts) and the dream guard (test/dream_guard.test.ts).
 * It lives outside any *.test.ts file so importing it does not make vitest register the other guard's suite. See the comment at
 * the top of extractor_guard.test.ts for what it checks.
 */
export const WHITELISTED_KINDS = ["notice.proposed", "notice.expired", "notice.model.trained"];

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
  // repair_work: the extractor may only claim and acknowledge (update); the rows are inserted by verbs in the invalidating transaction and by the operator's backfill
  [/\b(?:insert\s+into|merge\s+into|copy)\s+(?:public\s*\.\s*)?"?repair_work"?(?![\w])/i, "inserts into repair_work (only verbs and the operator backfill insert work)"],
  [/\b(?:delete\s+from|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\s*\.\s*)?"?repair_work"?(?![\w])/i, "deletes from repair_work"],
];
const FORBIDDEN_IDENTIFIERS: Array<[RegExp, string]> = [
  [/\bregistry\b/, "uses the verb registry"],
  [/\brunVerb\b/, "calls runVerb"],
  [/\.handler\s*\(/, "calls a verb handler"],
  [/\blinkNodes\b/, "uses linkNodes"],
  [/\binsertSelfNode\b/, "uses insertSelfNode"],
  [/\bsupersedeNode\b/, "uses supersedeNode"],
];

export function violations(source: string, whitelist: readonly string[] = WHITELISTED_KINDS): string[] {
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
      else if (!whitelist.includes(v[2]!)) out.push(`appendEvent( with kind "${v[2]}" (allowed: ${whitelist.join(", ")})`);
    }
  }
  return out;
}
