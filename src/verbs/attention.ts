// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { PoolClient } from "pg";
import { DESIRE_NODE, VOW_NODE } from "./self_common.js";

/**
 * Attention: what this mind is carrying right now, computed on read from projections it already writes, plus its pins.
 * Arithmetic only: no model, no proposal, nothing written. The verb is mind_attend (mind_attend.ts); this file holds the
 * weight formula and the item collectors, which mind_orient, mind_weather and the extractor's pass reach through the verb
 * or through `collectAttention` / `attendedIds`.
 */

/** What the collectors need: a transaction scoped to the mind, the mind, and a clock. A VerbContext and a PassContext both fit. */
export interface AttentionCtx {
  tx: PoolClient;
  mind_id: string;
  now: () => Date;
}

/** The kinds of thing a pin can name (the `item_type` of attention_pins). */
export const PIN_TYPES = ["loop", "thread", "task", "desire", "declaration", "noticing", "node", "event"] as const;
export type PinType = (typeof PIN_TYPES)[number];

/**
 * The `type` an item carries in the list. Two are not pin types: a `repair` is a noticing of kind repair (pinned as a
 * noticing), and a `sit` is a node or event held in the active or processing charge state (pinned as that node or event).
 */
export type ItemType = PinType | "repair" | "sit";

// ---------------------------------------------------------------------------------------------------------------
// The weight
//
//   w = clamp(0.35 * recency + 0.25 * charge + 0.20 * kind + 0.20 * pin, 0, 1)
//
// Every term is in 0..1 and the four coefficients add to 1, so a weight is already in 0..1; the clamp only guards float noise.

/** Recency: how fresh the item is. The weight of recency in the sum: more than anything else, because what a mind touched lately is what it is carrying. */
export const W_RECENCY = 0.35;
/** Charge: how much the item itself weighs (its urgency, intensity, salience or score). A quarter: it ranks within a kind and across kinds. */
export const W_CHARGE = 0.25;
/** Kind: a fixed prior per type of thing, so an open declaration outranks a bare noticing at equal freshness and charge. A fifth. */
export const W_KIND = 0.2;
/** Pin: the mind said "keep this in view". A fifth: enough to float a pinned item over its peers, not enough to pin a stale low-charge thing above a burning one. */
export const W_PIN = 0.2;
/** Recency decays as exp(-age_days / RECENCY_DAYS): a week-old item keeps about 37%, a month-old one about 1%. */
export const RECENCY_DAYS = 7;

/**
 * The per-type prior for the kind term. A declared change to who the mind is (cooling) outranks everything; a loop is a thing the
 * mind chose to track; a sit is a charge it chose to hold; tasks and repairs ask for action; threads and desires are background
 * concerns; a noticing is only a suggestion. A pinned bare node or event is not in the specification's table: it gets the neutral
 * 0.5 (the pin term, not the kind, is why it is here).
 */
export const KIND_PRIOR: Record<ItemType, number> = {
  declaration: 1.0,
  loop: 0.9,
  sit: 0.8,
  task: 0.7,
  repair: 0.7,
  thread: 0.6,
  desire: 0.5,
  noticing: 0.4,
  node: 0.5,
  event: 0.5,
};

/** Charge by name, one table per source of charge. A loop: burning 1.0, nagging 0.5. */
export const LOOP_CHARGE: Record<string, number> = { burning: 1.0, nagging: 0.5 };
/** A task: urgent 1.0, high 0.7, normal 0.4, low 0.2. A thread's priority reads the same way (it has no urgent). */
export const PRIORITY_CHARGE: Record<string, number> = { urgent: 1.0, high: 0.7, normal: 0.4, low: 0.2 };
/** A held charge: processing 0.8, active 0.6. */
export const SIT_CHARGE: Record<string, number> = { processing: 0.8, active: 0.6 };
/** A declaration still cooling carries full charge. */
export const DECLARATION_CHARGE = 1.0;
/** A pinned node or event: its texture salience (foundational 1, active 0.7, background 0.4, archive 0.1), or this when it has none. */
export const SALIENCE_CHARGE: Record<string, number> = { foundational: 1.0, active: 0.7, background: 0.4, archive: 0.1 };
export const UNSET_CHARGE = 0.5;

const DAY_MS = 86_400_000;
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export interface WeightInput {
  /** created or last touched */
  since: Date;
  now: Date;
  /** 0..1 */
  charge: number;
  type: ItemType;
  pinned: boolean;
  /** overrides the type's kind prior */
  kind?: number;
}

