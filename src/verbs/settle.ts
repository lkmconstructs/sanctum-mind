// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { appendEvent } from "./common.js";
import { VOW_NODE, supersedeNode } from "./self_common.js";
import type { VerbContext } from "./types.js";

export interface SettledDeclaration {
  kind: "rewrite" | "retire" | "vow_break";
  proposal_id?: string;
  vow_id?: string;
  target_node_id: string;
  /** rewrite only: the replacement node */
  node_id?: string;
}

export interface SettleResult {
  changed: number;
  declarations: SettledDeclaration[];
  notes: string[];
}

/**
 * Settles declared identity changes whose cooling is over: a rewrite of a core (the accepted proposal's
 * supersede is performed), the retirement of a core (the node is invalidated, nothing replaces it) and the breaking of a vow (the declared break becomes a settled one). Everything
 * is written by the mind itself; it applies only declarations the mind made itself, whose time has passed.
 * Shared by the daemon pass identity.settle and the verb mind_identity settle, so both do exactly the same.
 * Runs inside the caller's transaction, scoped to `mind` (which must be ctx.mind_id).
 */
export async function settleDueDeclarations(ctx: VerbContext, mind: string): Promise<SettleResult> {
  if (mind !== ctx.mind_id) throw new Error("settleDueDeclarations: mind must be the context's mind");
  const now = ctx.now();
  const declarations: SettledDeclaration[] = [];
  const notes: string[] = [];

  const props = await ctx.tx.query<{ id: string }>(
    `select p.id from proposals p
       join nodes n on n.id = p.target_node_id and n.mind_id = p.mind_id and n.node_type = 'identity' and n.invalidated_at is null
     where p.mind_id = $1 and p.status = 'accepted' and p.effective_at <= $2 and p.withdrawn_at is null and p.settled_at is null
       and p.proposed_by = p.mind_id
     order by p.effective_at, p.created_at, p.id`,
    [mind, now],
  );
  for (const { id } of props.rows) {
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`proposal:${id}`]);
    // re-read under the lock: a withdrawal that committed meanwhile wins
    const cur = await ctx.tx.query<{
      section: string;
      content: string;
      lineage_note: string | null;
      target_node_id: string | null;
      attestations: unknown;
      action: "rewrite" | "retire";
    }>(
      `select p.action, p.section, p.content, p.lineage_note, p.target_node_id, p.attestations from proposals p
         join nodes n on n.id = p.target_node_id and n.mind_id = p.mind_id and n.node_type = 'identity' and n.invalidated_at is null
       where p.id = $1 and p.mind_id = $2 and p.status = 'accepted' and p.withdrawn_at is null and p.settled_at is null
         and p.proposed_by = p.mind_id`,
      [id, mind],
    );
    const p = cur.rows[0];
    if (!p || p.target_node_id === null) continue;
    if (p.action === "retire") {
      // the core is invalidated, not replaced and not deleted; edges stay as they are (supersedeNode leaves the old node's edges too)
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`node:${p.target_node_id}`]);
      const ev = await appendEvent(ctx, {
        kind: "identity.retired",
        subject_id: id,
        payload: { proposal_id: id, target_node_id: p.target_node_id, lineage_note: p.lineage_note },
      });
      const upd = await ctx.tx.query(
        `update nodes set invalidated_at = $2, metadata = metadata || $3::jsonb
          where id = $1 and mind_id = $4 and node_type = 'identity' and invalidated_at is null`,
        [
          p.target_node_id,
          ev.created_at,
          JSON.stringify({
            retired: true,
            retired_at: ev.created_at,
            retired_reason: p.lineage_note,
            retire_proposal_id: id,
            retire_attestations: p.attestations,
          }),
          mind,
        ],
      );
      if (upd.rowCount !== 1) throw new Error(`identity retire ${id}: core ${p.target_node_id} vanished under the lock`);
      await ctx.tx.query(
        `update proposals set status = 'settled', settled_at = $2, settled_event_id = $3 where id = $1 and mind_id = $4`,
        [id, ev.created_at, ev.id, mind],
      );
      declarations.push({ kind: "retire", proposal_id: id, target_node_id: p.target_node_id });
      continue;
    }
    const sup = await supersedeNode(ctx, p.target_node_id, {
      content: p.content,
      label: p.section,
      reason: p.lineage_note ?? `identity proposal ${id} settled`,
      provenance: { proposal_id: id, lineage_note: p.lineage_note, attestations: p.attestations },
    });
    if (!sup.ok) {
      notes.push(`proposal ${id}: ${sup.error.message}`);
      continue;
    }
    const ev = await appendEvent(ctx, {
      kind: "identity.settled",
      subject_id: id,
      payload: { proposal_id: id, target_node_id: p.target_node_id, node_id: sup.receipt.projection!.node_id },
    });
    await ctx.tx.query(
      `update proposals set status = 'settled', settled_at = $2, settled_event_id = $3 where id = $1 and mind_id = $4`,
      [id, ev.created_at, ev.id, mind],
    );
    declarations.push({
      kind: "rewrite",
      proposal_id: id,
      target_node_id: p.target_node_id,
      node_id: sup.receipt.projection!.node_id as string,
    });
  }

  const vows = await ctx.tx.query<{ id: string }>(
    `select id from nodes
     where mind_id = $1 and node_type = $2 and invalidated_at is null
       and jsonb_typeof(metadata->'break_declared') = 'object'
       and (metadata->'break_declared'->>'effective_at')::timestamptz <= $3
     order by created_at, id`,
    [mind, VOW_NODE, now],
  );
  for (const { id } of vows.rows) {
    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`node:${id}`]);
    const cur = await ctx.tx.query<{ metadata: Record<string, any> }>(
      `select metadata from nodes where id = $1 and mind_id = $2 and node_type = $3 and invalidated_at is null
         and jsonb_typeof(metadata->'break_declared') = 'object'`,
      [id, mind, VOW_NODE],
    );
    const v = cur.rows[0];
    if (!v) continue;
    const { break_declared: d, ...rest } = v.metadata;
    const ev = await appendEvent(ctx, {
      kind: "vow.break.settled",
      subject_id: id,
      payload: { vow_id: id, reason: d.reason, declared_event_id: d.event_id },
    });
    await ctx.tx.query(`update nodes set metadata = $2::jsonb where id = $1 and mind_id = $3`, [
      id,
      JSON.stringify({ ...rest, broken: true, broken_at: ev.created_at, broken_reason: d.reason, broken_by: mind }),
      mind,
    ]);
    declarations.push({ kind: "vow_break", vow_id: id, target_node_id: id });
  }
  return { changed: declarations.length, declarations, notes };
}
