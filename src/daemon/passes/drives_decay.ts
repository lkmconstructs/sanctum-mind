// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { DRIVES, levelsAt, loadDriveRows, persistDecay } from "../../verbs/drives.js";
import { HOUR_MS, ago, type DaemonPass, type PassContext } from "./types.js";

const EPSILON = 1e-6;

/** True when every stored drive of the lane, decayed to `now`, is within EPSILON of its baselines. */
async function atBaselines(ctx: PassContext, context: string, now: Date): Promise<boolean> {
  const rows = await loadDriveRows(ctx, context);
  if (rows.length === 0) return false;
  return rows.every((row) => {
    if (!(DRIVES as readonly string[]).includes(row.drive)) return false;
    const l = levelsAt(row, now);
    return (
      Math.abs(l.intensity - l.baselines.intensity) <= EPSILON &&
      Math.abs(l.frustration - l.baselines.frustration) <= EPSILON &&
      Math.abs(l.satisfaction - l.baselines.satisfaction) <= EPSILON
    );
  });
}

/** Persists decayed drive values for every lane that has a drive row older than the threshold (default 1 hour). */
export const drivesDecay: DaemonPass = {
  name: "drives.decay",
  async run(ctx) {
    const now = ctx.now();
    const lanes = await ctx.tx.query<{ context: string }>(
      `select distinct context from drive_state where mind_id = $1 and updated_at < $2 order by context`,
      [ctx.mind_id, ago(now, ctx.config.decayStaleHours, HOUR_MS)],
    );
    let changed = 0;
    for (const { context } of lanes.rows) {
      if (await atBaselines(ctx, context, now)) continue; // nothing left to decay: no event
      const done = await persistDecay(ctx, context, now);
      changed += done.drives.length;
    }
    return { changed };
  },
};
