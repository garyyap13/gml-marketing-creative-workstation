-- Breakdown results (D-35, D-58; T-06, T-15). The sync pulls each Breakdown set turned on in Settings alongside the
-- totals; each set is its own breakdown schema and each row's values its breakdown key. Breakdown rows go through the
-- same checks as totals and are kept apart: the totals views read only rows without a breakdown, so the two paths are
-- never added together. Reach stays a per-row figure and is never summed. Until the Meta connection (B3), the stand-in
-- sync takes Breakdown rows as `breakdown_insights`: [{ "breakdown_set": "age_gender", "rows": [...] }].

set role api_owner;

-- app.record_insights, as in 20261013060200_results.sql, for totals or for one Breakdown set.
create function app.record_insights(p_run ingest.sync_runs, p_insights jsonb, p_breakdowns text[], p_locator text) returns void
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
  -- A Breakdown set is its own breakdown schema (D-35, T-06); its rows are never added to the totals.
  v_schema text := case when cardinality(coalesce(p_breakdowns, '{}')) = 0 then 'none' else array_to_string(p_breakdowns, ',') end;
  v_key text;
  v_missing text;
begin
  select * into v_account from launch.accounts where id = p_run.account_id;
  for v_row, v_position in select r, n from jsonb_array_elements(coalesce(p_insights, '[]')) with ordinality as i(r, n) loop
    select * into v_ad from meta.ads where account_id = v_account.id and external_id = v_row ->> 'ad_id';
    -- Each metric: a number from Meta's numeric string, or null with the reason it is missing.
    v_values := jsonb_build_object(
      'spend', v_row -> 'spend', 'impressions', v_row -> 'impressions', 'reach', v_row -> 'reach',
      'link_clicks', v_row -> 'inline_link_clicks', 'results', v_row #> '{results,0,values,0,value}');
    -- A Breakdown row names its value for each field of the set, e.g. {"age": "25-34", "gender": "female"}; the canonical
    -- JSON text is the observation's breakdown key, so the same values always land on the same observation.
    v_key := case when v_schema = 'none' then '' else (
      select jsonb_object_agg(b, v_row ->> b)::text from unnest(p_breakdowns) b) end;
    v_missing := (select string_agg(b, ', ') from unnest(coalesce(p_breakdowns, '{}')) b where coalesce(v_row ->> b, '') = '');
    select string_agg(key, ', ') into v_bad from jsonb_each(v_values)
    where value <> 'null'::jsonb and not (jsonb_typeof(value) = 'string' and value #>> '{}' ~ '^[0-9]+(\.[0-9]+)?$');
    if v_ad.id is null or v_bad is not null or v_missing is not null
      or not coalesce(pg_input_is_valid(v_row ->> 'date_start', 'date') and pg_input_is_valid(v_row ->> 'date_stop', 'date'), false)
      or (v_row ->> 'date_start') !~ '^\d{4}-\d{2}-\d{2}$' or (v_row ->> 'date_stop') !~ '^\d{4}-\d{2}-\d{2}$'
      or (v_row ->> 'date_stop') < (v_row ->> 'date_start') then
      insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
      values (p_run.id, format('%s[%s]', p_locator, v_position - 1), v_row,
        case when v_ad.id is null then 'Unknown ad' when v_bad is not null then format('Not a number: %s', v_bad)
          when v_missing is not null then format('Missing breakdown value: %s', v_missing) else 'Not a valid period' end);
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
      v_indicator, v_schema, 1)
    on conflict (account_id, entity_level, channel_scope, period_kind, time_zone, currency, attribution_setting, result_indicator,
      breakdown_schema, definition_version) do nothing;
    select id into v_scope_id from measure.report_scopes
    where account_id = v_account.id and entity_level = 'ad' and channel_scope = 'paid_only' and period_kind = 'daily'
      and time_zone = coalesce(v_account.time_zone, 'unknown') and currency = coalesce(v_account.currency, 'unknown')
      and attribution_setting = coalesce(v_row ->> 'attribution_setting', v_ad_set.attribution_setting, 'not_applicable')
      and result_indicator = v_indicator and breakdown_schema = v_schema and definition_version = 1;

    insert into measure.observations (entity_id, scope_id, period_start, period_end, breakdown_key)
    values (v_entity_id, v_scope_id, (v_row ->> 'date_start')::date, (v_row ->> 'date_stop')::date, v_key)
    on conflict (entity_id, scope_id, period_start, period_end, breakdown_key, source_action_type) do nothing;
    select id into v_observation_id from measure.observations
    where entity_id = v_entity_id and scope_id = v_scope_id and period_start = (v_row ->> 'date_start')::date
      and period_end = (v_row ->> 'date_stop')::date and breakdown_key = v_key and source_action_type = '';

    -- The same ad and day twice in one generation cannot both be right.
    if exists (select 1 from measure.observation_revisions where observation_id = v_observation_id and run_id = p_run.id) then
      insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
      values (p_run.id, format('%s[%s]', p_locator, v_position - 1), v_row,
        'Duplicate row for this ad and period' || case when v_key <> '' then ' (' || v_key || ')' else '' end);
      continue;
    end if;
    v_checksum := md5(v_values::text);
    if v_checksum is not distinct from (
      select checksum from measure.observation_revisions
      where observation_id = v_observation_id and published_at is not null order by generation desc limit 1) then
      if v_observation_id = any (v_seen) then
        insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
        values (p_run.id, format('%s[%s]', p_locator, v_position - 1), v_row,
        'Duplicate row for this ad and period' || case when v_key <> '' then ' (' || v_key || ')' else '' end);
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

-- The totals, as before.
create or replace function app.record_insights(p_run ingest.sync_runs, p_insights jsonb) returns void
language sql
security definer
set search_path = ''
as $$
  select app.record_insights(p_run, p_insights, '{}'::text[], 'insights');
$$;

-- worker.record_meta_sync, as in 20261015060500_posts_legacy_dynamic.sql, plus Breakdown rows.
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
  v_kind text := coalesce(p_payload ->> 'kind', 'stand_in');
  v_raw uuid;
  v_prefix text := (select brand_prefix from core.settings);
  v_set jsonb;
  v_set_position bigint;
  v_breakdowns text[];
begin
  select * into v_account from launch.accounts where platform = 'meta_ad_account' and external_id = p_ad_account_id;
  if v_account.id is null then
    raise exception 'unknown ad account %', p_ad_account_id;
  end if;
  if v_kind not in ('stand_in', 'six_hourly', 'daily_repull', 'backfill', 'manual') then
    raise exception 'unknown sync kind %', v_kind;
  end if;
  insert into ingest.sync_runs (account_id, generation, kind, state, connection_id)
  values (v_account.id, coalesce((select max(generation) from ingest.sync_runs where account_id = v_account.id), 0) + 1, v_kind, 'running', v_account.connection_id)
  returning * into v_run;
  -- The response is kept, credentials removed, so every recorded row can be traced to it (D-33).
  v_raw := app.record_raw_response(v_run.id, jsonb_build_object('source', 'stand_in'), null, p_payload);

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

  -- Besides bracketed Variant codes, the name may carry a Legacy Code such as GML-TESTI-0007, bracketed or not (D-12;
  -- the pattern is proposed, PD-30), and the creative may promote a Page post or Instagram post (D-30).
  insert into meta.ads (account_id, ad_set_id, adset_external_id, external_id, name, parsed_codes, media_id, effective_status, last_seen_run_id,
    legacy_codes, promoted_post_external_id, promoted_instagram_media_id)
  select v_account.id, (select id from meta.ad_sets where account_id = v_account.id and external_id = a ->> 'adset_id'), a ->> 'adset_id',
    a ->> 'id', a ->> 'name',
    -- The codes in the order the name gives them, each once, so a Dynamic Launch lists its Variants in that order.
    array(select x.code from (select r.m[1] as code, min(r.n) as n from regexp_matches(a ->> 'name', '\[([A-Z][A-Z0-9]*-[0-9]+(?:-[A-Z]+)?)\]', 'g')
      with ordinality as r(m, n) group by r.m[1]) x order by x.n),
    coalesce(a -> 'creative' ->> 'video_id', a -> 'creative' ->> 'image_hash'), a ->> 'effective_status', v_run.id,
    array(select distinct upper(m[1]) from regexp_matches(a ->> 'name', '(?<![A-Za-z0-9-])(' || v_prefix || '-[A-Za-z]{2,12}-[0-9]{1,6})(?![A-Za-z0-9-])', 'gi') as m),
    a -> 'creative' ->> 'effective_object_story_id', a -> 'creative' ->> 'effective_instagram_media_id'
  from jsonb_array_elements(v_ads) a
  on conflict (account_id, external_id) do update
  set name = excluded.name, ad_set_id = coalesce(excluded.ad_set_id, meta.ads.ad_set_id), adset_external_id = excluded.adset_external_id,
    parsed_codes = excluded.parsed_codes, media_id = coalesce(excluded.media_id, meta.ads.media_id),
    effective_status = excluded.effective_status, last_seen_at = now(), last_seen_run_id = excluded.last_seen_run_id,
    legacy_codes = excluded.legacy_codes, promoted_post_external_id = coalesce(excluded.promoted_post_external_id, meta.ads.promoted_post_external_id),
    promoted_instagram_media_id = coalesce(excluded.promoted_instagram_media_id, meta.ads.promoted_instagram_media_id);

  perform app.record_insights(v_run, p_payload -> 'insights');
  -- Breakdown rows, one list per Breakdown set the sync pulled (D-35, D-58). A set that isn't turned on in Settings is
  -- set aside whole, never guessed at.
  for v_set, v_set_position in select s, n from jsonb_array_elements(coalesce(p_payload -> 'breakdown_insights', '[]')) with ordinality as b(s, n) loop
    v_breakdowns := (select breakdowns from core.breakdown_settings where breakdown_set = v_set ->> 'breakdown_set' and enabled);
    if v_breakdowns is null then
      insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
      values (v_run.id, format('breakdown_insights[%s]', v_set_position - 1), jsonb_build_object('breakdown_set', v_set -> 'breakdown_set'),
        'Breakdown not turned on in Settings');
      continue;
    end if;
    perform app.record_insights(v_run, v_set -> 'rows', v_breakdowns, format('breakdown_insights[%s].rows', v_set_position - 1));
  end loop;
  perform app.match_ads(v_account.id, v_run.id, v_correlation_id);

  update ingest.quarantine_rows set raw_response_id = v_raw where run_id = v_run.id and raw_response_id is null;
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

-- Each synced ad's current daily Breakdown rows, whatever its match state, with the set, the values and the full scope
-- (T-15). Pool them only within one scope and one Breakdown set; Reach is per row and never added up.
create view reporting.breakdowns with (security_invoker = true) as
select a.external_id as meta_ad_id, a.name as ad_name, a.match_state,
  -- Only a matched ad counts for its Variant; a Mismatched or kept-out ad keeps out of Variant results (T-14).
  case when a.match_state = 'matched' then a.variant_id end as variant_id, case when a.match_state = 'matched' then va.code end as variant_code,
  a.launch_id,
  o.period_start as day, s.breakdown_schema as breakdown_set_fields, o.breakdown_key::jsonb as breakdown_values,
  s.channel_scope, s.time_zone, s.currency, s.attribution_setting, s.result_indicator, s.definition_version,
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
left join creative.variants va on va.id = a.variant_id
join lateral (
  select rr.id, rr.generation from measure.observation_revisions rr
  where rr.observation_id = o.id and rr.published_at is not null
  order by rr.generation desc, rr.created_at desc limit 1
) r on true
join measure.metric_values mv on mv.revision_id = r.id
where s.period_kind = 'daily' and s.breakdown_schema <> 'none' and o.breakdown_key <> '' and o.source_action_type = ''
  and o.period_start = o.period_end and o.superseded_at is null
group by a.external_id, a.name, a.match_state, a.variant_id, va.code, a.launch_id, o.period_start, s.breakdown_schema, o.breakdown_key,
  s.channel_scope, s.time_zone, s.currency, s.attribution_setting, s.result_indicator, s.definition_version, r.id, r.generation;
grant select on reporting.breakdowns to authenticated;
