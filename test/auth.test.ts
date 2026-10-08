import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { hashKey, mayAct, resolveCaller, seedMindsFromFile, upsertMinds } from "../src/auth.js";
import type { Caller } from "../src/verbs/types.js";
import { appPool, closePool, resetDatabase, TEST_KEYS } from "./helpers.js";

let admin: Pool; // seeding and grant changes need the admin role
let pool: Pool; // resolveCaller runs as the app role
let dir: string;

beforeEach(async () => {
  await closePool(pool);
  await closePool(admin);
  admin = await resetDatabase();
  pool = appPool();
});

beforeAll(async () => {
  admin = await resetDatabase();
  pool = appPool();
  dir = await mkdtemp(join(tmpdir(), "sanctum-auth-"));
});

afterAll(async () => {
  await closePool(pool);
  await closePool(admin);
  await rm(dir, { recursive: true, force: true });
});

describe("hashKey", () => {
  it("is deterministic sha256 hex", () => {
    const expected = createHash("sha256").update("some-key").digest("hex");
    expect(hashKey("some-key")).toBe(expected);
    expect(hashKey("some-key")).toBe(hashKey("some-key"));
    expect(hashKey("some-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey("other-key")).not.toBe(expected);
  });
});

describe("resolveCaller", () => {
  it("resolves alpha with no grants", async () => {
    expect(await resolveCaller(pool, TEST_KEYS.alpha)).toEqual({ bearer: "alpha", grants: {} });
  });

  it("resolves beta with its read grant on alpha", async () => {
    expect(await resolveCaller(pool, TEST_KEYS.beta)).toEqual({ bearer: "beta", grants: { alpha: ["read"] } });
  });

  it("a grant from a disabled grantor is not live", async () => {
    await admin.query("update minds set disabled_at = now() where mind_id = 'alpha'");
    expect(await resolveCaller(pool, TEST_KEYS.beta)).toEqual({ bearer: "beta", grants: {} });
  });

  it("a revoked grant is not live", async () => {
    await admin.query("update grants set revoked_at = now()");
    expect(await resolveCaller(pool, TEST_KEYS.beta)).toEqual({ bearer: "beta", grants: {} });
  });

  it("a __proto__ mind in the database does not break auth", async () => {
    await admin.query(
      "insert into minds (mind_id, key_hash) values ('__proto__', $1), ('victim', $2)",
      [hashKey("proto-key"), hashKey("victim-key")],
    );
    await admin.query(
      "insert into grants (grantor_mind, grantee_mind, scope) values ('__proto__', 'victim', 'read'), ('alpha', 'victim', 'write')",
    );
    const c = await resolveCaller(pool, "victim-key");
    expect(c).not.toBeNull();
    expect(Object.getPrototypeOf(c!.grants)).toBeNull();
    expect(Object.keys(c!.grants).sort()).toEqual(["__proto__", "alpha"]);
    expect(mayAct(c!, "alpha", "write")).toBe(true);
    expect(mayAct(c!, "beta", "read")).toBe(false);
    expect(mayAct(c!, "__proto__", "read")).toBe(true);
    // a caller with no such grant is not treated as holding one
    const b = await resolveCaller(pool, TEST_KEYS.beta);
    expect(mayAct(b!, "__proto__", "read")).toBe(false);
  });

  it("returns null for unknown, empty and missing keys", async () => {
    expect(await resolveCaller(pool, "not-a-key")).toBeNull();
    expect(await resolveCaller(pool, "")).toBeNull();
    expect(await resolveCaller(pool, undefined)).toBeNull();
  });
});

describe("mayAct", () => {
  const alpha: Caller = { bearer: "alpha", grants: {} };
  const beta: Caller = { bearer: "beta", grants: { alpha: ["read"] } };

  it("owner may act in its own scope", () => {
    expect(mayAct(alpha, "alpha", "write")).toBe(true);
    expect(mayAct(beta, "beta", "letter")).toBe(true);
  });
  it("a granted scope is allowed", () => {
    expect(mayAct(beta, "alpha", "read")).toBe(true);
  });
  it("a missing scope is refused", () => {
    expect(mayAct(beta, "alpha", "write")).toBe(false);
    expect(mayAct(alpha, "beta", "read")).toBe(false);
  });
  it("an unknown mind is refused", () => {
    expect(mayAct(beta, "nobody", "read")).toBe(false);
    expect(mayAct(beta, "constructor", "read")).toBe(false);
  });
});

describe("seedMindsFromFile", () => {
  it("adds a mind and rotates an existing key", async () => {
    const file = join(dir, "keys.txt");
    await writeFile(file, ["# keys", "", "alpha rotated-alpha-key-0123456789abcdefghij", "  ", "third third-key-0123456789abcdefghijklmnop", ""].join("\n"));
    expect(await seedMindsFromFile(admin, file)).toEqual({ upserted: 2, suspended: [] });

    expect(await resolveCaller(pool, TEST_KEYS.alpha)).toBeNull();
    expect(await resolveCaller(pool, "rotated-alpha-key-0123456789abcdefghij")).toEqual({ bearer: "alpha", grants: {} });
    expect(await resolveCaller(pool, "third-key-0123456789abcdefghijklmnop")).toEqual({ bearer: "third", grants: {} });
    // beta is untouched and keeps its grant
    expect(await resolveCaller(pool, TEST_KEYS.beta)).toEqual({ bearer: "beta", grants: { alpha: ["read"] } });
  });

  it("rotation leaves a suspended mind suspended and names it", async () => {
    const seed = join(dir, "third.txt");
    await writeFile(seed, "third third-key-0123456789abcdefghijklmnop\n");
    await seedMindsFromFile(admin, seed);
    await admin.query("update minds set disabled_at = now() where mind_id = 'third'");
    expect(await resolveCaller(pool, "third-key-0123456789abcdefghijklmnop")).toBeNull();
    const file = join(dir, "rotate.txt");
    await writeFile(file, "third third-key-rotated-0123456789abcdefghij\n");
    expect(await seedMindsFromFile(admin, file)).toEqual({ upserted: 1, suspended: ["third"] });
    expect((await admin.query("select disabled_at from minds where mind_id = 'third'")).rows[0].disabled_at).not.toBeNull();
    expect(await resolveCaller(pool, "third-key-rotated-0123456789abcdefghij")).toBeNull();
    await admin.query("update minds set disabled_at = null where mind_id = 'third'");
    expect(await resolveCaller(pool, "third-key-rotated-0123456789abcdefghij")).toEqual({ bearer: "third", grants: {} });
  });

  it("rejects reserved mind ids when seeding", async () => {
    const file = join(dir, "reserved.txt");
    await writeFile(file, "__proto__ some-key-0123456789abcdefghijklmnopq\n");
    await expect(seedMindsFromFile(admin, file)).rejects.toThrow(/line 1/);
  });

  it("throws naming the line for a bad mind_id and writes nothing", async () => {
    const file = join(dir, "bad.txt");
    await writeFile(file, ["# header", "good good-key-0123456789abcdefghijklmnopq", "", "bad id!x some-key-0123456789abcdefghijklmnopq"].join("\n"));
    await expect(seedMindsFromFile(admin, file)).rejects.toThrow(/line 4/);
    const file2 = join(dir, "bad2.txt");
    await writeFile(file2, ["fine fine-key-0123456789abcdefghijklmnopq", "bad$id key-0123456789abcdefghijklmnopqrstuv"].join("\n"));
    await expect(seedMindsFromFile(admin, file2)).rejects.toThrow(/line 2/);
    expect(await resolveCaller(pool, "good-key-0123456789abcdefghijklmnopq")).toBeNull();
    expect(await resolveCaller(pool, "fine-key-0123456789abcdefghijklmnopq")).toBeNull();
  });

  it("L2: a key under 32 characters is refused, naming the line, and nothing is written", async () => {
    const file = join(dir, "short.txt");
    await writeFile(file, ["# header", "okay okay-key-0123456789abcdefghijklmnopq", "", "weak short-key"].join("\n"));
    await expect(seedMindsFromFile(admin, file)).rejects.toThrow(/line 4: key for "weak" is too short \(9 characters; at least 32 required\)/);
    expect((await admin.query("select 1 from minds where mind_id in ('okay', 'weak')")).rowCount).toBe(0);
    // exactly 32 characters is accepted
    const ok = join(dir, "exact.txt");
    await writeFile(ok, `exact ${"k".repeat(32)}\n`);
    expect(await seedMindsFromFile(admin, ok)).toEqual({ upserted: 1, suspended: [] });
  });

  it("L2: upsertMinds refuses a short key directly", async () => {
    await expect(upsertMinds(admin, [{ mind_id: "tiny", key: "short" }])).rejects.toThrow(/entry 1: key for "tiny" is too short/);
    await expect(upsertMinds(admin, [{ mind_id: "tiny", key: "short", line: 7 }])).rejects.toThrow(/line 7/);
    expect((await admin.query("select 1 from minds where mind_id = 'tiny'")).rowCount).toBe(0);
  });
});
