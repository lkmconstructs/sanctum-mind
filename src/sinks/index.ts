import { deliverFile } from "./file.js";
import { deliverHttp } from "./http.js";
import { redactCredentials } from "./redact.js";
import type { DeliveryResult, SinkBody, SinkConfig } from "./types.js";

export { loadSinks, parseSinks, resolveEnvRefs } from "./config.js";
export { redactCredentials } from "./redact.js";
export { sinkMatches } from "./types.js";
export type { SinkConfig, SinkBody, SinkEvent, DeliveryResult, HttpSinkConfig, FileSinkConfig, NoneSinkConfig } from "./types.js";

/** Delivers one body to one sink. Never throws; credentials embedded in a URL never appear in the error. */
export async function deliverToSink(
  sink: SinkConfig,
  body: SinkBody,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const r = await deliverRaw(sink, body, fetchImpl);
  return r.error === undefined ? r : { ...r, error: redactCredentials(r.error) };
}

async function deliverRaw(sink: SinkConfig, body: SinkBody, fetchImpl: typeof fetch): Promise<DeliveryResult> {
  switch (sink.type) {
    case "http":
      return deliverHttp(sink, body, fetchImpl);
    case "file":
      return deliverFile(sink, body);
    case "none":
      return { ok: true };
  }
}
