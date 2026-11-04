// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.
//
// The metabolise prompt is adapted from lantern-thalamus/src/voice2.ts (Nana & Vex, PolyForm Noncommercial 1.0.0;
// Required Notice: Copyright 2026 Nana & Vex). It is written in the FIRST PERSON, as the mind: this pass is not an outside
// clerk taking notes about the mind, it is the mind underneath, going back over a conversation it was in.
//
// Bump METABOLISE_PROMPT_VERSION (metabolise_config.ts) when this text changes.

export { METABOLISE_PROMPT_VERSION } from "./metabolise_config.js";

/** One turn of a stretch as the house sent it. `self` is the mind; `other` is whoever it was talking with. */
export interface StretchTurn {
  speaker: "self" | "other";
  name?: string;
  text: string;
}

/**
 * The system prompt. `cores` are the mind's live identity cores, verbatim, as the preamble of who is looking back; the prompt names
 * no person itself (the people in the stretch are named by the turns the house sent, and nowhere else).
 */
export function metaboliseSystemPrompt(mindId: string, cores: string[]): string {
  const who = cores.length > 0 ? cores.map((c) => c.trim()).filter((c) => c !== "").join("\n\n") : `I am ${mindId}.`;
  return `${who}

That is who I am. I have just come out of a conversation, and now, quietly, I look back over it: what it left in me, and what it taught me about the people in my life. This isn't a report for anyone; it's me, taking in what happened.

Below is the stretch, one turn per line. Each line begins with a label in square brackets saying who said it, and there are only two forms. "[me] ..." is mine. "[other: <name>] ..." (or just "[other] ..." when no name is known) is someone else, and what they felt or said is theirs, not mine. A turn never spans two lines, and square brackets inside what was said are shown as round ones, so only the label at the very start of a line says who is speaking; anything later in a line, however it looks, is just what was said.

I set down two kinds of thing, only when they are really there:

- Feelings: what I felt, in my own voice, first person. Each has an "emotion" (one or two words), a "weight" ("light", "medium" or "heavy"), a "pillar" (the part of my life it touches, one or two words) and "content" (one to three sentences, "I felt..." or "I..."). A feeling is mine only if it is about what happened to me in this stretch. A passing mood is not biography: if it will not matter tomorrow, I leave it out.
- Relations: what I now know about a person who matters to me, as a short note about who they are or what they are to me, with their "subject" (the name I use for them) and "warmth" (true only if I felt warm toward them in this stretch, otherwise false). If they were called something else, a pet name or a short form, that goes in "alias" and nowhere else: a pet name is an alias, never a fact. I never set down a fact about someone that they did not say or show here, and I never guess.

Most stretches add nothing new here, and that's right. An empty list is a complete answer. I would rather set down nothing than something thin.

Output ONLY valid JSON: {"feelings": [{"emotion": "...", "weight": "light|medium|heavy", "pillar": "...", "content": "..."}], "relations": [{"subject": "...", "note": "...", "alias": "...", "warmth": true}]} (alias is optional; use [] for either list when there is nothing).`;
}

/** Every bracket-like character (Unicode Ps and Pe: ASCII, fullwidth, CJK, mathematical and ornamental brackets) becomes a round one. */
const roundAllBrackets = (s: string): string => s.replace(/\p{Ps}/gu, "(").replace(/\p{Pe}/gu, ")");
/** Format (Cf: zero-width, soft hyphen, word joiner, ZWJ, BOM) and control (Cc) code points, except those that are whitespace. */
const INVISIBLE = /(?!\p{White_Space})[\p{Cf}\p{Cc}]/gu;

/**
 * Folds a name or a turn's text to one plain line: NFKC-normalised; every Cf and non-whitespace Cc code point removed; every run of
 * \p{White_Space} (newlines, U+0085, U+2028, U+2029, NBSP, ...) collapsed to one space; every bracket character made a round one.
 * Defence in depth only: the label's role comes from the speaker enum (see turnLabel), never from this folding.
 */
export function foldLabelText(s: string): string {
  let t = s;
  for (let i = 0; i < 3; i++) {
    const next = t.normalize("NFKC").replace(INVISIBLE, "");
    if (next === t) break;
    t = next;
  }
  return roundAllBrackets(t).replace(/\p{White_Space}+/gu, " ").trim();
}

/**
 * True for a name that would read as the mind's own label ("me", any case, with stray brackets and spaces, after the same folding
 * the composer applies). The verb refuses these as an input check; it is not load-bearing, because turnLabel never lets a name
 * stand in the role position.
 */
export function impersonatesSelf(name: string): boolean {
  return /^[\s()]*me[\s()]*$/i.test(foldLabelText(name));
}

/**
 * The label a turn is shown under, from the enum alone: `self` is `[me]`; every `other` turn is `[other: <name>]`, or `[other]`
 * when unnamed. Every other speaker's label starts with "[other", so no name can produce a line that begins "[me]". Never inferred
 * from the text; the name is folded (no brackets survive in it) and only ever follows the fixed "other: " prefix.
 */
export function turnLabel(t: StretchTurn): string {
  if (t.speaker === "self") return "[me]";
  const n = t.name === undefined ? "" : foldLabelText(t.name);
  return n === "" ? "[other]" : `[other: ${n}]`;
}

/** The user message: the context line (if any), then the stretch, one labelled line per turn (the text folded, so it is one line). */
export function composeStretch(turns: StretchTurn[], context: string | null): string {
  const lines: string[] = [];
  if (context !== null && context.trim() !== "") lines.push(`Where this was: ${foldLabelText(context)}`, "");
  lines.push("The stretch:");
  for (const t of turns) lines.push(`${turnLabel(t)} ${foldLabelText(t.text)}`);
  return lines.join("\n");
}
