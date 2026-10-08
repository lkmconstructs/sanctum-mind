-- 0015_purge: the one deletion path in the system. purge_mind removes a mind and everything of its
-- own: every row of every table that has a mind_id column, the letters it is a party to, the
-- grants touching it, and the minds row. It is SECURITY DEFINER and owned by the role that ran
-- the migration (the admin), and EXECUTE is revoked from everyone else, so the unprivileged
-- sanctum_app login can neither call it nor delete anything itself.
--
-- Tables are discovered at runtime (pg_constraint for the foreign keys, information_schema for the
-- mind_id columns), so tables added by later migrations are purged without editing this function.
-- Deletion order is a topological sort of the foreign keys among those tables: a table is deleted
-- only when no table still holding rows references it.
--
-- The events append-only trigger is disabled with ALTER TABLE for the duration. That DDL is
-- transactional: it is re-enabled before the function returns, and a failure anywhere rolls the
-- whole purge (including the trigger change) back.
--
-- Refusals (nothing is deleted): the mind does not exist; another mind still holds letters with
-- this mind as a party and p_sever_letters is false; rows of other minds were authored by this
-- mind (written_by, proposed_by or any other column referencing minds), because rewriting someone
-- else's ledger is not a purge.

create function purge_mind(p_mind text, p_sever_letters boolean default false) returns jsonb
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
  m bigint;
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
comment on function purge_mind(text, boolean) is 'Admin-only: deletes a mind and everything of its own in one transaction; the only deletion path.';
