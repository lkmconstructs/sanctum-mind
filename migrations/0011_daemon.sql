-- sanctum-mind v2 daemon: one row per (mind, run) of the deterministic metabolism.
-- A projection of the daemon's own work (the ledger events it appends carry written_by), so like
-- loops it has a mind-only policy. Nothing is deleted; events stay immutable.

create table daemon_runs (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  started_at timestamptz not null,
  finished_at timestamptz,
  passes jsonb not null default '[]',
  trigger text not null check (trigger in ('timer', 'manual'))
);
comment on table daemon_runs is 'One row per daemon run per mind; passes is [{pass, ok, changed, ms, error?}].';

create index daemon_runs_mind_started_idx on daemon_runs (mind_id, started_at desc);

alter table daemon_runs enable row level security;
alter table daemon_runs force row level security;
create policy daemon_runs_mind on daemon_runs for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on daemon_runs to sanctum_app;