/** The terms of a weight, for tests and for anyone asking why an item sits where it does. */
export function weightTerms(i: WeightInput): { recency: number; charge: number; kind: number; pin: number } {
  const ageDays = Math.max(0, i.now.getTime() - i.since.getTime()) / DAY_MS;
  return {
    recency: Math.exp(-ageDays / RECENCY_DAYS), // 1 for something touched just now, 1/e after a week
    charge: clamp01(i.charge), // the item's own urgency, intensity, salience or score
    kind: i.kind ?? KIND_PRIOR[i.type], // the fixed per-type prior above (the higher of two when one thing is two kinds of item)
    pin: i.pinned ? 1 : 0, // 1.0 when the mind pinned it, else 0
  };
}

/** w = clamp(0.35 * recency + 0.25 * charge + 0.20 * kind + 0.20 * pin), to six decimals so that float noise never decides an order. */
export function attentionWeight(i: WeightInput): number {
  const t = weightTerms(i);
  const w = clamp01(W_RECENCY * t.recency + W_CHARGE * t.charge + W_KIND * t.kind + W_PIN * t.pin);
  return Math.round(w * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------------------------------------------
// The items

/** Per type, the newest this many are considered (older ones have decayed to almost nothing; the cap keeps a very full mind cheap). */
export const CAP_PER_TYPE = 500;
/** How many of the top items count as "attended" for the extractor. */
export const ATTENDED_TOP = 12;

export interface RawItem {
  type: ItemType;
  /**
   * The pin types that name this item (a repair is pinned as a noticing; a sit as the node or event it holds). A node-backed item
   * (a desire, a vow with a declared break, a held node) is named by its own type and by `node`.
   */
  pin_types: PinType[];
  id: string;
  label: string;
  since: Date;
  charge: number;
  /** a kind prior that replaces the type's own (set when two sources of one thing are merged) */
  kind?: number;
  /** the nodes and events this item rests on (for the extractor); may include ids that are neither */
  sources: string[];
}

export interface AttentionItem extends RawItem {
  weight: number;
  pinned: boolean;
  note: string | null;
}

export interface PinRow {
  id: string;
  item_type: PinType;
  item_id: string;
  note: string | null;
  pinned_event_id: string;
  pinned_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (...xs: Array<unknown>): string[] => xs.filter((x): x is string => typeof x === "string" && UUID.test(x)).map((x) => x.toLowerCase());
const short = (s: string, max: number): string => Array.from(s.replace(/\s+/g, " ").trim()).slice(0, max).join("");
const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
/** a missing `only` filter binds null, which every query reads as "all" */
const only = (ids: string[] | null): string[] | null => ids;

type Collector = (c: AttentionCtx, ids: string[] | null) => Promise<RawItem[]>;

const loops: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; label: string; urgency: string; created_at: Date; created_event_id: string }>(
    `select id, label, urgency, created_at, created_event_id from loops
      where mind_id = $1 and resolved_at is null and ($2::uuid[] is null or id = any($2))
      order by created_at desc, id limit ${CAP_PER_TYPE}`,
    [c.mind_id, only(ids)],
  );
  // a loop is only ever created and resolved (no reopen yet), so its last touch is its creation
  return r.rows.map((x) => ({
    type: "loop", pin_types: ["loop"], id: x.id, label: x.label, since: x.created_at,
    charge: LOOP_CHARGE[x.urgency] ?? 0.5, sources: uuids(x.created_event_id),
  }));
};

const threads: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; label: string; priority: string; updated_at: Date; created_event_id: string }>(
    `select id, label, priority, updated_at, created_event_id from threads
      where mind_id = $1 and status = 'active' and ($2::uuid[] is null or id = any($2))
      order by updated_at desc, id limit ${CAP_PER_TYPE}`,
    [c.mind_id, only(ids)],
  );
  return r.rows.map((x) => ({
    type: "thread", pin_types: ["thread"], id: x.id, label: x.label, since: x.updated_at,
    charge: PRIORITY_CHARGE[x.priority] ?? 0.4, sources: uuids(x.created_event_id),
  }));
};

const tasks: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; title: string; priority: string; updated_at: Date; created_event_id: string }>(
    `select id, title, priority, updated_at, created_event_id from tasks
      where mind_id = $1 and status in ('open', 'in_progress', 'blocked') and ($2::uuid[] is null or id = any($2))
      order by updated_at desc, id limit ${CAP_PER_TYPE}`,
    [c.mind_id, only(ids)],
  );
  return r.rows.map((x) => ({
    type: "task", pin_types: ["task"], id: x.id, label: x.title, since: x.updated_at,
    charge: PRIORITY_CHARGE[x.priority] ?? 0.4, sources: uuids(x.created_event_id),
  }));
};

