-- Results entered by hand (D-36, D-61 PD-22, D-76; TRD §8.3). The Marketing Team adds its TikTok, Xiaohongshu and
-- YouTube accounts, plans and confirms Post Launches on them as usual, and enters each live Post's results for a date
-- range. An entry is that period's total, a scope of its own (period kind 'range'), never split into days or added to
-- daily results. Every entry is a revision with its provenance: who entered it and when, or which CSV file it came
-- from. Correcting a period adds a revision; nothing is deleted.

alter table measure.report_scopes
  drop constraint report_scopes_period_kind_check,
  add constraint report_scopes_period_kind_check check (period_kind in ('daily', 'rolling', 'lifetime', 'range'));

alter table measure.reporting_entities
  add column launch_id uuid references launch.launches (id),
  add constraint reporting_entities_manual_launch check (entity_type <> 'manual' or launch_id is not null);
create unique index reporting_entities_one_per_launch on measure.reporting_entities (launch_id) where launch_id is not null;

alter table ingest.sync_runs
  drop constraint sync_runs_kind_check,
  add constraint sync_runs_kind_check check (kind in ('six_hourly', 'daily_repull', 'backfill', 'manual', 'stand_in', 'manual_entry', 'csv_import')),
  add column entered_by uuid references core.members (id),
  add column file_id uuid references core.files (id);
grant select (entered_by, file_id) on ingest.sync_runs to authenticated;

insert into measure.metric_definitions (key, version, unit, aggregation, source_field) values
  ('views', 1, 'count', 'sum', 'views'),
  ('likes', 1, 'count', 'sum', 'likes'),
  ('comments', 1, 'count', 'sum', 'comments'),
  ('shares', 1, 'count', 'sum', 'shares'),
  ('saves', 1, 'count', 'sum', 'saves');

set role api_owner;

