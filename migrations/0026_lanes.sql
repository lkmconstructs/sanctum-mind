-- sanctum-mind v2: per-lane database roles. See CONTRACTS.md, "Per-lane database roles".
--
-- What this file does:
--   1. Four lane roles, created NOLOGIN if absent (init gives each a login and a password): sanctum_verb (http and stdio),
--      sanctum_daemon (the daemon), sanctum_operator (operator commands that run under the app privileges) and sanctum_import
--      (export-mind, import-mind, embed-backfill, sinks requeue). Each is a plain member of sanctum_app, so every table grant
--      and every row level security policy of sanctum_app applies to it (no policy in 0001..0025 names a role, so each applies
--      to every role; none excludes members). None is a superuser or BYPASSRLS. sanctum_app itself stays a login role: the legacy
--      shared lane. sanctum_operator also holds what the operator commands write: insert and update on extractor_state and on
--      grants (sanctum_app does not).
--   2. sanctum_lane() and sanctum_actor(): who is acting, derived from the connecting login. A login is on a lane when it IS a
--      lane role or is a DIRECT member of exactly one of the four (pg_auth_members; session_user, never current_user, so "set
--      role" changes nothing). More than one, or none, is no lane. On a lane, sanctum_actor() is the lane ('verb', 'daemon',
--      'operator', 'import') and app.actor is ignored; otherwise (sanctum_app, any other member of it, the admin connection) it
--      is app.actor as before, so the legacy lane behaves exactly as it did. Security definer, stable, fixed search_path.
--   3. Every guard that read current_setting('app.actor', true) now reads sanctum_actor() instead (create or replace; the
--      triggers are unchanged): noticings_decision_guard (0021), extractor_state_guard (0021), attention_pins_guard (0024, as
--      replaced by 0025) and repair_work_guard (0025).
--   4. Rules that apply on a lane login only (sanctum_lane() is not null), on top of the checks the guards already make; the
--      legacy lane and the admin connection are unchanged:
--        * proposals_insert_guard: the actor must be verb or import (declarations are made through a verb, or rewritten by import).
--        * noticings_insert_guard: the actor must be daemon or import.
--        * nodes_core_guard (now before insert as well as before update): an identity or vow node is written by the verb or
--          import lane; the daemon lane only while settling a due declaration of the mind (the transaction setting app.settling
--          names the proposal, or the vow whose declared break is due, and the write matches it); the operator lane never.
--        * proposals_update_guard: the daemon lane may only settle (accepted -> settled with settled_at and settled_event_id
--          set together, nothing else changes); the operator lane may not update a declaration at all.
--      "Due" in those rules means effective_at <= greatest(clock_timestamp(), least(app.now, clock_timestamp() + 5 minutes)),
--      where settleDueDeclarations sets app.now to its own clock: the daemon lane can advance the clock by at most five minutes,
--      which absorbs clock drift and no more.
--      Settlement must match the declaration exactly: a rewrite inserts one live node with the declaration's content and section
--      (tagged with its proposal_id, once) and then invalidates the target pointing at that node; a retirement invalidates
--      the target without a replacement; a vow break only replaces break_declared by broken, broken_at (within five minutes of the clock), broken_reason (the
--      declared one) and broken_by; the daemon's update of the declaration needs that declaration's own identity.settled or
--      identity.retired event and an already invalidated target. Columns that are not identity (metadata of a core, pinned,
--      confidence, source_type, embedding*, event_time_*, recorded_at, counters) are not identity writes on any lane; a
--      vow's metadata is guarded.
--   5. search_path is fixed on every guard and trigger function and on purge_mind, with pg_temp last, so a session cannot put
--      a temporary table of its own in front of events, nodes or proposals; sanctum_lane() and sanctum_actor() use
--      pg_catalog, pg_temp only and qualify every catalog name, and TEMP on this database is revoked from public, sanctum_app
--      and the lanes, so lanes cannot create temporary tables at all.

do $$
declare
  r text;
