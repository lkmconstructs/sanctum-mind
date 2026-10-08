import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHttpServer, DEFAULT_HOST, maxConnectionsFrom } from "../src/server.js";
import { setMindDisabled } from "../src/minds-admin.js";
import { createPool } from "../src/db/pool.js";
import { registry } from "../src/verbs/registry.js";
import { appPool, closePool, resetDatabase, TEST_KEYS } from "./helpers.js";

let admin: Pool;
let pool: Pool;
let server: http.Server;
let base: string;

const UNAUTHORIZED_BODY = { ok: false, error: { code: "unauthorized", message: "unknown or missing bearer" } };
const UNAUTHORIZED_RPC = { jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null };
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

beforeAll(async () => {
  admin = await resetDatabase();
  pool = appPool();
  server = createHttpServer({ pool, registry });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await closePool(pool);
  await closePool(admin);
});

async function post(path: string, key: string | undefined, body: string, extra: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? auth(key) : {}), ...extra },
    body,
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function mcp(key: string, body: unknown) {
  const res = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth(key) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function callTool(key: string, name: string, args: unknown) {
  const r = await mcp(key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(r.status).toBe(200);
  return r.json.result as { isError?: boolean; content: { text: string }[] };
}

describe("GET /health", () => {
  it("is open and reports verbs and db", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.receipt.projection.verbs).toBeGreaterThanOrEqual(2);
    expect(json.receipt.projection.db).toBe("up");
  });
});

