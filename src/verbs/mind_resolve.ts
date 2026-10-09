// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text, uuidSchema } from "./common.js";
import {
  backwardConflict,
  canTransition,
  currentHolding,
  lockHolding,
  resolveSubjectKind,
  upsertHolding,
  type ChargeState,
} from "./charge.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  subject_id: uuidSchema,
  outcome: z.enum(["metabolized", "deferred", "released"]).default("metabolized"),
  resolution_note: text(4000).optional(),
});

export const mind_resolve = defineVerb({
  name: "mind_resolve",
  description:
    "Resolve a held subject as metabolized, deferred or released. Terminal: a resolved subject " +
    "accepts no further transitions.",
  schema,
  scopeFor: () => "write",
  handler: async (ctx, input) => {
    await lockHolding(ctx, input.subject_id);
    const kind = await resolveSubjectKind(ctx, input.subject_id);
    if (!kind) return err("not_found", "subject not found", "subject_id");

    const current = await currentHolding(ctx, input.subject_id);
    const from: ChargeState = current?.state ?? "fresh";
    if (!canTransition(from, input.outcome)) return backwardConflict(from, input.outcome);

    const ev = await appendEvent(ctx, {
      kind: "resolve",
      subject_id: input.subject_id,
      payload: { outcome: input.outcome, resolution_note: input.resolution_note ?? null, subject_kind: kind },
    });
    const row = await upsertHolding(ctx, {
      subject_id: input.subject_id,
      subject_kind: kind,
      state: input.outcome,
      note: input.resolution_note ?? null,
      event_id: ev.id,
      at: ev.created_at,
    });
    return ok({ event_id: ev.id, projection: row });
  },
});
