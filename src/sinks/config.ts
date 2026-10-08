// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { redactCredentials } from "./redact.js";
import type { SinkConfig } from "./types.js";

const filter = z.strictObject({
  kinds: z.array(z.string().min(1)).optional(),
  minds: z.array(z.string().min(1)).optional(),
});
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * A sink URL: http or https, no userinfo (credentials belong in headers, via ${VAR}). ${VAR} references
 * are allowed anywhere and are replaced by a stand-in for the syntax check; they are resolved at load.
 */
function urlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.replace(ENV_REF, "x"));
  } catch {
    return "url is not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "url must be http or https";
  if (u.username !== "" || u.password !== "") {
    return "url must not contain credentials (user:pass@); put them in headers with a ${VAR} reference";
  }
  return null;
}

const sinkUrl = z.string().min(1).superRefine((v, c) => {
  const p = urlProblem(v);
  if (p !== null) c.addIssue({ code: "custom", message: p });
});

const name = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/, "sink name must be 1-64 of [a-zA-Z0-9_.-]");

const sinkSchema = z.discriminatedUnion("type", [
  z.strictObject({
    name,
    type: z.literal("http"),
    filter: filter.optional(),
    url: sinkUrl,
    headers: z.record(z.string(), z.string()).optional(),
    timeout_ms: z.number().int().min(1).max(120_000).default(10_000),
  }),
  z.strictObject({ name, type: z.literal("file"), filter: filter.optional(), path: z.string().min(1) }),
  z.strictObject({ name, type: z.literal("none"), filter: filter.optional() }),
]);

const sinksSchema = z.array(sinkSchema).superRefine((arr, ctx) => {
  const seen = new Set<string>();
  for (const [i, s] of arr.entries()) {
    if (seen.has(s.name)) ctx.addIssue({ code: "custom", message: `duplicate sink name ${s.name}`, path: [i, "name"] });
    seen.add(s.name);
  }
});

/** Replaces every ${VAR} with env[VAR]; throws on an unset variable so a secret is never silently empty. */
export function resolveEnvRefs(value: string, env: Record<string, string | undefined>, where: string): string {
  return value.replace(ENV_REF, (_m, v: string) => {
    const r = env[v];
    if (r === undefined) throw new Error(`sinks: ${where} references unset environment variable ${v}`);
    return r;
  });
}

/** Validates a parsed sinks array and resolves header env references. */
export function parseSinks(raw: unknown, env: Record<string, string | undefined> = process.env): SinkConfig[] {
  const parsed = sinksSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new Error(redactCredentials(`sinks: invalid configuration at ${i?.path.join(".") || "(root)"}: ${i?.message ?? "invalid"}`));
  }
  return parsed.data.map((s): SinkConfig => {
    if (s.type !== "http") return s;
    // ${VAR} in the url is resolved here; the result is checked again, since a variable could carry user:pass@
    const url = resolveEnvRefs(s.url, env, `sink ${s.name} url`);
    const problem = urlProblem(url);
    if (problem !== null) throw new Error(`sinks: sink ${s.name}: ${problem} (after resolving environment references)`);
    if (!s.headers) return { ...s, url };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers)) headers[k] = resolveEnvRefs(v, env, `sink ${s.name} header ${k}`);
    return { ...s, url, headers };
  });
}

/** SINKS_FILE (path to JSON) wins over SINKS (inline JSON); neither set means no sinks. Throws on bad config. */
export function loadSinks(env: Record<string, string | undefined> = process.env): SinkConfig[] {
  const file = env.SINKS_FILE?.trim();
  const inline = env.SINKS?.trim();
  let text: string;
  if (file) {
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`sinks: cannot read SINKS_FILE: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (inline) {
    text = inline;
  } else {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(redactCredentials(`sinks: configuration is not valid JSON: ${e instanceof Error ? e.message : String(e)}`));
  }
  return parseSinks(raw, env);
}
