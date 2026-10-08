// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { ok } from "../result.js";
import { defineVerb } from "./types.js";
import { mindIdSchema, text } from "./common.js";
import { eventTime, instant, texture } from "./texture.js";
import { appendEventWithTimes } from "./ledger.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  type: z.enum(["identity", "operational", "episodic", "journal", "note"]),
  text: text(12000),
  tags: z.array(text(64)).max(32).optional(),
  texture: texture.optional(),
  context: text(64).optional(),
  recorded_at: instant.optional(),
  event_time: eventTime.optional(),
});

export const mind_write = defineVerb({
  name: "mind_write",
  description:
    "Append a plain record to the ledger (identity, operational, episodic, journal or note). " +
    "No graph node is created; use mind_observe for lived experience worth curating.",
  schema,
  scopeFor: () => "write",
  embedText: (input) => input.text,
  handler: async (ctx, input) => {
    const payload: Record<string, unknown> = { type: input.type, text: input.text, tags: input.tags ?? [] };
    if (input.event_time?.text !== undefined) payload.event_time_text = input.event_time.text;
    const ev = await appendEventWithTimes(ctx, {
      kind: "write",
      payload,
      embedded: ctx.embedded,
      ...(input.texture === undefined ? {} : { texture: input.texture }),
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.recorded_at === undefined ? {} : { recorded_at: input.recorded_at }),
      ...(input.event_time === undefined ? {} : { event_time: input.event_time }),
    });
    return ok({ event_id: ev.id, projection: { event_id: ev.id, seq: ev.seq, created_at: ev.created_at } });
  },
});
