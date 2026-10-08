import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";

const FIELDS = ["mood", "energy", "momentum", "register", "afterglow", "note"] as const;

const schema = z.strictObject({
  mind_id: mindIdSchema,
  operation: z.enum(["set", "update", "read"]),
  mood: text().optional(),
  energy: z.enum(["high", "medium", "low", "depleted"]).optional(),
  momentum: z.enum(["driving", "steady", "coasting", "stalled"]).optional(),
  register: text().optional(),
  afterglow: text().optional(),
  note: text().optional(),
});

/**
 * `read` needs a read grant, `set` and `update` need write (scopeFor); the runner enforces
 * that and runs reads in a read-only transaction.
 *
 * `set` and `update` are the same operation (a patch: omitted fields survive), kept as
 * two names kept for callers that distinguish them.
 */
export const mind_state = defineVerb({
  name: "mind_state",
  description:
    "Read or patch a mind's current state (mood, energy, momentum, register, afterglow, note). " +
    "set and update are identical patches: omitted fields keep their current value, " +
    "so a field cannot be cleared once set, only overwritten.",
  schema,
  scopeFor: (input) => (input.operation === "read" ? "read" : "write"),
  handler: async (ctx, input) => {
    if (input.operation === "read") {
      const r = await ctx.tx.query(`select * from brain_state where mind_id = $1`, [ctx.mind_id]);
      return ok({ projection: r.rows[0] ?? null });
    }

    const supplied: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = input[f];
      if (v !== undefined) supplied[f] = v;
    }
    if (Object.keys(supplied).length === 0) {
      return err("invalid_input", "at least one state field is required", "operation");
    }

    // Serialise writers per mind so projection order equals ledger (seq) order.
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext('brain_state:' || $1))", [ctx.mind_id]);
    const ev = await appendEvent(ctx, { kind: "state.set", payload: supplied });
    const r = await ctx.tx.query(
      `insert into brain_state (mind_id, mood, energy, momentum, register, afterglow, note, last_event_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (mind_id) do update set
         mood = coalesce(excluded.mood, brain_state.mood),
         energy = coalesce(excluded.energy, brain_state.energy),
         momentum = coalesce(excluded.momentum, brain_state.momentum),
         register = coalesce(excluded.register, brain_state.register),
         afterglow = coalesce(excluded.afterglow, brain_state.afterglow),
         note = coalesce(excluded.note, brain_state.note),
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at
       returning *`,
      [
        ctx.mind_id,
        supplied.mood ?? null,
        supplied.energy ?? null,
        supplied.momentum ?? null,
        supplied.register ?? null,
        supplied.afterglow ?? null,
        supplied.note ?? null,
        ev.id,
        ev.created_at,
      ],
    );
    return ok({ event_id: ev.id, projection: r.rows[0] });
  },
});
