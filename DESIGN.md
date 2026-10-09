# sanctum-mind design

Status: design draft, 5 October 2026.

sanctum-mind is a construct-neutral continuity substrate: one service, one
database it owns, one result contract, any number of minds. It owns its storage
and does not depend on any other service on the read path.

Deployment-specific history and decisions live outside the core.

## Architecture

```
MCP client (any construct, any host)
   │  stdio or Streamable HTTP, bearer key per mind
   ▼
sanctum-mind service (TypeScript, Node 22)
   ├─ verbs/        one module per verb, zod schema in, typed result out
   ├─ ledger/       append-only events, the only thing that is ever written
   ├─ projections/  current truth derived from the ledger (state, drives,
   │                relations, loops, tasks, threads, handoff)
   ├─ graph/        nodes and edges, recall, invalidation, provenance
   ├─ recall/       hybrid retrieval: pgvector + full text + graph walk
   └─ adapters/     optional import and export adapters
   ▼
PostgreSQL 15 or 16 + pgvector
```

Supabase is the same engine, so the connection string determines local versus
hosted. Nothing in the schema assumes either.

### Two record classes

**Events** are the originals. Every verb that changes anything appends exactly
one event. Events are append-only: a database trigger refuses updates and deletes, except that a missing
embedding may be filled in later (backfill). Purge is the one deletion path, and it is an admin function. Columns:

```
events(
  id uuid pk,
  mind_id text not null,            -- the construct this belongs to
  kind text not null,               -- observe, write, sit, resolve, loop.create,
                                    -- loop.resolve, vow.make, relate.set, ...
  subject_id uuid null,             -- the node or prior event this acts on
  payload jsonb not null,           -- kind-specific, validated by zod
  texture jsonb null,               -- salience, vividness, grip, charge, somatic
  context text null,                -- a lane tag
  recorded_at timestamptz not null, -- when it was said
  event_time_start timestamptz null,
  event_time_end timestamptz null,
  event_time_granularity text null, -- day, week, month, year, fuzzy
  created_at timestamptz not null default now(),
  session_id text null,
  embedding vector(384) null
)
```

**Projections** are current truth, derived from events deterministically and
rebuildable at any time. One table per projection: `brain_state`,
`drive_state`, `relations`, `loops`, `threads`, `tasks`, `handoffs`,
`letters`. Each row carries `mind_id` (letters carry `from_mind` and `to_mind`) and the id
of the last event that touched it. Reads go here. Reads never go to recall.

**Graph** is curated memory: `nodes` and `edges` carrying a bitemporal model
(type, label, content, confidence, source_type, invalidated_at, and the
`recorded_at` / `event_time` / `created_at` time concepts) plus `mind_id`. Identity cores, lineage, welds live here. Recall
(semantic, text, graph walk) runs over nodes and events, always filtered by
`mind_id` and `invalidated_at is null`.

### Isolation

- `mind_id` is a required argument on every verb. Verbs with no `mind_id` do
  not exist.
- Postgres row level security on every mind-scoped data table, keyed on a session variable the
  service sets per transaction. RLS confines a transaction to the one mind the service selected; the
  service selects it from the bearer key and the bearer's grants (`mayAct` in the verb runner). `minds`,
  `grants` and `schema_migrations` have no RLS; the app role can only read them. A bug in a verb cannot leak
  across minds through SQL, because the database refuses rows of any other mind; but the runner's grant
  check is application code, and RLS does not enforce grants.
- Row level security is a guard against verb bugs, not against SQL injection:
  the service role sets its own scope variable, so injected SQL could reset it.
  Injection is prevented one layer up, by parameterised queries only and strict
  schemas at the boundary. The service also refuses to run as a superuser or a
  `BYPASSRLS` role, since either would see every mind.
- A letter is one row, visible to both its sender and its recipient (a policy on the letters table), and
  written by the sender. Letters remain the only cross-mind channel.

### Grants

```
grants(
  grantor_mind text not null,   -- the mind whose scope this opens (recorded by the operator)
  grantee_mind text not null,   -- who may act in it
  scope text not null,          -- read, write, relate, letter, steward
  granted_at timestamptz not null,
  revoked_at timestamptz null
)
```