const desires: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; label: string; created_at: Date; intensity: string | null; event_id: string | null }>(
    `select id, label, created_at, case when jsonb_typeof(metadata->'intensity') = 'number' then metadata->>'intensity' end as intensity,
            metadata->>'event_id' as event_id
       from nodes
      where mind_id = $1 and node_type = '${DESIRE_NODE}' and invalidated_at is null
        and coalesce((metadata->'fulfilled') = 'true'::jsonb, false) = false
        and coalesce((metadata->'faded') = 'true'::jsonb, false) = false
        and ($2::uuid[] is null or id = any($2))
      order by created_at desc, id limit ${CAP_PER_TYPE}`,
    [c.mind_id, only(ids)],
  );
  // mind_desire stores intensity as 0..1 (the specification's "intensity / 10" assumed 0..10); a value above 1 is read as 0..10
  return r.rows.map((x) => {
    const n = num(x.intensity) ?? 0.5;
    return { type: "desire", pin_types: ["desire", "node"], id: x.id, label: x.label, since: x.created_at, charge: n > 1 ? n / 10 : n, sources: uuids(x.id, x.event_id) };
  });
};

/** Open identity declarations: accepted rewrites and retirements that have not settled or been withdrawn, and vows with a declared break. */
const declarations: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; label: string; since: Date; declared_at: string | null; node_id: string | null; event_id: string | null; vow: boolean }>(
    `select p.id, p.section as label, p.created_at as since, null::text as declared_at, p.target_node_id::text as node_id, p.event_id::text as event_id, false as vow
       from proposals p
      where p.mind_id = $1 and p.status = 'accepted' and p.settled_at is null and p.withdrawn_at is null
        and ($2::uuid[] is null or p.id = any($2))
     union all
     select n.id, n.label, n.created_at, n.metadata->'break_declared'->>'declared_at', n.id::text, n.metadata->'break_declared'->>'event_id', true
       from nodes n
      where n.mind_id = $1 and n.node_type = '${VOW_NODE}' and n.invalidated_at is null
        and jsonb_typeof(n.metadata->'break_declared') = 'object'
        and ($2::uuid[] is null or n.id = any($2))
      order by since desc, id limit ${CAP_PER_TYPE}`,
    [c.mind_id, only(ids)],
  );
  return r.rows.map((x) => {
    const d = x.declared_at === null ? NaN : Date.parse(x.declared_at);
    return {
      type: "declaration", pin_types: x.vow ? ["declaration", "node"] : ["declaration"], id: x.id, label: x.label,
      since: Number.isNaN(d) ? x.since : new Date(d), charge: DECLARATION_CHARGE, sources: uuids(x.node_id, x.event_id),
    };
  });
};

/** The noticings the mind may see: pending, recorded at stage propose, not expired; repairs whatever the extractor's state, the rest only while the operator's stage is propose. */
const noticings: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; kind: string; payload: Record<string, unknown> | null; score: number; sources: string[]; created_at: Date }>(
    `select n.id, n.kind, n.payload, n.score, n.sources, n.created_at from noticings n
      where n.mind_id = $1 and n.status = 'pending' and n.stage = 'propose' and n.expires_at > $3
        and (n.kind = 'repair' or exists (select 1 from extractor_state s where s.mind_id = n.mind_id and s.stage = 'propose'))
        and ($2::uuid[] is null or n.id = any($2))
      order by n.created_at desc, n.id limit ${CAP_PER_TYPE}`,
    [c.mind_id, only(ids), c.now()],
  );
  return r.rows.map((x) => {
    const p = x.payload !== null && typeof x.payload === "object" ? x.payload : {};
    const s = (k: string): string | null => (typeof p[k] === "string" && (p[k] as string).trim() !== "" ? (p[k] as string) : null);
    const repair = x.kind === "repair";
    const label = repair
      ? `repair: ${s("dependant_type") ?? "node"} ${s("relation") ?? "depends"} a ${s("upstream_state") ?? "changed"} node`
      : `${x.kind}: ${short(s("label") ?? s("summary") ?? s("content") ?? s("reason") ?? "", 100)}`.trimEnd();
    return {
      type: repair ? "repair" : "noticing", pin_types: ["noticing"], id: x.id, label, since: x.created_at,
      charge: clamp01(x.score), sources: uuids(...x.sources),
    } satisfies RawItem;
  });
};

