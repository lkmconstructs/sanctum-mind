-- sanctum-mind v2: dreaming. An optional, operator-enabled, model-backed pass lays down ONE dream from the day's residue
-- (recent textured events, relations with a charge, the handoff, the identity cores as preamble). A dream is residue, never
-- memory: it lives in its own table until the mind anchors it by a verb call (mind_dream anchor), which authors an
-- observation as the mind through mind_observe's own write path. A dream nobody anchors fades. See CONTRACTS.md,
-- "Dreaming".
--
-- The rules are the noticings rules (0021, 0026), applied to dreams:
--   1. dreams: one row per dream. stage in (shadow, propose), status in (laid, anchored, released, faded). Two stages,
--      no third; there is no stage under which residue becomes memory by itself. `residue` is ids and counts only; the
--      text of a dream is in `content` and `question` and nowhere else (the ledger carries ids).
--   2. dream_state: the operator's switch for one mind (enabled, stage, schedule, gap_hours, paused_at). Separate from
--      extractor_state on purpose: dreams may run with the extractor off, and the reverse. dream_state_guard: a row
--      becomes enabled only when sanctum_actor() is 'operator' -> "only the operator enables dreaming".
--   3. dream_preferences: the mind's own say over who appears. One row per mind, `relations` = "all" | "none" | a list of
--      relation subjects. dream_preferences_guard: written only by the mind in a verb call (actor 'verb', bearer = mind); on
--      a lane, verb or import -> "who appears in a dream is the mind's to decide". No operator path.
--   4. dreams_insert_guard (BEFORE INSERT): laid in the mind's own scope (mind_id = app.mind_id, app.bearer = mind_id); on
--      a lane the actor must be daemon or import -> "dreams are laid down by the mind's own daemon or an import". Status on
--      insert: 'laid', or 'faded', or a decided status carrying its decided_event_id (import) -> "a decided dream carries
--      its decision event".
--   5. dreams_decision_guard (BEFORE UPDATE). After insert a dream is fixed. Only status, decided_event_id and decided_at
--      change, together, once:
--        * content, question, residue, model_version, stage, laid_event_id, fades_at, created_at (and id, mind_id) are
--          immutable for every connection, admin included -> "a dream is fixed once laid";
--        * laid -> anchored or released requires actor 'verb' and bearer = the mind -> "only the mind decides what a dream was";
--        * laid -> faded requires actor daemon or import and bearer = the mind -> "only the mind's own daemon fades a dream";
--        * any move out of laid needs decided_event_id to reference an events row of this mind whose subject_id is this
--          dream and whose kind is dream.<new status> -> "a decision must reference its own dream.* event".
--   6. extractor_runs admits the pass name 'dream.generate' (the same schedule bookkeeping as the extractor's passes).

create table dreams (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  content text not null,
  question text not null default '',
  residue jsonb not null default '{}',
  model_version text not null,
  stage text not null check (stage in ('shadow', 'propose')),
  status text not null default 'laid' check (status in ('laid', 'anchored', 'released', 'faded')),
  laid_event_id uuid not null references events (id),
  decided_event_id uuid references events (id),
  decided_at timestamptz,
  fades_at timestamptz not null,
  created_at timestamptz not null default now()
);
comment on table dreams is 'Residue laid down by the dreaming pass. Never memory: only a verb call by the mind (mind_dream anchor) turns one into an observation. After insert only status, decided_event_id and decided_at change, together, once.';
comment on column dreams.residue is 'What the dream was made from: ids and counts only (event_ids, node_ids, relation subjects, window). The text is in content and question.';
comment on column dreams.stage is 'shadow: laid and never shown to the mind. propose: shown in mind_dream list and mind_orient. No third stage exists.';

create index dreams_mind_status_created_idx on dreams (mind_id, status, created_at desc);

create table dream_state (
  mind_id text primary key references minds (mind_id),
  enabled boolean not null default false,
  stage text not null default 'shadow' check (stage in ('shadow', 'propose')),
  schedule text not null default '03:30' check (schedule ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  gap_hours int not null default 20 check (gap_hours between 1 and 168),
  paused_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_event_id uuid references events (id)
);
comment on table dream_state is 'The operator''s switch for the dreaming of one mind. No row means off. A row can become enabled only with sanctum_actor() = operator.';

create table dream_preferences (
  mind_id text primary key references minds (mind_id),
  relations jsonb not null default '"all"',
  updated_at timestamptz not null default now(),
  updated_event_id uuid not null references events (id)
);
comment on table dream_preferences is 'The mind''s own say over who appears in its dreams: "all", "none", or a list of relation subjects. Written only by the mind (mind_dream prefer).';

create function dreams_insert_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.mind_id is distinct from current_setting('app.mind_id', true)
     or current_setting('app.bearer', true) is distinct from new.mind_id then
    raise exception 'dreams are laid down in the mind''s own scope' using errcode = 'insufficient_privilege';
  end if;
  if new.status not in ('laid', 'faded') and new.decided_event_id is null then
    raise exception 'a decided dream carries its decision event' using errcode = 'insufficient_privilege';
  end if;
  if sanctum_lane() is not null and sanctum_actor() not in ('daemon', 'import') then
    raise exception 'dreams are laid down by the mind''s own daemon or an import' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger dreams_insert_guard before insert on dreams
  for each row execute function dreams_insert_guard();

create function dreams_decision_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := sanctum_actor();
begin
  if row(new.id, new.mind_id, new.content, new.question, new.residue, new.model_version, new.stage, new.laid_event_id,
         new.fades_at, new.created_at)
     is distinct from
     row(old.id, old.mind_id, old.content, old.question, old.residue, old.model_version, old.stage, old.laid_event_id,
         old.fades_at, old.created_at) then
    raise exception 'a dream is fixed once laid' using errcode = 'insufficient_privilege';
  end if;
  if new.status is not distinct from old.status then
    if new.decided_event_id is distinct from old.decided_event_id or new.decided_at is distinct from old.decided_at then
      raise exception 'a decision is recorded only together with the status change' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if old.status <> 'laid' then
    raise exception 'a decided dream is final' using errcode = 'insufficient_privilege';
  end if;
  if new.status in ('anchored', 'released') then
    if a is distinct from 'verb' or b is distinct from old.mind_id then
      raise exception 'only the mind decides what a dream was' using errcode = 'insufficient_privilege';
    end if;
  elsif new.status = 'faded' then
    if a is null or a not in ('daemon', 'import') or b is distinct from old.mind_id then
      raise exception 'only the mind''s own daemon fades a dream' using errcode = 'insufficient_privilege';
    end if;
  else
    raise exception 'a dream cannot return to laid' using errcode = 'insufficient_privilege';
  end if;
  if new.decided_event_id is null or not exists (
       select 1 from public.events e
        where e.id = new.decided_event_id and e.mind_id = old.mind_id and e.subject_id = old.id
          and e.kind = 'dream.' || new.status) then
    raise exception 'a decision must reference its own dream.* event' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger dreams_decision_guard before update on dreams
  for each row execute function dreams_decision_guard();

create function dream_state_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled) and sanctum_actor() is distinct from 'operator' then
    raise exception 'only the operator enables dreaming' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger dream_state_guard before insert or update on dream_state
  for each row execute function dream_state_guard();

create function dream_preferences_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  a text := sanctum_actor();
begin
  if new.mind_id is distinct from current_setting('app.mind_id', true)
     or current_setting('app.bearer', true) is distinct from new.mind_id
     or a is null or a not in ('verb', 'import') then
    raise exception 'who appears in a dream is the mind''s to decide' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(new.relations) not in ('string', 'array')
     or (jsonb_typeof(new.relations) = 'string' and new.relations #>> '{}' not in ('all', 'none')) then
    raise exception 'relations is "all", "none" or a list of relation subjects' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger dream_preferences_guard before insert or update on dream_preferences
  for each row execute function dream_preferences_guard();

alter table dreams enable row level security;
alter table dreams force row level security;
create policy dreams_mind on dreams for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table dream_state enable row level security;
alter table dream_state force row level security;
create policy dream_state_mind on dream_state for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table dream_preferences enable row level security;
alter table dream_preferences force row level security;
create policy dream_preferences_mind on dream_preferences for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

-- The pass records its runs beside the extractor's. The constraint is replaced, not edited: 0022 and 0023 are immutable.
alter table extractor_runs drop constraint extractor_runs_pass_check;
alter table extractor_runs add constraint extractor_runs_pass_check check (pass in ('notice.extract', 'notice.train', 'notice.repair', 'dream.generate'));

-- No delete anywhere. The app role reads the operator's switch and can insert a first row only (import, disabled); only the
-- operator lane or the admin URL changes dream_state. The app role lays dreams (as the daemon), decides them (as the mind's
-- verb) and keeps the mind's preference.
grant select, insert, update on dreams to sanctum_app;
grant select, insert on dream_state to sanctum_app;
grant select, insert, update on dream_state to sanctum_operator;
grant select, insert, update on dream_preferences to sanctum_app;
