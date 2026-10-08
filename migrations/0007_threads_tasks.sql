-- sanctum-mind v2 hold region, part two: threads (ongoing concerns) and tasks (things to do).
-- Both are projections of events (which carry written_by), so like loops they have mind-only policies.

create table threads (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  label text not null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  tags text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'resolved', 'archived')),
  notes jsonb not null default '[]',
  created_event_id uuid not null references events (id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  resolved_at timestamptz,
  resolution text
);
comment on table threads is 'Ongoing concerns a mind is following, projected from thread events.';

create table tasks (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  title text not null,
  description text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  tags text[] not null default '{}',
  depends_on uuid[] not null default '{}',
  created_event_id uuid not null references events (id),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz
);
comment on table tasks is 'Tasks a mind intends to do, projected from task events.';

create index threads_mind_status_idx on threads (mind_id, status, priority, created_at);
create index tasks_mind_status_idx on tasks (mind_id, status, priority, created_at);

alter table threads enable row level security;
alter table threads force row level security;
create policy threads_mind on threads for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table tasks enable row level security;
alter table tasks force row level security;
create policy tasks_mind on tasks for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on threads, tasks to sanctum_app;
