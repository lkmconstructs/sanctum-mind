import type { Pool } from "pg";
import type { SinkConfig } from "../../sinks/types.js";
import type { VerbContext } from "../../verbs/types.js";
import type { DaemonConfig } from "../config.js";

/** A pass runs inside one write transaction scoped to one mind, authored by that mind, with the advisory lock held. */
export interface PassContext extends VerbContext {
  config: DaemonConfig;
}

export interface PassResult {
  changed: number;
  notes?: string[];
}

export interface DaemonPass {
  name: string;
  run(ctx: PassContext): Promise<PassResult>;
}

/**
 * What a detached pass gets instead of a transaction: the app-role pool and the mind. A detached pass is
 * the one exception to "a pass is one transaction under the per-mind advisory lock": it does slow work
 * outside the database (sink delivery over the network) and must not hold a pooled connection, row locks
 * or the daemon's advisory lock while it waits. It opens its own short transactions with `withMind` and
 * is responsible for its own mutual exclusion (outbox.deliver leases the rows it works on).
 */
export interface DetachedPassContext {
  pool: Pool;
  mind_id: string;
  now: () => Date;
  sinks: SinkConfig[];
  config: DaemonConfig;
}

export interface DetachedPass {
  name: string;
  detached: true;
  run(ctx: DetachedPassContext): Promise<PassResult>;
}

/** Any pass the runner can run: a transactional one, or a detached one (outbox delivery). */
export type AnyPass = DaemonPass | DetachedPass;

export const isDetached = (p: AnyPass): p is DetachedPass => "detached" in p && p.detached === true;

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** The instant `n` units of `unitMs` before `now`. */
export const ago = (now: Date, n: number, unitMs: number): Date => new Date(now.getTime() - n * unitMs);
