// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { z } from "zod";
import type { Pool, PoolClient } from "pg";
import type { Result } from "../result.js";
import type { SinkConfig } from "../sinks/types.js";

/**
 * Who is calling, resolved from the bearer key by src/auth.ts before any verb runs.
 * `bearer` is the mind that holds the key. `mind_id` on the input is the scope being
 * acted on; they differ only when a live grant allows it.
 */
export interface Caller {
  bearer: string;
  /** grants the bearer holds: grantor mind -> scopes */
  grants: Record<string, GrantScope[]>;
}

export type GrantScope = "read" | "write" | "relate" | "letter" | "steward";

/**
 * Per-request context handed to every verb. `tx` is a client inside a transaction with
 * `app.mind_id` already set, so row level security scopes every statement to the target mind.
 * Verbs never touch the pool directly.
 */
export interface VerbContext {
  caller: Caller;
  /** the mind whose rows this call may read and write */
  mind_id: string;
  tx: PoolClient;
  now: () => Date;
  session_id?: string;
  /** the live registry, so composing verbs (orient) can call sibling read paths and skip any not registered */
  registry: Registry;
  /** the configured embedder; the `none` embedder when unset */
  embedder: Embedder;
  /** the configured outbox sinks; empty when none (no outbox rows are written) */
  sinks: SinkConfig[];
  /** the cooling period for declared identity changes, in milliseconds (0 = none) */
  coolingMs: number;
  /**
   * The embedding of `verb.embedText(input)`, computed by the runner BEFORE the transaction opened
   * (so a slow embedder never holds a connection). Absent when the verb has no embedText, it returned
   * null, or the text was blank; `vector`/`model` are null when embedding was unavailable or failed.
   */
  embedded?: { vector: string | null; model: string | null };
}

export interface Verb<S extends z.ZodTypeAny = z.ZodTypeAny, P = unknown> {
  name: `mind_${string}`;
  description: string;
  schema: S;
  /**
   * Which grant scope a caller other than the mind itself needs for this input. The runner calls it after parsing,
   * checks mayAct with it, and runs the transaction read only when it returns "read".
   */
  scopeFor: (input: z.infer<S>) => GrantScope;
  /**
   * True when this input changes what only the mind itself may change (its identity and vows). The runner then
   * refuses any other bearer with `forbidden` ("identity belongs to the mind") before looking at grants.
   */
  mindOnly?: (input: z.infer<S>) => boolean;
  /**
   * True when a `steward` grant also satisfies a `read` scope for this verb's read operations (mind_identity, mind_vow).
   * No other verb opts in, so a steward-only grantee cannot read the rest of the mind.
   */
  stewardMayRead?: true;
  /**
   * The text to embed for this input, or null when there is nothing to embed (reads, operations that
   * store no embedded node, text-only search). Called by the runner after the grant check and before
   * the transaction; handlers read the result from ctx.embedded and never call the embedder.
   */
  embedText?: (input: z.infer<S>) => string | null;
  handler: (ctx: VerbContext, input: z.infer<S>) => Promise<Result<P>>;
}

/** Helper so each verb file keeps full inference without repeating generics. */
export function defineVerb<S extends z.ZodTypeAny, P>(v: Verb<S, P>): Verb<S, P> {
  return v;
}

/** The whole registry, exported from src/verbs/registry.ts. */
export type Registry = ReadonlyArray<Verb>;

/**
 * Text embedder behind one interface. The default is a local model producing 384-dim vectors;
 * an HTTP embedder and a `none` embedder (vectors stay null, retrieval falls back to full text) also exist.
 * Tests inject a deterministic fake. Verbs never import a concrete embedder.
 */
export interface Embedder {
  /** stable identifier recorded with each vector, e.g. "local:bge-small-en-v1.5" or "none" */
  readonly name: string;
  readonly dim: 384;
  /** returns one vector per input, in order; "none" returns an array of nulls */
  embed(texts: string[]): Promise<Array<Float32Array | null>>;
}

export interface RunDeps {
  pool: Pool;
  registry: Registry;
  now?: () => Date;
  embedder?: Embedder;
  /** overall cap on the pre-transaction embedding call; default 10 000 ms */
  embedTimeoutMs?: number;
  /** outbox sinks; default none */
  sinks?: SinkConfig[];
  /** cooling period for declared identity changes, ms; default from IDENTITY_COOLING_HOURS (24 h) */
  coolingMs?: number;
}
