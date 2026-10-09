// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { PoolClient } from "pg";
import { SALIENCE_VALUE, type NoticingKind } from "./features.js";

/**
 * Candidate generation: deterministic, no model. Given the ledger and graph rows of one mind since a point in time, it
 * proposes what MAY belong together. It reads (select only) and returns plain objects; nothing here writes.
 *
 * Eligibility, stated so it can be argued with:
 *  - Only rows the mind itself wrote (`written_by` = the mind): a write grantee's words are not the mind's to be nudged about.
 *  - Events: those with text (`payload.text` or `payload.content`) and a vector, other than the bookkeeping kinds
 *    `notice.*` and `daemon.*`, the kinds an accepted proposal leaves behind (`pattern`, `distill`), and letters (`letter.*`).
 *  - Nodes (links only): live, with a vector, other than the protected self nodes (identity, vow, anchor, desire).
 *  - At most MAX_ROWS of each, the newest, so one very busy week cannot make the pairwise work large (400 rows is 80 000 pairs).
 * Time: a row is NEW when it was appended (`created_at`) at or after `newStart` (the last completed run, never more than seven
 * days back). Rows are compared against every eligible row from the lookback (EXTRACTOR_LOOKBACK_DAYS, default 30), so a new node
 * can link to one from three weeks ago and a pattern can recur across days. Every candidate must contain at least one new row
 * (a metabolized `sit` resolved since `newStart` counts as the new fact for its own distillation); clusters may mix new and older rows.
 * Attention: a row the mind is attending to (`Window.attended`: its pinned nodes and events, and what its top attention items rest
 * on) counts as new for this run whatever its age, so attended things are noticed sooner, and carries `attended` for the feature of
 * that name. It must still be eligible and inside the lookback and the newest-400 cap: attention changes what is new, not what is eligible.
 */
export const LINK_COSINE = 0.6;
export const CLUSTER_COSINE = 0.55;
export const MIN_PATTERN = 3;
export const MIN_DISTILLATION = 2;
export const MAX_CLUSTER = 12;
export const MAX_ROWS = 400;
export const HIGH_SALIENCE = 0.7;
const RELATED_PER_SIT = 4;
const SUMMARY_PIECE = 240;
const SUMMARY_MAX = 1000;
const LABEL_MAX = 80;
const SELF_NODE_TYPES = ["identity", "vow", "anchor", "desire"];

export interface Item {
  id: string;
  type: "event" | "node";
  text: string;
  vec: Float32Array | null;
  norm: number;
  created_at: Date;
  context: string | null;
  /** `session:<id>` */
  keys: string[];
  charge: string[];
  salience: number | null;
  /** appended since the last completed run, or attended to (see Window.attended) */
  isNew: boolean;
  /** the mind is attending to this row: pinned, or under a top attention item */
  attended: boolean;
}

export interface Window {
  /** the lookback start: older eligible rows are compared from here */
  start: Date;
  /** rows appended at or after this are new */
  newStart: Date;
  end: Date;
  /** ids of nodes and events the mind is attending to: treated as new for this run. Absent means none. */
  attended?: ReadonlySet<string>;
}

export interface Candidate {
  kind: NoticingKind;
  /** chronological (created_at, then id) */
  items: Item[];
  payload: Record<string, unknown>;
  /** the cosine feature */
  cosine: number;
  /** cheap pre-rerank rank, for the per-kind cap */
  rank: number;
  key: string;
}

export interface Loaded {
  events: Item[];
  nodes: Item[];
  /** `<lower id>|<higher id>` of every pair of window nodes that already share an edge, either direction */
  edgePairs: Set<string>;
  /** subjects of `sit`s resolved as metabolized since the window start, with their text (an event or a node) */
  metabolized: Item[];
}

// ---------- small helpers ----------

export const snippetOf = (s: string, max = SUMMARY_PIECE): string => Array.from(s.replace(/\s+/g, " ").trim()).slice(0, max).join("");
export const sourceKey = (kind: string, ids: readonly string[]): string => `${kind}:${[...ids].sort().join(",")}`;
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
const byTime = (a: Item, b: Item): number => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function parseVec(text: string | null): { vec: Float32Array | null; norm: number } {
  if (!text) return { vec: null, norm: 0 };
  try {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return { vec: null, norm: 0 };
    const vec = Float32Array.from(arr as number[]);
    let s = 0;
    for (const x of vec) {
      if (!Number.isFinite(x)) return { vec: null, norm: 0 };
      s += x * x;
    }
    const norm = Math.sqrt(s);
    return norm > 0 ? { vec, norm } : { vec: null, norm: 0 };
  } catch {
    return { vec: null, norm: 0 };
  }
}

