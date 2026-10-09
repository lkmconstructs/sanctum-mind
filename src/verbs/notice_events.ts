// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";

/**
 * Payload shapes of the decision events `mind_notice` writes. Like the extractor's own (src/extractor/events.ts) they
 * carry ids only and no text from the memory: the words of an accepted pattern or distillation live in the `pattern` /
 * `distill` event and the node, not in `notice.accepted`. The one free-text field is `reason` on `notice.rejected`,
 * which is the mind's own words about its own decision.
 */
export const noticeAcceptedPayload = z.strictObject({
  noticing_id: z.uuid(),
  kind: z.enum(["link", "pattern", "distillation"]),
  sources: z.array(z.uuid()),
  edge_id: z.uuid().optional(),
  edge_type: z.string().optional(),
  existing: z.boolean().optional(),
  node_id: z.uuid().optional(),
  /** the pattern or distill event the node was made from */
  content_event_id: z.uuid().optional(),
  edited: z.boolean().optional(),
});

export const noticeRejectedPayload = z.strictObject({
  noticing_id: z.uuid(),
  kind: z.enum(["link", "pattern", "distillation"]),
  reason: z.string().nullable(),
});
