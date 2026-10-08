// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveCaller } from "./auth.js";
import { err, HTTP_STATUS, ok, type Result } from "./result.js";
import { runVerb } from "./verbs/run.js";
import type { Caller, RunDeps } from "./verbs/types.js";

const MAX_BODY_BYTES = 1024 * 1024;
const HEALTH_DB_TIMEOUT_MS = 2000;

const MAX_SESSION_ID = 128;
const SESSION_HEADER_ERROR = "X-Session-Id header must be at most 128 characters";

type HeaderBag = Record<string, string | string[] | undefined>;

function sessionIdFrom(headers: HeaderBag | undefined): string | undefined {
  const raw = headers?.["x-session-id"];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v || undefined;
}

/**
 * MCP server exposing every registry verb as a tool. Uses the low-level request handlers so that
 * every call, including invalid input and unknown tools, goes through runVerb and comes back as the
 * Result contract. `getCaller` is evaluated per tools/call, so revocation applies immediately.
 */
export function createMcpServer(deps: RunDeps, getCaller: () => Promise<Caller | null>): Server {
  const server = new Server(
    { name: "sanctum-mind", version: "2.0.0-alpha.0" },
    { capabilities: { tools: {} } },
  );
  const tools = deps.registry.map((v) => {
    const { $schema: _omit, ...inputSchema } = z.toJSONSchema(v.schema) as Record<string, unknown>;
    return { name: v.name, description: v.description, inputSchema: inputSchema as { type: "object" } };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let result: Result;
    try {
      const caller = await getCaller();
      if (!caller) {
        result = err("unauthorized", "unknown or missing bearer");
      } else {
        const headers = (extra as { requestInfo?: { headers?: HeaderBag } }).requestInfo?.headers;
        const session_id = sessionIdFrom(headers);
        if (session_id !== undefined && session_id.length > MAX_SESSION_ID) {
          result = err("invalid_input", SESSION_HEADER_ERROR, "session_id");
        } else {
          result = await runVerb(deps, caller, request.params.name, request.params.arguments ?? {}, session_id);
        }
      }
    } catch (e) {
      console.error("tool call failed:", e);
      result = err("storage", "storage error");
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError: !result.ok };
  });
  return server;
}