export function cosine(a: Item, b: Item): number | null {
  if (!a.vec || !b.vec || a.vec.length !== b.vec.length) return null;
  let d = 0;
  for (let i = 0; i < a.vec.length; i++) d += a.vec[i]! * b.vec[i]!;
  return d / (a.norm * b.norm);
}

function textureOf(t: unknown): { charge: string[]; salience: number | null } {
  if (t === null || typeof t !== "object" || Array.isArray(t)) return { charge: [], salience: null };
  const o = t as { charge?: unknown; salience?: unknown };
  const charge = Array.isArray(o.charge) ? [...new Set(o.charge.filter((x): x is string => typeof x === "string" && x !== ""))].sort() : [];
  const salience = typeof o.salience === "string" && o.salience in SALIENCE_VALUE ? SALIENCE_VALUE[o.salience]! : null;
  return { charge, salience };
}

/** Co-occurrence keys: sessions only. A shared context has its own feature (shared_context), so it is not counted twice. */
function keysOf(session: string | null): string[] {
  return session ? [`session:${session}`] : [];
}

/** Mean pairwise cosine of the items that have vectors (0 when fewer than two pairs can be measured). */
export function meanCosine(items: Item[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const c = cosine(items[i]!, items[j]!);
      if (c !== null) {
        sum += c;
        n++;
      }
    }
  }
  return n === 0 ? 0 : sum / n;
}

// ---------- loading ----------

interface EventRow {
  id: string; text: string; created_at: Date; context: string | null; session_id: string | null; texture: unknown; emb: string | null;
}
interface NodeRow {
  id: string; text: string; created_at: Date; context: string | null; session_id: string | null; texture: unknown; emb: string | null;
}

const eventItem = (r: EventRow, w: Window): Item => {
  const attended = w.attended?.has(r.id) === true;
  return {
    id: r.id, type: "event", text: r.text, ...parseVec(r.emb), created_at: r.created_at, context: r.context,
    keys: keysOf(r.session_id), ...textureOf(r.texture), isNew: attended || r.created_at.getTime() >= w.newStart.getTime(), attended,
  };
};
const nodeItem = (r: NodeRow, w: Window): Item => {
  const attended = w.attended?.has(r.id) === true;
  return {
    id: r.id, type: "node", text: r.text, ...parseVec(r.emb), created_at: r.created_at, context: r.context,
    keys: keysOf(r.session_id), ...textureOf(r.texture), isNew: attended || r.created_at.getTime() >= w.newStart.getTime(), attended,
  };
};

const EVENT_TEXT = `coalesce(nullif(btrim(payload->>'text'), ''), nullif(btrim(payload->>'content'), ''))`;
/** The eligibility filter for events, applied to every events query here (window rows and sit subjects alike). Parameter $1 is the mind. */
const EVENT_ELIGIBLE = `written_by = $1 and embedding is not null and ${EVENT_TEXT} is not null
        and kind not like 'notice.%' and kind not like 'daemon.%' and kind not like 'letter.%' and kind not in ('pattern', 'distill')`;
/** The same for nodes (alias n); $1 is the mind, the self-node types are $4 or a literal list. */
const NODE_ELIGIBLE = `n.written_by = $1 and n.invalidated_at is null and n.embedding is not null and nullif(btrim(n.content), '') is not null
        and n.node_type <> all('{${SELF_NODE_TYPES.join(",")}}'::text[])`;
const NODE_SESSION = `case when n.metadata->>'event_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (select e.session_id from events e where e.mind_id = n.mind_id and e.id = (n.metadata->>'event_id')::uuid) end`;

