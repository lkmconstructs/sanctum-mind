import { appendEvent } from "../../verbs/common.js";
import { DAY_MS, ago, type DaemonPass } from "./types.js";

/**
 * Letters unread for a long time age: nothing is deleted and read_at stays null. The event lands in the
 * RECIPIENT's ledger, which is the mind this pass runs for, so no cross-mind write happens.
 */
export const lettersExpire: DaemonPass = {
  name: "letters.expire",
  async run(ctx) {
    const now = ctx.now();
    const r = await ctx.tx.query<{ id: string; from_mind: string; letter_type: string; sent_at: Date }>(
      `select l.id, l.from_mind, l.letter_type, l.sent_at from letters l
       where l.to_mind = $1 and l.read_at is null and l.sent_at < $2 and (l.deliver_at is null or l.deliver_at <= $4)
         and not exists (
           select 1 from events e
           where e.mind_id = $1 and e.kind = 'daemon.letter.aging' and e.subject_id = l.id and e.recorded_at > $3)
       order by l.sent_at, l.id`,
      [ctx.mind_id, ago(now, ctx.config.letterAgingDays, DAY_MS), ago(now, ctx.config.letterRenotifyDays, DAY_MS), now],
    );
    for (const l of r.rows) {
      await appendEvent(ctx, {
        kind: "daemon.letter.aging",
        subject_id: l.id,
        payload: {
          letter_id: l.id,
          from: l.from_mind,
          letter_type: l.letter_type,
          age_days: Math.floor((now.getTime() - l.sent_at.getTime()) / DAY_MS),
        },
      });
    }
    return { changed: r.rows.length };
  },
};
