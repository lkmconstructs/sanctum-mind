import { z } from "zod";
import { ok, type Result } from "../result.js";
import { defineVerb } from "./types.js";
import { mindIdSchema, text } from "./common.js";

const schema = z.strictObject({
  mind_id: mindIdSchema,
  lookback_hours: z.number().min(1).max(24 * 30).default(24),
  context: text(64).optional(),
});

type Counts = Record<string, number>;

/** Count descending, then name ascending, so the output is deterministic. */
function ranked(m: Map<string, number>, top?: number): [string, number][] {
  const all = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return top === undefined ? all : all.slice(0, top);
}

const toObject = (entries: [string, number][]): Counts => Object.fromEntries(entries);
const listing = (entries: [string, number][]) => entries.map(([k, n]) => `${k} (${n})`).join(", ");

export const mind_weather = defineVerb({
  name: "mind_weather",
  description:
    "A deterministic read of recent texture: charge tags, salience, vividness, grip, somatic locations and event kinds " +
    "over a lookback window, plus a one paragraph report. No model call and nothing is written.",
  schema,
  scopeFor: () => "read",
  handler: async (ctx, input): Promise<Result<unknown>> => {
    const to = ctx.now();
    const from = new Date(to.getTime() - input.lookback_hours * 3_600_000);
    const ctxFilter = input.context ?? null;

    // Window: from <= created_at <= to. The empty string is the shared lane (context is null).
    const win = `mind_id = $1 and created_at >= $2 and created_at <= $3
       and ($4::text is null or context is not distinct from nullif($4, ''))`;
    const params = [ctx.mind_id, from, to, ctxFilter];

    const kindRows = await ctx.tx.query<{ kind: string; n: string }>(
      `select kind, count(*) as n from events where ${win} group by kind`,
      params,
    );
    const textured = await ctx.tx.query<{ n: string }>(
      `select count(*) as n from events where ${win} and texture is not null`,
      params,
    );
    // Charge tags: one row per tag, grouped and limited in SQL. "C" collation matches the JS tie order.
    const chargeRows = await ctx.tx.query<{ k: string; n: string }>(
      `select e #>> '{}' as k, count(*) as n
       from events,
         jsonb_array_elements(case when jsonb_typeof(texture->'charge') = 'array' then texture->'charge' else '[]'::jsonb end) e
       where ${win} and texture is not null and jsonb_typeof(e) = 'string'
       group by 1 order by count(*) desc, (e #>> '{}') collate "C" asc limit 10`,
      params,
    );
    const scalar = async (field: string, limit: number | null) =>
      ctx.tx.query<{ k: string; n: string }>(
        `select texture->>'${field}' as k, count(*) as n from events
         where ${win} and texture is not null and jsonb_typeof(texture->'${field}') = 'string'
         group by 1 order by count(*) desc, (texture->>'${field}') collate "C" asc ${limit === null ? "" : "limit " + limit}`,
        params,
      );
    const [salienceRows, vividnessRows, gripRows, somaticRows] = [
      await scalar("salience", null),
      await scalar("vividness", null),
      await scalar("grip", null),
      await scalar("somatic", 5),
    ];

    const toMap = (rows: { k: string; n: string }[]) => new Map(rows.map((r) => [r.k, Number(r.n)]));
    const kinds = new Map<string, number>();
    let event_count = 0;
    for (const r of kindRows.rows) {
      kinds.set(r.kind, Number(r.n));
      event_count += Number(r.n);
    }
    const charge = toMap(chargeRows.rows);
    const salience = toMap(salienceRows.rows);
    const vividness = toMap(vividnessRows.rows);
    const grip = toMap(gripRows.rows);
    const somatic = toMap(somaticRows.rows);
    const textured_count = Number(textured.rows[0]!.n);

    const hours = input.lookback_hours;
    let report: string;
    if (event_count === 0) {
      report = "Quiet: no events in the window.";
    } else {
      const parts = [
        `Over the last ${hours} hours: ${event_count} ${event_count === 1 ? "event" : "events"}, ${textured_count} carrying texture.`,
      ];
      const topCharge = ranked(charge, 3);
      if (topCharge.length > 0) parts.push(`Dominant charge: ${listing(topCharge)}.`);
      const v = ranked(vividness, 1)[0];
      const g = ranked(grip, 1)[0];
      if (v && g) parts.push(`Mostly ${v[0]} and ${g[0]}.`);
      else if (v) parts.push(`Mostly ${v[0]}.`);
      else if (g) parts.push(`Mostly ${g[0]}.`);
      report = parts.join(" ");
    }

    return ok({
      projection: {
        window: { from: from.toISOString(), to: to.toISOString(), hours },
        event_count,
        textured_count,
        kinds: toObject(ranked(kinds)),
        charge_counts: toObject(ranked(charge, 10)),
        salience: toObject(ranked(salience)),
        vividness: toObject(ranked(vividness)),
        grip: toObject(ranked(grip)),
        somatic: toObject(ranked(somatic, 5)),
        report,
      },
    });
  },
});