/** Reads the window. Select statements only; `tx` is scoped to the mind. */
export async function loadWindow(tx: PoolClient, mind: string, w: Window): Promise<Loaded> {
  const ev = await tx.query<EventRow>(
    `select id, left(${EVENT_TEXT}, 1000) as text, created_at, context, session_id, texture, embedding::text as emb
       from events
      where mind_id = $1 and created_at >= $2 and ${EVENT_ELIGIBLE}
      order by created_at desc, id limit $3`,
    [mind, w.start, MAX_ROWS],
  );
  const nd = await tx.query<NodeRow>(
    `select n.id, left(n.content, 1000) as text, n.created_at, n.metadata->>'context' as context, n.metadata->'texture' as texture,
            n.embedding::text as emb, ${NODE_SESSION} as session_id
       from nodes n
      where n.mind_id = $1 and n.created_at >= $2 and ${NODE_ELIGIBLE}
      order by n.created_at desc, n.id limit $3`,
    [mind, w.start, MAX_ROWS],
  );
  const nodes = nd.rows.map((r) => nodeItem(r, w)).sort(byTime);
  const ids = nodes.map((n) => n.id);
  const edgePairs = new Set<string>();
  if (ids.length >= 2) {
    const er = await tx.query<{ a: string; b: string }>(
      `select source_node_id as a, target_node_id as b from edges
        where mind_id = $1 and source_node_id = any($2::uuid[]) and target_node_id = any($2::uuid[])`,
      [mind, ids],
    );
    for (const r of er.rows) edgePairs.add(pairKey(r.a, r.b));
  }

  const held = await tx.query<{ subject_id: string; subject_kind: string }>(
    `select subject_id, subject_kind from holdings where mind_id = $1 and state = 'metabolized' and updated_at >= $2
      order by updated_at, subject_id limit 100`,
    [mind, w.newStart],
  );
  const metabolized: Item[] = [];
  const evIds = held.rows.filter((h) => h.subject_kind === "event").map((h) => h.subject_id);
  const ndIds = held.rows.filter((h) => h.subject_kind === "node").map((h) => h.subject_id);
  const subjects = new Map<string, Item>();
  // a sit subject must pass the same eligibility as everything else (the mind's own words, a memory kind, a vector)
  if (evIds.length > 0) {
    const r = await tx.query<EventRow>(
      `select id, left(${EVENT_TEXT}, 1000) as text, created_at, context, session_id, texture, embedding::text as emb
         from events where mind_id = $1 and id = any($2::uuid[]) and ${EVENT_ELIGIBLE}`,
      [mind, evIds],
    );
    for (const row of r.rows) subjects.set(row.id, eventItem(row, w));
  }
  if (ndIds.length > 0) {
    const r = await tx.query<NodeRow>(
      `select n.id, left(n.content, 1000) as text, n.created_at, n.metadata->>'context' as context, n.metadata->'texture' as texture,
              n.embedding::text as emb, ${NODE_SESSION} as session_id
         from nodes n where n.mind_id = $1 and n.id = any($2::uuid[]) and ${NODE_ELIGIBLE}`,
      [mind, ndIds],
    );
    for (const row of r.rows) subjects.set(row.id, nodeItem(row, w));
  }
  for (const h of held.rows) {
    const s = subjects.get(h.subject_id);
    if (s && s.vec !== null) metabolized.push(s);
  }
  return { events: ev.rows.map((r) => eventItem(r, w)).sort(byTime), nodes, edgePairs, metabolized };
}

// ---------- text for payloads ----------

const STOP = new Set(
  ("the and for are but not you all any can had her was one our out has have this that with from they been were will would there their what " +
    "about which when your said each she how its who did get may him his into than then them these those some such only over also just " +
    "like very more most much many being because while where after before again against between through during should could does done " +
    "i'm it's don't didn't can't").split(" "),
);

