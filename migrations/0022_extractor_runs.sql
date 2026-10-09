-- sanctum-mind v2: extractor stage 2. A record of each run of the extractor's two scheduled passes, notice.extract and
-- notice.train. The passes run at most once a day per mind at the operator's schedule; this table is how they know whether
-- they already did (the schedule gate), where the next candidate window starts (the last run that completed), and why a
-- run did nothing (notes). It is bookkeeping about the machine, not memory: it holds counts and short reasons, never the
-- mind's words. Rows are appended by the daemon as the mind and never updated or deleted by the app role.
--
-- Primary key (mind_id, pass, started_at): there is no surrogate id, so export and import carry the rows as they are.

create table extractor_runs (
  mind_id text not null references minds (mind_id),
  pass text not null check (pass in ('notice.extract', 'notice.train')),
  started_at timestamptz not null,
  finished_at timestamptz,
  ok boolean not null,
  notes jsonb not null default '{}',
  primary key (mind_id, pass, started_at)
);
comment on table extractor_runs is 'One row per run of notice.extract or notice.train: when, whether it completed, and counts or a short reason in notes. Bookkeeping, not memory.';

alter table extractor_runs enable row level security;
alter table extractor_runs force row level security;
create policy extractor_runs_mind on extractor_runs for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert on extractor_runs to sanctum_app;
