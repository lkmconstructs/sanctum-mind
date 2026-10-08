// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
import { MIND_ONLY, VOW_NODE, defaultLabel, insertSelfNode } from "./self_common.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["make", "list", "recall", "break", "withdraw_break", "note"]),
    vow: text(4000).optional(),
    context: text(4000).optional(),
    reason: text(4000).optional(),
    note: text(4000).optional(),
    vow_id: z.uuid().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .superRefine((v, c) => {
    const need = (field: string, present: boolean, what: string) => {
      if (!present) c.addIssue({ code: "custom", message: `${field} is required to ${what}`, path: [field] });
    };
    if (v.operation === "make") need("vow", v.vow !== undefined, "make a vow");
    if (v.operation === "break") {
      need("vow_id", v.vow_id !== undefined, "break a vow");
      need("reason", v.reason !== undefined, "break a vow");
    }
    if (v.operation === "withdraw_break") need("vow_id", v.vow_id !== undefined, "withdraw a break");
    if (v.operation === "recall") need("vow_id", v.vow_id !== undefined, "recall a vow");
    if (v.operation === "note") {
      need("vow_id", v.vow_id !== undefined, "note a vow");
      need("note", v.note !== undefined, "note a vow");
    }
  });

type VowMeta = Record<string, unknown> & { broken?: boolean; break_declared?: unknown };

export const mind_vow = defineVerb<typeof schema, unknown>({
  name: "mind_vow",
  description:
    "Vows are pinned graph nodes. Anyone with read scope may list live vows or recall one by id. Only the mind acting as itself " +
    "may make a vow (immediate), declare a break (takes effect after a cooling period; the vow stays live and is then marked broken) " +
    "or withdraw a declared break until it settles. A break cools only on the mind's own clock; a steward may add a note to a vow but cannot shorten a break.",
  schema,
  scopeFor: (input) =>
    input.operation === "list" || input.operation === "recall"
      ? "read"
      : input.operation === "note"
        ? "steward"
        : "write", // make, break, withdraw_break: write scope passes the runner, then the handler requires the mind itself
  stewardMayRead: true,
  mindOnly: (input) => input.operation === "make" || input.operation === "break" || input.operation === "withdraw_break",
  embedText: (input) => (input.operation === "make" ? (input.vow ?? null) : null),
  handler: async (ctx, input) => {
    if (input.operation === "list") {
      const r = await ctx.tx.query(
        `select * from nodes where mind_id = $1 and node_type = $2 and invalidated_at is null
         order by created_at asc limit $3`,
        [ctx.mind_id, VOW_NODE, input.limit],
      );
      return ok({
        projection: {
          vows: r.rows.map((row) => ({
            ...row,
            broken: row.metadata?.broken === true,
            break_declared: row.metadata?.break_declared ?? null,
          })),
        },
      });
    }

    if (input.operation === "recall") {
      const found = await ctx.tx.query(
        `select id from nodes where id = $1 and mind_id = $2 and node_type = $3 and invalidated_at is null`,
        [input.vow_id, ctx.mind_id, VOW_NODE],
      );
      if (found.rows.length === 0) return err("not_found", "vow not found", "vow_id");
      // Recall is a pure read: read-scoped calls run in a read-only transaction, so no access counters move.
      const r = await ctx.tx.query(`select * from nodes where id = $1`, [input.vow_id]);
      return ok({ projection: { vow: r.rows[0] } });
    }

    const loadVow = async (vow_id: string) => {
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`node:${vow_id}`]);
      const cur = await ctx.tx.query<{ metadata: VowMeta }>(
        `select metadata from nodes where id = $1 and mind_id = $2 and node_type = $3 and invalidated_at is null`,
        [vow_id, ctx.mind_id, VOW_NODE],
      );
      return cur.rows[0];
    };

    if (input.operation === "note") {
      const vow_id = input.vow_id!;
      const v = await loadVow(vow_id);
      if (!v) return err("not_found", "vow not found", "vow_id");
      const ev = await appendEvent(ctx, { kind: "vow.note", subject_id: vow_id, payload: { vow_id, note: input.note } });
      const prior = Array.isArray(v.metadata.steward_notes) ? v.metadata.steward_notes : [];
      const entry = { by: ctx.caller.bearer, note: input.note, at: ev.created_at, event_id: ev.id };
      const upd = await ctx.tx.query(`update nodes set metadata = $2::jsonb where id = $1 returning *`, [
        vow_id,
        JSON.stringify({ ...v.metadata, steward_notes: [...prior, entry] }),
      ]);
      return ok({ event_id: ev.id, projection: { event_id: ev.id, vow: upd.rows[0] } });
    }

    // everything below changes the mind's own vows: only the mind acting as itself
    if (ctx.caller.bearer !== ctx.mind_id) return err("forbidden", MIND_ONLY);

    if (input.operation === "make") {
      const vow = input.vow!;
      const ev = await appendEvent(ctx, { kind: "vow.make", payload: { vow, context: input.context ?? null } });
      const node_id = await insertSelfNode(ctx, {
        node_type: VOW_NODE,
        label: defaultLabel(vow),
        content: vow,
        pinned: true,
        metadata: { context: input.context ?? null, event_id: ev.id, made_at: ev.created_at, broken: false },
      });
      return ok({ event_id: ev.id, projection: { event_id: ev.id, node_id } });
    }

    const vow_id = input.vow_id!;
    const v = await loadVow(vow_id);
    if (!v) return err("not_found", "vow not found", "vow_id");
    if (v.metadata.broken === true) return err("conflict", "vow is already broken", "vow_id");

    if (input.operation === "break") {
      if (v.metadata.break_declared) return err("conflict", "a break is already declared for this vow", "vow_id");
      // one clock: the event's created_at is the declaration's time, and cooling is counted from it
      const ev = await appendEvent(ctx, {
        kind: "vow.break.declare",
        subject_id: vow_id,
        payload: { reason: input.reason, cooling_ms: ctx.coolingMs },
      });
      const declared_at = ev.created_at;
      const effective_at = new Date(declared_at.getTime() + ctx.coolingMs);
      const upd = await ctx.tx.query(`update nodes set metadata = $2::jsonb where id = $1 returning *`, [
        vow_id,
        JSON.stringify({
          ...v.metadata,
          break_declared: {
            reason: input.reason,
            declared_at: declared_at.toISOString(),
            effective_at: effective_at.toISOString(),
            event_id: ev.id,
          },
        }),
      ]);
      return ok({ event_id: ev.id, projection: { event_id: ev.id, vow: upd.rows[0] } });
    }

    // withdraw_break
    if (!v.metadata.break_declared) return err("conflict", "no break is declared for this vow", "vow_id");
    const { break_declared, ...rest } = v.metadata;
    const ev = await appendEvent(ctx, {
      kind: "vow.break.withdraw",
      subject_id: vow_id,
      payload: { vow_id, withdrawn: break_declared },
    });
    const upd = await ctx.tx.query(`update nodes set metadata = $2::jsonb where id = $1 returning *`, [vow_id, JSON.stringify(rest)]);
    return ok({ event_id: ev.id, projection: { event_id: ev.id, vow: upd.rows[0] } });
  },
});
