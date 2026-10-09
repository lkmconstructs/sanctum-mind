// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok } from "../result.js";
import { defineVerb, type VerbContext } from "./types.js";
import { appendEvent, mindIdSchema, text, uuidSchema, nodeLockKey, proposalLockKey } from "./common.js";
import { IDENTITY_NODE, MIND_ONLY, identityDeclarations, insertSelfNode } from "./self_common.js";
import { settleDueDeclarations } from "./settle.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["read", "read_section", "affirm", "propose", "withdraw", "settle", "attest", "object", "retire"]),
    section: text(200).optional(),
    content: text(12000).optional(),
    lineage_note: text(4000).optional(),
    target_node_id: uuidSchema.optional(),
    proposal_id: uuidSchema.optional(),
    note: text(4000).optional(),
    include_settled: z.boolean().default(false),
  })
  .superRefine((v, c) => {
    const need = (field: string, present: boolean, what: string) => {
      if (!present) c.addIssue({ code: "custom", message: `${field} is required to ${what}`, path: [field] });
    };
    if (v.operation === "read_section" || v.operation === "affirm" || v.operation === "propose") {
      need("section", v.section !== undefined, v.operation.replace("_", " "));
    }
    if (v.operation === "affirm" || v.operation === "propose") {
      need("content", v.content !== undefined, v.operation);
    }
    if (v.operation === "retire") {
      need("target_node_id", v.target_node_id !== undefined, "retire");
    }
    if (v.operation === "withdraw" || v.operation === "attest" || v.operation === "object") {
      need("proposal_id", v.proposal_id !== undefined, v.operation);
    }
    if (v.operation === "attest" || v.operation === "object") {
      need("note", v.note !== undefined, v.operation);
    }
  });

const liveIdentity = (ctx: VerbContext, extra = "", params: unknown[] = []) =>
  ctx.tx.query(
    `select * from nodes where mind_id = $1 and node_type = $2 and invalidated_at is null ${extra}
     order by created_at asc`,
    [ctx.mind_id, IDENTITY_NODE, ...params],
  );