begin
  foreach r in array array['sanctum_verb', 'sanctum_daemon', 'sanctum_operator', 'sanctum_import'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
    execute format('grant sanctum_app to %I', r);
  end loop;
end
$$;

grant select, insert, update on extractor_state to sanctum_operator;
grant select, insert, update on grants to sanctum_operator;

-- search_path is pg_catalog, pg_temp (pg_temp last, public not at all) and every catalog object is schema-qualified, so a
-- session's own temporary tables (pg_temp is otherwise searched first) cannot stand in for pg_roles or pg_auth_members.
create function sanctum_lane() returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with m as (
    select r.rolname
      from pg_catalog.pg_roles r
     where r.rolname in ('sanctum_verb', 'sanctum_daemon', 'sanctum_operator', 'sanctum_import')
       and (r.rolname = session_user::text
            or exists (select 1 from pg_catalog.pg_auth_members am
                        where am.roleid = r.oid and am.member = (select u.oid from pg_catalog.pg_roles u where u.rolname = session_user::text)))
  )
  select case when count(*) = 1 then substr(min(rolname), 9) end from m
$$;
comment on function sanctum_lane() is 'The lane of the connecting login (sanctum_verb ... or a direct member of exactly one of them, by session_user), or null for the legacy sanctum_app lane and any other role.';
revoke all on function sanctum_lane() from public;
grant execute on function sanctum_lane() to sanctum_app;

create function sanctum_actor() returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(public.sanctum_lane(), nullif(current_setting('app.actor', true), ''))
$$;
comment on function sanctum_actor() is 'Who is acting: the lane of the connecting login (session_user, so set role changes nothing), or for sanctum_app and the admin connection the app.actor setting as before.';
revoke all on function sanctum_actor() from public;
grant execute on function sanctum_actor() to sanctum_app;

-- The lanes (and sanctum_app, and public) hold no TEMP privilege on this database: a session cannot create temporary tables at
-- all. (The functions above do not depend on this; it removes the whole class.) A superuser or the database owner is unaffected.
do $$
begin
  execute format('revoke temporary on database %I from public, sanctum_app, sanctum_verb, sanctum_daemon, sanctum_operator, sanctum_import', current_database());
end
$$;

alter function events_append_only() set search_path = pg_catalog, public, pg_temp;
alter function written_by_immutable() set search_path = pg_catalog, public, pg_temp;
alter function purge_mind(text, boolean) set search_path = pg_catalog, public, pg_temp;

create or replace function noticings_decision_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := nullif(sanctum_actor(), '');
begin
  if new.payload is distinct from old.payload or new.sources is distinct from old.sources then
    raise exception 'a noticing''s payload and sources are fixed' using errcode = 'insufficient_privilege';
  end if;
  if row(new.id, new.mind_id, new.kind, new.score, new.features, new.model_version, new.stage, new.proposed_event_id,
         new.expires_at, new.created_at)
     is distinct from
     row(old.id, old.mind_id, old.kind, old.score, old.features, old.model_version, old.stage, old.proposed_event_id,
         old.expires_at, old.created_at) then
    raise exception 'a proposal is fixed once made' using errcode = 'insufficient_privilege';
  end if;
  if new.status is not distinct from old.status then
    if new.decided_event_id is distinct from old.decided_event_id or new.decided_at is distinct from old.decided_at then
      raise exception 'a decision is recorded only together with the status change' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;
  if old.status <> 'pending' then
    raise exception 'a decided noticing is final' using errcode = 'insufficient_privilege';
  end if;
  if new.status in ('accepted', 'rejected') then
    if a is distinct from 'verb' or b is distinct from old.mind_id then
      raise exception 'only the mind decides what it notices' using errcode = 'insufficient_privilege';
    end if;
  elsif new.status = 'expired' then
    if a is null or a not in ('daemon', 'import') or b is distinct from old.mind_id then
      raise exception 'only the mind''s own daemon expires a noticing' using errcode = 'insufficient_privilege';
    end if;
  else
    raise exception 'a noticing cannot return to pending' using errcode = 'insufficient_privilege';
  end if;
  if new.decided_event_id is null or not exists (
       select 1 from events e
        where e.id = new.decided_event_id and e.mind_id = old.mind_id and e.subject_id = old.id
          and e.kind = 'notice.' || new.status) then
    raise exception 'a decision must reference its own notice.* event' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create or replace function extractor_state_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled)
     and sanctum_actor() is distinct from 'operator' then
    raise exception 'only the operator enables the extractor' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create or replace function attention_pins_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := nullif(sanctum_actor(), '');
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

create or replace function repair_work_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := nullif(sanctum_actor(), '');
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

