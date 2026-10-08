import { settleDueDeclarations } from "../../verbs/settle.js";
import type { DaemonPass } from "./types.js";

/**
 * Settles the mind's own declared identity changes whose cooling is over (see settleDueDeclarations).
 * The mind can do the same itself with mind_identity settle; the daemon is the fallback that settles on a clock.
 */
export const identitySettle: DaemonPass = {
  name: "identity.settle",
  async run(ctx) {
    const r = await settleDueDeclarations(ctx, ctx.mind_id);
    return r.notes.length > 0 ? { changed: r.changed, notes: r.notes } : { changed: r.changed };
  },
};
