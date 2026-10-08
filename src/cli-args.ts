import { parseArgs } from "node:util";
import { isValidMindId, mindIdProblem } from "./auth.js";

/** A bad command line: the message is shown to the user as is. */
export class ArgError extends Error {}

function parse<O extends Record<string, { type: "string" | "boolean"; multiple?: boolean }>>(argv: string[], options: O, usage: string) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (e) {
    throw new ArgError(`${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n${usage}`);
  }
}

export const DAEMON_USAGE = "usage: sanctum-mind daemon [--once] [--interval <minutes>] [--mind <id>]";
export const IMPORT_USAGE = "usage: sanctum-mind import-revien <file> --mind <id> [--source <id>]... [--dry-run]";

export interface DaemonArgs {
  once: boolean;
  interval: number;
  mind?: string;
}

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  const { values, positionals } = parse(
    argv,
    { once: { type: "boolean" }, interval: { type: "string" }, mind: { type: "string" } },
    DAEMON_USAGE,
  );
  if (positionals.length > 0) throw new ArgError(`daemon takes no positional arguments (got "${positionals.join(" ")}")\n${DAEMON_USAGE}`);
  let interval = 30;
  if (values.interval !== undefined) {
    interval = /^\d+$/.test(values.interval) ? Number(values.interval) : NaN;
    if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
      throw new ArgError("--interval must be an integer number of minutes from 1 to 1440");
    }
  }
  if (values.mind !== undefined && !isValidMindId(values.mind)) throw new ArgError(mindIdProblem(values.mind));
  return { once: values.once === true, interval, ...(values.mind !== undefined ? { mind: values.mind } : {}) };
}

export interface ImportArgs {
  file: string;
  mind: string;
  sources: string[];
  dryRun: boolean;
}

export function parseImportArgs(argv: string[]): ImportArgs {
  const { values, positionals } = parse(
    argv,
    { mind: { type: "string" }, source: { type: "string", multiple: true }, "dry-run": { type: "boolean" } },
    IMPORT_USAGE,
  );
  if (positionals.length === 0) throw new ArgError(`import-revien needs a file path\n${IMPORT_USAGE}`);
  if (positionals.length > 1) {
    throw new ArgError(`import-revien takes exactly one file, got ${positionals.length}: ${positionals.join(" ")}\n${IMPORT_USAGE}`);
  }
  if (values.mind === undefined || values.mind === "") throw new ArgError(`--mind <id> is required\n${IMPORT_USAGE}`);
  if (!isValidMindId(values.mind)) throw new ArgError(mindIdProblem(values.mind));
  const sources = values.source ?? [];
  if (sources.some((s) => s === "")) throw new ArgError("--source needs a non-empty source id");
  return { file: positionals[0]!, mind: values.mind, sources, dryRun: values["dry-run"] === true };
}
