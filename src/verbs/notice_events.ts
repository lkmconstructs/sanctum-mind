// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";

/**
 * Payload shapes of the decision events `mind_notice` writes. Like the extractor's own (src/extractor/events.ts) they
 * carry ids only and no text from the memory: the words of an accepted pattern or distillation live in the `pattern` /
 * `distill` event and the node, not in `notice.accepted`. The one free-text field is `reason` on `notice.rejected`,
 * which is the mind's own words about its own decision.
 */
export const REPAIR_DECISIONS = ["keep", "rethink", "retire"] as const;

export const noticeAcceptedPayload = z.strictObject({
  noticing_id: z.uuid(),
  kind: z.enum(["link", "pattern", "distillation", "repair"]),
  /** every kind but repair names its sources; a repair names only its decision */
  sources: z.array(z.uuid()).optional(),
  /** repair: what the mind decided about the dependant */
  decision: z.enum(REPAIR_DECISIONS).optional(),
  edge_id: z.uuid().optional(),
  edge_type: z.string().optional(),
  existing: z.boolean().optional(),
  node_id: z.uuid().optional(),
  /** the pattern or distill event the node was made from */
  content_event_id: z.uuid().optional(),
  edited: z.boolean().optional(),
}).superRefine((v, c) => {
  if (v.kind === "repair") {
    if (v.decision === undefined) c.addIssue({ code: "custom", message: "a repair is decided keep, rethink or retire", path: ["decision"] });
  } else {
    if (v.sources === undefined) c.addIssue({ code: "custom", message: "sources are required", path: ["sources"] });
    if (v.decision !== undefined) c.addIssue({ code: "custom", message: "decision applies to a repair only", path: ["decision"] });
  }
});

/** The ids-only payloads of the three events that record what became of a dependant (subject = the dependant node). The mind's new wording is in the `rethink` event and the node. */
export const repairKeptPayload = z.strictObject({ noticing_id: z.uuid(), upstream_id: z.uuid() });
export const repairRethoughtPayload = z.strictObject({ noticing_id: z.uuid(), upstream_id: z.uuid(), node_id: z.uuid() });
export const repairRetiredPayload = z.strictObject({ noticing_id: z.uuid(), upstream_id: z.uuid() });

export const noticeRejectedPayload = z.strictObject({
  noticing_id: z.uuid(),
  kind: z.enum(["link", "pattern", "distillation", "repair"]),
  reason: z.string().nullable(),
});
