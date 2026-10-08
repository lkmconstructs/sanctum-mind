// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { resetDatabase, appPool, closePool } from "./helpers.js";
import { withMind } from "../src/db/pool.js";
import { runVerb } from "../src/verbs/run.js";
import { registry } from "../src/verbs/registry.js";
import { NONE_EMBEDDER } from "../src/embed/none.js";
import { runDaemonOnce } from "../src/daemon/index.js";
import { parseSinks, loadSinks } from "../src/sinks/config.js";
import { sinksRequeue, sinksStatus, sinksTest } from "../src/sinks/cli.js";
import { redactCredentials } from "../src/sinks/redact.js";
import { backoffMs, BATCH, LEASE_MS, leaseMsFor, PARKED_AT } from "../src/daemon/passes/outbox_deliver.js";
import type { SinkConfig } from "../src/sinks/types.js";
import type { Caller } from "../src/verbs/types.js";

const alpha: Caller = { bearer: "alpha", grants: {} };
const beta: Caller = { bearer: "beta", grants: {} };

let pool: Pool;
let admin: Pool;
let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
  dir = mkdtempSync(join(tmpdir(), "sinks-"));
});
afterAll(async () => {
  if (pool) await closePool(pool);
  if (admin) await closePool(admin);
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

const q = <T = any>(mind: string, sql: string, params: unknown[] = []): Promise<T[]> =>
  withMind(pool, mind, mind, "read", async (tx) => (await tx.query(sql, params)).rows as T[]);
const write = (sinks: SinkConfig[], caller: Caller, mind: string, text = "hello") =>
  runVerb({ pool, registry, embedder: NONE_EMBEDDER, sinks }, caller, "mind_write", { mind_id: mind, type: "note", text }) as Promise<any>;
const daemon = (sinks: SinkConfig[], now: Date, minds = ["alpha"]) =>
  runDaemonOnce({ pool, embedder: NONE_EMBEDDER, sinks, now: () => now }, { trigger: "manual", minds });
const deliverPass = (reports: Awaited<ReturnType<typeof daemon>>, mind = "alpha") =>
  reports.find((r) => r.mind_id === mind)!.passes.find((p) => p.pass === "outbox.deliver")!;

async function localServer(handler: (req: { headers: Record<string, any>; body: any }) => number): Promise<{ url: string; got: any[] }> {
  const got: any[] = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const rec = { headers: req.headers, body: JSON.parse(data) };
      got.push(rec);
      const status = handler(rec);
      res.statusCode = status;
      res.end(status >= 400 ? "nope ".repeat(100) : "ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as any).port}/in`, got };
}

describe("config", () => {
  it("resolves ${VAR} headers, validates and loads from SINKS or SINKS_FILE", () => {
    const raw = [{ name: "h", type: "http", url: "http://x.test/a", headers: { authorization: "Bearer ${TOK}" } }];
    const s = parseSinks(raw, { TOK: "secret" });
    expect(s[0]).toMatchObject({ headers: { authorization: "Bearer secret" }, timeout_ms: 10_000 });
    expect(() => parseSinks(raw, {})).toThrow(/TOK/);
    expect(() => parseSinks([{ name: "x", type: "ftp" }], {})).toThrow(/sinks/);
    expect(() => parseSinks([{ name: "a", type: "none" }, { name: "a", type: "none" }], {})).toThrow(/duplicate/);
    expect(loadSinks({})).toEqual([]);
    expect(loadSinks({ SINKS: JSON.stringify([{ name: "n", type: "none" }]) })).toHaveLength(1);
    const f = join(dir, "s.json");
    writeFileSync(f, JSON.stringify([{ name: "f", type: "file", path: "/tmp/x" }]));
    expect(loadSinks({ SINKS_FILE: f, SINKS: "[]" })[0]!.name).toBe("f");
    expect(() => loadSinks({ SINKS: "{" })).toThrow(/JSON/);
  });
});

describe("enqueue and file delivery", () => {
  it("enqueues for a matching kind, delivers one NDJSON line, and skips unmatched kinds", async () => {
    const path = join(dir, "out.ndjson");
    const sinks = parseSinks([{ name: "f", type: "file", path, filter: { kinds: ["write"] } }]);
    expect((await write(sinks, alpha, "alpha")).ok).toBe(true);
    await runVerb({ pool, registry, embedder: NONE_EMBEDDER, sinks }, alpha, "mind_state", { mind_id: "alpha", operation: "set", mood: "calm" });
    const rows = await q("alpha", `select o.*, e.kind from event_outbox o join events e on e.id = o.event_id`);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("write");
    const reports = await daemon(sinks, new Date());
    expect(deliverPass(reports).changed).toBe(1);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0]!);
    expect(body.sink).toBe("f");
    expect(body.event).toMatchObject({ id: rows[0].event_id, mind_id: "alpha", kind: "write", written_by: "alpha" });
    expect(body.event.payload.text).toBe("hello");
    expect((await q("alpha", `select delivered_at from event_outbox`))[0].delivered_at).not.toBeNull();
    // delivered rows are not delivered again
    expect(deliverPass(await daemon(sinks, new Date())).changed).toBe(0);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("no sinks configured, a none sink, or a minds filter that excludes the mind enqueue nothing", async () => {
    await write([], alpha, "alpha");
    await write(parseSinks([{ name: "n", type: "none" }]), alpha, "alpha");
    await write(parseSinks([{ name: "f", type: "file", path: join(dir, "z"), filter: { minds: ["beta"] } }]), alpha, "alpha");
    expect(await q("alpha", `select 1 from event_outbox`)).toHaveLength(0);
    expect(existsSync(join(dir, "z"))).toBe(false);
  });

  it("a failed transaction leaves no outbox row", async () => {
    const sinks = parseSinks([{ name: "f", type: "file", path: join(dir, "o") }]);
    const r: any = await runVerb({ pool, registry, embedder: NONE_EMBEDDER, sinks }, alpha, "mind_write", { mind_id: "alpha", type: "note", text: "x", bogus: 1 });
    expect(r.ok).toBe(false);
    expect(await q("alpha", `select 1 from event_outbox`)).toHaveLength(0);
  });
});

describe("http delivery", () => {
  it("fails twice then succeeds; attempts and next_attempt_at advance; a 4xx is retried; ${VAR} header resolved", async () => {
    let n = 0;
    const srv = await localServer(() => (++n <= 2 ? (n === 1 ? 500 : 403) : 200));
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url, headers: { "x-key": "k-${SINK_TEST_TOKEN}" } }], { SINK_TEST_TOKEN: "abc" });
    await write(sinks, alpha, "alpha");
    const t0 = new Date("2030-01-01T00:00:00Z");
    // the row is due immediately (default now() is the real clock, which is earlier than t0)
    let r = deliverPass(await daemon(sinks, t0));
    expect(r.changed).toBe(0);
    expect(r.notes![0]).toMatch(/attempt 1.*status 500/);
    let row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBe(t0.getTime() + 60_000);
    expect(row.last_error).toMatch(/^status 500/);
    expect(row.last_error.length).toBeLessThanOrEqual(200);
    // not yet due: no call
    r = deliverPass(await daemon(sinks, new Date(t0.getTime() + 30_000)));
    expect(srv.got).toHaveLength(1);
    // due: second failure (403 is retried too), delay 5 minutes
    const t1 = new Date(t0.getTime() + 60_000);
    r = deliverPass(await daemon(sinks, t1));
    row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.attempts).toBe(2);
    expect(new Date(row.next_attempt_at).getTime()).toBe(t1.getTime() + 5 * 60_000);
    expect(row.delivered_at).toBeNull();
    // third run delivers
    const t2 = new Date(t1.getTime() + 5 * 60_000);
    r = deliverPass(await daemon(sinks, t2));
    expect(r.changed).toBe(1);
    row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.delivered_at).not.toBeNull();
    expect(row.last_error).toBeNull();
    expect(srv.got).toHaveLength(3);
    expect(srv.got[0].headers["x-key"]).toBe("k-abc");
    expect(srv.got[2].body.sink).toBe("h");
    expect(srv.got[2].body.event.id).toBe(row.event_id);
  });

  it("backoff schedule and parking after 30 attempts", async () => {
    expect([1, 2, 3, 4, 5, 6, 29].map(backoffMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000, 86_400_000, 86_400_000]);
    const srv = await localServer(() => 502);
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url }]);
    await write(sinks, alpha, "alpha");
    await admin.query(`update event_outbox set attempts = 29`);
    const t = new Date("2030-01-01T00:00:00Z");
    const r = deliverPass(await daemon(sinks, t));
    expect(r.notes![0]).toMatch(/parked/);
    const row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.attempts).toBe(30);
    expect(new Date(row.next_attempt_at).getTime()).toBe(PARKED_AT.getTime());
    expect(row.last_error).toMatch(/gave up after 30/);
    expect(deliverPass(await daemon(sinks, new Date("3000-01-01T00:00:00Z"))).changed).toBe(0);
    expect(srv.got).toHaveLength(1);
  });

  it("an unreachable server is a failure with a recorded error, not a crash", async () => {
    const sinks = parseSinks([{ name: "h", type: "http", url: "http://127.0.0.1:1/x", timeout_ms: 2000 }]);
    await write(sinks, alpha, "alpha");
    const reports = await daemon(sinks, new Date());
    expect(reports[0]!.ok).toBe(true);
    const row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBeTruthy();
  });
});

