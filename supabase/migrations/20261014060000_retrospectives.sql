-- 复盘: Optimization Plans with frozen Evidence, the team's Findings, follow-up actions and Verdicts (D-41–D-43, D-57,
-- D-63, D-67, D-74; FR-09, FR-17, T-08, T-18). The retrospective extends Optimization Plans; it is not a second
-- approval lifecycle.

create schema learning; -- Optimization Plans, Evidence, Findings and actions (exposed, read-only to members)
grant usage on schema learning to authenticated, api_owner;

-- Lock order, extended: Brief, then Creative, then Variant, then Review, then Launch, then Optimization Plan (T-03).

create table learning.optimization_plans (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references core.members (id),
  owner_id uuid not null references core.members (id),
  baseline_variant_id uuid not null references creative.variants (id),
  baseline_version_id uuid not null references creative.versions (id),
  hypothesis text,
  -- "What we wanted to learn", as recorded when the plan was written (D-67).
  intent_brief_hypothesis text,
  intent_source_plan_hypothesis text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  state text not null default 'proposed' check (state in ('proposed', 'accepted', 'in_progress', 'completed', 'cancelled')),
  evidence_class text not null check (evidence_class in ('insufficient_evidence', 'observational', 'experiment_supported')),
  check_date date,
  minimum_spend numeric(14, 2) check (minimum_spend > 0),
  minimum_spend_currency text check (minimum_spend_currency ~ '^[A-Z]{3}$'),
  accepted_at timestamptz,
  verdict text check (verdict in ('confirmed', 'not_confirmed', 'not_enough_data')),
  verdict_by uuid references core.members (id),
  verdict_by_system boolean not null default false,
  verdict_at timestamptz,
  verdict_note text,
  completion_summary text,
  completed_at timestamptz,
  cancel_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  lock_version integer not null default 0,
  constraint plans_minimum_spend check ((minimum_spend is null) = (minimum_spend_currency is null)),
  constraint plans_verdict_complete check ((verdict is null) = (verdict_at is null)
    and (verdict is null or (verdict_by is not null) <> verdict_by_system)),
  constraint plans_verdict_needs_check_date check (verdict is null or check_date is not null),
  constraint plans_accepted check (state in ('proposed', 'cancelled') or accepted_at is not null),
  constraint plans_completed check (state <> 'completed' or (verdict is not null and completion_summary is not null)),
  constraint plans_cancelled check ((state = 'cancelled') = (cancel_reason is not null))
);

-- Frozen when the plan is written; never changed afterwards (D-42, T-18).
create table learning.plan_evidence (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references learning.optimization_plans (id),
  role text not null check (role in ('baseline', 'comparator')),
  variant_id uuid not null references creative.variants (id),
  version_id uuid references creative.versions (id),
  annotation_revision_id uuid references creative.annotation_revisions (id),
  files jsonb not null default '[]'::jsonb,
  launch_ids uuid[] not null default '{}',
  date_from date not null,
  date_to date not null check (date_to >= date_from),
  scope jsonb,
  totals jsonb,
  missing jsonb not null default '{}'::jsonb,
  frozen_at timestamptz not null default now(),
  unique (plan_id, role)
);

create table learning.evidence_rows (
  evidence_id uuid not null references learning.plan_evidence (id),
  revision_id uuid not null references measure.observation_revisions (id),
  day date not null,
  launch_id uuid not null references launch.launches (id),
  meta_ad_id text not null,
  values jsonb not null,
  unavailable jsonb not null default '{}'::jsonb,
  definition_version integer not null,
  primary key (evidence_id, revision_id)
);

-- Append-only; a correction is a new Finding that supersedes the earlier one (T-18, D-74).
create table learning.retrospective_findings (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references learning.optimization_plans (id),
  kind text not null check (kind in ('observation', 'hypothesis')),
  body text not null,
  disposition text not null check (disposition in ('keep', 'change', 'test')),
  target text not null check (target in ('whole_video', 'section', 'time_range')),
  section_id uuid references creative.content_sections (id),
  start_ms bigint,
  end_ms bigint,
  evidence_id uuid references learning.plan_evidence (id),
  supersedes_id uuid unique references learning.retrospective_findings (id),
  author_id uuid not null references core.members (id),
  created_at timestamptz not null default now(),
  constraint findings_target check (
    (target = 'whole_video' and section_id is null and start_ms is null and end_ms is null)
    or (target = 'section' and section_id is not null and start_ms is null and end_ms is null)
    or (target = 'time_range' and section_id is null and start_ms >= 0 and end_ms > start_ms)),
  -- Ad-level results do not measure a section or a moment, so only hypotheses point at one (FR-17, D-74).
  constraint findings_observation check (kind = 'hypothesis' or (target = 'whole_video' and evidence_id is not null))
);

