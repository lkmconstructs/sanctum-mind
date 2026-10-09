// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { ok } from "../result.js";
import { defineVerb } from "./types.js";
import type { VerbContext } from "./types.js";
import { mindIdSchema, text } from "./common.js";
import { bookkeepingExcluded } from "../extractor/events.js";
import { listNoticings, pendingRepairs, repairsByUpstream } from "./mind_notice.js";

const lim = (def: number, max = 100) => z.number().int().min(1).max(max).default(def);

const schema = z.strictObject({
  mind_id: mindIdSchema,
  depth: z.enum(["orientation", "quick", "full"]).default("quick"),
  context: text(64).optional(),
  limits: z
    .strictObject({ loops: lim(10), threads: lim(10), tasks: lim(10), recent: lim(20) })
    .optional(),
});

type Section = unknown;
type SectionSpec = { key: string; run: (ctx: VerbContext) => Promise<Section> };

/** Find a sibling verb, validate a constructed input, call its handler; never throws on verb-level failure. */
async function compose(ctx: VerbContext, name: string, input: Record<string, unknown>): Promise<Section> {
  const v = ctx.registry.find((x) => x.name === name);
  if (!v) return { skipped: "not registered" };
  const parsed = v.schema.safeParse({ mind_id: ctx.mind_id, ...input });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: { code: "invalid_input", message: `${name}: ${issue?.message ?? "invalid input"}` } };
  }
  // Orient is a read; a composed section must be a read too, whatever its input.
  if (v.scopeFor(parsed.data) !== "read") return { error: { code: "forbidden", message: "section is not read-scoped" } };
  const r = await v.handler(ctx, parsed.data);
  return r.ok ? (r.receipt.projection ?? null) : { error: r.error };
}

export const mind_orient = defineVerb<typeof schema, unknown>({
  name: "mind_orient",
  description:
    "Wake: compose identity, vows, state, handoff, health and (deeper) loops, threads, tasks, relations, drives, inbox, weather, anchors, attention (the top seven things it is carrying, with pins), noticings (when the operator has the extractor at stage propose), repairs (pending), desires, holdings, recent events and daemon orphan sightings into one read. Appends no event.",
  schema,
  scopeFor: () => "read",
  handler: async (ctx, input) => {
    const depth = input.depth;
    const limits = input.limits ?? { loops: 10, threads: 10, tasks: 10, recent: 20 };
    const context = input.context;
    const lane = context ?? "";
    const quick = depth === "quick" || depth === "full";
    const full = depth === "full";

    const sections: SectionSpec[] = [
      { key: "identity", run: (c) => compose(c, "mind_identity", { operation: "read" }) },
      { key: "vows", run: (c) => compose(c, "mind_vow", { operation: "list" }) },
      { key: "state", run: (c) => compose(c, "mind_state", { operation: "read" }) },
      { key: "handoff", run: (c) => compose(c, "mind_handoff", { operation: "read", context: lane }) },
      { key: "health", run: (c) => compose(c, "mind_health", {}) },
    ];
    if (quick) {
      sections.push(
        { key: "loops", run: (c) => compose(c, "mind_loop", { operation: "list", limit: limits.loops }) },
        { key: "threads", run: (c) => compose(c, "mind_thread", { operation: "list", status: "active", limit: limits.threads }) },
        { key: "tasks", run: (c) => compose(c, "mind_task", { operation: "list", limit: limits.tasks }) },
        { key: "relations", run: (c) => compose(c, "mind_relate", { operation: "read" }) },
        { key: "drives", run: (c) => compose(c, "mind_drive", { operation: "read", context: lane }) },
        { key: "inbox", run: (c) => compose(c, "mind_letter", { operation: "inbox", limit: 5 }) },
        {
          key: "weather",
          run: (c) => compose(c, "mind_weather", { lookback_hours: 24, ...(context === undefined ? {} : { context }) }),
        },
        { key: "anchors", run: (c) => compose(c, "mind_anchor", { operation: "list" }) },
        // what the mind is carrying: the seven heaviest things (mind_attend list), before the proposals
        {
          key: "attention",
          run: async (c) => {
            const r = (await compose(c, "mind_attend", { operation: "list", limit: 7 })) as { items?: unknown; stale_pins?: unknown } | null;
            // items only (the pins themselves are in mind_attend list); stale_pins says how many pins mark nothing and could be released
            return r !== null && Array.isArray(r.items) ? { items: r.items, stale_pins: typeof r.stale_pins === "number" ? r.stale_pins : 0 } : r;
          },
        },
        {
          // the top 5 pending proposals the mind may see (the extractor's at stage propose, repairs whatever the stage). Repairs come first but at
          // most 3 of them when any other proposal is pending, so a rewrite with many dependants cannot crowd out everything else.
          key: "noticings",
          run: async (c) => {
            if (!c.registry.some((v) => v.name === "mind_notice")) return [];
            const others = (await listNoticings(c, { limit: 5, noRepair: true })).noticings;
            const reps = (await listNoticings(c, { kind: "repair", limit: others.length > 0 ? 3 : 5 })).noticings;
            return [...reps, ...others.slice(0, 5 - reps.length)];
          },
        },
        // repairs waiting for the mind (a node it relied on was rewritten or retired); shown whatever the extractor's state, with the top 5 upstreams by count
        { key: "repairs", run: async (c) => ({ pending: await pendingRepairs(c), by_upstream: await repairsByUpstream(c, 5) }) },
      );
    }
    if (full) {
      sections.push(
        { key: "desires", run: (c) => compose(c, "mind_desire", { operation: "list" }) },
        {
          key: "holdings",
          run: async (c) => {
            const r = await c.tx.query(
              `select subject_id, subject_kind, state, note, last_event_id, updated_at
               from holdings where mind_id = $1 and state in ('active', 'processing')
               order by updated_at desc limit 50`,
              [c.mind_id],
            );
            return { holdings: r.rows };
          },
        },
        {
          key: "recent",
          run: async (c) => {
            const r = await c.tx.query(
              `select id, seq, kind, context, created_at, payload
               from events where mind_id = $1 and ${bookkeepingExcluded()} order by seq desc limit $2`,
              [c.mind_id, limits.recent],
            );
            return { events: r.rows };
          },
        },
        {
          // Informational: the daemon's last orphan sightings (observation nodes with no edges), newest first.
          key: "orphans",
          run: async (c) => {
            const r = await c.tx.query(
              `select id, seq, subject_id, created_at, payload
               from events where mind_id = $1 and kind = 'daemon.graph.orphan' order by seq desc limit 20`,
              [c.mind_id],
            );
            return { events: r.rows };
          },
        },
      );
    }

    const out: Record<string, Section> = {};
    let n = 0;
    for (const s of sections) {
      const sp = `orient_${n++}`;
      await ctx.tx.query(`savepoint ${sp}`);
      try {
        out[s.key] = await s.run(ctx);
        await ctx.tx.query(`release savepoint ${sp}`);
      } catch (e) {
        console.error(`mind_orient section ${s.key} failed:`, e);
        await ctx.tx.query(`rollback to savepoint ${sp}`).catch(() => undefined);
        out[s.key] = { error: { code: "storage", message: "section failed" } };
      }
    }

    return ok({
      projection: { mind_id: ctx.mind_id, depth, as_of: ctx.now().toISOString(), context: context ?? null, sections: out },
    });
  },
});
