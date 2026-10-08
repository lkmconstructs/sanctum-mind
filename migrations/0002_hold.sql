-- sanctum-mind v2 hold region: what a mind is currently holding, and its open loops.
-- Both tables are projections of events (which carry written_by), so like brain_state they
-- have mind-only policies.

create table holdings (
  mind_id text not null references minds (mind_id),
  subject_id uuid not null,
  subject_kind text not null check (subject_kind in ('event', 'node')),
  state text not null check (state in ('fresh', 'active', 'processing', 'metabolized', 'deferred', 'released')),
  note text,
  last_event_id uuid not null references events (id),
  updated_at timestamptz not null,
  primary key (mind_id, subject_id)
);
comment on table holdings is 'Current charge state of each subject a mind is holding, projected from sit and resolve events.';

create table loops (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  label text not null,
  urgency text not null check (urgency in ('burning', 'nagging')),
  context text,
  created_event_id uuid not null references events (id),
  created_at timestamptz not null,
  resolved_event_id uuid references events (id),
  resolution text,
  resolved_at timestamptz
);
comment on table loops is 'Open and resolved loops a mind is carrying, projected from loop events.';

create index loops_mind_open_idx on loops (mind_id, resolved_at, urgency, created_at);

alter table holdings enable row level security;
alter table holdings force row level security;
create policy holdings_mind on holdings for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table loops enable row level security;
alter table loops force row level security;
create policy loops_mind on loops for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on holdings, loops to sanctum_app;
