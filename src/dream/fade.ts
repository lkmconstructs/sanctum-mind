// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { appendEvent } from "../verbs/common.js";
import type { DaemonPass } from "../daemon/passes/types.js";
import { dreamFadedPayload } from "./events.js";

/**
 * `dream.fade`: laid dreams whose `fades_at` has passed become `faded`, each with a `dream.faded` event (subject = the
 * dream). Deterministic, no model, every tick, as the mind (so the decision guard in migration 0027 passes). Shadow dreams
 * fade too. A dream nobody anchored is residue that dissolved, which is the normal fate of a dream; fading changes nothing
 * but the dream's row.
 */
export const dreamFade: DaemonPass = {
  name: "dream.fade",
  async run(ctx) {
    const now = ctx.now();
    const due = await ctx.tx.query<{ id: string; stage: "shadow" | "propose"; fades_at: Date }>(
      `select id, stage, fades_at from dreams where mind_id = $1 and status = 'laid' and fades_at <= $2 order by fades_at, id for update`,
      [ctx.mind_id, now],
    );
    for (const d of due.rows) {
      const ev = await appendEvent(ctx, {
        kind: "dream.faded",
        subject_id: d.id,
        payload: dreamFadedPayload.parse({ dream_id: d.id, stage: d.stage, fades_at: d.fades_at.toISOString() }),
      });
      await ctx.tx.query(`update dreams set status = 'faded', decided_event_id = $2, decided_at = $3 where id = $1 and mind_id = $4`, [
        d.id, ev.id, ev.created_at, ctx.mind_id,
      ]);
    }
    return { changed: due.rows.length };
  },
};
