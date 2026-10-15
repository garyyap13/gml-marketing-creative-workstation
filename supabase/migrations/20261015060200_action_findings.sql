-- Several Findings may motivate one follow-up action (TRD §4.7 learning.action_findings). Until now each action named
-- one Finding in plan_actions.finding_id; those links move here and the column goes, so there is one source.

-- Both sides carry their plan, so a link can only join an action and a Finding of the same 复盘.
alter table learning.plan_actions add constraint plan_actions_id_plan unique (id, plan_id);
alter table learning.retrospective_findings add constraint retrospective_findings_id_plan unique (id, plan_id);

create table learning.action_findings (
  action_id uuid not null,
  finding_id uuid not null,
  plan_id uuid not null,
  primary key (action_id, finding_id),
  foreign key (action_id, plan_id) references learning.plan_actions (id, plan_id),
  foreign key (finding_id, plan_id) references learning.retrospective_findings (id, plan_id)
);
create index action_findings_by_finding on learning.action_findings (finding_id);

insert into learning.action_findings (action_id, finding_id, plan_id) select id, finding_id, plan_id from learning.plan_actions;
alter table learning.plan_actions drop column finding_id;

alter table learning.action_findings enable row level security;
grant select, insert on learning.action_findings to api_owner; -- append-only, like the actions themselves
create policy action_findings_commands on learning.action_findings to api_owner using (true) with check (true);
grant select on learning.action_findings to authenticated;
create policy action_findings_read on learning.action_findings for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- api.link_plan_action, as in 20261014130200_team_time_zone.sql, except that it takes finding_ids (or one finding_id)
-- and links each to the new action.
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
  v_finding_texts text[];
  v_finding_ids uuid[] := '{}'::uuid[];
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
  -- One or more current Findings of this 复盘 motivate the action: finding_ids, or a single finding_id.
  v_finding_texts := case
    when jsonb_typeof(p_action -> 'finding_ids') = 'array' then array(select jsonb_array_elements_text(p_action -> 'finding_ids'))
    when jsonb_typeof(p_action -> 'finding_id') = 'string' then array[p_action ->> 'finding_id']
    else '{}'::text[] end;
  if cardinality(v_finding_texts) > 0 and not exists (select 1 from unnest(v_finding_texts) t where coalesce(t, '') !~ v_uuid) then
    v_finding_ids := array(select distinct t::uuid from unnest(v_finding_texts) t);
  end if;
  if cardinality(v_finding_ids) = 0 or cardinality(v_finding_ids) > 50 or (
      select count(*) from learning.retrospective_findings f where f.id = any (v_finding_ids) and f.plan_id = p_plan_id
        and not exists (select 1 from learning.retrospective_findings g where g.supersedes_id = f.id)) <> cardinality(v_finding_ids) then
    v_errors := v_errors || jsonb_build_object('finding_id', 'Choose one or more current Findings of this 复盘');
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

  insert into learning.plan_actions (plan_id, kind, variant_id, owner_id, due_date, intended_change, success_criterion,
    baseline_evidence_id, created_by)
  values (p_plan_id, 'new_variant', v_variant.id, v_owner.id, v_due, trim(p_action ->> 'intended_change'),
    trim(p_action ->> 'success_criterion'), (select id from learning.plan_evidence where plan_id = p_plan_id and role = 'baseline'), v_caller.id)
  returning * into v_action;
  insert into learning.action_findings (action_id, finding_id, plan_id)
  select v_action.id, f, p_plan_id from unnest(v_finding_ids) f;
  update learning.optimization_plans
  set state = 'in_progress', check_date = v_check,
    minimum_spend = coalesce((p_action ->> 'minimum_spend')::numeric, minimum_spend),
    minimum_spend_currency = coalesce(p_action ->> 'minimum_spend_currency', minimum_spend_currency),
    lock_version = lock_version + 1
  where id = p_plan_id
  returning * into v_plan;

  v_event_id := app.record_event(v_caller.id, 'member', 'optimization_plan', v_plan.id, v_plan.lock_version, 'plan_action_linked',
    jsonb_build_object('action_id', v_action.id, 'variant_id', v_variant.id, 'code', v_variant.code, 'finding_ids', to_jsonb(v_finding_ids)), v_correlation_id);
  perform app.notify(v_event_id, 'plan_action_assigned', format('Make %s from 复盘: %s', v_variant.code, v_action.intended_change),
    'variant', v_variant.id, array[v_owner.id], jsonb_build_object('code', v_variant.code, 'plan_id', p_plan_id));

  return app.remember_result(v_caller.id, 'link_plan_action', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_action.id, 'variant_id', v_variant.id, 'code', v_variant.code, 'lock_version', v_plan.lock_version, 'correlation_id', v_correlation_id));
end;
$$;


reset role;
