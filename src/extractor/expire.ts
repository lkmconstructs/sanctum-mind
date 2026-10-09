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
 * A pending non-repair proposal that cites a node since rewritten or retired can no longer be accepted (the accept refuses a dead
 * source), so it expires at once too, with `reason: "source_invalidated"` on its event (ids only). A repair is exempt: its upstream is
 * invalidated by definition.
 */
export const noticeExpire: DaemonPass = {
  name: "notice.expire",
  async run(ctx) {
    const now = ctx.now();
    const due = await ctx.tx.query<{ id: string; kind: string; stage: string; expires_at: Date; lapsed: boolean }>(
      `select n.id, n.kind, n.stage, n.expires_at, (n.expires_at <= $2) as lapsed from noticings n
        where n.mind_id = $1 and n.status = 'pending'
          and (n.expires_at <= $2
               or (n.kind <> 'repair' and exists (select 1 from nodes d where d.mind_id = n.mind_id and d.id = any(n.sources) and d.invalidated_at is not null)))
        order by n.expires_at, n.id for update of n`,
      [ctx.mind_id, now],
    );
    for (const n of due.rows) {
      const ev = await appendEvent(ctx, {
        kind: "notice.expired",
        subject_id: n.id,
        payload: noticeExpiredPayload.parse({
          noticing_id: n.id, noticing_kind: n.kind, stage: n.stage, expires_at: n.expires_at.toISOString(),
          reason: n.lapsed ? undefined : "source_invalidated",
        }),
      });
      await ctx.tx.query(
        `update noticings set status = 'expired', decided_event_id = $2, decided_at = $3 where id = $1 and mind_id = $4`,
        [n.id, ev.id, ev.created_at, ctx.mind_id],
      );
    }
    return { changed: due.rows.length };
  },
};
