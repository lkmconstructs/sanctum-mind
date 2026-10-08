-- sanctum-mind v2 self region: identity, vows, anchors, desires and rethink.
-- Update policies on nodes and edges stop requiring authorship, so a grantee with write
-- scope can invalidate or annotate a row another bearer wrote. Authorship is still fixed at
-- insert (the insert policy keeps the written_by check) and a trigger forbids rewriting it.

drop policy nodes_mind on nodes;
create policy nodes_select on nodes for select
  using (mind_id = current_setting('app.mind_id', true));
create policy nodes_insert on nodes for insert
  with check (mind_id = current_setting('app.mind_id', true) and written_by = current_setting('app.bearer', true));
create policy nodes_update on nodes for update
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

drop policy edges_mind on edges;
create policy edges_select on edges for select
  using (mind_id = current_setting('app.mind_id', true));
create policy edges_insert on edges for insert
  with check (mind_id = current_setting('app.mind_id', true) and written_by = current_setting('app.bearer', true));
create policy edges_update on edges for update
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

create function written_by_immutable() returns trigger language plpgsql as $$
begin
  if new.written_by <> old.written_by then
    raise exception 'written_by is fixed at insert and cannot change' using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger nodes_written_by_immutable before update on nodes
  for each row execute function written_by_immutable();
create trigger edges_written_by_immutable before update on edges
  for each row execute function written_by_immutable();

create table proposals (
  id uuid primary key default gen_random_uuid(),
  mind_id text not null references minds (mind_id),
  kind text not null check (kind in ('identity')),
  section text not null,
  content text not null,
  lineage_note text,
  proposed_by text not null references minds (mind_id),
  event_id uuid not null references events (id),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  decided_event_id uuid references events (id),
  decided_at timestamptz,
  created_at timestamptz not null
);
comment on table proposals is 'Changes to a mind proposed by another bearer, pending the owner decision.';

create index proposals_mind_status_idx on proposals (mind_id, status, created_at);

alter table proposals enable row level security;
alter table proposals force row level security;
create policy proposals_mind on proposals for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on proposals to sanctum_app;
