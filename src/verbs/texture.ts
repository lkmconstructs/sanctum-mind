import { z } from "zod";
import { nonBlankText, text } from "./common.js";

/** Reserved literals shared by the memory verbs. */
export const RELATED_TO_EDGE = "related_to";
export const OBSERVATION_NODE = "observation";

export const texture = z.strictObject({
  salience: z.enum(["foundational", "active", "background", "archive"]).optional(),
  vividness: z.enum(["crystalline", "vivid", "soft", "fragmentary", "faded"]).optional(),
  grip: z.enum(["iron", "strong", "present", "loose", "dormant"]).optional(),
  charge: z.array(nonBlankText(64)).max(16).optional(), // emotional resonance tags
  somatic: text(200).optional(), // body location
});

const MIN_MS = Date.parse("0001-01-01T00:00:00Z");
const MAX_MS = Date.parse("9999-12-31T23:59:59Z");
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * Normalise an ISO 8601 date or datetime (0 to 6 fractional digits, any offset) to a UTC string
 * with exactly six fractional digits, `YYYY-MM-DDTHH:mm:ss.ffffffZ`. Such strings compare
 * correctly as plain strings. Date-only means 00:00:00Z. Returns null when the text is not a
 * real instant or its UTC year falls outside 0001..9999.
 */
export function normaliseInstant(s: string): string | null {
  let base: string;
  let frac = "";
  let offsetMin = 0;
  if (DATE_ONLY.test(s)) {
    base = `${s}T00:00:00`;
  } else {
    const m = DATETIME.exec(s);
    if (!m) return null;
    base = m[1]!;
    frac = m[2] ?? "";
    const off = m[3]!;
    if (off !== "Z") {
      const digits = off.slice(1).replace(":", "");
      const h = Number(digits.slice(0, 2));
      const mi = Number(digits.slice(2) || "0");
      if (h > 23 || mi > 59) return null;
      offsetMin = (off[0] === "-" ? -1 : 1) * (h * 60 + mi);
    }
  }
  const utc = Date.parse(`${base}Z`);
  if (Number.isNaN(utc)) return null;
  // Date.parse accepts e.g. Feb 30 in some engines by rolling over; insist on the same calendar day.
  if (new Date(utc).toISOString().slice(0, 10) !== base.slice(0, 10)) return null;
  const ms = utc - offsetMin * 60_000;
  if (ms < MIN_MS || ms > MAX_MS) return null;
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac.padEnd(6, "0")}Z`;
}

/** Schema for an instant with offset (recorded_at). Normalise with `normaliseInstant` in the handler. */
export const instant = z
  .iso.datetime({ offset: true })
  .refine((s) => normaliseInstant(s) !== null, "must be an ISO 8601 datetime with at most 6 fractional digits and a UTC year in 0001..9999");

const eventInstant = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .refine((s) => normaliseInstant(s) !== null, "must be an ISO 8601 date or datetime with at most 6 fractional digits and a UTC year in 0001..9999");

export const eventTime = z
  .strictObject({
    start: eventInstant,
    end: eventInstant.optional(),
    granularity: z.enum(["day", "week", "month", "year", "fuzzy"]).optional(),
    text: text(200).optional(),
  })
  .superRefine((v, c) => {
    if (v.end === undefined) return;
    const s = normaliseInstant(v.start);
    const e = normaliseInstant(v.end);
    if (s !== null && e !== null && e < s) {
      c.addIssue({ code: "custom", message: "event_time.end must not be before start", path: ["end"] });
    }
  });

export type EventTime = z.infer<typeof eventTime>;

export interface ResolvedEventTime {
  start: string;
  end: string;
  granularity: string | null;
}

/** Resolve validated input to storage values: UTC microsecond strings, end defaulting to start, date-only start implying day. */
export function resolveEventTime(t: EventTime): ResolvedEventTime {
  const start = normaliseInstant(t.start)!;
  const end = t.end === undefined ? start : normaliseInstant(t.end)!;
  const granularity = t.granularity ?? (DATE_ONLY.test(t.start) ? "day" : null);
  return { start, end, granularity };
}