create table learning.plan_actions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references learning.optimization_plans (id),
  kind text not null check (kind in ('new_variant', 'new_brief', 'ad_side_change')),
  finding_id uuid not null references learning.retrospective_findings (id),
  variant_id uuid references creative.variants (id),
  owner_id uuid not null references core.members (id),
  due_date date not null,
  intended_change text not null,
  success_criterion text not null,
  baseline_evidence_id uuid not null references learning.plan_evidence (id),
  created_by uuid not null references core.members (id),
  created_at timestamptz not null default now(),
  constraint plan_actions_new_variant check (kind <> 'new_variant' or variant_id is not null)
);
create unique index plan_actions_one_per_variant on learning.plan_actions (variant_id) where variant_id is not null;
create index plan_actions_by_plan on learning.plan_actions (plan_id);
create index findings_by_plan on learning.retrospective_findings (plan_id);
create index plan_evidence_by_variant on learning.plan_evidence (variant_id);

alter table learning.optimization_plans enable row level security;
alter table learning.plan_evidence enable row level security;
alter table learning.evidence_rows enable row level security;
alter table learning.retrospective_findings enable row level security;
alter table learning.plan_actions enable row level security;
grant select, insert, update on learning.optimization_plans to api_owner;
grant select, insert on learning.plan_evidence, learning.evidence_rows, learning.retrospective_findings, learning.plan_actions to api_owner;
create policy plans_commands on learning.optimization_plans to api_owner using (true) with check (true);
create policy plan_evidence_commands on learning.plan_evidence to api_owner using (true) with check (true);
create policy evidence_rows_commands on learning.evidence_rows to api_owner using (true) with check (true);
create policy findings_commands on learning.retrospective_findings to api_owner using (true) with check (true);
create policy plan_actions_commands on learning.plan_actions to api_owner using (true) with check (true);
grant select on learning.optimization_plans, learning.plan_evidence, learning.evidence_rows, learning.retrospective_findings,
  learning.plan_actions to authenticated;
create policy plans_read on learning.optimization_plans for select to authenticated using ((select app.is_active_member()));
create policy plan_evidence_read on learning.plan_evidence for select to authenticated using ((select app.is_active_member()));
create policy evidence_rows_read on learning.evidence_rows for select to authenticated using ((select app.is_active_member()));
create policy findings_read on learning.retrospective_findings for select to authenticated using ((select app.is_active_member()));
create policy plan_actions_read on learning.plan_actions for select to authenticated using ((select app.is_active_member()));

-- Commands read current results through the same curated view members use.
grant select on reporting.variant_daily_results, reporting.revision_values to api_owner;

-- Spend on the Launches of a plan's follow-up Variants from acceptance to the check date, by currency. Only spend in
-- the minimum's currency counts towards it; other currencies are shown, never converted (D-37, D-57, D-74).
create view reporting.plan_spend with (security_invoker = true) as
select p.id as plan_id, r.currency, sum(r.spend) as spend, r.currency = p.minimum_spend_currency as counted,
  count(*) filter (where r.spend is null)::integer as unreported_days
from learning.optimization_plans p
join learning.plan_actions a on a.plan_id = p.id
join reporting.variant_daily_results r on r.variant_id = a.variant_id
where p.accepted_at is not null and r.day >= p.accepted_at::date and (p.check_date is null or r.day <= p.check_date)
group by p.id, r.currency, p.minimum_spend_currency;
grant select on reporting.plan_spend to authenticated, api_owner;

set role api_owner;

-- Freezes one Variant's current daily paid results for a date range as Evidence (D-42, T-18). The rows are read once,
-- and everything frozen is derived from that one read. Only rows of one scope can be frozen together, since currencies,
-- time zones, attribution and result types never mix (D-37).
create function app.freeze_evidence(p_plan_id uuid, p_role text, p_variant_id uuid, p_version_id uuid, p_from date, p_to date)
returns learning.plan_evidence
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
  v_scopes jsonb;
  v_evidence learning.plan_evidence;
