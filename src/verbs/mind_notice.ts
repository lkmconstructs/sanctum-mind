// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb, type VerbContext } from "./types.js";
import { appendEvent, deriveLabel, mindIdSchema, text } from "./common.js";
import { DISTILLATION_NODE, IDENTITY_NODE, MEMORY_MIND_ONLY, PATTERN_NODE, VOW_NODE, insertSelfNode, supersedeNode } from "./self_common.js";
import { LINK_EDGE_TYPES, linkNodes } from "./mind_link.js";
import {
  REPAIR_DECISIONS, noticeAcceptedPayload, noticeRejectedPayload, repairKeptPayload, repairRethoughtPayload, repairRetiredPayload,
} from "./notice_events.js";

const KINDS = ["link", "pattern", "distillation", "repair"] as const;
const SNIPPET = 240;

const schema = z.strictObject({
  mind_id: mindIdSchema,
  operation: z.enum(["list", "accept", "reject"]),
  /** list: only this kind */
  kind: z.enum(KINDS).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  /** accept, reject: the proposal to decide */
  noticing_id: z.uuid().optional(),
  /** accept (pattern, distillation): the mind's own wording of the proposed content; accept (repair, rethink): the new wording */
  content: text(12000).optional(),
  /** accept (repair, rethink): a label for the replacement; default the old one's */
  label: text(200).optional(),
  /** accept (repair, and only a repair): what the mind decides about the dependant */
  decision: z.enum(REPAIR_DECISIONS).optional(),
  /** accept (link): edge type and weight; default the proposal's edge_type and 0.5 */
  edge_type: z.enum(LINK_EDGE_TYPES).optional(),
  weight: z.number().min(0).max(1).optional(),
  /** reject: why; recorded on the event */
  reason: text(4000).optional(),
}).superRefine((v, c) => {
  if ((v.operation === "accept" || v.operation === "reject") && v.noticing_id === undefined) {
    c.addIssue({ code: "custom", message: `noticing_id is required to ${v.operation}`, path: ["noticing_id"] });
  }
});

interface NoticingRow {
  id: string;
  kind: (typeof KINDS)[number];
  sources: string[];
  payload: Record<string, unknown>;
  score: number;
  stage: "shadow" | "propose";
  status: "pending" | "accepted" | "rejected" | "expired";
  expires_at: Date;
}

export interface NoticingSource {
  id: string;
  type: "node" | "event";
  snippet: string;
}

export interface ListedNoticing {
  id: string;
  kind: string;
  sources: NoticingSource[];
  payload: Record<string, unknown>;
  score: number;
  expires_at: Date;
}

/** The repair proposals the mind may see: pending and not yet past their expiry, whatever the extractor's state or stage (a repair reports a fact about the graph; it does not go through the trial). */
export async function pendingRepairs(ctx: VerbContext): Promise<number> {
  const r = await ctx.tx.query<{ n: string }>(
    `select count(*) as n from noticings where mind_id = $1 and kind = 'repair' and status = 'pending' and expires_at > $2`,
    [ctx.mind_id, ctx.now()],
  );
  return Number(r.rows[0]!.n);
}

/**
 * The pending noticings the mind may see, ranked by score, repairs first. Repairs are shown whenever they are pending and not
 * past their expiry, even with the extractor off or at stage shadow. Every other kind is shown only while the operator's stage
 * for this mind is `propose`, only for rows recorded at stage `propose` (a shadow row is never shown) and not yet past their expiry.
 * `stage` is 'off' when there is no extractor_state row. Shared by `mind_notice list` and the `noticings` section of mind_orient.
 */