-- Makes one observation the current copy of its entity and period: other copies in the same kind of scope (another
-- result type, attribution, currency or time zone) are superseded. Called when a revision is published (A5b's
-- trigger) and when an entry is made again unchanged, so switching a result type back never leaves two copies current.
create function app.make_current(p_observation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obs measure.observations;
  v_scope measure.report_scopes;
begin
  select * into v_obs from measure.observations where id = p_observation_id;
  select * into v_scope from measure.report_scopes where id = v_obs.scope_id;
  update measure.observations set superseded_at = null where id = v_obs.id and superseded_at is not null;
  update measure.observations o set superseded_at = now()
  from measure.report_scopes s
  where s.id = o.scope_id and o.id <> v_obs.id and o.superseded_at is null
    and o.entity_id = v_obs.entity_id and o.period_start = v_obs.period_start and o.period_end = v_obs.period_end
    and o.breakdown_key = v_obs.breakdown_key and o.source_action_type = v_obs.source_action_type
    and s.account_id = v_scope.account_id and s.entity_level = v_scope.entity_level and s.channel_scope = v_scope.channel_scope
    and s.period_kind = v_scope.period_kind and s.breakdown_schema = v_scope.breakdown_schema and s.definition_version = v_scope.definition_version;
end;
$$;

create or replace function app.supersede_other_scopes() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.make_current(new.observation_id);
  return null;
end;
$$;

-- The result types a person can enter for another platform (D-76), named in the reader's words by the web client.
create function app.manual_result_types() returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['leads', 'messages', 'purchases', 'profile_visits', 'link_clicks', 'none'];
$$;

-- Field errors for one period's figures: spend, views or impressions, clicks, Results with their type, and optional
-- reach, likes, comments, shares and saves (D-76). Every figure is a plain non-negative number: counts are whole and
-- spend has at most two decimals. Spend applies only to paid entries, or to both.
create function app.manual_values_errors(p_values jsonb, p_has_currency boolean, p_channel text) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_errors jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_figures integer := 0;
begin
  if jsonb_typeof(p_values) is distinct from 'object' then
    return jsonb_build_object('values', 'Enter at least one figure');
  end if;
  for v_key, v_value in select * from jsonb_each(p_values) loop
    if v_key not in ('spend', 'views', 'clicks', 'results', 'result_type', 'reach', 'likes', 'comments', 'shares', 'saves') then
      v_errors := v_errors || jsonb_build_object(v_key, 'Not a figure the workstation records');
    elsif v_key = 'result_type' then
      if jsonb_typeof(v_value) <> 'null' and (jsonb_typeof(v_value) <> 'string' or not (v_value #>> '{}') = any (app.manual_result_types())) then
        v_errors := v_errors || jsonb_build_object(v_key, 'Leads, messages, purchases, profile visits, link clicks or none');
      end if;
    elsif jsonb_typeof(v_value) = 'null' then
      continue;
    elsif jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}')::numeric < 0
        or (v_key <> 'spend' and (v_value #>> '{}')::numeric <> trunc((v_value #>> '{}')::numeric))
        or (v_key = 'spend' and scale(trim_scale((v_value #>> '{}')::numeric)) > 2)
        or (v_value #>> '{}')::numeric > 1e12 then
      v_errors := v_errors || jsonb_build_object(v_key, case when v_key = 'spend' then 'An amount of 0 or more' else 'A whole number, 0 or more' end);
    else
      v_figures := v_figures + 1;
    end if;
  end loop;
  if jsonb_typeof(p_values -> 'results') = 'number' and coalesce(p_values ->> 'result_type', 'none') = 'none' then
    v_errors := v_errors || jsonb_build_object('result_type', 'Say what the Results are');
  end if;
  if jsonb_typeof(p_values -> 'spend') = 'number' and not p_has_currency then
    v_errors := v_errors || jsonb_build_object('spend', 'This account has no currency, so spend can''t be recorded');
  elsif jsonb_typeof(p_values -> 'spend') = 'number' and p_channel = 'organic_only' and not v_errors ? 'spend' then
    v_errors := v_errors || jsonb_build_object('spend', 'Spend applies only to paid results, or to both');
  end if;
  if v_figures = 0 and v_errors = '{}'::jsonb then
    v_errors := jsonb_build_object('values', 'Enter at least one figure');
  end if;
  return v_errors;
end;
$$;

-- Records one Launch's figures for one period as a published revision of that period's observation, in the given
-- run. Figures the same as the current revision's add nothing. Shared by manual entry and CSV import.
create function app.record_period_results(p_run ingest.sync_runs, p_launch launch.launches, p_account launch.accounts, p_from date, p_to date,
  p_channel text, p_values jsonb, p_source text) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_indicator text := coalesce(nullif(p_values ->> 'result_type', ''), 'none');
  v_scope uuid;
  v_entity uuid;
  v_observation uuid;
  v_values jsonb;
  v_checksum text;
  v_current measure.observation_revisions;
  v_revision uuid;
  v_key text;
begin
  insert into measure.report_scopes (account_id, entity_level, channel_scope, period_kind, time_zone, currency, attribution_setting,
    result_indicator, breakdown_schema, definition_version)
  values (p_account.id, case when p_launch.kind = 'post' then 'post' else 'ad' end, p_channel, 'range', coalesce(p_account.time_zone, 'UTC'),
    coalesce(p_account.currency, 'none'), 'not_applicable', v_indicator, 'none', 1)
  on conflict (account_id, entity_level, channel_scope, period_kind, time_zone, currency, attribution_setting, result_indicator,
    breakdown_schema, definition_version) do nothing;
  select id into v_scope from measure.report_scopes
  where account_id = p_account.id and entity_level = case when p_launch.kind = 'post' then 'post' else 'ad' end and channel_scope = p_channel
    and period_kind = 'range' and time_zone = coalesce(p_account.time_zone, 'UTC') and currency = coalesce(p_account.currency, 'none')
    and attribution_setting = 'not_applicable' and result_indicator = v_indicator and breakdown_schema = 'none' and definition_version = 1;

  insert into measure.reporting_entities (entity_type, launch_id) values ('manual', p_launch.id) on conflict (launch_id) where launch_id is not null do nothing;
  select id into v_entity from measure.reporting_entities where launch_id = p_launch.id;

  insert into measure.observations (entity_id, scope_id, period_start, period_end)
  values (v_entity, v_scope, p_from, p_to)
  on conflict (entity_id, scope_id, period_start, period_end, breakdown_key, source_action_type) do nothing;
  select id into v_observation from measure.observations
  where entity_id = v_entity and scope_id = v_scope and period_start = p_from and period_end = p_to and breakdown_key = '' and source_action_type = '';

  -- The figures as stored: clicks are link clicks; the core figures are always present, null when not entered.
  -- Numbers are stored without trailing zeros, so 150 and 150.00 are the same figure.
  select coalesce(jsonb_object_agg(k, to_jsonb(trim_scale((p_values ->> f)::numeric))), '{}'::jsonb) into v_values
  from (values ('spend', 'spend'), ('views', 'views'), ('link_clicks', 'clicks'), ('results', 'results'), ('reach', 'reach'), ('likes', 'likes'),
    ('comments', 'comments'), ('shares', 'shares'), ('saves', 'saves')) as m (k, f)
  where jsonb_typeof(p_values -> f) = 'number';
  v_checksum := md5(v_values::text);
  select * into v_current from measure.observation_revisions
  where observation_id = v_observation and published_at is not null order by generation desc limit 1;
  if v_current.checksum is not distinct from v_checksum then
    -- Nothing changed, but the copy entered again becomes the current one if another result type had replaced it.
    perform app.make_current(v_observation);
    return v_current.id;
  end if;

  insert into measure.observation_revisions (observation_id, run_id, generation, source, checksum, published_at)
  values (v_observation, p_run.id, p_run.generation, p_source, v_checksum, now())
  returning id into v_revision;
  foreach v_key in array array['spend', 'views', 'link_clicks', 'results'] loop
    insert into measure.metric_values (revision_id, metric_key, definition_version, value, availability_reason)
    values (v_revision, v_key, 1, (v_values ->> v_key)::numeric, case when v_values ? v_key then null
      when v_key = 'spend' and p_channel = 'organic_only' then 'not_applicable' else 'not_returned' end);
  end loop;
  insert into measure.metric_values (revision_id, metric_key, definition_version, value)
  select v_revision, key, 1, value::text::numeric from jsonb_each(v_values) where key in ('reach', 'likes', 'comments', 'shares', 'saves');
  return v_revision;
end;
$$;

-- Marketing adds a TikTok, Xiaohongshu or YouTube account whose results it enters by hand (D-61 PD-22).
create function api.add_platform_account(p_platform text, p_handle text, p_name text, p_currency text, p_time_zone text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('platform', p_platform, 'handle', p_handle, 'name', p_name, 'currency', p_currency, 'time_zone', p_time_zone);
  v_replayed jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_account launch.accounts;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'add_platform_account', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if coalesce(p_platform, '') not in ('tiktok', 'xiaohongshu', 'youtube') then
    v_errors := v_errors || jsonb_build_object('platform', 'TikTok, Xiaohongshu or YouTube; Meta accounts come from the Meta connection');
  end if;
  if coalesce(trim(p_handle), '') = '' or length(trim(p_handle)) > 100 or app.has_hidden_characters(p_handle) then
    v_errors := v_errors || jsonb_build_object('handle', 'The account''s handle or ID, in up to 100 characters');
  elsif exists (select 1 from launch.accounts where platform = p_platform and lower(external_id) = lower(trim(p_handle))) then
    v_errors := v_errors || jsonb_build_object('handle', 'This account is already added');
  end if;
  if coalesce(trim(p_name), '') = '' or length(trim(p_name)) > 120 or app.has_hidden_characters(p_name) then
    v_errors := v_errors || jsonb_build_object('name', 'Name the account, in up to 120 characters');
  end if;
  if coalesce(p_currency, '') !~ '^[A-Z]{3}$' then
    v_errors := v_errors || jsonb_build_object('currency', 'A three-letter currency code, such as MYR');
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    v_errors := v_errors || jsonb_build_object('time_zone', 'A time zone such as Asia/Kuala_Lumpur');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  insert into launch.accounts (platform, external_id, name, time_zone, currency, source)
  values (p_platform, trim(p_handle), trim(p_name), p_time_zone, p_currency, 'manual')
  returning * into v_account;
  perform app.record_event(v_caller.id, 'member', 'account', v_account.id, null, 'platform_account_added',
    jsonb_build_object('platform', p_platform, 'handle', v_account.external_id), v_correlation_id);
  return app.remember_result(v_caller.id, 'add_platform_account', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_account.id, 'correlation_id', v_correlation_id));
end;
$$;

-- Marketing enters a live or ended Launch's results on another platform for one period (D-76). Entering the same
-- period again corrects it.
create function api.enter_manual_results(p_launch_id uuid, p_from date, p_to date, p_channel text, p_values jsonb, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('launch_id', p_launch_id, 'from', p_from, 'to', p_to, 'channel', p_channel, 'values', p_values);
  v_replayed jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_launch launch.launches;
  v_account launch.accounts;
  v_run ingest.sync_runs;
  v_revision uuid;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'enter_manual_results', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if p_launch_id is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('launch_id', 'Choose a live Launch')));
  end if;
  select * into v_launch from launch.launches where id = p_launch_id;
  if v_launch.id is null then
    perform app.fail('not_found');
  end if;
  select * into v_account from launch.accounts where id = v_launch.account_id;
  if coalesce(p_channel, '') not in ('organic_only', 'paid_only', 'combined') then
    v_errors := v_errors || jsonb_build_object('channel', 'Organic, paid, or both');
  end if;
  -- Today is the account's today.
  if p_from is null or p_to is null or p_from > p_to or p_to > (now() at time zone coalesce(v_account.time_zone, 'UTC'))::date or p_to - p_from > 366 then
    v_errors := v_errors || jsonb_build_object('period', 'A period of up to a year that has already ended or ends today');
  end if;
  if v_account.source <> 'manual' then
    v_errors := v_errors || jsonb_build_object('launch_id', 'Results for this account come from its connection, not by hand');
  else
    v_errors := v_errors || app.manual_values_errors(p_values, v_account.currency is not null, p_channel);
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  if v_launch.status not in ('live', 'ended') then
    perform app.fail('conflict', jsonb_build_object('reason', 'launch_not_live'));
  end if;

  -- One run per entry, numbered per account; the account's row keeps two entries from taking the same number.
  perform 1 from launch.accounts where id = v_account.id for update;
  insert into ingest.sync_runs (account_id, generation, kind, state, published_at, entered_by)
  values (v_account.id, coalesce((select max(generation) from ingest.sync_runs where account_id = v_account.id), 0) + 1, 'manual_entry', 'published', now(), v_caller.id)
  returning * into v_run;
  v_revision := app.record_period_results(v_run, v_launch, v_account, p_from, p_to, p_channel, p_values, 'manual');
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'manual_results_entered',
    jsonb_build_object('from', p_from, 'to', p_to, 'channel', p_channel, 'run_id', v_run.id, 'revision_id', v_revision), v_correlation_id);
  return app.remember_result(v_caller.id, 'enter_manual_results', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_revision, 'correlation_id', v_correlation_id));
end;
$$;

-- Marketing withdraws an entry made on the wrong Launch, dates or channel, with a reason. The entry is marked
-- superseded rather than deleted; entering the same period again brings it back.
create function api.withdraw_manual_result(p_observation_id uuid, p_reason text, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('observation_id', p_observation_id, 'reason', p_reason);
  v_replayed jsonb;
  v_obs measure.observations;
  v_launch launch.launches;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'withdraw_manual_result', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if coalesce(trim(p_reason), '') = '' or length(p_reason) > 500 then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('reason', 'Say why it is withdrawn, in up to 500 characters')));
  end if;
  select o.* into v_obs from measure.observations o join measure.reporting_entities e on e.id = o.entity_id
  where o.id = p_observation_id and e.entity_type = 'manual' for update of o;
  if v_obs.id is null then
    perform app.fail('not_found');
  end if;
  if v_obs.superseded_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_withdrawn'));
  end if;
  select l.* into v_launch from launch.launches l join measure.reporting_entities e on e.launch_id = l.id where e.id = v_obs.entity_id;
  update measure.observations set superseded_at = now() where id = p_observation_id;
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'manual_result_withdrawn',
    jsonb_build_object('observation_id', p_observation_id, 'from', v_obs.period_start, 'to', v_obs.period_end), v_correlation_id, trim(p_reason));
  return app.remember_result(v_caller.id, 'withdraw_manual_result', p_idempotency_key, v_request, jsonb_build_object(
    'id', p_observation_id, 'correlation_id', v_correlation_id));
end;
$$;

reset role;

-- Each Launch's current results per period entered by hand or imported, with provenance.
create view reporting.manual_results with (security_invoker = true) as
select l.id as launch_id, l.variant_id, va.code as variant_code, ac.platform, ac.id as account_id, ac.name as account_name,
  o.period_start, o.period_end, s.channel_scope, s.currency, s.result_indicator,
  max(mv.value) filter (where mv.metric_key = 'spend') as spend,
  max(mv.value) filter (where mv.metric_key = 'views') as views,
  max(mv.value) filter (where mv.metric_key = 'link_clicks') as clicks,
  max(mv.value) filter (where mv.metric_key = 'results') as results,
  max(mv.value) filter (where mv.metric_key = 'reach') as reach,
  max(mv.value) filter (where mv.metric_key = 'likes') as likes,
  max(mv.value) filter (where mv.metric_key = 'comments') as comments,
  max(mv.value) filter (where mv.metric_key = 'shares') as shares,
  max(mv.value) filter (where mv.metric_key = 'saves') as saves,
  r.source, run.entered_by, r.created_at as entered_at, run.file_id, r.id as revision_id, o.id as observation_id
from measure.observations o
join measure.report_scopes s on s.id = o.scope_id
join measure.reporting_entities e on e.id = o.entity_id
join launch.launches l on l.id = e.launch_id
join creative.variants va on va.id = l.variant_id
join launch.accounts ac on ac.id = l.account_id
join lateral (
  select rr.id, rr.source, rr.created_at, rr.run_id from measure.observation_revisions rr
  where rr.observation_id = o.id and rr.published_at is not null
  order by rr.generation desc, rr.created_at desc limit 1
) r on true
join ingest.sync_runs run on run.id = r.run_id
join measure.metric_values mv on mv.revision_id = r.id
where e.entity_type = 'manual' and s.period_kind = 'range' and o.superseded_at is null
group by l.id, l.variant_id, va.code, ac.platform, ac.id, ac.name, o.period_start, o.period_end, s.channel_scope, s.currency, s.result_indicator,
  r.source, run.entered_by, r.created_at, run.file_id, r.id, o.id;

grant select on reporting.manual_results to authenticated;
grant execute on function api.add_platform_account(text, text, text, text, text, uuid) to authenticated;
grant execute on function api.enter_manual_results(uuid, date, date, text, jsonb, uuid) to authenticated;
grant execute on function api.withdraw_manual_result(uuid, text, uuid) to authenticated;