begin
  select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_rows
  from reporting.variant_daily_results r
  where r.variant_id = p_variant_id and (p_version_id is null or r.version_id = p_version_id) and r.day between p_from and p_to;

  select coalesce(jsonb_agg(distinct jsonb_build_object('currency', r ->> 'currency', 'time_zone', r ->> 'time_zone',
    'attribution_setting', r ->> 'attribution_setting', 'result_indicator', r ->> 'result_indicator', 'channel_scope', r ->> 'channel_scope')), '[]'::jsonb)
  into v_scopes from jsonb_array_elements(v_rows) r;
  if jsonb_array_length(v_scopes) > 1 then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object(case p_role when 'baseline' then 'evidence' else 'comparator_variant_id' end,
      'These dates mix results in different currencies, time zones, attribution or result types. Choose dates with one kind')));
  end if;

  insert into learning.plan_evidence (plan_id, role, variant_id, version_id, annotation_revision_id, files, launch_ids, date_from, date_to,
    scope, totals, missing)
  select p_plan_id, p_role, p_variant_id, p_version_id,
    case when p_role = 'baseline' then (
      select ar.id from creative.annotation_revisions ar where ar.version_id = p_version_id order by ar.revision_number desc limit 1) end,
    -- The file identity is its Drive file ID, head revision, checksum and size (T-19).
    case when p_role = 'baseline' then coalesce((
      select jsonb_agg(jsonb_build_object('file_id', f.id, 'drive_file_id', f.drive_file_id, 'drive_revision_id', f.drive_revision_id,
        'checksum', f.checksum, 'checksum_algorithm', f.checksum_algorithm, 'bytes', f.bytes, 'card_position', vf.card_position) order by vf.card_position)
      from creative.version_files vf join core.files f on f.id = vf.file_id where vf.version_id = p_version_id), '[]'::jsonb) else '[]'::jsonb end,
    coalesce((select array_agg(distinct (r ->> 'launch_id')::uuid) from jsonb_array_elements(v_rows) r), '{}'),
    p_from, p_to, v_scopes -> 0,
    case when jsonb_array_length(v_rows) = 0 then null else (
      select jsonb_build_object(
        'spend', case when bool_and(r ->> 'spend' is not null) then sum((r ->> 'spend')::numeric) end,
        'results', case when bool_and(r ->> 'results' is not null) then sum((r ->> 'results')::numeric) end,
        'impressions', case when bool_and(r ->> 'impressions' is not null) then sum((r ->> 'impressions')::numeric) end,
        'link_clicks', case when bool_and(r ->> 'link_clicks' is not null) then sum((r ->> 'link_clicks')::numeric) end,
        'days', count(distinct r ->> 'day'))
      from jsonb_array_elements(v_rows) r) end,
    case when jsonb_array_length(v_rows) = 0 then jsonb_build_object('results', 'No matched paid results for these dates')
    else coalesce((select jsonb_object_agg(key, value) from (
      select distinct u.key, u.value from jsonb_array_elements(v_rows) r, jsonb_each_text(r -> 'unavailable') u) m), '{}'::jsonb) end
  returning * into v_evidence;

  insert into learning.evidence_rows (evidence_id, revision_id, day, launch_id, meta_ad_id, values, unavailable, definition_version)
  select v_evidence.id, (r ->> 'revision_id')::uuid, (r ->> 'day')::date, (r ->> 'launch_id')::uuid, r ->> 'meta_ad_id',
    jsonb_build_object('spend', r -> 'spend', 'impressions', r -> 'impressions', 'reach', r -> 'reach', 'link_clicks', r -> 'link_clicks', 'results', r -> 'results'),
    r -> 'unavailable', (r ->> 'definition_version')::integer
  from jsonb_array_elements(v_rows) r;
  return v_evidence;
end;
$$;

