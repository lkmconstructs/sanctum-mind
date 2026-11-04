// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";

/**
 * The payload shapes of the ledger events the dreaming pass writes: ids, counts and a version string, never the dream's text.
 * The text of a dream lives in the `dreams` row until the mind anchors it (and then in the observation the mind authored).
 * strictObject refuses any extra key. The verb's own events (dream.anchored, dream.released, dream.preference) are in
 * src/verbs/dream_events.ts.
 */
const stageOfDream = z.enum(["shadow", "propose"]);

export const dreamLaidPayload = z.strictObject({
  dream_id: z.uuid(),
  stage: stageOfDream,
  model_version: z.string().min(1).max(200),
  residue_counts: z.strictObject({
    events: z.number().int().min(0),
    nodes: z.number().int().min(0),
    relations: z.number().int().min(0),
    pinned: z.number().int().min(0),
    dropped: z.number().int().min(0),
  }),
  window: z.strictObject({ from: z.string(), to: z.string() }),
});

/** `reason: "imported"` is written by import-mind for a dream it brings in faded. */
export const dreamFadedPayload = z.strictObject({
  dream_id: z.uuid(),
  stage: stageOfDream.optional(),
  fades_at: z.string().optional(),
  reason: z.enum(["imported"]).optional(),
});

export const DREAM_EVENT_SHAPES = {
  "dream.laid": dreamLaidPayload,
  "dream.faded": dreamFadedPayload,
} as const;
