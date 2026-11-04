// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
import { MEMORY_MIND_ONLY } from "./self_common.js";
import { impersonatesSelf } from "../extractor/metabolise_prompt.js";

/** The most text one stretch may carry across all its turns (the model reads it in one call). */
export const METABOLISE_MAX_CHARS = 24_000;

const schema = z.strictObject({
  mind_id: mindIdSchema,
  turns: z.array(z.strictObject({
    speaker: z.enum(["self", "other"]),
    /** who `other` is, as the house knows them; shown to the model as the line's label */
    name: text(200).optional(),
    text: text(12000),
  })).min(1).max(60),
  /** where the stretch happened (a channel, a room, a situation), one short line */
  context: text(1000).optional(),
}).superRefine((v, c) => {
  v.turns.forEach((t, i) => {
    if (t.speaker === "self" && t.name !== undefined) {
      c.addIssue({ code: "custom", message: "a self turn is the mind and takes no name", path: ["turns", i, "name"] });
    }
    // An input check only, not load-bearing: the label's role comes from the speaker enum (every other turn is "[other...]"), so no name can forge "[me]".
    if (t.speaker === "other" && t.name !== undefined && impersonatesSelf(t.name)) {
      c.addIssue({ code: "custom", message: 'an other turn cannot be named "me": that label is the mind\'s own', path: ["turns", i, "name"] });
    }
  });
  const total = v.turns.reduce((n, t) => n + t.text.length, 0);
  if (total > METABOLISE_MAX_CHARS) {
    c.addIssue({ code: "custom", message: `the turns carry ${total} characters; at most ${METABOLISE_MAX_CHARS} across a stretch`, path: ["turns"] });
  }
});

/** The payload of a `metabolise.stretch` event: the turns as the house sent them (memory text, like a `write`), and the context. */
export const stretchPayload = z.strictObject({
  turns: z.array(z.strictObject({ speaker: z.enum(["self", "other"]), name: z.string().optional(), text: z.string() })).min(1),
  context: z.string().nullable(),
});

/**
 * The house's hand-off after a conversation stretch. Writes ONE ledger event, `metabolise.stretch` (the turns are experience: the
 * record of what was said, like any `write`), and one queue row naming it. Nothing else. The extractor's pass `notice.metabolise`
 * reads the queue later and may PROPOSE feelings and relations; nothing here becomes memory by itself.
 *
 * The stretch is recorded whether or not the extractor is on, paused or at shadow: the house must not lose a conversation because an
 * operator switch was off at the time. With the extractor off, paused or METABOLISER=none the row simply waits, and the daemon marks it failed "expired unprocessed" once it has been queued more than a week (expiry runs every tick regardless).
 *
 * No embedding: embedText is absent, so the event carries no vector. A raw transcript is bulk, and embedded it would drown the
 * mind's own observations in `mind_surface` and `mind_search`; what the mind keeps from a stretch it keeps through `mind_notice`.
 */
export const mind_metabolise = defineVerb({
  name: "mind_metabolise",
  description:
    "Hand over a stretch of conversation to be metabolised: turns of {speaker: self|other, name?, text}, with an optional context. " +
    "Records one ledger event (metabolise.stretch) and queues it; the operator-enabled extractor may later propose feelings and facts " +
    "about the people in it, which only you can accept (mind_notice). Recorded even when the extractor is off. Not embedded.",
  schema,
  scopeFor: () => "write",
  mindOnly: () => true,
  mindOnlyMessage: MEMORY_MIND_ONLY,
  handler: async (ctx, input): Promise<Result<unknown>> => {
    const ev = await appendEvent(ctx, {
      kind: "metabolise.stretch",
      payload: stretchPayload.parse({ turns: input.turns, context: input.context ?? null }),
    });
    const q = await ctx.tx.query<{ id: string }>(
      `insert into metabolise_queue (mind_id, stretch_event_id) values ($1, $2) returning id`,
      [ctx.mind_id, ev.id],
    );
    const queued_id = q.rows[0]!.id;
    return ok({ event_id: ev.id, projection: { event_id: ev.id, queued_id } });
  },
});
