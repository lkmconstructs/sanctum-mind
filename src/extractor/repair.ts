// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { randomUUID } from "node:crypto";
import { appendEvent } from "../verbs/common.js";
import type { DaemonPass } from "../daemon/passes/types.js";
import { extractorReproposeDays, noticingExpiresAt } from "./config.js";
import { bookkeepingExcluded, noticeProposedPayload } from "./events.js";
import { recordRun } from "./schedule.js";

const DAY_MS = 86_400_000;
/** The first run looks back this far; so does any later run after a long gap. */
export const REPAIR_WINDOW_DAYS = 30;
/** Upstream nodes looked at per run; the next run continues after the last one. */
export const REPAIR_CAP = 30;
/** Dependants reached by these relations score 1.0; every other relation scores 0.8. */
const STRONG = ["derived_from", "instance_of", "sources", "corrects"] as const;
/** When one dependant is reached by several relations, the first of these that applies is reported; any other edge type ranks after them. */
const PRIORITY = ["derived_from", "instance_of", "corrects", "sources", "related_to", "supports", "contradicts", "noticing", "replacement"] as const;
const CONTEXT_EVENTS = 5;
/** Repairs proposed per upstream node per tick; the rest follow on the next tick (the dedupe holds what was already proposed). */
export const REPAIR_DEPENDANT_CAP = 25;
/** A run reads back this far before where the last one stopped, so a decision that committed late is still seen. */
const OVERLAP = "1 minute";

export const repairScore = (relation: string): number => ((STRONG as readonly string[]).includes(relation) ? 1.0 : 0.8);

interface Upstream {
  id: string;
  superseded_by: string | null;
  at: string;
  replacement_snippet: string | null;
}

interface Cursor {
  at: string | null;
  id: string | null;
}

