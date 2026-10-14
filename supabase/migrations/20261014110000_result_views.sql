-- Combination and Label views (D-40, D-41, D-76; T-15, AC-20). Both read the current daily paid results of synced
-- ads and never mix currencies, result types, attribution settings, time zones or channel scopes (D-37): every row
-- carries its scope, and rows of different scopes are never summed together. Reach is a daily figure, so a Reach
-- result is never added up and neither view returns Reach.

-- A day reported again under another result type, attribution, currency or time zone replaces its earlier copy. A new
-- ad set's first sync, before any leads, reports days with no result type; the daily re-pull then reports the same
-- days with leads. Without this, both copies would stay current and the same money would show twice. Observations
-- stay append-only; the older copy is only marked superseded, and frozen Evidence keeps citing its revision.
alter table measure.observations add column superseded_at timestamptz;
grant update (superseded_at) on measure.observations to api_owner;
create index observations_current_days on measure.observations (period_start)
  where breakdown_key = '' and source_action_type = '' and superseded_at is null;

set role api_owner;

create function app.supersede_other_scopes() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obs measure.observations;
  v_scope measure.report_scopes;
begin
  select * into v_obs from measure.observations where id = new.observation_id;
  select * into v_scope from measure.report_scopes where id = v_obs.scope_id;
  update measure.observations set superseded_at = null where id = v_obs.id and superseded_at is not null;
  update measure.observations o set superseded_at = now()
  from measure.report_scopes s
  where s.id = o.scope_id and o.id <> v_obs.id and o.superseded_at is null
    and o.entity_id = v_obs.entity_id and o.period_start = v_obs.period_start and o.period_end = v_obs.period_end
    and o.breakdown_key = v_obs.breakdown_key and o.source_action_type = v_obs.source_action_type
    and s.account_id = v_scope.account_id and s.entity_level = v_scope.entity_level and s.channel_scope = v_scope.channel_scope
    and s.period_kind = v_scope.period_kind and s.breakdown_schema = v_scope.breakdown_schema and s.definition_version = v_scope.definition_version;
  return null;
end;
$$;

reset role;

create trigger observation_revisions_supersede after insert or update of published_at on measure.observation_revisions
  for each row when (new.published_at is not null) execute function app.supersede_other_scopes();

-- Variant results read only current copies (as in 20261013060200_results.sql, plus the superseded filter).
create or replace view reporting.variant_daily_results with (security_invoker = true) as
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
  and o.source_action_type = '' and o.period_start = o.period_end and o.superseded_at is null
group by l.variant_id, va.code, l.id, l.version_id, a.external_id, a.name, o.period_start, s.channel_scope, s.time_zone, s.currency,
  s.attribution_setting, s.result_indicator, s.definition_version, r.id, r.generation;

-- Every synced ad's current daily paid results, whatever its match state, so a view can account for all of an ad
-- set's spend. Its match state is the ad's current one: once an ad is resolved, its whole history moves with it.
create view reporting.ad_daily_results with (security_invoker = true) as
select
  a.id as ad_id, a.external_id as meta_ad_id, a.name as ad_name, a.account_id, a.ad_set_id, a.match_state,
  case when a.match_state = 'matched' then a.variant_id end as variant_id,
  o.period_start as day, s.channel_scope, s.time_zone, s.currency, s.attribution_setting, s.result_indicator,
  max(mv.value) filter (where mv.metric_key = 'spend') as spend,
  max(mv.value) filter (where mv.metric_key = 'impressions') as impressions,
  max(mv.value) filter (where mv.metric_key = 'link_clicks') as link_clicks,
  max(mv.value) filter (where mv.metric_key = 'results') as results
from measure.observations o
join measure.report_scopes s on s.id = o.scope_id
join measure.reporting_entities e on e.id = o.entity_id
join meta.ads a on a.id = e.meta_ad_id
join lateral (
  select rr.id from measure.observation_revisions rr
  where rr.observation_id = o.id and rr.published_at is not null
  order by rr.generation desc limit 1
) r on true
join measure.metric_values mv on mv.revision_id = r.id
where s.period_kind = 'daily' and s.breakdown_schema = 'none' and o.breakdown_key = '' and o.source_action_type = ''
  and o.period_start = o.period_end and o.superseded_at is null
group by a.id, a.external_id, a.name, a.account_id, a.ad_set_id, a.match_state, a.variant_id, o.period_start, s.channel_scope,
  s.time_zone, s.currency, s.attribution_setting, s.result_indicator;

