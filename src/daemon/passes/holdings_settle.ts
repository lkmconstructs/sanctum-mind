// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { appendEvent } from "../../verbs/common.js";
import { canTransition, currentHolding, lockHolding, upsertHolding } from "../../verbs/charge.js";
import { DAY_MS, ago, type DaemonPass } from "./types.js";

/** Moves long-untouched active or processing holdings to deferred (a legal forward transition). */
export const holdingsSettle: DaemonPass = {
  name: "holdings.settle",
  async run(ctx) {
    const now = ctx.now();
    const r = await ctx.tx.query<{ subject_id: string }>(
      `select subject_id from holdings
       where mind_id = $1 and state in ('active', 'processing') and updated_at < $2 order by updated_at, subject_id`,
      [ctx.mind_id, ago(now, ctx.config.holdingSettleDays, DAY_MS)],
    );
    let changed = 0;
    for (const { subject_id } of r.rows) {
      await lockHolding(ctx, subject_id);
      // Re-read under the lock: a concurrent sit or resolve may have moved it.
      const cur = await currentHolding(ctx, subject_id);
      if (!cur || !canTransition(cur.state, "deferred")) continue;
      if (cur.state !== "active" && cur.state !== "processing") continue;
      if (cur.updated_at.getTime() >= ago(now, ctx.config.holdingSettleDays, DAY_MS).getTime()) continue;
      const ev = await appendEvent(ctx, {
        kind: "daemon.holding.settle",
        subject_id,
        payload: { from: cur.state, to: "deferred", idle_days: Math.floor((now.getTime() - cur.updated_at.getTime()) / DAY_MS) },
      });
      await upsertHolding(ctx, {
        subject_id,
        subject_kind: cur.subject_kind,
        state: "deferred",
        note: cur.note,
        event_id: ev.id,
        at: ev.created_at,
      });
      changed++;
    }
    return { changed };
  },
};