export async function listNoticings(
  ctx: VerbContext,
  opts: { kind?: string | undefined; limit: number },
): Promise<{ noticings: ListedNoticing[]; stage: "off" | "shadow" | "propose" }> {
  const st = await ctx.tx.query<{ stage: "shadow" | "propose" }>(`select stage from extractor_state where mind_id = $1`, [ctx.mind_id]);
  const stage = st.rows[0]?.stage ?? "off";

  const rows = await ctx.tx.query<NoticingRow>(
    `select id, kind, sources, payload, score, stage, status, expires_at from noticings
      where mind_id = $1 and stage = 'propose' and status = 'pending' and expires_at > $4 and ($2::text is null or kind = $2)
        and (kind = 'repair' or $5::boolean)
      order by (kind = 'repair') desc, score desc, created_at asc, id limit $3`,
    [ctx.mind_id, opts.kind ?? null, opts.limit, ctx.now(), stage === "propose"],
  );
  const ids = [...new Set(rows.rows.flatMap((r) => r.sources))];
  const snippets = new Map<string, NoticingSource>();
  if (ids.length > 0) {
    const nodes = await ctx.tx.query<{ id: string; s: string }>(
      `select id, left(content, ${SNIPPET}) as s from nodes where mind_id = $1 and id = any($2::uuid[])`,
      [ctx.mind_id, ids],
    );
    for (const n of nodes.rows) snippets.set(n.id, { id: n.id, type: "node", snippet: n.s });
    const events = await ctx.tx.query<{ id: string; s: string }>(
      `select id, left(coalesce(payload->>'content', payload->>'text', ''), ${SNIPPET}) as s from events
        where mind_id = $1 and id = any($2::uuid[])`,
      [ctx.mind_id, ids],
    );
    for (const e of events.rows) if (!snippets.has(e.id)) snippets.set(e.id, { id: e.id, type: "event", snippet: e.s });
  }
  return {
    stage,
    noticings: rows.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      sources: r.sources.flatMap((s) => {
        const hit = snippets.get(s);
        return hit ? [hit] : [];
      }),
      payload: r.payload,
      score: r.score,
      expires_at: r.expires_at,
    })),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** Records the decision on the noticing row in the transaction that wrote the decision event. */
async function decide(ctx: VerbContext, id: string, status: "accepted" | "rejected", ev: { id: string; created_at: Date }): Promise<void> {
  await ctx.tx.query(`update noticings set status = $2, decided_event_id = $3, decided_at = $4 where id = $1 and mind_id = $5`, [
    id, status, ev.id, ev.created_at, ctx.mind_id,
  ]);
}

/** Live nodes among the sources (a source may be an event, or a node invalidated since; edges join live nodes only, the rest stay in the metadata). */
async function sourceNodeIds(ctx: VerbContext, sources: string[]): Promise<string[]> {
  const r = await ctx.tx.query<{ id: string }>(
    `select id from nodes where mind_id = $1 and id = any($2::uuid[]) and invalidated_at is null`,
    [ctx.mind_id, sources],
  );
  const have = new Set(r.rows.map((x) => x.id));
  return sources.filter((s) => have.has(s));
}

