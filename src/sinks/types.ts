export interface SinkFilter {
  kinds?: string[] | undefined;
  minds?: string[] | undefined;
}

export interface HttpSinkConfig {
  name: string;
  type: "http";
  filter?: SinkFilter | undefined;
  url: string;
  /** header values already resolved from ${VAR} references */
  headers?: Record<string, string> | undefined;
  timeout_ms: number;
}

export interface FileSinkConfig {
  name: string;
  type: "file";
  filter?: SinkFilter | undefined;
  path: string;
}

export interface NoneSinkConfig {
  name: string;
  type: "none";
  filter?: SinkFilter | undefined;
}

export type SinkConfig = HttpSinkConfig | FileSinkConfig | NoneSinkConfig;

/** The event as delivered to a sink. */
export interface SinkEvent {
  id: string;
  seq: string;
  mind_id: string;
  kind: string;
  subject_id: string | null;
  payload: unknown;
  texture: unknown;
  context: string | null;
  recorded_at: Date | string;
  event_time_start: Date | string | null;
  event_time_end: Date | string | null;
  event_time_granularity: string | null;
  created_at: Date | string;
  session_id: string | null;
  written_by: string;
}

export interface SinkBody {
  sink: string;
  event: SinkEvent;
}

export interface DeliveryResult {
  ok: boolean;
  /** status and first 200 characters, or the error message */
  error?: string;
}

/** True when the sink wants this event. */
export function sinkMatches(sink: SinkConfig, kind: string, mindId: string): boolean {
  if (sink.type === "none") return false;
  const f = sink.filter;
  if (f?.kinds && f.kinds.length > 0 && !f.kinds.includes(kind)) return false;
  if (f?.minds && f.minds.length > 0 && !f.minds.includes(mindId)) return false;
  return true;
}
