-- The Revien importer looks nodes up by the original id kept in metadata; index that lookup.
create index nodes_revien_node_id_idx on nodes (mind_id, (metadata->>'revien_node_id'))
  where metadata->>'revien_node_id' is not null;
