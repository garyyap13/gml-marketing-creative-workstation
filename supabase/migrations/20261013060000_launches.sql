-- Launches (D-27–D-30, D-54, D-61; FR-06, T-13, T-14, ADR 0004): one showing of a Variant to people, as a Post
-- or an Ad. Marketing plans a Launch for an approved Version; a Post goes live when its link is pasted, an Ad when
-- the Meta sync matches it.

create schema launch;    -- Launches and the accounts they run on (exposed, read-only to members)
create schema meta;      -- Meta objects seen by the sync and how they matched (exposed, read-only to members)
create schema measure;   -- observations and metric values (not exposed; read through reporting views)
create schema reporting; -- curated result views (exposed, read-only to members)

grant usage on schema launch, meta, reporting to authenticated, api_owner;
grant usage on schema measure, ingest to api_owner;
grant create on schema reporting to api_owner;

-- Lock order, extended: Brief, then Creative, then Variant, then Review, then Launch (T-03).

create table launch.accounts (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('facebook_page', 'instagram', 'meta_ad_account', 'tiktok', 'xiaohongshu', 'youtube')),
  external_id text not null,
  name text not null,
  time_zone text,
  currency text,
  source text not null check (source in ('api', 'manual', 'stand_in')), -- stand_in: demo accounts until B3 (D-72)
  created_at timestamptz not null default now(),
  unique (platform, external_id)
);

create table launch.launches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('post', 'ad')),
  variant_id uuid not null references creative.variants (id),
  version_id uuid references creative.versions (id),
  status text not null check (status in ('planned', 'live', 'ended', 'cancelled')),
  origin text not null check (origin in ('planned', 'unplanned')),
  approval_flag text check (approval_flag in ('never_approved', 'withdrawn', 'superseded')),
  account_id uuid not null references launch.accounts (id),
  planned_on date,
  -- Post
  caption text,
  post_link text,
  post_link_key text,
  -- Ad
  campaign_name text,
  campaign_external_id text,
  ad_set_name text,
  ad_set_external_id text,
  ad_copy text,
  planned_budget numeric(14, 2) check (planned_budget > 0),
  budget_currency text,
  ad_name text,
  utm_content text,
  is_dynamic boolean not null default false,
  created_by uuid references core.members (id),
  created_at timestamptz not null default now(),
  live_at timestamptz,
  ended_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  lock_version integer not null default 0,
  constraint launches_post_fields check (kind = 'ad' or (campaign_name is null and ad_set_name is null and ad_set_external_id is null
    and ad_copy is null and planned_budget is null and ad_name is null and utm_content is null)),
  constraint launches_ad_fields check (kind = 'post' or (caption is null and post_link is null
    and (ad_set_name is not null or ad_set_external_id is not null) and ad_name is not null)),
  constraint launches_planned_by_someone check (origin = 'unplanned' or (version_id is not null and created_by is not null)),
  constraint launches_live_since check (status in ('planned', 'cancelled') or live_at is not null),
  constraint launches_live_post_has_link check (kind = 'ad' or status in ('planned', 'cancelled') or post_link is not null),
  constraint launches_cancel_reason check ((status = 'cancelled') = (cancel_reason is not null)),
  constraint launches_budget_currency check ((planned_budget is null) = (budget_currency is null))
);
-- The same post never backs two Launches (D-30).
create unique index launches_one_post_link on launch.launches (post_link_key) where post_link_key is not null;
create index launches_by_variant on launch.launches (variant_id);

alter table launch.accounts enable row level security;
alter table launch.launches enable row level security;
grant select, insert, update on launch.accounts, launch.launches to api_owner;
create policy accounts_commands on launch.accounts to api_owner using (true) with check (true);
create policy launches_commands on launch.launches to api_owner using (true) with check (true);
grant select on launch.accounts, launch.launches to authenticated;
create policy accounts_read on launch.accounts for select to authenticated using ((select app.is_active_member()));
create policy launches_read on launch.launches for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Whether a Version's approval is in effect, or why not (D-24, D-53).
create function app.approval_state(p_version_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case when r.approval_ended_at is null then 'in_effect' else r.approval_end_reason end
    from review.reviews r where r.version_id = p_version_id and r.decision = 'approve'
  ), 'never_approved');
$$;

