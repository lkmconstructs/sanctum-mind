-- sanctum-mind v2 core schema. Fresh-database migration; the runner never re-runs it.

create extension if not exists vector;
create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sanctum_app') then
    create role sanctum_app nologin;
  end if;
end
$$;

create table minds (
  mind_id text primary key,
  key_hash text not null unique,
  display_name text,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);
comment on table minds is 'Registry of constructs and their hashed bearer keys, read by auth only and not row-level secured.';

create table grants (
  id uuid primary key default gen_random_uuid(),
  grantor_mind text not null references minds (mind_id),
  grantee_mind text not null references minds (mind_id),
  scope text not null check (scope in ('read', 'write', 'relate', 'letter')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
comment on table grants is 'Scoped permissions one mind gives another, live while revoked_at is null.';

create table events (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  kind text not null,
  subject_id uuid,
  payload jsonb not null,
  texture jsonb,
  context text,
  written_by text not null references minds (mind_id),
  recorded_at timestamptz not null,
  event_time_start timestamptz,
  event_time_end timestamptz,
  event_time_granularity text check (event_time_granularity in ('day', 'week', 'month', 'year', 'fuzzy')),
  created_at timestamptz not null default now(),
  session_id text,
  embedding vector(384),
  seq bigint generated always as identity unique
);
comment on table events is 'Append-only ledger of every change, the only original record in the system.';

create table nodes (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  node_type text not null,
  label text not null check (length(label) <= 512),
  content text not null,
  written_by text not null references minds (mind_id),
  source_type text not null default 'inferred' check (source_type in ('extracted', 'inferred', 'derived', 'corrected')),
  confidence double precision not null default 0.5 check (confidence between 0 and 1),
  pinned boolean not null default false,
  invalidated_at timestamptz,
  superseded_by uuid references nodes (id),
  metadata jsonb not null default '{}',
  recorded_at timestamptz,
  event_time_start timestamptz,
  event_time_end timestamptz,
  event_time_granularity text,
  created_at timestamptz not null default now(),
  last_accessed timestamptz,
  access_count integer not null default 0,
  embedding vector(384)
);
comment on table nodes is 'Curated graph memory with confidence, provenance and soft invalidation.';

create table edges (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  edge_type text not null,
  written_by text not null references minds (mind_id),
  source_node_id uuid not null references nodes (id),
  target_node_id uuid not null references nodes (id),
  weight double precision not null default 0.5 check (weight between 0 and 1),
  confidence double precision not null default 0.5,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
comment on table edges is 'Typed weighted links between graph nodes of one mind.';

create table brain_state (
  mind_id text primary key references minds (mind_id),
  mood text,
  energy text check (energy in ('high', 'medium', 'low', 'depleted')),
  momentum text check (momentum in ('driving', 'steady', 'coasting', 'stalled')),
  register text,
  afterglow text,
  note text,
  last_event_id uuid not null references events (id),
  updated_at timestamptz not null
);
comment on table brain_state is 'Current inner state of each mind, projected from the newest state event.';



create index events_mind_kind_created_idx on events (mind_id, kind, created_at desc);
create index events_mind_subject_idx on events (mind_id, subject_id);
create index nodes_mind_type_live_idx on nodes (mind_id, node_type) where invalidated_at is null;
create index edges_mind_source_idx on edges (mind_id, source_node_id);
create index edges_mind_target_idx on edges (mind_id, target_node_id);

create function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events are append-only: % is not allowed', tg_op using errcode = 'restrict_violation';
end
$$;
create trigger events_no_update_delete before update or delete on events
  for each row execute function events_append_only();

alter table events enable row level security;
alter table events force row level security;
create policy events_mind on events for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true) and written_by = current_setting('app.bearer', true));

alter table nodes enable row level security;
alter table nodes force row level security;
create policy nodes_mind on nodes for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true) and written_by = current_setting('app.bearer', true));

alter table edges enable row level security;
alter table edges force row level security;
create policy edges_mind on edges for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true) and written_by = current_setting('app.bearer', true));

alter table brain_state enable row level security;
alter table brain_state force row level security;
create policy brain_state_mind on brain_state for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant usage on schema public to sanctum_app;
-- The app role reads keys and grants but can never write them; there is no delete anywhere.
grant select on minds, grants to sanctum_app;
grant select, insert, update on events, nodes, edges, brain_state to sanctum_app;
