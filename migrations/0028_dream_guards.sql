-- sanctum-mind v2: dreams guards, tightened. 0027 is immutable, so the two functions are replaced here (the triggers keep
-- pointing at them by name).
--   * dreams_decision_guard: leaving `laid` now requires decided_at as well as decided_event_id. Before, a decision could be
--     recorded with decided_at NULL, and nothing could set it afterwards (a decided row accepts no change to decided_at), so
--     the history ordered by decided_at lost it for good.
--   * dreams_insert_guard: a row that is not `laid` is inserted only with its decision event (decided_event_id naming an event
--     of this mind, subject = the dream, kind = dream.<status>) and decided_at. Before, `faded` was admitted with neither, so a
--     faded dream could exist with no dream.faded event. A `laid` row is inserted with no decision.
-- Rows already in the table are not rewritten; this checks new writes only.

create or replace function dreams_insert_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.mind_id is distinct from current_setting('app.mind_id', true)
     or current_setting('app.bearer', true) is distinct from new.mind_id then
    raise exception 'dreams are laid down in the mind''s own scope' using errcode = 'insufficient_privilege';
  end if;
  if new.status = 'laid' then
    if new.decided_event_id is not null or new.decided_at is not null then
      raise exception 'a laid dream has no decision yet' using errcode = 'insufficient_privilege';
    end if;
  elsif new.decided_event_id is null or new.decided_at is null or not exists (
       select 1 from public.events e
        where e.id = new.decided_event_id and e.mind_id = new.mind_id and e.subject_id = new.id
          and e.kind = 'dream.' || new.status) then
    -- every non-laid dream, faded included, comes in with its own dream.<status> event and the time of the decision
    raise exception 'a decided dream carries its decision event' using errcode = 'insufficient_privilege';
  end if;
  if sanctum_lane() is not null and sanctum_actor() not in ('daemon', 'import') then
    raise exception 'dreams are laid down by the mind''s own daemon or an import' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create or replace function dreams_decision_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
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
  if new.decided_at is null then
    raise exception 'a decision carries the time it was made' using errcode = 'insufficient_privilege';
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