-- Either team starts a 复盘 for an exact live Version: the plan, with its baseline Evidence frozen (FR-09, FR-17; AC-31).
create function api.write_optimization_plan(p_fields jsonb, p_evidence jsonb, p_actions jsonb, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('fields', p_fields, 'evidence', p_evidence, 'actions', p_actions);
  v_replayed jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_uuid text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_version creative.versions;
  v_owner core.members;
  v_from date;
  v_to date;
  v_comparator creative.variants;
  v_plan learning.optimization_plans;
  v_baseline learning.plan_evidence;
  v_compared learning.plan_evidence;
begin
  v_replayed := app.replayed_result(v_caller.id, 'write_optimization_plan', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  if jsonb_typeof(p_fields) is distinct from 'object' or jsonb_typeof(p_evidence) is distinct from 'object' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('fields', 'Provide the plan and its Evidence')));
  end if;
  if coalesce(p_fields ->> 'version_id', '') !~ v_uuid then
    v_errors := v_errors || jsonb_build_object('version_id', 'Choose the exact Version this 复盘 is about');
  end if;
  if jsonb_typeof(p_fields -> 'hypothesis') not in ('string', 'null') or length(p_fields ->> 'hypothesis') > 2000 then
    v_errors := v_errors || jsonb_build_object('hypothesis', 'Up to 2,000 characters of text');
  end if;
  if coalesce(p_fields ->> 'priority', 'normal') not in ('low', 'normal', 'high') then
    v_errors := v_errors || jsonb_build_object('priority', 'Low, normal or high');
  end if;
  if coalesce(p_fields ->> 'evidence_class', 'observational') not in ('observational', 'insufficient_evidence') then
    v_errors := v_errors || jsonb_build_object('evidence_class', 'Experiment-supported Evidence needs a Controlled Test, which arrives with the Meta connection');
  end if;
  if p_fields ->> 'owner_id' is not null then
    if p_fields ->> 'owner_id' ~ v_uuid then
      select * into v_owner from core.members where id = (p_fields ->> 'owner_id')::uuid and active and archived_at is null;
    end if;
    if v_owner.id is null then
      v_errors := v_errors || jsonb_build_object('owner_id', 'Choose an active member');
    end if;
  end if;
  if not coalesce(pg_input_is_valid(p_evidence ->> 'date_from', 'date') and pg_input_is_valid(p_evidence ->> 'date_to', 'date'), false)
    or (p_evidence ->> 'date_from') !~ '^\d{4}-\d{2}-\d{2}$' or (p_evidence ->> 'date_to') !~ '^\d{4}-\d{2}-\d{2}$' then
    v_errors := v_errors || jsonb_build_object('evidence', 'Choose the dates of the results to cite');
  else
    v_from := (p_evidence ->> 'date_from')::date;
    v_to := (p_evidence ->> 'date_to')::date;
    if v_to < v_from or v_to - v_from > 366 then
      v_errors := v_errors || jsonb_build_object('evidence', 'Choose dates in order, at most a year apart');
    end if;
  end if;
  if p_evidence ->> 'comparator_variant_id' is not null then
    if p_evidence ->> 'comparator_variant_id' ~ v_uuid then
      select * into v_comparator from creative.variants where id = (p_evidence ->> 'comparator_variant_id')::uuid;
    end if;
    if v_comparator.id is null then
      v_errors := v_errors || jsonb_build_object('comparator_variant_id', 'Choose a Variant to compare with');
    end if;
  end if;
  if jsonb_typeof(coalesce(p_actions, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_actions, '[]'::jsonb)) > 0 then
    v_errors := v_errors || jsonb_build_object('actions', 'Add actions from the Findings once the plan is written');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  select * into v_version from creative.versions where id = (p_fields ->> 'version_id')::uuid;
  if v_version.id is null then
    perform app.fail('not_found');
  end if;
  -- A 复盘 looks back at a Version that was actually shown; an unknown live Version stays unknown (T-18).
  if not exists (select 1 from launch.launches where version_id = v_version.id and status in ('live', 'ended')) then
    perform app.fail('conflict', jsonb_build_object('reason', 'version_never_live'));
  end if;
  if v_comparator.id = v_version.variant_id then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('comparator_variant_id', 'Compare with a different Variant')));
  end if;

  -- A sync takes this lock exclusively while it matches and publishes (app.match_ads), so the baseline and comparator
  -- are frozen from one published state, never half of a new generation.
  perform pg_advisory_xact_lock_shared(hashtextextended('match_ads', 0));

  insert into learning.optimization_plans (author_id, owner_id, baseline_variant_id, baseline_version_id, hypothesis,
    intent_brief_hypothesis, intent_source_plan_hypothesis, priority, evidence_class)
  values (v_caller.id, coalesce(v_owner.id, v_caller.id), v_version.variant_id, v_version.id, nullif(trim(p_fields ->> 'hypothesis'), ''),
    (select nullif(trim(hypothesis), '') from brief.brief_versions where id = v_version.brief_version_id),
    (select p.hypothesis from learning.plan_actions a join learning.optimization_plans p on p.id = a.plan_id where a.variant_id = v_version.variant_id),
    coalesce(p_fields ->> 'priority', 'normal'), 'observational')
  returning * into v_plan;

  v_baseline := app.freeze_evidence(v_plan.id, 'baseline', v_version.variant_id, v_version.id, v_from, v_to);
  if v_comparator.id is not null then
    v_compared := app.freeze_evidence(v_plan.id, 'comparator', v_comparator.id, null, v_from, v_to);
    -- Only like with like: the comparison needs results of exactly the baseline's kind (AC-31).
    if v_compared.scope is null or v_compared.scope is distinct from v_baseline.scope then
      perform app.fail('invalid', jsonb_build_object('reason', 'comparator_incompatible', 'fieldErrors', jsonb_build_object('comparator_variant_id',
        'Compare with results in the same currency, time zone, attribution and result type')));
    end if;
  end if;
  -- With no results to cite, a 复盘 is insufficient evidence whatever was asked for (T-18).
  update learning.optimization_plans
  set evidence_class = case when v_baseline.totals is null then 'insufficient_evidence' else coalesce(p_fields ->> 'evidence_class', 'observational') end
  where id = v_plan.id
  returning * into v_plan;

  perform app.record_event(v_caller.id, 'member', 'optimization_plan', v_plan.id, v_plan.lock_version, 'plan_written',
    jsonb_build_object('variant_id', v_plan.baseline_variant_id, 'version_id', v_plan.baseline_version_id), v_correlation_id);
  return app.remember_result(v_caller.id, 'write_optimization_plan', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_plan.id, 'state', v_plan.state, 'evidence_class', v_plan.evidence_class, 'lock_version', v_plan.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

-- Either team adds a Finding to a 复盘 that is still open (T-18, D-74; AC-31). Findings are never edited: a correction
-- is a new Finding that supersedes the earlier one.
create function api.append_retrospective_finding(p_plan_id uuid, p_finding jsonb, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('plan_id', p_plan_id, 'finding', p_finding, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_uuid text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_plan learning.optimization_plans;
  v_baseline learning.plan_evidence;
  v_duration bigint;
  v_errors jsonb := '{}'::jsonb;
  v_kind text := p_finding ->> 'kind';
  v_target text := p_finding ->> 'target';
  v_finding learning.retrospective_findings;
begin
  v_replayed := app.replayed_result(v_caller.id, 'append_retrospective_finding', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if p_expected_lock_version is null or jsonb_typeof(p_finding) is distinct from 'object' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('finding', 'Provide the Finding and the plan''s lock version')));
  end if;

  select * into v_plan from learning.optimization_plans where id = p_plan_id;
  if v_plan.id is null then
    perform app.fail('not_found');
  end if;
  select * into v_baseline from learning.plan_evidence where plan_id = p_plan_id and role = 'baseline';
  select max(f.duration_ms) into v_duration from jsonb_array_elements(v_baseline.files) bf join core.files f on f.id = (bf ->> 'file_id')::uuid;

  if v_kind is null or v_kind not in ('observation', 'hypothesis') then
    v_errors := v_errors || jsonb_build_object('kind', 'An Observation or a Hypothesis');
  end if;
  if jsonb_typeof(p_finding -> 'body') is distinct from 'string' or trim(p_finding ->> 'body') = '' or length(p_finding ->> 'body') > 2000 then
    v_errors := v_errors || jsonb_build_object('body', 'Write the Finding, in up to 2,000 characters');
  end if;
  if coalesce(p_finding ->> 'disposition', '') not in ('keep', 'change', 'test') then
    v_errors := v_errors || jsonb_build_object('disposition', 'Keep, change or test');
  end if;
  if v_target is null or v_target not in ('whole_video', 'section', 'time_range') then
    v_errors := v_errors || jsonb_build_object('target', 'The whole video, a section or a time range');
  elsif v_kind = 'observation' and v_target <> 'whole_video' then
    -- Ad-level results do not measure a section or a moment (FR-17, D-74).
    v_errors := v_errors || jsonb_build_object('kind', 'Results are whole-ad numbers, so a section or moment can only carry a Hypothesis');
  elsif v_target = 'section' and not (coalesce(p_finding ->> 'section_id', '') ~ v_uuid and exists (
      select 1 from creative.content_sections where id = (p_finding ->> 'section_id')::uuid and revision_id = v_baseline.annotation_revision_id)) then
    v_errors := v_errors || jsonb_build_object('section_id', 'Choose a section of the annotations this 复盘 froze');
  elsif v_target = 'time_range' and (jsonb_typeof(p_finding -> 'start_ms') is distinct from 'number'
      or (p_finding ->> 'start_ms')::numeric < 0 or (p_finding ->> 'start_ms')::numeric <> trunc((p_finding ->> 'start_ms')::numeric)) then
    v_errors := v_errors || jsonb_build_object('start_ms', 'Start in whole milliseconds, from 0');
  elsif v_target = 'time_range' and (jsonb_typeof(p_finding -> 'end_ms') is distinct from 'number'
      or (p_finding ->> 'end_ms')::numeric <> trunc((p_finding ->> 'end_ms')::numeric)
      or (p_finding ->> 'end_ms')::numeric <= (p_finding ->> 'start_ms')::numeric
      or v_duration is null or (p_finding ->> 'end_ms')::numeric > v_duration) then
    v_errors := v_errors || jsonb_build_object('end_ms', format('End after the start and inside the video (%s)', coalesce(app.format_ms(v_duration), 'no duration')));
  end if;
  if v_kind = 'observation' and not (coalesce(p_finding ->> 'evidence_id', '') ~ v_uuid and exists (
      select 1 from learning.plan_evidence where id = (p_finding ->> 'evidence_id')::uuid and plan_id = p_plan_id and totals is not null)) then
    v_errors := v_errors || jsonb_build_object('evidence_id', 'An Observation cites results this 复盘 froze');
  elsif v_kind = 'hypothesis' and p_finding ->> 'evidence_id' is not null and not (p_finding ->> 'evidence_id' ~ v_uuid and exists (
      select 1 from learning.plan_evidence where id = (p_finding ->> 'evidence_id')::uuid and plan_id = p_plan_id)) then
    v_errors := v_errors || jsonb_build_object('evidence_id', 'Cite Evidence this 复盘 froze');
  end if;
  if p_finding ->> 'supersedes_id' is not null and not (p_finding ->> 'supersedes_id' ~ v_uuid and exists (
      select 1 from learning.retrospective_findings f where f.id = (p_finding ->> 'supersedes_id')::uuid and f.plan_id = p_plan_id
        and not exists (select 1 from learning.retrospective_findings g where g.supersedes_id = f.id))) then
    v_errors := v_errors || jsonb_build_object('supersedes_id', 'Correct a Finding of this 复盘 that has not been corrected yet');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  select * into v_plan from learning.optimization_plans where id = p_plan_id for update;
  if v_plan.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_plan.lock_version));
  end if;
  if v_plan.state in ('completed', 'cancelled') then
    perform app.fail('conflict', jsonb_build_object('reason', 'plan_closed'));
  end if;

  begin
    insert into learning.retrospective_findings (plan_id, kind, body, disposition, target, section_id, start_ms, end_ms, evidence_id, supersedes_id, author_id)
    values (p_plan_id, v_kind, trim(p_finding ->> 'body'), p_finding ->> 'disposition', v_target,
      case when v_target = 'section' then (p_finding ->> 'section_id')::uuid end,
      case when v_target = 'time_range' then (p_finding ->> 'start_ms')::bigint end,
      case when v_target = 'time_range' then (p_finding ->> 'end_ms')::bigint end,
      (p_finding ->> 'evidence_id')::uuid, (p_finding ->> 'supersedes_id')::uuid, v_caller.id)
    returning * into v_finding;
  exception when unique_violation then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('supersedes_id', 'That Finding was just corrected by someone else')));
  end;
  update learning.optimization_plans set lock_version = lock_version + 1 where id = p_plan_id returning * into v_plan;
  perform app.record_event(v_caller.id, 'member', 'optimization_plan', v_plan.id, v_plan.lock_version, 'finding_added',
    jsonb_build_object('finding_id', v_finding.id, 'kind', v_finding.kind, 'supersedes_id', v_finding.supersedes_id), v_correlation_id);
  return app.remember_result(v_caller.id, 'append_retrospective_finding', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_finding.id, 'lock_version', v_plan.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- Only the plan's owner or an Approver steers a plan (D-55).
create function app.can_steer_plan(p_caller core.members, p_plan learning.optimization_plans) returns boolean
language sql
stable
set search_path = ''
as $$
  select p_caller.id = p_plan.owner_id or p_caller.is_approver;
$$;

-- The owner or an Approver accepts a plan (starting its spend window), completes it with a Verdict and a summary, or
-- cancels it with a reason (FR-09, D-74). A plan moves to in progress when its first action is linked.
create function api.change_plan_state(p_plan_id uuid, p_state text, p_note text, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_plan learning.optimization_plans;
begin
  if p_state is null or p_state not in ('accepted', 'completed', 'cancelled') or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'state', case when p_state is null or p_state not in ('accepted', 'completed', 'cancelled') then 'Accept, complete or cancel' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;
  if p_state in ('completed', 'cancelled') and (coalesce(trim(p_note), '') = '' or length(p_note) > 2000) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('note',
      case p_state when 'completed' then 'Summarise what was learned' else 'Say why it is cancelled' end || ', in up to 2,000 characters')));
  end if;

  select * into v_plan from learning.optimization_plans where id = p_plan_id for update;
  if v_plan.id is null then
    perform app.fail('not_found');
  end if;
  if not app.can_steer_plan(v_caller, v_plan) then
    perform app.fail('forbidden');
  end if;
  if v_plan.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_plan.lock_version));
  end if;
  if (p_state = 'accepted' and v_plan.state <> 'proposed')
    or (p_state = 'completed' and v_plan.state not in ('accepted', 'in_progress'))
    or (p_state = 'cancelled' and v_plan.state in ('completed', 'cancelled')) then
    perform app.fail('conflict', jsonb_build_object('reason', 'invalid_transition'));
  end if;
  if p_state = 'completed' and v_plan.verdict is null then
    perform app.fail('conflict', jsonb_build_object('reason', 'verdict_needed'));
  end if;

  update learning.optimization_plans
  set state = p_state,
    accepted_at = case when p_state = 'accepted' then now() else accepted_at end,
    completion_summary = case when p_state = 'completed' then trim(p_note) else completion_summary end,
    completed_at = case when p_state = 'completed' then now() else completed_at end,
    cancel_reason = case when p_state = 'cancelled' then trim(p_note) else cancel_reason end,
    cancelled_at = case when p_state = 'cancelled' then now() else cancelled_at end,
    lock_version = lock_version + 1
  where id = p_plan_id
  returning * into v_plan;
  if p_state in ('completed', 'cancelled') then
    perform app.close_tasks('verdict_due', p_plan_id);
  end if;
  perform app.record_event(v_caller.id, 'member', 'optimization_plan', v_plan.id, v_plan.lock_version, 'plan_' || p_state,
    jsonb_build_object('note', nullif(trim(p_note), '')), v_correlation_id);
  return jsonb_build_object('id', v_plan.id, 'state', v_plan.state, 'lock_version', v_plan.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- The owner or an Approver turns a Finding into a follow-up Variant of the baseline's Creative (D-42, D-74; AC-11).
create function api.link_plan_action(p_plan_id uuid, p_action jsonb, p_expected_lock_version integer, p_idempotency_key uuid) returns jsonb
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
  if v_due is null or v_due < current_date then
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

create function app.counted_spend(p_plan_id uuid) returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(sum(unreported_days), 0) > 0 then null else coalesce(sum(spend), 0) end
  from reporting.plan_spend where plan_id = p_plan_id and counted;
$$;

-- An Approver records the Verdict, from the check date (D-43, D-74; AC-11). Below the minimum spend only "not enough
-- data" is possible, and once the daily check has recorded it, it stands.
create function api.record_verdict(p_plan_id uuid, p_verdict text, p_note text, p_expected_lock_version integer, p_idempotency_key uuid)
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
  if current_date < v_plan.check_date then
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

-- The daily check (T-16 emit_due_events and auto_verdicts, D-57, D-74): for each open plan whose check date has come,
-- too little counted spend records "not enough data"; otherwise the owner and the Approvers are asked for the Verdict.
-- Run by a schedule on the hosted project (B1); tests call it with a date.
create function worker.run_due_checks(p_today date) returns jsonb
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

-- Submitting a follow-up Variant's Version closes its owner's task.
create or replace function api.submit_version(
  p_variant_id uuid,
  p_file_ids uuid[],
  p_notes text,
  p_expected_lock_version integer,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('variant_id', p_variant_id, 'file_ids', to_jsonb(p_file_ids), 'notes', p_notes,
    'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_variant creative.variants;
  v_creative creative.creatives;
  v_media_kind text;
  v_file_count integer := coalesce(cardinality(p_file_ids), 0);
  v_usable integer;
  v_videos integer;
  v_images integer;
  v_version creative.versions;
  v_review review.reviews;
  v_owner_id uuid;
  v_owner_is_approver boolean;
  v_event_id uuid;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null or v_file_count = 0 then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end,
      'files', case when v_file_count = 0 then 'Choose the Version''s files' end))));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'submit_version', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select * into v_variant from creative.variants where id = p_variant_id for update;
  if v_variant.id is null then
    perform app.fail('not_found');
  end if;
  if v_variant.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_variant.lock_version));
  end if;
  if v_variant.state <> 'in_production' then
    perform app.fail('conflict', jsonb_build_object('reason', 'variant_not_in_production'));
  end if;

  select * into v_creative from creative.creatives where id = v_variant.creative_id;
  v_media_kind := app.format_media_kind(v_creative.id);
  -- A Version records the Brief version it followed, which must be locked by hand-off (D-16).
  if not exists (select 1 from brief.brief_versions where id = v_creative.brief_version_id and state = 'handed_off') then
    v_errors := v_errors || jsonb_build_object('brief', 'The Marketing Team must hand off the Brief first');
  end if;
  if v_creative.format_confirmed_by is null then
    v_errors := v_errors || jsonb_build_object('format', 'The Marketing Team must confirm the Format first');
  end if;
  if v_creative.narrative_style_id is null then
    v_errors := v_errors || jsonb_build_object('narrative_style_id', 'Choose a Narrative Style');
  end if;
  if v_media_kind = 'video' and v_variant.hook_type_id is null then
    v_errors := v_errors || jsonb_build_object('hook_type_id', 'Choose a Hook type');
  elsif v_media_kind is distinct from 'video' and v_variant.hook_type_id is not null then
    v_errors := v_errors || jsonb_build_object('hook_type_id', 'Only video Variants have a Hook type');
  end if;
  if v_variant.length_id is null then
    v_errors := v_errors || jsonb_build_object('length_id', 'Choose a length');
  end if;
  if v_variant.aspect_ratio_id is null then
    v_errors := v_errors || jsonb_build_object('aspect_ratio_id', 'Choose an aspect ratio');
  end if;

  select count(*), count(*) filter (where f.mime like 'video/%'), count(*) filter (where f.mime like 'image/%')
  into v_usable, v_videos, v_images
  from core.files f
  where f.id = any (p_file_ids)
    and f.kind = 'version_media' and f.variant_id = p_variant_id
    and f.verification_state = 'ready' and f.drift_state = 'unchanged'
    and not exists (select 1 from creative.version_files vf where vf.file_id = f.id);
  if v_usable <> v_file_count or (select count(distinct x) from unnest(p_file_ids) x) <> v_file_count then
    v_errors := v_errors || jsonb_build_object('files', 'Use verified Drive files registered for this Variant');
  elsif (select count(distinct f.drive_file_id) from core.files f where f.id = any (p_file_ids)) <> v_file_count then
    v_errors := v_errors || jsonb_build_object('files', 'Each file must be a different Drive file');
  elsif (v_media_kind = 'video' and not (v_file_count = 1 and v_videos = 1))
     or (v_media_kind = 'image' and not (v_file_count = 1 and v_images = 1))
     or (v_media_kind = 'carousel' and not (v_file_count >= 2 and v_images = v_file_count)) then
    v_errors := v_errors || jsonb_build_object('files', case v_media_kind
      when 'video' then 'A video Version has one video file'
      when 'image' then 'A static Version has one image file'
      else 'A carousel Version has two or more images, in card order' end);
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  -- D-69: a Drive file already used by a Version cannot back another one.
  if exists (
    select 1 from core.files f join core.files used on used.drive_file_id = f.drive_file_id and used.attached_at is not null
    where f.id = any (p_file_ids)) then
    perform app.fail('conflict', jsonb_build_object('fieldErrors',
      jsonb_build_object('files', 'This Drive file is already used by a Version. Upload new content as a new file')));
  end if;

  insert into creative.versions (variant_id, version_number, brief_version_id, submitted_by, notes)
  values (p_variant_id,
    coalesce((select max(version_number) from creative.versions where variant_id = p_variant_id), 0) + 1,
    v_creative.brief_version_id, v_caller.id, nullif(trim(p_notes), ''))
  returning * into v_version;
  insert into creative.version_files (version_id, file_id, card_position)
  select v_version.id, file_id, position from unnest(p_file_ids) with ordinality as cards (file_id, position);
  begin
    update core.files set attached_at = now() where id = any (p_file_ids);
  exception when unique_violation then -- a simultaneous submission attached the same Drive file
    perform app.fail('conflict', jsonb_build_object('fieldErrors',
      jsonb_build_object('files', 'This Drive file is already used by a Version. Upload new content as a new file')));
  end;
  insert into review.reviews (version_id, variant_id, round_number)
  values (v_version.id, p_variant_id, v_version.version_number)
  returning * into v_review;
  update creative.variants set state = 'awaiting_review', lock_version = lock_version + 1
  where id = p_variant_id
  returning * into v_variant;

  v_event_id := app.record_event(v_caller.id, 'member', 'review', v_review.id, v_review.lock_version, 'version_submitted',
    jsonb_build_object('variant_id', p_variant_id, 'version_id', v_version.id, 'version_number', v_version.version_number,
      'code', v_variant.code), v_correlation_id);

  -- Submitting completes the Creative Owner's hand-off task and any changes-requested task for this Variant.
  perform app.close_tasks('changes_requested', p_variant_id);
  perform app.close_tasks('plan_action_assigned', p_variant_id); -- a follow-up Variant from a 复盘 has been made (D-74)
  perform app.close_tasks('brief_handed_off',
    (select brief_id from brief.brief_versions where id = v_creative.brief_version_id), v_creative.creative_owner_id);

  -- D-56: the Brief's Marketing Owner, plus the Approvers if that owner is not one.
  v_owner_id := app.marketing_owner_of(v_creative.id);
  select is_approver into v_owner_is_approver from core.members where id = v_owner_id;
  perform app.notify(v_event_id, 'version_submitted',
    format('Review %s v%s', v_variant.code, v_version.version_number), 'review', v_review.id,
    array_append(
      case when v_owner_is_approver then '{}'::uuid[]
      else array(select id from core.members where is_approver and active and archived_at is null) end,
      v_owner_id),
    jsonb_build_object('code', v_variant.code, 'version_number', v_version.version_number, 'version_id', v_version.id));

  return app.remember_result(v_caller.id, 'submit_version', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_variant.id, 'state', v_variant.state, 'lock_version', v_variant.lock_version,
    'version_id', v_version.id, 'version_number', v_version.version_number, 'review_id', v_review.id,
    'correlation_id', v_correlation_id));
end;
$$;

reset role;

grant execute on function api.write_optimization_plan(jsonb, jsonb, jsonb, uuid) to authenticated;
grant execute on function api.append_retrospective_finding(uuid, jsonb, integer, uuid) to authenticated;
grant execute on function api.change_plan_state(uuid, text, text, integer) to authenticated;
grant execute on function api.link_plan_action(uuid, jsonb, integer, uuid) to authenticated;
grant execute on function api.record_verdict(uuid, text, text, integer, uuid) to authenticated;
grant execute on function worker.run_due_checks(date) to service_role;
