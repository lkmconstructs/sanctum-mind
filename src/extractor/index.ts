// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * The extractor: an optional, operator-enabled pass that PROPOSES links, patterns and distillations.
 * See CONTRACTS.md, "Noticing: the extractor". README of this directory, in one place:
 *
 * THE STAGE RULE. There are two stages, `shadow` and `propose` (a check constraint in migration 0021 admits no
 * third). In `shadow` the extractor scores and records noticings the mind never sees. In `propose` it records
 * noticings the mind is shown, ranked, in `mind_notice list` and `mind_orient`. At NEITHER stage does anything in
 * this directory write memory. A proposal becomes memory only when the mind, acting as itself, calls
 * `mind_notice accept`; that verb (src/verbs/mind_notice.ts) authors the node or edge. No flag, environment
 * variable or operator command makes a proposal apply itself.
 *
 * What code in this directory may do:
 *   - write to the `noticings`, `extractor_models` and `extractor_runs` tables, and read `extractor_state` (the operator owns that one);
 *   - append ONLY these ledger events: `notice.proposed`, `notice.expired`, `notice.model.trained`.
 *     (Deciding a repair proposal is the mind's verb call, `mind_notice accept`, which is outside this directory.)
 * What it must not do: add rows to the memory tables (nodes, edges) or append any other event kind
 * (an observation, a write, a link, a distillation). test/extractor_guard.test.ts reads every file here and fails
 * on a violation, so the rule is enforced by the suite, not only by this comment.
 *
 * Operator administration (enable, pause, stage, report) is NOT in this directory: it lives in
 * src/extractor-admin.ts, so everything here is a pass that runs inside the daemon.
 *
 * The passes: `notice.expire` (expire.ts, deterministic, every tick), `notice.repair` (repair.ts, deterministic, every tick: proposes that the mind look at what depended on a node that was superseded or retired), `notice.extract` (extract.ts, model-backed, detached,
 * once a day at the schedule: candidates.ts finds what may belong together, features.ts and scorer.ts score it, a reranker
 * from src/rerank helps) and `notice.train` (train.ts, once a day after extract: refits the scorer from the mind's own
 * decisions). The event payload shapes (ids and numbers only) are in events.ts; the EXTRACTOR_* settings are read by config.ts.
 */
import { noticeExpire } from "./expire.js";
import { noticeExtract } from "./extract.js";
import { noticeRepair } from "./repair.js";
import { noticeTrain } from "./train.js";
export { noticeExpire, noticeExtract, noticeRepair, noticeTrain };
export {
  extractorTtlDays, noticingExpiresAt, DEFAULT_EXTRACTOR_TTL_DAYS,
  extractorReproposeDays, DEFAULT_EXTRACTOR_REPROPOSE_DAYS, extractorMaxCandidates, DEFAULT_EXTRACTOR_MAX_CANDIDATES, extractorLookbackDays, DEFAULT_EXTRACTOR_LOOKBACK_DAYS, checkExtractorEnv,
} from "./config.js";
export { EXTRACTOR_EVENT_SHAPES } from "./events.js";
export { FEATURE_NAMES, computeFeatures, type Features, type FeatureName } from "./features.js";
export { PRIOR_MODEL, loadModel, scoreOf, type Model } from "./scorer.js";

/** The deterministic passes of the extractor (every tick): expiry, and belief repair (repair.ts, which needs no model and runs with the extractor off). They are in the daemon's PASSES list. */
export const EXTRACTOR_DETERMINISTIC_PASSES = [noticeExpire, noticeRepair] as const;
/** The model-backed passes (extract, then train). They are in the daemon's MODEL_PASSES list. */
export const EXTRACTOR_MODEL_PASSES = [noticeExtract, noticeTrain] as const;
/** Every pass of the extractor, in run order. */
export const EXTRACTOR_PASSES = [noticeExpire, noticeRepair, noticeExtract, noticeTrain] as const;
