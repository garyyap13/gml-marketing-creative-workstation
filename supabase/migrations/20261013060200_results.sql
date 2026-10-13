-- Results (D-35–D-39, D-42; FR-08, T-06, T-08): daily ad-level paid observations from each published sync
-- generation, kept as append-only revisions, read through curated reporting views. This is the thin first cut of
-- the measurement contract; organic Post insights, Breakdowns, CSV and manual entry follow (A5, B3).

create table measure.metric_definitions (
  key text not null,
  version integer not null,
  unit text not null check (unit in ('currency', 'count')),
  aggregation text not null check (aggregation in ('sum', 'none')), -- 'none': never summed, like Reach (D-37)
  source_field text not null,
  primary key (key, version)
);
insert into measure.metric_definitions (key, version, unit, aggregation, source_field) values
  ('spend', 1, 'currency', 'sum', 'spend'),
  ('impressions', 1, 'count', 'sum', 'impressions'),
  ('reach', 1, 'count', 'none', 'reach'),
  ('link_clicks', 1, 'count', 'sum', 'inline_link_clicks'),
  ('results', 1, 'count', 'sum', 'results');

-- Every scope dimension is a non-null canonical value, so nulls cannot create duplicate totals (T-06).
create table measure.report_scopes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references launch.accounts (id),
  entity_level text not null check (entity_level in ('ad', 'ad_set', 'campaign', 'post')),
  channel_scope text not null check (channel_scope in ('organic_only', 'paid_only', 'combined', 'unknown')),
  period_kind text not null check (period_kind in ('daily', 'rolling', 'lifetime')),
  time_zone text not null,
  currency text not null,
  attribution_setting text not null,
  result_indicator text not null,
  breakdown_schema text not null,
  definition_version integer not null,
  unique (account_id, entity_level, channel_scope, period_kind, time_zone, currency, attribution_setting, result_indicator,
    breakdown_schema, definition_version)
);

create table measure.reporting_entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('meta_ad', 'meta_ad_set', 'meta_campaign', 'meta_post', 'manual')),
  meta_ad_id uuid unique references meta.ads (id),
  constraint reporting_entities_typed check (entity_type <> 'meta_ad' or meta_ad_id is not null)
);

create table measure.observations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references measure.reporting_entities (id),
  scope_id uuid not null references measure.report_scopes (id),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  breakdown_key text not null default '',
  source_action_type text not null default '',
  unique (entity_id, scope_id, period_start, period_end, breakdown_key, source_action_type)
);

-- Append-only. The current revision of an observation is its latest published one (T-06).
create table measure.observation_revisions (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid not null references measure.observations (id),
  run_id uuid not null references ingest.sync_runs (id),
  generation integer not null,
  source text not null check (source in ('api', 'csv_import', 'manual')),
  checksum text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (observation_id, run_id)
);
create index observation_revisions_current on measure.observation_revisions (observation_id, generation desc) where published_at is not null;

-- A missing value is null with a reason, never zero; a reported zero stays zero (D-37).
create table measure.metric_values (
  revision_id uuid not null references measure.observation_revisions (id),
  metric_key text not null,
  definition_version integer not null,
  value numeric,
  availability_reason text check (availability_reason in ('unsupported', 'permission_denied', 'not_returned', 'not_applicable')),
  primary key (revision_id, metric_key),
  foreign key (metric_key, definition_version) references measure.metric_definitions (key, version),
  constraint metric_values_value_or_reason check ((value is null) = (availability_reason is not null))
);


alter table measure.metric_definitions enable row level security;
alter table measure.report_scopes enable row level security;
alter table measure.reporting_entities enable row level security;
alter table measure.observations enable row level security;
alter table measure.observation_revisions enable row level security;
alter table measure.metric_values enable row level security;
grant select, insert on measure.report_scopes, measure.reporting_entities, measure.observations, measure.metric_values to api_owner;
grant select, insert, update on measure.observation_revisions to api_owner; -- update only to publish
grant select on measure.metric_definitions to api_owner;
create policy metric_definitions_commands on measure.metric_definitions to api_owner using (true);
create policy report_scopes_commands on measure.report_scopes to api_owner using (true) with check (true);
create policy reporting_entities_commands on measure.reporting_entities to api_owner using (true) with check (true);
create policy observations_commands on measure.observations to api_owner using (true) with check (true);
create policy observation_revisions_commands on measure.observation_revisions to api_owner using (true) with check (true);
create policy metric_values_commands on measure.metric_values to api_owner using (true) with check (true);

-- Members read measurements only through the reporting views (security invoker); the measure schema itself is not
-- exposed through the API.
grant usage on schema measure to authenticated;
grant select on measure.metric_definitions, measure.report_scopes, measure.reporting_entities, measure.observations,
  measure.observation_revisions, measure.metric_values to authenticated;
