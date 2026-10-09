// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
import { PIN_TYPES, collectAttention, liveItem, type PinType } from "./attention.js";

/** The `forbidden` text for pinning or releasing when the caller is not the mind itself. */
export const ATTENTION_MIND_ONLY = "attention is directed by the mind";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["list", "pin", "release"]),
    /** list: how many items; default 12, at most 50 */
    limit: z.number().int().min(1).max(50).default(12),
    /** pin; release (with item_id) */
    item_type: z.enum(PIN_TYPES).optional(),
    item_id: z.uuid().optional(),
    /** pin: why the mind is keeping it in view */
    note: text(1000).optional(),
    /** release: the pin itself, instead of item_type and item_id */
    pin_id: z.uuid().optional(),
  })
  .superRefine((v, c) => {
    const need = (field: "item_type" | "item_id", present: boolean, doing: string) => {
      if (!present) c.addIssue({ code: "custom", message: `${field} is required to ${doing}`, path: [field] });
    };
    if (v.operation === "pin") {
      need("item_type", v.item_type !== undefined, "pin");
      need("item_id", v.item_id !== undefined, "pin");
      if (v.pin_id !== undefined) c.addIssue({ code: "custom", message: "pin_id applies to release only", path: ["pin_id"] });
    }
    if (v.operation === "release") {
      if (v.pin_id === undefined) {
        need("item_type", v.item_type !== undefined, "release (or give pin_id)");
        need("item_id", v.item_id !== undefined, "release (or give pin_id)");
      } else if (v.item_type !== undefined || v.item_id !== undefined) {
        c.addIssue({ code: "custom", message: "release by pin_id or by item_type and item_id, not both", path: ["pin_id"] });
      }
      if (v.note !== undefined) c.addIssue({ code: "custom", message: "note applies to pin only", path: ["note"] });
    }
    if (v.operation === "list" && (v.item_type !== undefined || v.item_id !== undefined || v.note !== undefined || v.pin_id !== undefined)) {
      c.addIssue({ code: "custom", message: "list takes no item, note or pin", path: ["operation"] });
    }
  });

interface PinOut {
  id: string;
  item_type: PinType;
  item_id: string;
  note: string | null;
  pinned_event_id: string;
  pinned_at: Date;
  released_event_id: string | null;
  released_at: Date | null;
}

export const mind_attend = defineVerb({
  name: "mind_attend",
  description:
    "What the mind is carrying, and what it keeps in view. list: the heaviest things now (open loops, active threads, open tasks, live desires, " +
    "declarations still cooling, noticings and repairs waiting, held charges, anything pinned), each with a weight from 0 to 1 that is plain " +
    "arithmetic on recency, charge, kind and pin. pin and release are for the mind acting as itself: pinning keeps a thing in view and changes " +
    "nothing about it; releasing drops the pin. list needs read scope (a steward grant alone is not enough); a grantee with read can list but cannot pin.",
  schema,
  scopeFor: (input) => (input.operation === "list" ? "read" : "write"),
  mindOnly: (input) => input.operation === "pin" || input.operation === "release",
  mindOnlyMessage: ATTENTION_MIND_ONLY,
  handler: async (ctx, input): Promise<Result<unknown>> => {
    if (input.operation === "list") {
      const { items, pins } = await collectAttention(ctx);
      return ok({
        projection: {
          items: items.slice(0, input.limit).map((x) => ({
            type: x.type, id: x.id, label: x.label, weight: x.weight, since: x.since, pinned: x.pinned, ...(x.note === null ? {} : { note: x.note }),
          })),
          pins: pins.length,
        },
      });
    }
    // the mind, in a verb call: the database checks the same (app.actor = 'verb' and the bearer is the mind)
    if (ctx.caller.bearer !== ctx.mind_id || ctx.actor !== "verb") return err("forbidden", ATTENTION_MIND_ONLY);

    if (input.operation === "pin") {
      const type = input.item_type!;
      const id = input.item_id!.toLowerCase();
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`attend:${ctx.mind_id}:${type}:${id}`]);
      const live = await liveItem(ctx, type, id);
      if (!live) return err("not_found", `${type} not found, or no longer live`, "item_id");
      const have = await ctx.tx.query(`select 1 from attention_pins where mind_id = $1 and item_type = $2 and item_id = $3 and released_at is null`, [ctx.mind_id, type, id]);
      if (have.rows.length > 0) return err("conflict", `${type} is already pinned`, "item_id");
      const note = input.note ?? null;
      const ev = await appendEvent(ctx, { kind: "attend.pin", subject_id: id, payload: { item_type: type, item_id: id, note } });
      const r = await ctx.tx.query<PinOut>(
        `insert into attention_pins (mind_id, item_type, item_id, note, pinned_event_id, pinned_at) values ($1, $2, $3, $4, $5, $6) returning *`,
        [ctx.mind_id, type, id, note, ev.id, ev.created_at],
      );
      return ok({ event_id: ev.id, projection: { pin: r.rows[0] } });
    }

    // release: by pin id, or by the item
    const found =
      input.pin_id !== undefined
        ? await ctx.tx.query<PinOut>(`select * from attention_pins where mind_id = $1 and id = $2 and released_at is null for update`, [ctx.mind_id, input.pin_id])
        : await ctx.tx.query<PinOut>(
            `select * from attention_pins where mind_id = $1 and item_type = $2 and item_id = $3 and released_at is null for update`,
            [ctx.mind_id, input.item_type, input.item_id!.toLowerCase()],
          );
    const pin = found.rows[0];
    if (!pin) return err("not_found", "no live pin", input.pin_id !== undefined ? "pin_id" : "item_id");
    const ev = await appendEvent(ctx, {
      kind: "attend.release",
      subject_id: pin.item_id,
      payload: { item_type: pin.item_type, item_id: pin.item_id, pin_id: pin.id },
    });
    const r = await ctx.tx.query<PinOut>(
      `update attention_pins set released_at = $2, released_event_id = $3 where id = $1 returning *`,
      [pin.id, ev.created_at, ev.id],
    );
    return ok({ event_id: ev.id, projection: { pin: r.rows[0] } });
  },
});
