// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";

/**
 * The payload shapes of the ledger events the extractor writes. They carry ids, counts and numbers ONLY, never text
 * from the mind's memory (no snippet, label, summary or content): the ledger is delivered to sinks and read by
 * grantees, and a proposal's wording belongs in the `noticings` row until the mind accepts it. strictObject refuses any
 * extra key, so a payload cannot grow a text field unnoticed; the passes parse through these before appending, and
 * test/notice.test.ts parses every `notice.*` event in the ledger against them.
 */
const kindOfNoticing = z.enum(["link", "pattern", "distillation"]);
const stageOfNoticing = z.enum(["shadow", "propose"]);

export const noticeProposedPayload = z.strictObject({
  noticing_id: z.uuid(),
  noticing_kind: kindOfNoticing,
  stage: stageOfNoticing,
  score: z.number(),
  source_count: z.number().int().min(1),
  model_version: z.number().int().min(0),
});

/** `reason: "imported"` is written by import-mind for a proposal it brings in expired; the pass writes the rest. */
export const noticeExpiredPayload = z.strictObject({
  noticing_id: z.uuid(),
  noticing_kind: kindOfNoticing.optional(),
  stage: stageOfNoticing.optional(),
  expires_at: z.string().optional(),
  reason: z.literal("imported").optional(),
});

export const noticeModelTrainedPayload = z.strictObject({
  version: z.number().int().min(0),
  trained_on: z.number().int().min(0),
  metrics: z.record(z.string(), z.number()),
});

export const EXTRACTOR_EVENT_SHAPES = {
  "notice.proposed": noticeProposedPayload,
  "notice.expired": noticeExpiredPayload,
  "notice.model.trained": noticeModelTrainedPayload,
} as const;
