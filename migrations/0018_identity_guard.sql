-- sanctum-mind v2: identity belongs to the mind, enforced in the database as well as in the verbs.
-- Content, label, type and invalidation of an identity or vow node may change only when the bearer of the
-- transaction is the mind that owns the node. Settlement runs as the mind, so it passes; a grantee's raw
-- update does not. Metadata (notes, a declared break) is not guarded here.

create function nodes_core_guard() returns trigger language plpgsql as $$
begin
  if (old.node_type in ('identity', 'vow') or new.node_type in ('identity', 'vow'))
     and (new.content, new.label, new.node_type, new.invalidated_at)
         is distinct from (old.content, old.label, old.node_type, old.invalidated_at)
     and current_setting('app.bearer', true) is distinct from old.mind_id then
    raise exception 'identity belongs to the mind' using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger nodes_core_guard before update on nodes
  for each row execute function nodes_core_guard();

comment on table proposals is 'Declarations of identity change by the mind; rows from 0013 are historical.';