create policy metric_definitions_read on measure.metric_definitions for select to authenticated using ((select app.is_active_member()));
create policy report_scopes_read on measure.report_scopes for select to authenticated using ((select app.is_active_member()));
create policy reporting_entities_read on measure.reporting_entities for select to authenticated using ((select app.is_active_member()));
create policy observations_read on measure.observations for select to authenticated using ((select app.is_active_member()));
create policy observation_revisions_read on measure.observation_revisions for select to authenticated using ((select app.is_active_member()));
create policy metric_values_read on measure.metric_values for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Normalises one generation's daily ad-level insights into observation revisions (T-06, T-07 step 3). A value that
-- is not a plain number quarantines its row; nothing is silently coerced. A day whose values did not change keeps
-- its current revision.
create function app.record_insights(p_run ingest.sync_runs, p_insights jsonb) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account launch.accounts;
  v_row jsonb;
  v_position bigint;
  v_ad meta.ads;
  v_ad_set meta.ad_sets;
  v_entity_id uuid;
  v_scope_id uuid;
  v_observation_id uuid;
  v_values jsonb;
  v_checksum text;
  v_revision_id uuid;
  v_bad text;
  v_indicator text;
  v_seen uuid[] := '{}'::uuid[];
begin
  select * into v_account from launch.accounts where id = p_run.account_id;
  for v_row, v_position in select r, n from jsonb_array_elements(coalesce(p_insights, '[]')) with ordinality as i(r, n) loop
    select * into v_ad from meta.ads where account_id = v_account.id and external_id = v_row ->> 'ad_id';
    -- Each metric: a number from Meta's numeric string, or null with the reason it is missing.
    v_values := jsonb_build_object(
      'spend', v_row -> 'spend', 'impressions', v_row -> 'impressions', 'reach', v_row -> 'reach',
      'link_clicks', v_row -> 'inline_link_clicks', 'results', v_row #> '{results,0,values,0,value}');
    select string_agg(key, ', ') into v_bad from jsonb_each(v_values)
    where value <> 'null'::jsonb and not (jsonb_typeof(value) = 'string' and value #>> '{}' ~ '^[0-9]+(\.[0-9]+)?$');
    if v_ad.id is null or v_bad is not null
      or not coalesce(pg_input_is_valid(v_row ->> 'date_start', 'date') and pg_input_is_valid(v_row ->> 'date_stop', 'date'), false)
      or (v_row ->> 'date_start') !~ '^\d{4}-\d{2}-\d{2}$' or (v_row ->> 'date_stop') !~ '^\d{4}-\d{2}-\d{2}$'
      or (v_row ->> 'date_stop') < (v_row ->> 'date_start') then
      insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
      values (p_run.id, format('insights[%s]', v_position - 1), v_row,
        case when v_ad.id is null then 'Unknown ad' when v_bad is not null then format('Not a number: %s', v_bad) else 'Not a valid period' end);
      continue;
    end if;
    select * into v_ad_set from meta.ad_sets where id = v_ad.ad_set_id;
    -- The result type belongs to the ad set's optimisation goal (D-39): a day without a results entry keeps it.
    v_indicator := v_row #>> '{results,0,indicator}';
    if v_indicator is not null and v_ad_set.id is not null and v_ad_set.result_indicator is distinct from v_indicator then
      update meta.ad_sets set result_indicator = v_indicator where id = v_ad_set.id returning * into v_ad_set;
    end if;
    v_indicator := coalesce(v_indicator, v_ad_set.result_indicator, 'none');

    insert into measure.reporting_entities (entity_type, meta_ad_id) values ('meta_ad', v_ad.id)
    on conflict (meta_ad_id) do nothing;
    select id into v_entity_id from measure.reporting_entities where meta_ad_id = v_ad.id;

    insert into measure.report_scopes (account_id, entity_level, channel_scope, period_kind, time_zone, currency, attribution_setting,
      result_indicator, breakdown_schema, definition_version)
    values (v_account.id, 'ad', 'paid_only', 'daily', coalesce(v_account.time_zone, 'unknown'), coalesce(v_account.currency, 'unknown'),
      coalesce(v_row ->> 'attribution_setting', v_ad_set.attribution_setting, 'not_applicable'),
      v_indicator, 'none', 1)
    on conflict (account_id, entity_level, channel_scope, period_kind, time_zone, currency, attribution_setting, result_indicator,
      breakdown_schema, definition_version) do nothing;
    select id into v_scope_id from measure.report_scopes
    where account_id = v_account.id and entity_level = 'ad' and channel_scope = 'paid_only' and period_kind = 'daily'
      and time_zone = coalesce(v_account.time_zone, 'unknown') and currency = coalesce(v_account.currency, 'unknown')
      and attribution_setting = coalesce(v_row ->> 'attribution_setting', v_ad_set.attribution_setting, 'not_applicable')
      and result_indicator = v_indicator and breakdown_schema = 'none' and definition_version = 1;

    insert into measure.observations (entity_id, scope_id, period_start, period_end)
    values (v_entity_id, v_scope_id, (v_row ->> 'date_start')::date, (v_row ->> 'date_stop')::date)
    on conflict (entity_id, scope_id, period_start, period_end, breakdown_key, source_action_type) do nothing;
    select id into v_observation_id from measure.observations
    where entity_id = v_entity_id and scope_id = v_scope_id and period_start = (v_row ->> 'date_start')::date
      and period_end = (v_row ->> 'date_stop')::date and breakdown_key = '' and source_action_type = '';

    -- The same ad and day twice in one generation cannot both be right.
    if exists (select 1 from measure.observation_revisions where observation_id = v_observation_id and run_id = p_run.id) then
      insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
      values (p_run.id, format('insights[%s]', v_position - 1), v_row, 'Duplicate row for this ad and period');
      continue;
    end if;
    v_checksum := md5(v_values::text);
    if v_checksum is not distinct from (
      select checksum from measure.observation_revisions
      where observation_id = v_observation_id and published_at is not null order by generation desc limit 1) then
      if v_observation_id = any (v_seen) then
        insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
        values (p_run.id, format('insights[%s]', v_position - 1), v_row, 'Duplicate row for this ad and period');
      end if;
      v_seen := v_seen || v_observation_id;
      continue;
    end if;
    v_seen := v_seen || v_observation_id;
    insert into measure.observation_revisions (observation_id, run_id, generation, source, checksum)
    values (v_observation_id, p_run.id, p_run.generation, 'api', v_checksum)
    returning id into v_revision_id;
    insert into measure.metric_values (revision_id, metric_key, definition_version, value, availability_reason)
    select v_revision_id, key, 1, case when value = 'null'::jsonb then null else (value #>> '{}')::numeric end,
      case when value = 'null'::jsonb then 'not_returned' end
    from jsonb_each(v_values);
  end loop;
end;
$$;

create or replace function worker.record_meta_sync(p_ad_account_id text, p_payload jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := set_config('app.correlation_id', gen_random_uuid()::text, true)::uuid;
  v_account launch.accounts;
  v_run ingest.sync_runs;
  v_ads jsonb;
begin
  select * into v_account from launch.accounts where platform = 'meta_ad_account' and external_id = p_ad_account_id;
  if v_account.id is null then
    raise exception 'unknown ad account %', p_ad_account_id;
  end if;
  insert into ingest.sync_runs (account_id, generation, kind, state)
  values (v_account.id, coalesce((select max(generation) from ingest.sync_runs where account_id = v_account.id), 0) + 1, 'stand_in', 'running')
  returning * into v_run;

  insert into meta.campaigns (account_id, external_id, name, objective)
  select v_account.id, c ->> 'id', c ->> 'name', c ->> 'objective' from jsonb_array_elements(coalesce(p_payload -> 'campaigns', '[]')) c
  where coalesce(c ->> 'id', '') <> '' and coalesce(c ->> 'name', '') <> ''
  on conflict (account_id, external_id) do update set name = excluded.name, objective = excluded.objective;

  insert into meta.ad_sets (account_id, campaign_id, external_id, name, optimization_goal, attribution_setting)
  select v_account.id, (select id from meta.campaigns where account_id = v_account.id and external_id = s ->> 'campaign_id'),
    s ->> 'id', s ->> 'name', s ->> 'optimization_goal', s ->> 'attribution_setting'
  from jsonb_array_elements(coalesce(p_payload -> 'adsets', '[]')) s
  where coalesce(s ->> 'id', '') <> '' and coalesce(s ->> 'name', '') <> ''
  on conflict (account_id, external_id) do update
  set name = excluded.name, campaign_id = excluded.campaign_id, optimization_goal = excluded.optimization_goal,
    attribution_setting = excluded.attribution_setting;

  -- An ad without its ID, name, ad set or status cannot be matched; it is set aside, not guessed at.
  insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
  select v_run.id, format('ads[%s]', n - 1), a, 'Missing id, name, adset_id or effective_status'
  from jsonb_array_elements(coalesce(p_payload -> 'ads', '[]')) with ordinality as x(a, n)
  where coalesce(a ->> 'id', '') = '' or coalesce(a ->> 'name', '') = '' or coalesce(a ->> 'adset_id', '') = '' or coalesce(a ->> 'effective_status', '') = '';
  select coalesce(jsonb_agg(a), '[]') into v_ads from jsonb_array_elements(coalesce(p_payload -> 'ads', '[]')) a
  where coalesce(a ->> 'id', '') <> '' and coalesce(a ->> 'name', '') <> '' and coalesce(a ->> 'adset_id', '') <> '' and coalesce(a ->> 'effective_status', '') <> '';

  insert into meta.ads (account_id, ad_set_id, adset_external_id, external_id, name, parsed_codes, media_id, effective_status, last_seen_run_id)
  select v_account.id, (select id from meta.ad_sets where account_id = v_account.id and external_id = a ->> 'adset_id'), a ->> 'adset_id',
    a ->> 'id', a ->> 'name',
    array(select distinct m[1] from regexp_matches(a ->> 'name', '\[([A-Z][A-Z0-9]*-[0-9]+(?:-[A-Z]+)?)\]', 'g') as m),
    coalesce(a -> 'creative' ->> 'video_id', a -> 'creative' ->> 'image_hash'), a ->> 'effective_status', v_run.id
  from jsonb_array_elements(v_ads) a
  on conflict (account_id, external_id) do update
  set name = excluded.name, ad_set_id = coalesce(excluded.ad_set_id, meta.ads.ad_set_id), adset_external_id = excluded.adset_external_id,
    parsed_codes = excluded.parsed_codes, media_id = coalesce(excluded.media_id, meta.ads.media_id),
    effective_status = excluded.effective_status, last_seen_at = now(), last_seen_run_id = excluded.last_seen_run_id;

  perform app.record_insights(v_run, p_payload -> 'insights');
  perform app.match_ads(v_account.id, v_run.id, v_correlation_id);

  -- Publishing makes this generation's revisions current, all at once (T-07 step 4).
  update measure.observation_revisions set published_at = now() where run_id = v_run.id;
  update ingest.sync_runs set state = 'published', published_at = now(),
    counts = jsonb_build_object('quarantined', (select count(*) from ingest.quarantine_rows where run_id = v_run.id))
  where id = v_run.id
  returning * into v_run;
  return jsonb_build_object('generation', v_run.generation, 'run_id', v_run.id, 'quarantined', (v_run.counts ->> 'quarantined')::integer);
end;
$$;

reset role;

-- Each matched single-Variant ad's current daily paid results, with the full scope and the revision they come from
-- (T-08). Mismatched, Untracked and Dynamic ads stay out of Variant results (T-14, D-31). Reach is a daily value and
-- is never summed (D-37); ratios are computed from summed numerators and denominators by the reader.
create view reporting.variant_daily_results with (security_invoker = true) as
select
  l.variant_id, va.code as variant_code, l.id as launch_id, l.version_id, a.external_id as meta_ad_id, a.name as ad_name,
  o.period_start as day, s.channel_scope, s.time_zone, s.currency, s.attribution_setting, s.result_indicator, s.definition_version,
  r.id as revision_id, r.generation,
  max(mv.value) filter (where mv.metric_key = 'spend') as spend,
  max(mv.value) filter (where mv.metric_key = 'impressions') as impressions,
  max(mv.value) filter (where mv.metric_key = 'reach') as reach,
  max(mv.value) filter (where mv.metric_key = 'link_clicks') as link_clicks,
  max(mv.value) filter (where mv.metric_key = 'results') as results,
  coalesce(jsonb_object_agg(mv.metric_key, mv.availability_reason) filter (where mv.availability_reason is not null), '{}'::jsonb) as unavailable
from measure.observations o
join measure.report_scopes s on s.id = o.scope_id
join measure.reporting_entities e on e.id = o.entity_id
join meta.ads a on a.id = e.meta_ad_id
join launch.launches l on l.id = a.launch_id
join creative.variants va on va.id = l.variant_id
join lateral (
  select rr.id, rr.generation from measure.observation_revisions rr
  where rr.observation_id = o.id and rr.published_at is not null
  order by rr.generation desc limit 1
) r on true
join measure.metric_values mv on mv.revision_id = r.id
where a.match_state = 'matched' and s.period_kind = 'daily' and s.breakdown_schema = 'none' and o.breakdown_key = ''
  and o.source_action_type = '' and o.period_start = o.period_end
group by l.variant_id, va.code, l.id, l.version_id, a.external_id, a.name, o.period_start, s.channel_scope, s.time_zone, s.currency,
  s.attribution_setting, s.result_indicator, s.definition_version, r.id, r.generation;

-- The values of any revision, current or not, so frozen Evidence can show exactly what it cited (D-42, T-08).
create view reporting.revision_values with (security_invoker = true) as
select mv.revision_id, r.observation_id, r.generation, r.source, mv.metric_key, mv.definition_version, mv.value, mv.availability_reason
from measure.metric_values mv
join measure.observation_revisions r on r.id = mv.revision_id
where r.published_at is not null;

grant select on reporting.variant_daily_results, reporting.revision_values to authenticated;
