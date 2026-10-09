// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

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
import { noticeExpire } from "../../extractor/expire.js";
import { noticeExtract } from "../../extractor/extract.js";
import { noticeRepair } from "../../extractor/repair.js";
import { noticeTrain } from "../../extractor/train.js";
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
  noticeExpire,
  noticeRepair,
];

/**
 * The model-backed passes of the extractor, listed apart from the twelve deterministic ones: each runs only for a mind whose
 * extractor the operator has enabled, at most once a day at its schedule. They run after PASSES in a normal tick, and
 * report a "skipped" note when there is nothing to do.
 */
export const MODEL_PASSES: readonly AnyPass[] = [noticeExtract, noticeTrain];

/** What a normal tick runs: the deterministic passes, then the model-backed ones. */
export const ALL_PASSES: readonly AnyPass[] = [...PASSES, ...MODEL_PASSES];

export type { AnyPass, DaemonPass, DetachedPass, DetachedPassContext, PassContext, PassResult } from "./types.js";
