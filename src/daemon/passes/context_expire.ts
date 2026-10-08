import { appendEvent } from "../../verbs/common.js";
import type { DaemonPass } from "./types.js";

/** Marks expired working-context entries cleared, with one event listing the keys. */
export const contextExpire: DaemonPass = {
  name: "context.expire",
  async run(ctx) {
    const now = ctx.now();
    const due = await ctx.tx.query<{ key: string }>(
      `select key from kv_contexts where mind_id = $1 and cleared_at is null and expires_at is not null and expires_at <= $2
       order by key`,
      [ctx.mind_id, now],
    );
    if (due.rows.length === 0) return { changed: 0 };
    // Same lock keys and order as mind_context, so a concurrent set/clear of one key cannot deadlock with this.
    for (const { key } of due.rows) {
      await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [`kv_contexts:${ctx.mind_id}:${key}`]);
    }
    const still = await ctx.tx.query<{ key: string }>(
      `select key from kv_contexts where mind_id = $1 and key = any($2::text[]) and cleared_at is null
         and expires_at is not null and expires_at <= $3 order by key`,
      [ctx.mind_id, due.rows.map((r) => r.key), now],
    );
    const keys = still.rows.map((r) => r.key);
    if (keys.length === 0) return { changed: 0 };
    const ev = await appendEvent(ctx, { kind: "daemon.context.expire", payload: { keys } });
    await ctx.tx.query(
      `update kv_contexts set cleared_at = $3, last_event_id = $4, updated_at = $3
       where mind_id = $1 and key = any($2::text[])`,
      [ctx.mind_id, keys, ev.created_at, ev.id],
    );
    return { changed: keys.length };
  },
};
