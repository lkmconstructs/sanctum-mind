// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_MIGRATIONS_DIR } from "./db/migrate.js";

/**
 * The package's own name and version, read from package.json at runtime (it sits one directory above src/ and above dist/, and
 * the Docker image copies it next to dist/). There is no git in the image and none is needed: the version is the release.
 */
export interface PackageInfo {
  name: string;
  version: string;
}

let cached: PackageInfo | undefined;

export function packageInfo(): PackageInfo {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { name?: unknown; version?: unknown };
  if (typeof raw.name !== "string" || typeof raw.version !== "string") throw new Error("package.json has no name or version");
  cached = { name: raw.name, version: raw.version };
  return cached;
}

export interface BuildInfo extends PackageInfo {
  node: string;
  platform: string;
  /** "dist" when running the compiled build, "src" when running the sources through tsx */
  running_from: "dist" | "src";
  /** how many migrations this build carries, and the last one (without .sql) */
  migrations: { count: number; latest: string | null };
}

export function buildInfo(): BuildInfo {
  let files: string[] = [];
  try {
    files = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    files = [];
  }
  const last = files[files.length - 1];
  return {
    ...packageInfo(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    running_from: import.meta.url.endsWith(".ts") ? "src" : "dist",
    migrations: { count: files.length, latest: last === undefined ? null : last.replace(/\.sql$/, "") },
  };
}

export function formatBuildInfo(b: BuildInfo): string {
  return [
    `${b.name} ${b.version}`,
    `node ${b.node} on ${b.platform}`,
    `running from ${b.running_from === "dist" ? "dist (compiled)" : "src (tsx)"}`,
    `migrations in this build: ${b.migrations.count}${b.migrations.latest ? ` (latest ${b.migrations.latest})` : ""}`,
  ].join("\n");
}