-- The generated ad name (D-28): "[GML-0007-B] avatar · angle · narrative", from the Brief version the Version
-- was made from and the Creative's Narrative Style.
create function app.ad_name(p_version_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select format('[%s] %s', va.code, concat_ws(' · ', avatar.name, angle.name, narrative.name))
  from creative.versions v
  join creative.variants va on va.id = v.variant_id
  join creative.creatives c on c.id = va.creative_id
  left join brief.brief_versions bv on bv.id = v.brief_version_id
  left join label.items avatar on avatar.id = bv.avatar_id
  left join label.items angle on angle.id = bv.angle_id
  left join label.items narrative on narrative.id = c.narrative_style_id
  where v.id = p_version_id;
$$;

-- Field errors for a planned Launch (FR-06). Text fields must be text; the budget is a positive amount in the ad
-- account's own currency (D-37: currencies are never converted).
create function app.launch_field_errors(p_kind text, p_fields jsonb, p_account launch.accounts) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_errors jsonb := '{}'::jsonb;
  v_text_limits jsonb := case p_kind
    when 'post' then '{"caption": 2200}'::jsonb
    else '{"campaign_name": 200, "ad_set_name": 200, "ad_set_id": 50, "ad_copy": 2000}'::jsonb end;
  v_key text;
  v_limit integer;
begin
  if p_kind is null or p_kind not in ('post', 'ad') then
    return jsonb_build_object('kind', 'Choose a Post or an Ad');
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object' then
    return jsonb_build_object('fields', 'Provide the Launch details');
  end if;

  if p_account.id is null then
    v_errors := v_errors || jsonb_build_object('account_id', case p_kind when 'post' then 'Choose the Page or account to post on' else 'Choose the ad account' end);
  elsif p_kind = 'post' and p_account.platform = 'meta_ad_account' then
    v_errors := v_errors || jsonb_build_object('account_id', 'A Post goes on a Page or social account, not an ad account');
  elsif p_kind = 'ad' and p_account.platform <> 'meta_ad_account' then
    v_errors := v_errors || jsonb_build_object('account_id', 'An Ad runs in a Meta ad account');
  end if;

  for v_key, v_limit in select key, value::integer from jsonb_each_text(v_text_limits) loop
    if jsonb_typeof(p_fields -> v_key) not in ('string', 'null') or length(p_fields ->> v_key) > v_limit then
      v_errors := v_errors || jsonb_build_object(v_key, format('Up to %s characters of text', v_limit));
    end if;
  end loop;

  if jsonb_typeof(p_fields -> 'planned_on') not in ('string', 'null')
    or (p_fields ->> 'planned_on' is not null and p_fields ->> 'planned_on' !~ '^\d{4}-\d{2}-\d{2}$') then
    v_errors := v_errors || jsonb_build_object('planned_on', 'Use a date like 2026-10-15');
  else
    begin
      perform (p_fields ->> 'planned_on')::date;
    exception when others then
      v_errors := v_errors || jsonb_build_object('planned_on', 'Use a date like 2026-10-15');
    end;
  end if;

  if p_kind = 'ad' then
    if coalesce(trim(p_fields ->> 'campaign_name'), '') = '' and not v_errors ? 'campaign_name' then
      v_errors := v_errors || jsonb_build_object('campaign_name', 'Name the Meta campaign');
    end if;
    if coalesce(trim(p_fields ->> 'ad_set_name'), '') = '' and coalesce(trim(p_fields ->> 'ad_set_id'), '') = ''
      and not v_errors ? 'ad_set_name' then
      v_errors := v_errors || jsonb_build_object('ad_set_name', 'Name the ad set, so the sync can find the ad');
    end if;
    if p_fields ->> 'ad_set_id' is not null and p_fields ->> 'ad_set_id' !~ '^\d{1,50}$' and not v_errors ? 'ad_set_id' then
      v_errors := v_errors || jsonb_build_object('ad_set_id', 'A Meta ad set ID is a number');
    end if;
    if jsonb_typeof(p_fields -> 'planned_budget') not in ('number', 'null')
      or (p_fields ->> 'planned_budget')::numeric <= 0 or (p_fields ->> 'planned_budget')::numeric >= 1e12
      or (p_fields ->> 'planned_budget')::numeric <> round((p_fields ->> 'planned_budget')::numeric, 2) then
      v_errors := v_errors || jsonb_build_object('planned_budget', 'A positive amount, to the cent');
    end if;
    if p_fields ->> 'planned_budget' is not null and p_account.id is not null and p_account.currency is null and not v_errors ? 'planned_budget' then
      v_errors := v_errors || jsonb_build_object('planned_budget', 'This ad account has no currency yet, so a budget cannot be recorded');
    elsif p_fields ->> 'budget_currency' is not null and p_account.id is not null
      and p_fields ->> 'budget_currency' is distinct from p_account.currency then
      v_errors := v_errors || jsonb_build_object('budget_currency', format('This ad account spends in %s', p_account.currency));
    end if;
  end if;
  return v_errors;
end;
$$;

-- Marketing plans a Post or an Ad for an exact approved Version (FR-05, FR-06; AC-05).
create function api.plan_launch(p_version_id uuid, p_kind text, p_fields jsonb, p_idempotency_key uuid) returns jsonb
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
    where vf.variant_id = v_variant.id and vf.removed_at is null and f.usable_until < current_date
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

-- The identity of a pasted post link: the host without "www." or "m.", the path without a trailing slash, and only
-- the query parameters that identify a post (YouTube's v, Facebook's story_fbid, fbid and id), so one post pasted two
-- ways is one post while two YouTube videos stay two. Paths keep their case (Instagram codes are case-sensitive).
create function app.post_link_key(p_link text) returns text
language sql
immutable
set search_path = ''
as $$
  select case when v ~ '^https://[^/[:space:]?#]+\.[^/[:space:]?#]+(/[^[:space:]]*)?$' then
    regexp_replace(lower(substring(v from '^https://([^/?#]+)')), '^(www\.|m\.)', '')
      || regexp_replace(coalesce(substring(v from '^https://[^/?#]+([^?#]*)'), ''), '/+$', '')
      || coalesce('?' || (
        select string_agg(param, '&' order by param)
        from regexp_split_to_table(substring(v from '\?([^#]*)'), '&') as param
        where split_part(param, '=', 1) in ('v', 'story_fbid', 'fbid', 'id') and split_part(param, '=', 2) <> ''
      ), '')
  end
  from (select trim(p_link) as v) link;
$$;

-- The correlation ID of the command or sync in progress.
create function app.current_correlation_id() returns uuid
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('app.correlation_id', true), '')::uuid, gen_random_uuid());
$$;

