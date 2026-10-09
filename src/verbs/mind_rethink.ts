// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err } from "../result.js";
import { defineVerb } from "./types.js";
import { mindIdSchema, text, uuidSchema } from "./common.js";
import { IDENTITY_NODE, VOW_NODE, supersedeNode } from "./self_common.js";

const PROTECTED_NODE_TYPES: string[] = [IDENTITY_NODE, VOW_NODE];

const schema = z.strictObject({
  mind_id: mindIdSchema,
  node_id: uuidSchema,
  content: text(12000),
  label: text(200).optional(),
  node_type: text(64).optional(),
  reason: text(4000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const mind_rethink = defineVerb<typeof schema, unknown>({
  name: "mind_rethink",
  description:
    "Replace a live node with a corrected one: the old node is invalidated and superseded, " +
    "the new node inherits its label, type, confidence and pinning, and a corrects edge links them.",
  schema,
  scopeFor: () => "write",
  embedText: (input) => input.content,
  handler: async (ctx, input) => {
    const cur = await ctx.tx.query<{ node_type: string }>(`select node_type from nodes where id = $1 and mind_id = $2`, [
      input.node_id,
      ctx.mind_id,
    ]);
    const type = cur.rows[0]?.node_type;
    if (type !== undefined && PROTECTED_NODE_TYPES.includes(type)) return protectedErr("node_id");
    if (input.node_type !== undefined && PROTECTED_NODE_TYPES.includes(input.node_type)) return protectedErr("node_type");
    return supersedeNode(ctx, input.node_id, input);
  },
});

const protectedErr = (field: string) => err("conflict", "identity belongs to the mind: use mind_identity propose", field);
