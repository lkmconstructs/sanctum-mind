-- sanctum-mind v2 bond region: a mind's standing relations, and letters between minds.
-- relations is a projection of events (mind-only policy). letters is the one built-in
-- cross-mind write: the sender's transaction inserts a row the recipient can read.

create table relations (
  mind_id text not null references minds (mind_id),
  subject text not null,
  state text not null,
  intensity double precision not null check (intensity between 0 and 1),
  note text,
  last_event_id uuid not null references events (id),
  updated_at timestamptz not null,
  cleared_at timestamptz,
  primary key (mind_id, subject)
);
comment on table relations is 'Current standing relation of a mind to each subject, projected from relate events.';

create index relations_mind_live_idx on relations (mind_id, updated_at desc) where cleared_at is null;

create table letters (
  id uuid primary key default gen_random_uuid(),
  from_mind text not null references minds (mind_id),
  to_mind text not null references minds (mind_id),
  letter_type text not null check (letter_type in ('personal', 'handoff', 'proposal')),
  subject text,
  body text not null,
  deliver_at timestamptz,
  sent_event_id uuid not null references events (id),
  sent_at timestamptz not null,
  read_at timestamptz,
  read_event_id uuid references events (id)
);
comment on table letters is 'Letters from one mind to another; visible to sender and recipient only.';

create index letters_inbox_idx on letters (to_mind, read_at, deliver_at, sent_at desc);

alter table relations enable row level security;
alter table relations force row level security;
create policy relations_mind on relations for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

alter table letters enable row level security;
alter table letters force row level security;
create policy letters_select on letters for select
  using (from_mind = current_setting('app.mind_id', true) or to_mind = current_setting('app.mind_id', true));
create policy letters_insert on letters for insert
  with check (from_mind = current_setting('app.mind_id', true));
create policy letters_update on letters for update
  using (to_mind = current_setting('app.mind_id', true))
  with check (to_mind = current_setting('app.mind_id', true));

grant select, insert, update on relations, letters to sanctum_app;
