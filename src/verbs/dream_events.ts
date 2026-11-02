// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";

/**
 * The payload shapes of the ledger events `mind_dream` writes as the mind: ids and counts, never the dream's text (that is in
 * the observation the mind authored when it anchored, and in the `dreams` row). `reason` on a release is the mind's own
 * words and the one free-text field. The pass's own events (dream.laid, dream.faded) are in src/dream/events.ts.
 */
export const dreamAnchoredPayload = z.strictObject({
  dream_id: z.uuid(),
  event_id: z.uuid(),
  node_id: z.uuid(),
  /** the mind gave its own account rather than the dream's text */
  edited: z.boolean(),
});

export const dreamReleasedPayload = z.strictObject({
  dream_id: z.uuid(),
  reason: z.string().max(4000).optional(),
});

export const dreamPreferencePayload = z.strictObject({
  relations: z.union([z.literal("all"), z.literal("none"), z.number().int().min(0)]),
});

export const DREAM_VERB_EVENT_SHAPES = {
  "dream.anchored": dreamAnchoredPayload,
  "dream.released": dreamReleasedPayload,
  "dream.preference": dreamPreferencePayload,
} as const;
