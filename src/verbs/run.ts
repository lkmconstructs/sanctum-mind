// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { NONE_EMBEDDER } from "../embed/none.js";
import type { PoolClient } from "pg";
import { err, type Result } from "../result.js";
import { mayAct } from "../auth.js";
import { withMind } from "../db/pool.js";
import { defaultCoolingMs } from "./cooling.js";
import { MIND_ONLY } from "./self_common.js";
import { DEFAULT_EMBED_TIMEOUT_MS, embedOne } from "./common.js";
import type { Caller, RunDeps, VerbContext } from "./types.js";

/** Thrown inside the transaction to roll it back when a handler resolves ok:false. */
class VerbErrorSignal extends Error {
  constructor(readonly result: Result) {
    super("verb returned an error result");
  }
}

export async function runVerb(
  deps: RunDeps,
  caller: Caller,
  name: string,
  rawInput: unknown,
  session_id?: string,
): Promise<Result> {
  const verb = deps.registry.find((v) => v.name === name);
  if (!verb) return err("not_found", `unknown verb: ${name}`);

  const parsed = verb.schema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    let field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : undefined;
    if (field === undefined && issue && issue.code === "unrecognized_keys") {
      field = String(issue.keys[0]);
    }
    return err("invalid_input", issue?.message ?? "invalid input", field);
  }
  const input = parsed.data as { mind_id: string };

  if (verb.mindOnly?.(input) === true && caller.bearer !== input.mind_id) return err("forbidden", verb.mindOnlyMessage ?? MIND_ONLY);
  const scope = verb.scopeFor(input);
  if (!mayAct(caller, input.mind_id, scope, { stewardMayRead: verb.stewardMayRead === true })) {
    return err("forbidden", `bearer ${caller.bearer} may not act on mind ${input.mind_id}`);
  }
  const mode = scope === "read" ? "read" : "write";

  // Embed BEFORE the transaction: a slow or hung embedder must not hold a pooled connection, row
  // locks or an advisory lock. embedOne never throws and is capped, so this cannot fail the call.
  const embedder = deps.embedder ?? NONE_EMBEDDER;
  let embedded: VerbContext["embedded"];
  try {
    const toEmbed = verb.embedText?.(input);
    if (typeof toEmbed === "string" && toEmbed.trim() !== "") {
      embedded = await embedOne(embedder, toEmbed, deps.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS);
    }
  } catch (e) {
    console.error(`verb ${name} embedText failed:`, e);
  }

  // A deadlock (40P01) or serialization failure (40001) rolls the whole transaction back; running it again from scratch is safe because a
  // handler has no effect outside its transaction: embedding happened above, before it opened, and sink deliveries are only queued in the
  // outbox inside it. One retry; a second failure is a storage error like any other.
  const attempt = () => withMind(deps.pool, input.mind_id, caller.bearer, mode, async (tx: PoolClient) => {
      const result = await verb.handler(
        {
          caller,
          mind_id: input.mind_id,
          tx,
          now: deps.now ?? (() => new Date()),
          registry: deps.registry,
          embedder,
          sinks: deps.sinks ?? [],
          coolingMs: deps.coolingMs ?? defaultCoolingMs(),
          actor: "verb",
          ...(embedded === undefined ? {} : { embedded }),
          ...(session_id === undefined ? {} : { session_id }),
        },
        input,
      );
      if (!result.ok) throw new VerbErrorSignal(result);
      return result;
    }, "verb");
  try {
    try {
      return await attempt();
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
      if (e instanceof VerbErrorSignal || (code !== "40P01" && code !== "40001")) throw e;
      console.error(`verb ${name}: ${String(code)}, running it once more`);
      return await attempt();
    }
  } catch (e) {
    if (e instanceof VerbErrorSignal) return e.result;
    console.error(`verb ${name} failed:`, e);
    return err("storage", "storage operation failed");
  }
}
