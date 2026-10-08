-- sanctum-mind v2 outbox: one row per (event, sink), written in the event's own transaction and
-- delivered by the daemon pass outbox.deliver. At-least-once; receivers dedupe on event id.

create table event_outbox (
  id bigint generated always as identity primary key,
  event_id uuid not null references events (id),
  mind_id text not null references minds (mind_id),
  sink text not null,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  last_error text,
  unique (event_id, sink)
);
comment on table event_outbox is 'Delivery queue of committed events to configured sinks; the ledger stays canonical.';

create index event_outbox_sink_due_idx on event_outbox (sink, delivered_at, next_attempt_at);
create index event_outbox_mind_idx on event_outbox (mind_id);

alter table event_outbox enable row level security;
alter table event_outbox force row level security;
create policy event_outbox_mind on event_outbox for all
  using (mind_id = current_setting('app.mind_id', true))
  with check (mind_id = current_setting('app.mind_id', true));

grant select, insert, update on event_outbox to sanctum_app;
