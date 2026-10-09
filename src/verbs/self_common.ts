// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { err, ok, type Result } from "../result.js";
import { appendEvent, deriveLabel, nodeLockKey, NOT_EMBEDDED } from "./common.js";
import { recordRepairWork } from "./repair_work.js";
import type { VerbContext } from "./types.js";

/** Node type literals of the Self region. */
export const IDENTITY_NODE = "identity";
export const VOW_NODE = "vow";
export const ANCHOR_NODE = "anchor";
export const DESIRE_NODE = "desire";
/** Node types an accepted noticing becomes (mind_notice accept). nodes.node_type is free text, so no schema change. */
export const PATTERN_NODE = "pattern";
export const DISTILLATION_NODE = "distillation";

/** First 120 characters of a text, whitespace collapsed to single spaces. */
export const defaultLabel = (s: string): string => deriveLabel(s);

export interface SelfNodeInput {
  node_type: string;
  label: string;
  content: string;
  pinned?: boolean;
  metadata: Record<string, unknown>;
}

/** Inserts a Self node: extracted, confidence 1.0, authored by the bearer, embedded from ctx.embedded (pre-transaction). Returns the id. */
export async function insertSelfNode(ctx: VerbContext, n: SelfNodeInput): Promise<string> {
  const emb = ctx.embedded ?? NOT_EMBEDDED;
  const r = await ctx.tx.query<{ id: string }>(
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, pinned, metadata,
                        embedding, embedding_model)
     values ($1, $2, $3, $4, $5, 'extracted', 1.0, $6, $7::jsonb, $8::vector, $9)
     returning id`,
    [ctx.mind_id, n.node_type, n.label, n.content, ctx.caller.bearer, n.pinned ?? false, JSON.stringify(n.metadata), emb.vector, emb.model],
  );
  return r.rows[0]!.id;
}

export interface SupersedeInput {
  content: string;
  label?: string | undefined;
  node_type?: string | undefined;
  reason: string;
  metadata?: Record<string, unknown> | undefined;
  /** extra metadata keys recorded on the new node (who or what drove the rewrite) */
  provenance?: Record<string, unknown> | undefined;
}

/**
 * The rethink mechanics: appends a `rethink` event, inserts the replacement node (inheriting label, type,
 * confidence and pinning), invalidates the old node with `superseded_by`, and links them with a `corrects` edge.
 * Takes the per-node advisory lock. Writes nothing and returns an error result when the node is missing or
 * already invalidated.
 */
export async function supersedeNode(
  ctx: VerbContext,
  nodeId: string,
  input: SupersedeInput,
): Promise<Result<{ event_id: string; node_id: string; superseded: string }>> {
  await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [nodeLockKey(nodeId)]);
  const cur = await ctx.tx.query<{
    node_type: string;
    label: string;
    confidence: number;
    pinned: boolean;
    metadata: Record<string, unknown>;
    invalidated_at: Date | null;
  }>(`select node_type, label, confidence, pinned, metadata, invalidated_at from nodes where id = $1 and mind_id = $2`, [
    nodeId,
    ctx.mind_id,
  ]);
  const old = cur.rows[0];
  if (!old) return err("not_found", "node not found", "node_id");
  if (old.invalidated_at !== null) return err("conflict", "node is already invalidated", "node_id");

  const emb = ctx.embedded ?? NOT_EMBEDDED;
  const ev = await appendEvent(ctx, {
    embedded: emb,
    kind: "rethink",
    subject_id: nodeId,
    payload: {
      content: input.content,
      label: input.label ?? null,
      node_type: input.node_type ?? null,
      reason: input.reason,
    },
  });
  const metadata = {
    ...old.metadata,
    ...(input.metadata ?? {}),
    ...(input.provenance ?? {}),
    rewritten_from: nodeId,
    rewritten_by: ctx.caller.bearer,
    reason: input.reason,
    event_id: ev.id,
  };
  const ins = await ctx.tx.query<{ id: string }>(
    `insert into nodes (mind_id, node_type, label, content, written_by, source_type, confidence, pinned, metadata,
                        embedding, embedding_model)
     values ($1, $2, $3, $4, $5, 'extracted', $6, $7, $8::jsonb, $9::vector, $10)
     returning id`,
    [
      ctx.mind_id,
      input.node_type ?? old.node_type,
      input.label ?? old.label,
      input.content,
      ctx.caller.bearer,
      old.confidence,
      old.pinned,
      JSON.stringify(metadata),
      emb.vector,
      emb.model,
    ],
  );
  const newId = ins.rows[0]!.id;
  await ctx.tx.query(`update nodes set invalidated_at = $2, superseded_by = $3 where id = $1`, [nodeId, ev.created_at, newId]);
  await ctx.tx.query(
    `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata)
     values ($1, 'corrects', $2, $3, $4, 0.5, 1.0, $5::jsonb)`,
    [ctx.mind_id, ctx.caller.bearer, newId, nodeId, JSON.stringify({ event_id: ev.id })],
  );
  // belief repair: the work is recorded in the transaction that invalidates the node (completeness does not depend on commit timing)
  await recordRepairWork(ctx.tx, { mind_id: ctx.mind_id, upstream_id: nodeId, upstream_state: "superseded", replacement_id: newId, created_event_id: ev.id });
  return ok({ event_id: ev.id, projection: { event_id: ev.id, node_id: newId, superseded: nodeId } });
}

/** The refusal for deciding what the extractor noticed (mind_notice accept and reject) when the caller is not the mind itself. */
export const MEMORY_MIND_ONLY = "memory is authored by the mind";

/** The refusal for any act that changes a mind's identity or vows when the caller is not the mind itself. */
export const MIND_ONLY = "identity belongs to the mind";

interface Attestation {
  by: string;
  stance: string;
  note: string;
  at: string;
  event_id: string;
}

export interface Declaration {
  proposal_id?: string;
  vow_id?: string;
  kind: "rewrite" | "retire" | "vow_break";
  /** proposals only: what the declaration does to its target when it settles */
  action?: "rewrite" | "retire";
  target_node_id: string | null;
  effective_at: string | null;
  attestations: Attestation[];
  objections: Attestation[];
}

const split = (all: Attestation[]): Pick<Declaration, "attestations" | "objections"> => ({
  attestations: all.filter((a) => a.stance === "attest"),
  objections: all.filter((a) => a.stance === "object"),
});

/** Declared changes that have not yet taken effect: accepted-not-settled rewrites and retirements, and vows with a declared break. */
export async function identityDeclarations(ctx: VerbContext): Promise<Declaration[]> {
  const props = await ctx.tx.query<{
    id: string;
    action: "rewrite" | "retire";
    target_node_id: string | null;
    effective_at: Date | null;
    attestations: Attestation[];
  }>(
    `select id, action, target_node_id, effective_at, attestations from proposals
     where mind_id = $1 and status = 'accepted' and settled_at is null and withdrawn_at is null and effective_at is not null
     order by created_at asc, id`,
    [ctx.mind_id],
  );
  const vows = await ctx.tx.query<{ id: string; metadata: { break_declared: { effective_at: string } } }>(
    `select id, metadata from nodes
     where mind_id = $1 and node_type = $2 and invalidated_at is null and metadata ? 'break_declared'
       and jsonb_typeof(metadata->'break_declared') = 'object'
     order by created_at asc, id`,
    [ctx.mind_id, VOW_NODE],
  );
  const out: Declaration[] = props.rows.map((p) => ({
    proposal_id: p.id,
    kind: p.action,
    action: p.action,
    target_node_id: p.target_node_id,
    effective_at: p.effective_at === null ? null : p.effective_at.toISOString(),
    ...split(p.attestations),
  }));
  for (const v of vows.rows) {
    out.push({
      vow_id: v.id,
      kind: "vow_break",
      target_node_id: v.id,
      effective_at: v.metadata.break_declared.effective_at,
      attestations: [],
      objections: [],
    });
  }
  return out;
}
