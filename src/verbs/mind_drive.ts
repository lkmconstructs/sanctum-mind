import { z } from "zod";
import { ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { appendEvent, mindIdSchema, text } from "./common.js";
import {
  AXES,
  DRIVES,
  clamp10,
  driveView,
  levelsAt,
  writeInstant,
  loadDriveRows,
  lockDrive,
  persistDecay,
  upsertDrive,
  type Drive,
} from "./drives.js";

const schema = z
  .strictObject({
    mind_id: mindIdSchema,
    operation: z.enum(["read", "nudge", "decay", "set_baseline"]),
    context: text(64).default(""),
    drive: z.enum(DRIVES).optional(),
    axis: z.enum(AXES).optional(),
    delta: z.number().min(-10).max(10).optional(),
    value: z.number().min(0).max(10).optional(),
    source: text(64).optional(),
    note: text(4000).optional(),
  })
  .superRefine((v, c) => {
    const need = (field: "drive" | "axis" | "delta" | "value", op: string) => {
      if (v[field] === undefined) {
        c.addIssue({ code: "custom", message: `${field} is required for ${op}`, path: [field] });
      }
    };
    if (v.operation === "nudge") {
      need("drive", "nudge");
      need("axis", "nudge");
      need("delta", "nudge");
    }
    if (v.operation === "set_baseline") {
      need("drive", "set_baseline");
      need("axis", "set_baseline");
      need("value", "set_baseline");
    }
  });

export const mind_drive = defineVerb({
  name: "mind_drive",
  description:
    "The eight drives (connection, continuity, competence, play, care, anchor, desire, autonomy), each with " +
    "intensity, frustration and satisfaction on 0 to 10. Values relax toward their baselines with a 24 hour half-life. " +
    "read (decayed as of now, nothing persisted), nudge (add a delta to one axis), decay (persist the decay), " +
    "set_baseline (move an axis's rest point). context is an optional lane tag; empty is the shared record.",
  schema,
  scopeFor: (input) => (input.operation === "read" ? "read" : "write"),
  handler: async (ctx, input): Promise<Result<unknown>> => {
    const context = input.context;
    const asOf = ctx.now();

    if (input.operation === "read") {
      const rows = new Map((await loadDriveRows(ctx, context)).map((r) => [r.drive, r]));
      const drives = DRIVES.map((d) => {
        const row = rows.get(d);
        return driveView(d, levelsAt(row, asOf), row?.updated_at ?? null);
      });
      return ok({ projection: { context, as_of: asOf.toISOString(), drives } });
    }

    if (input.operation === "decay") {
      const done = await persistDecay(ctx, context, asOf);
      return ok({ event_id: done.event_id, projection: { event_id: done.event_id, drives: done.drives } });
    }

    const drive = input.drive!;
    const axis = input.axis!;
    await lockDrive(ctx, context, drive);
    const row = (await loadDriveRows(ctx, context)).find((r) => r.drive === drive);
    // One instant for the whole write: decay target and stored updated_at (never behind the row).
    const at = writeInstant(asOf, row ? [row] : []);
    const cur = levelsAt(row, at);

    if (input.operation === "nudge") {
      const before = cur[axis];
      const after = clamp10(before + input.delta!);
      const next = { ...cur, [axis]: after };
      const ev = await appendEvent(ctx, {
        kind: "drive.nudge",
        payload: {
          context,
          drive,
          axis,
          delta: input.delta,
          source: input.source ?? null,
          note: input.note ?? null,
          before,
          after,
        },
        ...(context === "" ? {} : { context }),
      });
      const saved = await upsertDrive(ctx, context, drive, next, ev.id, at);
      return ok({ event_id: ev.id, projection: { event_id: ev.id, drive: driveView(drive, levelsAt(saved, saved.updated_at), saved.updated_at) } });
    }

    // set_baseline
    const next = { ...cur, baselines: { ...cur.baselines, [axis]: input.value! } };
    const ev = await appendEvent(ctx, {
      kind: "drive.baseline",
      payload: { context, drive, axis, value: input.value, source: input.source ?? null, note: input.note ?? null },
      ...(context === "" ? {} : { context }),
    });
    const saved = await upsertDrive(ctx, context, drive, next, ev.id, at);
    return ok({ event_id: ev.id, projection: { event_id: ev.id, drive: driveView(drive, levelsAt(saved, saved.updated_at), saved.updated_at) } });
  },
});
