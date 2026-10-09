// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { randomUUID } from "node:crypto";
import { appendEvent } from "../verbs/common.js";
import type { DaemonPass } from "../daemon/passes/types.js";
import { extractorRepairBudget, noticingExpiresAt } from "./config.js";
import { bookkeepingExcluded, noticeProposedPayload } from "./events.js";
import { recordRun } from "./schedule.js";

/** Repairs proposed per upstream node per tick; the rest follow on the next tick (the offset on its work row holds the place). */
export const REPAIR_DEPENDANT_CAP = 25;
/** Work rows looked at per tick, so a large backfill of rewrites with few dependants cannot make one tick long. */
export const REPAIR_SCAN_CAP = 500;
const CONTEXT_EVENTS = 5;
const CONTEXT_EDGES = 5;

/**
 * The direction policy (CONTRACTS.md, "Belief repair"). D is a dependant of the invalidated upstream U when:
 *   derived_from, instance_of, corrects: the edge runs D -> U (D rests on U)                      score 1.0
 *   metadata.sources of D holds U; a noticing D was made from has U among its sources              score 1.0
 *   a replacement chain: D answered for U's predecessor and U is its replacement                  score 0.8
 *   supports, contradicts: an edge in either direction                                             score 0.6 (low-confidence review)
 * related_to, any other edge type (revien:* included), and the reverse of a dependency-direction edge are never a repair: they are
 * context, listed in the payload as `context_edges` (ids, at most five).
 */
const DEPENDENCY_EDGES = ["derived_from", "instance_of", "corrects"] as const;
const REVIEW_EDGES = ["supports", "contradicts"] as const;
/** When one dependant is reached by several relations, the first of these that applies is reported (so the best score applies). */
const PRIORITY = ["derived_from", "instance_of", "corrects", "sources", "noticing", "replacement", "supports", "contradicts"] as const;

/** The score a relation earns, or null when the relation is never a repair (context only). */
export function repairScore(relation: string): number | null {
  switch (relation) {
    case "derived_from": case "instance_of": case "corrects": case "sources": case "noticing":
      return 1.0;
    case "replacement":
      return 0.8;
    case "supports": case "contradicts":
      return 0.6;
    default:
      return null;
  }
}

interface Work {
  id: string;
  upstream_id: string;
  upstream_state: "superseded" | "retired";
  replacement_id: string | null;
  next_offset: number;
}

interface Reach {
  id: string;
  node_type: string;
  written_by: string;
  dead: boolean;
  relation: string;
  metadata: Record<string, unknown>;
}

const rank = (relation: string): number => {
  const i = (PRIORITY as readonly string[]).indexOf(relation);
  return i === -1 ? PRIORITY.length : i;
};

/** True when the dependant already answered for this upstream (a kept review, or the replacement a repair made): it is not asked again. */
function reviewed(metadata: Record<string, unknown>, upstream: string): boolean {
  if (metadata.upstream_id === upstream) return true;
  const r = metadata.repair_reviewed;
  return Array.isArray(r) && r.some((x) => typeof x === "object" && x !== null && (x as { upstream_id?: unknown }).upstream_id === upstream);
}

/**
 * `notice.repair`: belief repair. Deterministic (no model, no scorer), every tick, for every mind whose daemon runs, whether or not
 * the operator has enabled the extractor. Every invalidation of a node (superseded by `mind_rethink`, a settled identity rewrite or a
 * repair's rethink; retired by a settled identity retirement or a repair) wrote a `repair_work` row in the transaction that did it, so
 * this pass does not scan timestamps and commit timing cannot hide an upstream from it. Each tick, under the per-mind daemon lock, it
 * takes the undone work rows oldest first; for each it computes the dependants (the direction policy above), leaves out those it has
 * already put to the mind, and proposes a `repair` noticing (sources [dependant, upstream]) for each until it has made 25 for that
 * upstream or the tick's budget (`EXTRACTOR_REPAIR_BUDGET`, default 50) is spent. It then records its progress on the row
 * (`next_offset`, the number of repairs proposed for the upstream so far) or finishes it (`done_at`). The mind answers keep, rethink
 * or retire through `mind_notice accept`.
 *
 * This pass writes only noticings, `notice.proposed` events, an `extractor_runs` row and the progress columns of `repair_work`
 * (updates: claim and acknowledge); it never inserts work (verbs and the operator's backfill do) and changes no node, edge or other event.
 *
 * Where the pass resumes is decided by the dedupe, not by a position: the dependants of an upstream are ordered by id and those
 * already put to the mind are dropped, so a dependant that appears while the work is half done (an edge written later, with any id)
 * is reached on the next tick. A numeric offset into a list that can grow by insertion would skip such a dependant; `next_offset`
 * is therefore a progress count, not a cursor. Only dependants the mind wrote itself are asked about. Dedupe is by sorted sources: a
 * repair put to the mind holds its pair for good, whether it is pending, accepted, rejected or expired.
 */