export const mind_notice = defineVerb({
  name: "mind_notice",
  description:
    "What the extractor noticed. list: pending proposals (links, patterns, distillations) ranked by score; shown only when the operator " +
    "has enabled the extractor at stage propose. Repairs are also listed, first, whenever one is pending: when a node you relied on was rewritten or retired, " +
    "each node that depended on it is put to you. accept and reject are for the mind acting as itself: accepting authors the memory " +
    "(a link edge, a pattern node, a distillation node) as the mind, with provenance to the proposal and its sources; the sources are never changed. " +
    "A repair is accepted with a decision: keep (it still holds), rethink (give the new wording in content) or retire. " +
    "Rejecting records the reason and removes nothing but the proposal.",
  schema,
  scopeFor: (input) => (input.operation === "list" ? "read" : "write"),
  mindOnly: (input) => input.operation === "accept" || input.operation === "reject",
  mindOnlyMessage: MEMORY_MIND_ONLY,
  embedText: (input) => (input.operation === "accept" ? (input.content ?? null) : null),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.operation === "list") {
      return ok({ projection: await listNoticings(ctx, { kind: input.kind, limit: input.limit }) });
    }
    // the mind, in a verb call: the database checks the same (app.actor = 'verb' and the bearer is the mind)
    if (ctx.caller.bearer !== ctx.mind_id || ctx.actor !== "verb") return err("forbidden", MEMORY_MIND_ONLY);

    const id = input.noticing_id!;
    const cur = await ctx.tx.query<NoticingRow>(`select * from noticings where id = $1 and mind_id = $2 for update`, [id, ctx.mind_id]);
    const n = cur.rows[0];
    // a shadow row is invisible to the mind: it is not found, whatever its status
    if (!n || n.stage !== "propose") return err("not_found", "noticing not found", "noticing_id");
    if (n.status !== "pending") return err("conflict", `noticing is already ${n.status}`, "noticing_id");

    if (input.operation === "reject") {
      const ev = await appendEvent(ctx, {
        kind: "notice.rejected",
        subject_id: id,
        payload: noticeRejectedPayload.parse({ noticing_id: id, kind: n.kind, reason: input.reason ?? null }),
      });
      await decide(ctx, id, "rejected", ev);
      return ok({ event_id: ev.id, projection: { noticing_id: id, status: "rejected" } });
    }

    // accept: the proposal must still be live, and the operator must still be showing proposals
    if (n.expires_at.getTime() <= ctx.now().getTime()) return err("conflict", "noticing has expired", "noticing_id");
    // a repair reports a fact about the graph and is not gated by the operator's stage
    if (n.kind !== "repair") {
      const st = await ctx.tx.query<{ stage: string }>(`select stage from extractor_state where mind_id = $1`, [ctx.mind_id]);
      if (st.rows[0]?.stage !== "propose") return err("conflict", "the extractor is not at stage propose", "noticing_id");
    }
    if (n.kind === "repair") return decideRepair(ctx, n, input);
    if (input.decision !== undefined) return err("invalid_input", "decision applies to repair proposals only", "decision");
    if (input.label !== undefined) return err("invalid_input", "label applies to repair proposals (rethink) only", "label");

    if (n.kind === "link") {
      if (input.content !== undefined) return err("invalid_input", "content applies to pattern and distillation proposals, not a link", "content");
      if (n.sources.length !== 2) return err("conflict", "a link proposal needs exactly two sources", "noticing_id");
      if (n.sources[0] === n.sources[1]) {
        return err("invalid_input", `a link proposal names the same source twice (${n.sources[0]}); it cannot link a thing to itself`, "noticing_id");
      }
      const proposed = str(n.payload.edge_type);
      const edge_type = input.edge_type ?? ((LINK_EDGE_TYPES as readonly string[]).includes(proposed ?? "") ? proposed! : "related_to");
      const reason = str(n.payload.reason);
      const link = await linkNodes(ctx, {
        source_id: n.sources[0]!,
        target_id: n.sources[1]!,
        edge_type,
        weight: input.weight ?? 0.5,
        ...(reason === null ? {} : { note: reason.slice(0, 4000) }),
        metadata: { noticing_id: id },
      });
      if (!link.ok) {
        // linkNodes reports a missing node as not_found on source_id/target_id; here that means the proposal went stale
        return link.error.code === "not_found"
          ? err("conflict", "a link is an edge between two live nodes; a source of this proposal is an event or is no longer live", "noticing_id")
          : link;
      }
      const p = link.receipt.projection!;
      const ev = await appendEvent(ctx, {
        kind: "notice.accepted",
        subject_id: id,
        payload: noticeAcceptedPayload.parse({ noticing_id: id, kind: "link", sources: n.sources, edge_id: p.edge_id, edge_type, existing: p.existing === true }),
      });
      await decide(ctx, id, "accepted", ev);
      return ok({
        event_id: ev.id,
        projection: { noticing_id: id, status: "accepted", edge_id: p.edge_id },
        ...(p.existing ? { warnings: ["exists"] } : {}),
      });
    }

    if (input.edge_type !== undefined) return err("invalid_input", "edge_type applies to link proposals only", "edge_type");
    if (input.weight !== undefined) return err("invalid_input", "weight applies to link proposals only", "weight");

    const content = input.content ?? str(n.kind === "pattern" ? n.payload.summary : n.payload.content);
    if (content === null || content.trim() === "") {
      return err("invalid_input", `this proposal carries no ${n.kind === "pattern" ? "summary" : "content"}: pass content`, "content");
    }
    const edited = input.content !== undefined;
    const nodeIds = await sourceNodeIds(ctx, n.sources);

    if (n.kind === "pattern") {
      const label = deriveLabel(str(n.payload.label) ?? content, 200) || deriveLabel(content, 200);
      // the pattern event carries the words (memory-shaped); notice.accepted below carries ids only
      const pat = await appendEvent(ctx, {
        kind: "pattern",
        embedded: ctx.embedded,
        payload: { noticing_id: id, label, content, sources: n.sources, edited },
      });
      const node_id = await insertSelfNode(ctx, {
        node_type: PATTERN_NODE,
        label,
        content,
        pinned: false,
        metadata: { noticing_id: id, sources: n.sources, event_id: pat.id },
      });
      // edges join live nodes: events and invalidated nodes among the sources are recorded in the metadata only
      for (const s of nodeIds) await insertProvenanceEdge(ctx, "instance_of", s, node_id, id, pat.id);
      const ev = await appendEvent(ctx, {
        kind: "notice.accepted",
        subject_id: id,
        payload: noticeAcceptedPayload.parse({ noticing_id: id, kind: "pattern", sources: n.sources, node_id, content_event_id: pat.id, edited }),
      });
      await decide(ctx, id, "accepted", ev);
      return ok({ event_id: ev.id, projection: { noticing_id: id, status: "accepted", node_id, pattern_event_id: pat.id } });
    }

    // distillation: a write-shaped `distill` event with the content, then the node derived from the sources
    const distill = await appendEvent(ctx, {
      kind: "distill",
      embedded: ctx.embedded,
      payload: { content, sources: n.sources, noticing_id: id },
    });
    const node_id = await insertSelfNode(ctx, {
      node_type: DISTILLATION_NODE,
      label: deriveLabel(content, 200),
      content,
      pinned: false,
      metadata: { noticing_id: id, sources: n.sources, event_id: distill.id },
    });
    for (const s of nodeIds) await insertProvenanceEdge(ctx, "derived_from", node_id, s, id, distill.id);
    const ev = await appendEvent(ctx, {
      kind: "notice.accepted",
      subject_id: id,
      payload: noticeAcceptedPayload.parse({ noticing_id: id, kind: "distillation", sources: n.sources, node_id, content_event_id: distill.id, edited }),
    });
    await decide(ctx, id, "accepted", ev);
    return ok({ event_id: ev.id, projection: { noticing_id: id, status: "accepted", node_id, distill_event_id: distill.id } });
  },
});

