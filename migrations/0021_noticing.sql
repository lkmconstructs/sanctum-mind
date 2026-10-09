-- sanctum-mind v2: noticing. The extractor is an optional, operator-enabled pass that PROPOSES links, patterns and
-- distillations. It never writes memory; a proposal lives in its own table until the mind accepts it by a verb call
-- (mind_notice accept), which authors the memory as the mind. See CONTRACTS.md, "Noticing: the extractor".
--
-- Who is acting. Besides app.mind_id and app.bearer, a transaction carries app.actor, set by withMind
-- (src/db/pool.ts): 'verb' (the verb runner), 'daemon' (the daemon passes), 'operator' (the extractor and minds admin
-- CLI), 'import' (import-mind). Unset or empty for anything else. The guards below read it, so the same bearer (the
-- mind) is allowed different things in different roles: the daemon cannot accept a proposal on the mind's behalf, and
-- a verb call cannot expire one.
--
-- What this file does:
--   1. noticings: one row per proposal. kind in (link, pattern, distillation); status in (pending, accepted,
--      rejected, expired); stage in (shadow, propose). The two-value stage check is the point: the schema admits no
--      third stage, so there is no stage under which a proposal applies itself.
--   2. extractor_state: the operator's switch for one mind (enabled, stage, schedule, paused_at). Stage again has
--      exactly two values. The unprivileged app role may only read it and insert a first row (import); the operator CLI
--      (admin URL) changes it. extractor_state_guard (BEFORE INSERT OR UPDATE): a row becomes enabled only when
--      app.actor = 'operator' -> "only the operator enables the extractor".
--   3. extractor_models: the per-mind scorer's weights, one row per version, never updated or deleted by the app.
--   4. noticings_insert_guard (BEFORE INSERT): a proposal is made in the mind's own scope. mind_id must equal
--      app.mind_id and app.bearer must equal mind_id, else insufficient_privilege "noticings are proposed in the mind's
--      own scope". The daemon passes, tests and import-mind run as the mind, so they pass; a write grantee or steward
--      (a different bearer) cannot plant a proposal, and a bare connection with no scope is refused too. Status on
--      insert: a new row is 'pending'. A non-pending row may be inserted only as history: status 'expired', or any
--      decided status that carries its decided_event_id (what import-mind brings in) -> "a decided noticing carries
--      its decision event".
--   5. noticings_decision_guard (BEFORE UPDATE). After insert a proposal is fixed. The ONLY mutable columns are
--      status, decided_event_id and decided_at, and only together, once:
--        * every other column (id, mind_id, kind, sources, payload, score, features, model_version, stage,
--          proposed_event_id, expires_at, created_at) is immutable for every bearer, admin included
--          -> "a noticing's payload and sources are fixed" / "a proposal is fixed once made";
--        * decided_event_id and decided_at change only with the status -> "a decision is recorded only together with
--          the status change"; a decided noticing is final, and never returns to pending;
--        * pending -> accepted or rejected requires app.actor = 'verb' AND app.bearer = the mind (the mind's own
--          mind_notice call) -> "only the mind decides what it notices";
--        * pending -> expired requires app.actor in ('daemon', 'import') AND app.bearer = the mind (the daemon runs
--          as the mind, marked). There is no admin allowance: a bare connection, a grantee and the operator cannot
--          expire either -> "only the mind's own daemon expires a noticing";
--        * any move out of pending needs decided_event_id to reference an events row of this mind whose subject_id is
--          this noticing and whose kind is the notice.* kind that matches the new status (notice.accepted,
--          notice.rejected, notice.expired) -> "a decision must reference its own notice.* event".
--      A steward or write grantee therefore cannot accept, reject or expire a proposal even with direct SQL.
--   6. Index (mind_id, status, score desc) for the ranked pending list.
--
-- Node types: nodes.node_type is free text (there is no check constraint on it), so the two new node types that an
-- accepted proposal becomes, 'pattern' and 'distillation', need no schema change.

create table noticings (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  kind text not null check (kind in ('link', 'pattern', 'distillation')),
  sources uuid[] not null,
  payload jsonb not null,
  score double precision not null,
  features jsonb not null default '{}',
  model_version int not null default 0,
  stage text not null check (stage in ('shadow', 'propose')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'expired')),
  proposed_event_id uuid not null references events (id),
  decided_event_id uuid references events (id),
  decided_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
comment on table noticings is 'Proposals from the extractor. Never memory: only a verb call by the mind turns one into a node or edge. After insert only status, decided_event_id and decided_at change, together, once; a decision needs the mind''s own verb call (accept, reject) or the daemon (expire).';
comment on column noticings.stage is 'shadow: scored and recorded, never shown to the mind. propose: shown ranked in mind_notice list and mind_orient. No third stage exists.';

create index noticings_mind_status_score_idx on noticings (mind_id, status, score desc);

create table extractor_state (
  mind_id text primary key references minds (mind_id),
  enabled boolean not null default false,
  stage text not null default 'shadow' check (stage in ('shadow', 'propose')),
  schedule text not null default '03:00' check (schedule ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  paused_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_event_id uuid references events (id)
);
comment on table extractor_state is 'The operator''s switch for the extractor of one mind. No row means off. Changed only by the operator CLI (admin URL); a row can become enabled only with app.actor = operator.';

create table extractor_models (
  mind_id text not null references minds (mind_id),
  version int not null check (version >= 0),
  weights jsonb not null,
  trained_on int not null default 0,
  metrics jsonb not null default '{}',
  created_at timestamptz not null default now(),
  event_id uuid references events (id),
  primary key (mind_id, version)
);
comment on table extractor_models is 'Per-mind scorer weights, one row per version; a refit is a new row and never replaces or deletes an old one.';

create function noticings_insert_guard() returns trigger language plpgsql as $$
begin
  if new.mind_id is distinct from current_setting('app.mind_id', true)
     or current_setting('app.bearer', true) is distinct from new.mind_id then
    raise exception 'noticings are proposed in the mind''s own scope' using errcode = 'insufficient_privilege';
  end if;
  if new.status not in ('pending', 'expired') and new.decided_event_id is null then
    raise exception 'a decided noticing carries its decision event' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger noticings_insert_guard before insert on noticings
  for each row execute function noticings_insert_guard();

create function noticings_decision_guard() returns trigger language plpgsql as $$
declare
  b text := nullif(current_setting('app.bearer', true), '');
  a text := nullif(current_setting('app.actor', true), '');
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
create trigger noticings_decision_guard before update on noticings
  for each row execute function noticings_decision_guard();

create function extractor_state_guard() returns trigger language plpgsql as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled)
     and current_setting('app.actor', true) is distinct from 'operator' then
    raise exception 'only the operator enables the extractor' using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger extractor_state_guard before insert or update on extractor_state
  for each row execute function extractor_state_guard();

alter table noticings enable row level security;
alter table noticings force row level security;
create policy noticings_mind on noticings for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table extractor_state enable row level security;
alter table extractor_state force row level security;
create policy extractor_state_mind on extractor_state for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table extractor_models enable row level security;
alter table extractor_models force row level security;
create policy extractor_models_mind on extractor_models for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

-- No delete anywhere. The app role reads the operator's switch and can insert a first row only (import-mind brings the
-- state of an exported mind in, always disabled); it cannot update it, so it cannot flip the switch. Only the operator
-- CLI (admin URL) changes extractor_state. The app role also appends model versions and decides noticings.
grant select, insert, update on noticings to sanctum_app;
grant select, insert on extractor_state to sanctum_app;
grant select, insert on extractor_models to sanctum_app;