describe("rls, health, status, test", () => {
  it("beta's outbox rows are invisible under alpha; status and health count", async () => {
    const srv = await localServer(() => 500);
    const path = join(dir, "o.ndjson");
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url }, { name: "f", type: "file", path }]);
    await write(sinks, alpha, "alpha");
    await write(sinks, beta, "beta", "b1");
    await write(sinks, beta, "beta", "b2");
    expect(await q("alpha", `select 1 from event_outbox`)).toHaveLength(2);
    expect(await q("beta", `select 1 from event_outbox`)).toHaveLength(4);
    expect(await q("alpha", `select 1 from event_outbox where mind_id = 'beta'`)).toHaveLength(0);
    await daemon(sinks, new Date(), ["alpha", "beta"]);
    const status = await sinksStatus(pool, sinks);
    expect(status).toEqual([
      // beta wrote two events: the sink stops at the first failure, so only one of them was attempted
      { sink: "h", pending: 3, failing: 2, delivered: 0 },
      { sink: "f", pending: 0, failing: 0, delivered: 3 },
    ]);
    const h: any = await runVerb({ pool, registry, embedder: NONE_EMBEDDER, sinks }, alpha, "mind_health", { mind_id: "alpha" });
    expect(h.receipt.projection.outbox).toEqual({ pending: 1, failing: 1 });
    const none: any = await runVerb({ pool, registry, embedder: NONE_EMBEDDER }, beta, "mind_health", { mind_id: "beta" });
    expect(none.receipt.projection.outbox).toEqual({ pending: 2, failing: 1 });
  });

  it("mind_health reports outbox null with no sinks and no rows", async () => {
    const h: any = await runVerb({ pool, registry, embedder: NONE_EMBEDDER }, alpha, "mind_health", { mind_id: "alpha" });
    expect(h.receipt.projection.outbox).toBeNull();
  });

  it("sinks test sends a synthetic sink.test body to each sink", async () => {
    const srv = await localServer((r) => (r.body.event.kind === "sink.test" ? 200 : 500));
    const path = join(dir, "t.ndjson");
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url }, { name: "f", type: "file", path }, { name: "bad", type: "http", url: "http://127.0.0.1:1/", timeout_ms: 1000 }]);
    const res = await sinksTest(sinks);
    expect(res.map((r) => [r.sink, r.ok])).toEqual([["h", true], ["f", true], ["bad", false]]);
    expect(JSON.parse(readFileSync(path, "utf8")).event.kind).toBe("sink.test");
  });
});

