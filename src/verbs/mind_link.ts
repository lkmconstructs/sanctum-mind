// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb, type VerbContext } from "./types.js";
import { appendEvent, mindIdSchema, text, uuidSchema, nodeLockKey } from "./common.js";

export const LINK_EDGE_TYPES = [
  "related_to", "contradicts", "conflicts_with", "corrects", "derived_from",
  "references", "felt_toward", "involves", "depends_on", "followed_by",
] as const;

const schema = z.strictObject({
  mind_id: mindIdSchema,
  source_id: uuidSchema,
  target_id: uuidSchema,
  edge_type: z.enum(LINK_EDGE_TYPES).default("related_to"),
  weight: z.number().min(0).max(1).default(0.5),
  note: text(4000).optional(),
});

/** `{edge_id, existing: true}` when the edge was already there (warning: exists), else `{event_id, edge_id}`. */
export interface LinkProjection {
  edge_id: string;
  existing?: true;
  event_id?: string;
}

export interface LinkInput {
  source_id: string;
  target_id: string;
  edge_type: string;
  weight: number;
  note?: string | undefined;
  /** extra edge metadata (for example the noticing an accepted link came from) */
  metadata?: Record<string, unknown>;
}

/**
 * The one code path that links two live nodes: mind_link and an accepted `link` noticing both use it.
 * Validates, serialises on the triple, returns the existing edge (warning: exists, nothing written) or appends the
 * `link` event and inserts the edge authored by the bearer.
 */
export async function linkNodes(
  ctx: VerbContext,
  input: LinkInput,
): Promise<Result<LinkProjection>> {
  if (input.source_id === input.target_id) {
    return err("invalid_input", "a node cannot be linked to itself", "target_id");
  }
  // The per-node lock supersedeNode takes, in a fixed order, BEFORE the liveness check: a link cannot commit against a node that is
  // being invalidated concurrently (either the rewrite waits for this transaction, and then repair finds the edge, or the node is
  // already invalid here and the link is refused).
  for (const key of [nodeLockKey(input.source_id), nodeLockKey(input.target_id)].sort()) await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
  for (const [field, id] of [["source_id", input.source_id], ["target_id", input.target_id]] as const) {
    const n = await ctx.tx.query(`select 1 from nodes where id = $1 and invalidated_at is null`, [id]);
    if (n.rows.length === 0) return err("not_found", `${field} is not a live node`, field);
  }

  // Serialise on the triple so concurrent identical links cannot both insert.
  await ctx.tx.query("select pg_advisory_xact_lock(hashtext('link:' || $1 || ':' || $2 || ':' || $3 || ':' || $4))", [
    ctx.mind_id, input.source_id, input.target_id, input.edge_type,
  ]);
  const existing = await ctx.tx.query<{ id: string }>(
    `select id from edges where source_node_id = $1 and target_node_id = $2 and edge_type = $3 limit 1`,
    [input.source_id, input.target_id, input.edge_type],
  );
  if (existing.rows.length > 0) {
    return ok({ projection: { edge_id: existing.rows[0]!.id, existing: true }, warnings: ["exists"] });
  }

  const ev = await appendEvent(ctx, {
    kind: "link",
    payload: {
      source_id: input.source_id,
      target_id: input.target_id,
      edge_type: input.edge_type,
      weight: input.weight,
      note: input.note ?? null,
    },
  });
  const r = await ctx.tx.query<{ id: string }>(
    `insert into edges (mind_id, edge_type, written_by, source_node_id, target_node_id, weight, confidence, metadata)
     values ($1, $2, $3, $4, $5, $6, 1.0, $7::jsonb) returning id`,
    [
      ctx.mind_id, input.edge_type, ctx.caller.bearer, input.source_id, input.target_id, input.weight,
      JSON.stringify({ note: input.note ?? null, event_id: ev.id, ...(input.metadata ?? {}) }),
    ],
  );
  return ok({ event_id: ev.id, projection: { event_id: ev.id, edge_id: r.rows[0]!.id } });
}

export const mind_link = defineVerb({
  name: "mind_link",
  description:
    "Link two live graph nodes with a typed weighted edge. Linking the same pair with the " +
    "same type again returns the existing edge (warning: exists) and writes nothing.",
  schema,
  scopeFor: () => "write",
  handler: async (ctx, input): Promise<Result<unknown>> => {
    return linkNodes(ctx, input);
  },
});