interface Reach {
  id: string;
  node_type: string;
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
 * the operator has enabled the extractor. A node that gained `invalidated_at` (superseded by `mind_rethink` or a settled
 * identity rewrite, or retired by a settled identity retirement or a repair) leaves behind the nodes that depended on it. For each
 * live dependant this pass proposes, as a `repair` noticing with sources [dependant, upstream], that the mind look at it:
 * the mind answers keep, rethink or retire through `mind_notice accept`. This pass writes only `noticings`, `notice.proposed`
 * events and an `extractor_runs` row; it changes no node, edge or other event.
 *
 * Dependants: a live node written by the mind itself with an edge to or from the upstream (any type; the type is reported), or whose
 * `metadata.sources` holds its id, or whose `metadata.noticing_id` names a noticing whose sources hold it, or whose
 * `metadata.replacement_id` (a rethink made by a repair) or a `repair_reviewed` entry's `replacement_id` (a keep) is the upstream:
 * a node that answered for an upstream is asked again when that upstream's replacement is itself superseded or retired.
 * The replacement that a supersede made is not a dependant, and neither is a node that already answered for this very upstream
 * (`repair_reviewed`, or a rethink made by a repair). Events are context only (their ids are named in the payload), never dependants.
 *
 * Window: upstream nodes in the last 30 days, paged on the pair (invalidated_at, id). Each run takes the nodes strictly after its
 * cursor (`notes.through_at`, `through_id` of the pass's own latest row; imported rows are ignored), oldest first, at most 30, and
 * also reads back up to 30 from the minute before the cursor, so a decision that committed late with an earlier timestamp is
 * still seen (the dedupe makes a re-read harmless). At most 25 new repairs per upstream per run (the rest next tick). A row is
 * written when a run proposed something or moved the cursor. Dedupe is by sorted sources: a pending, accepted or rejected repair holds its pair,
 * an expired one until EXTRACTOR_REPROPOSE_DAYS after its expiry.
 */
export const noticeRepair: DaemonPass = {
  name: "notice.repair",
  async run(ctx) {
    const mind = ctx.mind_id;
    const now = ctx.now();
    const floor = new Date(now.getTime() - REPAIR_WINDOW_DAYS * DAY_MS);

    const last = await ctx.tx.query<{ through_at: string | null; through_id: string | null }>(
      `select notes->>'through_at' as through_at, notes->>'through_id' as through_id from extractor_runs
        where mind_id = $1 and pass = 'notice.repair' and coalesce(notes->>'imported', '') = '' and notes ? 'through_at'
        order by started_at desc limit 1`,
      [mind],
    );
    const prev = last.rows[0] ?? null;
    const throughAt = prev?.through_at ?? null;
    const throughId = prev?.through_id ?? null;
    const base = `select n.id, n.superseded_by, n.invalidated_at::text as at,
              (select left(r.content, 240) from nodes r where r.id = n.superseded_by and r.mind_id = n.mind_id) as replacement_snippet
         from nodes n
        where n.mind_id = $1 and n.invalidated_at is not null
          and (n.superseded_by is not null or n.metadata->>'retired' = 'true')
          and n.invalidated_at >= $2`;
    // new: strictly after the cursor (the pair), oldest first, one more than the cap to know whether the cap was hit
    const fresh = await ctx.tx.query<Upstream>(
      `${base} and ($3::text is null or (n.invalidated_at, n.id) > ($3::timestamptz, $4::uuid))
        order by n.invalidated_at, n.id limit ${REPAIR_CAP + 1}`,
      [mind, floor, throughAt, throughId],
    );
    // read back: what lies within a minute before the cursor, in case a decision committed after the last run with an earlier timestamp
    const back = throughAt === null
      ? []
      : (await ctx.tx.query<Upstream>(
          `${base} and n.invalidated_at >= $3::timestamptz - interval '${OVERLAP}' and (n.invalidated_at, n.id) <= ($3::timestamptz, $4::uuid)
            order by n.invalidated_at desc, n.id desc limit ${REPAIR_CAP}`,
          [mind, floor, throughAt, throughId],
        )).rows.reverse();
    if (fresh.rows.length === 0 && back.length === 0) return { changed: 0 };
    const capped = fresh.rows.length > REPAIR_CAP;
    const newBatch = fresh.rows.slice(0, REPAIR_CAP);
    let batch = [...back, ...newBatch];

    const days = extractorReproposeDays();
    let dependants = 0;
    let proposed = 0;
    let held = 0;
    let examined = 0;
    let stoppedAt: number | null = null;
    for (const [at, u] of batch.entries()) {
      const reached = await ctx.tx.query<Reach>(
        `select d.id, d.node_type, e.edge_type as relation, d.metadata
           from edges e
           join nodes d on d.id = case when e.source_node_id = $2::uuid then e.target_node_id else e.source_node_id end
          where e.mind_id = $1 and (e.source_node_id = $2::uuid or e.target_node_id = $2::uuid)
            and d.mind_id = $1 and d.written_by = $1 and d.invalidated_at is null and d.id <> $2::uuid
         union all
         select d.id, d.node_type, 'sources', d.metadata from nodes d
          where d.mind_id = $1 and d.written_by = $1 and d.invalidated_at is null and d.id <> $2::uuid
            and jsonb_typeof(d.metadata->'sources') = 'array' and d.metadata->'sources' @> jsonb_build_array($2::uuid::text)
         union all
         select d.id, d.node_type, 'noticing', d.metadata from nodes d
           join noticings n on n.mind_id = d.mind_id and n.id::text = d.metadata->>'noticing_id'
          where d.mind_id = $1 and d.written_by = $1 and d.invalidated_at is null and d.id <> $2::uuid
            and n.kind <> 'repair' and $2::uuid = any(n.sources)
         union all
         select d.id, d.node_type, 'replacement', d.metadata from nodes d
          where d.mind_id = $1 and d.written_by = $1 and d.invalidated_at is null and d.id <> $2::uuid
            and (d.metadata->>'replacement_id' = $2::uuid::text
                 or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(d.metadata->'repair_reviewed') = 'array' then d.metadata->'repair_reviewed' else '[]'::jsonb end) e
                             where e->>'replacement_id' = $2::uuid::text))`,
        [mind, u.id],
      );
      const best = new Map<string, Reach>();
      for (const r of reached.rows) {
        if (r.id === u.superseded_by || reviewed(r.metadata ?? {}, u.id)) continue;
        const have = best.get(r.id);
        if (!have || rank(r.relation) < rank(have.relation) || (rank(r.relation) === rank(have.relation) && r.relation < have.relation)) best.set(r.id, r);
      }
      examined++;
      if (best.size === 0) continue;
      const ctxEvents = await ctx.tx.query<{ id: string }>(
        `select id from events
          where mind_id = $1 and ${bookkeepingExcluded()}
            and (subject_id = $2 or subject_id in (select id from proposals where mind_id = $1 and target_node_id = $2))
          order by (kind = 'identity.retired') desc, seq limit ${CONTEXT_EVENTS}`,
        [mind, u.id],
      );
      const state = u.superseded_by !== null ? "superseded" : "retired";
      let proposedHere = 0;
      for (const d of [...best.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        dependants++;
        const pair = [d.id, u.id];
        const have = await ctx.tx.query<{ status: string; expires_at: Date }>(
          `select status, expires_at from noticings where mind_id = $1 and kind = 'repair' and sources @> $2::uuid[] and sources <@ $2::uuid[]`,
          [mind, pair],
        );
        const holds = have.rows.some((x) => x.status !== "expired" || now.getTime() < x.expires_at.getTime() + days * DAY_MS);
        if (holds) {
          held++;
          continue;
        }
        if (proposedHere >= REPAIR_DEPENDANT_CAP) {
          // more to ask about this node than one tick should put to the mind: stop here, the next tick continues with it
          stoppedAt = at;
          break;
        }
        const id = randomUUID();
        const score = repairScore(d.relation);
        const ev = await appendEvent(ctx, {
          kind: "notice.proposed",
          subject_id: id,
          payload: noticeProposedPayload.parse({ noticing_id: id, noticing_kind: "repair", stage: "propose", score, source_count: 2, model_version: 0 }),
        });
        await ctx.tx.query(
          `insert into noticings (id, mind_id, kind, sources, payload, score, features, model_version, stage, status, proposed_event_id, expires_at, created_at)
           values ($1, $2, 'repair', $3::uuid[], $4::jsonb, $5, '{}'::jsonb, 0, 'propose', 'pending', $6, $7, $8)`,
          [
            id, mind, pair,
            JSON.stringify({
              upstream_id: u.id,
              upstream_state: state,
              replacement_id: u.superseded_by,
              replacement_snippet: u.replacement_snippet,
              dependant_id: d.id,
              dependant_type: d.node_type,
              relation: d.relation,
              context_event_ids: ctxEvents.rows.map((x) => x.id),
              reason: `the upstream node was ${state}; this node is tied to it by ${d.relation}`,
            }),
            score, ev.id, noticingExpiresAt(now), now,
          ],
        );
        proposed++;
        proposedHere++;
      }
      if (stoppedAt !== null) break;
    }

    // where the next run resumes: after the last new upstream fully handled (a cap cut the run short), else after the last new one seen
    let cursor: Cursor = { at: throughAt, id: throughId };
    if (stoppedAt !== null) {
      batch = batch.slice(0, stoppedAt + 1);
      const before = stoppedAt - back.length - 1; // index in newBatch of the last one finished
      if (before >= 0) cursor = { at: newBatch[before]!.at, id: newBatch[before]!.id };
    } else if (newBatch.length > 0) {
      cursor = { at: newBatch[newBatch.length - 1]!.at, id: newBatch[newBatch.length - 1]!.id };
    }
    const moved = cursor.at !== throughAt || cursor.id !== throughId;
    if (proposed === 0 && !moved) return { changed: 0 };
    await recordRun(ctx.tx, mind, "notice.repair", now, ctx.now(), true, {
      window: { floor: floor.toISOString(), read_back: back.length },
      through_at: cursor.at,
      through_id: cursor.id,
      upstreams: examined,
      dependants,
      proposed,
      held,
      capped: capped || stoppedAt !== null,
    });
    return {
      changed: proposed,
      notes: [`${proposed} repair(s) proposed for ${dependants} dependant(s) of ${examined} changed node(s)${capped || stoppedAt !== null ? "; capped, the rest on the next run" : ""}`],
    };
  },
};
