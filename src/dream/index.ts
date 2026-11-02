// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * Dreaming: an optional, operator-enabled pass that LAYS DOWN one dream from the day's residue. See CONTRACTS.md,
 * "Dreaming". The rule of this directory is the extractor's rule (src/extractor/index.ts), applied to dreams:
 *
 * A dream is residue, never memory. It lives in `dreams` until the mind, acting as itself, calls `mind_dream anchor`
 * (src/verbs/mind_dream.ts, outside this directory), which authors an observation as the mind through mind_observe's own
 * write path. A dream nobody anchors fades. There are two stages, `shadow` and `propose` (a check constraint in migration
 * 0027 admits no third); at NEITHER stage does anything here write memory.
 *
 * What code in this directory may do:
 *   - write to `dreams` and `extractor_runs`, and read `dream_state` and `dream_preferences` (the operator owns the first, the
 *     mind the second);
 *   - append ONLY these ledger events: `dream.laid`, `dream.faded`.
 * What it must not do: add rows to nodes or edges, or append any other event kind. test/dream_guard.test.ts reads every file
 * here and fails on a violation (the same scanner as the extractor's), so the rule is enforced by the suite.
 *
 * Operator administration (enable, pause, stage, gap, report) is NOT here: src/dream-admin.ts.
 *
 * The passes: `dream.fade` (fade.ts, deterministic, every tick) and `dream.generate` (generate.ts, model-backed, detached, once a
 * day at the schedule, at most once per `gap_hours`: residue.ts reads what the dream is made from, honouring the mind's
 * preference about who appears; prompt.ts is the first-person prompt; dreamer.ts is the model call).
 */
import { dreamFade } from "./fade.js";
import { dreamGenerate } from "./generate.js";
export { dreamFade, dreamGenerate };
export { readDreamState, dreamNotDueReason, type DreamState } from "./generate.js";
export { DREAM_EVENT_SHAPES } from "./events.js";
export { checkDreamEnv, dreamerConfig, dreamFadesAt, dreamTtlDays, dreamWindowHours, DEFAULT_DREAM_TTL_DAYS, DEFAULT_DREAM_WINDOW_HOURS, DREAM_PROMPT_VERSION } from "./config.js";
export { NONE_DREAMER, httpDreamer, dreamerFrom, parseLastJson, answerFrom, type Dreamer, type DreamAnswer } from "./dreamer.js";
export { readPreference, readResidue, composeResidue, residueIsEmpty, type Residue, type RelationPreference } from "./residue.js";
export { dreamSystemPrompt } from "./prompt.js";

/** The deterministic pass (every tick), in the daemon's PASSES list. */
export const DREAM_DETERMINISTIC_PASSES = [dreamFade] as const;
/** The model-backed pass, in the daemon's MODEL_PASSES list. */
export const DREAM_MODEL_PASSES = [dreamGenerate] as const;
/** Every pass of dreaming, in run order. */
export const DREAM_PASSES = [dreamFade, dreamGenerate] as const;
