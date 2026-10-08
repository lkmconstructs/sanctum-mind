// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

/**
 * The one result contract. Every verb returns exactly one of these shapes.
 * There is no third shape: no `_error`, no `stored:false`, no success-shaped failure.
 */

export type ErrorCode =
  | "invalid_input" // payload failed validation at the boundary
  | "not_found"     // the subject row does not exist in this mind's scope
  | "unauthorized"  // missing, unknown or disabled bearer (HTTP 401)
  | "forbidden"     // bearer is not this mind and holds no matching grant
  | "conflict"      // the operation contradicts current state (e.g. backward transition)
  | "storage";      // the database refused or failed; details are logged, not returned

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  storage: 500,
};

export interface VerbError {
  code: ErrorCode;
  message: string;
  /** dotted path of the offending field, when the error is about one */
  field?: string;
}

export interface Receipt<P = unknown> {
  /** id of the ledger event this call appended; absent on pure reads */
  event_id?: string;
  /** the projection row(s) or read result this call produced */
  projection?: P;
  warnings?: string[];
}

export type Ok<P = unknown> = { ok: true; receipt: Receipt<P> };
export type Err = { ok: false; error: VerbError };
export type Result<P = unknown> = Ok<P> | Err;

export function ok<P>(receipt: Receipt<P>): Ok<P> {
  return { ok: true, receipt };
}

export function err(code: ErrorCode, message: string, field?: string): Err {
  return { ok: false, error: field === undefined ? { code, message } : { code, message, field } };
}

export function isOk<P>(r: Result<P>): r is Ok<P> {
  return r.ok;
}
