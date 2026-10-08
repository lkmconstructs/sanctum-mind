import type { AnyPass } from "./types.js";
import { drivesDecay } from "./drives_decay.js";
import { contextExpire } from "./context_expire.js";
import { loopsStale } from "./loops_stale.js";
import { holdingsSettle } from "./holdings_settle.js";
import { desiresFade } from "./desires_fade.js";
import { identitySettle } from "./identity_settle.js";
import { graphOrphans } from "./graph_orphans.js";
import { embeddingsBackfill } from "./embeddings_backfill.js";
import { lettersExpire } from "./letters_expire.js";
import { outboxDeliver } from "./outbox_deliver.js";

/** The passes in run order. */
export const PASSES: readonly AnyPass[] = [
  drivesDecay,
  contextExpire,
  loopsStale,
  holdingsSettle,
  desiresFade,
  identitySettle,
  graphOrphans,
  embeddingsBackfill,
  outboxDeliver,
  lettersExpire,
];

export type { AnyPass, DaemonPass, DetachedPass, DetachedPassContext, PassContext, PassResult } from "./types.js";