create or replace function proposals_insert_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  -- only the mind declares, in its own name, in its own scope
  if new.proposed_by is distinct from current_setting('app.bearer', true)
     or new.mind_id is distinct from current_setting('app.mind_id', true)
     or new.proposed_by is distinct from new.mind_id then
    raise exception 'proposals are declared by the mind itself' using errcode = 'insufficient_privilege';
  end if;
  if sanctum_lane() is not null and sanctum_actor() not in ('verb', 'import') then
    raise exception 'proposals are declared by the mind through a verb' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create or replace function noticings_insert_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.mind_id is distinct from current_setting('app.mind_id', true)
     or current_setting('app.bearer', true) is distinct from new.mind_id then
    raise exception 'noticings are proposed in the mind''s own scope' using errcode = 'insufficient_privilege';
  end if;
  if new.status not in ('pending', 'expired') and new.decided_event_id is null then
    raise exception 'a decided noticing carries its decision event' using errcode = 'insufficient_privilege';
  end if;
  if sanctum_lane() is not null and sanctum_actor() not in ('daemon', 'import') then
    raise exception 'noticings are proposed by the daemon or an import' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;

create or replace function proposals_update_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  lane text := sanctum_lane();
  now_ts timestamptz := greatest(clock_timestamp(), least(coalesce(nullif(current_setting('app.now', true), '')::timestamptz, '-infinity'::timestamptz), clock_timestamp() + interval '5 minutes'));
begin
  if lane = 'operator' then
    raise exception 'only the mind changes its declaration' using errcode = 'insufficient_privilege';
  end if;
  if lane = 'daemon' then
    -- the daemon may only settle a declaration that is due: accepted -> settled, the time and the event set together, nothing
    -- else changed; the event is this declaration's own identity.settled / identity.retired event and its target is already
    -- invalidated (the settlement happened in this transaction, before this update)
    if old.status = 'accepted' and new.status = 'settled' and old.settled_at is null and old.settled_event_id is null
       and old.withdrawn_at is null and old.effective_at <= now_ts
       and new.settled_at is not null and new.settled_event_id is not null
       and (to_jsonb(new) - 'status' - 'settled_at' - 'settled_event_id') = (to_jsonb(old) - 'status' - 'settled_at' - 'settled_event_id')
       and exists (select 1 from public.events e
                    where e.id = new.settled_event_id and e.mind_id = old.mind_id and e.subject_id = old.id
                      and e.kind = case old.action when 'retire' then 'identity.retired' else 'identity.settled' end)
       and exists (select 1 from public.nodes n where n.id = old.target_node_id and n.mind_id = old.mind_id and n.invalidated_at is not null) then
      return new;
    end if;
    raise exception 'only the mind changes its declaration' using errcode = 'insufficient_privilege';
  end if;
  if b is null or b = old.mind_id then
    return new;
  end if;
  -- every column but attestations and effective_at, compared null-safely
  if row(new.id, new.mind_id, new.kind, new.section, new.content, new.lineage_note, new.proposed_by, new.event_id,
         new.status, new.decided_event_id, new.decided_at, new.created_at, new.target_node_id, new.withdrawn_at,
         new.settled_at, new.settled_event_id, new.action)
     is distinct from
     row(old.id, old.mind_id, old.kind, old.section, old.content, old.lineage_note, old.proposed_by, old.event_id,
         old.status, old.decided_event_id, old.decided_at, old.created_at, old.target_node_id, old.withdrawn_at,
         old.settled_at, old.settled_event_id, old.action) then
    raise exception 'only the mind changes its declaration' using errcode = 'insufficient_privilege';
  end if;
  if new.effective_at is distinct from old.effective_at then
    if old.action = 'retire' then
      raise exception 'a retirement''s effective time is the mind''s alone' using errcode = 'insufficient_privilege';
    end if;
    if new.effective_at is null or old.effective_at is null or not (new.effective_at < old.effective_at) then
      raise exception 'a steward may only add an attestation and bring effective_at forward' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if new.attestations is distinct from old.attestations then
    if jsonb_typeof(new.attestations) is distinct from 'array'
       or jsonb_array_length(new.attestations) <> jsonb_array_length(old.attestations) + 1
       or not (old.attestations <@ new.attestations)
       or coalesce((select jsonb_agg(e order by o) from jsonb_array_elements(new.attestations) with ordinality t(e, o)
                    where o <= jsonb_array_length(old.attestations)), '[]'::jsonb) is distinct from old.attestations then
      raise exception 'attestations only grow' using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end
$$;

