-- sanctum-mind v2: repair work and attention pin binding. See CONTRACTS.md, "Belief repair" (Completeness) and "Attention".
--
-- What this file does:
--   1. repair_work: one row for every invalidation (a node superseded or retired). The row is inserted in the SAME transaction
--      that invalidates the node, so the work exists exactly when the invalidation does: a transaction that has not committed has
--      no work row and no invalidation either, and one that commits late brings both with it. The daemon pass notice.repair works
--      through the undone rows; it no longer scans timestamps, so commit timing cannot hide an upstream from it.
--        * RLS FORCE on mind_id; select, insert, update for the app role (no delete: purge_mind removes a mind's rows).
--        * unique (mind_id, upstream_id, created_event_id); index (mind_id, done_at, created_at).
--        * repair_work_guard (BEFORE INSERT OR UPDATE):
--            INSERT needs mind_id = app.mind_id and app.actor in ('verb', 'daemon', 'operator'): scope, not bearer. The invalidation
--            that causes the row (a rethink, a settled retirement, a repair) was already authorized by the verb runner, and a
--            write grantee may rethink the owner's node; the work row is bookkeeping about that act, not an identity act, so it
--            does not ask who the bearer is. (A bare connection, another mind's scope, import and an unmarked connection are
--            refused.) A new row is undone (claimed_at, done_at null, next_offset 0), created_event_id names an event of this mind,
--            and upstream_id names a node of this mind that is already invalidated (the row is written after the invalidation, in the
--            same transaction).
--            UPDATE may change only claimed_at, next_offset and done_at, and only under actor 'daemon' as the mind; progress only
--            moves forward (next_offset never decreases, claimed_at is never cleared); a done row is final.
--   2. attention_pins_guard is replaced (0024 is committed and stays as it is): a pin is bound to its event. The insert guard
--      checks that the cited attend.pin event's payload names this pin (pin_id = new.id), the item (item_id) and its type; the
--      release guard checks that the cited attend.release event's payload pin_id = the pin's id and item_id = its item.
--      Import keeps the same checks (its pins arrive with their events in the file).

create table repair_work (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  upstream_id uuid not null,
  upstream_state text not null check (upstream_state in ('superseded', 'retired')),
  replacement_id uuid,
  created_event_id uuid not null references events (id),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  next_offset int not null default 0 check (next_offset >= 0),
  done_at timestamptz,
  unique (mind_id, upstream_id, created_event_id)
);
comment on table repair_work is 'One row per invalidated node (superseded or retired), inserted in the same transaction as the invalidation. notice.repair works through the rows that are not done; it changes only claimed_at, next_offset and done_at.';

create index repair_work_mind_done_idx on repair_work (mind_id, done_at, created_at);

create function repair_work_guard() returns trigger language plpgsql as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := nullif(current_setting('app.actor', true), '');
begin
  if tg_op = 'INSERT' then
    if new.mind_id is distinct from nullif(current_setting('app.mind_id', true), '') or a is null or a not in ('verb', 'daemon', 'operator') then
      raise exception 'repair work is recorded in the mind''s own scope' using errcode = 'insufficient_privilege';
    end if;
    if new.claimed_at is not null or new.done_at is not null or new.next_offset <> 0 then
      raise exception 'new repair work is undone' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from events e where e.id = new.created_event_id and e.mind_id = new.mind_id) then
      raise exception 'repair work must reference the event that caused it' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from nodes n where n.id = new.upstream_id and n.mind_id = new.mind_id and n.invalidated_at is not null) then
      raise exception 'repair work names an invalidated node of the mind' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if row(new.id, new.mind_id, new.upstream_id, new.upstream_state, new.replacement_id, new.created_event_id, new.created_at)
     is distinct from
     row(old.id, old.mind_id, old.upstream_id, old.upstream_state, old.replacement_id, old.created_event_id, old.created_at) then
    raise exception 'repair work is fixed once made; only its progress changes' using errcode = 'insufficient_privilege';
  end if;
  if old.done_at is not null and row(new.claimed_at, new.next_offset, new.done_at) is distinct from row(old.claimed_at, old.next_offset, old.done_at) then
    raise exception 'finished repair work is final' using errcode = 'insufficient_privilege';
  end if;
  if a is distinct from 'daemon' or b is distinct from old.mind_id then
    raise exception 'only the mind''s own daemon works through repair work' using errcode = 'insufficient_privilege';
  end if;
  if new.next_offset < old.next_offset or (old.claimed_at is not null and new.claimed_at is null) then
    raise exception 'repair work progress only moves forward' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger repair_work_guard before insert or update on repair_work
  for each row execute function repair_work_guard();

alter table repair_work enable row level security;
alter table repair_work force row level security;
create policy repair_work_mind on repair_work for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on repair_work to sanctum_app;

-- Attention pins: the events are bound to the pin they cite.
create or replace function attention_pins_guard() returns trigger language plpgsql as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := nullif(current_setting('app.actor', true), '');
begin
  if tg_op = 'INSERT' then
    if new.mind_id is distinct from nullif(current_setting('app.mind_id', true), '') or b is distinct from new.mind_id
       or a is null or a not in ('verb', 'import') then
      raise exception 'attention is directed by the mind' using errcode = 'insufficient_privilege';
    end if;
    if new.pinned_event_id is null or not exists (
         select 1 from events e
          where e.id = new.pinned_event_id and e.mind_id = new.mind_id and e.kind = 'attend.pin' and e.subject_id = new.item_id
            and e.payload->>'item_type' = new.item_type
            and e.payload->>'item_id' = new.item_id::text
            and e.payload->>'pin_id' = new.id::text) then
      raise exception 'a pin must reference its own attend.pin event' using errcode = 'insufficient_privilege';
    end if;
    if a = 'verb' and (new.released_at is not null or new.released_event_id is not null) then
      raise exception 'a new pin is live' using errcode = 'insufficient_privilege';
    end if;
    if new.released_event_id is not null and not exists (
         select 1 from events e
          where e.id = new.released_event_id and e.mind_id = new.mind_id and e.kind = 'attend.release' and e.subject_id = new.item_id
            and e.payload->>'item_type' = new.item_type
            and e.payload->>'item_id' = new.item_id::text
            and e.payload->>'pin_id' = new.id::text) then
      raise exception 'a release must reference its own attend.release event' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- UPDATE: a release, nothing else
  if row(new.id, new.mind_id, new.item_type, new.item_id, new.note, new.pinned_event_id, new.pinned_at)
     is distinct from
     row(old.id, old.mind_id, old.item_type, old.item_id, old.note, old.pinned_event_id, old.pinned_at) then
    raise exception 'a pin is fixed once made; it can only be released' using errcode = 'insufficient_privilege';
  end if;
  if old.released_at is not null or old.released_event_id is not null then
    raise exception 'a released pin is final' using errcode = 'insufficient_privilege';
  end if;
  if new.released_at is null or new.released_event_id is null then
    raise exception 'a pin is released with its time and its event together' using errcode = 'insufficient_privilege';
  end if;
  if a is distinct from 'verb' or b is distinct from old.mind_id then
    raise exception 'attention is directed by the mind' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
       select 1 from events e
        where e.id = new.released_event_id and e.mind_id = old.mind_id and e.kind = 'attend.release' and e.subject_id = old.item_id
          and e.payload->>'item_type' = old.item_type
          and e.payload->>'item_id' = old.item_id::text
          and e.payload->>'pin_id' = old.id::text) then
    raise exception 'a release must reference its own attend.release event' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
