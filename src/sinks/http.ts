import { redactCredentials } from "./redact.js";
import type { DeliveryResult, HttpSinkConfig, SinkBody } from "./types.js";

/** A response body is read for at most this many bytes (an error text is stored at 200 characters). */
export const MAX_RESPONSE_BYTES = 4096;

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
    }
  } catch {
    // a body that fails mid-read still has a status worth recording
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

let lastWarn = -Infinity;
function warn(sink: string, msg: string, now: () => number): void {
  const t = now();
  if (t - lastWarn < 60_000) return;
  lastWarn = t;
  console.error(`sanctum-mind: http sink ${sink}: ${msg}`);
}

/** POSTs one body. 2xx is delivered; everything else (including network errors and timeouts) is a failure. */
export async function deliverHttp(
  sink: HttpSinkConfig,
  body: SinkBody,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<DeliveryResult> {
  try {
    const res = await fetchImpl(sink.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(sink.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(sink.timeout_ms),
      // a sink URL is operator-configured; a redirect would send the body (and headers) somewhere else
      redirect: "error",
    });
    if (res.status >= 200 && res.status < 300) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: true };
    }
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    const error = redactCredentials(`status ${res.status} ${text}`.trim()).slice(0, 200);
    warn(sink.name, error, now);
    return { ok: false, error };
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : "";
    const error = redactCredentials(`${e instanceof Error ? e.message : String(e)}${cause}`).slice(0, 200);
    warn(sink.name, error, now);
    return { ok: false, error };
  }
}