describe("credentials in sink URLs", () => {
  it("rejects userinfo in the url, resolves ${VAR} in it at load, and re-checks the resolved value", () => {
    const bad = (url: string) => () => parseSinks([{ name: "h", type: "http", url }], {});
    expect(bad("https://user:pass@example.test/in")).toThrow(/must not contain credentials/);
    expect(bad("https://token@example.test/in")).toThrow(/must not contain credentials/);
    expect(bad("https://${U}:${P}@example.test/in")).toThrow(/must not contain credentials/);
    expect(bad("ftp://example.test/in")).toThrow(/http or https/);
    expect(bad("not a url")).toThrow(/valid URL/);
    // the message never echoes the credentials
    try {
      bad("https://user:hunter2@example.test/in")();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("hunter2");
    }
    const ok = parseSinks([{ name: "h", type: "http", url: "https://${HOST}/ingest/${KEY}" }], { HOST: "example.test", KEY: "k1" });
    expect(ok[0]).toMatchObject({ url: "https://example.test/ingest/k1" });
    expect(() => parseSinks([{ name: "h", type: "http", url: "https://${HOST}/x" }], {})).toThrow(/HOST/);
    expect(() => parseSinks([{ name: "h", type: "http", url: "https://${HOST}/x" }], { HOST: "u:p@example.test" })).toThrow(/after resolving/);
    expect(() => loadSinks({ SINKS: '[{"name":"h","type":"http","url":"https://u:secretpw@example.test"' })).toThrow(/JSON/);
    try {
      loadSinks({ SINKS: '[{"name":"h","type":"http","url":"https://u:secretpw@example.test" oops}]' });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secretpw");
    }
  });

  it("redacts user:pass@ patterns from stored and returned errors", async () => {
    expect(redactCredentials("fail https://bob:s3cret@host.test/x and ftp://tok@h/y ok http://h/z")).toBe(
      "fail https://***@host.test/x and ftp://***@h/y ok http://h/z",
    );
    const srv = await rawServer((_req, res) => {
      res.statusCode = 500;
      res.end("upstream said: see https://svc:topsecret@internal.test/path");
    });
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url }]);
    await write(sinks, alpha, "alpha");
    const reports = await daemon(sinks, new Date());
    const row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.last_error).toContain("https://***@internal.test/path");
    expect(row.last_error).not.toContain("topsecret");
    expect(JSON.stringify(deliverPass(reports))).not.toContain("topsecret");
  });
});

