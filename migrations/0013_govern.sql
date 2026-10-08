-- sanctum-mind v2 governance: the govern grant scope and rewrite proposals.
-- Identity and vow nodes change only through the proposal flow; a govern grantee may decide
-- proposals and break vows without owning the mind.

alter table grants drop constraint grants_scope_check;
alter table grants add constraint grants_scope_check
  check (scope in ('read', 'write', 'relate', 'letter', 'govern'));

-- A proposal with a target is a rewrite of that identity node; without one it is an addition.
alter table proposals add column target_node_id uuid references nodes (id);
comment on column proposals.target_node_id is 'Identity node this proposal rewrites when accepted; null for an addition.';
