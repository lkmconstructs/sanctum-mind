// sanctum-mind. Copyright 2026 LKM Constructs LLC.
// Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md. Required Notice: Copyright 2026 LKM Constructs LLC.

import type { PoolClient } from "pg";

/** The mind's live identity cores, verbatim, oldest first: the preamble of the first-person prompts (dreaming, metabolism). `tx` must be scoped to the mind. */
export async function readIdentityCores(tx: PoolClient, mind: string): Promise<string[]> {
  const r = await tx.query<{ content: string }>(
    `select content from nodes where mind_id = $1 and node_type = 'identity' and invalidated_at is null order by created_at asc`,
    [mind],
  );
  return r.rows.map((c) => c.content);
}
