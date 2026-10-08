// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { ok } from "../result.js";
import { defineVerb } from "./types.js";
import { mindIdSchema, nonBlankText, text } from "./common.js";
import { instant } from "./texture.js";
import { fuseTable, plan, snippet, type Candidate } from "./retrieval.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  query: nonBlankText(2000),
  limit: z.number().int().min(1).max(50).default(10),
  scope: z.enum(["events", "nodes", "both"]).default("both"),
  kind: text(64).optional(),
  node_type: text(64).optional(),
  context: text(64).optional(),
  after: instant.optional(),
  before: instant.optional(),
  mode: z.enum(["hybrid", "text", "semantic"]).default("hybrid"),
});

function shape(c: Candidate) {
  return {
    source: c.source,
    id: c.id,
    score: c.score,
    ...(c.text_rank === undefined ? {} : { text_rank: c.text_rank }),
    ...(c.distance === undefined ? {} : { distance: c.distance }),
    ...(c.kind === undefined ? {} : { kind: c.kind }),
    ...(c.node_type === undefined ? {} : { node_type: c.node_type }),
    ...(c.label === undefined || c.label === null ? {} : { label: c.label }),
    snippet: snippet(c.body),
    created_at: c.created_at,
    context: c.context,
    ...(c.texture === null || c.texture === undefined ? {} : { texture: c.texture }),
  };
}

export const mind_search = defineVerb({
  name: "mind_search",
  description:
    "Search events and curated nodes by full text, meaning, or both (reciprocal rank fusion). " +
    "Filters: kind (events), node_type (nodes), context, after/before (recorded time, after inclusive, before exclusive). " +
    "Without an embedder, semantic search is unavailable and a warning is returned. Writes nothing.",
  schema,
  scopeFor: () => "read",
  embedText: (input) => (input.mode === "text" ? null : input.query),
  handler: async (ctx, input) => {
    const vec = input.mode === "text" ? null : (ctx.embedded?.vector ?? null);
    const p = plan(input.mode, vec);
    const f = {
      kind: input.kind,
      node_type: input.node_type,
      context: input.context,
      after: input.after,
      before: input.before,
    };
    const useVec = p.useVec ? vec : null;
    const hits: Candidate[] = [];
    if (p.runText || p.useVec) {
      if (input.scope !== "nodes") hits.push(...(await fuseTable(ctx.tx, "events", input.query, useVec, p.runText, f)));
      if (input.scope !== "events") hits.push(...(await fuseTable(ctx.tx, "nodes", input.query, useVec, p.runText, f)));
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return ok({
      projection: { query: input.query, mode_used: p.mode_used, hits: hits.slice(0, input.limit).map(shape) },
      ...(p.warnings.length > 0 ? { warnings: p.warnings } : {}),
    });
  },
});
