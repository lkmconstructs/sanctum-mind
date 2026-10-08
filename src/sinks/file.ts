import { appendFile } from "node:fs/promises";
import type { DeliveryResult, FileSinkConfig, SinkBody } from "./types.js";

/** Appends one JSON line (NDJSON). */
export async function deliverFile(sink: FileSinkConfig, body: SinkBody): Promise<DeliveryResult> {
  try {
    await appendFile(sink.path, JSON.stringify(body) + "\n", "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