/** The commonest terms across the first lines of `texts`, in order of count then first appearance: a label, at most 80 characters. */
export function termsLabel(texts: string[]): string {
  const firstLines = texts.map((t) => (t.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim()).join(" ");
  const count = new Map<string, number>();
  for (const w of firstLines.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    count.set(w, (count.get(w) ?? 0) + 1);
  }
  const top = [...count.entries()]
    .map(([w, n], i) => ({ w, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, 4)
    .map((x) => x.w);
  const label = top.length > 0 ? top.join(", ") : snippetOf(texts[0] ?? "", LABEL_MAX);
  return Array.from(label).slice(0, LABEL_MAX).join("");
}

/** The first 240 characters of each source joined by " / ", at most 1000. */
export function summaryOf(items: Item[]): string {
  return Array.from(items.map((i) => snippetOf(i.text)).join(" / ")).slice(0, SUMMARY_MAX).join("");
}

// ---------- clustering ----------

/**
 * Greedy clusters: walk the items newest first; each unused item seeds a cluster of the unused items whose cosine to
 * the seed is at least `thr`, nearest first, each added only if it is also at least `thr` from every member already in
 * (so every pair in a cluster is, as the spec says, at least `thr`). Clusters of at least `min` that `keep` accepts are kept;
 * an item is in at most one kept cluster. Deterministic: ties break on id.
 */
export function clusters(items: Item[], thr: number, min: number, max = MAX_CLUSTER, keep: (c: Item[]) => boolean = () => true): Item[][] {
  const pool = items.filter((i) => i.vec !== null).sort((a, b) => byTime(b, a));
  const used = new Set<string>();
  const memo = new Map<string, number>();
  const cos = (a: Item, b: Item): number => {
    const k = pairKey(a.id, b.id);
    let v = memo.get(k);
    if (v === undefined) {
      v = cosine(a, b) ?? -1;
      memo.set(k, v);
    }
    return v;
  };
  const out: Item[][] = [];
  for (const seed of pool) {
    if (used.has(seed.id)) continue;
    const near = pool
      .filter((o) => o.id !== seed.id && !used.has(o.id))
      .map((o) => ({ o, c: cos(seed, o) }))
      .filter((x) => x.c >= thr)
      .sort((a, b) => b.c - a.c || (a.o.id < b.o.id ? -1 : 1));
    const members = [seed];
    for (const { o } of near) {
      if (members.length >= max) break;
      if (members.every((m) => cos(m, o) >= thr)) members.push(o);
    }
    if (members.length >= min && keep(members)) {
      for (const m of members) used.add(m.id);
      out.push(members.sort(byTime));
    }
  }
  return out;
}

// ---------- the three kinds ----------

function make(kind: NoticingKind, items: Item[], payload: Record<string, unknown>, rankBonus = 0): Candidate {
  const sorted = [...items].sort(byTime);
  const c = kind === "link" ? (cosine(sorted[0]!, sorted[1]!) ?? 0) : meanCosine(sorted);
  return { kind, items: sorted, payload, cosine: c, rank: c + rankBonus, key: sourceKey(kind, sorted.map((i) => i.id)) };
}

export function linkCandidates(loaded: Loaded, w: Window): Candidate[] {
  const out: Candidate[] = [];
  const n = loaded.nodes;
  for (let i = 0; i < n.length; i++) {
    for (let j = i + 1; j < n.length; j++) {
      const a = n[i]!;
      const b = n[j]!;
      const c = cosine(a, b);
      if (c === null || c < LINK_COSINE || (!a.isNew && !b.isNew) || loaded.edgePairs.has(pairKey(a.id, b.id))) continue;
      const shared = a.context !== null && a.context !== "" && a.context === b.context ? ` shared context "${snippetOf(a.context, 40)}"` : " no shared context";
      out.push(make("link", [a, b], { edge_type: "related_to", reason: `cosine ${c.toFixed(2)};${shared}` }));
    }
  }
  return out;
}

/** The window of a payload is the span of its sources (earliest to latest append), the period the pattern recurred across. */
function patternPayload(items: Item[]): Record<string, unknown> {
  const t = items.map((i) => i.created_at.getTime());
  return { label: termsLabel(items.map((i) => i.text)), summary: summaryOf(items), window: { start: new Date(Math.min(...t)).toISOString(), end: new Date(Math.max(...t)).toISOString() } };
}
const hasNew = (items: Item[]): boolean => items.some((i) => i.isNew);

export function patternCandidates(loaded: Loaded, w: Window): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (items: Item[]) => {
    const c = make("pattern", items, patternPayload([...items].sort(byTime)), 0.02 * items.length);
    if (!out.has(c.key)) out.set(c.key, c);
  };
  for (const g of clusters(loaded.events, CLUSTER_COSINE, MIN_PATTERN, MAX_CLUSTER, hasNew)) add(g);
  // three or more events sharing a context and a charge tag (one group per context and tag)
  const groups = new Map<string, Item[]>();
  for (const e of loaded.events) {
    if (!e.context) continue;
    for (const tag of e.charge) {
      const k = `${e.context}\u0000${tag}`;
      groups.set(k, [...(groups.get(k) ?? []), e]);
    }
  }
  for (const [, g] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (g.length >= MIN_PATTERN && hasNew(g)) {
      const newest = [...g].sort(byTime).slice(-MAX_CLUSTER);
      if (hasNew(newest)) add(newest);
    }
  }
  return [...out.values()];
}

export function distillationCandidates(loaded: Loaded, w: Window): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (items: Item[]) => {
    const sorted = [...items].sort(byTime);
    const c = make("distillation", sorted, {
      content: summaryOf(sorted),
      lineage: { noticing_source_event_ids: sorted.filter((i) => i.type === "event").map((i) => i.id) },
    }, 0.02 * sorted.length);
    if (!out.has(c.key)) out.set(c.key, c);
  };
  const high = loaded.events.filter((e) => (e.salience ?? 0) >= HIGH_SALIENCE);
  for (const g of clusters(high, CLUSTER_COSINE, MIN_DISTILLATION, MAX_CLUSTER, hasNew)) add(g);
  // a sit the mind metabolized in the window, with the window's events that read like it
  for (const s of loaded.metabolized) {
    const related = loaded.events
      .filter((e) => e.id !== s.id)
      .map((e) => ({ e, c: cosine(s, e) }))
      .filter((x): x is { e: Item; c: number } => x.c !== null && x.c >= CLUSTER_COSINE)
      .sort((a, b) => b.c - a.c || (a.e.id < b.e.id ? -1 : 1))
      .slice(0, RELATED_PER_SIT)
      .map((x) => x.e);
    add([s, ...related]);
  }
  return [...out.values()];
}

/** All three kinds, pre-rerank. Pure: the same rows give the same candidates in the same order. */
export function generateCandidates(loaded: Loaded, w: Window): Record<NoticingKind, Candidate[]> {
  return { link: linkCandidates(loaded, w), pattern: patternCandidates(loaded, w), distillation: distillationCandidates(loaded, w) };
}

/** Best first by the cheap rank, ties by key; the first `max`. */
export function capCandidates(cands: Candidate[], max: number): Candidate[] {
  return [...cands].sort((a, b) => b.rank - a.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, max);
}

/** The rerank query and documents for a candidate: the first source's opening against the others' text. */
export function rerankPair(c: Candidate): { query: string; documents: string[] } {
  return { query: snippetOf(c.items[0]!.text), documents: c.items.slice(1).map((i) => snippetOf(i.text, 600)) };
}

// ---------- dedupe ----------

export interface Existing {
  kind: string;
  sources: string[];
  status: string;
  stage: string;
  score: number;
  /** when the noticing lapsed, if it expired: the instant it was due to */
  expires_at: Date;
}

export type Verdict = { action: "new" } | { action: "blocked" } | { action: "repropose"; mustExceed: number };

/**
 * Same kind and same source set as a pending, accepted or rejected noticing: skip. As an expired one: not before
 * `days` after it expired, and then only if the new score is higher than the expired one's (`mustExceed`). A shadow-stage
 * expired noticing counts as nothing (the mind never saw it), so it does not hold a source set back; a pending shadow one does.
 */
export function verdictFor(existing: Existing[] | undefined, now: Date, days: number): Verdict {
  if (!existing || existing.length === 0) return { action: "new" };
  if (existing.some((e) => e.status === "pending" || e.status === "accepted" || e.status === "rejected")) return { action: "blocked" };
  const shown = existing.filter((e) => e.status === "expired" && e.stage === "propose");
  if (shown.length === 0) return { action: "new" };
  const at = (e: Existing) => e.expires_at.getTime();
  const latest = shown.reduce((a, b) => (at(b) > at(a) ? b : a));
  if (now.getTime() - at(latest) < days * 86_400_000) return { action: "blocked" };
  return { action: "repropose", mustExceed: latest.score };
}

export function indexExisting(rows: Existing[]): Map<string, Existing[]> {
  const m = new Map<string, Existing[]>();
  for (const r of rows) {
    const k = sourceKey(r.kind, r.sources);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}
