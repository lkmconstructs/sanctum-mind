import { appendEvent } from "../../verbs/common.js";
import { DAY_MS, ago, type DaemonPass } from "./types.js";

/** Flags nagging loops open too long, once per loop per window. Nothing is resolved. */
export const loopsStale: DaemonPass = {
  name: "loops.stale",
  async run(ctx) {
    const now = ctx.now();
    const r = await ctx.tx.query<{ id: string; created_at: Date }>(
      `select l.id, l.created_at from loops l
       where l.mind_id = $1 and l.resolved_at is null and l.urgency = 'nagging' and l.created_at < $2
         and not exists (
           select 1 from events e
           where e.mind_id = $1 and e.kind = 'daemon.loop.stale' and e.subject_id = l.id and e.recorded_at > $3)
       order by l.created_at, l.id`,
      [ctx.mind_id, ago(now, ctx.config.loopStaleDays, DAY_MS), ago(now, ctx.config.loopRenotifyDays, DAY_MS)],
    );
    for (const loop of r.rows) {
      const age_days = Math.floor((now.getTime() - loop.created_at.getTime()) / DAY_MS);
      await appendEvent(ctx, { kind: "daemon.loop.stale", subject_id: loop.id, payload: { loop_id: loop.id, age_days } });
    }
    return { changed: r.rows.length };
  },
};
