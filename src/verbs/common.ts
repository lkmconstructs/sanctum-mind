// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import type { Embedder, VerbContext } from "./types.js";
import { sinkMatches } from "../sinks/types.js";

const RESERVED_MIND_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const mindIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .refine((s) => !RESERVED_MIND_IDS.has(s), "reserved mind id");

/** String.prototype.isWellFormed is Node 22 (ES2024); tsconfig targets ES2022 lib, so call it through a type. */
const isWellFormed = (s: string): boolean => (s as string & { isWellFormed(): boolean }).isWellFormed();

/** A uuid, lowercased at the schema boundary so every verb sees one spelling (z.uuid() accepts upper case, and ids are used in lock keys). */
export const uuidSchema = z.uuid().transform((s) => s.toLowerCase());

/** The advisory-lock keys for a node and for a proposal. The ONE place they are built, always lowercased: node:ABC and node:abc must be the same lock. */
export const nodeLockKey = (id: string): string => `node:${id.toLowerCase()}`;
export const proposalLockKey = (id: string): string => `proposal:${id.toLowerCase()}`;

/** Bounded free text that Postgres can store: no NUL bytes. */
export const text = (max = 4000) =>
  z
    .string()
    .max(max)
    .refine((s) => !s.includes("\u0000"), "must not contain NUL")
    .refine(isWellFormed, "must be well-formed Unicode");

/** Text that must carry something: trimmed, then at least one character. */
export const nonBlankText = (max = 4000) => text(max).trim().min(1, "must not be blank");

/**
 * Collapse whitespace and truncate by code points, never UTF-16 units, so a surrogate pair is
 * not split. Returns "" when nothing is left; callers turn that into invalid_input.
 */
export function deriveLabel(s: string, maxCodePoints = 120): string {
  return Array.from(s.replace(/\s+/g, " ").trim()).slice(0, maxCodePoints).join("");
}

/** The vector(384) column width. */
export const EMBED_DIM = 384;
/** Overall cap on one pre-transaction embedding call. */
export const DEFAULT_EMBED_TIMEOUT_MS = 10_000;

/** pgvector text literal for a vector; null when it is missing, empty or carries a non-finite component. */
export function vectorLiteral(v: ArrayLike<number> | null | undefined): string | null {
  if (!v || v.length === 0) return null;
  const parts: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (!Number.isFinite(x)) return null;
    parts.push(String(x));
  }
  return `[${parts.join(",")}]`;
}

export interface Embedded {
  vector: string | null;
  model: string | null;
}

export const NOT_EMBEDDED: Embedded = { vector: null, model: null };
let embedWarned = false;

/**
 * Embeds one text OUTSIDE any transaction (the runner calls it before withMind). Never throws and
 * never fails a write: nulls when there is no embedder, the text is blank, the embedder fails,
 * does not answer within `timeoutMs`, or returns a vector of the wrong width or with a NaN/Infinity.
 */
export async function embedOne(
  embedder: Embedder,
  text: string,
  timeoutMs: number = DEFAULT_EMBED_TIMEOUT_MS,
): Promise<Embedded> {
  let timer: NodeJS.Timeout | undefined;
  try {
    if (embedder.name === "none" || text.trim() === "") return NOT_EMBEDDED;
    const cap = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const out = await Promise.race([embedder.embed([text]), cap]);
    if (out === null) {
      warnEmbed(`embedder did not answer within ${timeoutMs} ms`);
      return NOT_EMBEDDED;
    }
    const v = out[0];
    if (!v || v.length !== EMBED_DIM || v.length !== embedder.dim) return NOT_EMBEDDED;
    const vector = vectorLiteral(v);
    return vector === null ? NOT_EMBEDDED : { vector, model: embedder.name };
  } catch (err) {
    warnEmbed(err instanceof Error ? err.message : String(err));
    return NOT_EMBEDDED;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function warnEmbed(msg: string): void {
  if (embedWarned) return;
  embedWarned = true;
  console.error("sanctum-mind: embedding failed, storing null:", msg);
}

export interface AppendEventInput {
  kind: string;
  payload: unknown;
  subject_id?: string;
  texture?: unknown;
  context?: string;
  recorded_at?: Date;
  /** the embedding computed before the transaction (ctx.embedded); null columns when absent */
  embedded?: Embedded | undefined;
}

export interface AppendedEvent {
  id: string;
  seq: string;
  created_at: Date;
  recorded_at: Date;
  event_time_start: Date | null;
  event_time_end: Date | null;
  event_time_granularity: string | null;
}

/**
 * Queues the event for every configured sink whose filter matches, in the event's own transaction.
 * No sinks configured (or none matching) means no rows.
 */
export async function enqueueOutbox(ctx: VerbContext, eventId: string, kind: string): Promise<void> {
  for (const sink of ctx.sinks) {
    if (!sinkMatches(sink, kind, ctx.mind_id)) continue;
    await ctx.tx.query(
      `insert into event_outbox (event_id, mind_id, sink) values ($1, $2, $3) on conflict (event_id, sink) do nothing`,
      [eventId, ctx.mind_id, sink.name],
    );
  }
}

/**
 * The ONLY way verbs write events. Scope (mind_id) comes from ctx, authorship
 * (written_by) from the caller's bearer. created_at is the statement clock, taken after
 * any advisory lock the caller holds, so it agrees with seq for serialised writers.
 * seq is the ledger's total order (bigint, returned as a string by pg).
 */
export async function appendEvent(ctx: VerbContext, e: AppendEventInput): Promise<AppendedEvent> {
  const emb = e.embedded ?? NOT_EMBEDDED;
  const res = await ctx.tx.query<AppendedEvent>(
    `insert into events (mind_id, kind, subject_id, payload, texture, context, written_by, recorded_at, session_id, created_at,
                         embedding, embedding_model)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, clock_timestamp(), $10::vector, $11)
     returning id, seq, created_at, recorded_at, event_time_start, event_time_end, event_time_granularity`,
    [
      ctx.mind_id,
      e.kind,
      e.subject_id ?? null,
      JSON.stringify(e.payload),
      e.texture === undefined ? null : JSON.stringify(e.texture),
      e.context ?? null,
      ctx.caller.bearer,
      e.recorded_at ?? ctx.now(),
      ctx.session_id ?? null,
      emb.vector,
      emb.model,
    ],
  );
  const row = res.rows[0]!;
  await enqueueOutbox(ctx, row.id, e.kind);
  return row;
}