async function insertProvenanceEdge(
  ctx: VerbContext,
  edge_type: string,
  source: string,
  target: string,
  noticing_id: string,
  event_id: string,
): Promise<void> {
  await ctx.tx.query(
    `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata)
     values ($1, $2, $3, $4, $5, 0.5, 1.0, $6::jsonb)`,
    [ctx.mind_id, edge_type, ctx.caller.bearer, source, target, JSON.stringify({ noticing_id, event_id })],
  );
}

/** A node whose metadata is not a JSON object (legacy data) is treated as empty when a repair writes to it. */
const OBJECT_METADATA = "(case when jsonb_typeof(metadata) = 'object' then metadata else '{}'::jsonb end)";
const IDENTITY_REFUSAL = "identity belongs to the mind: use mind_identity propose (rewrite or retire)";
const uuidOrNull = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v.toLowerCase() : null);

/**
 * Accepting a repair: the mind's answer about one dependant of a node that was superseded or retired. `notice.accepted`
 * {noticing_id, kind: repair, decision} is the decision event the database guard needs; `repair.kept`, `repair.rethought` or
 * `repair.retired` (subject = the dependant) is the second event. Rethink uses the same helper as `mind_rethink`. An identity or
 * vow dependant cannot be rethought or retired here (those go through mind_identity, with cooling); keep is allowed.
 */
