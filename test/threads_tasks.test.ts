import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { mind_thread } from "../src/verbs/mind_thread.js";
import { mind_task } from "../src/verbs/mind_task.js";
import type { Caller, Registry } from "../src/verbs/types.js";

const registry: Registry = [mind_thread, mind_task];
const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: { alpha: ["read"] } };

let pool: Pool;
const run = (caller: Caller, name: string, input: unknown): Promise<any> =>
  runVerb({ pool, registry }, caller, name, input);
const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);

beforeEach(async () => {
  if (pool) await closePool(pool);
  const admin = await resetDatabase();
  await closePool(admin);
  pool = appPool();
});
afterAll(async () => {
  if (pool) await closePool(pool);
});

const thread = (input: Record<string, unknown>, caller = alpha, mind = "alpha") =>
  run(caller, "mind_thread", { mind_id: mind, ...input });
const task = (input: Record<string, unknown>, caller = alpha, mind = "alpha") =>
  run(caller, "mind_task", { mind_id: mind, ...input });

const addThread = async (label: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await thread({ operation: "add", label, ...extra });
  expect(r.ok).toBe(true);
  return r.receipt.projection.thread.id;
};
const addTask = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const r = await task({ operation: "create", title, ...extra });
  expect(r.ok).toBe(true);
  return r.receipt.projection.task.id;
};

