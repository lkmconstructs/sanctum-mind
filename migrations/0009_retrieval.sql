-- 0009_retrieval: full text and vector indexes plus the embedding model record.

alter table events add column embedding_model text;
alter table events add column search tsvector generated always as (
  to_tsvector('simple', coalesce(payload->>'text','') || ' ' || coalesce(payload->>'content','') || ' ' || coalesce(payload->>'label',''))
) stored;
create index events_search_gin on events using gin (search);
create index events_embedding_hnsw on events using hnsw (embedding vector_cosine_ops);

alter table nodes add column embedding_model text;
alter table nodes add column search tsvector generated always as (
  to_tsvector('simple', label || ' ' || content)
) stored;
create index nodes_search_gin on nodes using gin (search);
create index nodes_embedding_hnsw on nodes using hnsw (embedding vector_cosine_ops);

-- The ledger stays append-only, with one exception: the embedder backfill may fill in a null
-- embedding (and its model name) on an existing row. Every other column must be unchanged.
create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.embedding is null
     and (to_jsonb(new) - 'embedding' - 'embedding_model' - 'search') = (to_jsonb(old) - 'embedding' - 'embedding_model' - 'search') then
    return new;
  end if;
  raise exception 'events are append-only: % is not allowed', tg_op using errcode = 'restrict_violation';
end
$$;
