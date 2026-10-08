-- 0016_integrity2: cross-mind references are refused by the database, and purge says so by name.
--
-- 1. nodes.superseded_by and proposals.target_node_id may only point at a node of the same mind
--    (composite foreign keys on the (mind_id, id) unique key from 0005). A null stays allowed (MATCH SIMPLE).
-- 2. purge_mind refuses, before deleting anything, when rows of OTHER minds reference rows of the mind being
--    purged through any foreign key, instead of failing late with a raw foreign key violation.

alter table nodes add constraint nodes_superseded_same_mind
  foreign key (mind_id, superseded_by) references nodes (mind_id, id);

alter table proposals drop constraint proposals_target_node_id_fkey;
alter table proposals add constraint proposals_target_same_mind
  foreign key (mind_id, target_node_id) references nodes (mind_id, id);

create or replace function purge_mind(p_mind text, p_sever_letters boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  counts jsonb := '{}'::jsonb;
  n bigint;
  remaining text[];
  pick text[];
  t text;
  r record;
  forced text[] := '{}';
  bypass boolean;
  foreign_letters bigint;
  authored text := '';
  referenced text := '';
  m bigint;
  joincond text;
  notown text;
begin
  if not exists (select 1 from minds where mind_id = p_mind) then
    raise exception 'mind "%" does not exist', p_mind using errcode = 'no_data_found';
  end if;

  -- An owner that is neither superuser nor BYPASSRLS is still bound by FORCE ROW LEVEL SECURITY, and
  -- the policies define no delete. Lift FORCE for this transaction (restored below, rolled back on error).
  select rolsuper or rolbypassrls into bypass from pg_roles where rolname = current_user;
  if not coalesce(bypass, false) then
    for r in
      select c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relforcerowsecurity
    loop
      execute format('alter table %I no force row level security', r.relname);
      forced := forced || r.relname::text;
    end loop;
  end if;

  -- Letters where another mind is a party.
  select count(*) into foreign_letters from letters
   where (from_mind = p_mind and to_mind <> p_mind) or (to_mind = p_mind and from_mind <> p_mind);
  if foreign_letters > 0 and not p_sever_letters then
    raise exception 'mind "%" is a party to % letter(s) held by other minds; purge refuses unless severing them (--sever-letters), which deletes those letters too',
      p_mind, foreign_letters using errcode = 'restrict_violation';
  end if;

  -- Rows of other minds that this mind authored (any foreign key to minds outside letters and grants).
  for r in
    select cl.relname as tbl, a.attname as col,
           exists (select 1 from information_schema.columns ic
                    where ic.table_schema = 'public' and ic.table_name = cl.relname and ic.column_name = 'mind_id') as has_mind
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid and cl.relnamespace = 'public'::regnamespace
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = 'public.minds'::regclass and array_length(c.conkey, 1) = 1
       and cl.relname not in ('letters', 'grants')
       and a.attname <> 'mind_id'
  loop
    if r.has_mind then
      execute format('select count(*) from %I where %I = $1 and mind_id <> $1', r.tbl, r.col) into m using p_mind;
    else
      execute format('select count(*) from %I where %I = $1', r.tbl, r.col) into m using p_mind;
    end if;
    if m > 0 then
      authored := authored || format(' %s.%s=%s', r.tbl, r.col, m);
    end if;
  end loop;
  if authored <> '' then
    raise exception 'mind "%" authored rows inside other minds, which a purge cannot remove:%', p_mind, authored
      using errcode = 'restrict_violation';
  end if;

  -- Rows of other minds that point INTO this mind's rows through any foreign key. Without this check the
  -- delete below would fail late with a raw foreign key violation. A referencing row counts as "another
  -- mind's" when its own mind_id differs, or (letters, which have no mind_id) when this mind is not a party.
  -- Letters of this mind's counterparties that reference its events are handled by the letters rule above.
  for r in
    select c.oid as coid, cl.relname as tbl, rf.relname as reftbl,
           (select string_agg(a.attname, ',' order by u.ord)
              from unnest(c.conkey) with ordinality u(attnum, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum) as cols,
           exists (select 1 from information_schema.columns ic
                    where ic.table_schema = 'public' and ic.table_name = cl.relname and ic.column_name = 'mind_id') as has_mind
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid and cl.relnamespace = 'public'::regnamespace
      join pg_class rf on rf.oid = c.confrelid and rf.relnamespace = 'public'::regnamespace
     where c.contype = 'f' and rf.relname <> 'minds'
       and exists (select 1 from information_schema.columns ic
                    where ic.table_schema = 'public' and ic.table_name = rf.relname and ic.column_name = 'mind_id')
  loop
    select string_agg(format('a.%I = r.%I', ak.attname, rk.attname), ' and ' order by u.ord) into joincond
      from pg_constraint c
      cross join lateral unnest(c.conkey, c.confkey) with ordinality as u(ka, kr, ord)
      join pg_attribute ak on ak.attrelid = c.conrelid and ak.attnum = u.ka
      join pg_attribute rk on rk.attrelid = c.confrelid and rk.attnum = u.kr
     where c.oid = r.coid;
    if r.has_mind then
      notown := 'a.mind_id <> $1';
    elsif r.tbl = 'letters' then
      notown := 'a.from_mind <> $1 and a.to_mind <> $1';
    else
      continue;
    end if;
    execute format('select count(*) from %I a join %I r on %s where r.mind_id = $1 and %s', r.tbl, r.reftbl, joincond, notown)
      into m using p_mind;
    if m > 0 then
      referenced := referenced || format(' %s.%s=%s', r.tbl, r.cols, m);
    end if;
  end loop;
  if referenced <> '' then
    raise exception 'mind "%" is referenced by rows of other minds, which a purge cannot remove (table.column=count):%', p_mind, referenced
      using errcode = 'restrict_violation';
  end if;

  alter table events disable trigger events_no_update_delete;

  -- letters reference events, so they go first
  delete from letters where from_mind = p_mind or to_mind = p_mind;
  get diagnostics n = row_count;
  counts := counts || jsonb_build_object('letters', n);
  counts := counts || jsonb_build_object('letters_severed', case when p_sever_letters then foreign_letters else 0 end);

  select coalesce(array_agg(table_name::text), '{}') into remaining
    from information_schema.columns
   where table_schema = 'public' and column_name = 'mind_id'
     and table_name in (select table_name from information_schema.tables
                         where table_schema = 'public' and table_type = 'BASE TABLE')
     and table_name <> 'minds';

  while coalesce(array_length(remaining, 1), 0) > 0 loop
    select coalesce(array_agg(x), '{}') into pick
      from unnest(remaining) x
     where not exists (
       select 1 from pg_constraint c
         join pg_class a on a.oid = c.conrelid and a.relnamespace = 'public'::regnamespace
         join pg_class b on b.oid = c.confrelid and b.relnamespace = 'public'::regnamespace
        where c.contype = 'f' and b.relname = x and a.relname <> x and a.relname = any (remaining));
    if coalesce(array_length(pick, 1), 0) = 0 then
      raise exception 'purge cannot order tables with a foreign key cycle among: %', remaining;
    end if;
    foreach t in array pick loop
      execute format('delete from %I where mind_id = $1', t) using p_mind;
      get diagnostics n = row_count;
      counts := counts || jsonb_build_object(t, n);
      remaining := array_remove(remaining, t);
    end loop;
  end loop;

  delete from grants where grantor_mind = p_mind or grantee_mind = p_mind;
  get diagnostics n = row_count;
  counts := counts || jsonb_build_object('grants', n);

  delete from minds where mind_id = p_mind;
  get diagnostics n = row_count;
  counts := counts || jsonb_build_object('minds', n);

  alter table events enable trigger events_no_update_delete;
  foreach t in array forced loop
    execute format('alter table %I force row level security', t);
  end loop;
  return counts;
end
$$;

revoke all on function purge_mind(text, boolean) from public;
