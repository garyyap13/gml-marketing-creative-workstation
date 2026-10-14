-- The team time zone (deferred polish, D-78). "Today" for due dates, Verdict check dates and Footage's usable-until
-- warning is the team's today in its time zone, Asia/Kuala_Lumpur unless the Admin changes it in Settings, rather than
-- the database server's UTC date. Results entered for an account keep that account's own time zone (A5c).

alter table core.settings alter column time_zone set default 'Asia/Kuala_Lumpur';
update core.settings set time_zone = 'Asia/Kuala_Lumpur' where id and time_zone = 'UTC';

set role api_owner;

create function app.team_today() returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone s.time_zone)::date from core.settings s;
$$;

-- The Admin sets the team time zone.
create function api.update_team_settings(p_time_zone text, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_settings core.settings;
  v_from text;
begin
  if not v_caller.is_admin then
    perform app.fail('forbidden');
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('time_zone', 'A time zone such as Asia/Kuala_Lumpur')));
  end if;
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;
  select * into v_settings from core.settings for update;
  if v_settings.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_settings.lock_version));
  end if;
  if v_settings.time_zone = p_time_zone then
    return jsonb_build_object('time_zone', v_settings.time_zone, 'lock_version', v_settings.lock_version, 'correlation_id', v_correlation_id);
  end if;
  v_from := v_settings.time_zone;
  update core.settings set time_zone = p_time_zone, lock_version = lock_version + 1 where id returning * into v_settings;
  -- Settings is a single row, so its events use the nil UUID as their entity.
  perform app.record_event(v_caller.id, 'member', 'settings', '00000000-0000-0000-0000-000000000000', v_settings.lock_version, 'team_time_zone_set',
    jsonb_build_object('time_zone', jsonb_build_object('from', v_from, 'to', p_time_zone)), v_correlation_id);
  return jsonb_build_object('time_zone', v_settings.time_zone, 'lock_version', v_settings.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- api.plan_launch, as in 20261013060000_launches.sql, with the team's today in place of the server's.
create or replace function api.plan_launch(p_version_id uuid, p_kind text, p_fields jsonb, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('version_id', p_version_id, 'kind', p_kind, 'fields', p_fields);
  v_replayed jsonb;
  v_account launch.accounts;
  v_errors jsonb;
  v_version creative.versions;
  v_variant creative.variants;
  v_approval text;
  v_launch launch.launches;
  v_expired text[];
  v_warnings jsonb := '[]'::jsonb;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'plan_launch', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  if (p_fields ->> 'account_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_account from launch.accounts where id = (p_fields ->> 'account_id')::uuid;
  end if;
  v_errors := app.launch_field_errors(p_kind, p_fields, v_account);
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  select * into v_version from creative.versions where id = p_version_id;
  if v_version.id is null then
    perform app.fail('not_found');
  end if;
  -- Lock the Variant first, so an approval cannot be withdrawn or superseded while this Launch is planned.
  select * into v_variant from creative.variants where id = v_version.variant_id for update;
  v_approval := app.approval_state(p_version_id);
  if v_approval <> 'in_effect' then
    perform app.fail('conflict', jsonb_build_object('reason', case v_approval
      when 'never_approved' then 'version_not_approved' when 'withdrawn' then 'approval_withdrawn' else 'approval_superseded' end));
  end if;
  -- The approval covers the recorded file; a file changed in Drive needs a new Version first (T-19, D-69).
  if exists (
    select 1 from creative.version_files vf join core.files f on f.id = vf.file_id
    where vf.version_id = p_version_id and f.drift_state is distinct from 'unchanged') then
    perform app.fail('invalid', jsonb_build_object('reason', 'file_changed_in_drive'));
  end if;
  -- Footage past its usage-rights date warns but does not block (D-71).
  v_expired := array(
    select f.code from creative.variant_footage vf join creative.footage f on f.id = vf.footage_id
    where vf.variant_id = v_variant.id and vf.removed_at is null and f.usable_until < app.team_today()
    order by f.code);
  if cardinality(v_expired) > 0 then
    v_warnings := jsonb_build_array(jsonb_build_object('code', 'footage_past_usable_until', 'footage', to_jsonb(v_expired)));
  end if;

  insert into launch.launches
    (kind, variant_id, version_id, status, origin, account_id, planned_on, caption,
     campaign_name, ad_set_name, ad_set_external_id, ad_copy, planned_budget, budget_currency, ad_name, utm_content, created_by)
  values (p_kind, v_variant.id, p_version_id, 'planned', 'planned', v_account.id, (p_fields ->> 'planned_on')::date,
    case when p_kind = 'post' then nullif(trim(p_fields ->> 'caption'), '') end,
    case when p_kind = 'ad' then trim(p_fields ->> 'campaign_name') end,
    case when p_kind = 'ad' then nullif(trim(p_fields ->> 'ad_set_name'), '') end,
    case when p_kind = 'ad' then nullif(trim(p_fields ->> 'ad_set_id'), '') end,
    case when p_kind = 'ad' then nullif(trim(p_fields ->> 'ad_copy'), '') end,
    case when p_kind = 'ad' then (p_fields ->> 'planned_budget')::numeric end,
    case when p_kind = 'ad' and p_fields ->> 'planned_budget' is not null then v_account.currency end,
    case when p_kind = 'ad' then app.ad_name(p_version_id) end,
    case when p_kind = 'ad' then v_variant.code end,
    v_caller.id)
  returning * into v_launch;

  -- A retired Variant is live again once a new Launch is planned (D-54).
  perform app.refresh_liveness(v_variant.id);
  -- Planning is the action the approval notice asked for (D-56).
  perform app.close_tasks('version_approved', v_variant.id);
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'launch_planned',
    jsonb_build_object('variant_id', v_variant.id, 'version_id', p_version_id, 'kind', p_kind), v_correlation_id);

  return app.remember_result(v_caller.id, 'plan_launch', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_launch.id, 'status', v_launch.status, 'ad_name', v_launch.ad_name, 'utm_content', v_launch.utm_content,
    'lock_version', v_launch.lock_version, 'warnings', v_warnings, 'correlation_id', v_correlation_id));
end;
$$;

-- api.link_plan_action, as in 20261014060000_retrospectives.sql, with the team's today in place of the server's.
create or replace function api.link_plan_action(p_plan_id uuid, p_action jsonb, p_expected_lock_version integer, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('plan_id', p_plan_id, 'action', p_action, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_uuid text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_plan learning.optimization_plans;
  v_baseline creative.variants;
  v_creative creative.creatives;
  v_owner core.members;
  v_errors jsonb := '{}'::jsonb;
  v_due date;
  v_check date;
  v_variant creative.variants;
  v_action learning.plan_actions;
  v_event_id uuid;
begin
  v_replayed := app.replayed_result(v_caller.id, 'link_plan_action', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if p_expected_lock_version is null or jsonb_typeof(p_action) is distinct from 'object' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('action', 'Provide the action and the plan''s lock version')));
  end if;
  select * into v_plan from learning.optimization_plans where id = p_plan_id;
  if v_plan.id is null then
    perform app.fail('not_found');
  end if;
  if not app.can_steer_plan(v_caller, v_plan) then
    perform app.fail('forbidden');
  end if;

  if coalesce(p_action ->> 'kind', '') <> 'new_variant' then
    v_errors := v_errors || jsonb_build_object('kind', 'In this version a Finding becomes a new Variant');
  end if;
  if not (coalesce(p_action ->> 'finding_id', '') ~ v_uuid and exists (
      select 1 from learning.retrospective_findings f where f.id = (p_action ->> 'finding_id')::uuid and f.plan_id = p_plan_id
        and not exists (select 1 from learning.retrospective_findings g where g.supersedes_id = f.id))) then
    v_errors := v_errors || jsonb_build_object('finding_id', 'Choose a current Finding of this 复盘');
  end if;
  if jsonb_typeof(p_action -> 'intended_change') is distinct from 'string' or trim(p_action ->> 'intended_change') = '' or length(p_action ->> 'intended_change') > 2000 then
    v_errors := v_errors || jsonb_build_object('intended_change', 'Say what the new Variant changes, in up to 2,000 characters');
  end if;
  if jsonb_typeof(p_action -> 'success_criterion') is distinct from 'string' or trim(p_action ->> 'success_criterion') = '' or length(p_action ->> 'success_criterion') > 1000 then
    v_errors := v_errors || jsonb_build_object('success_criterion', 'Say what result would confirm it, in up to 1,000 characters');
  end if;
  if coalesce(p_action ->> 'owner_id', '') ~ v_uuid then
    select * into v_owner from core.members where id = (p_action ->> 'owner_id')::uuid and active and archived_at is null;
  end if;
  if v_owner.id is null or v_owner.team <> 'creative' then
    v_errors := v_errors || jsonb_build_object('owner_id', 'Choose the Creative Team member who will make it');
  end if;
  if coalesce(pg_input_is_valid(p_action ->> 'due_date', 'date'), false) and (p_action ->> 'due_date') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_due := (p_action ->> 'due_date')::date;
  end if;
  if coalesce(pg_input_is_valid(p_action ->> 'check_date', 'date'), false) and (p_action ->> 'check_date') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_check := (p_action ->> 'check_date')::date;
  end if;
  if v_due is null or v_due < app.team_today() then
    v_errors := v_errors || jsonb_build_object('due_date', 'A due date from today on');
  end if;
  -- The first action sets the check date and minimum spend; later actions keep them, so counted spend never changes
  -- meaning midway (D-74).
  if v_plan.check_date is not null and v_check is not null and v_check <> v_plan.check_date then
    v_errors := v_errors || jsonb_build_object('check_date', format('The first action set the check date to %s', v_plan.check_date));
  end if;
  v_check := coalesce(v_check, v_plan.check_date);
  if v_check is null or (v_due is not null and v_check < v_due) then
    v_errors := v_errors || jsonb_build_object('check_date', 'A check date on or after the due date');
  end if;
  if p_action ? 'minimum_spend_currency' and coalesce(p_action ->> 'minimum_spend_currency', '') !~ '^[A-Z]{3}$' then
    v_errors := v_errors || jsonb_build_object('minimum_spend_currency', 'A three-letter currency code in capitals, like MYR');
  elsif v_plan.minimum_spend is not null and ((p_action ? 'minimum_spend' and (p_action ->> 'minimum_spend') is distinct from v_plan.minimum_spend::text
      and not (jsonb_typeof(p_action -> 'minimum_spend') = 'number' and (p_action ->> 'minimum_spend')::numeric = v_plan.minimum_spend))
      or (p_action ? 'minimum_spend_currency' and p_action ->> 'minimum_spend_currency' <> v_plan.minimum_spend_currency)) then
    v_errors := v_errors || jsonb_build_object('minimum_spend', format('The first action set the minimum to %s %s', v_plan.minimum_spend_currency, v_plan.minimum_spend));
  elsif v_plan.minimum_spend is null and p_action -> 'minimum_spend' is null then
    v_errors := v_errors || jsonb_build_object('minimum_spend', 'Set the minimum test spend');
  elsif p_action -> 'minimum_spend' is not null and (jsonb_typeof(p_action -> 'minimum_spend') <> 'number'
      or (p_action ->> 'minimum_spend')::numeric <= 0 or (p_action ->> 'minimum_spend')::numeric >= 1e12
      or (p_action ->> 'minimum_spend')::numeric <> round((p_action ->> 'minimum_spend')::numeric, 2)) then
    v_errors := v_errors || jsonb_build_object('minimum_spend', 'A positive amount, to the cent');
  elsif v_plan.minimum_spend is null and coalesce(p_action ->> 'minimum_spend_currency', '') !~ '^[A-Z]{3}$' then
    v_errors := v_errors || jsonb_build_object('minimum_spend_currency', 'A three-letter currency code in capitals, like MYR');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  -- Lock order: the baseline's Creative (for the next Variant letter), then the plan.
  select * into v_baseline from creative.variants where id = v_plan.baseline_variant_id;
  select * into v_creative from creative.creatives where id = v_baseline.creative_id for update;
  select * into v_plan from learning.optimization_plans where id = p_plan_id for update;
  if v_plan.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_plan.lock_version));
  end if;
  if v_plan.state = 'proposed' then
    perform app.fail('conflict', jsonb_build_object('reason', 'plan_not_accepted'));
  elsif v_plan.state in ('completed', 'cancelled') or v_plan.verdict is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'plan_closed'));
  end if;
  if v_creative.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'creative_archived'));
  end if;

  -- The follow-up Variant starts with the baseline's labels; the Creative Team can change them before go-live (D-74).
  update creative.creatives set last_variant_number = last_variant_number + 1
  where id = v_creative.id
  returning * into v_creative;
  insert into creative.variants (creative_id, letter, code, hook_type_id, length_id, aspect_ratio_id, production_stage, derived_from_variant_id)
  values (v_creative.id, app.variant_letter(v_creative.last_variant_number), v_creative.code || '-' || app.variant_letter(v_creative.last_variant_number),
    v_baseline.hook_type_id, v_baseline.length_id, v_baseline.aspect_ratio_id,
    (app.production_stages(app.format_media_kind(v_creative.id)))[1], v_baseline.id)
  returning * into v_variant;
  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'variant_created',
    jsonb_build_object('code', v_variant.code, 'creative_id', v_creative.id, 'plan_id', p_plan_id), v_correlation_id);

  insert into learning.plan_actions (plan_id, kind, finding_id, variant_id, owner_id, due_date, intended_change, success_criterion,
    baseline_evidence_id, created_by)
  values (p_plan_id, 'new_variant', (p_action ->> 'finding_id')::uuid, v_variant.id, v_owner.id, v_due, trim(p_action ->> 'intended_change'),
    trim(p_action ->> 'success_criterion'), (select id from learning.plan_evidence where plan_id = p_plan_id and role = 'baseline'), v_caller.id)
  returning * into v_action;
  update learning.optimization_plans
  set state = 'in_progress', check_date = v_check,
    minimum_spend = coalesce((p_action ->> 'minimum_spend')::numeric, minimum_spend),
    minimum_spend_currency = coalesce(p_action ->> 'minimum_spend_currency', minimum_spend_currency),
    lock_version = lock_version + 1
  where id = p_plan_id
  returning * into v_plan;

  v_event_id := app.record_event(v_caller.id, 'member', 'optimization_plan', v_plan.id, v_plan.lock_version, 'plan_action_linked',
    jsonb_build_object('action_id', v_action.id, 'variant_id', v_variant.id, 'code', v_variant.code), v_correlation_id);
  perform app.notify(v_event_id, 'plan_action_assigned', format('Make %s from 复盘: %s', v_variant.code, v_action.intended_change),
    'variant', v_variant.id, array[v_owner.id], jsonb_build_object('code', v_variant.code, 'plan_id', p_plan_id));

  return app.remember_result(v_caller.id, 'link_plan_action', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_action.id, 'variant_id', v_variant.id, 'code', v_variant.code, 'lock_version', v_plan.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- api.record_verdict, as in 20261014060000_retrospectives.sql, with the team's today in place of the server's.
create or replace function api.record_verdict(p_plan_id uuid, p_verdict text, p_note text, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('plan_id', p_plan_id, 'verdict', p_verdict, 'note', p_note, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_plan learning.optimization_plans;
begin
  if not v_caller.is_approver then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'record_verdict', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if p_verdict is null or p_verdict not in ('confirmed', 'not_confirmed', 'not_enough_data') or length(p_note) > 2000 or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'verdict', case when p_verdict is null or p_verdict not in ('confirmed', 'not_confirmed', 'not_enough_data') then 'Confirmed, not confirmed or not enough data' end,
      'note', case when length(p_note) > 2000 then 'Up to 2,000 characters' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;

  select * into v_plan from learning.optimization_plans where id = p_plan_id for update;
  if v_plan.id is null then
    perform app.fail('not_found');
  end if;
  if v_plan.verdict is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'verdict_recorded'));
  end if;
  if v_plan.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_plan.lock_version));
  end if;
  if v_plan.state not in ('accepted', 'in_progress') then
    perform app.fail('conflict', jsonb_build_object('reason', case when v_plan.state = 'proposed' then 'plan_not_accepted' else 'plan_closed' end));
  end if;
  if v_plan.check_date is null then
    perform app.fail('conflict', jsonb_build_object('reason', 'no_check_date'));
  end if;
  if app.team_today() < v_plan.check_date then
    perform app.fail('conflict', jsonb_build_object('reason', 'before_check_date'));
  end if;
  if p_verdict <> 'not_enough_data' and app.counted_spend(p_plan_id) < v_plan.minimum_spend then
    perform app.fail('invalid', jsonb_build_object('reason', 'below_minimum_spend', 'fieldErrors', jsonb_build_object('verdict',
      format('Spend is below the minimum of %s %s, so the Verdict is not enough data', v_plan.minimum_spend_currency, v_plan.minimum_spend))));
  end if;

  update learning.optimization_plans
  set verdict = p_verdict, verdict_by = v_caller.id, verdict_at = now(), verdict_note = nullif(trim(p_note), ''), lock_version = lock_version + 1
  where id = p_plan_id
  returning * into v_plan;
  perform app.close_tasks('verdict_due', p_plan_id);
  perform app.record_event(v_caller.id, 'member', 'optimization_plan', v_plan.id, v_plan.lock_version, 'verdict_recorded',
    jsonb_build_object('verdict', p_verdict), v_correlation_id);
  return app.remember_result(v_caller.id, 'record_verdict', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_plan.id, 'verdict', v_plan.verdict, 'lock_version', v_plan.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- worker.run_due_checks, as in 20261014060000_retrospectives.sql, except that the day defaults to the team's today, so
-- the hosted schedule (B1) needn't work it out.
create or replace function worker.run_due_checks(p_today date default null) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := set_config('app.correlation_id', gen_random_uuid()::text, true)::uuid;
  v_plan learning.optimization_plans;
  v_spend numeric;
  v_event_id uuid;
  v_automatic integer := 0;
  v_asked integer := 0;
begin
  p_today := coalesce(p_today, app.team_today());
  for v_plan in
    select * from learning.optimization_plans
    where state in ('accepted', 'in_progress') and verdict is null and check_date <= p_today
    order by id
    for update skip locked
  loop
    v_spend := app.counted_spend(v_plan.id);
    -- With a day's spend unreported the total is unknown, so people decide rather than the check (D-37).
    if v_plan.minimum_spend is not null and v_spend is not null and v_spend < v_plan.minimum_spend then
      update learning.optimization_plans
      set verdict = 'not_enough_data', verdict_by_system = true, verdict_at = now(), lock_version = lock_version + 1,
        verdict_note = format('Counted spend %s %s is below the minimum of %s %s.', v_plan.minimum_spend_currency, v_spend,
          v_plan.minimum_spend_currency, v_plan.minimum_spend)
      where id = v_plan.id
      returning * into v_plan;
      perform app.close_tasks('verdict_due', v_plan.id);
      perform app.record_event(null, 'system', 'optimization_plan', v_plan.id, v_plan.lock_version, 'verdict_recorded',
        jsonb_build_object('verdict', 'not_enough_data', 'counted_spend', v_spend), v_correlation_id);
      v_automatic := v_automatic + 1;
    elsif not exists (select 1 from work.tasks where kind = 'verdict_due' and entity_id = v_plan.id) then
      v_event_id := app.record_event(null, 'system', 'optimization_plan', v_plan.id, v_plan.lock_version, 'verdict_due',
        jsonb_build_object('check_date', v_plan.check_date, 'counted_spend', v_spend), v_correlation_id);
      perform app.notify(v_event_id, 'verdict_due',
        format('Record the Verdict for the 复盘 of %s', (select code from creative.variants where id = v_plan.baseline_variant_id)),
        'plan', v_plan.id,
        array(select distinct m from unnest(array[v_plan.owner_id] || array(
          select id from core.members where is_approver and active and archived_at is null)) m),
        jsonb_build_object('plan_id', v_plan.id));
      v_asked := v_asked + 1;
    end if;
  end loop;
  return jsonb_build_object('automatic_verdicts', v_automatic, 'verdicts_requested', v_asked);
end;
$$;

reset role;

grant execute on function api.update_team_settings(text, integer) to authenticated;