The verb runner allows a request into a mind's scope when the bearer is that
mind, or holds a live grant with the matching scope (`mayAct`; application code, not RLS).
Only then does it open a transaction confined by RLS to that mind. Letters need no grant:
a letter row visible to both parties is the one built-in cross-mind write. `steward` is a
further scope: a steward may attest to a rewrite (ending cooling early; a retirement and a vow break cool only on the mind's own clock), object (recorded, never blocking) or note a vow; it cannot write identity text or block a change; attesting sets a rewrite's effective time. Identity cores and vows change only by the mind acting as itself; a rewrite or a vow break is a declaration
that takes effect after a cooling period during which the mind may withdraw it.

### Result contract

Every verb returns one of:

```
{ ok: true,  receipt: { event_id, projection?: {...}, warnings?: [] } }
{ ok: false, error: { code, message, field? } }
```

Codes: `invalid_input`, `unauthorized`, `not_found`, `forbidden`, `conflict`, `storage`.
HTTP maps these to 400, 401, 404, 403, 409, 500. MCP returns them in the tool
result with `isError` set. No `_error`, no `stored:false`, no success-shaped
failures.

## Verb surface

| Region | Verbs |
| --- | --- |
| Wake | `mind_orient` (depth: orientation, quick, full) |
| Remember | `mind_observe`, `mind_write`, `mind_search`, `mind_surface`, `mind_notice` |
| Hold | `mind_sit`, `mind_resolve`, `mind_loop`, `mind_thread`, `mind_task` |
| Self | `mind_identity` (read, read_section, affirm, propose, retire, withdraw, settle, attest, object), `mind_vow` (make, list, recall, break, withdraw_break, note), `mind_anchor`, `mind_desire`, `mind_rethink` |
| Bond | `mind_relate`, `mind_letter`, `mind_link` |
| State | `mind_state`, `mind_drive`, `mind_weather`, `mind_context`, `mind_handoff`, `mind_attend` (list, pin, release) |
| Ops | `mind_health` |

Deferred to their own design pass: `mind_dream`, `mind_unconscious`,
`mind_maintain`. The daemon is implemented: deterministic passes over the ledger
and the clock (no model calls), each change recorded as a ledger event (`daemon.*`, or `identity.settled` / `identity.retired` / `vow.break.settled` written as the mind). There are twelve passes, all deterministic, including `identity.settle`, `notice.expire` and `notice.repair`. The optional model-backed extractor passes (`notice.extract`, `notice.train`) are listed separately: they run only for a mind whose extractor the operator has enabled, once a day.

### Noticing

`mind_patterns` became the extractor (CONTRACTS, "Noticing"): a scheduled, optional, off-by-default,
model-backed pass that proposes links, patterns and distillations from a mind's recent ledger. It is
proposal-only by construction. A proposal becomes memory only when the mind accepts it, and the
memory it becomes is authored by the mind with provenance to its sources, which stay untouched.
The operator can enable, schedule, pause or disable it and choose between two stages, scoring
silently or presenting ranked proposals; no stage writes memory, and the schema admits no third.
Stages 1 and 2 are built: storage, the `mind_notice` verb, the database guards, expiry, portability, and the
passes that generate candidates, rerank and score them, and refit the scorer from the mind's own decisions.

The scorer is a fixed reranker plus an interpretable per-mind logistic model trained on that mind's
own accepts, rejects and expiries, with a documented prior until there is enough feedback. No
neural model: complexity is earned from measured data, not assumed. The machine may become better
at noticing. It does not inherit the right to remember on the mind's behalf.

Belief repair (CONTRACTS, "Belief repair") reuses this machinery for one more question. When a node is superseded or retired, the nodes that depended on it are left alone; a deterministic pass, `notice.repair`, proposes that the mind look at each one, and the mind answers keep, rethink or retire through the same `mind_notice accept`. It needs no model, so it runs with the extractor off, and it reports a fact about the graph rather than a judgement, so it does not go through the shadow trial. Every invalidation writes its repair work in the same transaction, so repair is eventually complete whatever the commit timing. It inherits every rule above: it only proposes, the database lets only the mind's own verb call decide, and identity and vow nodes can be kept but are rewritten or retired only through `mind_identity`, with cooling.

### Attention

`mind_attend` answers "what is this mind carrying right now" with arithmetic, not a model (CONTRACTS, "Attention"): the mind's own open loops, threads, tasks, desires, cooling declarations, waiting proposals and held charges, plus anything it pinned, each weighted 0 to 1 from how recent it is, how charged, what kind of thing it is and whether it is pinned. Pins are the one thing stored (`attention_pins`); only the mind, in a verb call, can pin or release, the database checks that, and a pin never changes the thing it names. `mind_orient` shows the top seven, and the extractor looks first at what is pinned or under the heaviest items.

## Stack

- TypeScript, Node 22, ES modules. `pg`, `zod`, `@modelcontextprotocol/sdk`.
- Plain SQL migrations under `migrations/`, applied by a small runner with an
  advisory lock, per-file transactions, checksums and a `schema_migrations`
  ledger. Fresh databases only; external data comes in through adapters.
- Embeddings behind one interface. Default: local `BAAI/bge-small-en-v1.5`,
  384 dimensions, a common size, so imported vectors stay comparable. Swappable by environment variable.
- `vitest` for unit tests. Every verb gets a contract test: valid input yields
  a receipt and a projection change, invalid input yields a typed error, and a
  call with another mind's id yields `forbidden`.
- Runs as one process under PM2 or Docker. No sidecars required.

## First commit

1. This document.
2. `package.json`, `tsconfig.json`, `.gitignore`, vitest config.
3. `migrations/0001_core.sql`: events, nodes, edges, schema_migrations, row
   level security policies, pgvector extension.
4. `src/db/migrate.ts`: the runner.
5. `src/result.ts`: the result contract and error codes.
6. `src/verbs/mind_health.ts` and `src/verbs/mind_state.ts` end to end
   (schema, ledger write, projection, test), as the pattern every other verb
   copies.
7. `src/server.ts`: MCP stdio plus HTTP, bearer auth, `mind_id` enforcement.