describe("mind_thread", () => {
  it("adds a thread with defaults and an event", async () => {
    const r = await thread({ operation: "add", label: "the move" });
    expect(r.ok).toBe(true);
    const t = r.receipt.projection.thread;
    expect(t).toMatchObject({ mind_id: "alpha", label: "the move", priority: "normal", tags: [], status: "active", notes: [] });
    expect(r.receipt.projection.event_id).toBe(r.receipt.event_id);
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("thread.add");
    expect(ev.payload).toEqual({ label: "the move", priority: "normal", tags: [] });
    expect(t.created_event_id).toBe(ev.id);
    expect(t.created_at.getTime()).toBe(ev.created_at.getTime());
  });

  it("rejects a blank label on add and update", async () => {
    expect(await thread({ operation: "add", label: "  \t " })).toMatchObject({ ok: false, error: { code: "invalid_input", field: "label" } });
    expect(await thread({ operation: "add", label: "" })).toMatchObject({ error: { field: "label" } });
    const id = await addThread("fine");
    expect(await thread({ operation: "update", thread_id: id, label: " " })).toMatchObject({ error: { field: "label" } });
    expect((await thread({ operation: "add", label: "  trimmed " })).receipt.projection.thread.label).toBe("trimmed");
  });

  it("validates per-operation requirements", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    for (const input of [
      { operation: "add" },
      { operation: "update", note: "x" },
      { operation: "resolve" },
      { operation: "archive" },
      { operation: "update", thread_id: id },
    ]) {
      const r = await thread(input);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe("invalid_input");
    }
    expect((await thread({ operation: "add" })).error.field).toBe("label");
    expect((await thread({ operation: "resolve" })).error.field).toBe("thread_id");
  });

  it("lists by priority then age, with status filters", async () => {
    const a = await addThread("low one", { priority: "low" });
    const b = await addThread("normal old");
    const c = await addThread("high one", { priority: "high" });
    const d = await addThread("normal new");
    const labels = async (extra: Record<string, unknown> = {}) =>
      (await thread({ operation: "list", ...extra })).receipt.projection.threads.map((t: any) => t.label);
    expect(await labels()).toEqual(["high one", "normal old", "normal new", "low one"]);
    expect(await labels({ limit: 2 })).toEqual(["high one", "normal old"]);
    await thread({ operation: "resolve", thread_id: b });
    await thread({ operation: "archive", thread_id: d });
    expect(await labels()).toEqual(["high one", "low one"]);
    expect(await labels({ status: "resolved" })).toEqual(["normal old"]);
    expect(await labels({ status: "archived" })).toEqual(["normal new"]);
    expect((await labels({ status: "all" })).length).toBe(4);
    void a; void c;
  });

  it("update patches fields and appends notes", async () => {
    const id = await addThread("first", { tags: ["a"] });
    const r1 = await thread({ operation: "update", thread_id: id, priority: "high", note: "one" });
    expect(r1.ok).toBe(true);
    const r2 = await thread({ operation: "update", thread_id: id, label: "renamed", tags: ["b", "c"], note: "two" });
    const t = r2.receipt.projection.thread;
    expect(t).toMatchObject({ label: "renamed", priority: "high", tags: ["b", "c"] });
    expect(t.notes.map((n: any) => n.note)).toEqual(["one", "two"]);
    expect(t.notes[0].event_id).toBe(r1.receipt.event_id);
    expect(t.notes[1].event_id).toBe(r2.receipt.event_id);
    expect(typeof t.notes[0].at).toBe("string");
    const [ev] = await q("alpha", "select * from events where id = $1", [r2.receipt.event_id]);
    expect(ev.kind).toBe("thread.update");
    expect(ev.subject_id).toBe(id);
    expect(ev.payload).toEqual({ label: "renamed", tags: ["b", "c"], note: "two" });
    expect(t.updated_at.getTime()).toBe(ev.created_at.getTime());
  });

  it("resolve and archive transitions with conflicts", async () => {
    const id = await addThread("x");
    const r = await thread({ operation: "resolve", thread_id: id, note: "done with it" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.thread).toMatchObject({ status: "resolved", resolution: "done with it" });
    expect(r.receipt.projection.thread.resolved_at).toBeInstanceOf(Date);
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("thread.resolve");
    expect(ev.payload).toEqual({ note: "done with it" });
    expect((await thread({ operation: "resolve", thread_id: id })).error.code).toBe("conflict");
    expect((await thread({ operation: "update", thread_id: id, note: "n" })).error.code).toBe("conflict");
    const a = await thread({ operation: "archive", thread_id: id });
    expect(a.ok).toBe(true);
    expect(a.receipt.projection.thread.status).toBe("archived");
    expect((await thread({ operation: "archive", thread_id: id })).error.code).toBe("conflict");

    const id2 = await addThread("y");
    expect((await thread({ operation: "archive", thread_id: id2 })).ok).toBe(true);
    expect((await thread({ operation: "resolve", thread_id: id2 })).error.code).toBe("conflict");
    const missing = await thread({ operation: "archive", thread_id: "00000000-0000-4000-8000-000000000002" });
    expect(missing.error).toMatchObject({ code: "not_found", field: "thread_id" });
  });

  it("RLS hides threads from other minds; read grantee can list only", async () => {
    const id = await addThread("secret");
    expect((await q("beta", "select * from threads")).length).toBe(0);
    expect((await q("alpha", "select * from threads")).length).toBe(1);
    const l = await thread({ operation: "list" }, beta);
    expect(l.ok).toBe(true);
    expect(l.receipt.projection.threads.length).toBe(1);
    expect((await thread({ operation: "add", label: "z" }, beta)).error.code).toBe("forbidden");
    expect((await thread({ operation: "resolve", thread_id: id }, beta)).error.code).toBe("forbidden");
    const own = await thread({ operation: "list" }, beta, "beta");
    expect(own.receipt.projection.threads).toEqual([]);
    const cross = await thread({ operation: "resolve", thread_id: id }, { bearer: "beta", grants: {} }, "beta");
    expect(cross.error.code).toBe("not_found");
  });
});

