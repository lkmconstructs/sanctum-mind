// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rerankerFromEnv } from "../src/rerank/index.js";
import { NONE_RERANKER } from "../src/rerank/none.js";
import { httpReranker } from "../src/rerank/http.js";
import { LOCAL_RERANK_MODEL, localReranker, type TransformersModule } from "../src/rerank/local.js";
import { sigmoid } from "../src/rerank/types.js";

interface Seen {
  method?: string | undefined;
  auth?: string | undefined;
  type?: string | undefined;
  body: any;
}

let server: Server;
let base = "";
let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any;
      try { body = JSON.parse(raw); } catch { body = raw; }
      seen.push({ method: req.method, auth: req.headers.authorization, type: req.headers["content-type"], body });
      handler(req, res, raw);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  seen = [];
  vi.restoreAllMocks();
});

const json = (res: ServerResponse, obj: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

describe("reranker none", () => {
  it("returns a null score for every document", async () => {
    expect(await NONE_RERANKER.rerank("q", ["a", "b", "c"])).toEqual([null, null, null]);
    expect(await NONE_RERANKER.rerank("q", [])).toEqual([]);
    expect(NONE_RERANKER.name).toBe("none");
  });
});

describe("reranker http", () => {
  it("POSTs {query, documents} as JSON and returns the scores in order", async () => {
    handler = (_req, res) => json(res, { scores: [0.9, 0.1, 0.5] });
    const r = httpReranker(`${base}/rerank`);
    expect(await r.rerank("rain on the river", ["one", "two", "three"])).toEqual([0.9, 0.1, 0.5]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", type: "application/json", body: { query: "rain on the river", documents: ["one", "two", "three"] } });
    expect(seen[0]!.auth).toBeUndefined();
    expect(r.name).toBe("http:127.0.0.1");
  });

  it("sends RERANK_API_KEY as a bearer token when set", async () => {
    handler = (_req, res) => json(res, { scores: [0.5] });
    await httpReranker(`${base}/rerank`, "s3cret").rerank("q", ["a"]);
    expect(seen[0]!.auth).toBe("Bearer s3cret");
  });

  it("reads scores outside 0..1 as logits and squashes the batch with the sigmoid", async () => {
    handler = (_req, res) => json(res, { scores: [4.2, -3, 0.5] });
    const out = await httpReranker(`${base}/rerank`).rerank("q", ["a", "b", "c"]);
    expect(out).toEqual([sigmoid(4.2), sigmoid(-3), sigmoid(0.5)]);
    for (const s of out) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
  });

  it("refuses a redirect: null scores, one warning, and the redirect target is never called", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    handler = (req, res) => {
      if (req.url === "/elsewhere") return json(res, { scores: [1] });
      res.writeHead(302, { location: `${base}/elsewhere` });
      res.end();
    };
    const r = httpReranker(`${base}/rerank`, "s3cret");
    expect(await r.rerank("q", ["a"])).toEqual([null]);
    expect(seen).toHaveLength(1); // /rerank only; the bearer token did not travel to /elsewhere
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("degrades to null scores with one warning on a server error, a bad shape, a wrong length, a non-number, and a dead server", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let t = 1_000_000;
    const r = httpReranker(`${base}/rerank`, undefined, fetch, () => t);
    const bodies: Array<[number, unknown]> = [
      [500, {}],
      [200, { nope: 1 }],
      [200, { scores: [0.5] }], // two documents, one score
      [200, { scores: [0.5, "x"] }],
      [200, { scores: [0.5, null] }],
    ];
    for (const [status, body] of bodies) {
      handler = (_req, res) => json(res, body, status);
      expect(await r.rerank("q", ["a", "b"])).toEqual([null, null]);
      t += 61_000; // past the once-a-minute warning window, so each failure is one warning
    }
    expect(warn).toHaveBeenCalledTimes(bodies.length);
    const dead = httpReranker("http://127.0.0.1:1/rerank");
    expect(await dead.rerank("q", ["a"])).toEqual([null]);
  });

  it("warns at most once a minute, and never throws on a timeout", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let t = 5_000_000;
    const timeout: typeof fetch = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const r = httpReranker("http://rerank.local/x", undefined, timeout, () => t);
    expect(await r.rerank("q", ["a", "b"])).toEqual([null, null]);
    expect(await r.rerank("q", ["a"])).toEqual([null]);
    expect(warn).toHaveBeenCalledTimes(1);
    t += 61_000;
    await r.rerank("q", ["a"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("asks fetch for a 10 second timeout and for redirects to be an error", async () => {
    let init: RequestInit | undefined;
    const spy: typeof fetch = async (_u, i) => {
      init = i;
      return new Response(JSON.stringify({ scores: [0.2] }), { status: 200 });
    };
    expect(await httpReranker("http://rerank.local/x", undefined, spy).rerank("q", ["a"])).toEqual([0.2]);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not call the server for an empty batch", async () => {
    expect(await httpReranker(`${base}/rerank`).rerank("q", [])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});

describe("reranker local", () => {
  /** A stand-in for @huggingface/transformers: the logit of a pair is the number written in the document. */
  function fakeTransformers(calls: { loads: number; batches: number[]; cacheDir?: string; model?: string }): TransformersModule {
    return {
      env: {
        get cacheDir() { return calls.cacheDir ?? ""; },
        set cacheDir(v: string) { calls.cacheDir = v; },
      },
      AutoTokenizer: {
        async from_pretrained(model: string) {
          calls.loads++;
          calls.model = model;
          return (queries: string[], opts: Record<string, unknown>) => ({ queries, docs: opts.text_pair as string[] });
        },
      },
      AutoModelForSequenceClassification: {
        async from_pretrained() {
          return async (inputs: any) => {
            calls.batches.push(inputs.docs.length);
            const data = Float32Array.from(inputs.docs.map((d: string) => Number(d)));
            return { logits: { data, dims: [inputs.docs.length, 1] } };
          };
        },
      },
    };
  }

  it("loads lazily, once, from RERANK_CACHE_DIR, and returns sigmoid(logit) per pair, in order, in batches of 16", async () => {
    const calls = { loads: 0, batches: [] as number[] } as { loads: number; batches: number[]; cacheDir?: string; model?: string };
    const r = localReranker({ RERANK_CACHE_DIR: "/tmp/rr-cache-test" }, async () => fakeTransformers(calls));
    expect(calls.loads).toBe(0); // nothing loads until the first call
    expect(await r.rerank("q", ["2", "-2", "0"])).toEqual([sigmoid(2), sigmoid(-2), 0.5]);
    expect(calls.loads).toBe(1);
    expect(calls.model).toBe(LOCAL_RERANK_MODEL);
    expect(calls.cacheDir).toBe("/tmp/rr-cache-test");
    const many = Array.from({ length: 35 }, (_, i) => String(i - 10));
    const out = await r.rerank("q", many);
    expect(out).toHaveLength(35);
    expect(calls.batches).toEqual([3, 16, 16, 3]);
    expect(calls.loads).toBe(1);
    for (const s of out) {
      expect(s).not.toBeNull();
      expect(s!).toBeGreaterThan(0);
      expect(s!).toBeLessThan(1);
    }
    expect(out[0]).toBeLessThan(out[34]!); // higher logit, higher score
    expect(r.name).toBe("local:ms-marco-MiniLM-L-6-v2");
  });

  it("defaults the cache dir to ./.rerank-cache (absolute)", async () => {
    const calls = { loads: 0, batches: [] as number[] } as { loads: number; batches: number[]; cacheDir?: string };
    await localReranker({}, async () => fakeTransformers(calls)).rerank("q", ["1"]);
    expect(calls.cacheDir?.endsWith("/.rerank-cache")).toBe(true);
    expect(calls.cacheDir?.startsWith("/")).toBe(true);
  });

  it("when the package or the model cannot be loaded: one warning, null scores, and it does not retry", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let tries = 0;
    const r = localReranker({}, async () => {
      tries++;
      throw new Error("Cannot find package '@huggingface/transformers'");
    });
    expect(await r.rerank("q", ["a", "b"])).toEqual([null, null]);
    expect(await r.rerank("q", ["a"])).toEqual([null]);
    expect(tries).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![1])).toMatch(/Cannot find package/);
  });

  it("the real loader, with the optional package absent, degrades the same way", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    // @huggingface/transformers is deliberately not a dependency of this repository
    const r = localReranker({ RERANK_CACHE_DIR: "/tmp/rr-cache-none" });
    expect(await r.rerank("q", ["a"])).toEqual([null]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an inference failure or a non-finite logit gives null scores and one warning", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = { loads: 0, batches: [] as number[] };
    const r = localReranker({}, async () => fakeTransformers(calls));
    expect(await r.rerank("q", ["not a number"])).toEqual([null]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("rerankerFromEnv", () => {
  it("defaults to none and accepts none, local and http", () => {
    expect(rerankerFromEnv({}).name).toBe("none");
    expect(rerankerFromEnv({ RERANKER: "" }).name).toBe("none");
    expect(rerankerFromEnv({ RERANKER: " None " }).name).toBe("none");
    expect(rerankerFromEnv({ RERANKER: "local" }).name).toBe("local:ms-marco-MiniLM-L-6-v2");
    expect(rerankerFromEnv({ RERANKER: "http", RERANK_URL: "https://rr.example/v1/rerank" }).name).toBe("http:rr.example");
  });

  it("fails fast on an unknown value, and on http without a usable RERANK_URL", () => {
    expect(() => rerankerFromEnv({ RERANKER: "cohere" })).toThrow(/RERANKER must be one of none, local, http/);
    expect(() => rerankerFromEnv({ RERANKER: "http" })).toThrow(/needs RERANK_URL/);
    expect(() => rerankerFromEnv({ RERANKER: "http", RERANK_URL: "not a url" })).toThrow(/not a valid URL/);
    expect(() => rerankerFromEnv({ RERANKER: "http", RERANK_URL: "ftp://x/y" })).toThrow(/http or https/);
    // credentials in the URL are refused, as for sinks, and the message does not repeat them
    for (const u of ["https://user:pw@rr.example/x", "https://token@rr.example/x"]) {
      let msg = "";
      try { rerankerFromEnv({ RERANKER: "http", RERANK_URL: u }); } catch (e) { msg = String(e); }
      expect(msg).toMatch(/must not contain credentials/);
      expect(msg).not.toMatch(/pw|token@/);
    }
  });
});
