import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
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
  subject_id: z.uuid(),
  state: z.enum(["active", "processing"]).default("active"),
  note: text(4000).optional(),
});

export const mind_sit = defineVerb({
  name: "mind_sit",
  description:
    "Sit with a node or event: move it to active or processing. Moves only forward; a repeat with " +
    "the same state is a no-op unless a note is given, which annotates.",
  schema,
  scopeFor: () => "write",
  handler: async (ctx, input) => {
    await lockHolding(ctx, input.subject_id);
    const kind = await resolveSubjectKind(ctx, input.subject_id);
    if (!kind) return err("not_found", "subject not found", "subject_id");

    const current = await currentHolding(ctx, input.subject_id);
    const from: ChargeState = current?.state ?? "fresh";

    if (from === input.state) {
      if (input.note === undefined) {
        return ok({ projection: current, warnings: ["no-op"] });
      }
      const ev = await appendEvent(ctx, {
        kind: "sit.annotate",
        subject_id: input.subject_id,
        payload: { note: input.note },
      });
      const row = await upsertHolding(ctx, {
        subject_id: input.subject_id,
        subject_kind: kind,
        state: from,
        note: input.note,
        event_id: ev.id,
        at: ev.created_at,
      });
      return ok({ event_id: ev.id, projection: row });
    }

    if (!canTransition(from, input.state)) return backwardConflict(from, input.state);

    const ev = await appendEvent(ctx, {
      kind: "sit",
      subject_id: input.subject_id,
      payload: { state: input.state, note: input.note ?? null, subject_kind: kind },
    });
    const row = await upsertHolding(ctx, {
      subject_id: input.subject_id,
      subject_kind: kind,
      state: input.state,
      note: input.note ?? null,
      event_id: ev.id,
      at: ev.created_at,
    });
    return ok({ event_id: ev.id, projection: row });
  },
});
