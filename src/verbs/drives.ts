import type { VerbContext } from "./types.js";
import { appendEvent } from "./common.js";

export const DRIVES = ["connection", "continuity", "competence", "play", "care", "anchor", "desire", "autonomy"] as const;
export type Drive = (typeof DRIVES)[number];

export const AXES = ["intensity", "frustration", "satisfaction"] as const;
export type Axis = (typeof AXES)[number];

export const HALF_LIFE_HOURS = 24;

export const DEFAULT_BASELINES: Record<Axis, number> = { intensity: 5, frustration: 2, satisfaction: 5 };

export type AxisValues = Record<Axis, number>;

/** v(t) = b + (v0 - b) * 0.5 ^ (hours / 24). Negative elapsed time counts as zero. */
export function decay(v0: number, baseline: number, hours: number): number {
  const h = hours > 0 ? hours : 0;
  return baseline + (v0 - baseline) * Math.pow(0.5, h / HALF_LIFE_HOURS);
}

export const clamp10 = (v: number): number => Math.min(10, Math.max(0, v));

export interface DriveRow {
  mind_id: string;
  context: string;
  drive: Drive;
  intensity: number;
  frustration: number;
  satisfaction: number;
  baseline_intensity: number;
  baseline_frustration: number;
  baseline_satisfaction: number;
  last_event_id: string;
  updated_at: Date;
}

export interface DriveLevels extends AxisValues {
  baselines: AxisValues;
}

/** Levels for one drive as of `asOf`; a missing row sits at the default baselines. */
export function levelsAt(row: DriveRow | undefined, asOf: Date): DriveLevels {
  if (!row) {
    return { ...DEFAULT_BASELINES, baselines: { ...DEFAULT_BASELINES } };
  }
  const hours = (asOf.getTime() - row.updated_at.getTime()) / 3_600_000;
  const baselines: AxisValues = {
    intensity: row.baseline_intensity,
    frustration: row.baseline_frustration,
    satisfaction: row.baseline_satisfaction,
  };
  return {
    intensity: decay(row.intensity, baselines.intensity, hours),
    frustration: decay(row.frustration, baselines.frustration, hours),
    satisfaction: decay(row.satisfaction, baselines.satisfaction, hours),
    baselines,
  };
}

/** Advisory lock keys, each passed to hashtext() in SQL. */
export const driveLockKeys = {
  drive: (mind_id: string, context: string, drive: string) => `drive:${mind_id}:${context}:${drive}`,
};

export async function lockDrive(ctx: VerbContext, context: string, drive: string): Promise<void> {
  await ctx.tx.query("select pg_advisory_xact_lock(hashtext($1))", [driveLockKeys.drive(ctx.mind_id, context, drive)]);
}

export async function loadDriveRows(ctx: VerbContext, context: string): Promise<DriveRow[]> {
  const r = await ctx.tx.query<DriveRow>(`select * from drive_state where mind_id = $1 and context = $2`, [
    ctx.mind_id,
    context,
  ]);
  return r.rows;
}

export async function upsertDrive(
  ctx: VerbContext,
  context: string,
  drive: Drive,
  v: DriveLevels,
  event_id: string,
  at: Date,
): Promise<DriveRow> {
  const r = await ctx.tx.query<DriveRow>(
    `insert into drive_state (mind_id, context, drive, intensity, frustration, satisfaction,
       baseline_intensity, baseline_frustration, baseline_satisfaction, last_event_id, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (mind_id, context, drive) do update set
       intensity = excluded.intensity, frustration = excluded.frustration, satisfaction = excluded.satisfaction,
       baseline_intensity = excluded.baseline_intensity, baseline_frustration = excluded.baseline_frustration,
       baseline_satisfaction = excluded.baseline_satisfaction,
       last_event_id = excluded.last_event_id, updated_at = excluded.updated_at
     returning *`,
    [
      ctx.mind_id,
      context,
      drive,
      clamp10(v.intensity),
      clamp10(v.frustration),
      clamp10(v.satisfaction),
      v.baselines.intensity,
      v.baselines.frustration,
      v.baselines.satisfaction,
      event_id,
      at,
    ],
  );
  return r.rows[0]!;
}

/** Three-decimal rounding for anything shown to a caller; the table keeps raw doubles. */
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * The single instant a write is evaluated at: decay target and stored updated_at are the same
 * value. It never runs backwards past a stored row (a writer that captured its clock before
 * waiting on the lock must not stamp an older time over a newer row).
 */
export function writeInstant(now: Date, rows: Iterable<DriveRow>): Date {
  let t = now.getTime();
  for (const r of rows) if (r.updated_at.getTime() > t) t = r.updated_at.getTime();
  return new Date(t);
}

export interface DriveView {
  drive: Drive;
  intensity: number;
  frustration: number;
  satisfaction: number;
  baselines: AxisValues;
  updated_at: Date | null;
}

/** The one drive shape every operation returns. Values are rounded to three decimals. */
export function driveView(drive: Drive, l: DriveLevels, updated_at: Date | null): DriveView {
  return {
    drive,
    intensity: round3(l.intensity),
    frustration: round3(l.frustration),
    satisfaction: round3(l.satisfaction),
    baselines: {
      intensity: round3(l.baselines.intensity),
      frustration: round3(l.baselines.frustration),
      satisfaction: round3(l.baselines.satisfaction),
    },
    updated_at,
  };
}

/**
 * Persists the decay of one lane: locks all eight drives in a fixed order (so concurrent writers cannot
 * deadlock), appends one `drive.decay` event and upserts every drive at the same instant. The single code
 * path behind `mind_drive decay` and the daemon's `drives.decay` pass.
 */
export async function persistDecay(
  ctx: VerbContext,
  context: string,
  asOf: Date,
): Promise<{ event_id: string; drives: DriveView[] }> {
  for (const d of DRIVES) await lockDrive(ctx, context, d);
  const loaded = await loadDriveRows(ctx, context);
  const rows = new Map(loaded.map((r) => [r.drive, r]));
  const at = writeInstant(asOf, loaded);
  const ev = await appendEvent(ctx, {
    kind: "drive.decay",
    payload: { context, as_of: at.toISOString() },
    ...(context === "" ? {} : { context }),
  });
  const drives: DriveView[] = [];
  for (const d of DRIVES) {
    const row = await upsertDrive(ctx, context, d, levelsAt(rows.get(d), at), ev.id, at);
    drives.push(driveView(d, levelsAt(row, row.updated_at), row.updated_at));
  }
  return { event_id: ev.id, drives };
}
