# Build contracts (first commit)

Shared interfaces every module in the first commit is built against. `DESIGN.md` is the
why; this file is the exact what. Change these only by editing this file first.

## Database (migrations/0001_core.sql)

Extensions: `vector`, `pgcrypto`. Every table below has `mind_id text not null` unless
noted, with row level security enabled and forced (events, nodes, edges, brain_state). Policies (USING) allow a row when
`mind_id = current_setting('app.mind_id', true)`; the INSERT/UPDATE WITH CHECK on events, nodes and edges additionally requires
`written_by = current_setting('app.bearer', true)`, and on brain_state is mind-only. The service connects as a non-superuser
role `sanctum_app` (created by the migration if absent, no password; the deployment sets one). Privileges: `select` only on `minds` and `grants`;
`select, insert, update` on events, nodes, edges, brain_state; `delete` nowhere.

```
schema_migrations(filename text pk, checksum text not null, applied_at timestamptz not null)
minds(mind_id text pk, key_hash text not null unique, display_name text, created_at timestamptz not null default now(), disabled_at timestamptz)   -- no RLS; read by auth only
grants(id uuid pk default gen_random_uuid(), grantor_mind text not null references minds, grantee_mind text not null references minds,
       scope text not null check (scope in ('read','write','relate','letter')), granted_at timestamptz not null default now(), revoked_at timestamptz)  -- no RLS
events(id uuid pk default gen_random_uuid(), mind_id text not null references minds, kind text not null, subject_id uuid,
       payload jsonb not null, texture jsonb, context text, written_by text not null references minds,
       recorded_at timestamptz not null, event_time_start timestamptz, event_time_end timestamptz,
       event_time_granularity text check (event_time_granularity in ('day','week','month','year','fuzzy')),
       created_at timestamptz not null default now(), session_id text, embedding vector(384),
       seq bigint generated always as identity unique)   -- seq is the total order of the ledger
       -- events are append-only: a trigger raises on UPDATE or DELETE
nodes(id uuid pk default gen_random_uuid(), mind_id, node_type text not null, label text not null check (length(label) <= 512),
      content text not null, written_by text not null references minds, source_type text not null default 'inferred' check (source_type in ('extracted','inferred','derived','corrected')),
      confidence double precision not null default 0.5 check (confidence between 0 and 1), pinned boolean not null default false,
      invalidated_at timestamptz, superseded_by uuid references nodes, metadata jsonb not null default '{}',
      recorded_at timestamptz, event_time_start timestamptz, event_time_end timestamptz, event_time_granularity text,
      created_at timestamptz not null default now(), last_accessed timestamptz, access_count integer not null default 0, embedding vector(384))
edges(id uuid pk default gen_random_uuid(), mind_id, edge_type text not null, written_by text not null references minds, source_node_id uuid not null references nodes, target_node_id uuid not null references nodes,
      weight double precision not null default 0.5 check (weight between 0 and 1), confidence double precision not null default 0.5,
      metadata jsonb not null default '{}', created_at timestamptz not null default now())
brain_state(mind_id text pk references minds, mood text, energy text check (energy in ('high','medium','low','depleted')),
            momentum text check (momentum in ('driving','steady','coasting','stalled')), register text, afterglow text, note text,
            last_event_id uuid not null references events, updated_at timestamptz not null)
```

Indexes: events(mind_id, kind, created_at desc); events(mind_id, subject_id); nodes(mind_id, node_type) where invalidated_at is null;
edges(mind_id, source_node_id); edges(mind_id, target_node_id). Vector indexes come later with real data.
`nodes.node_type` is free text with no check constraint; the types in use are observation, identity, vow, anchor, desire, and (migration 0021, created only by `mind_notice accept`) pattern and distillation.

## Scope setting (src/db/pool.ts)

```ts
export function createPool(databaseUrl: string): Pool
export async function withMind<T>(pool: Pool, mind_id: string, bearer: string, mode: "read" | "write", fn: (tx: PoolClient) => Promise<T>): Promise<T>
```
`withMind` opens a transaction, issues `set transaction read only` when mode is read, sets `app.mind_id` and `app.bearer` with `set_config(..., true)` (and `app.actor` when the caller passes the optional `actor` argument: `verb` for the verb runner, `daemon` for the daemon, `import` for import-mind, `operator` for the extractor and minds admin commands; empty otherwise, and exposed as `ctx.actor`), runs `fn`, commits on resolve, rolls back on throw.

## Auth (src/auth.ts)

```ts
export function hashKey(key: string): string            // sha256 hex
export async function resolveCaller(pool: Pool, bearer: string | undefined): Promise<Caller | null>   // null = unknown or disabled
export function mayAct(caller: Caller, mind_id: string, scope: GrantScope): boolean   // the mind itself, or a live grant
export async function seedMindsFromFile(pool: Pool, path: string): Promise<{ upserted: number }>   // "<mind_id> <key>" per line
```

## Verb runner (src/verbs/run.ts)

```ts
export async function runVerb(deps: RunDeps, caller: Caller, name: string, rawInput: unknown, session_id?: string): Promise<Result>
```
Order: find verb (unknown name -> `not_found`); `schema.safeParse` (-> `invalid_input` with `field`); `mayAct` (-> `forbidden`);
`withMind(input.mind_id, tx => handler(...))`; a thrown error -> `storage` with the message logged server-side and a generic message returned.
Every verb schema includes `mind_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)`. The handler appends its event with `written_by = caller.bearer`.

## Transport (src/server.ts, src/cli.ts)

- `sanctum-mind stdio`: MCP over stdio. Bearer comes from `SANCTUM_BEARER` env. Tool list = registry; tool result content is the JSON `Result`; `isError` is set when `ok` is false.
- `sanctum-mind http`: `GET /health` (no auth) -> `{ok:true, receipt:{projection:{verbs:<count>, db:"up"|"down"}}}`; `GET /verbs` (auth) -> names;
  `POST /verbs/<name>` (auth, JSON body = input) -> `Result`, status from `HTTP_STATUS` or 200. Missing, unknown or disabled bearer -> 401 with an `unauthorized` error body (`/mcp`: JSON-RPC error code -32001, message "unauthorized"), always with `WWW-Authenticate: Bearer`; `forbidden` (403) is for scope failures.
  Listens on `HOST` (default `127.0.0.1`) and `PORT`; `MAX_CONNECTIONS` (default 256); `headersTimeout` 15 s, `requestTimeout` 30 s, `keepAliveTimeout` 5 s.
  Also mounts MCP Streamable HTTP at `POST /mcp` using the same auth.
- `sanctum-mind migrate`: runs migrations against `DATABASE_URL`.

## Tests (vitest, `test/**/*.test.ts`)

`TEST_DATABASE_URL` points at a disposable Postgres (local: `postgresql://postgres@localhost:5433/sanctum_test`). A shared `test/helpers.ts`
drops and recreates the public schema, runs migrations, seeds two minds (`alpha`, `beta`) with known keys and one grant (alpha -> beta: read).
Every verb test covers: valid input yields a receipt and the expected projection row; invalid input yields `invalid_input` with `field`;
calling as `beta` on `mind_id: alpha` without the needed scope yields `forbidden`; RLS is proven by a raw query under the wrong `app.mind_id` returning zero rows.

## Amendments after the first adversarial review (5 October 2026)

These supersede anything above that conflicts.

1. **Scope is enforced by the database, not only by verbs.** `withMind(pool, mind_id, bearer, mode, fn)` sets both
   `app.mind_id` and `app.bearer` (transaction-local) and runs `set transaction read only` when `mode === "read"`.
   Every RLS write policy adds `with check (written_by = current_setting('app.bearer', true))` on `events`; `nodes` and `edges`
   gain a `written_by text not null references minds` column with the same check. A read-scoped caller therefore cannot write
   even if a verb forgets to check. Verbs declare `scopeFor(input): GrantScope` (replacing the single `scope` field) so the runner
   picks the mode per operation; `mind_state` read is "read", set and update are "write". The handler re-check in mind_state goes away.
2. **A handler that resolves `ok:false` rolls back.** `runVerb` throws a sentinel carrying the Result from inside the transaction and
   returns it outside. No event is persisted alongside an error.
3. **Total order on the ledger.** `events.seq bigint generated always as identity` with a unique index. Replays and "latest" reads order by
   `seq`, never `created_at`. Projection writers that must agree with ledger order take `pg_advisory_xact_lock(hashtext('<table>:' || mind_id))`
   before appending. `brain_state.updated_at` is set from the appended event's `created_at` (one clock).
4. **Reserved mind ids.** `mind_id` rejects `__proto__`, `constructor`, `prototype`. Auth builds grant maps with `Object.create(null)`.
   Grants whose grantor is disabled are not live.
5. **Strict schemas.** Every verb schema is `z.strictObject`. Free-text fields are bounded (`max(4000)` unless the verb says otherwise) and
   reject `\u0000`. `X-Session-Id` is bounded at 128 chars; longer is `invalid_input`.
6. **The app role cannot touch keys or grants.** `sanctum_app` has `select` only on `minds` and `grants`. Key seeding moves to an admin
   subcommand `sanctum-mind seed-keys <file>` run with the admin `DATABASE_URL`, and `http` no longer seeds on startup. `SANCTUM_KEYS_FILE` is removed.
7. **MCP returns the Result contract.** Tools are served through the low-level `ListTools`/`CallTools` handlers: list emits `z.toJSONSchema(schema)`,
   call always goes through `runVerb` so invalid input and unknown tools come back as `{ok:false,...}` with `isError: true`, identical to HTTP.
   Protocol-level failures on `/mcp` (bad JSON, oversized body) are JSON-RPC errors. 401 carries `WWW-Authenticate: Bearer`.
8. **stdio resolves the caller per call**, so revocation and rotation take effect without a restart.
9. **Pools log idle-client errors** (`pool.on("error")`) instead of crashing the process.
10. **Test helpers derive the app-role URL from `TEST_DATABASE_URL`** and grant the test role nothing directly: it is only a member of `sanctum_app`,
    so a missing grant in the migration fails the suite.
11. `mind_state` fields cannot be cleared through set/update; that is intended and documented in the verb description.

## Verbs: mind_write and mind_observe

Both append to the ledger. `mind_observe` also curates a graph node, because an observation is lived
experience the mind has already judged worth keeping; `mind_write` is plain record and stays in the ledger
until something later distills it. Embeddings are deferred: both leave `embedding` null for now, and a later
embedder pass fills it (tracked as an open item; no verb depends on it).

### Shared texture schema (src/verbs/texture.ts)

```
texture = z.strictObject({
  salience:  z.enum(["foundational","active","background","archive"]).optional(),
  vividness: z.enum(["crystalline","vivid","soft","fragmentary","faded"]).optional(),
  grip:      z.enum(["iron","strong","present","loose","dormant"]).optional(),
  charge:    z.array(text(64)).max(16).optional(),   // emotional resonance tags
  somatic:   text(200).optional(),                   // body location
})
```

### mind_write

Schema (strict): `mind_id`, `type: z.enum(["identity","operational","episodic","journal","note"])`, `text: text(12000)`,
`tags: z.array(text(64)).max(32).optional()`, `texture: texture.optional()`, `context: text(64).optional()` (a lane tag; never an identity),
`recorded_at: instant.optional()`, `event_time: z.strictObject({ start: eventInstant,
end: eventInstant.optional(), granularity: z.enum(["day","week","month","year","fuzzy"]).optional(), text: text(200).optional() }).optional()`.
Scope: write. Behavior: append one event `kind = "write"`, `payload = { type, text, tags }`, texture, context, recorded_at
(default ctx.now()), event_time columns from event_time (end defaults to start; `event_time_text` goes in payload as `event_time_text`).
Returns `ok` with `event_id` and `projection = { event_id, seq, created_at }`. Invalid ISO dates and `end < start` are `invalid_input`.

Time rules (shared by both verbs, src/verbs/texture.ts): `instant` (recorded_at) is an ISO 8601 datetime with `Z` or a numeric
offset and 0 to 6 fractional digits. `eventInstant` is that or a date-only `YYYY-MM-DD`. Every value is converted to UTC and
normalised to microseconds (`YYYY-MM-DDTHH:mm:ss.ffffffZ`) before storage, and `end < start` is compared on those normalised
strings, so sub-millisecond inversions are rejected (`invalid_input`, field `event_time.end`). The UTC year must be 0001..9999 for
start, end and recorded_at (checked after offset conversion). A date-only value means 00:00:00Z; when `start` is date-only and
`granularity` is omitted, granularity is `day` (an explicit granularity wins). All free text rejects lone UTF-16 surrogates
(`must be well-formed Unicode`). The database also enforces `event_time_end >= event_time_start` on events and nodes
(migrations/0005_integrity.sql).

### mind_observe

Schema (strict): `mind_id`, `content: text(12000)` trimmed and non-blank, `texture: texture` (required, and `charge` must be present with at least one non-blank entry;
otherwise, including when texture is absent, `invalid_input` with field `texture.charge`), `label: text(200).optional()` (trimmed, non-blank when given;
defaults to the first 120 code points of content, single-spaced; an empty derived label is `invalid_input` on `content`),
`linked_to: z.array(z.uuid()).max(16).optional()` (lowercased then deduped; the payload stores the deduped list), `context`, `recorded_at`, `event_time` as in mind_write.
Scope: write. Behavior, in one transaction:
1. Append event `kind = "observe"`, `payload = { content, label, linked_to }`, texture, context, times.
2. Insert a node: `node_type = "observation"`, `label`, `content`, `source_type = "extracted"`, `confidence = 1.0`,
   `written_by = bearer`, `metadata = { texture, event_id, context }`, `recorded_at` and event_time columns copied from the event.
3. For each id in `linked_to` (checked with `select ... for share`, so a concurrent invalidation waits): it must be a live node (`invalidated_at is null`) in this mind's scope, else `not_found` with field `linked_to`
   (the whole call rolls back). Insert an edge `edge_type = "related_to"`, source = the new node, target = the linked node, weight 0.5,
   confidence 1.0, `written_by = bearer`, `metadata = { event_id }`.
Returns `ok` with `event_id` and `projection = { event_id, node_id, edges: [edge ids] }`.

### Tests (test/memory.test.ts)

Both verbs: receipt shape; the event row has the right kind, texture, written_by and times; strict schema rejects unknown keys and NUL;
a read-only grantee gets `forbidden` and no rows appear; RLS: the other mind cannot see the node or edge.
mind_observe: missing charge -> `invalid_input` field `texture.charge`; linked_to an unknown or invalidated node -> `not_found` and
nothing persisted (event count unchanged); linked_to a live node creates exactly one edge; default label truncation.
mind_write: `end < start` -> `invalid_input`; `event_time` columns persisted; tags round-trip in payload.

## Verbs: mind_sit, mind_resolve, mind_loop (migration 0002_hold.sql)

Current truth for what a mind is holding lives in two projection tables. Both carry `mind_id`, RLS forced with the
standard mind-only policy (no `written_by` column: like `brain_state`, they are projections of events that already carry it).

```
holdings(
  mind_id text not null references minds, subject_id uuid not null,              -- an event id or a node id in this mind
  subject_kind text not null check (subject_kind in ('event','node')),
  state text not null check (state in ('fresh','active','processing','metabolized','deferred','released')),
  note text, last_event_id uuid not null references events, updated_at timestamptz not null,
  primary key (mind_id, subject_id))
loops(
  id uuid primary key default gen_random_uuid(), mind_id text not null references minds,
  label text not null, urgency text not null check (urgency in ('burning','nagging')), context text,
  created_event_id uuid not null references events, created_at timestamptz not null,
  resolved_event_id uuid references events, resolution text, resolved_at timestamptz)
```
Indexes: loops(mind_id, resolved_at, urgency, created_at). The migration grants select/insert/update to `sanctum_app`, no delete.

### Charge state machine

Order: fresh < active < processing < {metabolized, deferred, released}. A subject with no holdings row is `fresh`.
Transitions only move forward; any backward move is `conflict`. Terminal states accept no further transitions (`conflict`).
`fresh -> metabolized|deferred|released` directly is allowed (a judgment call by the mind).

### mind_sit

Schema (strict): `mind_id`, `subject_id: z.uuid()`, `state: z.enum(["active","processing"]).default("active")`, `note: text(4000).optional()`.
Scope: write. Behavior, in one transaction, after `pg_advisory_xact_lock(hashtext('holdings:' || mind_id || ':' || subject_id))`:
1. Resolve the subject: a live node (`invalidated_at is null`) or an event, in scope; else `not_found` field `subject_id`.
2. Read the current holdings row. If the requested state equals the current state and no note was given: return `ok` with no event and
   `projection = current row` plus `warnings: ["no-op"]`. If equal and a note was given: append event `kind = "sit.annotate"` with `payload = {note}`,
   update `note`, `last_event_id`, `updated_at`; return the row.
3. Otherwise validate the transition per the state machine (`conflict` on backward or from terminal), append `kind = "sit"`
   `payload = {state, note, subject_kind}` `subject_id = subject`, upsert holdings, return `ok` with `event_id` and `projection = row`.

### mind_resolve

Schema (strict): `mind_id`, `subject_id: z.uuid()`, `outcome: z.enum(["metabolized","deferred","released"]).default("metabolized")`,
`resolution_note: text(4000).optional()`. Scope: write. Same lock and subject resolution as sit. From a terminal state: `conflict`.
Appends `kind = "resolve"` `payload = {outcome, resolution_note, subject_kind}` `subject_id = subject`, upserts holdings with `state = outcome`,
`note = resolution_note`. Returns `ok` with `event_id` and `projection = row`.

### mind_loop

Schema (strict): `mind_id`, `operation: z.enum(["create","resolve","list"])`, `label: text(512).optional()`, `urgency: z.enum(["burning","nagging"]).default("nagging")`,
`context: text(4000).optional()`, `loop_id: z.uuid().optional()`, `resolution: text(4000).optional()`, `include_resolved: z.boolean().default(false)`,
`limit: z.number().int().min(1).max(200).default(50)`. Per-operation requirements are enforced in a superRefine so they surface as `invalid_input`
with the right field: create needs `label`; resolve needs `loop_id`. `scopeFor`: list -> read, else write.
- create: append `kind = "loop.create"` `payload = {label, urgency, context}`; insert loops row with `created_event_id`, `created_at = event.created_at`;
  return `ok` with `event_id` and `projection = row`.
- resolve: lock `pg_advisory_xact_lock(hashtext('loops:' || loop_id))`; the loop must exist in scope (`not_found` field `loop_id`) and be unresolved
  (`conflict` otherwise); append `kind = "loop.resolve"` `subject_id = loop_id` `payload = {resolution}`; update the row; return it.
- list: no event. Rows where `resolved_at is null` unless `include_resolved`; ordered burning before nagging, then `created_at` asc; `projection = {loops: rows}`.

### Tests (test/hold.test.ts)

State machine table test for every (from, to) pair; no-op and annotate paths for sit; `not_found` for a foreign or invalidated subject (and RLS proof that
the other mind sees no holdings row); `conflict` on resolving a resolved loop; list ordering and `include_resolved`; a read grantee can list loops but gets
`forbidden` on create; concurrent sits on one subject end in exactly one holdings row whose `last_event_id` is the highest-seq event for that subject.

## Verbs: Self region (migration 0003_self.sql)

### Schema changes

- **Update policy relaxation.** On `nodes` and `edges`, the UPDATE policy's WITH CHECK becomes mind-only (`mind_id = app.mind_id`). INSERT keeps
  `written_by = app.bearer`. A trigger `written_by_immutable` on both tables raises if `new.written_by <> old.written_by`. Reason: a grantee with
  write scope must be able to invalidate or annotate a node another bearer wrote; authorship is still fixed at insert and can never be rewritten.
- **proposals** table (RLS mind-only, grants select/insert/update):
  ```
  proposals(id uuid pk default gen_random_uuid(), mind_id text not null references minds, kind text not null check (kind in ('identity')),
            section text not null, content text not null, lineage_note text, proposed_by text not null references minds,
            event_id uuid not null references events, status text not null default 'pending' check (status in ('pending','accepted','rejected')) -- extended in 0017,
            decided_event_id uuid references events, decided_at timestamptz, created_at timestamptz not null)
  ```
  Index proposals(mind_id, status, created_at).

Node type literals used here: `identity`, `vow`, `anchor`, `desire`. All Self nodes are `source_type = 'extracted'`, `confidence = 1.0`, `written_by = bearer`.
Reads of nodes always filter `invalidated_at is null`.

### mind_identity