async function rawServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as any).port}/in`, hits };
}

describe("http sink hardening", () => {
  it("does not follow redirects: a 302 is a failure and the target is never contacted", async () => {
    const target = await rawServer((_q, res) => res.end("ok"));
    const srv = await rawServer((_q, res) => {
      res.statusCode = 302;
      res.setHeader("location", target.url.replace("/in", "/elsewhere"));
      res.end();
    });
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url }]);
    await write(sinks, alpha, "alpha");
    await daemon(sinks, new Date());
    const row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.delivered_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/redirect/i);
    expect(target.hits).toEqual([]);
  });

  it("reads at most 4 KiB of an error body: a server that never finishes its body does not stall the delivery", async () => {
    const srv = await rawServer((_q, res) => {
      res.statusCode = 500;
      res.write("x".repeat(6000)); // more than the cap, and the body never ends
    });
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url, timeout_ms: 20_000 }]);
    await write(sinks, alpha, "alpha");
    const t0 = Date.now();
    await daemon(sinks, new Date());
    expect(Date.now() - t0).toBeLessThan(5000);
    const row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.last_error).toMatch(/^status 500 x+/);
    expect(row.last_error.length).toBeLessThanOrEqual(200);
  });
});

describe("outbox ordering and stop-on-failure", () => {
  const writeN = async (sinks: SinkConfig[], n: number) => {
    for (let i = 1; i <= n; i++) expect((await write(sinks, alpha, "alpha", `e${i}`)).ok).toBe(true);
  };

  it("delivers a sink's rows in ascending outbox id order", async () => {
    const srv = await localServer(() => 200);
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url }]);
    await writeN(sinks, 5);
    const expected = (await q("alpha", `select e.id from event_outbox o join events e on e.id = o.event_id order by o.id`)).map((r) => r.id);
    const r = deliverPass(await daemon(sinks, new Date()));
    expect(r.changed).toBe(5);
    expect(srv.got.map((g) => g.body.event.id)).toEqual(expected);
    const seqs = srv.got.map((g) => Number(g.body.event.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("stops a sink at its first failure for the rest of the run, leaving later rows untouched", async () => {
    let n = 0;
    const srv = await localServer(() => (++n === 2 ? 500 : 200)); // second request fails
    const sinks = parseSinks([{ name: "h", type: "http", url: srv.url }]);
    await writeN(sinks, 4);
    const ids = (await q("alpha", `select e.id from event_outbox o join events e on e.id = o.event_id order by o.id`)).map((r) => r.id);
    const before = await q("alpha", `select id, next_attempt_at from event_outbox order by id`);
    const t0 = new Date(Date.now() + 1000);
    const r = deliverPass(await daemon(sinks, t0));
    expect(r.changed).toBe(1);
    expect(srv.got.map((g) => g.body.event.id)).toEqual([ids[0], ids[1]]); // third and fourth were never tried
    const rows = await q("alpha", `select * from event_outbox order by id`);
    expect(rows.map((x) => [x.attempts, x.delivered_at !== null])).toEqual([[0, true], [1, false], [0, false], [0, false]]);
    // released, not leased: the untried rows are due exactly as before
    expect(new Date(rows[2].next_attempt_at).getTime()).toBe(new Date(before[2].next_attempt_at).getTime());
    expect(new Date(rows[3].next_attempt_at).getTime()).toBe(new Date(before[3].next_attempt_at).getTime());
    expect(new Date(rows[1].next_attempt_at).getTime()).toBe(t0.getTime() + 60_000);
    // the next run, once the failed row is due, goes through them in order
    const r2 = deliverPass(await daemon(sinks, new Date(t0.getTime() + 61_000)));
    expect(r2.changed).toBe(3);
    expect(srv.got.slice(2).map((g) => g.body.event.id)).toEqual([ids[1], ids[2], ids[3]]);
  });

  it("a failing sink does not stop another sink", async () => {
    const bad = await localServer(() => 500);
    const good = await localServer(() => 200);
    const sinks = parseSinks([{ name: "bad", type: "http", url: bad.url }, { name: "good", type: "http", url: good.url }]);
    await writeN(sinks, 3);
    const r = deliverPass(await daemon(sinks, new Date()));
    expect(r.changed).toBe(3);
    expect(bad.got).toHaveLength(1);
    expect(good.got).toHaveLength(3);
  });
});

describe("delivery holds no transaction and no daemon lock", () => {
  it("another run for the same mind proceeds while a sink hangs; rows are leased, not delivered twice", async () => {
    const hang = await rawServer(() => {
      // never answers: the sink timeout ends the call
    });
    const sinks = parseSinks([{ name: "h", type: "http", url: hang.url, timeout_ms: 4000 }]);
    await write(sinks, alpha, "alpha");
    const t0 = new Date(Date.now() + 1000);
    let aDone = false;
    const a = daemon(sinks, t0).then((r) => ((aDone = true), r));
    // wait until the sink has the request
    for (let i = 0; i < 100 && hang.hits.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(hang.hits).toHaveLength(1);

    // no connection of the app role sits idle in a transaction while the sink hangs
    const idle = await admin.query(
      `select count(*)::int n from pg_stat_activity where application_name = 'sanctum-test-app' and state like 'idle in transaction%'`,
    );
    expect(idle.rows[0].n).toBe(0);
    // the row is leased
    const leased = (await q("alpha", `select * from event_outbox`))[0];
    expect(leased.attempts).toBe(0);
    expect(new Date(leased.next_attempt_at).getTime()).toBeGreaterThan(t0.getTime() + 60_000);

    const started = Date.now();
    const b = await daemon(sinks, new Date(t0.getTime() + 5000));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(aDone).toBe(false);
    expect(b[0]!.ok).toBe(true);
    expect(b[0]!.passes.every((p) => p.ok)).toBe(true);
    expect(deliverPass(b).changed).toBe(0);
    expect(hang.hits).toHaveLength(1); // not handed to the sink a second time

    const ra = await a;
    expect(deliverPass(ra).notes![0]).toMatch(/attempt 1/);
    const row = (await q("alpha", `select * from event_outbox`))[0];
    expect(row.attempts).toBe(1);
    expect(row.delivered_at).toBeNull();
    expect(new Date(row.next_attempt_at).getTime()).toBeLessThan(t0.getTime() + 10 * 60_000);
  }, 30_000);
});

describe("sinks requeue", () => {
  it("resets only the parked, undelivered rows of the named sink", async () => {
    const good = await localServer(() => 200);
    const other = await localServer(() => 200);
    const sinks = parseSinks([{ name: "h", type: "http", url: good.url }, { name: "o", type: "http", url: other.url }]);
    await write(sinks, alpha, "alpha");
    await write(sinks, beta, "beta", "b");
    await admin.query(`update event_outbox set attempts = 30, next_attempt_at = $1, last_error = 'gave up after 30 attempts: x'`, [PARKED_AT]);
    await admin.query(`update event_outbox set attempts = 5, next_attempt_at = $1 where sink = 'h' and mind_id = 'beta'`, [new Date(Date.now() + 3600_000)]);
    const r = await sinksRequeue(pool, "h");
    expect(r).toEqual({ total: 1, minds: { alpha: 1 } });
    const rows = await q("alpha", `select sink, attempts, last_error, next_attempt_at from event_outbox order by sink`);
    expect(rows.find((x) => x.sink === "h")).toMatchObject({ attempts: 0, last_error: null });
    expect(new Date(rows.find((x) => x.sink === "h").next_attempt_at).getTime()).toBeLessThan(Date.now() + 1000);
    expect(rows.find((x) => x.sink === "o")).toMatchObject({ attempts: 30 }); // another sink: untouched
    expect((await q("beta", `select attempts from event_outbox where sink = 'h'`))[0].attempts).toBe(5); // not parked: untouched
    expect(deliverPass(await daemon(sinks, new Date(Date.now() + 1000))).changed).toBe(1);
    expect(good.got).toHaveLength(1);
    expect(await sinksRequeue(pool, "h")).toEqual({ total: 0, minds: {} });
  });
});

describe("outbox lease sizing", () => {
  it("is at least 30 minutes, and exceeds BATCH * the slowest configured timeout plus slack", () => {
    const slow = parseSinks([{ name: "h", type: "http", url: "http://x.test/a", timeout_ms: 120_000 }]);
    expect(leaseMsFor([])).toBe(LEASE_MS);
    expect(leaseMsFor(parseSinks([{ name: "f", type: "file", path: "/tmp/x" }]))).toBe(LEASE_MS);
    expect(leaseMsFor(parseSinks([{ name: "h", type: "http", url: "http://x.test/a", timeout_ms: 1000 }]))).toBe(LEASE_MS);
    expect(leaseMsFor(slow)).toBeGreaterThan(BATCH * 120_000);
    expect(leaseMsFor(slow)).toBe(BATCH * 120_000 + 5 * 60_000);
  });

  it("the claim leases rows for the computed time while the delivery is in flight", async () => {
    let leaseAt: Date | undefined;
    let t0 = 0;
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        void admin.query("select next_attempt_at from event_outbox where delivered_at is null").then((r) => {
          leaseAt = r.rows[0]?.next_attempt_at;
          res.statusCode = 200;
          res.end("ok");
        });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const sinks = parseSinks([{ name: "h", type: "http", url: `http://127.0.0.1:${(server.address() as any).port}/in`, timeout_ms: 120_000 }]);
    await write(sinks, alpha, "alpha");
    const now = new Date();
    t0 = now.getTime();
    expect(deliverPass(await daemon(sinks, now)).changed).toBe(1);
    expect(leaseAt).toBeDefined();
    expect(leaseAt!.getTime() - t0).toBeGreaterThan(BATCH * 120_000);
  });
});