describe("GET /health with the database down", () => {
  it("answers 503 and keeps the body", async () => {
    const dead = createPool("postgresql://nobody@127.0.0.1:1/none");
    const s = createHttpServer({ pool: dead, registry });
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/health`);
      expect(res.status).toBe(503);
      const json: any = await res.json();
      expect(json.ok).toBe(true);
      expect(json.receipt.projection.db).toBe("down");
    } finally {
      await new Promise<void>((resolve) => {
        s.closeAllConnections();
        s.close(() => resolve());
      });
      await dead.end().catch(() => undefined);
    }
  });
});

describe("GET /verbs", () => {
  it("requires a bearer", async () => {
    const res = await fetch(`${base}/verbs`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(UNAUTHORIZED_BODY);
  });
  it("rejects an unknown bearer", async () => {
    const res = await fetch(`${base}/verbs`, { headers: auth("nope") });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(UNAUTHORIZED_BODY);
  });
  it("lists verb names for alpha", async () => {
    const res = await fetch(`${base}/verbs`, { headers: auth(TEST_KEYS.alpha) });
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.ok).toBe(true);
    expect(json.receipt.projection.verbs).toContain("mind_state");
  });
});

describe("POST /verbs/<name>", () => {
  const setMood = JSON.stringify({ mind_id: "alpha", operation: "set", mood: "focused" });

  it("alpha sets state in its own scope and X-Session-Id becomes the event's session_id", async () => {
    const r = await post("/verbs/mind_state", TEST_KEYS.alpha, setMood, { "x-session-id": "sess-1" });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const id = r.json.receipt.event_id;
    expect(typeof id).toBe("string");
    const q = await admin.query("select session_id from events where id = $1", [id]);
    expect(q.rows[0]?.session_id).toBe("sess-1");
  });

  it("an X-Session-Id of 200 chars is 400 invalid_input on session_id", async () => {
    const r = await post("/verbs/mind_state", TEST_KEYS.alpha, setMood, { "x-session-id": "s".repeat(200) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_input");
    expect(r.json.error.field).toBe("session_id");
  });

  it("beta is forbidden from writing alpha's state", async () => {
    const r = await post("/verbs/mind_state", TEST_KEYS.beta, setMood);
    expect(r.status).toBe(403);
    expect(r.json.ok).toBe(false);
    expect(r.json.error.code).toBe("forbidden");
  });

  it("invalid JSON is 400 invalid_input", async () => {
    const r = await post("/verbs/mind_state", TEST_KEYS.alpha, "{not json");
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid_input");
  });

  it("a body over 1 MiB is 413 invalid_input", async () => {
    const r = await post("/verbs/mind_state", TEST_KEYS.alpha, JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }));
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("invalid_input");
    expect(r.json.error.message).toBe("body too large");
  });

  it("unknown verb is 404 not_found", async () => {
    const r = await post("/verbs/nope", TEST_KEYS.alpha, "{}");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });

  it("needs a bearer", async () => {
    const r = await post("/verbs/mind_state", undefined, setMood);
    expect(r.status).toBe(401);
    expect(r.json).toEqual(UNAUTHORIZED_BODY);
  });
});

describe("POST /mcp", () => {
  it("lists tools and calls mind_state through the SDK client", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: auth(TEST_KEYS.alpha) },
    });
    await client.connect(transport as Transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("mind_state");
      expect(names).toContain("mind_health");

      const result: any = await client.callTool({
        name: "mind_state",
        arguments: { mind_id: "alpha", operation: "read" },
      });
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.ok).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("tools/list exposes both tools with a mind_id pattern in the input schema", async () => {
    const r = await mcp(TEST_KEYS.alpha, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = r.json.result.tools as any[];
    expect(tools.map((t) => t.name).sort()).toEqual(["mind_anchor", "mind_context", "mind_desire", "mind_drive", "mind_handoff", "mind_health", "mind_identity", "mind_letter", "mind_link", "mind_loop", "mind_observe", "mind_orient", "mind_relate", "mind_resolve", "mind_rethink", "mind_search", "mind_sit", "mind_state", "mind_surface", "mind_task", "mind_thread", "mind_vow", "mind_weather", "mind_write"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.inputSchema.properties.mind_id.pattern).toBe("string");
    }
  });

  it("tools/call with invalid input returns the Result contract with isError", async () => {
    const r = await callTool(TEST_KEYS.alpha, "mind_state", { mind_id: "alpha", operation: "set", energy: "huge" });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("invalid_input");
    expect(parsed.error.field).toBe("energy");
  });

  it("tools/call with an unknown tool returns not_found", async () => {
    const r = await callTool(TEST_KEYS.alpha, "mind_nope", {});
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("not_found");
  });

  it("tools/call as beta on alpha's set is forbidden", async () => {
    const r = await callTool(TEST_KEYS.beta, "mind_state", { mind_id: "alpha", operation: "set", mood: "x" });
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("forbidden");
  });

  it("bad JSON on /mcp is a JSON-RPC -32700 error", async () => {
    const r = await post("/mcp", TEST_KEYS.alpha, "{not json");
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  });

  it("an oversized /mcp body is a JSON-RPC -32600 error", async () => {
    const r = await post("/mcp", TEST_KEYS.alpha, JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }));
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe(-32600);
    expect(r.json.error.message).toBe("Request body too large");
  });

  it("an over-long X-Session-Id on /mcp is a JSON-RPC -32600 error naming the header", async () => {
    const r = await post(
      "/mcp",
      TEST_KEYS.alpha,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      { "x-session-id": "s".repeat(200) },
    );
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe(-32600);
    expect(r.json.error.message).toContain("X-Session-Id");
  });

  it("401 carries WWW-Authenticate: Bearer on every protected route", async () => {
    for (const [path, method] of [["/verbs", "GET"], ["/verbs/mind_state", "POST"], ["/mcp", "POST"]] as const) {
      const res = await fetch(base + path, { method });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("rejects a missing or unknown bearer with 401 and a JSON-RPC -32001 error plus the header", async () => {
    for (const key of [undefined, "nope"]) {
      const res = await fetch(base + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? auth(key) : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual(UNAUTHORIZED_RPC);
    }
  });

  it("a scope failure stays 403 forbidden, not 401", async () => {
    const r = await post("/verbs/mind_state", TEST_KEYS.beta, JSON.stringify({ mind_id: "alpha", operation: "set", mood: "x" }));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("forbidden");
  });
});

describe("listen host and connection limits (M2, L7)", () => {
  it("honours the host passed to listen: bound to 127.0.0.1 it reports that address", async () => {
    const s = createHttpServer({ pool, registry });
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    try {
      const addr = s.address() as AddressInfo;
      expect(addr.address).toBe("127.0.0.1");
      expect(addr.family).toBe("IPv4");
      const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => {
        s.closeAllConnections();
        s.close(() => resolve());
      });
    }
  });

  it("the CLI default host is loopback", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("sets slow-client timeouts and a connection cap", () => {
    expect(server.headersTimeout).toBe(15_000);
    expect(server.requestTimeout).toBe(30_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxConnections).toBe(256);
  });

  it("MAX_CONNECTIONS is read from the environment and validated", () => {
    expect(maxConnectionsFrom({})).toBe(256);
    expect(maxConnectionsFrom({ MAX_CONNECTIONS: "10" })).toBe(10);
    expect(() => maxConnectionsFrom({ MAX_CONNECTIONS: "0" })).toThrow(/MAX_CONNECTIONS/);
    expect(() => maxConnectionsFrom({ MAX_CONNECTIONS: "lots" })).toThrow(/MAX_CONNECTIONS/);
    const prev = process.env.MAX_CONNECTIONS;
    process.env.MAX_CONNECTIONS = "7";
    try {
      expect(createHttpServer({ pool, registry }).maxConnections).toBe(7);
    } finally {
      if (prev === undefined) delete process.env.MAX_CONNECTIONS;
      else process.env.MAX_CONNECTIONS = prev;
    }
  });
});

describe("a disabled mind (L10)", () => {
  it("its bearer is 401 unauthorized and grants from it stop applying; enabling restores both", async () => {
    await admin.query("insert into grants (grantor_mind, grantee_mind, scope) values ('alpha', 'beta', 'write')");
    const readAlpha = JSON.stringify({ mind_id: "alpha", operation: "read" });
    const betaOnAlpha = () => post("/verbs/mind_state", TEST_KEYS.beta, readAlpha);
    try {
      expect((await betaOnAlpha()).status).toBe(200);
      await setMindDisabled(admin, "alpha", true);
      const own = await post("/verbs/mind_state", TEST_KEYS.alpha, readAlpha);
      expect(own.status).toBe(401);
      expect(own.json.error.code).toBe("unauthorized");
      const viaGrant = await betaOnAlpha();
      expect(viaGrant.status).toBe(403);
      expect(viaGrant.json.error.code).toBe("forbidden");
      await setMindDisabled(admin, "alpha", false);
      expect((await post("/verbs/mind_state", TEST_KEYS.alpha, readAlpha)).status).toBe(200);
      expect((await betaOnAlpha()).status).toBe(200);
    } finally {
      await admin.query("delete from grants where scope = 'write'");
      await setMindDisabled(admin, "alpha", false);
    }
  });
});