describe("mind_task", () => {
  it("creates with defaults, depends_on and an event", async () => {
    const dep = await addTask("first");
    const r = await task({ operation: "create", title: "second", description: "d", priority: "high", tags: ["t"], depends_on: [dep] });
    expect(r.ok).toBe(true);
    const t = r.receipt.projection.task;
    expect(t).toMatchObject({ title: "second", description: "d", priority: "high", status: "open", tags: ["t"], depends_on: [dep], completed_at: null });
    expect(t.blocked_by).toEqual([dep]);
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("task.create");
    expect(ev.payload).toEqual({ title: "second", description: "d", priority: "high", tags: ["t"], depends_on: [dep] });
  });

  it("rejects missing title, bad depends_on, and foreign ids", async () => {
    const r = await task({ operation: "create" });
    expect(r.error).toMatchObject({ code: "invalid_input", field: "title" });
    expect((await task({ operation: "update", title: "x" })).error).toMatchObject({ code: "invalid_input", field: "task_id" });
    const id = await addTask("a");
    expect((await task({ operation: "update", task_id: id })).error.code).toBe("invalid_input");
    const ghost = await task({ operation: "create", title: "b", depends_on: ["00000000-0000-4000-8000-000000000003"] });
    expect(ghost.error).toMatchObject({ code: "not_found", field: "depends_on" });
    // a task of another mind is invisible
    const bt: any = await task({ operation: "create", title: "beta's" }, { bearer: "beta", grants: {} }, "beta");
    const foreign = await task({ operation: "create", title: "c", depends_on: [bt.receipt.projection.task.id] });
    expect(foreign.error).toMatchObject({ code: "not_found", field: "depends_on" });
    const mixed = await task({ operation: "create", title: "d", depends_on: [id, "00000000-0000-4000-8000-000000000003"] });
    expect(mixed.error).toMatchObject({ code: "not_found", field: "depends_on" });
    expect((await q("alpha", "select * from tasks")).length).toBe(1);
    expect((await q("alpha", "select * from events where kind = 'task.create'")).length).toBe(1);
  });

  it("rejects self-dependency on update", async () => {
    const id = await addTask("a");
    const r = await task({ operation: "update", task_id: id, depends_on: [id] });
    expect(r.error).toMatchObject({ code: "invalid_input", field: "depends_on" });
  });

  it("cancelled dependencies do not block", async () => {
    const dep = await addTask("dep");
    const t = await addTask("t", { depends_on: [dep] });
    const list = async () => (await task({ operation: "list" })).receipt.projection.tasks.find((x: any) => x.id === t);
    expect((await list()).blocked_by).toEqual([dep]);
    await task({ operation: "update", task_id: dep, status: "cancelled" });
    expect((await list()).blocked_by).toEqual([]);
  });

  it("dedupes depends_on on create and update", async () => {
    const a = await addTask("a");
    const b = await addTask("b");
    const t = await addTask("t", { depends_on: [a, a, b, a] });
    const [row] = await q("alpha", "select depends_on from tasks where id = $1", [t]);
    expect(row.depends_on).toEqual([a, b]);
    const r = await task({ operation: "update", task_id: t, depends_on: [b, b] });
    expect(r.receipt.projection.task.depends_on).toEqual([b]);
    const [ev] = await q("alpha", "select payload from events where id = $1", [r.receipt.event_id]);
    expect(ev.payload.depends_on).toEqual([b]);
  });

  it("rejects dependency cycles (direct and transitive) and still allows diamonds", async () => {
    const a = await addTask("a");
    const b = await addTask("b", { depends_on: [a] });
    const c = await addTask("c", { depends_on: [b] });
    const direct = await task({ operation: "update", task_id: a, depends_on: [b] });
    expect(direct.error).toMatchObject({ code: "invalid_input", field: "depends_on", message: "dependency cycle" });
    const transitive = await task({ operation: "update", task_id: a, depends_on: [c] });
    expect(transitive.error).toMatchObject({ code: "invalid_input", field: "depends_on", message: "dependency cycle" });
    const [row] = await q("alpha", "select depends_on from tasks where id = $1", [a]);
    expect(row.depends_on).toEqual([]);
    expect(await q("alpha", "select 1 from events where kind = 'task.update'")).toHaveLength(0);
    // a diamond is not a cycle
    const d = await addTask("d", { depends_on: [a, b, c] });
    expect(d).toBeTruthy();
    expect((await task({ operation: "update", task_id: c, depends_on: [a] })).ok).toBe(true);
  });

  it("another mind's task id is not found, and blank titles are invalid", async () => {
    const r = await run({ bearer: "beta", grants: {} }, "mind_task", { mind_id: "beta", operation: "create", title: "b-task" });
    const foreign = await task({ operation: "create", title: "x", depends_on: [r.receipt.projection.task.id] });
    expect(foreign.error).toMatchObject({ code: "not_found", field: "depends_on" });
    expect(await task({ operation: "create", title: "   " })).toMatchObject({ ok: false, error: { code: "invalid_input", field: "title" } });
    expect(await task({ operation: "update", task_id: await addTask("ok"), title: "\n\t" })).toMatchObject({ error: { field: "title" } });
    const t: any = await task({ operation: "create", title: "  padded  " });
    expect(t.receipt.projection.task.title).toBe("padded");
  });

  it("lists with the default filter, ordering and blocked_by", async () => {
    const low = await addTask("low", { priority: "low" });
    const normal = await addTask("normal", { depends_on: [low] });
    const urgent = await addTask("urgent", { priority: "urgent", depends_on: [low, normal] });
    const high = await addTask("high", { priority: "high" });
    const finished = await addTask("finished");
    await task({ operation: "update", task_id: finished, status: "done" });
    await task({ operation: "update", task_id: high, status: "in_progress" });
    const list = async (extra: Record<string, unknown> = {}) =>
      (await task({ operation: "list", ...extra })).receipt.projection.tasks;
    let tasks = await list();
    expect(tasks.map((t: any) => t.title)).toEqual(["urgent", "high", "normal", "low"]);
    const by = (title: string) => tasks.find((t: any) => t.title === title).blocked_by;
    expect(by("urgent").sort()).toEqual([low, normal].sort());
    expect(by("normal")).toEqual([low]);
    expect(by("low")).toEqual([]);
    // finishing a dependency unblocks
    await task({ operation: "update", task_id: low, status: "done" });
    tasks = await list();
    expect(by("urgent")).toEqual([normal]);
    expect(by("normal")).toEqual([]);
    expect((await list({ filter_status: ["done"] })).map((t: any) => t.title).sort()).toEqual(["finished", "low"]);
    expect((await list({ filter_status: ["done", "open", "in_progress"] })).length).toBe(5);
    expect((await list({ limit: 1 })).length).toBe(1);
  });

  it("updates fields and replaces depends_on wholesale", async () => {
    const a = await addTask("a");
    const b = await addTask("b");
    const t = await addTask("t", { depends_on: [a] });
    const r = await task({ operation: "update", task_id: t, depends_on: [b], status: "blocked", title: "t2", tags: ["x"], priority: "urgent", description: "dd" });
    expect(r.ok).toBe(true);
    expect(r.receipt.projection.task).toMatchObject({
      title: "t2", status: "blocked", depends_on: [b], blocked_by: [b], tags: ["x"], priority: "urgent", description: "dd", completed_at: null,
    });
    const [ev] = await q("alpha", "select * from events where id = $1", [r.receipt.event_id]);
    expect(ev.kind).toBe("task.update");
    expect(ev.subject_id).toBe(t);
    expect(ev.payload).toMatchObject({ depends_on: [b], status: "blocked" });
    const cleared = await task({ operation: "update", task_id: t, depends_on: [] });
    expect(cleared.receipt.projection.task.depends_on).toEqual([]);
    expect((await task({ operation: "update", task_id: "00000000-0000-4000-8000-000000000004", title: "x" })).error)
      .toMatchObject({ code: "not_found", field: "task_id" });
  });

  it("terminal states refuse updates; completed_at is set once", async () => {
    const id = await addTask("a");
    await task({ operation: "update", task_id: id, status: "in_progress" });
    const d = await task({ operation: "update", task_id: id, status: "done" });
    expect(d.ok).toBe(true);
    const completed = d.receipt.projection.task.completed_at;
    expect(completed).toBeInstanceOf(Date);
    for (const patch of [{ status: "open" }, { status: "done" }, { title: "z" }]) {
      const r = await task({ operation: "update", task_id: id, ...patch });
      expect(r.error.code).toBe("conflict");
    }
    const [row] = await q("alpha", "select * from tasks where id = $1", [id]);
    expect(row.completed_at.getTime()).toBe(completed.getTime());
    const c = await addTask("b");
    expect((await task({ operation: "update", task_id: c, status: "cancelled" })).ok).toBe(true);
    expect((await task({ operation: "update", task_id: c, status: "open" })).error.code).toBe("conflict");
    expect((await q("alpha", "select completed_at from tasks where id = $1", [c]))[0].completed_at).toBeNull();
  });

  it("RLS hides tasks; read grantee can list but not write", async () => {
    const id = await addTask("secret");
    expect((await q("beta", "select * from tasks")).length).toBe(0);
    const l = await task({ operation: "list" }, beta);
    expect(l.ok).toBe(true);
    expect(l.receipt.projection.tasks.length).toBe(1);
    expect((await task({ operation: "create", title: "x" }, beta)).error.code).toBe("forbidden");
    expect((await task({ operation: "update", task_id: id, status: "done" }, beta)).error.code).toBe("forbidden");
    const cross = await task({ operation: "update", task_id: id, status: "done" }, { bearer: "beta", grants: {} }, "beta");
    expect(cross.error.code).toBe("not_found");
  });
});
