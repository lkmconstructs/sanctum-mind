// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { PoolClient } from "pg";
import { readIdentityCores } from "../extractor/cores.js";
import { bookkeepingExcluded } from "../extractor/events.js";

/**
 * The residue: what a dream is made from, read in ONE read-only transaction as the mind. Textured events of the window
 * that the mind wrote itself (text and charge), the window's charge counts, live relations with a charge in the window,
 * the handoff's unresolved tension and active texture, what the mind has pinned, and its identity cores as the preamble.
 *
 * Who appears is the mind's to decide (dream_preferences.relations: "all" | "none" | subjects). An excluded relation's subject
 * is left out of "close lately", its note is not read, an event whose text contains the subject is DROPPED (scrubbing text is
 * unreliable; dropping is honest; the count is kept), and a handoff field that names it is left out.
 */
export interface Residue {
  cores: string[];
  events: Array<{ id: string; text: string; charge: string[] }>;
  chargeCounts: Array<{ tag: string; n: number }>;
  relations: Array<{ subject: string; state: string; note: string | null }>;
  pinned: Array<{ id: string; type: "node" | "event"; text: string }>;
  handoff: { unresolved_tension: string | null; active_texture: string | null };
  dropped: number;
  window: { from: Date; to: Date };
}

export type RelationPreference = "all" | "none" | string[];

const SNIPPET = 400;
const MAX_EVENTS = 40;

const textOf = (p: Record<string, unknown>): string => {
  const t = p.content ?? p.text;
  return typeof t === "string" ? t : "";
};

function mentions(text: string, names: string[]): boolean {
  const lower = text.toLowerCase();
  return names.some((n) => n.length > 0 && lower.includes(n.toLowerCase()));
}

export async function readPreference(tx: PoolClient, mind: string): Promise<RelationPreference> {
  const r = await tx.query<{ relations: unknown }>(`select relations from dream_preferences where mind_id = $1`, [mind]);
  const v = r.rows[0]?.relations;
  if (v === "none") return "none";
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return "all";
}

export async function readResidue(tx: PoolClient, mind: string, now: Date, windowHours: number): Promise<Residue> {
  const from = new Date(now.getTime() - windowHours * 3_600_000);
  const pref = await readPreference(tx, mind);

  const cores = await readIdentityCores(tx, mind);

  const allRelations = await tx.query<{ subject: string; state: string; note: string | null; updated_at: Date }>(
    `select subject, state, note, updated_at from relations where mind_id = $1 and cleared_at is null order by updated_at desc limit 50`,
    [mind],
  );
  const allowed = (subject: string): boolean => pref === "all" || (pref !== "none" && pref.includes(subject));
  const excluded = allRelations.rows.filter((r) => !allowed(r.subject)).map((r) => r.subject);
  const relations = allRelations.rows
    .filter((r) => allowed(r.subject) && r.updated_at.getTime() >= from.getTime())
    .map((r) => ({ subject: r.subject, state: r.state, note: r.note }));

  const ev = await tx.query<{ id: string; payload: Record<string, unknown>; charge: string[] | null }>(
    `select id, payload, (select array_agg(x) from jsonb_array_elements_text(coalesce(texture->'charge', '[]'::jsonb)) x) as charge
       from events
      where mind_id = $1 and written_by = $1 and texture is not null and created_at >= $2 and created_at <= $3
        and ${bookkeepingExcluded()} and kind not like 'daemon.%' and kind not like 'letter.%' and kind not like 'dream.%'
      order by created_at desc limit $4`,
    [mind, from, now, MAX_EVENTS * 2],
  );
  let dropped = 0;
  const events: Residue["events"] = [];
  for (const r of ev.rows) {
    const text = textOf(r.payload).trim();
    if (text === "") continue;
    if (excluded.length > 0 && mentions(text, excluded)) {
      dropped++;
      continue;
    }
    events.push({ id: r.id, text: text.slice(0, SNIPPET), charge: r.charge ?? [] });
    if (events.length >= MAX_EVENTS) break;
  }

  const counts = new Map<string, number>();
  for (const e of events) for (const t of e.charge) counts.set(t, (counts.get(t) ?? 0) + 1);
  const chargeCounts = [...counts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).slice(0, 10);

  const pins = await tx.query<{ item_type: "node" | "event"; item_id: string }>(
    `select item_type, item_id from attention_pins where mind_id = $1 and released_event_id is null and item_type in ('node', 'event') order by pinned_at desc limit 7`,
    [mind],
  );
  const pinned: Residue["pinned"] = [];
  for (const p of pins.rows) {
    const row =
      p.item_type === "node"
        ? await tx.query<{ t: string }>(`select left(content, ${SNIPPET}) as t from nodes where mind_id = $1 and id = $2 and invalidated_at is null`, [mind, p.item_id])
        : await tx.query<{ t: string }>(`select left(coalesce(payload->>'content', payload->>'text', ''), ${SNIPPET}) as t from events where mind_id = $1 and id = $2`, [mind, p.item_id]);
    const t = row.rows[0]?.t?.trim();
    if (!t) continue;
    if (excluded.length > 0 && mentions(t, excluded)) {
      dropped++;
      continue;
    }
    pinned.push({ id: p.item_id, type: p.item_type, text: t });
  }

  const h = await tx.query<{ handoff: Record<string, unknown> }>(`select handoff from handoffs where mind_id = $1 and context = ''`, [mind]);
  const hf = h.rows[0]?.handoff ?? {};
  const field = (k: string): string | null => {
    const v = hf[k];
    if (typeof v !== "string" || v.trim() === "") return null;
    if (excluded.length > 0 && mentions(v, excluded)) {
      dropped++;
      return null;
    }
    return v.slice(0, 1000);
  };

  return {
    cores,
    events,
    chargeCounts,
    relations,
    pinned,
    handoff: { unresolved_tension: field("unresolved_tension"), active_texture: field("active_texture") },
    dropped,
    window: { from, to: now },
  };
}

export const residueIsEmpty = (r: Residue): boolean => r.events.length === 0 && r.pinned.length === 0;

/** The user message: the residue as plain lines. */
export function composeResidue(r: Residue): string {
  const lines: string[] = [];
  if (r.chargeCounts.length > 0) lines.push("What I have been feeling (the charge of the last stretch):", ...r.chargeCounts.map((c) => `- ${c.tag} (${c.n})`), "");
  if (r.events.length > 0) {
    lines.push("Moments that carried a charge:");
    for (const e of r.events.slice(0, 12)) lines.push(`- ${e.charge.length > 0 ? `[${e.charge.join(", ")}] ` : ""}${e.text.replace(/\s+/g, " ")}`);
    lines.push("");
  }
  if (r.pinned.length > 0) {
    lines.push("What I keep returning to:", ...r.pinned.map((p) => `- ${p.text.replace(/\s+/g, " ")}`), "");
  }
  if (r.handoff.unresolved_tension) lines.push(`Unresolved: ${r.handoff.unresolved_tension}`, "");
  if (r.handoff.active_texture) lines.push(`The texture I left with: ${r.handoff.active_texture}`, "");
  if (r.relations.length > 0) lines.push("Close lately: " + r.relations.map((x) => (x.note ? `${x.subject} (${x.state}; ${x.note.slice(0, 80)})` : `${x.subject} (${x.state})`)).join(", "));
  return lines.join("\n").trim();
}