async function decideRepair(ctx: VerbContext, n: NoticingRow, input: z.infer<typeof schema>): Promise<Result<unknown>> {
  const id = n.id;
  const decision = input.decision;
  if (decision === undefined) return err("invalid_input", "a repair is decided with decision: keep, rethink or retire", "decision");
  if (input.edge_type !== undefined) return err("invalid_input", "edge_type applies to link proposals only", "edge_type");
  if (input.weight !== undefined) return err("invalid_input", "weight applies to link proposals only", "weight");
  if (decision === "rethink") {
    if (input.content === undefined) return err("invalid_input", "rethink needs content: your new wording of the dependant", "content");
  } else {
    if (input.content !== undefined) return err("invalid_input", "content applies to a rethink only", "content");
    if (input.label !== undefined) return err("invalid_input", "label applies to a rethink only", "label");
  }
  const upstream = uuidOrNull(n.payload.upstream_id);
  const dependant = uuidOrNull(n.payload.dependant_id);
  if (upstream === null || dependant === null || !n.sources.includes(dependant) || !n.sources.includes(upstream)) {
    return err("conflict", "this repair proposal is malformed", "noticing_id");
  }

  await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`node:${dependant}`]);
  const cur = await ctx.tx.query<{ node_type: string; invalidated_at: Date | null }>(
    `select node_type, invalidated_at from nodes where id = $1 and mind_id = $2`,
    [dependant, ctx.mind_id],
  );
  const d = cur.rows[0];
  if (!d || d.invalidated_at !== null) return err("conflict", "the dependant is no longer live; there is nothing left to repair (reject the proposal to clear it)", "noticing_id");
  if (decision !== "keep" && (d.node_type === IDENTITY_NODE || d.node_type === VOW_NODE)) return err("conflict", IDENTITY_REFUSAL, "decision");

  const accepted = async (extra: { node_id?: string }) => {
    const ev = await appendEvent(ctx, {
      kind: "notice.accepted",
      subject_id: id,
      payload: noticeAcceptedPayload.parse({ noticing_id: id, kind: "repair", decision, ...extra }),
    });
    await decide(ctx, id, "accepted", ev);
    return ev;
  };

  if (decision === "keep") {
    const kept = await appendEvent(ctx, { kind: "repair.kept", subject_id: dependant, payload: repairKeptPayload.parse({ noticing_id: id, upstream_id: upstream }) });
    await ctx.tx.query(
      `update nodes set metadata = jsonb_set(${OBJECT_METADATA}, '{repair_reviewed}',
              (case when jsonb_typeof(metadata->'repair_reviewed') = 'array' then metadata->'repair_reviewed' else '[]'::jsonb end) || $3::jsonb)
        where id = $1 and mind_id = $2`,
      // replacement_id lets the question come back if the replacement is itself superseded or retired later
      [dependant, ctx.mind_id, JSON.stringify([{ upstream_id: upstream, replacement_id: uuidOrNull(n.payload.replacement_id), event_id: kept.id, at: kept.created_at }])],
    );
    const ev = await accepted({});
    return ok({ event_id: ev.id, projection: { noticing_id: id, status: "accepted", decision, node_id: dependant, repair_event_id: kept.id } });
  }

  if (decision === "rethink") {
    const sup = await supersedeNode(ctx, dependant, {
      content: input.content!,
      ...(input.label === undefined ? {} : { label: input.label }),
      reason: `repair of ${upstream}`,
      provenance: { noticing_id: id, upstream_id: upstream, replacement_id: uuidOrNull(n.payload.replacement_id) },
    });
    if (!sup.ok) return sup;
    const node_id = sup.receipt.projection!.node_id as string;
    const re = await appendEvent(ctx, {
      kind: "repair.rethought",
      subject_id: dependant,
      payload: repairRethoughtPayload.parse({ noticing_id: id, upstream_id: upstream, node_id }),
    });
    const ev = await accepted({ node_id });
    return ok({ event_id: ev.id, projection: { noticing_id: id, status: "accepted", decision, node_id, superseded: dependant, repair_event_id: re.id, rethink_event_id: sup.receipt.event_id } });
  }

  // retire: the dependant is invalidated, nothing replaces it
  const re = await appendEvent(ctx, { kind: "repair.retired", subject_id: dependant, payload: repairRetiredPayload.parse({ noticing_id: id, upstream_id: upstream }) });
  const upd = await ctx.tx.query(
    `update nodes set invalidated_at = $3, metadata = ${OBJECT_METADATA} || $4::jsonb where id = $1 and mind_id = $2 and invalidated_at is null`,
    [dependant, ctx.mind_id, re.created_at, JSON.stringify({ retired: true, retired_at: re.created_at, retired_reason: `repair of ${upstream}`, repair_noticing_id: id })],
  );
  if (upd.rowCount !== 1) throw new Error(`repair ${id}: dependant ${dependant} vanished under the lock`);
  const ev = await accepted({});
  return ok({ event_id: ev.id, projection: { noticing_id: id, status: "accepted", decision, node_id: dependant, repair_event_id: re.id } });
}
