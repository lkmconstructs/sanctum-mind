-- mind_weather scans a mind's events by time window; index the window and the textured subset.
create index events_mind_created on events (mind_id, created_at desc);
create index events_mind_textured on events (mind_id, created_at desc) where texture is not null;
