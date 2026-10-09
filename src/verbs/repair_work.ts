// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { PoolClient } from "pg";

/**
 * Records that a node was invalidated, so belief repair will ask about what depended on it. Called in the SAME transaction as the
 * invalidation itself (supersedeNode, a settled identity retirement, a repair's retire), so the work exists exactly when the
 * invalidation does, whatever the commit timing. These are the only inserts into `repair_work` besides the operator's backfill
 * (src/extractor-admin.ts); the daemon pass only claims and acknowledges rows (updates).
 * The insert guard checks scope (the mind's own app.mind_id, actor verb, daemon or operator), not the bearer: the invalidation that causes
 * the row was already authorized by the verb runner (a write grantee may rethink), and the row is bookkeeping about it. Nothing here touches app.bearer.
 */
export async function recordRepairWork(
  tx: PoolClient,
  w: { mind_id: string; upstream_id: string; upstream_state: "superseded" | "retired"; replacement_id: string | null; created_event_id: string },
): Promise<void> {
  await tx.query(
    `insert into repair_work (mind_id, upstream_id, upstream_state, replacement_id, created_event_id)
     values ($1, $2, $3, $4, $5)
     on conflict (mind_id, upstream_id, created_event_id) do nothing`,
    [w.mind_id, w.upstream_id, w.upstream_state, w.replacement_id, w.created_event_id],
  );
}
