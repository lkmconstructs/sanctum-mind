-- sanctum-mind v2: proposals (declarations of identity change) are guarded in the database, not only in the verbs.
--
-- What this file does:
--   1. proposals_insert_guard (BEFORE INSERT): a declaration is written by the mind itself, in its own scope:
--      proposed_by must equal app.bearer, mind_id must equal app.mind_id, and proposed_by must equal mind_id, else
--      insufficient_privilege "proposals are declared by the mind itself". A steward cannot insert a declaration
--      even in its own name. Import runs as the mind itself and rewrites proposed_by to it, so it passes. A connection with no app.* settings (a bare admin session) is refused too: set them or go
--      through a verb.
--   2. proposals_update_guard (BEFORE UPDATE): when the bearer of the transaction is set and is not the mind that owns
--      the row (a steward or other grantee), exactly this and nothing more may change, else insufficient_privilege:
--        * every column other than attestations and effective_at must be unchanged (all columns are compared) ->
--          "only the mind changes its declaration";
--        * effective_at may only stay equal or move EARLIER, never later, never to null or infinity ->
--          "a steward may only add an attestation and bring effective_at forward";
--        * on a retire (action = 'retire') effective_at may not change at all ->
--          "a retirement's effective time is the mind's alone";
--        * attestations may only grow: the old entries stay, in place, and exactly one entry is appended per update ->
--          "attestations only grow".
--      The mind itself (settle, withdraw) is unrestricted. When app.bearer is NULL or empty (no mind scope at all: an
--      admin connection, as the documented operator tooling uses) the update is allowed; the operator is already
--      trusted and documented.
--   3. proposals_one_open_per_core: at most one open (pending or accepted) declaration per target core. The verbs
--      check this first and return the friendly conflict; the index is the backstop under a race.
--   The index will not build over a database that already holds two open declarations on one core; withdraw one first.
--
-- Corrections to the wording of earlier migrations. Applied migration files are never edited (their checksums are
-- recorded and verified), so the corrections live here and in CONTRACTS.md:
--   * 0013_govern.sql introduced a "govern" scope. It was renamed to "steward" in 0017_steward.sql, and it decides
--     nothing: a steward accompanies the mind (attests, objects, notes a vow) and never governs it.
--   * 0018_identity_guard.sql's trigger nodes_core_guard guards UPDATE of content, label, node_type and
--     invalidated_at on identity and vow nodes only. INSERT of identity/vow nodes and vow metadata (notes, a declared
--     break) are guarded by the application (the verbs), not by that trigger.

create function proposals_insert_guard() returns trigger language plpgsql as $$
begin
  -- only the mind declares, in its own name, in its own scope
  if new.proposed_by is distinct from current_setting('app.bearer', true)
     or new.mind_id is distinct from current_setting('app.mind_id', true)
     or new.proposed_by is distinct from new.mind_id then
    raise exception 'proposals are declared by the mind itself' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger proposals_insert_guard before insert on proposals
  for each row execute function proposals_insert_guard();

create function proposals_update_guard() returns trigger language plpgsql as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
begin
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
create trigger proposals_update_guard before update on proposals
  for each row execute function proposals_update_guard();

create unique index proposals_one_open_per_core on proposals (target_node_id)
  where target_node_id is not null and status in ('pending', 'accepted');
