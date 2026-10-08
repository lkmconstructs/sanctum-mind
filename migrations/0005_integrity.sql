-- 0005_integrity: make the database refuse cross-mind edges and inverted event times.

alter table nodes add constraint nodes_mind_id_unique unique (mind_id, id);

alter table edges add constraint edges_source_same_mind
  foreign key (mind_id, source_node_id) references nodes (mind_id, id);
alter table edges add constraint edges_target_same_mind
  foreign key (mind_id, target_node_id) references nodes (mind_id, id);

alter table events add constraint events_event_time_order
  check (event_time_end is null or event_time_start is null or event_time_end >= event_time_start);
alter table nodes add constraint nodes_event_time_order
  check (event_time_end is null or event_time_start is null or event_time_end >= event_time_start);