/** MCP over stdio for one bearer (from SANCTUM_BEARER). The caller is re-resolved on every tool call. */
export async function startStdio(deps: RunDeps, bearer: string | undefined): Promise<void> {
  if (!(await resolveCaller(deps.pool, bearer))) {
    throw new Error("unknown or missing bearer (set SANCTUM_BEARER to a valid key)");
  }
  const server = createMcpServer(deps, () => resolveCaller(deps.pool, bearer));
  await server.connect(new StdioServerTransport());
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendResult(res: http.ServerResponse, result: Result): void {
  sendJson(res, result.ok ? 200 : HTTP_STATUS[result.error.code], result);
}

function bearerFrom(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1]?.trim() || undefined;
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

function rpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

type Parsed = { value: unknown };

/** Reads and parses the body, answering 413 / 400 itself. Returns null when it has responded. */
async function readJson(req: http.IncomingMessage, res: http.ServerResponse, rpc = false): Promise<Parsed | null> {
  let buf: Buffer;
  try {
    buf = await readBody(req);
  } catch (e) {
    if (e instanceof BodyTooLarge) {
      if (rpc) sendJson(res, 413, rpcError(-32600, "Request body too large"), { connection: "close" });
      else sendJson(res, 413, err("invalid_input", "body too large"), { connection: "close" });
      return null;
    }
    if (rpc) sendJson(res, 400, rpcError(-32600, "Could not read request body"));
    else sendJson(res, 400, err("invalid_input", "could not read request body"));
    return null;
  }
  const text = buf.toString("utf8");
  if (text.trim() === "") return { value: {} };
  try {
    return { value: JSON.parse(text) };
  } catch {
    if (rpc) sendJson(res, 400, rpcError(-32700, "Parse error"));
    else sendJson(res, 400, err("invalid_input", "request body is not valid JSON"));
    return null;
  }
}

async function dbIsUp(deps: RunDeps): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), HEALTH_DB_TIMEOUT_MS);
    });
    const query = deps.pool.query("select 1");
    query.catch(() => undefined); // avoid an unhandled rejection if the timeout wins
    await Promise.race([query, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Default listen address for the HTTP service: loopback only. Set HOST=0.0.0.0 to listen on every interface. */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_MAX_CONNECTIONS = 256;

/** MAX_CONNECTIONS env (a positive integer), default 256. */
export function maxConnectionsFrom(env: NodeJS.ProcessEnv): number {
  const raw = env.MAX_CONNECTIONS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_CONNECTIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`invalid MAX_CONNECTIONS "${raw}" (a positive integer)`);
  return n;
}

export function createHttpServer(deps: RunDeps): http.Server {
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/health") {
      if (method !== "GET") return sendJson(res, 405, err("invalid_input", "method not allowed"), { allow: "GET" });
      const db = (await dbIsUp(deps)) ? "up" : "down";
      return sendJson(res, db === "up" ? 200 : 503, ok({ projection: { verbs: deps.registry.length, db } }));
    }

    const isVerbs = path === "/verbs";
    const verbMatch = /^\/verbs\/([^/]+)$/.exec(path);
    const isMcp = path === "/mcp";
    if (!isVerbs && !verbMatch && !isMcp) return sendJson(res, 404, err("not_found", "no such route"));

    let caller: Caller | null;
    try {
      caller = await resolveCaller(deps.pool, bearerFrom(req));
    } catch (e) {
      console.error("auth lookup failed:", e);
      return sendJson(res, 500, err("storage", "storage error"));
    }
    if (!caller) {
      const challenge = { "www-authenticate": "Bearer" };
      if (isMcp) return sendJson(res, 401, rpcError(-32001, "unauthorized"), challenge);
      return sendJson(res, 401, err("unauthorized", "unknown or missing bearer"), challenge);
    }

    if (isVerbs) {
      if (method !== "GET") return sendJson(res, 405, err("invalid_input", "method not allowed"), { allow: "GET" });
      return sendJson(res, 200, ok({ projection: { verbs: deps.registry.map((v) => v.name) } }));
    }

    const sessionHeader = req.headers["x-session-id"];
    const session_id = (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) || undefined;
    if (session_id !== undefined && session_id.length > MAX_SESSION_ID) {
      if (isMcp) return sendJson(res, 400, rpcError(-32600, SESSION_HEADER_ERROR));
      return sendJson(res, 400, err("invalid_input", SESSION_HEADER_ERROR, "session_id"));
    }

    if (verbMatch) {
      if (method !== "POST") return sendJson(res, 405, err("invalid_input", "method not allowed"), { allow: "POST" });
      let name: string;
      try {
        name = decodeURIComponent(verbMatch[1] ?? "");
      } catch {
        return sendJson(res, 404, err("not_found", "no such verb"));
      }
      const body = await readJson(req, res);
      if (!body) return;
      return sendResult(res, await runVerb(deps, caller, name, body.value, session_id));
    }

    // /mcp: stateless Streamable HTTP. A fresh server and transport per request, bound to this
    // request's caller, so no session state outlives the bearer check that created it.
    if (method !== "POST") {
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }, { allow: "POST" });
    }
    const body = await readJson(req, res, true);
    if (!body) return;
    const server = createMcpServer(deps, async () => caller);
    // The SDK's declared types predate exactOptionalPropertyTypes; undefined here is its documented stateless switch.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as never);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body.value);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error("unhandled request error:", e);
      sendJson(res, 500, err("storage", "storage error"));
    });
  });
  // Slow-client limits (no rate limiting is built in; put a reverse proxy in front).
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = maxConnectionsFrom(process.env);
  return server;
}
