-- Two TRD records kept as views over the data that already holds them, so nothing is stored twice (TRD §4.1, §4.5).

-- label.item_events: each label item's history (added, renamed, and later merged or archived), read from the
-- activity log, whose payload keeps the old and new name (T-13).
create view label.item_events with (security_invoker = true) as
select l.entity_id as item_id, l.action as event, l.actor_kind, l.actor_member_id, l.occurred_at, l.reason, l.payload, l.id as activity_id
from audit.activity_log l
where l.entity_type = 'label_item';
grant select on label.item_events to authenticated;

-- ingest.manual_entries: every result entered by hand, corrections and withdrawn entries included, with who entered it
-- and when (D-36, D-61). Each entry is a published revision in a run of kind manual_entry (§8.3, A5c); this lists
-- them all, where reporting.manual_results gives only the current one. Like the rest of ingest it is not exposed
-- through the API (D-08); the app reads reporting.manual_results.
create view ingest.manual_entries with (security_invoker = true) as
select r.id as revision_id, run.entered_by, r.created_at as entered_at, ac.platform, ac.id as account_id, l.id as launch_id,
  va.code as variant_code, o.period_start, o.period_end, s.channel_scope, s.currency, s.result_indicator,
  (select jsonb_object_agg(mv.metric_key, mv.value) from measure.metric_values mv where mv.revision_id = r.id) as metric_values,
  o.superseded_at is not null or r.id is distinct from (
    select rr.id from measure.observation_revisions rr where rr.observation_id = o.id and rr.published_at is not null
    order by rr.generation desc, rr.created_at desc limit 1) as replaced
from measure.observation_revisions r
join ingest.sync_runs run on run.id = r.run_id and run.kind = 'manual_entry'
join measure.observations o on o.id = r.observation_id
join measure.report_scopes s on s.id = o.scope_id
join measure.reporting_entities e on e.id = o.entity_id
join launch.launches l on l.id = e.launch_id
join creative.variants va on va.id = l.variant_id
join launch.accounts ac on ac.id = l.account_id
where r.published_at is not null;