/** Charges in active or processing (mind_sit): the node or event held. A node no longer live is not carried. */
const sits: Collector = async (c, ids) => {
  const r = await c.tx.query<{ subject_id: string; subject_kind: "node" | "event"; state: string; updated_at: Date; node_label: string | null; ev_kind: string | null; ev_text: string | null }>(
    `select h.subject_id, h.subject_kind, h.state, h.updated_at, n.label as node_label, e.kind as ev_kind,
            left(coalesce(e.payload->>'text', e.payload->>'content', e.payload->>'label', ''), 80) as ev_text
       from holdings h
       left join nodes n on h.subject_kind = 'node' and n.id = h.subject_id and n.mind_id = h.mind_id and n.invalidated_at is null
       left join events e on h.subject_kind = 'event' and e.id = h.subject_id and e.mind_id = h.mind_id
      where h.mind_id = $1 and h.state in ('active', 'processing') and ($2::uuid[] is null or h.subject_id = any($2))
        and (n.id is not null or e.id is not null)
      order by h.updated_at desc, h.subject_id limit ${CAP_PER_TYPE}`,
    [c.mind_id, only(ids)],
  );
  return r.rows.map((x) => ({
    type: "sit", pin_types: [x.subject_kind], id: x.subject_id,
    label: x.subject_kind === "node" ? (x.node_label ?? "") : eventLabel(x.ev_kind ?? "event", x.ev_text ?? ""),
    since: x.updated_at, charge: SIT_CHARGE[x.state] ?? 0.6, sources: [x.subject_id],
  }));
};

/** An event is labelled by its kind and the first 80 characters of its words. */
const eventLabel = (kind: string, text: string): string => {
  const t = short(text, 80);
  return t === "" ? kind : `${kind}: ${t}`;
};

const textureCharge = (sal: unknown): number => (typeof sal === "string" && sal in SALIENCE_CHARGE ? SALIENCE_CHARGE[sal]! : UNSET_CHARGE);

/** A node as an item of its own (a pinned node): live nodes only. */
const nodeItems: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; label: string; created_at: Date; sal: string | null }>(
    `select id, label, created_at, metadata->'texture'->>'salience' as sal from nodes
      where mind_id = $1 and invalidated_at is null and id = any($2::uuid[])`,
    [c.mind_id, ids ?? []],
  );
  return r.rows.map((x) => ({
    type: "node", pin_types: ["node"], id: x.id, label: x.label, since: x.created_at, charge: textureCharge(x.sal), sources: [x.id],
  }));
};

/** An event as an item of its own (a pinned event). */
const eventItems: Collector = async (c, ids) => {
  const r = await c.tx.query<{ id: string; kind: string; created_at: Date; sal: string | null; text: string | null }>(
    `select id, kind, created_at, texture->>'salience' as sal,
            left(coalesce(payload->>'text', payload->>'content', payload->>'label', ''), 80) as text
       from events where mind_id = $1 and id = any($2::uuid[])`,
    [c.mind_id, ids ?? []],
  );
  return r.rows.map((x) => ({
    type: "event", pin_types: ["event"], id: x.id, label: eventLabel(x.kind, x.text ?? ""), since: x.created_at,
    charge: textureCharge(x.sal), sources: [x.id],
  }));
};

/** The collector that decides whether a thing of this pin type exists and is live (the same rule the list uses). */
const BY_PIN_TYPE: Record<PinType, Collector> = {
  loop: loops, thread: threads, task: tasks, desire: desires, declaration: declarations, noticing: noticings, node: nodeItems, event: eventItems,
};

/** The thing this id names, if it is a live item of that pin type for this mind; null otherwise. */
export async function liveItem(c: AttentionCtx, type: PinType, id: string): Promise<RawItem | null> {
  const rows = await BY_PIN_TYPE[type](c, [id.toLowerCase()]);
  return rows.find((x) => x.id === id.toLowerCase()) ?? null;
}

export async function livePins(c: AttentionCtx): Promise<PinRow[]> {
  const r = await c.tx.query<PinRow>(
    `select id, item_type, item_id, note, pinned_event_id, pinned_at from attention_pins
      where mind_id = $1 and released_at is null order by pinned_at, id`,
    [c.mind_id],
  );
  return r.rows;
}

/** Which type label wins when one thing is several kinds of item: declaration > desire > sit (> node, event). */
const LABEL_RANK: Partial<Record<ItemType, number>> = { declaration: 4, desire: 3, sit: 2, node: 1, event: 1 };