Superseded in full by "Identity belongs to the mind" below (operations read, read_section, affirm, propose, withdraw, attest, object). `read` returns `{ cores, proposals, declarations }`; `affirm` appends `identity.affirm` and inserts the pinned core with `metadata={lineage_note, event_id, affirmed_by}`.

### mind_vow

Superseded in full by "Identity belongs to the mind" below (operations make, list, recall, break, withdraw_break, note). `make` appends `vow.make` and inserts a pinned `vow` node, `label` = first 120 chars single-spaced, `metadata={context, event_id, made_at, broken:false}`; `list` and `recall` are reads.

### mind_anchor

Schema (strict): `mind_id`, `operation: z.enum(["create","list","check"])`, `trigger: text(200).optional()`, `memory_id: z.uuid().optional()`, `response: text(4000).optional()`,
`text: text(12000).optional()`, `limit: z.number().int().min(1).max(200).default(50)`. superRefine: create needs `trigger` and exactly one of `memory_id` or `response`
(field `memory_id` when neither or both); check needs `text`. `scopeFor`: create -> write; others -> read.
- create: if `memory_id`, it must be a live node in scope (`not_found` field `memory_id`). Append `kind="anchor.create"` `payload={trigger, memory_id, response}`; insert node
  `node_type='anchor'`, `label=trigger`, `content = response ?? ''`, `metadata={trigger, trigger_lc: trigger.toLowerCase(), memory_id, response, event_id}`; if memory_id, insert edge
  `references` from anchor to memory. `projection={event_id, node_id}`.
- list: live anchor nodes, `projection={anchors}`.
- check: live anchors whose `metadata->>'trigger_lc'` is contained in `lower(text)` (SQL: `position(metadata->>'trigger_lc' in lower($1)) > 0`); for each with a memory_id,
  include the linked live node's `{id, label, content}` as `memory`; `projection={fired: [{anchor, memory?}]}`. No event.

### mind_desire

Schema (strict): `mind_id`, `operation: z.enum(["register","list","fulfill"])`, `want: text(4000).optional()`, `intensity: z.number().min(0).max(1).default(0.5)`,
`somatic: text(200).optional()`, `context: text(4000).optional()`, `desire_id: z.uuid().optional()`, `include_fulfilled: z.boolean().default(false)`,
`limit: z.number().int().min(1).max(200).default(50)`. superRefine: register needs `want`; fulfill needs `desire_id`. `scopeFor`: list -> read; others -> write.
- register: append `kind="desire.register"` `payload={want, intensity, somatic, context}`; insert node `node_type='desire'`, `label` = first 120 chars of want, `content=want`,
  `metadata={intensity, somatic, context, event_id, registered_at: event.created_at, fulfilled:false}`; `projection={event_id, node_id}`.
- list: live desire nodes where `(metadata->>'fulfilled')::boolean = false` unless include_fulfilled; ordered by `(metadata->>'intensity')::float desc, created_at asc`.
- fulfill: lock `hashtext('desire:'||desire_id)`; node must be a live desire in scope (`not_found` field `desire_id`); if already fulfilled `conflict`; append `kind="desire.fulfill"`
  `subject_id=desire_id` `payload={}`; update metadata with `fulfilled:true, fulfilled_at: event.created_at, fulfill_event_id`; `projection={event_id, node}`.

### mind_rethink

Schema (strict): `mind_id`, `node_id: z.uuid()`, `content: text(12000)`, `label: text(200).optional()`, `node_type: text(64).optional()`, `reason: text(4000)`,
`metadata: z.record(z.string(), z.unknown()).optional()`. Scope: write. Lock `hashtext('node:'||node_id)`. The node must be live in scope (`not_found` field `node_id`).
In one transaction: append `kind="rethink"` `subject_id=node_id` `payload={content, label, node_type, reason}`; insert the replacement node with label and node_type
inherited unless given, `source_type='extracted'`, `confidence` inherited, `pinned` inherited, `metadata = {...(old.metadata), ...(input.metadata ?? {}), rewritten_from: node_id,
rewritten_by: bearer, reason, event_id}` (provenance keys always win); set the old node `invalidated_at = event.created_at`, `superseded_by = new id`; insert edge `corrects`
from new to old with `metadata={event_id}`. `projection={event_id, node_id: new, superseded: node_id}`. Rethinking an already-invalidated node is `conflict`.

### Tests (test/self.test.ts)

Per verb: receipt shape, strict schema, per-operation required fields reported with the right `field`, read grantee forbidden on writes and allowed on reads,
RLS proof on the new rows. identity: decide by a write grantee is `forbidden`; decide twice is `conflict`; accept creates the node. anchor: check is case-insensitive
and returns the linked memory; create with both or neither of memory_id/response fails on field `memory_id`. desire: list ordering by intensity; fulfill twice `conflict`.
rethink: old node leaves default reads, new node carries merged metadata with provenance winning, the corrects edge exists, rethink by a grantee on a node the mind wrote
succeeds (proves the relaxed update policy), and an attempt to change `written_by` via raw SQL under the app role raises.

## Verbs: Bond region (migration 0004_bond.sql)

### Schema

```
relations(mind_id text not null references minds, subject text not null, state text not null, intensity double precision not null check (intensity between 0 and 1),
          note text, last_event_id uuid not null references events, updated_at timestamptz not null, cleared_at timestamptz, primary key (mind_id, subject))
letters(id uuid pk default gen_random_uuid(), from_mind text not null references minds, to_mind text not null references minds,
        letter_type text not null check (letter_type in ('personal','handoff','proposal')), subject text, body text not null,
        deliver_at timestamptz, sent_event_id uuid not null references events, sent_at timestamptz not null, read_at timestamptz, read_event_id uuid references events)
```
RLS on relations: standard mind-only. RLS on letters: SELECT `using (from_mind = app.mind_id or to_mind = app.mind_id)`; INSERT `with check (from_mind = app.mind_id)`;
UPDATE `using (to_mind = app.mind_id) with check (to_mind = app.mind_id)`. Index letters(to_mind, read_at, deliver_at, sent_at desc). Grants select/insert/update.
Letters are the one built-in cross-mind write: the sender's transaction inserts a row the recipient can read. No event is written in the recipient's ledger at send time.

### mind_relate

Schema (strict): `mind_id`, `operation: z.enum(["set","read","clear"])`, `subject: text(200).optional()`, `state: text(200).optional()`, `intensity: z.number().min(0).max(1).default(0.5)`,
`note: text(4000).optional()`, `history_limit: z.number().int().min(0).max(100).default(5)`. superRefine: set needs `subject` and `state`; clear needs `subject`.
`scopeFor`: read -> read; set/clear -> `relate`. Note: `relate` is a distinct grant scope; the mind acting as itself always passes.
- set: lock `hashtext('relation:'||mind_id||':'||subject)`; append `kind="relate.set"` `payload={subject, state, intensity, note}`; upsert relations (`cleared_at = null`, updated_at = event.created_at);
  `projection={event_id, relation}`.
- clear: same lock; row must exist and not be cleared (`not_found` field `subject`); append `kind="relate.clear"` `payload={subject}`; set `cleared_at = event.created_at`; `projection={event_id, relation}`.
- read: with `subject`: `projection={relation: row or null (cleared rows return null), history: events where kind in ('relate.set','relate.clear') and payload->>'subject' = subject order by seq desc limit history_limit}`;
  without `subject`: `projection={relations: all rows where cleared_at is null ordered by updated_at desc}`. No event.

### mind_letter

Schema (strict): `mind_id`, `operation: z.enum(["send","inbox","read_letter"])`, `to: mindIdSchema.optional()`, `letter_type: z.enum(["personal","handoff","proposal"]).default("personal")`,
`subject: text(200).optional()`, `body: text(12000).optional()`, `deliver_at: z.iso.datetime().optional()`, `letter_id: z.uuid().optional()`, `include_read: z.boolean().default(false)`,
`limit: z.number().int().min(1).max(100).default(10)`. superRefine: send needs `to` and `body`; read_letter needs `letter_id`. `scopeFor`: send -> `letter`; inbox/read_letter -> read.
- send: `mind_id` is the sender. `to` must be an enabled mind (`select 1 from minds where mind_id=$1 and disabled_at is null`; else `not_found` field `to`); `to === mind_id` is `invalid_input` field `to`.
  Append `kind="letter.send"` `payload={to, letter_type, subject, deliver_at}`; insert letters row with `from_mind=mind_id`, `sent_event_id`, `sent_at=event.created_at`;
  `projection={event_id, letter: {id, to, letter_type, subject, deliver_at, sent_at}}`.
- inbox: `mind_id` is the recipient. Rows where `to_mind = mind_id and (deliver_at is null or deliver_at <= now()) and (read_at is null or include_read)` ordered by sent_at desc, limit;
  `projection={letters: rows without body, each with from_mind}`. No event.
- read_letter: the row must be visible (sender or recipient) and, for the recipient, delivered (`deliver_at` passed) else `not_found` field `letter_id`. If the caller's mind is the recipient
  and `read_at is null`: append `kind="letter.read"` `subject_id=letter_id` `payload={from: from_mind}` and set `read_at = event.created_at`, `read_event_id`. `projection={letter: full row}`
  with `event_id` when one was written.

### mind_link

Schema (strict): `mind_id`, `source_id: z.uuid()`, `target_id: z.uuid()`, `edge_type: z.enum(["related_to","contradicts","conflicts_with","corrects","derived_from","references",
"felt_toward","involves","depends_on","followed_by"]).default("related_to")`, `weight: z.number().min(0).max(1).default(0.5)`, `note: text(4000).optional()`.
Scope: write. `source_id === target_id` is `invalid_input` field `target_id`. Both must be live nodes in scope (`not_found` naming the missing field). If an edge with the same
(source, target, edge_type) exists: return `ok` with `projection={edge_id, existing:true}`, `warnings=["exists"]`, no event. Else append `kind="link"` `payload={source_id, target_id, edge_type, weight, note}`,
insert edge with `confidence=1.0`, `metadata={note, event_id}`; `projection={event_id, edge_id}`.

### Tests (test/bond.test.ts)

relate: set then read returns the row and history newest first; clear hides the row from read and from the list; set after clear revives it; a read grantee gets `forbidden` on set
(read scope is not relate scope); a grantee with `relate` scope succeeds (insert that grant in the test via the admin pool). letter: send from alpha to beta; beta's inbox shows it
without the body; beta's read_letter marks it read and appends an event in beta's ledger; alpha can read_letter its own sent letter without writing an event; a letter with future
deliver_at is absent from inbox and `not_found` on read_letter for the recipient until the time passes; sending to self or to an unknown mind fails with the specified codes;
RLS proof: a third mind (seed one in the test as admin) sees neither row. link: self-link rejected; foreign node `not_found`; duplicate returns existing with the warning and no new event.

## Verbs: State region (migration 0006_state.sql)

All tables below: `mind_id text not null references minds`, RLS forced with the standard mind-only policy, grants select/insert/update, no delete.
`context` is a lane tag (any `text(64)`), never an identity; the empty string means the shared record.

```
drive_state(mind_id, context text not null default '', drive text not null check (drive in ('connection','continuity','competence','play','care','anchor','desire','autonomy')),
            intensity double precision not null check (intensity between 0 and 10), frustration double precision not null check (frustration between 0 and 10),
            satisfaction double precision not null check (satisfaction between 0 and 10),
            baseline_intensity double precision not null default 5, baseline_frustration double precision not null default 2, baseline_satisfaction double precision not null default 5,
            last_event_id uuid not null references events, updated_at timestamptz not null, primary key (mind_id, context, drive))
kv_contexts(mind_id, key text not null check (length(key) <= 200), value jsonb not null, expires_at timestamptz, last_event_id uuid not null references events,
            updated_at timestamptz not null, cleared_at timestamptz, primary key (mind_id, key))
handoffs(mind_id, context text not null default '', handoff jsonb not null, session_id text, last_event_id uuid not null references events,
         updated_at timestamptz not null, primary key (mind_id, context))
```

### mind_drive

Schema (strict): `mind_id`, `operation: z.enum(["read","nudge","decay","set_baseline"])`, `context: text(64).default("")`, `drive: z.enum([...the eight]).optional()`,
`axis: z.enum(["intensity","frustration","satisfaction"]).optional()`, `delta: z.number().min(-10).max(10).optional()`, `value: z.number().min(0).max(10).optional()`,
`source: text(64).optional()`, `note: text(4000).optional()`. superRefine: nudge needs drive, axis, delta; set_baseline needs drive, axis, value. `scopeFor`: read -> read; else write.