export const noticeRepair: DaemonPass = {
  name: "notice.repair",
  async run(ctx) {
    const mind = ctx.mind_id;
    const now = ctx.now();
    const budget = extractorRepairBudget();

    const work = await ctx.tx.query<Work>(
      `select id, upstream_id, upstream_state, replacement_id, next_offset from repair_work
        where mind_id = $1 and done_at is null order by created_at, id limit ${REPAIR_SCAN_CAP}`,
      [mind],
    );
    if (work.rows.length === 0) return { changed: 0 };

    let remaining = budget;
    let proposed = 0;
    let workDone = 0;
    let budgetHit = false;

    for (const w of work.rows) {
      if (remaining <= 0) {
        budgetHit = true;
        break;
      }
      const u = w.upstream_id;
      const reached = await ctx.tx.query<Reach>(
        `select d.id, d.node_type, d.written_by, (d.invalidated_at is not null) as dead, e.edge_type as relation, d.metadata
           from edges e join nodes d on d.id = e.source_node_id
          where e.mind_id = $1 and e.target_node_id = $2::uuid and e.edge_type = any($3::text[]) and d.mind_id = $1 and d.id <> $2::uuid
         union all
         select d.id, d.node_type, d.written_by, (d.invalidated_at is not null), e.edge_type, d.metadata
           from edges e join nodes d on d.id = case when e.source_node_id = $2::uuid then e.target_node_id else e.source_node_id end
          where e.mind_id = $1 and (e.source_node_id = $2::uuid or e.target_node_id = $2::uuid) and e.edge_type = any($4::text[])
            and d.mind_id = $1 and d.id <> $2::uuid
         union all
         select d.id, d.node_type, d.written_by, (d.invalidated_at is not null), 'sources', d.metadata from nodes d
          where d.mind_id = $1 and d.id <> $2::uuid
            and jsonb_typeof(d.metadata->'sources') = 'array' and d.metadata->'sources' @> jsonb_build_array($2::uuid::text)
         union all
         select d.id, d.node_type, d.written_by, (d.invalidated_at is not null), 'noticing', d.metadata from nodes d
           join noticings n on n.mind_id = d.mind_id and n.id::text = d.metadata->>'noticing_id'
          where d.mind_id = $1 and d.id <> $2::uuid and n.kind <> 'repair' and $2::uuid = any(n.sources)
         union all
         select d.id, d.node_type, d.written_by, (d.invalidated_at is not null), 'replacement', d.metadata from nodes d
          where d.mind_id = $1 and d.id <> $2::uuid
            and (d.metadata->>'replacement_id' = $2::uuid::text
                 or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(d.metadata->'repair_reviewed') = 'array' then d.metadata->'repair_reviewed' else '[]'::jsonb end) e
                             where e->>'replacement_id' = $2::uuid::text))`,
        [mind, u, DEPENDENCY_EDGES, REVIEW_EDGES],
      );
      const best = new Map<string, Reach>();
      for (const r of reached.rows) {
        const have = best.get(r.id);
        if (!have || rank(r.relation) < rank(have.relation) || (rank(r.relation) === rank(have.relation) && r.relation < have.relation)) best.set(r.id, r);
      }
      const ordered = [...best.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      // what has already been put to the mind about this upstream, in one query (pairs are sets of two, dependant and upstream)
      const heldBy = new Set<string>();
      const existing = await ctx.tx.query<{ sources: string[] }>(
        `select sources from noticings where mind_id = $1 and kind = 'repair' and sources @> array[$2::uuid]`,
        [mind, u],
      );
      for (const x of existing.rows) {
        // a repair put to the mind, in any state, is final for its (upstream, dependant) pair: reject means "leave it", and one that
        // lapsed was left (unlike the extractor's own kinds, nothing is proposed again after expiry)
        if (x.sources.length !== 2) continue;
        for (const id of x.sources) if (id !== u) heldBy.add(id);
      }
      // not asked about: the replacement this supersede made, something no longer live, something the mind did not write, a node that
      // already answered for this upstream, and anything already put to the mind
      const todo = ordered.filter((d) => !(d.id === w.replacement_id || d.dead || d.written_by !== mind || reviewed(d.metadata ?? {}, u) || heldBy.has(d.id)));

      let ctxEvents: string[] | null = null;
      let ctxEdges: string[] | null = null;
      let snippet: string | null | undefined;
      let proposedHere = 0;
      let stopped = false;
      for (const d of todo) {
        const pair = [d.id, u];
        if (proposedHere >= REPAIR_DEPENDANT_CAP || remaining <= 0) {
          stopped = true;
          budgetHit = budgetHit || remaining <= 0;
          break;
        }
        if (ctxEvents === null) {
          ctxEvents = (await ctx.tx.query<{ id: string }>(
            `select id from events
              where mind_id = $1 and ${bookkeepingExcluded()}
                and (subject_id = $2 or subject_id in (select id from proposals where mind_id = $1 and target_node_id = $2))
              order by (kind = 'identity.retired') desc, seq limit ${CONTEXT_EVENTS}`,
            [mind, u],
          )).rows.map((x) => x.id);
          // edges that touch the upstream but are not a repair relation (related_to, any other type, the reverse of a dependency): context only
          ctxEdges = (await ctx.tx.query<{ id: string }>(
            `select e.id from edges e
              where e.mind_id = $1 and (e.source_node_id = $2::uuid or e.target_node_id = $2::uuid)
                and not (e.target_node_id = $2::uuid and e.edge_type = any($3::text[])) and not (e.edge_type = any($4::text[]))
              order by e.id limit ${CONTEXT_EDGES}`,
            [mind, u, DEPENDENCY_EDGES, REVIEW_EDGES],
          )).rows.map((x) => x.id);
          snippet = w.replacement_id === null ? null : (await ctx.tx.query<{ s: string }>(
            `select left(content, 240) as s from nodes where id = $1 and mind_id = $2`, [w.replacement_id, mind],
          )).rows[0]?.s ?? null;
        }
        const id = randomUUID();
        const score = repairScore(d.relation)!;
        const ev = await appendEvent(ctx, {
          kind: "notice.proposed",
          subject_id: id,
          payload: noticeProposedPayload.parse({ noticing_id: id, noticing_kind: "repair", stage: "propose", score, source_count: 2, model_version: 0 }),
        });
        const low = d.relation === "supports" || d.relation === "contradicts";
        await ctx.tx.query(
          `insert into noticings (id, mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at, created_at)
           values ($1, $2, 'repair', $3::uuid[], $4::jsonb, $5, '{}'::jsonb, 0, 'propose', 'pending', $6, $7, $8)`,
          [
            id, mind, pair,
            JSON.stringify({
              upstream_id: u,
              upstream_state: w.upstream_state,
              replacement_id: w.replacement_id,
              replacement_snippet: snippet ?? null,
              dependant_id: d.id,
              dependant_type: d.node_type,
              relation: d.relation,
              context_event_ids: ctxEvents,
              context_edges: ctxEdges,
              reason: `${low ? "low-confidence review: " : ""}the upstream node was ${w.upstream_state}; this node is tied to it by ${d.relation}`,
            }),
            score, ev.id, noticingExpiresAt(now), now,
          ],
        );
        proposed++;
        proposedHere++;
        remaining--;
      }

      const done = !stopped;
      // acknowledge: claim the row and record the place reached (or finish it)
      await ctx.tx.query(
        `update repair_work set claimed_at = coalesce(claimed_at, $2), next_offset = $3, done_at = $4 where id = $1 and mind_id = $5`,
        [w.id, now, w.next_offset + proposedHere, done ? now : null, mind],
      );
      if (done) workDone++;
      if (stopped && remaining <= 0) {
        budgetHit = true;
        break;
      }
    }

    await recordRun(ctx.tx, mind, "notice.repair", now, ctx.now(), true, { work_done: workDone, proposed, budget_hit: budgetHit });
    return {
      changed: proposed,
      notes: [`${proposed} repair(s) proposed; ${workDone} changed node(s) fully looked at${budgetHit ? "; budget spent, the rest on the next run" : ""}`],
    };
  },
};
