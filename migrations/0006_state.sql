-- sanctum-mind v2 state region: drive levels, short-lived keyed context, and session handoffs.
-- All three are projections of events (which carry written_by), so like brain_state they
-- have mind-only policies. `context` is a lane tag; the empty string is the shared record.

create table drive_state (
  mind_id text not null references minds (mind_id),
  context text not null default '',
  drive text not null check (drive in ('connection', 'continuity', 'competence', 'play', 'care', 'anchor', 'desire', 'autonomy')),
  intensity double precision not null check (intensity between 0 and 10),
  frustration double precision not null check (frustration between 0 and 10),
  satisfaction double precision not null check (satisfaction between 0 and 10),
  baseline_intensity double precision not null default 5 check (baseline_intensity between 0 and 10),
  baseline_frustration double precision not null default 2 check (baseline_frustration between 0 and 10),
  baseline_satisfaction double precision not null default 5 check (baseline_satisfaction between 0 and 10),
  last_event_id uuid not null references events (id),
  updated_at timestamptz not null,
  primary key (mind_id, context, drive)
);
comment on table drive_state is 'Persisted drive levels per lane; values relax toward baselines with a 24 hour half-life when read.';

create table kv_contexts (
  mind_id text not null references minds (mind_id),
  key text not null check (length(key) <= 200),
  value jsonb not null,
  expires_at timestamptz,
  last_event_id uuid not null references events (id),
  updated_at timestamptz not null,
  cleared_at timestamptz,
  primary key (mind_id, key)
);
comment on table kv_contexts is 'Keyed working context with optional expiry, projected from context events.';

create index kv_contexts_active_idx on kv_contexts (mind_id, updated_at desc) where cleared_at is null;

create table handoffs (
  mind_id text not null references minds (mind_id),
  context text not null default '',
  handoff jsonb not null,
  session_id text,
  last_event_id uuid not null references events (id),
  updated_at timestamptz not null,
  primary key (mind_id, context)
);
comment on table handoffs is 'Latest whole-snapshot handoff per lane, projected from handoff.write events.';

alter table drive_state enable row level security;
alter table drive_state force row level security;
create policy drive_state_mind on drive_state for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table kv_contexts enable row level security;
alter table kv_contexts force row level security;
create policy kv_contexts_mind on kv_contexts for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table handoffs enable row level security;
alter table handoffs force row level security;
create policy handoffs_mind on handoffs for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on drive_state, kv_contexts, handoffs to sanctum_app;
