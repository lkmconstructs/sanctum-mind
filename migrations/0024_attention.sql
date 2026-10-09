-- sanctum-mind v2: attention. A mind can pin what it wants to keep in view. The attention set itself (what the mind is
-- carrying right now) is computed on read from projections that already exist; the only thing stored here is the pins.
-- See CONTRACTS.md, "Attention".
--
-- What this file does:
--   1. attention_pins: one row per pin. item_type in (loop, thread, task, desire, declaration, noticing, node, event);
--      item_id is the pinned thing's id (not a foreign key: the pinned things live in several tables, and a pin outlives
--      the item it names until the mind releases it). A pin is live while released_at is null. RLS FORCE on mind_id,
--      select/insert/update for the app role, no delete (purge_mind removes a mind's pins with everything else).
--   2. A partial unique index on (mind_id, item_type, item_id) where released_at is null: one live pin per item. The verb
--      answers `conflict` first; the index is the backstop for a race and for direct SQL.
--   3. attention_pins_guard (BEFORE INSERT OR UPDATE). Pins belong to the mind, as itself:
--        * INSERT needs app.bearer = mind_id (and mind_id = app.mind_id) and app.actor = 'verb' (the mind's own mind_attend
--          call) -> "attention is directed by the mind". A new pin is live (released_at and released_event_id null) and
--          pinned_event_id must name an `attend.pin` event of this mind whose subject is the item and whose payload item_type is the row's.
--          ONE exception, for import-mind (which runs as the mind under actor 'import' and brings a mind's ledger and its
--          projections in together): an INSERT under actor 'import' with app.bearer = mind_id is allowed when
--          pinned_event_id is non-null (the same event rule applies), and the row may arrive already released, i.e.
--          released_at and released_event_id may be set, both or neither, the latter naming an `attend.release` event of this
--          mind whose subject is the item. Nothing else is relaxed for import; it can neither update nor delete a pin.
--        * UPDATE is a release and nothing else: only released_at and released_event_id may change, both together, once,
--          from null to non-null; every other column (id, mind_id, item_type, item_id, note, pinned_event_id, pinned_at)
--          must be unchanged, null-safely -> "a pin is fixed once made; it can only be released". It needs app.bearer =
--          mind_id and app.actor = 'verb' and released_event_id must name an `attend.release` event of this mind whose
--          subject is the item. A released pin never returns to live.
--      A write grantee or steward (a different bearer), a daemon pass, the operator and a bare connection with no scope
--      cannot pin or release, even with direct SQL.
--   No DELETE trigger: the app role holds no delete grant, and purge_mind (admin) must be able to remove a mind's rows.

create table attention_pins (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  item_type text not null check (item_type in ('loop', 'thread', 'task', 'desire', 'declaration', 'noticing', 'node', 'event')),
  item_id uuid not null,
  note text,
  pinned_event_id uuid not null references events (id),
  pinned_at timestamptz not null,
  released_event_id uuid references events (id),
  released_at timestamptz,
  check ((released_at is null) = (released_event_id is null))
);
comment on table attention_pins is 'What the mind has pinned to keep in view. Only the mind pins and releases, through mind_attend; a pin never changes the item it names. A release sets released_at and released_event_id and nothing else.';

create unique index attention_pins_one_live on attention_pins (mind_id, item_type, item_id) where released_at is null;

create function attention_pins_guard() returns trigger language plpgsql as $$
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
            and e.payload->>'item_type' = new.item_type) then
      raise exception 'a pin must reference its own attend.pin event' using errcode = 'insufficient_privilege';
    end if;
    if a = 'verb' and (new.released_at is not null or new.released_event_id is not null) then
      raise exception 'a new pin is live' using errcode = 'insufficient_privilege';
    end if;
    if new.released_event_id is not null and not exists (
         select 1 from events e
          where e.id = new.released_event_id and e.mind_id = new.mind_id and e.kind = 'attend.release' and e.subject_id = new.item_id
            and e.payload->>'item_type' = new.item_type) then
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
          and e.payload->>'item_type' = old.item_type) then
    raise exception 'a release must reference its own attend.release event' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger attention_pins_guard before insert or update on attention_pins
  for each row execute function attention_pins_guard();

alter table attention_pins enable row level security;
alter table attention_pins force row level security;
create policy attention_pins_mind on attention_pins for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on attention_pins to sanctum_app;
