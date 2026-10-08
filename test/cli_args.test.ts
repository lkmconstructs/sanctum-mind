// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import { describe, expect, it } from "vitest";
import { ArgError, parseDaemonArgs, parseImportArgs } from "../src/cli-args.js";

describe("parseImportArgs", () => {
  it("reads a file, a mind, repeated sources and --dry-run", () => {
    expect(parseImportArgs(["x.json", "--mind", "alpha", "--source", "a", "--source", "b", "--dry-run"])).toEqual({
      file: "x.json", mind: "alpha", sources: ["a", "b"], dryRun: true,
    });
    expect(parseImportArgs(["--mind", "alpha", "x.json"])).toMatchObject({ file: "x.json", sources: [], dryRun: false });
  });

  it("rejects a typo flag", () => {
    expect(() => parseImportArgs(["x.json", "--mind", "alpha", "--dryrun"])).toThrow(ArgError);
    expect(() => parseImportArgs(["x.json", "--mind", "alpha", "--dryrun"])).toThrow(/Unknown option '--dryrun'/);
  });

  it("resolves `--mind alpha alpha` to mind alpha and file alpha", () => {
    expect(parseImportArgs(["--mind", "alpha", "alpha"])).toMatchObject({ mind: "alpha", file: "alpha" });
    expect(() => parseImportArgs(["--mind", "alpha"])).toThrow(/needs a file path/);
  });

  it("rejects `--source --dry-run` (a flag is not a value)", () => {
    expect(() => parseImportArgs(["x.json", "--mind", "alpha", "--source", "--dry-run"])).toThrow(ArgError);
  });

  it("rejects an extra positional", () => {
    expect(() => parseImportArgs(["a.json", "b.json", "--mind", "alpha"])).toThrow(/exactly one file/);
  });

  it("rejects --mind without a value, a missing --mind and an invalid mind id", () => {
    expect(() => parseImportArgs(["x.json", "--mind"])).toThrow(ArgError);
    expect(() => parseImportArgs(["x.json"])).toThrow(/--mind <id> is required/);
    expect(() => parseImportArgs(["x.json", "--mind", "bad id!"])).toThrow(/invalid mind_id/);
    expect(() => parseImportArgs(["x.json", "--mind", "__proto__"])).toThrow(/invalid mind_id/);
  });
});

describe("parseDaemonArgs", () => {
  it("defaults and reads flags", () => {
    expect(parseDaemonArgs([])).toEqual({ once: false, interval: 30 });
    expect(parseDaemonArgs(["--once", "--interval", "5", "--mind", "alpha"])).toEqual({ once: true, interval: 5, mind: "alpha" });
  });

  it("rejects a typo flag, any positional (including `--mind alpha alpha`) and --mind without a value", () => {
    expect(() => parseDaemonArgs(["--onec"])).toThrow(/Unknown option/);
    expect(() => parseDaemonArgs(["--mind", "alpha", "alpha"])).toThrow(/no positional arguments/);
    expect(() => parseDaemonArgs(["stray"])).toThrow(/no positional arguments/);
    expect(() => parseDaemonArgs(["--mind"])).toThrow(ArgError);
    expect(() => parseDaemonArgs(["--mind", "--once"])).toThrow(ArgError);
  });

  it("validates --interval and the mind id", () => {
    expect(() => parseDaemonArgs(["--interval", "0"])).toThrow(/--interval/);
    expect(() => parseDaemonArgs(["--interval", "1.5"])).toThrow(/--interval/);
    expect(() => parseDaemonArgs(["--interval", "abc"])).toThrow(/--interval/);
    expect(() => parseDaemonArgs(["--mind", "no/slash"])).toThrow(/invalid mind_id/);
  });
});
