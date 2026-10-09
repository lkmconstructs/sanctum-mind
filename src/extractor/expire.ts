// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { appendEvent } from "../verbs/common.js";
import type { DaemonPass } from "../daemon/passes/types.js";
import { noticeExpiredPayload } from "./events.js";

/**
 * `notice.expire`: pending noticings whose `expires_at` has passed become `expired`, each with a `notice.expired`
 * event (subject = the noticing). Deterministic, no model, runs every tick as the mind (so the decision guard in
 * migration 0021 passes). Shadow noticings expire too: they count as nothing. Expiry removes only the proposal;
 * the sources, and everything else, are untouched. It is the training signal that the mind let a proposal lapse.
 */
export const noticeExpire: DaemonPass = {
  name: "notice.expire",
  async run(ctx) {
    const now = ctx.now();
    const due = await ctx.tx.query<{ id: string; kind: string; stage: string; expires_at: Date }>(
      `select id, kind, stage, expires_at from noticings
        where mind_id = $1 and status = 'pending' and expires_at <= $2
        order by expires_at, id for update`,
      [ctx.mind_id, now],
    );
    for (const n of due.rows) {
      const ev = await appendEvent(ctx, {
        kind: "notice.expired",
        subject_id: n.id,
        payload: noticeExpiredPayload.parse({ noticing_id: n.id, noticing_kind: n.kind, stage: n.stage, expires_at: n.expires_at.toISOString() }),
      });
      await ctx.tx.query(
        `update noticings set status = 'expired', decided_event_id = $2, decided_at = $3 where id = $1 and mind_id = $4`,
        [n.id, ev.id, ev.created_at, ctx.mind_id],
      );
    }
    return { changed: due.rows.length };
  },
};