-- One ad set over a period, in slices: each Variant with matched ads, each Dynamic Ad on its own (ad level only,
-- D-31), then the Untracked, Mismatched and kept-out ads, so within one scope the slices add up to all of the ad set's
-- spend (T-15, PD-28). A Live Variant whose ads Meta reported no delivery for is still a member, with no scope and
-- nothing reported. Missing spend and results are counted so the reader never treats them as zero.
create function reporting.combination(p_ad_set_id uuid, p_from date default null, p_to date default null)
returns table (
  slice text, variant_id uuid, variant_code text, ad_id uuid, ad_name text, ads bigint, spend numeric, results numeric,
  impressions numeric, link_clicks numeric, days bigint, spend_missing bigint, results_missing bigint,
  currency text, result_indicator text, attribution_setting text, time_zone text, channel_scope text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with rows as (
    select r.*, case when r.match_state = 'matched' then 'variant' else coalesce(r.match_state, 'untracked') end as slice
    from reporting.ad_daily_results r
    where r.ad_set_id = p_ad_set_id and r.day >= coalesce(p_from, '-infinity'::date) and r.day <= coalesce(p_to, 'infinity'::date)
  )
  select r.slice, r.variant_id, v.code, case when r.slice = 'dynamic' then r.ad_id end, case when r.slice = 'dynamic' then max(r.ad_name) end,
    count(distinct r.ad_id), sum(r.spend), case when r.result_indicator = 'reach' then null else sum(r.results) end,
    sum(r.impressions), sum(r.link_clicks), count(distinct r.day), count(*) filter (where r.spend is null), count(*) filter (where r.results is null),
    r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope
  from rows r
  left join creative.variants v on v.id = r.variant_id
  group by r.slice, r.variant_id, v.code, case when r.slice = 'dynamic' then r.ad_id end, r.currency, r.result_indicator, r.attribution_setting,
    r.time_zone, r.channel_scope
  union all
  select 'variant', a.variant_id, v.code, null, null, count(distinct a.id), null, null, null, null, 0, 0, 0, null, null, null, null, null
  from meta.ads a
  join creative.variants v on v.id = a.variant_id
  join launch.launches l on l.id = a.launch_id
  where a.ad_set_id = p_ad_set_id and a.match_state = 'matched' and l.live_at is not null
    and l.live_at::date <= coalesce(p_to, 'infinity'::date) and coalesce(l.ended_at::date, 'infinity'::date) >= coalesce(p_from, '-infinity'::date)
    and not exists (select 1 from rows r where r.variant_id = a.variant_id)
  group by a.variant_id, v.code;
$$;

-- Each label item's Variant results pooled across ad sets, one row per label item and scope (T-15). Labels resolve
-- through merges (T-13); a Variant with no item of that kind, such as a Legacy Creative's, pools under no label.
-- Footage and its Presenter are dimensions too (D-71): a Variant using several counts under each, so those rows are
-- never added together. Missing figures are counted, and a Reach result is never added up.
create function reporting.label_results(p_kind text, p_from date default null, p_to date default null)
returns table (
  label_id uuid, label_name text, variants bigint, spend numeric, results numeric, impressions numeric, link_clicks numeric,
  spend_missing bigint, results_missing bigint, engagement_missing bigint,
  currency text, result_indicator text, attribution_setting text, time_zone text, channel_scope text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recursive roots as (
    select id, id as root from label.items where merged_into_id is null
    union all
    select i.id, r.root from label.items i join roots r on i.merged_into_id = r.id
  ),
  tagged as (
    select v.id as variant_id,
      case p_kind
        when 'hook_type' then v.hook_type_id when 'length' then v.length_id when 'aspect_ratio' then v.aspect_ratio_id
        when 'format' then c.format_id when 'narrative_style' then c.narrative_style_id
        when 'avatar' then bv.avatar_id when 'angle' then bv.angle_id when 'product' then bv.product_id
        when 'funnel_stage' then bv.funnel_stage_id when 'initiative' then bv.initiative_id
      end as item_id
    from creative.variants v
    join creative.creatives c on c.id = v.creative_id
    left join brief.brief_versions bv on bv.id = c.brief_version_id
    where p_kind in ('hook_type', 'length', 'aspect_ratio', 'format', 'narrative_style', 'avatar', 'angle', 'product', 'funnel_stage', 'initiative')
    union all
    select v.id, f.item_id
    from creative.variants v
    left join lateral (
      select distinct case when p_kind = 'footage' then vf.footage_id else ft.presenter_id end as item_id
      from creative.variant_footage vf join creative.footage ft on ft.id = vf.footage_id
      where vf.variant_id = v.id and vf.removed_at is null and (p_kind = 'footage' or ft.presenter_id is not null)
    ) f on true
    where p_kind in ('footage', 'presenter')
  ),
  labelled as (
    select t.variant_id, case when p_kind = 'footage' then t.item_id else ro.root end as label_id
    from tagged t
    left join roots ro on ro.id = t.item_id
  )
  select l.label_id,
    case when p_kind = 'footage' then (select f.code || ' · ' || f.title from creative.footage f where f.id = l.label_id)
      else (select li.name from label.items li where li.id = l.label_id) end,
    count(distinct r.variant_id), sum(r.spend), case when r.result_indicator = 'reach' then null else sum(r.results) end,
    sum(r.impressions), sum(r.link_clicks), count(*) filter (where r.spend is null), count(*) filter (where r.results is null),
    count(*) filter (where r.impressions is null or r.link_clicks is null),
    r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope
  from reporting.variant_daily_results r
  join labelled l on l.variant_id = r.variant_id
  where r.day >= coalesce(p_from, '-infinity'::date) and r.day <= coalesce(p_to, 'infinity'::date)
  group by l.label_id, r.currency, r.result_indicator, r.attribution_setting, r.time_zone, r.channel_scope;
$$;

-- The ad sets with results in a period, for choosing a Combination view: spend per ad set and currency, never summed
-- across currencies.
create function reporting.combination_ad_sets(p_from date default null, p_to date default null)
returns table (ad_set_id uuid, ad_set_name text, campaign_name text, account_id uuid, currency text, spend numeric, last_day date)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.ad_set_id, s.name, c.name, r.account_id, r.currency, sum(r.spend), max(r.day)
  from reporting.ad_daily_results r
  join meta.ad_sets s on s.id = r.ad_set_id
  left join meta.campaigns c on c.id = s.campaign_id
  where r.day >= coalesce(p_from, '-infinity'::date) and r.day <= coalesce(p_to, 'infinity'::date)
  group by r.ad_set_id, s.name, c.name, r.account_id, r.currency;
$$;

grant select on reporting.ad_daily_results to authenticated;
revoke execute on function reporting.combination(uuid, date, date), reporting.label_results(text, date, date),
  reporting.combination_ad_sets(date, date) from public;
grant execute on function reporting.combination(uuid, date, date), reporting.label_results(text, date, date),
  reporting.combination_ad_sets(date, date) to authenticated;
