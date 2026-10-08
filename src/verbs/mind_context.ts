// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { z } from "zod";
import { err, ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";

const MAX_VALUE_BYTES = 16384;
const MAX_DEPTH = 256;

const wellFormed = (s: string): boolean => (s as string & { isWellFormed(): boolean }).isWellFormed();
const badString = (s: string): boolean => s.includes("\u0000") || !wellFormed(s);

/** First problem Postgres jsonb (or a later reader) could not store faithfully, or null. Iterative, so depth cannot overflow the stack. */
function valueProblem(root: unknown): string | null {
  const stack: { v: unknown; d: number }[] = [{ v: root, d: 1 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (typeof v === "string") {
      if (badString(v)) return "value contains a NUL or malformed Unicode string";
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) return "value contains a non-finite number";
    } else if (v !== null && typeof v === "object") {
      if (d > MAX_DEPTH) return `value nests deeper than ${MAX_DEPTH}`;
      if (Array.isArray(v)) {
        for (const x of v) stack.push({ v: x, d: d + 1 });
      } else {
        for (const [k, x] of Object.entries(v)) {
          if (badString(k)) return "value contains a key with a NUL or malformed Unicode";
          stack.push({ v: x, d: d + 1 });
        }
      }
    }
  }
  return null;
}

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["set", "get", "list", "clear"]),
    key: text(200).optional(),
    value: z.unknown().optional(),
    ttl_minutes: z.number().int().min(1).max(60 * 24 * 30).optional(),
  })
  .superRefine((v, c) => {
    if (v.operation !== "list" && (v.key === undefined || v.key === "")) {
      c.addIssue({ code: "custom", message: `key is required for ${v.operation}`, path: ["key"] });
    }
    if (v.operation === "set") {
      if (v.value === undefined) {
        c.addIssue({ code: "custom", message: "value is required for set", path: ["value"] });
      } else if (valueProblem(v.value) !== null) {
        c.addIssue({ code: "custom", message: valueProblem(v.value)!, path: ["value"] });
      } else {
        let json: string | undefined;
        try {
          json = JSON.stringify(v.value);
        } catch {
          json = undefined;
        }
        if (json === undefined) {
          c.addIssue({ code: "custom", message: "value must be JSON serialisable", path: ["value"] });
        } else if (Buffer.byteLength(json, "utf8") > MAX_VALUE_BYTES) {
          c.addIssue({ code: "custom", message: `value exceeds ${MAX_VALUE_BYTES} bytes serialised`, path: ["value"] });
        }
      }
    }
  });

interface KvRow {
  mind_id: string;
  key: string;
  value: unknown;
  expires_at: Date | null;
  last_event_id: string;
  updated_at: Date;
  cleared_at: Date | null;
}

const isExpired = (r: KvRow, now: Date) =>
  r.cleared_at !== null || (r.expires_at !== null && r.expires_at.getTime() <= now.getTime());

export const mind_context = defineVerb({
  name: "mind_context",
  description:
    "Keyed working context: set a JSON value (up to 16384 bytes serialised) under a key with an optional ttl in minutes, " +
    "get it back (flagged expired when past its ttl or cleared), list active entries, or clear one.",
  schema,
  scopeFor: (input) => (input.operation === "get" || input.operation === "list" ? "read" : "write"),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    const now = ctx.now();

    if (input.operation === "list") {
      const r = await ctx.tx.query<KvRow>(
        `select * from kv_contexts
         where mind_id = $1 and cleared_at is null and (expires_at is null or expires_at > $2)
         order by updated_at desc`,
        [ctx.mind_id, now],
      );
      return ok({ projection: { entries: r.rows } });
    }

    const key = input.key!;
    if (input.operation === "get") {
      const r = await ctx.tx.query<KvRow>(`select * from kv_contexts where mind_id = $1 and key = $2`, [ctx.mind_id, key]);
      const row = r.rows[0] ?? null;
      return ok({ projection: { entry: row, expired: row === null ? false : isExpired(row, now) } });
    }

    await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`kv_contexts:${ctx.mind_id}:${key}`]);

    if (input.operation === "set") {
      const ev = await appendEvent(ctx, {
        kind: "context.set",
        payload: { key, value: input.value, ttl_minutes: input.ttl_minutes ?? null },
      });
      const r = await ctx.tx.query<KvRow>(
        `insert into kv_contexts (mind_id, key, value, expires_at, last_event_id, updated_at, cleared_at)
         values ($1, $2, $3::jsonb, case when $4::integer is null then null else $5::timestamptz + make_interval(mins => $4::integer) end, $6, $5, null)
         on conflict (mind_id, key) do update set
           value = excluded.value, expires_at = excluded.expires_at, last_event_id = excluded.last_event_id,
           updated_at = excluded.updated_at, cleared_at = null
         returning *`,
        [ctx.mind_id, key, JSON.stringify(input.value), input.ttl_minutes ?? null, ev.created_at, ev.id],
      );
      return ok({ event_id: ev.id, projection: { event_id: ev.id, entry: r.rows[0] } });
    }

    // clear
    const cur = await ctx.tx.query<KvRow>(`select * from kv_contexts where mind_id = $1 and key = $2`, [ctx.mind_id, key]);
    const row = cur.rows[0];
    if (!row || isExpired(row, now)) return err("not_found", "no active entry for that key", "key");
    const ev = await appendEvent(ctx, { kind: "context.clear", payload: { key } });
    const r = await ctx.tx.query<KvRow>(
      `update kv_contexts set cleared_at = $3, last_event_id = $4, updated_at = $3 where mind_id = $1 and key = $2 returning *`,
      [ctx.mind_id, key, ev.created_at, ev.id],
    );
    return ok({ event_id: ev.id, projection: { event_id: ev.id, entry: r.rows[0] } });
  },
});