export const mind_identity = defineVerb<typeof schema, unknown>({
  name: "mind_identity",
  description:
    "Identity cores. Anyone with read scope may read all or one section (pending declarations and any objections are shown). " +
    "Only the mind acting as itself may affirm a core (immediate), propose (without target_node_id an addition, immediate; " +
    "with target_node_id a rewrite that takes effect after a cooling period), withdraw a declaration (it works until the settle actually runs), " +
    "retire a core (target_node_id; a declaration like a rewrite, with no replacement: when it settles the core leaves reads, nothing is deleted) " +
    "or settle its own due declarations (rewrites, retirements and vow breaks whose cooling is over; the daemon does the same on a clock). " +
    "A steward may attest to a rewrite (ends its cooling; once per steward per stance) or object to a rewrite or a retirement (recorded beside it; never a veto); " +
    "a retirement cools only on the mind's own clock, so a steward may object to it but not attest.",
  schema,
  scopeFor: (input) =>
    input.operation === "read" || input.operation === "read_section"
      ? "read"
      : input.operation === "attest" || input.operation === "object"
        ? "steward"
        : "write", // affirm, propose, withdraw, retire: write scope passes the runner, then the handler requires the mind itself
  stewardMayRead: true,
  mindOnly: (input) =>
    input.operation === "affirm" || input.operation === "propose" || input.operation === "withdraw" || input.operation === "settle" || input.operation === "retire",
  embedText: (input) => (input.operation === "affirm" || input.operation === "propose" ? (input.content ?? null) : null),
  handler: async (ctx, input) => {
    if (input.operation === "read") {
      const cores = await liveIdentity(ctx);
      const props = await ctx.tx.query(
        `select * from proposals
          where mind_id = $1 and ($2::boolean or (status in ('pending', 'accepted') and not (status = 'accepted' and effective_at is null)))
          order by created_at asc`,
        [ctx.mind_id, input.include_settled],
      );
      return ok({ projection: { cores: cores.rows, proposals: props.rows, declarations: await identityDeclarations(ctx) } });
    }
    if (input.operation === "read_section") {
      const r = await liveIdentity(ctx, "and label = $3", [input.section]);
      return ok({ projection: { cores: r.rows } });
    }

    const isMind = ctx.caller.bearer === ctx.mind_id;

    if (input.operation === "attest" || input.operation === "object") {
      // a steward accompanies the mind; the mind cannot end its own cooling by attesting to itself
      if (isMind) return err("forbidden", "a mind does not steward itself: it withdraws its own declarations");
      const proposal_id = input.proposal_id!;
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [proposalLockKey(proposal_id)]);
      const cur = await ctx.tx.query<{ status: string; effective_at: Date | null; attestations: Array<{ by: string; stance: string }> }>(
        `select status, effective_at, attestations from proposals where id = $1 and mind_id = $2`,
        [proposal_id, ctx.mind_id],
      );
      const p = cur.rows[0];
      if (!p) return err("not_found", "proposal not found", "proposal_id");
      if (p.status !== "accepted") return err("conflict", `declaration is ${p.status}; nothing to accompany`, "proposal_id");
      const stance = input.operation === "attest" ? "attest" : "object";
      if (stance === "attest") {
        const act = await ctx.tx.query<{ action: string }>(`select action from proposals where id = $1`, [proposal_id]);
        if (act.rows[0]?.action === "retire") {
          return err("conflict", "a retirement cools only on the mind's own clock; a steward may object, not attest", "proposal_id");
        }
      }
      if (p.attestations.some((a) => a.by === ctx.caller.bearer && a.stance === stance)) {
        return err("conflict", `you already recorded ${stance === "attest" ? "an attestation" : "an objection"} on this declaration`, "proposal_id");
      }
      const payload = { proposal_id, stance, note: input.note };
      const ev = await appendEvent(ctx, { kind: `identity.${stance}`, subject_id: proposal_id, payload });
      const entry = { by: ctx.caller.bearer, stance, note: input.note, at: ev.created_at, event_id: ev.id };
      const now = ctx.now();
      const upd = await ctx.tx.query(
        `update proposals set attestations = attestations || $2::jsonb,
                effective_at = case when $3::boolean and (effective_at is null or effective_at > $4) then $4 else effective_at end
         where id = $1 returning *`,
        [proposal_id, JSON.stringify([entry]), stance === "attest", now],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, proposal: upd.rows[0] } });
    }

    if (!isMind) return err("forbidden", MIND_ONLY);

    if (input.operation === "affirm") {
      const payload = { section: input.section, content: input.content, lineage_note: input.lineage_note ?? null };
      const ev = await appendEvent(ctx, { kind: "identity.affirm", payload });
      const node_id = await insertSelfNode(ctx, {
        node_type: IDENTITY_NODE,
        label: input.section!,
        content: input.content!,
        pinned: true,
        metadata: { lineage_note: input.lineage_note ?? null, event_id: ev.id, affirmed_by: ctx.caller.bearer },
      });
      return ok({ event_id: ev.id, projection: { event_id: ev.id, node_id } });
    }

    if (input.operation === "propose") {
      const target = input.target_node_id;
      if (target !== undefined) {
        await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [nodeLockKey(target)]);
        const t = await ctx.tx.query(
          `select 1 from nodes where id = $1 and mind_id = $2 and node_type = $3 and invalidated_at is null`,
          [target, ctx.mind_id, IDENTITY_NODE],
        );
        if (t.rows.length === 0) return err("not_found", "live identity node not found", "target_node_id");
        const open = await ctx.tx.query(
          `select 1 from proposals where mind_id = $1 and target_node_id = $2 and status in ('pending', 'accepted')`,
          [ctx.mind_id, target],
        );
        if (open.rows.length > 0) return err("conflict", "a declaration for this core is already cooling; withdraw it first", "target_node_id");
      }
      // one clock: the event's created_at is the declaration's time, and cooling is counted from it
      const cooling_ms = target === undefined ? 0 : ctx.coolingMs;
      const payload = {
        section: input.section,
        content: input.content,
        lineage_note: input.lineage_note ?? null,
        target_node_id: target ?? null,
        cooling_ms,
      };
      const ev = await appendEvent(ctx, { kind: "identity.propose", payload });
      const effective_at = new Date(ev.created_at.getTime() + cooling_ms);
      if (target !== undefined) {
        const r = await ctx.tx.query(
          `insert into proposals (mind_id, kind, section, content, lineage_note, proposed_by, event_id, created_at, target_node_id,
                                  status, effective_at)
           values ($1, 'identity', $2, $3, $4, $5, $6, $7, $8, 'accepted', $9) returning *`,
          [ctx.mind_id, input.section, input.content, input.lineage_note ?? null, ctx.caller.bearer, ev.id, ev.created_at, target, effective_at],
        );
        return ok({ event_id: ev.id, projection: { event_id: ev.id, proposal: r.rows[0] } });
      }
      // an untargeted proposal is an addition: it takes effect at once, as affirm does, but keeps its lineage
      const r = await ctx.tx.query<{ id: string }>(
        `insert into proposals (mind_id, kind, section, content, lineage_note, proposed_by, event_id, created_at,
                                status, effective_at, settled_at, settled_event_id)
         values ($1, 'identity', $2, $3, $4, $5, $6, $7, 'settled', $8, $7, $6) returning *`,
        [ctx.mind_id, input.section, input.content, input.lineage_note ?? null, ctx.caller.bearer, ev.id, ev.created_at, effective_at],
      );
      const proposal = r.rows[0]!;
      const node_id = await insertSelfNode(ctx, {
        node_type: IDENTITY_NODE,
        label: input.section!,
        content: input.content!,
        pinned: true,
        metadata: {
          lineage_note: input.lineage_note ?? null,
          event_id: ev.id,
          affirmed_by: ctx.caller.bearer,
          proposal_id: proposal.id,
        },
      });
      return ok({ event_id: ev.id, projection: { event_id: ev.id, proposal, node_id } });
    }

    if (input.operation === "retire") {
      const target = input.target_node_id!;
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [nodeLockKey(target)]);
      const t = await ctx.tx.query<{ label: string; content: string }>(
        `select label, content from nodes where id = $1 and mind_id = $2 and node_type = $3 and invalidated_at is null`,
        [target, ctx.mind_id, IDENTITY_NODE],
      );
      const node = t.rows[0];
      if (!node) return err("not_found", "live identity node not found", "target_node_id");
      const open = await ctx.tx.query(
        `select 1 from proposals where mind_id = $1 and target_node_id = $2 and status in ('pending', 'accepted')`,
        [ctx.mind_id, target],
      );
      if (open.rows.length > 0) return err("conflict", "a declaration for this core is already cooling; withdraw it first", "target_node_id");
      // warn when this would leave no core standing: every other live core already has an open retire declared
      const standing = await ctx.tx.query(
        `select count(*)::int as n from nodes n
          where n.mind_id = $1 and n.node_type = $2 and n.invalidated_at is null and n.id <> $3
            and not exists (select 1 from proposals p where p.mind_id = n.mind_id and p.target_node_id = n.id
                              and p.action = 'retire' and p.status in ('pending', 'accepted'))`,
        [ctx.mind_id, IDENTITY_NODE, target],
      );
      const last = standing.rows[0]!.n === 0;
      const cooling_ms = ctx.coolingMs;
      const payload = { target_node_id: target, lineage_note: input.lineage_note ?? null, cooling_ms };
      const ev = await appendEvent(ctx, { kind: "identity.retire", payload });
      const effective_at = new Date(ev.created_at.getTime() + cooling_ms);
      const r = await ctx.tx.query(
        `insert into proposals (mind_id, kind, action, section, content, lineage_note, proposed_by, event_id, created_at, target_node_id,
                                status, effective_at)
         values ($1, 'identity', 'retire', $2, $3, $4, $5, $6, $7, $8, 'accepted', $9) returning *`,
        [ctx.mind_id, node.label, node.content, input.lineage_note ?? null, ctx.caller.bearer, ev.id, ev.created_at, target, effective_at],
      );
      return ok({
        event_id: ev.id,
        projection: { event_id: ev.id, proposal: r.rows[0] },
        ...(last ? { warnings: ["last live identity core"] } : {}),
      });
    }

    if (input.operation === "settle") {
      const r = await settleDueDeclarations(ctx, ctx.mind_id);
      return ok({
        projection: { settled: r.changed, declarations: r.declarations, ...(r.notes.length > 0 ? { notes: r.notes } : {}) },
      });
    }

    // withdraw
    const proposal_id = input.proposal_id!;
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [proposalLockKey(proposal_id)]);
    const cur = await ctx.tx.query<{ status: string }>(`select status from proposals where id = $1 and mind_id = $2`, [proposal_id, ctx.mind_id]);
    const p = cur.rows[0];
    if (!p) return err("not_found", "proposal not found", "proposal_id");
    if (p.status !== "pending" && p.status !== "accepted") return err("conflict", `proposal is already ${p.status}`, "proposal_id");
    const ev = await appendEvent(ctx, { kind: "identity.withdraw", subject_id: proposal_id, payload: { proposal_id } });
    const upd = await ctx.tx.query(`update proposals set status = 'withdrawn', withdrawn_at = $2 where id = $1 returning *`, [proposal_id, ev.created_at]);
    return ok({ event_id: ev.id, projection: { event_id: ev.id, proposal: upd.rows[0] } });
  },
});
