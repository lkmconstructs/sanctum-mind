-- 0010_trigger_tighten: close the loose append-only exception, drop the HNSW indexes, forbid self-loop edges.

-- The ledger stays append-only with one exception: the embedder may fill a null embedding together
-- with its model name. Every other column must be byte-identical. jsonb equality is numeric
-- (100 = 100.000), so columns are compared as TEXT, which preserves the numeric literal as written.
-- payload and texture are compared again on their own, explicitly, because they are the columns a
-- rewrite would target.
create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.embedding is null
     and new.embedding is not null
     and new.embedding_model is not null
     and (to_jsonb(old) - 'embedding' - 'embedding_model' - 'search')::text
         = (to_jsonb(new) - 'embedding' - 'embedding_model' - 'search')::text
     and old.payload::text is not distinct from new.payload::text
     and old.texture::text is not distinct from new.texture::text then
    return new;
  end if;
  raise exception 'events are append-only: % is not allowed', tg_op using errcode = 'restrict_violation';
end
$$;

-- Semantic ranking is an exact ordered scan per mind. An HNSW index under row level security with
-- pgvector 0.6 filters AFTER the index returns its candidates and can silently lose rows, and the
-- planner never used these indexes for the filtered query anyway.
drop index if exists events_embedding_hnsw;
drop index if exists nodes_embedding_hnsw;

alter table edges add constraint edges_no_self_loop check (source_node_id <> target_node_id);
