-- sanctum-mind v2: metabolism (Voice 2). A stretch of conversation the house hands the mind (mind_metabolise) is queued; the
-- model-backed pass notice.metabolise reads it, in the first person, and PROPOSES two new kinds of noticing: a feeling the mind
-- may keep, and a fact about a person in its life. Both inherit every rule of the noticing machinery (migration 0021): they are
-- made in the mind's own scope, decided only by the mind's own mind_notice call, and never apply themselves.
-- See DREAMING.md, "Metabolism".
--
-- What this file does:
--   1. noticings.kind: the check of 0023 admits link, pattern, distillation and repair. It is dropped and added again with
--      feeling and relation (six kinds). No row changes; the 0021 insert and decision guards apply unchanged.
--   2. extractor_runs.pass: the check of 0027 is replaced to admit notice.metabolise.
--   3. relations.aliases: the names a person is called by (a pet name is an alias, never a fact). Default empty.
--   4. metabolise_queue: one row per stretch waiting for the pass. The row is inserted in the transaction that appends the
--      metabolise.stretch event (mind_metabolise) and names that event.
--        * RLS FORCE on mind_id; select, insert, update for the app role (no delete: purge_mind removes a mind's rows).
--        * unique (mind_id, stretch_event_id); index (mind_id, status, created_at).
--        * metabolise_queue_guard (BEFORE INSERT OR UPDATE), reading sanctum_actor():
--            INSERT needs mind_id = app.mind_id, app.bearer = the mind, and actor 'verb' (a new row is queued) or 'import' (the row
--            arrives done: a stretch from another life is not processed again). stretch_event_id names an event of this mind of
--            kind metabolise.stretch.
--            UPDATE may change only status, done_at and note; queued -> done or failed, one way, with done_at set; under actor
--            'daemon' (or 'import') as the mind. A finished row is final.

alter table noticings drop constraint noticings_kind_check;
alter table noticings add constraint noticings_kind_check check (kind in ('link', 'pattern', 'distillation', 'repair', 'feeling', 'relation'));

alter table extractor_runs drop constraint extractor_runs_pass_check;
alter table extractor_runs add constraint extractor_runs_pass_check check (pass in ('notice.extract', 'notice.train', 'notice.repair', 'dream.generate', 'notice.metabolise'));

comment on table extractor_runs is 'One row per run of notice.extract, notice.train, notice.repair, dream.generate or notice.metabolise: when, whether it completed, and counts, a cursor or a short reason in notes. Bookkeeping, not memory.';

alter table relations add column aliases text[] not null default '{}';
comment on column relations.aliases is 'Other names the subject is called by (pet names, short forms), recorded when the mind accepts a metabolised relation. Never a fact about the person.';

create table metabolise_queue (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  stretch_event_id uuid not null references events (id),
  status text not null default 'queued' check (status in ('queued', 'done', 'failed')),
  note text,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  unique (mind_id, stretch_event_id)
);
comment on table metabolise_queue is 'Stretches of conversation (metabolise.stretch events) waiting for notice.metabolise. Bookkeeping, not memory: it names an event and holds a status and a short reason, never the text. The pass changes only status, done_at and note.';

create index metabolise_queue_mind_status_idx on metabolise_queue (mind_id, status, created_at);

create function metabolise_queue_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := sanctum_actor();
begin
  if tg_op = 'INSERT' then
    if new.mind_id is distinct from nullif(current_setting('app.mind_id', true), '') or b is distinct from new.mind_id
       or a is null or a not in ('verb', 'import') then
      raise exception 'a stretch is queued by the mind''s own call' using errcode = 'insufficient_privilege';
    end if;
    if a = 'verb' and (new.status <> 'queued' or new.done_at is not null) then
      raise exception 'a new stretch is queued' using errcode = 'insufficient_privilege';
    end if;
    if a = 'import' and (new.status <> 'done' or new.done_at is null) then
      raise exception 'an imported stretch arrives done' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from public.events e where e.id = new.stretch_event_id and e.mind_id = new.mind_id and e.kind = 'metabolise.stretch') then
      raise exception 'a queued stretch must reference its own metabolise.stretch event' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if row(new.id, new.mind_id, new.stretch_event_id, new.created_at)
     is distinct from
     row(old.id, old.mind_id, old.stretch_event_id, old.created_at) then
    raise exception 'a queued stretch is fixed once made; only its status changes' using errcode = 'insufficient_privilege';
  end if;
  if new.status is not distinct from old.status then
    if new.done_at is distinct from old.done_at or new.note is distinct from old.note then
      raise exception 'a stretch''s note and time change only with its status' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if old.status <> 'queued' then
    raise exception 'a finished stretch is final' using errcode = 'insufficient_privilege';
  end if;
  if new.status not in ('done', 'failed') then
    raise exception 'a stretch is finished as done or failed' using errcode = 'insufficient_privilege';
  end if;
  if new.done_at is null then
    raise exception 'a finished stretch carries the time it finished' using errcode = 'insufficient_privilege';
  end if;
  if a is null or a not in ('daemon', 'import') or b is distinct from old.mind_id then
    raise exception 'only the mind''s own daemon works through the queue' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger metabolise_queue_guard before insert or update on metabolise_queue
  for each row execute function metabolise_queue_guard();

alter table metabolise_queue enable row level security;
alter table metabolise_queue force row level security;
create policy metabolise_queue_mind on metabolise_queue for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on metabolise_queue to sanctum_app;