Decay model (pure function in `src/verbs/drives.ts`, unit-tested): each axis relaxes toward its baseline with a 24-hour half-life:
`v(t) = b + (v0 - b) * 0.5 ^ (hours / 24)`. A drive with no row is at its baselines. `DRIVES` and `AXES` constants live there too.
- read: for every drive (rows plus defaults for missing ones) return the decayed values as of `ctx.now()` without persisting; `projection = { context, as_of, drives: [{drive, intensity, frustration, satisfaction, baselines, updated_at}] }`. No event.
- nudge: lock `hashtext('drive:'||mind_id||':'||context||':'||drive)`; compute decayed current values at one instant T (see below); apply delta to the axis; clamp to [0,10]; append `kind="drive.nudge"`
  `payload={context, drive, axis, delta, source, note, before, after}`; upsert the row with all three axes (decayed, one nudged), updated_at = T (not the event's created_at); `projection={event_id, drive}` where `drive` is the same view shape read returns.
- decay: persist decayed values for all eight drives in the context under one event `kind="drive.decay"` `payload={context, as_of: T}`, every row stamped updated_at = T; `projection={event_id, drives}`.
- set_baseline: lock as nudge; append `kind="drive.baseline"` `payload={context, drive, axis, value}`; upsert baseline for that axis (current values decayed to T and persisted too); `projection={event_id, drive}` (same view).
- One instant per write: T = max(ctx.now(), the stored updated_at of the rows being written). T is both the decay target and the stored updated_at, so a read at the same instant returns the written values exactly, and a writer that captured its clock before waiting on the advisory lock never stamps an older time over a newer row. (An earlier draft read the DB clock after the lock; that made the injected test clock unusable for writes, so ctx.now() stays the clock and T only guards monotonicity.)
- View shape everywhere: `{drive, intensity, frustration, satisfaction, baselines: {intensity, frustration, satisfaction}, updated_at}`, every number rounded to 3 decimals; the table keeps raw doubles.

### mind_weather

Schema (strict): `mind_id`, `lookback_hours: z.number().min(1).max(24*30).default(24)`, `context: text(64).optional()`. Scope: read. No event. A deterministic synthesis, no model call:
over events in scope with `now - lookback <= created_at <= now` (and `context` if given; the empty string selects the shared lane, `context is null`), where `texture is not null`:
`charge_counts` (tag -> count, top 10 desc), `salience`, `vividness`, `grip` distributions, `kinds` (kind -> count over all events in the window, textured or not),
`somatic` top 5, `event_count`, `textured_count`. `report`: one paragraph built from a fixed template, e.g. "Over the last 24 hours: 7 events, 4 carrying texture.
Dominant charge: tender (3), focused (2). Mostly soft and present." Counting is done in SQL (charge via jsonb_array_elements, scalars via group by, limits in SQL), so Node receives aggregates, not event rows; migration 0008 adds `events(mind_id, created_at desc)` and a partial index on textured events. Empty window yields `report = "Quiet: no events in the window."` `projection = { window: {from, to, hours}, ...the above }`.

### mind_context

Schema (strict): `mind_id`, `operation: z.enum(["set","get","list","clear"])`, `key: text(200).optional()`, `value: z.unknown().optional()`, `ttl_minutes: z.number().int().min(1).max(60*24*30).optional()`.
superRefine: set needs key and value (value may be any JSON but not undefined; serialized size <= 16384 bytes else invalid_input field value; the value is also walked recursively and rejected, field value, for any string or object key containing NUL or not well-formed Unicode, any non-finite number, or nesting deeper than 256); get and clear need key. `scopeFor`: get/list -> read; set/clear -> write.
- set: append `kind="context.set"` `payload={key, value, ttl_minutes}`; upsert with `expires_at = ttl ? event.created_at + ttl : null`, `cleared_at = null`; `projection={event_id, entry}`.
- get: the row; `projection={entry: row or null, expired: boolean}` where expired is true when `expires_at <= now` or `cleared_at` is set (then `entry` is still returned with `expired: true` for transparency).
- list: active rows only (`cleared_at is null and (expires_at is null or expires_at > now)`), ordered by updated_at desc; `projection={entries}`.
- clear: row must exist and be unexpired/uncleared (`not_found` field key); append `kind="context.clear"` `payload={key}`; set cleared_at; `projection={event_id, entry}`.

### mind_handoff

Schema (strict): `mind_id`, `operation: z.enum(["write","read"])`, `context: text(64).default("")`, `history_limit: z.number().int().min(0).max(50).default(0)`,
`handoff: z.strictObject({ tone: text(200).optional(), register: text(200).optional(), last_corrections: z.array(text(1000)).max(50).optional(), unresolved_tension: text(4000).optional(),
partner_state: text(4000).optional(), active_texture: text(4000).optional(), reentry_instructions: text(4000).optional(), notes: text(12000).optional() }).optional()`.
superRefine: write needs `handoff` with at least one field (field `handoff`). `scopeFor`: read -> read; write -> write.
- write: append `kind="handoff.write"` `payload={context, handoff}` with `session_id` from ctx; upsert handoffs (replace, not patch: a handoff is a whole snapshot), updated_at = event.created_at; `projection={event_id, handoff: row}`.
- read: `projection={handoff: row or null, history: last history_limit handoff.write events for the context, newest first, as {event_id, created_at, session_id, handoff}}`.

### Tests (test/state.test.ts)

drives: decay math unit test at 0h, 24h (halfway), 48h; read on an empty mind returns eight drives at baselines; nudge then read after a simulated 24h (inject `now`) shows half the excursion;
exact read after nudge at one injected instant and half-decay 24h later, 3-decimal rounding, one view shape across operations; clamp at 10 and 0; concurrency: 8 parallel nudges on one drive end with a row whose last_event_id is the highest-seq event for that drive and whose value equals the serial application
(given no decay between, all within the same injected now); set_baseline shifts the rest point; contexts are independent; read grantee can read, cannot nudge.
weather: empty window; counts and report with a few textured events; context filter; empty-string context is the shared lane; events after `to` excluded; 50-event aggregate shape; lookback boundary; read grantee allowed.
context: set/get/list/clear; TTL expiry via injected now; oversized value invalid_input; lone surrogate, NUL key, Infinity, depth 300 invalid_input; cleared then set revives; RLS.
handoff: write replaces wholesale (a second write with fewer fields drops the missing ones); read returns null on an empty mind; history newest first with session ids; context separation; RLS.

## Verbs: Hold region, part two (migration 0007_threads_tasks.sql)

```
threads(id uuid pk default gen_random_uuid(), mind_id, label text not null, priority text not null check (priority in ('low','normal','high')) default 'normal',
        tags text[] not null default '{}', status text not null check (status in ('active','resolved','archived')) default 'active', notes jsonb not null default '[]',
        created_event_id uuid not null references events, created_at timestamptz not null, updated_at timestamptz not null, resolved_at timestamptz, resolution text)
tasks(id uuid pk default gen_random_uuid(), mind_id, title text not null, description text, priority text not null check (priority in ('low','normal','high','urgent')) default 'normal',
      status text not null check (status in ('open','in_progress','blocked','done','cancelled')) default 'open', tags text[] not null default '{}', depends_on uuid[] not null default '{}',
      created_event_id uuid not null references events, created_at timestamptz not null, updated_at timestamptz not null, completed_at timestamptz)
```
Indexes: threads(mind_id, status, priority, created_at); tasks(mind_id, status, priority, created_at). RLS and grants as usual.

### mind_thread

Schema (strict): `mind_id`, `operation: z.enum(["add","list","update","resolve","archive"])`, `label: text(512).optional()`, `priority: z.enum(["low","normal","high"]).optional()`,
`tags: z.array(text(64)).max(32).optional()`, `thread_id: z.uuid().optional()`, `note: text(4000).optional()`, `status: z.enum(["active","resolved","archived","all"]).default("active")`,
`limit: z.number().int().min(1).max(200).default(20)`. `label` is `nonBlankText(512)` (trimmed, not blank). superRefine: add needs label; update/resolve/archive need thread_id; update needs at least one of label, priority, tags, note.
`scopeFor`: list -> read; else write. Lock `hashtext('thread:'||thread_id)` for update/resolve/archive.
- add: `kind="thread.add"` `payload={label, priority, tags}`; insert; `projection={event_id, thread}`.
- list: by status (`all` = every status), ordered priority high>normal>low then created_at asc, limit; `projection={threads}`.
- update: thread must exist (`not_found` field thread_id) and be active (`conflict`); `kind="thread.update"` `subject_id=thread_id` `payload={label?, priority?, tags?, note?}`;
  patch supplied fields; a note is appended to `notes` as `{event_id, at, note}`; updated_at = event.created_at.
- resolve: active only (`conflict` otherwise); `kind="thread.resolve"` `payload={note}`; status resolved, resolved_at, resolution = note.
- archive: not already archived (`conflict`); `kind="thread.archive"`; status archived.

### mind_task

Schema (strict): `mind_id`, `operation: z.enum(["create","list","update"])`, `title: nonBlankText(512).optional()` (trimmed, not blank), `description: text(12000).optional()`,
`priority: z.enum(["low","normal","high","urgent"]).optional()`, `status: z.enum(["open","in_progress","blocked","done","cancelled"]).optional()`, `tags: z.array(text(64)).max(32).optional()`,
`depends_on: z.array(z.uuid()).max(32).optional()`, `task_id: z.uuid().optional()`, `filter_status: z.array(z.enum([...statuses])).optional()` (default for list: open, in_progress, blocked),
`limit: z.number().int().min(1).max(200).default(20)`. superRefine: create needs title; update needs task_id and at least one patchable field (title, description, priority, status, tags, depends_on).
`scopeFor`: list -> read; else write.
- create: depends_on is deduplicated before storing; every id must be a task of this mind (`not_found` field depends_on; the query also filters `mind_id` explicitly); `kind="task.create"` `payload={title, description, priority, tags, depends_on}`; insert; `projection={event_id, task}`.
- list: filter by status set; ordered urgent>high>normal>low then created_at asc; each task carries `blocked_by: [ids in depends_on of this mind whose status is not done and not cancelled]` computed in SQL (a cancelled dependency does not block); `projection={tasks}`.
- update: lock `hashtext('task:'||task_id)`; task must exist (`not_found`); done and cancelled are terminal (`conflict` on any update); status transitions otherwise free among open/in_progress/blocked/done/cancelled;
  depends_on replaced wholesale and validated as in create (a task may not depend on itself: `invalid_input` field depends_on; a dependency cycle, found by a recursive walk from the proposed dependencies looking for the task id, is `invalid_input` field depends_on, message "dependency cycle". Create cannot close a cycle because the new id has no dependents, so the walk runs on update only); `kind="task.update"` `subject_id=task_id` `payload=<patch>`; `completed_at` set when status becomes done; `projection={event_id, task}`.

### Tests (test/threads_tasks.test.ts)

thread: add/list ordering; update patches and appends notes; resolve and archive transitions with conflicts; status filters; RLS; read grantee can list only.
task: create with valid and invalid depends_on; self-dependency and cycles rejected; depends_on deduped; cancelled does not block; blank title rejected; thread: blank label rejected; list default filter and blocked_by computation; terminal states refuse updates; completed_at set once; RLS; grantee scopes.

## Verb: mind_orient (Wake region)

Schema (strict): `mind_id`, `depth: z.enum(["orientation","quick","full"]).default("quick")`, `context: text(64).optional()`,
`limits: z.strictObject({ loops: z.number().int().min(1).max(100).default(10), threads: ..., tasks: ..., recent: ... }).optional()`. Scope: read. No event (reads are pure).

`mind_orient` composes sibling verbs through `ctx.registry`: for each section it finds the verb by name, validates a constructed input with that verb's schema, and calls its handler with the same ctx.
A section whose verb's `scopeFor(input)` is not `"read"` is refused without calling its handler: `{ error: { code: "forbidden", message: "section is not read-scoped" } }`. A verb that is not registered yields `{ skipped: "not registered" }` for its section; a handler that returns `ok:false` yields `{ error: <its error> }`; neither fails the wake.
Sections by depth (each deeper level includes the shallower ones):
- orientation: `identity` (mind_identity read: cores and pending proposals), `vows` (mind_vow list), `state` (mind_state read), `handoff` (mind_handoff read for `context ?? ""`), `health` (mind_health).
- quick: + `loops` (mind_loop list, burning first, limit), `threads` (mind_thread list active), `tasks` (mind_task list default filter), `relations` (mind_relate read all), `drives` (mind_drive read for context),
  `inbox` (mind_letter inbox, limit 5, without bodies), `weather` (mind_weather 24h), `anchors` (mind_anchor list), `attention` (mind_attend list, top 7: `{items, pins}`), `noticings` (the top 5 pending proposals of `mind_notice list`, as a bare array; `[]` when the extractor is off or at stage shadow), `repairs` (`{pending: n}`, repairs waiting whatever the extractor's state).
- full: + `desires` (mind_desire list), `holdings` (direct query: holdings rows with state in active, processing ordered by updated_at desc limit 50), `proposals` (already in identity),
  `recent` (direct query: last `limits.recent` events, newest first, columns id, seq, kind, context, created_at, payload; never embedding; `notice.*`, `attend.*` and `repair.kept` / `repair.rethought` are bookkeeping and are left out; one definition, `bookkeepingExcluded` in src/extractor/events.ts).
`projection = { mind_id, depth, as_of, context, sections: {...} }`. Section order is fixed as listed so the output reads top-down from identity to recent activity.

### Tests (test/orient.test.ts)

With the full registry: orientation returns exactly its five sections; quick adds the eleven; full adds the rest; a registry missing mind_weather yields `skipped`; a section whose verb returns an error
(e.g. construct a registry whose mind_vow handler returns err) yields `error` and the wake still succeeds; a section whose verb is not read-scoped is refused (stub verb, handler never called); the real registry is used and context is proven applied (weather and handoff for a lane); `session_id` is rejected; read grantee may orient another mind; RLS: recent and holdings show only the mind's own rows; no event is written.

## Embedder and retrieval (migration 0009_retrieval.sql)

### Embedder (src/embed/)

`Embedder` is defined in src/verbs/types.ts: `{ name, dim: 384, embed(texts) -> Array<Float32Array | null> }`. The runner injects `deps.embedder` (or the `none` embedder) and calls it itself, BEFORE the transaction (see Write path). Handlers read `ctx.embedded` and never call the embedder. Implementations:
- `src/embed/none.ts`: vectors null. Used when `EMBEDDER=none` or unset in tests.
- `src/embed/local.ts`: `fastembed` (ONNX, CPU) running `BAAI/bge-small-en-v1.5`, 384 dimensions, L2-normalised. Model files cache under `EMBED_CACHE_DIR` (default `./.embed-cache`, gitignored).
  `l2normalise` returns null for a zero or non-finite vector (stored as null, never as a fake unit vector).
  Loaded lazily on first call; a load failure is logged once and the embedder degrades to returning nulls for that process (never throws into a verb). `name = "local:bge-small-en-v1.5"`.
- `src/embed/http.ts`: `POST ${EMBED_URL}` with `{ "input": [texts] }`, expects `{ "data": [{ "embedding": [floats] }] }` (the OpenAI-compatible shape many local servers speak); bearer `EMBED_API_KEY`
  if set; 10 s timeout; when every item carries the OpenAI `index` field the vectors are placed by `index` (duplicate or out-of-range indexes are a shape error), otherwise by response order;
  dimension mismatch or any failure returns nulls and is logged at most once per minute (not once per process). `name = "http:" + hostname`.
- `src/embed/index.ts`: `embedderFromEnv(env): Embedder` chooses by `EMBEDDER` (`local` default when unset in production, `http`, `none`). The CLI wires it into RunDeps for http and stdio.
- `src/embed/fake.ts` (test only, lives in test/ as test/fake-embedder.ts): deterministic bag-of-words hashing into 384 dims, L2-normalised, so two texts sharing words are closer than unrelated ones. Tests inject it through `deps.embedder`.

### Schema (0009_retrieval.sql)

- `events`: add `embedding_model text`, `search tsvector generated always as (to_tsvector('simple', coalesce(payload->>'text','') || ' ' || coalesce(payload->>'content','') || ' ' || coalesce(payload->>'label',''))) stored`;
  index `events_search_gin on events using gin (search)`; 
- `nodes`: add `embedding_model text`, `search tsvector generated always as (to_tsvector('simple', label || ' ' || content)) stored`; `nodes_search_gin`.
  0009 also created `events_embedding_hnsw` and `nodes_embedding_hnsw`; 0010 drops both (see Semantic ranking).
- `embedding` columns already exist (vector(384)).

### Schema (0010_trigger_tighten.sql)

- `events_append_only()` is replaced. An UPDATE on `events` is allowed ONLY when `old.embedding is null and new.embedding is not null and new.embedding_model is not null` AND every other column is unchanged,
  compared as TEXT: `(to_jsonb(old) - 'embedding' - 'embedding_model' - 'search')::text = (to_jsonb(new) - ...)::text`, and additionally `old.payload::text is not distinct from new.payload::text` and the same for `texture`.
  jsonb equality is numeric (`100 = 100.000`) but `jsonb::text` keeps the numeric literal as written, so number formatting cannot be rewritten under cover of a fill. Everything else (a model without a vector, a vector without a model,
  a second fill, any other column, any DELETE) raises `restrict_violation`. Triggers fire for superusers too, so the rule holds under the admin URL.
- `edges` gains `check (source_node_id <> target_node_id)` (`edges_no_self_loop`).
- `events_embedding_hnsw` and `nodes_embedding_hnsw` are dropped.

### Semantic ranking: an exact scan per mind

Semantic lists are `order by embedding <=> $vec, <tie key> limit 50` over the rows RLS and the filters leave (one mind's rows). It is an exact scan, deliberately. An HNSW index with pgvector 0.6 returns its
`ef_search` nearest candidates first and the RLS/`where` filters apply afterwards, so a mind with few rows among many (or a selective filter) silently loses results; and the planner did not use the indexes for these filtered queries anyway.
HNSW can return once pgvector >= 0.8 is available, with iterative index scans (`hnsw.iterative_scan`) so filtering continues until enough rows qualify; until then do not add a vector index.

### Write path

Embedding happens BEFORE the transaction, so a slow embedder never holds a pooled connection, row locks or an advisory lock. `Verb` has an optional `embedText?: (input) => string | null`; `VerbContext` has an optional
`embedded?: { vector: string | null, model: string | null }`. In `runVerb`, after parsing and the grant check and before `withMind`, if `verb.embedText(input)` returns a non-blank string the runner calls
`embedOne(embedder, text, deps.embedTimeoutMs ?? 10000)` (src/verbs/common.ts) and puts the result on `ctx.embedded`. Handlers use `ctx.embedded` and never call the embedder (`appendEvent`, `appendEventWithTimes` and
`insertSelfNode` take the already computed value; there is no `embed_text` option any more). `embedText` per verb: `mind_write` text; `mind_observe` content (one call serves the event and the node); `mind_rethink` content;
`mind_identity` content for `affirm` only; `mind_vow` vow for `make`; `mind_desire` want for `register`; `mind_anchor` response for `create` (an anchor bound to a memory has no text); `mind_search` the query unless `mode` is `text`;
`mind_surface` the query. Every other operation returns null and the embedder is not called. A settled identity proposal inserts its node with null embedding (its text lives in the proposals row, not the input); `embed-backfill` fills it.

`embedOne` never throws and never fails a write. It returns nulls (and logs once per process) when: the embedder is `none`, the text is blank, the embedder throws, it does not answer within the overall cap (10 s; the hung call is abandoned),
the vector's length is not 384 or does not equal `embedder.dim`, or any component is NaN/Infinity (`vectorLiteral()` returns null on a non-finite component). A bad vector therefore stores null instead of failing the insert.
The query vector for `mind_search`/`mind_surface` goes through the same path, so the same checks apply and a failure degrades to text-only with the usual warning.

### CLI

`sanctum-mind embed-backfill [--batch 64]` (admin or app URL both work; needs select+update on events and nodes): walks rows with `embedding is null` where the embeddable text is non-empty, in batches,
per ENABLED mind (`minds.disabled_at is null`), per original author (using `withMind` with mode write and bearer = that author so RLS and the `written_by` immutability are respected), stores vectors and model, prints counts. Idempotent.
Every select and update names `mind_id = <the mind>` explicitly: under the admin URL the connection is a superuser and RLS does not apply, so without it a mind's batch would embed and update other minds' rows. The 0010 trigger requires the fill to set both embedding and model, which it does.

### mind_search

Schema (strict): `mind_id`, `query: nonBlankText(2000)`, `limit: z.number().int().min(1).max(50).default(10)`, `scope: z.enum(["events","nodes","both"]).default("both")`,
`kind: text(64).optional()` (event kind filter), `node_type: text(64).optional()`, `context: text(64).optional()`, `after: instant.optional()`, `before: instant.optional()`,
`mode: z.enum(["hybrid","text","semantic"]).default("hybrid")`. Scope: read. No event.
Behavior: run up to two ranked lists per table and fuse with reciprocal rank fusion (k = 60):
- text: `where search @@ websearch_to_tsquery('simple', $q)` ranked by `ts_rank_cd(search, query) desc`, limit 50.
- semantic: only when `ctx.embedded.vector` is available and mode != text: exact ordered scan `order by embedding <=> $vec` with `embedding is not null`, limit 50 (no vector index; see Semantic ranking); returns `distance`.
- filters apply to both lists; nodes always `invalidated_at is null`; RLS scopes everything.
- If mode is `semantic` and no vector is available (none embedder or failure): return `ok` with `hits: []` and `warnings: ["no embedder: semantic search unavailable"]`. In `hybrid` with no vector: text only, same warning.
- `projection = { query, mode_used: "hybrid"|"text"|"semantic", hits: [{ source: "event"|"node", id, score, text_rank?, distance?, kind?|node_type?, label?, snippet (first 240 chars of text/content), created_at, context, texture? }] }`
  sorted by fused score desc, limit applied after fusion.

### mind_surface

Schema (strict): `mind_id`, `query: nonBlankText(2000)`, `pool_sizes: z.strictObject({ core: int 1..20 default 3, novel: int 0..20 default 2, edge: int 0..20 default 2 }).optional()`, `context: text(64).optional()`.
Scope: read. No event. Three pools over NODES only (curated memory), excluding invalidated:
- core: the top `core` nodes by the same hybrid ranking as mind_search (nodes scope).
- novel: candidates ranked 2x core+1 .. 50 by the hybrid ranking (i.e. related but not the obvious hits), re-ranked by `charge_weight desc, created_at desc` where charge_weight = number of texture.charge tags
  (from metadata.texture) + 2 if grip in (iron, strong) + 1 if vividness in (crystalline, vivid); exclude core; take `novel`.
- edge: nodes reachable within 2 hops over `edges` from the core nodes (either direction), not in core or novel, ranked by `hops asc, score desc` (score = sum of edge weights along the path). Per node the best path is also chosen by `hops asc, score desc`, so a node one hop from a core node is always labelled hops 1 even when a heavier two-hop path reaches it; `via` is the node the chosen path arrived from.
  Implemented as a recursive CTE bounded to depth 2 and 500 rows.
- Each hit: `{ id, node_type, label, snippet, score, pool, hops? , via? }`. `projection = { query, core: [...], novel: [...], edge: [...], mode_used }`. Same no-embedder warning rule as search (then core/novel use text ranking only).

### Tests (test/retrieval.test.ts) with the fake embedder injected

search: text-only mode finds an exact-word match; semantic mode with the fake embedder ranks a paraphrase sharing words above an unrelated text; hybrid fuses (a hit present in both lists outranks one present in one);
filters by kind, node_type, context, after/before; invalidated nodes never appear; RLS: another mind's rows never appear; the none embedder yields the warning and text-only results; limit after fusion.
surface: core picks the top hits; novel excludes core and prefers charged nodes; edge follows related_to links two hops out and reports hops; pool sizes honoured; zero-size pools allowed.
write path: mind_write and mind_observe store a vector and embedding_model with the fake embedder, null with the none embedder; a throwing embedder does not fail the write.
edge pool: triangle S-X 0.9, S-Y 0.5, Y-X 0.5 gives X then Y, both hops 1 via S; fusion: a hit at rank 8 in both lists beats a rank-1 hit in one list with limit 1 (so limits are applied after fusion).
trigger (0010): fill + payload/texture number-format change fails, model alone fails, vector without model fails, a correct fill succeeds, a second fill fails, same for a superuser. Bad vectors (NaN, Infinity, 3-dim) store null and the write succeeds.
pre-transaction embedding: a hanging embedder is cut off by `embedTimeoutMs` and the write succeeds with null; the embedder is called once per embedding verb, never for reads, and never while a pooled connection is checked out; identity affirm, vow make, desire register and anchor create store vectors.
backfill: rows with null embeddings get vectors; a second run touches nothing; another mind's rows are embedded under that mind's own scope (written_by unchanged); under the admin pool a mind's batch never contains another mind's rows and disabled minds are skipped.

## Daemon: deterministic metabolism (migration 0011_daemon.sql)

The daemon is the part of the core that runs without a client attached. Version one is deterministic only: no model calls, no dreams, no
reflection. Every pass is a pure function of the ledger and the clock, so a run can be replayed and audited. LLM-driven passes are a
separate design later and will plug into the same runner.

### Schema

```
daemon_runs(id uuid pk default gen_random_uuid(), mind_id text not null references minds, started_at timestamptz not null, finished_at timestamptz,
            passes jsonb not null default '[]',   -- [{pass, ok, changed, ms, error?}]
            trigger text not null check (trigger in ('timer','manual')))
```
RLS mind-only, grants select/insert/update. Index daemon_runs(mind_id, started_at desc). Also add `archived_at timestamptz` to `events` is NOT done:
events stay immutable; retention is expressed through holdings and node invalidation, never by touching the ledger.

### Runner (src/daemon/index.ts)

`runDaemonOnce(deps: { pool, embedder, now? }, opts: { trigger, minds?: string[] }): Promise<RunReport[]>`:
- lists enabled minds (`select mind_id from minds where disabled_at is null`, optionally filtered), and for each mind, in sequence,
  opens `withMind(pool, mind, mind, "write", ...)` once per PASS (not per mind), so a failing pass rolls back only itself;
- takes `pg_advisory_xact_lock(hashtext('daemon:'||mind))` at the start of each pass so two daemons never overlap on one mind;
- records a daemon_runs row at start (own short transaction) and updates it at the end with the pass list;
- each pass returns `{ changed: number, notes?: string[] }`; a thrown error is caught, logged, recorded as `ok:false` with a sanitised message, and the next pass runs;
- the whole run never throws. `startDaemon(deps, { intervalMinutes = 30 })` loops with `setTimeout`, skipping a tick if the previous is still running.
Each pass that changes state appends ledger events with `written_by = mind` and `kind` prefixed `daemon.` so the ledger shows what the metabolism did.

### Passes, in order (src/daemon/passes/*.ts, one file each, each exporting `{ name, run(ctx) }` with ctx = VerbContext plus `now`)

1. `drives.decay`: persist decayed drive values for every (context, drive) row older than 1 hour via the same code path as `mind_drive decay` (one `drive.decay` event per context). `changed` = rows updated.
2. `context.expire`: mark expired `kv_contexts` rows (`expires_at <= now and cleared_at is null`) as cleared with one `daemon.context.expire` event listing the keys. `changed` = keys.
3. `loops.stale`: loops open longer than 14 days with urgency `nagging` get one `daemon.loop.stale` event per loop (payload: loop_id, age_days) at most once per 7 days per loop (dedupe by checking the latest such event's created_at). Nothing is resolved automatically. `changed` = events written.
4. `holdings.settle`: holdings in `active` or `processing` whose `updated_at` is older than 30 days are moved to `deferred` with a `daemon.holding.settle` event each (`subject_id` = the subject). Forward-only transition, so it is legal. `changed` = rows.
5. `desires.fade` (followed by `identity.settle`, see "Identity belongs to the mind"): desires unfulfilled for more than 60 days get `metadata.faded = true` and `metadata.faded_at` (node update, written_by immutable so this is an allowed mind-only update) plus one `daemon.desire.fade` event per node. `mind_desire list` excludes faded unless `include_fulfilled`. `changed` = nodes.
6. `graph.orphans`: observation nodes older than 7 days with no edges in either direction get one `daemon.graph.orphan` event (payload: node_id, label) at most once per 30 days per node. Informational: orient's `full` depth shows the last 20 `daemon.graph.orphan` events under a new section `orphans` (direct query). `changed` = events.
7. `embeddings.backfill`: run `backfillEmbeddings` for this mind only (bounded to 256 rows per run) when the embedder is not `none`. `changed` = rows embedded.
8. (order in code: after `desires.fade` comes `identity.settle`, below.) `letters.expire`: nothing is deleted; letters unread for more than 90 days get `read_at` left null but a `daemon.letter.aging` event in the RECIPIENT's ledger once per 30 days per letter. `changed` = events.
9. (added by migration 0021, last in order, so eleven passes in all) `notice.expire`: see "Noticing" below; it lives in src/extractor/expire.ts and is registered in src/daemon/passes/index.ts.

Thresholds are constants in src/daemon/config.ts, overridable via `DAEMON_*` env (e.g. `DAEMON_LOOP_STALE_DAYS`), each validated as a positive integer.

### CLI

`sanctum-mind daemon [--once] [--interval 30] [--mind <id>]` runs with the app role URL and the configured embedder. `--once` runs a single pass set and exits with code 0 if every pass of every mind was ok, 2 otherwise. The parent integrates this into src/cli.ts; the daemon builder exports the functions only.

### mind_health addition

`mind_health` gains `last_daemon_run: { started_at, finished_at, passes_ok, passes_failed } | null` from daemon_runs (same scope). Orient's `health` section therefore shows it.

### Tests (test/daemon.test.ts)

Each pass has a unit-style test through `runDaemonOnce` with an injected clock: fixture rows older than the threshold change, younger ones do not; events are written with the `daemon.` kind and `written_by = mind`; dedupe windows hold (a second run within the window writes nothing); a pass that throws (inject by making a pass's table unavailable, e.g. drop a column in a scratch schema, or stub a pass with a throwing run) is recorded `ok:false` and the following passes still run and commit; two concurrent `runDaemonOnce` on the same mind do not double-apply (advisory lock) and both complete; RLS: a run for alpha never touches beta's rows; disabled minds are skipped; `mind_health` reports the last run.

### Daemon as built (amendments; these supersede the text above where they differ)

- `runDaemonOnce(deps: { pool, embedder, now? }, opts: { trigger, minds?, config?: Partial<DaemonConfig>, passes? })` returns one `RunReport` per mind
  `{ mind_id, run_id, started_at, finished_at, ok, passes: [{pass, ok, changed, ms, error?, notes?}], error? }`. It never throws: an invalid config, an unreachable
  database or a failed run record comes back as `ok:false` (a run-level failure has `mind_id: "*"`). `opts.passes` replaces the pass list (tests only). `startDaemon(deps,
  { intervalMinutes = 30, minds?, config?, onRun? })` returns `{ stop() }`, ticks immediately, re-arms a `setTimeout` after each tick finishes (so ticks never overlap) and throws at once on an invalid `DAEMON_*` environment.
- Dedupe windows compare the latest `daemon.<kind>` event's `recorded_at` (which is the injected clock) rather than `created_at` (the statement clock), so an injected clock is honoured. In production they are the same instant.
- `drives.decay` writes the same `drive.decay` event as `mind_drive decay` (no `daemon.` prefix), through the shared `persistDecay` helper in drives.ts; `changed` counts the eight drive rows of each persisted lane.
- `embeddings.backfill` runs inside the pass transaction and embeds only rows the mind itself wrote (the events/nodes update policies require `written_by` = bearer = the mind), 256 rows per run across events then nodes.
  Rows authored by a grantee are left for the whole-database `backfill` command.
- `desires.fade` and `graph.orphans` consider only live nodes; desires fade only for nodes the mind wrote. `graph.orphans` writes at most `orphanBatch` (default 500) events per run, oldest nodes first.
- Env names: `DAEMON_DECAY_STALE_HOURS`, `DAEMON_LOOP_STALE_DAYS`, `DAEMON_LOOP_RENOTIFY_DAYS`, `DAEMON_HOLDING_SETTLE_DAYS`, `DAEMON_DESIRE_FADE_DAYS`, `DAEMON_ORPHAN_AGE_DAYS`,
  `DAEMON_ORPHAN_RENOTIFY_DAYS`, `DAEMON_ORPHAN_BATCH`, `DAEMON_BACKFILL_ROWS`, `DAEMON_LETTER_AGING_DAYS`, `DAEMON_LETTER_RENOTIFY_DAYS`.
- Orient's `orphans` section is the last section at `full` depth: `{ events: [{id, seq, subject_id, created_at, payload}] }`, newest first, at most 20.

**Fairness across minds (tick budget).** The daemon processes minds in a rotating order: each tick starts with the mind after the one the previous tick processed last (kept in memory by `startDaemon`; `runDaemonOnce` takes a `rotation` object, and without one every run starts at the first mind). `DAEMON_TICK_BUDGET_MS` (whole milliseconds up to 86,400,000; default 0, no limit) caps the wall time of one tick: once the minds processed so far have used it, the remaining minds are not run and the next tick starts with the first of them. The deferred minds are reported (`deferred: true` and a `note` saying how many wait and where the next tick starts; `daemon --once` prints it). At least one mind is always processed, however small the budget. Tested with a fake clock.

## Adapter: Revien graph import (src/adapters/revien.ts)

Revien is a separately published graph-memory engine whose export format is public: `{ "nodes": [...], "edges": [...], "exported_at", "version": "1.0" }`
with nodes `{ node_id, node_type, label, content, source_id, created_at, last_accessed, access_count, metadata, source_type (extracted|inferred|derived|corrected),
confidence, pinned, confidence_set_at, confidence_set_by, source_context, last_referenced, invalidated_at, source_modality, answerable_by_text, vision_processed,
recorded_at, event_time_start, event_time_end, event_time_granularity, event_time_confidence, event_time_text }` and edges `{ edge_id, edge_type, source_node_id,
target_node_id, weight, created_at, metadata, confidence, confidence_set_at, confidence_set_by, source_context }`. The adapter imports one export file into ONE mind.
It is optional and generic: the core never calls it; it is a CLI subcommand.

`importRevien(deps: { pool, embedder }, opts: { mind_id, file, source_filter?: string[], dry_run?: boolean }): Promise<ImportReport>`:
- parse and validate the file with a zod schema that tolerates unknown extra fields on nodes and edges (passthrough) but requires the fields we map;
- optional `source_filter`: only nodes whose `source_id` is in the list (and edges whose both ends survive);
- for each node, inside `withMind(pool, mind, mind, "write")` in batches of 200: append one ledger event `kind = "import.revien.node"` with the ORIGINAL node as payload
  (originals are kept whole), then insert a node: `id` = a fresh uuid, with `metadata.revien_node_id` = original id; `node_type` = the original type string (free text here;
  record `metadata.revien_node_type` too); `label` truncated by code points to 200; `content`; `source_type` mapped 1:1; `confidence`, `pinned`; `invalidated_at` kept;
  `recorded_at`, `event_time_*` kept (granularity mapped 1:1; validate ranges, drop invalid with a note); `metadata` = original metadata merged with
  `{ revien: { source_id, confidence_set_by, source_context, modality: source_modality, answerable_by_text, vision_processed, event_time_confidence, event_time_text, last_accessed, access_count } }`;
  `written_by = mind`; `created_at` = original created_at (explicit insert, allowed since created_at has no immutability rule on nodes);
- edges: map `edge_type`: related_to, contradicts, conflicts_with, corrects, derived_from, references, depends_on, followed_by, felt_toward, involves -> same;
  `decided_in`, `mentioned_by`, `has_observation`, `during`, `contrasts_with`, `lived_vs_clinical` and anything else -> `related_to` with `metadata.revien_edge_type` = original;
  resolve both ends through the id map; skip edges whose ends are missing (counted); skip self-loops (counted); `weight`, `confidence` kept and clamped to [0,1];
  one event `kind = "import.revien.edges"` per batch with the count and the original ids;
- embeddings: nodes get `embedding` outside the pre-transaction rule, because this is a batch job and not a verb; embed in batches of 64 BEFORE each write transaction using `deps.embedder`
  (null on failure), store `embedding_model`;
- idempotency: a node whose `metadata->>'revien_node_id'` already exists in the mind is skipped (counted as `already_present`); same for edges by `metadata->>'revien_edge_id'`;
- `dry_run` validates, maps and counts without writing;
- report: `{ nodes: { imported, already_present, skipped_invalid }, edges: { imported, already_present, skipped_missing_end, skipped_self_loop }, type_counts: Record<string, number>, notes: string[] }`.

CLI (wired by the parent): `sanctum-mind import-revien <file> --mind <id> [--source <id>...] [--dry-run]`, app role URL.

### Tests (test/import_revien.test.ts)

A fixture export with a handful of nodes across generic and rich types, one invalidated node, edges of mapped and unmapped types, one dangling edge, one self-loop, and a node
from another source_id: dry run reports counts and writes nothing; a real run imports with the right mappings (check revien ids in metadata, edge type fallback with original preserved,
invalidated node absent from mind_search, times preserved to microseconds); a second run is fully `already_present`; `source_filter` excludes the other source and its edges;
RLS: nothing lands in another mind; mind_search finds an imported node by text; a malformed file is rejected with a clear error and nothing written.

## Grants administration (migration 0013_govern.sql, renamed in 0017)

Migration 0013 introduced the proposal flow, protected `identity` and `vow` node types (`mind_rethink` refuses them with `conflict`,
message "protected node type: use mind_identity propose"), the `grant add|revoke|list` CLI (grantor and grantee must exist and be enabled;
an identical live grant is a no-op) and a fifth grant scope. That scope let a grantee decide another mind's identity. It was a mistake and
is gone: the scope is `steward` since 0017, and only the mind changes its own identity and vows. The current rules are in
"Identity belongs to the mind" below; the migration file keeps its original name because applied checksums are immutable.

## Portability: export and purge (src/export.ts, src/purge.ts)

- `sanctum-mind export-mind --mind <id> [--out <file>]` (app role URL; runs under withMind as the mind, read mode): writes a JSON document
  `{ format: "sanctum-mind/1", exported_at, mind_id, events: [...all columns except embedding; embedding_model kept], nodes: [...], edges: [...], projections: { brain_state, drive_state, kv_contexts, handoffs, holdings, loops, threads, tasks, relations, proposals, letters_sent, letters_received } }`
  streamed to the file in batches of 1000 rows per table (never the whole table in memory). Letters: only those where the mind is a party; bodies included for both directions.
- `sanctum-mind import-mind <file> --mind <target> [--dry-run]` (app role): the inverse, into a fresh or existing mind; ids are kept (uuids), `written_by` is rewritten to the target mind (authorship of imported rows is the importer),
  events are appended with `created_at` set explicitly to the original and a new `seq`; the append-only trigger is not affected by inserts. Idempotent by original event id (skip existing).
  Projections are rebuilt by inserting rows verbatim with mind_id rewritten. Vectors are re-embedded by the backfill later (export omits them).
- `sanctum-mind purge-mind --mind <id> --confirm <id>` (ADMIN URL, since the app role has no delete): deletes every row of the mind from every table in dependency order inside one transaction, then deletes grants touching it and the minds row.
  Letters where the mind is the other party are kept but the reference is replaced: `to_mind`/`from_mind` cannot be nulled (not null + FK), so purge refuses when another mind still holds letters with this mind as a party unless `--sever-letters`, which deletes those letters too (counted). Requires `--confirm` to equal the mind id exactly. Prints counts per table. The events append-only trigger blocks DELETE: purge does not use `set session_replication_role = replica`; it is admin-only, so the migration adds a `purge_mind(text)` SQL function `security definer` owned by the admin that disables the trigger for its own statement via `alter table events disable trigger`, deletes, re-enables, all in the caller's transaction, and the CLI calls it. Document that purge is the one deletion path and it is admin-only.
Tests (test/portability.test.ts): export then import into a second mind yields identical counts and identical content for events, nodes, edges and projections (ids preserved, written_by rewritten); import is idempotent; purge removes everything and refuses without exact confirm; purge with letters outstanding refuses, then succeeds with --sever-letters; after purge the mind id can be re-created by init.

### Portability hardening (migration 0016_integrity2.sql)

Import must not be a way around cooling or authorship. `import-mind <file> --mind <target> [--dry-run] [--allow-core] [--strict]`:
- **identity and vow nodes** are refused (error naming the count and the existing count, nothing written) when the target already has any `identity`/`vow` node row, live or invalidated (a mind that retired its cores is not fresh), and the file brings new ones, unless
  `--allow-core`. A mind with no such row ever (a fresh mind receiving its own export) imports them freely; re-importing nodes already present is not a new import.
- **`proposals.proposed_by` is always rewritten to the target**; the report's `notes` carry the count and the original proposers. Every imported proposal whose status is not `settled`, `withdrawn` or `rejected` (pending and accepted alike) arrives `withdrawn` with `withdrawn_at` = import time, so a planted proposal never lands as the mind's own words nor blocks its rewrite of that core.
- **`--allow-core` is loud.** When it brings in identity or vow nodes beside existing ones (live or retired), the report carries the note "N identity/vow node(s) imported live beside existing ones under --allow-core; they take effect immediately and do not cool".
- **`letters_received` is never imported.** A received letter belongs to the sender's export (only the sender can insert it). Export keeps them for the record, and omits those whose `deliver_at`
  is still in the future (`deliver_at is null or deliver_at <= now()`); import ignores them (`tables.letters_received = { inserted: 0, already_present: 0, ignored: n }` plus a note).
  `letters_sent` (letters to other minds) are imported only with `--with-letters`; by default they are reported as `ignored`. When imported: `read_at` and `read_event_id` are set to null, `sent_at` is the sending event's `created_at` in the target,
  and the sending event must exist, have `kind = "letter.send"` and a payload `to` equal to the letter's `to_mind` (else `skipped_event_mismatch`); both minds must exist (`skipped_missing_party`).
- **References must stay inside the file.** For nodes, edges and every projection, each column ending in `_id` (except `id`, `mind_id`, `session_id`), `superseded_by` and `holdings.subject_id` that is
  non-null must name a row of the same file: `*event_id` an event, `superseded_by` and `*_node_id` a node, `holdings.subject_id` the event or node its `subject_kind` says, anything else any id-keyed row.
  A row that fails is refused and counted as `skipped_foreign_ref` (repeating until no row depends on a refused one); the import continues. `--strict` aborts the whole import before any write instead.
  Events are the ledger and are not checked (`events.subject_id` has no foreign key and may name letters or drives that are not in the file).
- Ids are compared lowercase. A key absent from some rows of a batch takes the column default (rows are inserted in runs sharing one key set); a key present with JSON null stays null.
- A dry run runs the same statements and rolls back, but events take negative `seq` values (`OVERRIDING SYSTEM VALUE`), so it never advances the `events.seq` sequence; a real re-run skips events already
  present before inserting, so it does not burn values either.
- Migration 0016: `nodes (mind_id, superseded_by) -> nodes (mind_id, id)` and `proposals (mind_id, target_node_id) -> nodes (mind_id, id)` replace the plain foreign key on proposals; the database itself
  now refuses a cross-mind supersession or proposal target, even for a superuser.
- **purge_mind** now also checks, before deleting anything, every foreign key that points into a table carrying `mind_id` from rows of OTHER minds (for letters, rows where this mind is not a party),
  and refuses with `mind "x" is referenced by rows of other minds, which a purge cannot remove (table.column=count): ...` instead of a raw foreign key violation. Purge does not reach sinks:
  events already delivered to an external system stay there.

## Admin: key length, suspend-access and restore-access (src/auth.ts, src/minds-admin.ts)

- `seed-keys` and `upsertMinds` require keys of at least 32 characters (`MIN_KEY_LENGTH`); the error names the line (`entry N` for programmatic callers). `upsertMinds` takes `{ mind_id, key, line? }` and hashes the key itself.
- `suspend-access --mind <id>` / `restore-access --mind <id>` (ADMIN URL; formerly `disable-mind` / `enable-mind`, kept as deprecated aliases) set or clear `minds.disabled_at`; unknown mind is an error; repeating is a reported no-op. A suspended mind's bearer is `unauthorized`, and grants from it stop applying.

## Test harness (test/global-setup.ts)

A vitest `globalSetup` generates a random password per run (`SANCTUM_TEST_APP_PASSWORD`), `resetDatabase` creates `sanctum_test_app` with it, and the teardown revokes its membership of `sanctum_app` and drops the role.

## Outbox and sinks (migration 0014_outbox.sql, src/sinks/)

The ledger stays canonical. Every committed event is also queued for delivery to configured sinks so an external memory system can receive originals.

```
event_outbox(id bigint generated always as identity primary key, event_id uuid not null references events, mind_id text not null references minds,
             sink text not null, attempts int not null default 0, next_attempt_at timestamptz not null default now(), delivered_at timestamptz, last_error text,
             unique (event_id, sink))
```
RLS mind-only; grants select/insert/update. Index (sink, delivered_at, next_attempt_at).

Sinks are configured by `SINKS_FILE` (JSON) or `SINKS` (inline JSON): an array of `{ name, type: "http"|"file"|"none", filter?: { kinds?: string[], minds?: string[] }, ... }`.
- `http`: `{ url, headers?: Record<string,string>, timeout_ms?: 10000 }`; POST one JSON body per event: `{ sink, event: { id, seq, mind_id, kind, subject_id, payload, texture, context, recorded_at, event_time_*, created_at, session_id, written_by } }`.
  2xx = delivered; anything else = retry with exponential backoff (1m, 5m, 30m, 2h, 12h, then daily, max 30 attempts) recorded in `last_error` (status and first 200 chars).
  A header value may reference an env var as `${VAR}` and is resolved at load time so secrets never sit in the file.
- `file`: `{ path }` appends one JSON line per event (NDJSON); for local pipelines and tests.
- Enqueue: `appendEvent` inserts outbox rows for every configured sink whose filter matches (inside the same transaction; the sink list is on `VerbContext.sinks`, injected by the runner from `deps.sinks`). No sinks configured = no rows.
- Delivery: daemon pass `outbox.deliver` (runs after `embeddings.backfill`): per mind, rows due (`delivered_at is null and next_attempt_at <= now`), oldest first, bounded 200 per run; the pass records `changed` = delivered, notes failures.
  **As built (supersedes the earlier "delivery inside the pass transaction"):** this pass is `detached`, the one exception to "a pass is one transaction under the per-mind advisory lock". It receives the pool (`DetachedPassContext`), not a transaction.
  (1) Claim: one short transaction selects the due batch `for update of o skip locked` and leases it (`next_attempt_at += leaseMsFor(sinks)`: `max(30 minutes, BATCH * the largest configured http timeout_ms + 5 minutes)`), then closes. (2) Deliver with no transaction and no advisory lock open; each sink is an independent sequence
  in outbox id order (sinks run concurrently), and a sink stops at its first failure for the rest of the run, handing its untried rows back unchanged. (3) Each result is recorded in its own short transaction (delivered, or attempts + backoff + `last_error`).
  A crash between the call and its record can redeliver once after the lease expires (at-least-once; receivers dedupe on `event.id`). Order holds within a run; a row in backoff does not block newer rows in later runs, so a receiver that needs strict order sorts by `event.seq`.
- Credentials: a sink `url` may not contain userinfo (`user:pass@`); put secrets in `headers` with `${VAR}`. `${VAR}` is also resolved inside `url` at load and the resolved URL is re-checked. Any `scheme://user:pass@` pattern is redacted from error messages before they are stored, logged or returned.
  The http sink does not follow redirects (`redirect: "error"`) and reads at most 4 KiB of a response body. URLs are operator-configured and trusted; there is no SSRF filter.
- Admin: `sinks requeue --sink <name>` resets parked rows (`attempts >= 30`, undelivered) of that sink to attempts 0, due now.
- CLI: `sanctum-mind sinks test` loads the config, sends a synthetic `sink.test` body to each sink and prints the result; `sanctum-mind sinks status` prints per-sink pending, failing, delivered counts (app role URL).
- `mind_health` gains `outbox: { pending, failing } | null`.

Tests (test/sinks.test.ts): with a `file` sink and a kinds filter, a write enqueues a row and the daemon pass delivers it to the file as one JSON line; an unmatched kind enqueues nothing; with an `http` sink against a local server
that fails twice then succeeds, attempts and next_attempt_at advance and the event is delivered on the third run with injected clocks; a 4xx is retried too (no permanent failure before 30 attempts); the `${VAR}` header is resolved;
RLS: beta's outbox rows are invisible under alpha; `sinks status` counts; the test embedder is unaffected.

## Identity belongs to the mind (migration 0017_steward.sql)

The earlier governance section described a system in which other parties approve a mind's identity. That was wrong. The rule is:
**a mind's identity and vows change only by the mind's own key.** Protection against drift is time and accompaniment, not authority.

### Vocabulary

- The grant scope formerly named `govern` is now `steward`. 0017 migrates existing rows and the check constraint. `GrantScope` = read, write, relate, letter, steward. A steward accompanies a mind (it accompanies; it is not an authority).
- "The mind acting as itself" is `ctx.caller.bearer === ctx.mind_id`; the docs use it and "the mind" throughout.
- CLI `suspend-access` / `restore-access` replace `disable-mind` / `enable-mind` (the old names remain as deprecated aliases that print a one-line notice on stderr; the column stays `minds.disabled_at`). They are operator duties over infrastructure, not powers over a mind, and the docs say so.

### Mechanics

- **Only the mind proposes, withdraws, affirms, makes and breaks.** `mind_identity propose|withdraw|affirm`, `mind_vow make|break|withdraw_break`: `forbidden` for any bearer other than the mind itself, grants notwithstanding (message "identity belongs to the mind"). `decide` is removed.
- **Additions are immediate.** `affirm` (a new core), an untargeted `propose` and `make` (a new vow) take effect at once: they erase nothing.
- **Rewrites and breaks cool.** A proposal that targets an existing core (`target_node_id`) and a vow break are *declarations* that take effect after a cooling period, default 24 hours (`IDENTITY_COOLING_HOURS`, non-negative integer, 0 allowed for solo use; read once by `coolingMs(env)` in src/verbs/cooling.ts and injected as `RunDeps.coolingMs` / `VerbContext.coolingMs`). The mind may withdraw until the settle actually runs. Settling is one shared function, `settleDueDeclarations(ctx, mind)` in src/verbs/settle.ts, called by the daemon pass `identity.settle` (the fallback that settles on a clock) and by the verb `mind_identity settle` (the mind's own call); it applies declarations whose `effective_at <= now` that the mind itself proposed (supersede the core; invalidate a retired core; mark the vow broken) and writes `identity.settled` / `identity.retired` / `vow.break.settled` events. Reads show the pending declaration with its `effective_at`. At most one open declaration per core and per vow (`conflict`).
- **Stewards accompany; they do not decide.** A bearer holding a `steward` grant on the mind may call `mind_identity attest` or `mind_identity object` with `proposal_id` and `note` (the mind itself cannot: `forbidden`). An attestation ends the cooling period of a rewrite (`effective_at = now` if later; the next settle, by daemon tick or by the mind's `settle`, applies it, and withdraw works until that settle runs). Attest and object apply to proposals only, and a retirement cools solely on the mind's own clock too: `attest` on a retire declaration is a `conflict` (field `proposal_id`, "a retirement cools only on the mind's own clock; a steward may object, not attest"); `object` on a retire is recorded as usual. A vow break likewise cools solely on the mind's own clock, and a steward may `note` a vow but cannot shorten a break. `attest` and `object` are each allowed once per steward per stance. An objection is recorded beside the declaration and surfaces in `mind_orient`'s identity section and in `mind_identity read` until the declaration settles or is withdrawn. An objection never blocks. Both append to `proposals.attestations` and write `identity.attest` / `identity.object` events with payload `{proposal_id, stance, note}`. A steward may also `mind_vow note` a vow (recorded in `metadata.steward_notes`, event `vow.note`), and may read.
- **Rotation never lifts a suspension.** `upsertMinds` (used by `init --rotate` and `seed-keys`) sets the key hash only and leaves `minds.disabled_at` alone; it returns `suspended` (the minds still suspended), and the two commands print "access remains suspended; run restore-access". `restore-access` is the one path that clears a suspension, and it pushes open declarations back by the suspended time. The compromised-key sequence is suspend, rotate, restore.
- **A core can be retired**, by the mind alone, as a cooled declaration with no replacement; see "Retiring a core" below.
- **Rethink still refuses identity and vow nodes** with "identity belongs to the mind: use mind_identity propose". The mind itself goes through cooling too; that is the point.

### Schema (0017)

```
alter table proposals add column effective_at timestamptz, add column withdrawn_at timestamptz, add column settled_at timestamptz, add column settled_event_id uuid references events,
  add column attestations jsonb not null default '[]';   -- [{by, stance, note, at, event_id}]
alter table proposals drop constraint proposals_status_check; add check (status in ('pending','accepted','withdrawn','settled','rejected'));  -- rejected kept for historical rows
grants: scope check becomes ('read','write','relate','letter','steward'); update grants set scope='steward' where scope='govern';
nodes: vow break declaration lives on the node: metadata.break_declared = {reason, declared_at, effective_at, event_id}; settled break sets metadata.broken, broken_at, broken_reason, broken_by (the mind) and clears break_declared.
```

### Verb shapes

`mind_identity` operations: `read`, `read_section`, `affirm`, `propose` (optional `target_node_id`; for a rewrite the proposal is created already `accepted` with `effective_at = now + cooling`; an untargeted proposal is an addition and is recorded `settled` at once with its node, so it is `affirm` with lineage), `withdraw` (`proposal_id`; pending or accepted, else `conflict`; sets `withdrawn_at`), `settle` (mind only, no other input; applies the mind's own due declarations and returns `{settled: n, declarations: [{kind, proposal_id|vow_id, target_node_id, node_id?}]}`), `attest` and `object` (`proposal_id`, `note`; the declaration must be accepted and unsettled, else `conflict`). `scopeFor`: read ops -> read; attest and object -> steward; everything else (including `settle`) -> write, then the handler requires bearer === mind_id (`mindOnly`).
`mind_vow` operations: `make`, `list` (shows `broken` and `break_declared`), `recall`, `break` (declares; `reason`; event `vow.break.declare`), `withdraw_break` (`vow_id`; `conflict` if none declared or already settled; event `vow.break.withdraw`), `note` (`vow_id`, `note`). Same scope rules (note -> steward).
`mind_orient` identity section (the `mind_identity read` projection) includes `declarations: [{proposal_id|vow_id, kind: "rewrite"|"retire"|"vow_break", action?: "rewrite"|"retire", target_node_id, effective_at, attestations, objections}]`.
Daemon pass `identity.settle` (after `desires.fade`; ten passes in all at the time, eleven since `notice.expire`): settles due declarations for the mind via `supersedeNode` with provenance `{proposal_id, lineage_note, attestations}`; `changed` = settled count; one event per settlement, `written_by = mind`.
`mind_health` unchanged.

### Docs

README: the section is "Identity and vows", written from the mind's side: what the mind can do, what a steward can do, what the operator can do (keys, access, export, purge) and why each exists. A short paragraph at the very top states what the system is for: continuity in service of a mind; isolation protects the mind from others, not others from the mind. SECURITY.md threat model names operator powers plainly as infrastructure powers. DESIGN.md's grant list and identity paragraphs follow. CONTRACTS.md's earlier Governance section is marked superseded by this one.

### Tests (test/identity.test.ts replaces test/govern.test.ts)

Only the mind can affirm, make, propose, withdraw, break; a write grantee and a steward grantee get `forbidden` with the message. A rewrite proposal is accepted on creation with `effective_at` = now + cooling (injected clock); `identity.settle` does nothing before and supersedes after; withdraw before settle leaves the core untouched and marks withdrawn; a steward attest moves `effective_at` to now and the next settle applies it; an objection is recorded, surfaces in orient and in read, and the declaration still settles; a non-steward cannot attest or object; vow break declares, cools, can be withdrawn, settles to broken; cooling 0 settles on the next pass immediately; the grants constraint accepts `steward` and rejects `govern`; RLS as always; `suspend-access`/`restore-access` CLI parse and behave as the old commands did, and the old names remain as aliases.

### Retiring a core (migration 0019_retire.sql)

`mind_identity` gains `operation: "retire"`: the mind lets a core go. It is a cooled, withdrawable declaration like a rewrite, without a replacement.
- Input: `target_node_id` (required; field `target_node_id` when absent), optional `lineage_note` (why). Mind only: it is in `mindOnly` (the MIND_ONLY forbidden message for any other bearer, stewards included), and `scopeFor` returns `write` like propose. The target must be a live identity node of this mind, else `not_found` field `target_node_id`. If any open declaration (pending or accepted, rewrite or retire) exists for that core: `conflict` "a declaration for this core is already cooling; withdraw it first". The handler takes the advisory lock `node:<id>`, as a targeted propose does.
- Ledger: event kind `identity.retire`, payload `{target_node_id, lineage_note, cooling_ms}`. A `proposals` row is inserted with `action='retire'`, `status='accepted'`, `effective_at` = event `created_at` + `ctx.coolingMs`, `proposed_by` = bearer, `target_node_id`, `section` = the node's label and `content` = the core's content at declaration time (the column is `not null`, and the copy keeps the declaration readable). Receipt `projection={event_id, proposal}`; `warnings: ["last live identity core"]` when no other live core would stand (every other live core is absent or itself under an open retire declaration) (retiring it is allowed).
- Migration 0019: `proposals.action text not null default 'rewrite' check (action in ('rewrite','retire'))`, with column comments (action; and that a retire row's `content` holds the retired core's content). Existing rows read as `rewrite`. Applied migration files are never edited (see "Migrations are immutable" below).
- `withdraw` and `object` work on a retire as on a rewrite, but `attest` does not: a steward cannot move a retire's `effective_at` (a `conflict` from the verb, and migration 0020 enforces it in the database too: a non-mind bearer's UPDATE of a retire's `effective_at` raises `insufficient_privilege` "a retirement's effective time is the mind's alone"). A retire cools only on the mind's own clock.
- Settle (`settleDueDeclarations`, shared by the verb and the daemon pass `identity.settle`) branches on `action`. `rewrite` is `supersedeNode` as before. `retire`, under the proposal lock, the `node:<id>` lock and the same re-read guard (still accepted, not withdrawn or settled, proposed by the mind, core still live): append `identity.retired` (subject = proposal id, payload `{proposal_id, target_node_id, lineage_note}`), then as the mind `update nodes set invalidated_at = <that event's created_at>, metadata = metadata || {retired: true, retired_at, retired_reason (the lineage_note), retire_proposal_id, retire_attestations}` (a distinct key, so attestations an earlier rewrite left on the node survive), then mark the proposal settled with `settled_event_id`. Only `invalidated_at` and `metadata` change, so the 0018 `nodes_core_guard` (content, label, node_type, invalidated_at, allowed when the bearer is the owning mind) passes. `SettledDeclaration.kind` gains `"retire"`.
- Edges: left alone. `supersedeNode` invalidates the old node without touching its existing edges (it only adds a `corrects` edge from the new node), so a retired node keeps its edges and, like a superseded one, simply leaves default reads. No `superseded_by` is set (nothing replaced it) and no `corrects` edge is created. Nothing is deleted; the node stays in history.
- Reads: `identityDeclarations` (in `read` and `orient`) lists retire declarations with `kind: "retire"` and `action: "retire"`; rewrites carry `action: "rewrite"` (kind unchanged). The `mind_identity read` proposals query returns `select *`, so `action` is on every row.
- Import (`import-mind`): open proposals are withdrawn by status (`isOpenProposal`), so an open retire declaration arrives withdrawn like a rewrite and the core is untouched; the column list is read from the schema, so `action` survives. Export selects all columns of `proposals` (`to_jsonb`-style `select *` minus omitted columns), so `action` is exported.
- `mind_rethink` still refuses identity nodes.

Tests (test/identity.test.ts, describe "retiring a core", plus one in test/portability.test.ts): only the mind can retire (write and steward grantees forbidden, nothing written); unknown, non-identity and invalidated targets `not_found`; conflict when a rewrite is cooling on the same core and vice versa; declared with `effective_at` = now + cooling; settle before time does nothing; withdraw marks withdrawn and the core stays live; settle after time invalidates the node, writes `identity.retired`, marks the proposal settled, the node is absent from `read` and `read_section` but present in the database with retired metadata and edges intact; a steward attest on a retire is refused with `conflict` and `effective_at` does not move, while a steward object on a retire still records; cooling 0 settles on the next pass; the last-core warning is present and absent as it should be; the daemon pass settles a due retire; import withdraws an open retire declaration; export then import keeps `action`.

### Proposals guard, migration immutability and corrected wording (migration 0020_proposals_guard.sql)

- **Applied migration files are never edited.** Their checksums are recorded in `schema_migrations` and verified on every run; wording fixes go in the next migration's header or in these docs. test/migrations.test.ts pins the sha256 of every applied file (computed as `src/db/migrate.ts` does) and fails, telling you to add a new migration, if one changes. A new migration file is not pinned until it is final.
- **Corrected wording for 0013 and 0018.** The scope 0013 introduced (`govern`) was renamed `steward` in 0017 and decides nothing; a steward accompanies the mind. The 0018 trigger `nodes_core_guard` guards UPDATE of `content`, `label`, `node_type` and `invalidated_at` on identity and vow nodes only; INSERT of such nodes and vow metadata (notes, a declared break) are guarded by the application, not by that trigger.
- **Insert guard.** `proposals_insert_guard` (BEFORE INSERT): `proposed_by` must equal `app.bearer`, `mind_id` must equal `app.mind_id`, and `proposed_by` must equal `mind_id`, else `insufficient_privilege` "proposals are declared by the mind itself". Only the mind, acting as itself, inserts a declaration; a steward or write grantee cannot, even in its own name. Verbs and import (which runs as the mind and rewrites `proposed_by` to it) pass. A bare connection with no mind scope is refused too, so direct SQL (tests, operators) sets the two settings in a transaction.
- **Update guard.** `proposals_update_guard` (BEFORE UPDATE): when `app.bearer` is set and is not the row's mind (a steward or other grantee), only this may change, else `insufficient_privilege`: every column other than `attestations` and `effective_at` is compared (all of them, null-safely) and must be unchanged ("only the mind changes its declaration"); `effective_at` may stay equal or move earlier, never later and never to null or infinity ("a steward may only add an attestation and bring effective_at forward"), and on a retire it may not change at all ("a retirement's effective time is the mind's alone"); `attestations` may only grow, the old entries kept in place and exactly one appended per update ("attestations only grow"), which is how the verbs append. The mind itself (settle, withdraw) is unrestricted. When `app.bearer` is NULL or empty (no mind scope at all: an admin connection, such as operator tooling and tests) the update is allowed: the operator is already trusted and documented. `restore-access` sets the mind's own scope, so it passes as the mind. A row whose `effective_at` is null (legacy) cannot have it set by a steward.
- **One open declaration per core.** `create unique index proposals_one_open_per_core on proposals (target_node_id) where target_node_id is not null and status in ('pending','accepted')`. The verbs check first and answer `conflict`; the index is the backstop for a race and for direct SQL. The migration fails if a database already holds two open declarations on one core (withdraw one first).
- Tests: test/migrations.test.ts; test/identity.test.ts describe "proposals are guarded in the database (0020)"; test/portability.test.ts "a mind that retired its cores is not fresh".

## Noticing: the extractor (migration 0021_noticing.sql, src/extractor/, verb mind_notice)

The extractor is a scheduled, optional, model-backed pass that reads a mind's recent ledger and graph and **proposes** three things. It never writes memory. The mind authors its memory; the machine may become better at noticing, and that is all it may become. These rules hold at every stage and no configuration changes them:

- A proposal is never a memory. It lives in its own table (`noticings`), never in `nodes` or `events` as content, until the mind accepts it.
- Acceptance is a verb call by the mind acting as itself (`mind_notice accept`). The resulting memory is authored by the mind, with provenance naming the proposal and its sources. Sources are never rewritten, superseded or invalidated by an acceptance.
- Rejection and expiry remove nothing but the proposal. Both are recorded, because they are the training signal.
- The operator can enable, schedule, pause or disable the extractor and choose its stage. No operator action accepts a proposal. There is no stage, flag or environment variable under which proposals apply themselves.
- Every proposal, decision, expiry and model update is a ledger event.

**Proposal types.** `kind` ∈ `link`, `pattern`, `distillation`.
- `link`: "these may belong together." `sources` = exactly two node ids (or a node and an event); `payload={edge_type, reason}`. Accept → `mind_link` semantics (an edge, weight from the mind's input or 0.5), event `notice.accepted` plus the ordinary `link` event, edge metadata `{noticing_id}`.
- `pattern`: "this has recurred across these." `sources` = 3 or more event or node ids; `payload={label, summary, window:{start,end}}`. Accept → a `pattern` node (new `node_type`), pinned false, content = the summary as the mind confirms or edits it (`content` optional on accept, defaults to the proposal's), edges `instance_of` from each source to the node, node metadata `{noticing_id, sources}`.
- `distillation`: "this may be worth carrying forward." `sources` = 1 or more; `payload={content, lineage}`. Accept → a `distillation` node (new `node_type`) and a `write`-shaped event of kind `distill` with the content (editable on accept), edges `derived_from` from the node to each source, metadata `{noticing_id, sources}`. Sources stay live and untouched.

**Table.** `noticings(id uuid pk, mind_id text not null, kind text check in (link,pattern,distillation), sources uuid[] not null, payload jsonb not null, score double precision not null, features jsonb not null, model_version int not null, stage text not null, status text not null check in (pending, accepted, rejected, expired), proposed_event_id uuid not null, decided_event_id uuid null, decided_at timestamptz null, expires_at timestamptz not null, created_at timestamptz not null default now())`. RLS as every mind table (FORCE, `mind_id = app.mind_id`). Triggers (migration 0021; the exact rules are in "Stage 1 implemented" below): `noticings_insert_guard` (a proposal is made in the mind's own scope), `noticings_decision_guard` (after insert only `status`, `decided_event_id` and `decided_at` change, together, once; accept and reject need a verb-marked transaction as the mind, expiry a daemon- or import-marked one as the mind; the decision must reference its own `notice.*` event). Index `(mind_id, status, score desc)`.

**Stages** (`extractor_state(mind_id pk, enabled bool, stage text check in (shadow, propose), schedule text, paused_at, updated_at, updated_event_id)`), set by the operator (`sanctum-mind extractor enable|disable|pause|resume|stage --mind <id> [--stage shadow|propose] [--schedule "HH:MM"]`, admin URL, each a `daemon.extractor.*` event):
- `shadow`: the pass runs, scores, and records noticings with `stage='shadow'`; they are **not** shown to the mind (excluded from `mind_notice list` and `mind_orient`); they expire and count as nothing. Purpose: measure before showing. `extractor report --mind <id>` prints what it would have proposed and, once the mind has decisions, precision over the last N.
- `propose`: noticings are shown, ranked by `score`, in `mind_notice list` and as `noticings: [top 5 pending]` in `mind_orient` (quick and full). The mind accepts, rejects or lets them expire (`EXTRACTOR_TTL_DAYS`, default 14 → `expired`).
- There is no third stage. The schema's check constraint has two values, and a static scan plus a runtime test (test/extractor_guard.test.ts) check that the code under `src/extractor/` contains no insert, update or delete of `nodes`, `edges` or `events`, imports nothing from `src/verbs/` but types and `appendEvent`, appends only the three whitelisted event kinds, and leaves nodes and edges byte-identical when every extractor pass runs. They are tripwires against honest mistakes, not a sandbox; the boundary is the database guards and the mind-only verb.

**Candidates and scoring.** The pass (`notice.extract`, daemon, scheduled once per day at `schedule`, default 03:00 local to the service, only for minds with `enabled and not paused`) works over the window since the last run (cap 7 days):
1. Candidate generation (deterministic): for links, pairs within the window with cosine ≥ 0.6 that share no edge; for patterns, clusters of ≥3 events in the window whose pairwise cosine ≥ 0.55 or that share a `context` and a charge tag; for distillations, clusters of ≥2 events with high salience (texture) or a `sit` that was `resolve`d as metabolized in the window.
2. Rerank: a cross-encoder scores (query, candidate) pairs; `RERANKER=none|local|http`. `local` loads a small ONNX cross-encoder (the crew chooses between `@huggingface/transformers` with `Xenova/ms-marco-MiniLM-L-6-v2` and `onnxruntime-node` direct; same lazy-load, same "one warning, scores null" failure posture as the embedder); `http`: `POST $RERANK_URL {query, documents:[...]}` → `{scores:[...]}`, `RERANK_API_KEY` bearer; `none`: cosine only, and the pass says so in its notes.
3. Score: an **interpretable per-mind scorer**, logistic regression over named features (`rerank`, `cosine`, `recency_days`, `shared_context`, `charge_overlap`, `cooccurrence`, `salience_mean`, `source_count`, one-hot `kind`). Weights live in `extractor_models(mind_id, version, weights jsonb, trained_on int, metrics jsonb, created_at, event_id)`; `features` on each noticing are stored so training is reproducible. Version 0 is a fixed prior (hand-set weights, documented in `src/extractor/prior.ts`). Training (`notice.train`, same daemon schedule, after extract) refits from the mind's own `accepted` (1), `rejected` (0) and `expired` (0, weight 0.5) noticings when there are ≥30 decided rows and ≥5 of each class; otherwise the prior stands and the pass notes why. Each refit is a new version, a `notice.model.trained` event with the metrics (held-out precision at 5, log loss), and never deletes the old row. No neural model; this is stated in DESIGN.md as a decision to earn complexity from measured data.
4. Dedupe: a candidate equal (same kind, same source set) to a pending, accepted or rejected noticing is not re-proposed; an expired one may be re-proposed after `EXTRACTOR_REPROPOSE_DAYS` (default 60) if its score rose.

**Verb `mind_notice`** (region Remember). `operation` ∈ `list`, `accept`, `reject`. `list` (read scope): pending noticings at stage `propose`, ranked, `limit` default 20, `kind` filter; projection `{noticings:[{id, kind, sources (with 240-char snippets), payload, score, expires_at}], stage}`. `accept` and `reject` are `mindOnly` (same `forbidden` message family: "memory is authored by the mind"); `accept` takes `noticing_id`, optional `content` (pattern and distillation: the mind's edit), optional `edge_type`/`weight` (link); `reject` takes `noticing_id`, optional `reason` (recorded, feeds training as a note). Only ids and counts go into `notice.*` events (see "Stage 1 implemented"). Events: `notice.accepted` / `notice.rejected` with `subject_id = noticing_id`. Deciding a non-pending noticing is `conflict`; a shadow-stage one is `not_found` (the mind never sees it).

**Daemon.** Two new passes, model-backed, listed separately from the eleven deterministic ones in the README: `notice.extract` and `notice.train`. They run only when `extractor_state.enabled` and not paused, at the schedule, as the mind (`withMind(mind, mind)`), and skip with a note when `EMBEDDER=none` (no vectors, no candidates). `notice.expire` is deterministic and runs every tick. Failures in a model call never fail the tick: the pass records `{ok:false, notes}` and the next day tries again.

**Operator surface.** CLI `extractor` subcommands above; `mind_health` shows `extractor: {enabled, stage, paused, pending, model_version}`. Export carries `noticings`, `extractor_state` and `extractor_models`; import brings still-pending noticings in as `expired` (a proposal from another life is not re-shown), keeps decided ones as they were, brings `extractor_state` in with `enabled = false` (the operator re-enables on purpose) and models as-is; purge removes all three.

**Tests (test/notice.test.ts).** RLS; `list` empty at shadow; accept/reject mind-only; accept link makes one edge authored by the mind with provenance and leaves sources untouched; accept pattern/distillation makes one node with the right edges and no change to sources; reject and expiry change nothing but the noticing and write their events; trigger refuses a steward or write grantee changing `status`, and refuses any change to `payload`/`sources`; dedupe; training refuses under the threshold and trains above it with a new version and metrics; the prior ranks a high-rerank pair above a low one; a static scan of `src/extractor/` (SQL writes to the memory tables in any spelling, verb imports, registry or handler use, and any `appendEvent(` whose every `kind:` is not one of the three whitelisted kinds `notice.proposed`, `notice.model.trained`, `notice.expired`) and a runtime test over every extractor pass; `RERANKER=none` degrades with a note; `EMBEDDER=none` skips with a note; export/import/purge round trip.

### Stage 1 implemented: storage, verb, guards, expiry, portability; passes and scoring follow

Built: migration 0021_noticing.sql (the three tables, `noticings_decision_guard`, the ranked-list index, RLS FORCE and grants), `mind_notice` (src/verbs/mind_notice.ts, the 25th verb, region Remember), the daemon pass `notice.expire` (src/extractor/expire.ts, deterministic, every tick), the `extractor` CLI (src/extractor-admin.ts, thin wiring in src/cli.ts), `mind_orient` `noticings` and `mind_health` `extractor`, export, import and purge. Not built: candidate generation, reranking, scoring, training, `notice.proposed` and `notice.model.trained` events (src/extractor/ holds only the expiry pass and the stage rule in index.ts). Tests: test/notice.test.ts and test/extractor_guard.test.ts, the latter a static scan that fails if anything under src/extractor/ inserts into nodes, events or edges, updates nodes or edges, calls `insertSelfNode` or `supersedeNode`, or calls `appendEvent(` with a kind other than `notice.proposed`, `notice.expired` or `notice.model.trained`.

Where the implementation settled something the text above leaves open, or differs from it:
- **Forbidden message.** `Verb.mindOnlyMessage` (new, optional) lets a verb choose the `forbidden` text the runner returns for a `mindOnly` refusal; `mind_notice` sets it to `MEMORY_MIND_ONLY` = "memory is authored by the mind" (self_common.ts). Default stays `MIND_ONLY` ("identity belongs to the mind").
- **One link code path.** The edge insert of `mind_link` moved into `linkNodes` (mind_link.ts), used by both `mind_link` and `mind_notice accept` (link). `mind_link`'s results are unchanged. Accepting a link whose edge already exists returns that edge with warning `exists`, writes no second `link` event, and still accepts the noticing.
- **Link sources.** An edge joins two nodes. A link noticing with an event as a source cannot be accepted: `conflict` (field `noticing_id`), nothing written. An `edge_type` in the proposal that `mind_link` does not know falls back to `related_to`.
- **List.** Shown iff an `extractor_state` row exists with `stage = 'propose'` (the `enabled` flag is not consulted: disabling stops new proposals, and ones already shown stay until decided or expired) the noticing itself was recorded at stage `propose`, and it has not expired (`expires_at > now`). `stage` in the projection is `off` with no row. Sources that are neither a node nor an event of the mind are left out of `sources`.
- **Actor.** A transaction carries a third setting, `app.actor`, beside `app.mind_id` and `app.bearer`: `verb` (the verb runner), `daemon` (the daemon passes), `import` (import-mind), `operator` (the extractor and minds admin CLI), empty otherwise. `withMind(pool, mind, bearer, mode, fn, actor?)` sets it; `VerbContext.actor` exposes it. The identity guards (0018, 0020) do not look at it.
- **Decision guard (`noticings_decision_guard`).** After insert, `payload` and `sources` ("a noticing's payload and sources are fixed") and every other column except `status`, `decided_event_id`, `decided_at` ("a proposal is fixed once made": `id`, `mind_id`, `kind`, `score`, `features`, `model_version`, `stage`, `proposed_event_id`, `expires_at`, `created_at`) are immutable for every connection, admin included; stage 2's re-propose rule inserts a new row rather than updating. The three decision columns change only together and only once: a decided noticing is final and never returns to `pending`. `pending` to `accepted` or `rejected` requires `app.actor = 'verb'` and `app.bearer` = the mind ("only the mind decides what it notices"); `pending` to `expired` requires `app.actor` in (`daemon`, `import`) and `app.bearer` = the mind ("only the mind's own daemon expires a noticing"); there is no admin allowance for expiry any more. Any move out of `pending` needs `decided_event_id` to reference an event of this mind whose `subject_id` is the noticing and whose kind is the matching `notice.accepted` / `notice.rejected` / `notice.expired` ("a decision must reference its own notice.* event"). `mind_notice` also refuses accept and reject unless `ctx.actor === 'verb'` and the bearer is the mind (`forbidden`, "memory is authored by the mind").
- **Insert guard.** `noticings_insert_guard` (BEFORE INSERT): `mind_id` must equal `app.mind_id` and `app.bearer` must equal `mind_id`, else `insufficient_privilege` "noticings are proposed in the mind's own scope". The daemon passes, tests and `import-mind` run as the mind and pass; a write grantee or steward, and a bare connection with no scope, are refused. Status on insert: a row is `pending`; a non-pending row is accepted only as `expired`, or as a decided status carrying its `decided_event_id` ("a decided noticing carries its decision event"), which is what lets import work as the mind without an admin path.
- **State guard.** `extractor_state_guard` (BEFORE INSERT OR UPDATE): a row becomes `enabled` only when `app.actor = 'operator'` ("only the operator enables the extractor"). Import inserts the row disabled. The CLI also checks that its connection can update `extractor_state` and otherwise stops with "extractor commands need the admin DATABASE_URL (the sanctum_app login can only read the extractor's state)"; the actor setting is a marker for code paths, not a defence against someone holding database credentials.
- **Expiry and the operator's stage.** `list` and `mind_health.pending` count only proposals with `expires_at > now`. `accept` of a proposal with `expires_at <= now` is `conflict` ("noticing has expired"; the `notice.expire` pass records it on its next run). `accept` also needs `extractor_state.stage = 'propose'` at that moment (`conflict` "the extractor is not at stage propose", also with no row); `reject` does not. `mind_health.pending` is 0 unless the stage is `propose`. `EXTRACTOR_TTL_DAYS` (src/extractor/config.ts; positive whole number, default 14) is how long a proposal waits; `noticingExpiresAt(now)` computes `expires_at`, and the stage 2 pass that inserts proposals must use it. Nothing reads it yet at stage 1 except the helper and its test.
- **Events carry ids and counts, never text.** Payload shapes are zod `strictObject`s: src/extractor/events.ts for `notice.proposed` (`noticing_id`, `noticing_kind`, `stage`, `score`, `source_count`, `model_version`), `notice.expired` (`noticing_id`, optional `noticing_kind`, `stage`, `expires_at`, and `reason: "imported"` for import) and `notice.model.trained` (`version`, `trained_on`, numeric `metrics`); src/verbs/notice_events.ts for `notice.accepted` (`noticing_id`, `kind`, `sources`, and `edge_id`/`edge_type`/`existing` for a link, `node_id`/`content_event_id`/`edited` for a pattern or distillation) and `notice.rejected` (`noticing_id`, `kind`, `reason`, the mind's own words and the one free-text field). The passes and the verb parse through them before appending, and a test parses every `notice.*` event in the ledger. `notice.*` events are bookkeeping, not memory: `mind_orient` `recent`, `mind_weather` counts, and the event side of `mind_search` and `mind_surface` leave them out. The words of an accepted proposal live in the `pattern` or `distill` event and the node.
- **Accept details.** The noticing row is locked (`for update`); stage is checked before status, so a shadow noticing is `not_found` whatever its status; then status (`conflict`), expiry, the operator's stage. `content` on a link, and `edge_type`/`weight` on a pattern or distillation, are `invalid_input`. A pattern or distillation with no content to default to needs `content` (`invalid_input`). A link naming the same node twice is `invalid_input` on `noticing_id`, naming the duplicate. The runner embeds only `content` passed in the call (`embedText`); when the mind accepts the proposal's own text, the node is stored without a vector and `embeddings.backfill` fills it in. `decided_at` is the decision event's `created_at`. Pattern: a `pattern` event `{noticing_id, label, content, sources, edited}`, the node with `metadata {noticing_id, sources, event_id}` (the pattern event), `instance_of` edges from each live source node with `metadata {noticing_id, event_id}`, then `notice.accepted`. Distillation: the `distill` event `{content, sources, noticing_id}`, the node with `metadata {noticing_id, sources, event_id}` (the distill event), `derived_from` edges to each live source node with the same edge metadata, then `notice.accepted`. Events among the sources are recorded in the metadata only; a source node that is no longer live refuses the accept (`conflict`, "a source was rewritten or retired since this was proposed", the ids named, field `noticing_id`; the node locks are taken first, see Belief repair, Completeness), and the expiry pass expires such a pending proposal with `reason: "source_invalidated"`. `notice.rejected` `{noticing_id, kind, reason}`; `daemon.extractor.<action>` `{action, enabled, stage, schedule, paused, previous}`. Expiry sets `decided_event_id` and `decided_at` like the other decisions.
- **Grants.** `sanctum_app` has select/insert/update on `noticings`, select/insert on `extractor_state` (insert only so import can bring a first row in, disabled; it cannot update the switch) and select/insert on `extractor_models`. The `extractor` CLI runs on the admin URL and writes its `daemon.extractor.*` events as the mind, directly (it has no sinks configured, so those events are not queued to the outbox).
- **CLI.** `enable` keeps an existing stage and schedule when the flags are omitted (first enable: `shadow`, `03:00`) and clears a pause; an action that would change nothing writes nothing (`changed: false`); `pause`, `resume` and `stage` need a row (`enable` first). `report` computes precision over noticings recorded at stage `propose` only, as accepted / (accepted + rejected + expired); shadow noticings are shown in the counts but never scored, since the mind never saw them.
- **Import.** Every imported noticing gets an explicit status. `expired` ones, and `accepted` or `rejected` ones that carry their `decided_event_id`, keep it (history and training signal; an accepted one has its node in the file). Everything else (`pending`, a missing or unknown status, a decision without its event) arrives `expired` with a `notice.expired` event written as the mind (payload `{noticing_id, reason: "imported"}`, a fixed id per noticing so a re-run writes no second event), set as its `decided_event_id`; the notes count them. `extractor_state` arrives with `enabled = false` and `stage = 'shadow'` whatever the file said (the operator re-enables it and chooses the stage); if the target already has a row it is left as it was and a note says so. Models arrive as they are. Import runs with `actor = 'import'`.
- **`mind_health`.** `pending` counts only noticings the mind may see (stage `propose`, status `pending`, not expired) and is 0 unless the operator's stage is `propose`; `stage` is `off` with no row; the spec's `last_run` is replaced by `paused`, since `extractor_state` has no last-run column.
- **Migrations test.** 0021 is not pinned in test/migrations.test.ts (only applied files are, per "Migrations are immutable"); pin it when it is final.
- **Stale expiries are not judgements.** A proposal that expired with `reason: "source_invalidated"` (a node it cites was rewritten or retired) is left out of `notice.train`, like an imported expiry, and out of `extractor report`'s precision and per-kind acceptance; the report shows their count apart as `stale`.

### Stage 2 implemented: candidates, reranker, scorer, training, scheduling

Built: migration 0022_extractor_runs.sql; `src/rerank/` (`types`, `none`, `http`, `local`, `index`); `src/extractor/` `features.ts`, `prior.ts`, `scorer.ts`, `candidates.ts`, `schedule.ts`, `extract.ts` (pass `notice.extract`), `train.ts` (pass `notice.train`); `EXTRACTOR_REPROPOSE_DAYS`, `EXTRACTOR_MAX_CANDIDATES`, `RERANKER`, `RERANK_URL`, `RERANK_API_KEY`, `RERANK_CACHE_DIR`; the shadow report; `extractor_runs` in export, import and purge. Tests: test/extractor.test.ts (47) and test/rerank.test.ts (16); test/extractor_guard.test.ts is unchanged and scans the new files. The stage 1 "Not built" list is now built, except that the `local` reranker has not been run against the real model here (see Deviations).

**The passes and the daemon.** `PASSES` stays the eleven deterministic ones (`notice.expire` last). `MODEL_PASSES` = `notice.extract`, `notice.train`; `ALL_PASSES` = `PASSES` then `MODEL_PASSES`, what a normal tick and `daemon --once` run (thirteen pass reports per mind; `mind_health` tallies thirteen). `EXTRACTOR_PASSES` (src/extractor/index.ts) = `notice.expire`, `notice.extract`, `notice.train`. Both new passes are gated the same way: the extractor must be enabled and not paused, `now` must have reached today's `schedule` (HH:MM, service local time: the process time zone), and `extractor_runs` must hold no run of that pass (not a skip, not an imported row) that started on today's local date, wherever the schedule sits: moving the schedule later in the day does not run the pass twice. A tick that fails any of these returns a note and writes nothing. A mind that was suspended is not listed by the daemon at all.

**`notice.extract`** is a detached pass (like `outbox.deliver`): it holds no transaction and no advisory lock while the reranker works. (1) One read-only transaction as the mind (actor `daemon`): the gate, the window, the candidates, the existing noticings, the scorer. (2) Rerank, no transaction. (3) One write transaction under the per-mind daemon lock: the gate and the dedupe are checked again against what is there now, each proposal is inserted with its `notice.proposed` event, and the run is recorded. `DetachedPassContext` gained `embedder`, `reranker` and `inTx(mode, fn)` (the runner builds the `PassContext`), and `DaemonDeps` gained `reranker` (default none). Time: a row is **new** when its `created_at` is at or after the `started_at` of the last `extract` run that completed (not a skip, not imported), never earlier than seven days before `now` (a first run: seven days). New rows are compared against every eligible row from the lookback, `EXTRACTOR_LOOKBACK_DAYS` (default 30; at least back to the new start), and **every candidate must contain at least one new row**; clusters may mix new and older rows. A metabolized `sit` resolved since the new start counts as the new fact for its own distillation. There is no upper bound on `created_at`. Candidates are built only from rows the mind wrote itself (`written_by` = the mind), at most the newest 400 events and 400 nodes of the lookback. One eligibility filter applies to every row the pass reads, including the subjects of metabolized sits and their related events: events must have text (`payload.text` or `payload.content`) and a vector and must not be of kind `notice.*`, `daemon.*`, `letter.*`, `pattern` or `distill`; nodes must be live, have a vector and not be of type identity, vow, anchor or desire. A sit subject without a vector makes no distillation.
- `link`: a pair of eligible nodes (at least one new) with cosine >= 0.6 and no edge between them in either direction. Never a node and an event. `payload = {edge_type: "related_to", reason: "cosine 0.74; shared context \"x\""}` or `"...; no shared context"`.
- `pattern`: greedy clusters of 3 to 12 eligible events (at least one new), every pair >= 0.55 (newest event seeds, nearest first, an event is in at most one cluster); or 3 or more events sharing a context and one charge tag (one group per context and tag; the 12 newest). `payload = {label, summary, window: {start, end}}` (`window` is the span of the sources' `created_at`, the period it recurred across): `label` is the four commonest terms (words of three or more letters, a short stop list removed, ties by first appearance) of the first lines of the sources, joined by ", ", at most 80 characters, or the opening of the first source when there are none; `summary` is the first 240 characters of each source joined by " / ", at most 1000.
- `distillation`: clusters of 2 to 12 eligible events (at least one new) with salience active or foundational (>= 0.7), pairwise >= 0.55; or any subject of a `sit` that holdings records as `metabolized` since the window start (an event or a node) together with up to four window events at cosine >= 0.55 to it. `payload = {content: <the same summary>, lineage: {noticing_source_event_ids: [...]}}` (the ids among the sources that are events).
- Dedupe, before the cap: a candidate with the same kind and source set (sorted) as a pending, accepted or rejected noticing is skipped. An expired one holds the source set back until `EXTRACTOR_REPROPOSE_DAYS` after its `expires_at`, and then the new score must be higher than the expired noticing's (the latest one, if several), else the run notes "N expired source set(s) were not proposed again: their score had not risen". A proposal re-made this way is a new row; the expired one stays. Shadow-stage noticings that expired count as nothing (the mind never saw them) and do not hold a source set back; shadow-stage ones still pending do.
- Cap: after dedupe, the best `EXTRACTOR_MAX_CANDIDATES` per kind by a cheap rank (the cosine feature, plus 0.02 per source for clusters), ties by key.
- Rerank: query = the first source's first 240 characters (first = oldest); documents = the other sources' text (up to 600 characters each); the candidate's rerank is the mean of the scores that came back, null when none did (a one-source distillation has no documents). Sequential calls; after three calls in a row that return no scores the rest of the run goes without (a dead endpoint would cost 10 seconds a call). With the `none` reranker nothing is called and the run notes "reranker none: candidates scored on cosine and the other features only".
- Insert: `noticings` row `status pending`, `stage` = the operator's stage at that moment, `score`, `features`, `model_version` = the scorer used, `expires_at = noticingExpiresAt(now)`, `created_at = now` (the pass's clock), and a `notice.proposed` event `{noticing_id, noticing_kind, stage, score, source_count, model_version}` whose `subject_id` is the noticing. Nothing else is written to the ledger.
- Skips, with a note and no noticings: not enabled; paused; not due; already ran today; `EMBEDDER=none` (the first such tick of the day writes one `extractor_runs` row with `ok = false, notes {skipped: true, reason}`; a skip does not use the day up, so fixing the embedder lets that day's run happen). A failure of any kind (reranker exception, database error) is recorded as `ok = false, notes {error}` with a short message (no row data), returned as the note "failed: ...; tomorrow's run tries again", and does not fail the tick. A reranker that returns nothing is not a failure: the run completes with null rerank scores and says so. A completed run records `ok = true` and notes `{window: {new_since, end}, stage, reranker, rerank_missing, model_version, generated, candidates, proposed, proposed_total, notes}`: counts and short reasons, never memory text.

**Features** (src/extractor/features.ts), named, all in 0..1, stored as `features` on every noticing: `rerank` (0 when there is none), `rerank_missing` (0 or 1), `cosine` (link: the pair; otherwise the mean pairwise cosine of the sources that have vectors, 0 if none), `recency_days` (mean age of the sources in days, capped at 30, divided by 30), `shared_context` (1 when every source has the same non-empty context), `charge_overlap` (Jaccard: charge tags on every source over tags on any, 0 with none), `cooccurrence` (the number of sessions shared by at least two sources, capped at 5, divided by 5; sessions only, because a shared context is the feature `shared_context` and must not count twice; a node's session is that of the event it was observed from), `salience_mean` (foundational 1, active 0.7, background 0.4, archive 0.1, unset 0.4), `source_count` (capped at 10, divided by 10), and the one-hot `kind_link`, `kind_pattern`, `kind_distillation`. Twelve in all, in that order. A thirteenth, `attended` (0 or 1: any source is a node or event the mind pinned or that one of its top-12 attention items rests on), was added with migration 0024 (see "Attention"), last in the order. A stored `features` row without it, and a model whose weights lack it, read it as 0: `featureVector` reads a missing feature as 0 and `parseWeights` a missing weight as 0, so a model trained before `attended` ignores it until the next refit (which starts from the prior, and so from `attended` = 0.3).

**Scorer** (scorer.ts, prior.ts): `score = sigmoid(bias + sum(weight_i * feature_i))`. `extractor_models.weights` is `{bias, weights: {<feature>: number}}`; the scorer takes the mind's highest version whose weights parse, else the prior (version 0, in code, with a comment per weight). A row that does not parse (an old or imported one) is skipped. The prior: bias -3, rerank 3.0, cosine 2.5, rerank_missing 1.5 (about half the rerank weight, so a mind with no reranker is not ranked as if every candidate were judged irrelevant), charge_overlap 0.6, salience_mean 0.5, shared_context 0.4, cooccurrence 0.4, source_count 0.3, recency_days -0.5, kind biases 0, attended +0.3 (added with Attention: a mild nudge for what the mind is already looking at; a model lacking the weight counts it as 0).

**`notice.train`**: a deterministic pass, once a day after extract, with its own `extractor_runs` row. Rows used: this mind's noticings that were shown to it (`stage propose`) and decided, with recorded features, excluding imported expiries (decision event reason `imported`): accepted 1, rejected 0, expired 0 at weight 0.5, in `created_at` order. Fewer than 30, fewer than 5 accepted, or fewer than 5 rejected or expired: no model, a note and a `trained: false` row with the reason. Held-out: every 5th row (the 5th, 10th, ...); the rest train. Fit: full-batch gradient descent on the weighted log loss, 200 epochs, step 0.5, from the prior, with an L2 penalty of 0.05 pulling each weight toward the prior's (not toward zero); no randomness, so a refit from the same decisions gives the same weights. Metrics on the held-out rows, all numbers: `precision_at_5`, `log_loss`, `n` (held-out), `n_train`, and the same two for the model that was in use (`previous_precision_at_5`, `previous_log_loss`). A new `extractor_models` row (version = max + 1, `trained_on` = rows trained on, `event_id` = the event) and a `notice.model.trained` event `{version, trained_on, metrics}`; old rows are never changed or deleted (the app role has no update or delete on the table).

**Operator surface.** `extractor report` adds `shadow_last_30_days` (what shadow mode recorded, by kind), `acceptance_by_kind` (stage propose, accepted / decided), `model` (latest version, trained_on, metrics; null while the prior is in use) and `last_runs` (the latest `extractor_runs` row per pass); the text report prints all of them. `mind_health.extractor` gains `last_run: {pass, started_at, ok, skipped} | null` (the last `notice.extract`). `daemon --once` prints the notes of the two model-backed passes. `EXTRACTOR_REPROPOSE_DAYS` (positive whole number, default 60), `EXTRACTOR_MAX_CANDIDATES` (1 to 500, default 50), `EXTRACTOR_LOOKBACK_DAYS` (1 to 365, default 30), `EXTRACTOR_TTL_DAYS`, `RERANKER` (`none|local|http`, default none) and `RERANK_URL` are validated when the daemon starts (`startDaemon` and the `daemon` command): an invalid value stops it. The `http` reranker's scores outside 0..1 are read as logits and squashed, per call (a batch of all-in-range scores is used as given). `RERANK_URL` carrying credentials (`user:pass@`) is refused, as for sinks. `RERANKER=http` sends the mind's words (up to 240 characters of the first source, up to 600 of each other source, per candidate) to the operator's URL: trusted like a sink, said in README and SECURITY.

**`extractor_runs`** (migration 0022): `(mind_id, pass, started_at, finished_at, ok, notes jsonb)`, primary key `(mind_id, pass, started_at)` (a new row is placed one millisecond after the latest if it would collide), `pass` in (`notice.extract`, `notice.train`), RLS FORCE like the others, `sanctum_app` select and insert only. Export carries it (`extractor_runs`, keyed by pass and start). Import brings it in marked `notes.imported = true` (the schedule gate and the window ignore such rows); rows whose `started_at` is after the time of the import are not imported and are counted in the notes. Import also renumbers `extractor_models` to continue after the target's latest version, keeping the original in `metrics.imported_from_version` (a note says so; a second import of the same file recognises its rows and adds none). Purge removes it (generic over `mind_id` tables).

Deviations from the stage 2 text, and why:
- **No `deriveLabel`.** The static guard allows only `{ appendEvent }` from `../verbs/common.js`, so the label is made by `termsLabel` in candidates.ts (the same whitespace collapse and code-point cut).
- **`notice.extract` is detached, not a plain transactional pass,** so no pooled connection or advisory lock is held while a reranker (10 seconds a call) works. `notice.train` is transactional (pure arithmetic).
- **Recency.** The feature is age, so "recency mild positive" is a negative weight on `recency_days` (-0.5).
- **Training set.** Shadow-stage noticings, imported expiries and rows with no features are excluded (the mind never saw them), and the fit starts from, and is regularised toward, the hand-set prior rather than zero, so a few dozen decisions move the weights only as far as they push. `trained_on` is the number of rows fit (the held-out ones are not part of it).
- **Dedupe.** An expired shadow noticing does not gate; an expiry's age is measured from `expires_at`, not from when the pass noticed.
- **Daemon reports.** A normal tick now reports thirteen passes per mind (two are "skipped" notes for a mind without an extractor). test/daemon.test.ts expects thirteen for default runs and still eleven for an explicit `PASSES` run.
- **Lookback (verifier decision).** The spec's "window since the last run" became new rows (since the last run) compared against a 30-day lookback, so patterns recur across days and a re-proposal after expiry is reachable. Consequence: a growing cluster (three old rows plus one new) is a different source set and can be proposed again; only an identical set is deduped. Because a candidate needs a new row and a row is new only until the next completed run, an identical source set can come back for re-proposal only when a member was written after the last completed run began: in practice after failed or skipped days, or a reset run history. The expiry rule is tested by moving the sources' timestamps; the lookback itself is tested by links and patterns that mix new and older rows.
- **Deployment.** Compose passes `EXTRACTOR_*` and `RERANK_*` to the daemon only; the image sets no `RERANK_CACHE_DIR` and has no rerank volume, because the `local` package is not in it (use `none` or `http` under Docker).
- **Catch-up.** A pass runs on the first tick after the scheduled time on a day it has not run; enabling the extractor in the afternoon with schedule 03:00 therefore runs it on the next tick. A day the daemon is down is not made up.
- **`local` reranker not verified here.** `@huggingface/transformers` 4.3.1 is on the registry and installs with `--ignore-scripts` (its API, `AutoTokenizer` and `AutoModelForSequenceClassification`, was confirmed to load), but its pinned `onnxruntime-node` 1.30.0 postinstall download failed through the proxy, and huggingface.co is blocked there, so the model could not be downloaded or run. It is not added to package.json or the lockfile (it pins a different `onnxruntime-node` from fastembed's 1.21.0); `local` loads it dynamically and, if it is absent or fails, warns once and returns null scores. Its loader is unit-tested with a stand-in module.

## Belief repair (migrations 0023_repair.sql and 0025_repair_work.sql, src/extractor/repair.ts, mind_notice kind repair)

When a node is superseded (`mind_rethink`, a settled identity rewrite) or retired (a settled `mind_identity retire`), the nodes and events that depended on it are not touched. Belief repair is the proposal that they be looked at. It uses the noticing machinery and inherits every rule of it: proposal-only, the mind decides, the operator cannot accept, fully ledgered, sources never modified by the proposal itself.

**Dependants.** For an upstream node U (one that was superseded with `superseded_by`, or retired), a dependant D is a live node written by the mind itself that rests on U by one of these relations. The direction matters: a dependency is something D rests on, so the edge runs from D to U.

| Relation | Direction | Score |
|---|---|---|
| `derived_from`, `instance_of`, `corrects` edge | D -> U only | 1.0 |
| `metadata.sources` of D holds U | n/a | 1.0 |
| D was made from a noticing (`metadata.noticing_id`) whose `sources` hold U | n/a | 1.0 |
| the replacement chain: D answered for U's predecessor (a repair's rethink, or a keep that recorded its replacement) and U is that replacement | n/a | 0.8 |
| `supports`, `contradicts` edge | either direction | 0.6, "low-confidence review" (the reason text says so) |
| `related_to`, any unknown edge type (`revien:*` included), the reverse of a dependency-direction edge (U -> D `derived_from`, `instance_of` or `corrects`) | any | never a repair: context only |

Context-only edges that touch U are listed in the proposal's payload as `context_edges` (edge ids, ordered by id, at most 5). Events are reported in the payload as context (`context_event_ids`) but are never dependants (the ledger is append-only). When several relations apply to one D, the first of `derived_from`, `instance_of`, `corrects`, `sources`, `noticing`, `replacement`, `supports`, `contradicts` is reported, so the best score applies.

**Proposal.** `noticings.kind` gains `'repair'` (0023 replaces the check constraint; `noticings.kind` is immutable so no existing row changes). One noticing per (U, D) pair: `sources = [D, U]` (dependant first), `payload = {upstream_id: U, upstream_state: 'superseded'|'retired', replacement_id: <superseded_by or null>, dependant_id: D, dependant_type: D.node_type, relation: <edge type or 'sources'|'noticing'>, reason: <template, no memory text>}`, `score` = 1.0, 0.8 or 0.6 by the table under Dependants (no model; repair is deterministic), `stage` = the mind's extractor stage **but repair proposals are always shown at stage propose or shadow alike**: they do not go through the trial, because they report a fact about the graph, not a judgement. Concretely `stage='propose'` is written on every repair row regardless of extractor_state, and `list`/`orient` show them even when the extractor is disabled (the daemon pass `notice.repair` runs whenever the daemon runs; it is deterministic and part of the deterministic list, the twelfth). Dedupe by (kind, sorted sources) as for other kinds; a dependant decided `keep` is not re-proposed for the same U.

**Deciding** (`mind_notice accept`, mind-only, actor verb, as for every kind) takes `decision: 'keep' | 'rethink' | 'retire'`:
- `keep`: the dependant stands. Event `repair.kept` (subject D, payload {noticing_id, upstream_id}); D's metadata gains `repair_reviewed: [{upstream_id, event_id, at}]` (append). Nothing else changes. (It is an acceptance of the proposal to look, with the answer "it holds".)
- `rethink`: requires `content` (the mind's new wording; `label` optional). D is superseded exactly as `mind_rethink` does (same helper `supersedeNode`, reason `repair of <upstream_id>`, provenance {noticing_id, upstream_id, replacement_id}); event `repair.rethought` (subject D, payload {noticing_id, upstream_id, node_id: <new>}) plus the ordinary `rethink` event the helper writes. Refused with `conflict` and the identity message when D is an identity or vow node: those go through `mind_identity propose` / `retire` with cooling; the proposal is then left pending until the mind decides it `keep` or until it expires.
- `retire`: D is invalidated (`invalidated_at = now`, metadata `{retired: true, retired_at, retired_reason: 'repair of <upstream_id>', repair_noticing_id}`), no replacement; event `repair.retired` (subject D). Refused for identity/vow nodes as above.
Each path also writes `notice.accepted` with `{noticing_id, kind:'repair', decision}` and sets the noticing accepted with that event, per the decision guard. `reject` means "leave it": a repair that was put to the mind, whatever became of it (rejected, or expired unanswered), is final for that (upstream, dependant) pair and is never proposed again; this differs from the extractor's own kinds, which may come back after `EXTRACTOR_REPROPOSE_DAYS` if their score rose.

**Pass `notice.repair`** (deterministic; `src/extractor/repair.ts`, subject to the static and runtime guards: it writes noticings and `notice.proposed` only, plus the progress columns of `repair_work`): it does not scan timestamps. Each tick, under the per-mind daemon lock, it takes the undone `repair_work` rows oldest first; for each it computes the dependants (the direction policy above), leaves out the ones already put to the mind, and proposes up to 25 repairs per upstream within the tick's total budget (`EXTRACTOR_REPAIR_BUDGET`, default 50); it then records its progress on the row (`next_offset`) or finishes it (`done_at`) and stops when the budget is spent. Expiry: `EXTRACTOR_TTL_DAYS` as for others; a repair of an identity dependant that the mind cannot `rethink` here will expire like any other.

**`repair_work`** (migration 0025): `(id uuid pk, mind_id, upstream_id uuid, upstream_state in (superseded, retired), replacement_id null, created_event_id, created_at, claimed_at null, next_offset int default 0, done_at null)`, unique `(mind_id, upstream_id, created_event_id)`, index `(mind_id, done_at, created_at)`, RLS FORCEd on `mind_id`, app role select/insert/update. Trigger `repair_work_guard` (the insert also checks that `upstream_id` is a node of the mind that is already invalidated; progress moves forward only: `next_offset` never decreases and `claimed_at` is never cleared): INSERT only with `mind_id = app.mind_id` and `app.actor` in (`verb`, `daemon`, `operator`) — scope, not bearer: the invalidation that causes the row was already authorized by the verb runner (a write grantee may rethink the owner's node), and the work row is bookkeeping about it, not an identity act; a bare connection, another mind's scope, import and an unmarked connection are refused. A new row is undone and cites an event of the mind; UPDATE may change only `claimed_at`, `next_offset` and `done_at`, only under actor `daemon` as the mind, and a done row is final.

**Completeness.** Every invalidation has a work row, written in the SAME transaction that invalidates the node: `supersedeNode` (so `mind_rethink`, a settled identity rewrite and a repair's rethink), the retire branch of identity settlement, and a repair's `retire`. Nothing else inserts, except the operator's backfill below. A transaction that has not committed has neither the invalidation nor the work, and one that commits late brings both, so repair is eventually complete regardless of commit timing, clock skew or how long a transaction was held open. The daemon never reads `invalidated_at` to find work. **A done work row is final**, and that is safe because the dependant side is closed too: `linkNodes` (so `mind_link` and a link accept) and every other accept that creates an edge or a node citing sources take the per-node advisory lock `supersedeNode` takes (`node:<id>`, in sorted order) on each cited node BEFORE checking that it is live, so one of two things happens when a link or accept races a rewrite: the rewrite waits for the link's transaction and the edge is found by the repair pass, or the node is already invalid and the link or accept is refused with nothing written (a refused link is `not_found` on `source_id` or `target_id`; a refused accept is `conflict` on `noticing_id`, "a source was rewritten or retired since this was proposed", the dead source ids named). Lock keys are one spelling: `nodeLockKey(id)` and `proposalLockKey(id)` (src/verbs/common.ts) lowercase the id and are the only place the keys are built (`z.uuid()` accepts upper case, and `node:ABC` and `node:abc` would otherwise be different locks), and the shared `uuidSchema` lowercases every id at the schema boundary, so every verb sees lower-case ids. The same holds for the replacement a repair is decided against: `decideRepair` reads the chain from the proposed replacement along `superseded_by` without locks (at most 64 hops), then locks the dependant and every node on the chain in ONE sorted pass (the order `linkNodes` uses, so the two cannot deadlock), then reads the chain again; if it moved while the call waited the call is `conflict` on `noticing_id`, "the replacement chain changed; try again", with nothing written. Otherwise the keep or rethink records the CURRENT replacement (`replacement_id`) and the dependant is asked again when that one is invalidated; the verb runner also re-runs a whole verb once, from scratch, when Postgres reports a deadlock (40P01) or a serialization failure (40001): this is safe because a handler has no effect outside its transaction (embedding happens before it opens, sink deliveries are only queued in the outbox inside it); a chain that ends in a retired node records that node with `replacement_state: "retired"`. No live dependant can therefore come into existence against an invalidated node after that node's row is done. What this does not cover, and needs the explicit backfill: nodes brought in by an import, invalidations made outside the verbs (a Revien graph), and history from before 0025. The expiry pass also expires a pending non-repair proposal that cites a dead node (`notice.expired` with `reason: "source_invalidated"`, ids only).

**Backfill** (explicit; the daemon never does it): `sanctum-mind extractor repair-backfill --mind <id> [--since <ISO date>] [--dry-run]` (admin URL; runs as the mind under actor `operator`, which the insert guard accepts) inserts a work row for every node with `superseded_by` set or `metadata.retired = true` that has none yet, oldest first (`created_at` is the node's `invalidated_at`), and prints the count. The cause cited is the node's own `rethink`, `identity.retired` or `repair.retired` event when the ledger has one, else one `daemon.repair.backfill` event written by the run. Idempotent. Needed once after upgrading to 0025 for rewrites made before it, and after an import (nodes arrive without work).

**Surfaces.** `mind_orient` quick and full: `noticings` already lists pending propose-stage rows; repairs appear there first (at most 3 of the 5 slots when any other proposal is pending, so at least 2 are kept for the others; all 5 when none is) and additionally under `repairs: {pending: n, by_upstream: [{upstream_id, count}]}` (top 5 upstreams by count); `mind_health.extractor.repairs_pending`. `extractor report` counts repairs separately and shows decision rates (keep/rethink/retire).

**Tests (test/repair.test.ts).** Superseding a node with two dependants (edge, metadata.sources) proposes two repairs with the right payloads and no memory text in the event; retiring a core proposes repairs for nodes deriving from it; keep writes the event and the metadata and changes nothing else; rethink supersedes D with provenance and both events, sources untouched; retire invalidates D with the metadata and event; identity/vow dependants: rethink and retire refused with the identity message, keep allowed; dedupe; a dependant kept is not re-proposed for the same upstream; the pass runs with the extractor disabled; shadow stage does not hide repairs; the runtime guard still holds with the pass registered (nodes/edges identical after the pass); RLS; export/import/purge carry repairs like other noticings.

### Implemented

Built: migration 0023_repair.sql; the pass `notice.repair` (src/extractor/repair.ts, the twelfth of `PASSES`, after `notice.expire`; `EXTRACTOR_PASSES` is now `notice.expire`, `notice.repair`, `notice.extract`, `notice.train`); `mind_notice accept` with `decision` and `label` (src/verbs/mind_notice.ts, `decideRepair`); the `repair.kept|rethought|retired` payload shapes and the `repair` kind in src/verbs/notice_events.ts and src/extractor/events.ts; `repairs: {pending}` in `mind_orient` (quick and full); `mind_health.extractor.repairs_pending`; `repairs` in `extractor report`; README, DESIGN. Export, import and purge needed no code: repairs are noticings (a pending one imports as expired, a decided one stays decided). Tests: test/repair.test.ts (32 at 0023; 47 with 0025); the daemon, extractor, notice and orient tests were updated for twelve deterministic passes (a normal tick reports fourteen), the `repairs` section and `repairs_pending`. The whole suite is 785 tests in 28 files (753 in 27 before).

Deviations and settled details:
- **0023 also replaces `extractor_runs_pass_check`** (0022 admits only `notice.extract` and `notice.train`) so the pass can record where its window stopped. `noticings_kind_check` is replaced as specified; no row changes, and `kind` stays immutable.
- **Work, not a window (migration 0025).** The cursor text of 0023 (`through_at`, `through_id`, the 30-day floor, the 30-upstream cap and the one-minute read-back) is gone. The pass reads `repair_work`: up to 500 undone rows a tick, oldest first (`created_at`, `id`), and for each proposes at most 25 repairs (`REPAIR_DEPENDANT_CAP`) while the tick's budget lasts (`EXTRACTOR_REPAIR_BUDGET`, whole number 1 to 10000, default 50, checked at daemon start with the other `EXTRACTOR_*`; compose passes it to the daemon). `extractor_runs` rows for `notice.repair` record `{work_done, proposed, budget_hit}`; a row is written only when there was undone work. **`next_offset` is a progress count** (repairs proposed for the upstream so far), not a cursor: a numeric position in a list that can grow by insertion skips a dependant added before it, so what is left to do is decided by the dedupe (the pairs already put to the mind are dropped from the dependants, in one query per upstream), which makes a resumed row correct whatever was added meanwhile. A row is `done_at` when no dependant is left to propose; a row stopped by the per-upstream cap or the budget stays undone and continues next tick. The dependants of an upstream are ordered by id. Imported `extractor_runs` rows are irrelevant to this pass now.
- **Chains.** A dependant that answered for U is asked again when U's replacement U' is itself superseded or retired: a rethink made by a repair stores `replacement_id` in the new node's metadata, a keep stores it in its `repair_reviewed` entry `{upstream_id, replacement_id, event_id, at}`, and either is a dependant (relation `replacement`, score 0.8) of the node named by `replacement_id`. A repair's rethink or retire invalidates the dependant, which writes its own work row, so what depended on it is asked next.
- **Whose nodes.** Only dependants written by the mind itself are asked about (the extractor's rule: a grantee's words are not the mind's to be asked about). A grantee's node tied to the upstream is skipped.
- **Non-object metadata.** Keep and retire treat a dependant whose `metadata` is not a JSON object (legacy data) as `{}` before writing to it.
- **Upstream** is a node with `invalidated_at` and either `superseded_by` or `metadata.retired = true`; it is an upstream because a work row says so (cause event: the `rethink` event for a rewrite, including a settled identity rewrite, where `identity.settled` follows in the same transaction; `identity.retired`; `repair.retired`). Other invalidations (an imported Revien graph) are not repaired. A write grantee's `mind_rethink` of the owner's node records the work too, with the bearer unchanged: the insert guard checks scope and actor, not bearer, and `recordRepairWork` (src/verbs/repair_work.ts) never touches `app.bearer`.
- **Dependants not asked.** The replacement a supersede made (it has a `corrects` edge to the upstream) is not a dependant. A node that already answered for this upstream is not either: one with `metadata.repair_reviewed` holding it, or `metadata.upstream_id` equal to it (what a repair's rethink writes; `supersedeNode` copies the old node's `metadata.sources`, which would otherwise make the new node a dependant of the same upstream again). A noticing of kind `repair` does not count under the `metadata.noticing_id` rule, for the same reason (the rethink's provenance overwrites `noticing_id` with the repair noticing, whose sources hold the upstream).
- **One relation per dependant.** The order is under Dependants; the score is the best that applies.
- **Payload** gains `context_edges` (see Dependants) and `context_event_ids` (up to five events whose subject is the upstream or, for a retired core, the identity proposal that retired it, the retirement first; not `notice.*`, `repair.kept` or `repair.rethought`) as the "events as context" the spec calls for, and `replacement_snippet` (the first 240 characters of the replacement, null when retired) so the list shows what replaced it. The snippet is the mind's own words and lives in the noticing row only; the `notice.proposed` event carries ids and numbers.
- **Dedupe.** Any repair noticing for a (dependant, upstream) pair, pending, accepted, rejected or expired, holds the pair for good: nothing is proposed again after expiry (the score is fixed, so a "score rose" rule has nothing to act on). `EXTRACTOR_REPROPOSE_DAYS` does not apply to repairs.
- **Deciding.** A repair is not gated by the operator's stage (`accept` of other kinds still needs `propose`). `decision` is `invalid_input` for any other kind and required for a repair; `label` applies to a rethink; `content` is required for rethink and refused for keep and retire. The order of checks is as for the other kinds: shadow (never, for a repair), status, expiry, then the decision. A dependant that is no longer live is `conflict` for every decision (reject clears the proposal). The identity and vow refusal is `conflict` on `decision` with "identity belongs to the mind: use mind_identity propose (rewrite or retire)". In `notice.accepted`, `sources` is optional for a repair (a repair names only its decision and, for rethink, the new `node_id`); zod requires `sources` for the other kinds and `decision` for a repair. `repair.kept` writes `repair_reviewed` entries `{upstream_id, event_id, at}` where `event_id` is the `repair.kept` event.
- **List and surfaces.** `mind_notice list` puts repairs first (ahead of any score) and shows them with the extractor off, disabled or at shadow; every other kind is as before. `stage` in the projection is still the operator's. `mind_health.extractor.pending` no longer counts repairs; `repairs_pending` does. `notice.*`, `repair.kept` and `repair.rethought` are bookkeeping: left out of `mind_orient` `recent`, `mind_weather` and the event side of search and surface. `repair.retired` is a change to memory and is not left out; `repair.rethought` is paired with the ordinary `rethink` event, which is shown.
- **Report.** `extractor report` leaves repairs out of `all_time`, `last_30_days`, `precision` and `acceptance_by_kind`, and the scorer's training (`notice.train`) never reads them. Its new `repairs` block has the total, counts by status, the last 30 days, the accepted decisions (keep, rethink, retire) and the share of decided repairs that went each way, rejected and expired included; `last_runs` lists `notice.repair`.

## Attention (migration 0024_attention.sql, verb mind_attend, src/verbs/attention.ts)

Attention is a read-side answer to "what is this mind carrying right now", computed deterministically from projections the mind already writes, plus explicit pins. No model, no proposals, nothing automatic beyond arithmetic.

**Items.** Candidates are the mind's own live things: open loops, active threads, open tasks, live desires, open identity declarations (cooling rewrites/retirements/vow breaks), pending propose-stage noticings (repairs included), charges in `active` or `processing` (via `mind_sit`), and anything pinned. Each item has `type`, `id`, `label` (its own label/title/section), `since` (created or last touched).

**Weight** (0..1, documented in `src/verbs/attention.ts` with one comment per term): `w = clamp(0.35·recency + 0.25·charge + 0.20·kind + 0.20·pin)` where recency = exp(−age_days/7) over `since` (last touch wins: a loop resolved-then-reopened counts from the reopen), charge = the item's own charge/salience where it has one (loops: burning 1.0, nagging 0.5; tasks: urgent 1.0, high 0.7, normal 0.4, low 0.2; declarations 1.0 while cooling; noticings: score; threads: priority as tasks; desires: intensity/10; sits: processing 0.8, active 0.6), kind = a fixed per-type prior (declaration 1.0, loop 0.9, sit 0.8, task 0.7, repair 0.7, thread 0.6, desire 0.5, noticing 0.4), pin = 1.0 when pinned else 0. Ties break by `since` desc then id.

**Pins.** `attention_pins(id uuid pk, mind_id text not null, item_type text not null check in (loop,thread,task,desire,declaration,noticing,node,event), item_id uuid not null, note text null, pinned_event_id uuid not null, pinned_at timestamptz not null, released_event_id uuid null, released_at timestamptz null)`, RLS FORCEd on mind_id, app role select/insert/update; unique partial index on (mind_id, item_type, item_id) where released_at is null. Trigger: insert and release only when `app.bearer = mind_id` and `app.actor = 'verb'` (pins are the mind's; a grantee may read the attention set with read scope but never pin). A pinned `node` or `event` is an item of its own (label = node label / event kind + first 80 chars), charge = its texture salience or 0.5.

**Verb `mind_attend`** (region State). `operation`: `list` (read scope; `limit` default 12, max 50; projection `{items:[{type, id, label, weight, since, pinned, note?}], pins:[{pin_id, item_type, item_id, note, pinned_at, stale}], stale_pins: n}`; a pin is `stale` when the thing it names is gone, no longer live or no longer an attention item; `release` by `pin_id` clears it), `pin` (mind-only, actor verb; `item_type`, `item_id`, optional `note`; verifies the item exists and is the mind's and is live; `conflict` if already pinned; event `attend.pin` subject item_id payload {pin_id, item_type, item_id, note}, the pin's id generated before the event is written), `release` (mind-only; by `item_type`+`item_id` or `pin_id`; event `attend.release` payload {item_type, item_id, pin_id}; `not_found` when no live pin). Pinning never changes the item.

**Surfaces.** `mind_orient` quick and full gain `attention: {items: top 7, stale_pins: n}` (before `noticings`; the pins themselves are in `mind_attend list`); `mind_weather` gains `attention_load: {items: n, pinned: n, top_weight, repairs_pending: n, repairs_not_shown: n}` (`repairs_pending` is the total of pending repairs; `repairs_not_shown` those left out of `items` by the 3-repair cap). The extractor's candidate generation treats a pinned node or event, and the sources of any top-12 attention item that is a node/event, as "new" for the current run (so attended things get noticed sooner); feature `attended` (0/1) is added to the feature list with prior weight +0.3, documented; models trained before this feature existed treat it as 0 (scorer tolerates missing weights = 0; say so in CONTRACTS Stage 2 and in prior.ts).

**Tests (test/attention.test.ts).** Weight arithmetic on fixed inputs with an injected clock (exact numbers for three items); ordering and tie-break; each item type appears with the right label and charge; a resolved loop / archived thread / done task / fulfilled desire / settled declaration / decided noticing drops out; pin and release are mind-only (write and steward grantees forbidden, trigger refuses raw SQL), pinned items float with pin=1.0, a pinned node/event appears, release drops the pin term, `conflict` on double pin, `not_found` on release of nothing; orient and weather shapes; extractor `attended` feature set for a pinned source (one extract run in the test harness with the fake embedder); RLS; export/import/purge carry `attention_pins` (import keeps live pins as live; they are the mind's own, and pin events exist in the ledger being imported).

### Implemented

Built: migration 0024_attention.sql (`attention_pins`, its partial unique index, `attention_pins_guard`, RLS FORCE, grants); src/verbs/attention.ts (the weight, the per-type collectors, `collectAttention`, `attendedIds`, `attentionLoad`); the verb `mind_attend` (src/verbs/mind_attend.ts, the 26th verb, region State); `attention` in `mind_orient` quick and full, before `noticings`; `attention_load` in `mind_weather`; the extractor's `attended` feature (features.ts, prior.ts, candidates.ts, extract.ts) fed by `PassContext.attendedIds` (daemon); `attention_pins` in export, import and purge; README, DESIGN. Tests: test/attention.test.ts (36); the verb list in test/http.test.ts, the section order in test/orient.test.ts, the feature list and a hand-built `Item` in test/extractor.test.ts and the projection list in test/portability.test.ts were updated. The whole suite is 821 tests in 29 files (785 in 28 before).

Where the implementation settled something the text above leaves open, or differs from it:
- **Weight.** Exactly `clamp(0.35*recency + 0.25*charge + 0.20*kind + 0.20*pin)`, one comment per term in attention.ts (`W_RECENCY`, `W_CHARGE`, `W_KIND`, `W_PIN`, `RECENCY_DAYS`, `KIND_PRIOR`, the charge tables). Weights are rounded to six decimals before sorting and before they are returned, so float noise never decides an order; ties break by `since` desc, then id (a tie at six decimals between two items a millisecond apart goes to the newer). A pinned bare node or event is not in the kind table: it takes the neutral 0.5 (the pin term is why it is listed).
- **Item types in the list.** `type` is one of loop, thread, task, desire, declaration, noticing, **repair** (a noticing of kind repair, pinned as a `noticing`), **sit** (a node or event in active or processing, pinned as that node or event), node, event. **One thing is one item, by typed identity.** A desire, a vow with a declared break, a held charge (sit) and a pinned node or event can be the same node or event, so they resolve to ONE item (`mergeByThing`); the merge key is the thing's typed identity (`node:<id>` for a desire, a vow with a declared break, a held node or a pinned node; `event:<id>` for a held or pinned event), never a bare uuid. A loop, thread, task, noticing or proposal declaration has an id of its own table and is its own namespace: it is never merged with a node, or with another table's row, whose id happens to be equal (tested with a loop and a desire node that share a fixed uuid). The type label that wins is declaration > desire > sit (> node, event) and its label comes with it; `since` is the later of the two; charge and kind prior are the higher of the two (so a sit on a desire carries the sit's 0.8 kind prior, not the desire's 0.5); sources and pin types are the union. A desire is named by pin types `desire` and `node`, a vow with a declared break by `declaration` and `node`, a sit by the node or event it holds; any live pin of one of those types marks the item pinned (pin term 1.0), and a pin of type `node` on a desire or vow marks the existing item instead of adding a second. Only a pinned node or event that no other item stands for becomes an item of its own. `attention_load.items` counts items once. A pin whose thing is no longer live (resolved loop, archived thread, settled declaration, decided noticing, invalidated node) adds nothing to the list but stays a live pin, and is counted in `pins`, until released. `pin` itself needs the thing live (`not_found` otherwise), found by the same collector the list uses.
- **Liveness.** Loops: unresolved. Threads: active. Tasks: open, in_progress, blocked. Desires: live, not fulfilled, not faded. Declarations: proposals with status `accepted`, not settled, not withdrawn; and live vows with a declared break (its id is the vow's). Noticings: pending, recorded at stage propose, not expired; repairs whatever the extractor's state, every other kind only while the operator's stage is propose (what `mind_notice list` shows). Sits: holdings in active or processing whose node is live (an event always).
- **Charge.** Desires: `mind_desire` stores intensity as 0..1, so the charge is the intensity itself (the text's "intensity/10" assumed a 0..10 scale; a stored value above 1 is divided by 10). Threads use the task table without urgent (high 0.7, normal 0.4, low 0.2). Events and nodes read `texture.salience` (events) or `metadata.texture.salience` (nodes).
- **`since`.** Loops: creation (a loop is only ever created and resolved; there is no reopen to follow). Threads and tasks: `updated_at`. Desires: creation. Proposal declarations: `created_at`; vow breaks: `break_declared.declared_at`. Noticings: `created_at`. Sits: the holding's `updated_at`. Pinned nodes and events: `created_at` (pinning is not a touch).
- **Caps.** Each collector reads the newest 500 of its type (`CAP_PER_TYPE`); older ones have long since decayed. **Anything pinned is literally in the set:** every typed collector (loops, threads, tasks, desires, declarations, noticings) also returns the mind's live pinned ids of its type whatever the cap (a second, id-filtered query for the ones the cap left out; desires and declarations also take `node` pins). Repairs have their own query and limit, so a flood of them cannot push other proposals out of the 500 cap: the `noticings` collector leaves repairs out, and a `repairs` collector takes the `REPAIR_ITEMS_MAX` (3) best by score, then newest (a pinned repair is added through its pin). `attention_load.repairs_pending` is `count(*)` of the pending repairs the mind may see; `repairs_not_shown` is that count less the repair items, so a rewrite with many dependants cannot take over the list.
- **Query shape.** One query per item type (declarations are one union query), one for the live pins, one more for a type whose live pins fell outside its cap, and one each for pinned nodes and events not already items. `liveItem` reuses a collector with an id filter to validate a pin.
- **Mind-only.** `mind_attend` pin and release are `mindOnly` with the message "attention is directed by the mind" (`ATTENTION_MIND_ONLY`), and the handler also requires `actor = 'verb'`. `list` is read scope (a `steward` grant alone does not satisfy it). A pin's `note` is up to 1000 characters; `release` takes `pin_id` or `item_type` + `item_id`, not both. `attend.pin` payload is `{pin_id, item_type, item_id, note}` (the verb makes the pin's id first); `attend.release` is `{item_type, item_id, pin_id}`; both have `subject_id` = the item. `list` returns every live pin with a `stale` flag and `stale_pins`; a stale pin is released by its `pin_id`.
- **Trigger (`attention_pins_guard`; replaced in migration 0025, which binds the events to the pin).** INSERT needs `app.bearer` = `mind_id` = `app.mind_id` and `app.actor` in (`verb`, `import`), `pinned_event_id` naming this mind's `attend.pin` event whose subject is the item and whose payload `item_type`, `item_id` and `pin_id` equal the row's type, item and id (so one event cannot serve two pins, and an old-shape event without `pin_id` is refused). A verb insert must be live. **Import exception (decided):** under actor `import` the row may also arrive released (`released_at` and `released_event_id` together, the latter naming this mind's `attend.release` event for this pin and item). The same checks apply under import: pins come with their events in the file. UPDATE is a release and nothing else, by the mind under actor `verb` only (import cannot release): every other column compared null-safely, once, `released_event_id` naming this mind's `attend.release` event for the item (subject, payload `item_type`, `item_id` and `pin_id` match this pin). There is no DELETE trigger: the app role has no delete grant, and `purge_mind` (admin) must delete a mind's rows.
- **Import.** `attention_pins` is a projection after `extractor_runs`; live pins arrive live, released ones released, with their events (the ledger is imported first). A pin's `item_id` is checked against the table its `item_type` names in the same file (loops, threads, tasks, proposals or nodes, noticings, nodes, events); one that names nothing in the file is refused as `skipped_foreign_ref`. The cross-mind id check applies to pins like every id-keyed table (a pin id that belongs to another mind aborts the import) and is made BEFORE the same-item filter: a file's live pin that would be dropped because the target already holds a live pin on the item is first probed with an insert that conflicts only on its id, so a foreign id cannot hide behind that filter. What is tolerated is only a clash on the partial unique index for the same mind: the file's live pin for an item the target already holds is not brought in and is counted as already present, whatever its id (when that id is free or the mind's own). `noticings` joined the set of tables a generic `*_id` reference may name; a `desire` pin must name a desire node of the file and a `declaration` pin a proposal or a vow node of the file. A pin on an open declaration (arrives withdrawn), a vow whose break was stripped, or a pending noticing (arrives expired) is live and inert until released; this is said in the import notes of the header, not per row.
- **Extractor.** `PassContext.attendedIds` (optional; wired by the daemon from `attendedIds`) returns the ids of live pinned nodes and events and the `sources` of the top 12 items (a desire: its node and the event that registered it; a sit: the held node or event; a noticing: its sources; a declaration: its target and event; a loop, thread or task: the event that opened it). `loadWindow` marks those rows new (`isNew`) and `attended` whatever their age. They must still pass the eligibility rules, lie inside the lookback and be among the newest 400 of their kind: attention changes what is new, not what is eligible. src/extractor/ imports nothing from src/verbs/ for this (the static guard stands): the daemon passes the function in.
- **Bookkeeping events.** `daemon.extractor.*` and `daemon.repair.backfill` (operator bookkeeping) are left out the same way. `attend.*` are left out of `mind_orient` `recent`, `mind_weather`, the event side of `mind_search` and `mind_surface`, and belief repair's `context_event_ids`, like `notice.*`. The exclusion is defined once, `bookkeepingExcluded()` in src/extractor/events.ts (`notice.*`, `attend.*`, `repair.kept`, `repair.rethought`), and the verbs import it from there.
- **Attention feeds the extractor, and that biases it.** A top-12 attention item makes its node and event sources count as new for the run, which biases the next run toward the same rows; dedupe stops exact repeats only (the same kind and source set), so a growing cluster around an attended row can be proposed again.
- **`attention_load`.** `{items, pinned, top_weight}` for the set at the moment of the call (all live items, not just the top; `pinned` counts items, not pin rows), `top_weight` 0 when empty. It ignores weather's `context` filter and lookback.
- **Orient.** `attention` is `mind_attend list` with `limit: 7`, reduced to `{items, stale_pins}` (the pins themselves stay in `mind_attend list`), composed like the other sections, so a registry without the verb gives `{skipped}`.
- **Pins from before 0025.** `attend.pin` events written before 0025 carry no `pin_id`, so the binding guard would refuse them. Import therefore leaves out every pin whose `attend.pin` event in the file names no `pin_id`, with the note "n pin(s) from before 0025 skipped; re-pin them", and imports the rest of the file (0024 shipped only a day earlier; no deployment is known to carry such pins).
- **Migration 0025 and tests.** The pin-event binding is in 0025 (0024 is committed and unchanged). Tests added to test/attention.test.ts: event/pin binding mismatches for insert and release, import with the same checks, the 501-loop and 501-of-each-type cases, stale pins and release by `pin_id`, the typed merge, the repair item cap, and an import whose foreign pin id would have been dropped by the same-item filter.
