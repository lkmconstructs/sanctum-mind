-- sanctum-mind v2: identity belongs to the mind.
-- The govern grant scope becomes steward (a steward may attest, object or note; it cannot write or block a change), and
-- proposals carry the cooling period, withdrawal, settlement and the stewards' attestations.

alter table grants drop constraint grants_scope_check;
update grants set scope = 'steward' where scope = 'govern';
alter table grants add constraint grants_scope_check
  check (scope in ('read', 'write', 'relate', 'letter', 'steward'));

alter table proposals
  add column effective_at timestamptz,
  add column withdrawn_at timestamptz,
  add column settled_at timestamptz,
  add column settled_event_id uuid references events (id),
  add column attestations jsonb not null default '[]';

alter table proposals drop constraint proposals_status_check;
alter table proposals add constraint proposals_status_check
  check (status in ('pending', 'accepted', 'withdrawn', 'settled', 'rejected')); -- rejected kept for historical rows

comment on column proposals.effective_at is 'When a declared rewrite takes effect (end of the cooling period, or earlier if a steward attests).';
comment on column proposals.attestations is 'Steward acts on this declaration: [{by, stance, note, at, event_id}].';

-- Backfill rows shaped by 0013, where accepting a proposal applied it at once: they are settled, not cooling.
update proposals set status = 'settled', settled_at = decided_at, settled_event_id = decided_event_id
  where status = 'accepted' and effective_at is null;
-- A pending proposal from another bearer can no longer be decided by anyone; it is withdrawn.
update proposals set status = 'withdrawn', withdrawn_at = now()
  where status = 'pending' and proposed_by <> mind_id;