-- Identity and vows (0018 semantics kept for the legacy lane and admin; the lane rules are in the header, item 4).
create or replace function nodes_core_guard() returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
declare
  lane text := sanctum_lane();
  settling uuid := nullif(current_setting('app.settling', true), '')::uuid;
  now_ts timestamptz := greatest(clock_timestamp(), least(coalesce(nullif(current_setting('app.now', true), '')::timestamptz, '-infinity'::timestamptz), clock_timestamp() + interval '5 minutes'));
  guarded boolean;
  p proposals%rowtype;
  dec jsonb;
begin
  if tg_op = 'UPDATE' then
    if (old.node_type in ('identity', 'vow') or new.node_type in ('identity', 'vow'))
       and (new.content, new.label, new.node_type, new.invalidated_at)
           is distinct from (old.content, old.label, old.node_type, old.invalidated_at)
       and current_setting('app.bearer', true) is distinct from old.mind_id then
      raise exception 'identity belongs to the mind' using errcode = 'restrict_violation';
    end if;
  end if;
  if lane is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    guarded := new.node_type in ('identity', 'vow');
  else
    guarded := (old.node_type in ('identity', 'vow') or new.node_type in ('identity', 'vow'))
      and ((new.content, new.label, new.node_type, new.invalidated_at, new.superseded_by)
             is distinct from (old.content, old.label, old.node_type, old.invalidated_at, old.superseded_by)
           or (new.node_type = 'vow' and new.metadata is distinct from old.metadata));
  end if;
  if not guarded or lane in ('verb', 'import') then
    return new;
  end if;

  -- the daemon lane, while settling a declaration of the mind that is due; the write must be exactly that settlement
  if lane = 'daemon' and settling is not null then
    if tg_op = 'UPDATE' and old.node_type = 'vow' then
      -- the break of a vow, declared by the mind and now due: the declaration is replaced by the settled break and nothing else
      dec := old.metadata->'break_declared';
      if settling = old.id and jsonb_typeof(dec) = 'object'
         and (dec->>'effective_at')::timestamptz <= now_ts
         and (new.content, new.label, new.node_type, new.invalidated_at, new.superseded_by)
             is not distinct from (old.content, old.label, old.node_type, old.invalidated_at, old.superseded_by)
         and (new.metadata - 'broken_at' - 'broken_reason' - 'broken_by') = ((old.metadata - 'break_declared') || '{"broken": true}'::jsonb)
         and new.metadata ? 'broken_at'
         and (new.metadata->>'broken_at')::timestamptz between clock_timestamp() - interval '5 minutes' and now_ts + interval '5 minutes'
         and new.metadata->>'broken_reason' is not distinct from dec->>'reason'
         and new.metadata->>'broken_by' = old.mind_id then
        return new;
      end if;
    else
      select * into p from proposals where id = settling;
      if found and p.mind_id = new.mind_id and p.status = 'accepted' and p.settled_at is null and p.withdrawn_at is null
         and p.effective_at <= now_ts and p.proposed_by = p.mind_id then
        if tg_op = 'INSERT' then
          -- the replacement of a rewrite: exactly the declaration's words, tagged with it, and only one per declaration
          if p.action = 'rewrite' and new.node_type = 'identity' and new.content = p.content and new.label = p.section
             and new.invalidated_at is null and new.superseded_by is null
             and new.metadata->>'proposal_id' = p.id::text
             and not exists (select 1 from nodes x where x.mind_id = new.mind_id and x.metadata->>'proposal_id' = p.id::text) then
            return new;
          end if;
        elsif old.id = p.target_node_id and old.node_type = 'identity' and old.invalidated_at is null
              and new.node_type = old.node_type and new.content = old.content and new.label = old.label
              and new.invalidated_at is not null then
          if p.action = 'retire' and new.superseded_by is null then
            return new;
          end if;
          if p.action = 'rewrite' and new.metadata = old.metadata
             and exists (select 1 from nodes s
                          where s.id = new.superseded_by and s.mind_id = old.mind_id and s.node_type = 'identity'
                            and s.content = p.content and s.label = p.section and s.metadata->>'proposal_id' = p.id::text) then
            return new;
          end if;
        end if;
      end if;
    end if;
  end if;
  raise exception 'identity is settled only from the mind''s own declaration' using errcode = 'insufficient_privilege';
end
$$;
create trigger nodes_core_guard_insert before insert on nodes
  for each row execute function nodes_core_guard();