/**
 * One thing is one item. A desire, a vow with a declared break, a held charge and a pinned node or event can all be the same node
 * (or event), and they share its id; they are merged into one item. The type label is the highest of declaration > desire > sit, and
 * its label, with `since` the latest of the two (last touch wins), the charge and kind prior the higher of the two, the sources
 * and the pin types the union (so a pin of type `node` or of the item's own type marks it). Items with distinct ids are untouched.
 * (Proposal declarations, loops, threads, tasks and noticings have ids of their own tables and never collide.)
 */
function mergeByThing(raw: RawItem[]): RawItem[] {
  const out = new Map<string, RawItem>();
  for (const x of raw) {
    const have = out.get(x.id);
    if (!have) {
      out.set(x.id, x);
      continue;
    }
    const win = (LABEL_RANK[x.type] ?? 0) > (LABEL_RANK[have.type] ?? 0) ? x : have;
    out.set(x.id, {
      ...win,
      since: x.since.getTime() > have.since.getTime() ? x.since : have.since,
      charge: Math.max(x.charge, have.charge),
      sources: [...new Set([...have.sources, ...x.sources])],
      pin_types: [...new Set([...have.pin_types, ...x.pin_types])],
      // the higher kind prior of the two sources, whatever label won
      kind: Math.max(have.kind ?? KIND_PRIOR[have.type], x.kind ?? KIND_PRIOR[x.type]),
    });
  }
  return [...out.values()];
}

export interface AttentionSet {
  /** every live item, heaviest first */
  items: AttentionItem[];
  /** live pins, whether or not the pinned thing is still an item */
  pins: PinRow[];
}

/**
 * The whole attention set at the clock's `now`: one query per item type (loops, threads, tasks, desires, declarations,
 * noticings, sits), one for the live pins, and one each for a pinned node or event that is not already an item. Ordered by
 * weight desc, then `since` desc, then id. A pin names a thing; a pin whose thing is no longer live (a resolved loop, an
 * archived thread, a settled declaration, a decided noticing, an invalidated node) adds nothing: it stays in `pins` until released.
 */
export async function collectAttention(c: AttentionCtx): Promise<AttentionSet> {
  const now = c.now();
  const raw: RawItem[] = [];
  for (const col of [loops, threads, tasks, desires, declarations, noticings, sits]) raw.push(...(await col(c, null)));
  const merged = mergeByThing(raw);
  const pins = await livePins(c);
  const pinFor = new Map(pins.map((p) => [`${p.item_type}:${p.item_id}`, p]));
  const have = new Set(merged.flatMap((x) => x.pin_types.map((t) => `${t}:${x.id}`)));
  // a pinned node or event that no other item already stands for is an item of its own
  for (const [type, col] of [["node", nodeItems], ["event", eventItems]] as const) {
    const want = pins.filter((p) => p.item_type === type && !have.has(`${type}:${p.item_id}`)).map((p) => p.item_id);
    if (want.length > 0) merged.push(...(await col(c, want)));
  }
  const items: AttentionItem[] = merged.map((x) => {
    const pin = x.pin_types.map((t) => pinFor.get(`${t}:${x.id}`)).find((p) => p !== undefined);
    const pinned = pin !== undefined;
    return { ...x, pinned, note: pin?.note ?? null, weight: attentionWeight({ since: x.since, now, charge: x.charge, type: x.type, pinned, ...(x.kind === undefined ? {} : { kind: x.kind }) }) };
  });
  items.sort((a, b) => b.weight - a.weight || b.since.getTime() - a.since.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, pins };
}

/**
 * The ids the extractor treats as new for the current run: every live pin of type node or event (whether or not the pinned thing is
 * still an item), and the `sources` of the top ATTENDED_TOP attention items: a desire's node and the event that registered it, a held
 * charge's subject, a noticing's sources, a proposal declaration's target node and event (a vow break: the vow and its break event),
 * and the event that opened a loop, thread or task. Ids that are not nodes or events of the extractor's window are simply never matched.
 */
export async function attendedIds(c: AttentionCtx): Promise<Set<string>> {
  const { items, pins } = await collectAttention(c);
  const out = new Set<string>();
  for (const p of pins) if (p.item_type === "node" || p.item_type === "event") out.add(p.item_id.toLowerCase());
  for (const it of items.slice(0, ATTENDED_TOP)) for (const s of it.sources) out.add(s.toLowerCase());
  return out;
}

/** Weather's reading of the same set. */
export async function attentionLoad(c: AttentionCtx): Promise<{ items: number; pinned: number; top_weight: number }> {
  const { items } = await collectAttention(c);
  return { items: items.length, pinned: items.filter((x) => x.pinned).length, top_weight: items[0]?.weight ?? 0 };
}