-- A Variant goes live with its first live Launch: its labels and Footage lock with the Creative's first go-live
-- (D-13, D-54, D-71). The caller holds the Creative and Variant locks.
create function app.go_live(p_variant_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variant creative.variants;
begin
  update creative.creatives set first_live_at = now(), lock_version = lock_version + 1
  where id = (select creative_id from creative.variants where id = p_variant_id) and first_live_at is null;
  update creative.variants
  set state = 'live', live_at = coalesce(live_at, now()), retired_at = null, lock_version = lock_version + 1
  where id = p_variant_id and (state <> 'live' or live_at is null)
  returning * into v_variant;
  if v_variant.id is not null then
    perform app.record_event(null, 'system', 'variant', v_variant.id, v_variant.lock_version, 'variant_live',
      jsonb_build_object('code', v_variant.code), app.current_correlation_id());
  end if;
end;
$$;

-- Locks a Launch's Creative, Variant and the Launch itself, in the lock order.
create function app.lock_launch(p_launch_id uuid) returns launch.launches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_launch launch.launches;
begin
  perform 1 from creative.creatives c join creative.variants v on v.creative_id = c.id join launch.launches l on l.variant_id = v.id
  where l.id = p_launch_id for update of c;
  perform 1 from creative.variants v join launch.launches l on l.variant_id = v.id where l.id = p_launch_id for update of v;
  select * into v_launch from launch.launches where id = p_launch_id for update;
  return v_launch;
end;
$$;

-- Marketing pastes the link of a planned Post once it is published; the Post goes live (D-29, D-54; AC-06, AC-16).
create function api.confirm_post_live(p_launch_id uuid, p_post_link text, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('launch_id', p_launch_id, 'post_link', p_post_link, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_key text := app.post_link_key(p_post_link);
  v_launch launch.launches;
  v_approval text;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'confirm_post_live', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if v_key is null or length(p_post_link) > 2000 or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'post_link', case when v_key is null or length(p_post_link) > 2000 then 'Paste the published post''s https link' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;

  v_launch := app.lock_launch(p_launch_id);
  if v_launch.id is null then
    perform app.fail('not_found');
  end if;
  if v_launch.kind <> 'post' then
    perform app.fail('conflict', jsonb_build_object('reason', 'not_a_post'));
  end if;
  if v_launch.lock_version <> p_expected_lock_version or v_launch.status <> 'planned' then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_launch.lock_version));
  end if;
  v_approval := app.approval_state(v_launch.version_id);
  if v_approval <> 'in_effect' then
    perform app.fail('conflict', jsonb_build_object('reason', case v_approval
      when 'never_approved' then 'version_not_approved' when 'withdrawn' then 'approval_withdrawn' else 'approval_superseded' end));
  end if;
  if exists (select 1 from launch.launches where post_link_key = v_key and id <> p_launch_id) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('post_link', 'This post is already linked to another Launch')));
  end if;

  begin
    update launch.launches
    set status = 'live', post_link = trim(p_post_link), post_link_key = v_key, live_at = now(), lock_version = lock_version + 1
    where id = p_launch_id
    returning * into v_launch;
  exception when unique_violation then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('post_link', 'This post is already linked to another Launch')));
  end;
  perform app.go_live(v_launch.variant_id);
  -- The post ID is resolved later by the Meta worker (D-54); that job arrives with the Meta connection (B3).
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'post_live',
    jsonb_build_object('variant_id', v_launch.variant_id, 'post_link', v_launch.post_link), v_correlation_id);

  return app.remember_result(v_caller.id, 'confirm_post_live', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_launch.id, 'status', v_launch.status, 'lock_version', v_launch.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- A Variant that has been live is live while any of its Launches is live or planned, and retired once none is; a
-- paused ad is still live (D-54, D-72). The caller holds the Variant lock.
create function app.refresh_liveness(p_variant_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean := exists (select 1 from launch.launches where variant_id = p_variant_id and status in ('planned', 'live'));
  v_variant creative.variants;
begin
  update creative.variants
  set state = case when v_active then 'live' else 'retired' end,
    retired_at = case when v_active then null else now() end,
    lock_version = lock_version + 1
  where id = p_variant_id and live_at is not null and state in ('live', 'retired')
    and state <> case when v_active then 'live' else 'retired' end
  returning * into v_variant;
  if v_variant.id is not null then
    perform app.record_event(null, 'system', 'variant', v_variant.id, v_variant.lock_version,
      case when v_active then 'variant_live_again' else 'variant_retired' end, jsonb_build_object('code', v_variant.code), app.current_correlation_id());
  end if;
end;
$$;

-- Marketing ends a live Launch: the post was taken down or the ad turned off (D-54).
create function api.end_launch(p_launch_id uuid, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_launch launch.launches;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;
  v_launch := app.lock_launch(p_launch_id);
  if v_launch.id is null then
    perform app.fail('not_found');
  end if;
  if v_launch.lock_version <> p_expected_lock_version or v_launch.status <> 'live' then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_launch.lock_version));
  end if;

  update launch.launches set status = 'ended', ended_at = now(), lock_version = lock_version + 1
  where id = p_launch_id
  returning * into v_launch;
  perform app.refresh_liveness(v_launch.variant_id);
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'launch_ended',
    jsonb_build_object('variant_id', v_launch.variant_id), v_correlation_id);
  return jsonb_build_object('id', v_launch.id, 'status', v_launch.status, 'lock_version', v_launch.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- Marketing cancels a planned Launch, with a reason (FR-06).
create function api.cancel_launch(p_launch_id uuid, p_reason text, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_launch launch.launches;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if coalesce(trim(p_reason), '') = '' or length(p_reason) > 1000 or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'reason', case when coalesce(trim(p_reason), '') = '' or length(p_reason) > 1000 then 'Say why, in up to 1,000 characters' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;
  v_launch := app.lock_launch(p_launch_id);
  if v_launch.id is null then
    perform app.fail('not_found');
  end if;
  if v_launch.lock_version <> p_expected_lock_version or v_launch.status <> 'planned' then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_launch.lock_version));
  end if;

  update launch.launches set status = 'cancelled', cancelled_at = now(), cancel_reason = trim(p_reason), lock_version = lock_version + 1
  where id = p_launch_id
  returning * into v_launch;
  perform app.refresh_liveness(v_launch.variant_id);
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'launch_cancelled',
    jsonb_build_object('variant_id', v_launch.variant_id, 'reason', v_launch.cancel_reason), v_correlation_id);
  return jsonb_build_object('id', v_launch.id, 'status', v_launch.status, 'lock_version', v_launch.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- Stand-in until the Meta connection (B3): records the Pages and ad accounts the connection can see.
create function worker.record_launch_accounts(p_accounts jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  insert into launch.accounts (platform, external_id, name, time_zone, currency, source)
  select a ->> 'platform', a ->> 'id', a ->> 'name', a ->> 'timezone_name', a ->> 'currency', 'stand_in'
  from jsonb_array_elements(p_accounts) a
  on conflict (platform, external_id) do update set name = excluded.name, time_zone = excluded.time_zone, currency = excluded.currency;
  select jsonb_agg(jsonb_build_object('id', acc.id, 'platform', acc.platform, 'external_id', acc.external_id)) into v_result
  from launch.accounts acc join jsonb_array_elements(p_accounts) a on acc.platform = a ->> 'platform' and acc.external_id = a ->> 'id';
  return v_result;
end;
$$;

reset role;

grant execute on function api.plan_launch(uuid, text, jsonb, uuid) to authenticated;
grant execute on function api.confirm_post_live(uuid, text, integer, uuid) to authenticated;
grant execute on function api.end_launch(uuid, integer) to authenticated;
grant execute on function api.cancel_launch(uuid, text, integer) to authenticated;
grant execute on function worker.record_launch_accounts(jsonb) to service_role;
