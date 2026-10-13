-- Meta objects and Launch matching (D-28, D-31, D-54, D-58, D-61; FR-14, T-14). Each published sync generation
-- records the ad account's campaigns, ad sets and ads, then match_ads links each ad to its Variant and Launch.
-- Until the Meta connection exists (B3), tests publish generations through a stand-in worker function.

create table ingest.sync_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references launch.accounts (id),
  generation integer not null,
  kind text not null check (kind in ('six_hourly', 'daily_repull', 'backfill', 'manual', 'stand_in')),
  state text not null check (state in ('running', 'published', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  published_at timestamptz,
  unique (account_id, generation)
);

create table meta.campaigns (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references launch.accounts (id),
  external_id text not null,
  name text not null,
  objective text,
  unique (account_id, external_id)
);

create table meta.ad_sets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references launch.accounts (id),
  campaign_id uuid references meta.campaigns (id),
  external_id text not null,
  name text not null,
  optimization_goal text,
  attribution_setting text,
  result_indicator text, -- Meta's result indicator for the ad set's optimisation goal, as its insights report it (D-39)
  unique (account_id, external_id)
);

create table meta.ads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references launch.accounts (id),
  ad_set_id uuid references meta.ad_sets (id),
  adset_external_id text, -- kept even when the ad set itself was not in the generation
  external_id text not null,
  name text not null,
  parsed_codes text[] not null default '{}',
  media_id text,
  effective_status text not null,
  match_state text check (match_state in ('matched', 'mismatched', 'untracked', 'dynamic')),
  variant_id uuid references creative.variants (id),
  launch_id uuid references launch.launches (id),
  suggested_creative_id uuid references creative.creatives (id),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_seen_run_id uuid references ingest.sync_runs (id),
  unique (account_id, external_id)
);
-- A Meta ad backs at most one Launch, and a Launch is backed by at most one ad (D-30, AC-06).
create unique index ads_one_launch on meta.ads (launch_id) where launch_id is not null;

-- Rows a sync could not use, kept with the reason; nothing is silently coerced (T-07).
create table ingest.quarantine_rows (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ingest.sync_runs (id),
  row_locator text not null,
  payload jsonb not null,
  error text not null,
  resolution text,
  created_at timestamptz not null default now()
);

create table meta.ad_match_events (
  id uuid primary key default gen_random_uuid(),
  ad_id uuid not null references meta.ads (id),
  from_state text,
  to_state text not null,
  variant_id uuid references creative.variants (id),
  actor_member_id uuid references core.members (id),
  reason text,
  created_at timestamptz not null default now()
);

alter table ingest.sync_runs enable row level security;
alter table meta.campaigns enable row level security;
alter table meta.ad_sets enable row level security;
alter table meta.ads enable row level security;
alter table meta.ad_match_events enable row level security;
alter table ingest.quarantine_rows enable row level security;
grant select, insert on ingest.quarantine_rows to api_owner;
create policy quarantine_rows_commands on ingest.quarantine_rows to api_owner using (true) with check (true);
grant select, insert, update on ingest.sync_runs, meta.campaigns, meta.ad_sets, meta.ads to api_owner;
grant select, insert on meta.ad_match_events to api_owner; -- append-only
create policy sync_runs_commands on ingest.sync_runs to api_owner using (true) with check (true);
create policy campaigns_commands on meta.campaigns to api_owner using (true) with check (true);
create policy ad_sets_commands on meta.ad_sets to api_owner using (true) with check (true);
create policy ads_commands on meta.ads to api_owner using (true) with check (true);
create policy ad_match_events_commands on meta.ad_match_events to api_owner using (true) with check (true);
grant select on meta.campaigns, meta.ad_sets, meta.ads, meta.ad_match_events to authenticated;
create policy campaigns_read on meta.campaigns for select to authenticated using ((select app.is_active_member()));
create policy ad_sets_read on meta.ad_sets for select to authenticated using ((select app.is_active_member()));
create policy ads_read on meta.ads for select to authenticated using ((select app.is_active_member()));
create policy ad_match_events_read on meta.ad_match_events for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Links each ad seen in a sync run to its Variant and Launch (T-14). Runs after every published generation.
create function app.match_ads(p_account_id uuid, p_run_id uuid, p_correlation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ad meta.ads;
  v_ad_set meta.ad_sets;
  v_codes text[];
  v_variant creative.variants;
  v_state text;
  v_suggested uuid;
  v_launch launch.launches;
  v_version_id uuid;
  v_flag text;
  v_running boolean;
  v_gone boolean;
  v_ended_id uuid;
begin
  -- One matching run at a time, so two ad accounts syncing together never lock the same Variants in opposite orders.
  perform pg_advisory_xact_lock(hashtextextended('match_ads', 0));
  for v_ad in select * from meta.ads where account_id = p_account_id and last_seen_run_id = p_run_id order by first_seen_at, external_id loop
    -- Shown to people, or paused after that (D-54); an ad still in review or rejected has not been shown yet.
    v_running := v_ad.effective_status in ('ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'WITH_ISSUES');
    v_gone := v_ad.effective_status in ('ARCHIVED', 'DELETED');
    -- 1. Parse: Variant codes in brackets; a Creative Code without a letter only suggests the Creative (D-61).
    v_codes := array(select c from unnest(v_ad.parsed_codes) c where c ~ '^[A-Z][A-Z0-9]*-[0-9]+-[A-Z]+$');
    select * into v_ad_set from meta.ad_sets where id = v_ad.ad_set_id;
    v_variant := null;
    v_launch := null;
    v_suggested := null;
    if cardinality(v_codes) > 1 then
      v_state := 'dynamic'; -- several Variants in one ad: reported at ad level only (D-31, D-58)
    elsif cardinality(v_codes) = 1 then
      -- Lock order: Creative, then Variant, then Launch.
      perform 1 from creative.creatives c join creative.variants v on v.creative_id = c.id where v.code = v_codes[1] for update of c;
      select * into v_variant from creative.variants where code = v_codes[1] for update;
      v_state := case when v_variant.id is null then 'untracked' else 'matched' end;
    else
      v_state := 'untracked';
      select c.id into v_suggested from creative.creatives c where c.code = any (v_ad.parsed_codes) limit 1;
    end if;

    -- An ad already backing another Variant's Launch was renamed: it stays with that Launch, flagged as Mismatched.
    if v_state = 'matched' and v_ad.launch_id is not null
      and (select variant_id from launch.launches where id = v_ad.launch_id) is distinct from v_variant.id then
      v_state := 'mismatched';
    end if;

    if v_state = 'matched' then
      -- 2. Media check: the first matched ad records the Variant's media; a different video is Mismatched (D-28, D-61).
      if v_variant.meta_media_id is null and v_ad.media_id is not null then
        update creative.variants set meta_media_id = v_ad.media_id, lock_version = lock_version + 1
        where id = v_variant.id
        returning * into v_variant;
        perform app.record_event(null, 'worker', 'variant', v_variant.id, v_variant.lock_version, 'variant_media_recorded',
          jsonb_build_object('meta_ad_id', v_ad.external_id, 'media_id', v_ad.media_id), p_correlation_id);
      elsif v_ad.media_id is distinct from v_variant.meta_media_id then
        v_state := 'mismatched';
      end if;
    end if;

    if v_state = 'matched' then
      -- 3. Launch link: the ad's Launch, else the planned Ad Launch in its ad set (by ID, or by name where the ID was
      -- unknown), else a new unplanned Launch once the ad has been shown (D-54).
      if v_ad.launch_id is not null then
        select * into v_launch from launch.launches where id = v_ad.launch_id for update;
      else
        select l.* into v_launch from launch.launches l
        where l.variant_id = v_variant.id and l.kind = 'ad' and l.status = 'planned' and l.account_id = v_ad.account_id
          and (l.ad_set_external_id = coalesce(v_ad_set.external_id, v_ad.adset_external_id)
            or (l.ad_set_external_id is null and lower(trim(l.ad_set_name)) = lower(trim(v_ad_set.name))))
          and not exists (select 1 from meta.ads a where a.launch_id = l.id)
        order by l.created_at
        limit 1
        for update of l;
      end if;
      if v_launch.id is null and (v_running or v_gone) then
        -- Records the Variant's latest submitted Version, or none (D-61).
        select id into v_version_id from creative.versions where variant_id = v_variant.id order by version_number desc limit 1;
        insert into launch.launches (kind, variant_id, version_id, status, origin, account_id, campaign_name, campaign_external_id,
          ad_set_name, ad_set_external_id, ad_name, utm_content)
        values ('ad', v_variant.id, v_version_id, 'planned', 'unplanned', v_ad.account_id,
          (select name from meta.campaigns where id = v_ad_set.campaign_id), (select external_id from meta.campaigns where id = v_ad_set.campaign_id),
          v_ad_set.name, coalesce(v_ad_set.external_id, v_ad.adset_external_id), v_ad.name, v_variant.code)
        returning * into v_launch;
      end if;

      -- An ad that has been shown always goes live, whatever its approval; the flag shows on data health (D-54).
      if v_launch.id is not null and v_launch.status = 'planned' and (v_running or v_gone) then
        v_flag := case when v_launch.version_id is null then 'never_approved' else nullif(app.approval_state(v_launch.version_id), 'in_effect') end;
        update launch.launches set status = 'live', live_at = coalesce(live_at, now()), approval_flag = v_flag, lock_version = lock_version + 1
        where id = v_launch.id
        returning * into v_launch;
        perform app.go_live(v_variant.id);
        if v_flag is not null then
          update creative.variants set live_without_approval = true where id = v_variant.id;
        end if;
        perform app.record_event(null, 'worker', 'launch', v_launch.id, v_launch.lock_version, 'ad_live',
          jsonb_build_object('variant_id', v_variant.id, 'meta_ad_id', v_ad.external_id, 'approval_flag', v_flag), p_correlation_id);
      end if;
    end if;

    -- An archived or deleted ad ends the Launch it backs, whatever its match state; a paused ad stays live (D-54).
    if v_gone and coalesce(v_launch.id, v_ad.launch_id) is not null then
      v_ended_id := coalesce(v_launch.id, v_ad.launch_id);
      perform 1 from creative.creatives c join creative.variants va on va.creative_id = c.id join launch.launches l on l.variant_id = va.id
      where l.id = v_ended_id for update of c;
      perform 1 from creative.variants va join launch.launches l on l.variant_id = va.id where l.id = v_ended_id for update of va;
      update launch.launches set status = 'ended', ended_at = now(), lock_version = lock_version + 1
      where id = v_ended_id and status = 'live'
      returning * into v_launch;
      if found then
        perform app.refresh_liveness(v_launch.variant_id);
        perform app.record_event(null, 'worker', 'launch', v_launch.id, v_launch.lock_version, 'ad_ended',
          jsonb_build_object('variant_id', v_launch.variant_id, 'meta_ad_id', v_ad.external_id, 'effective_status', v_ad.effective_status), p_correlation_id);
      end if;
    end if;

    if v_state is distinct from v_ad.match_state then
      insert into meta.ad_match_events (ad_id, from_state, to_state, variant_id, reason)
      values (v_ad.id, v_ad.match_state, v_state, v_variant.id, 'sync');
    end if;
    -- A Mismatched ad keeps any Launch it already backed, but its results stay out until it is resolved (T-14).
    update meta.ads
    set match_state = v_state, variant_id = v_variant.id, suggested_creative_id = v_suggested,
      launch_id = case when v_state = 'matched' then v_launch.id when v_state = 'mismatched' then launch_id end
    where id = v_ad.id;
  end loop;
end;
$$;

-- Stand-in until the Meta connection (B3): publishes one sync generation for an ad account from Graph API-shaped
-- objects, then runs matching.
create function worker.record_meta_sync(p_ad_account_id text, p_payload jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := gen_random_uuid();
  v_account launch.accounts;
  v_run ingest.sync_runs;
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
  on conflict (account_id, external_id) do update set name = excluded.name, objective = excluded.objective;

  insert into meta.ad_sets (account_id, campaign_id, external_id, name, optimization_goal, attribution_setting)
  select v_account.id, (select id from meta.campaigns where account_id = v_account.id and external_id = s ->> 'campaign_id'),
    s ->> 'id', s ->> 'name', s ->> 'optimization_goal', s ->> 'attribution_setting'
  from jsonb_array_elements(coalesce(p_payload -> 'adsets', '[]')) s
  on conflict (account_id, external_id) do update
  set name = excluded.name, campaign_id = excluded.campaign_id, optimization_goal = excluded.optimization_goal,
    attribution_setting = excluded.attribution_setting;

  insert into meta.ads (account_id, ad_set_id, external_id, name, parsed_codes, media_id, effective_status)
  select v_account.id, (select id from meta.ad_sets where account_id = v_account.id and external_id = a ->> 'adset_id'),
    a ->> 'id', a ->> 'name',
    array(select distinct m[1] from regexp_matches(a ->> 'name', '\[([A-Z][A-Z0-9]*-[0-9]+(?:-[A-Z]+)?)\]', 'g') as m),
    coalesce(a -> 'creative' ->> 'video_id', a -> 'creative' ->> 'image_hash'), a ->> 'effective_status'
  from jsonb_array_elements(coalesce(p_payload -> 'ads', '[]')) a
  on conflict (account_id, external_id) do update
  set name = excluded.name, ad_set_id = excluded.ad_set_id, parsed_codes = excluded.parsed_codes,
    media_id = coalesce(excluded.media_id, meta.ads.media_id), effective_status = excluded.effective_status, last_seen_at = now();
  update meta.ads set last_seen_run_id = v_run.id
  where account_id = v_account.id and external_id in (select a ->> 'id' from jsonb_array_elements(coalesce(p_payload -> 'ads', '[]')) a);

  perform app.match_ads(v_account.id, v_run.id, v_correlation_id);

  update ingest.sync_runs set state = 'published', published_at = now() where id = v_run.id returning * into v_run;
  return jsonb_build_object('generation', v_run.generation, 'run_id', v_run.id);
end;
$$;

-- Review decisions on a Variant that is already live (D-61).
create or replace function api.request_changes(p_review_id uuid, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('review_id', p_review_id, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_review review.reviews;
  v_variant creative.variants;
  v_creative creative.creatives;
  v_event_id uuid;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'request_changes', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  v_review := app.lock_open_review(p_review_id, p_expected_lock_version);
  update review.reviews
  set decision = 'request_changes', decided_by = v_caller.id, decided_at = now(), lock_version = lock_version + 1
  where id = p_review_id
  returning * into v_review;
  -- A Variant an observed ad already put live stays live; its media is frozen, so changes need a new Variant (D-25, D-61).
  update creative.variants set state = case when live_at is null then 'changes_requested' else state end, lock_version = lock_version + 1
  where id = v_review.variant_id
  returning * into v_variant;
  select * into v_creative from creative.creatives where id = v_variant.creative_id;

  perform app.close_tasks('version_submitted', v_review.id);
  v_event_id := app.record_event(v_caller.id, 'member', 'review', v_review.id, v_review.lock_version, 'changes_requested',
    jsonb_build_object('variant_id', v_variant.id, 'version_id', v_review.version_id, 'code', v_variant.code),
    v_correlation_id);
  -- D-56: changes requested notifies the Creative Owner.
  perform app.notify(v_event_id, 'changes_requested', format(case when v_variant.live_at is null
      then 'Make the requested changes to %s' else 'Make the requested changes to live %s as a new Variant' end, v_variant.code),
    'variant', v_variant.id, array[v_creative.creative_owner_id],
    jsonb_build_object('code', v_variant.code, 'review_id', v_review.id));

  return app.remember_result(v_caller.id, 'request_changes', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_review.id, 'decision', v_review.decision, 'version_id', v_review.version_id,
    'lock_version', v_review.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

create or replace function api.approve_version(p_review_id uuid, p_version_id uuid, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('review_id', p_review_id, 'version_id', p_version_id,
    'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_review review.reviews;
  v_variant creative.variants;
  v_blocking uuid[];
  v_event_id uuid;
begin
  if not v_caller.is_approver then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'approve_version', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  v_review := app.lock_open_review(p_review_id, p_expected_lock_version);
  if p_version_id is distinct from v_review.version_id then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('version_id', 'This Review is for a different Version')));
  end if;
  v_blocking := array(
    select c.id from review.comments c join creative.versions v on v.id = c.version_id
    where v.variant_id = v_review.variant_id and c.kind = 'blocking' and c.resolved_at is null
    order by c.created_at);
  if cardinality(v_blocking) > 0 then
    perform app.fail('invalid', jsonb_build_object('reason', 'open_blocking_comments', 'blockingCommentIds', to_jsonb(v_blocking)));
  end if;
  if exists (
    select 1 from creative.version_files vf join core.files f on f.id = vf.file_id
    where vf.version_id = v_review.version_id and f.drift_state is distinct from 'unchanged') then
    perform app.fail('invalid', jsonb_build_object('reason', 'file_changed_in_drive'));
  end if;

  update review.reviews
  set decision = 'approve', decided_by = v_caller.id, decided_at = now(), lock_version = lock_version + 1
  where id = p_review_id
  returning * into v_review;
  -- A Variant an observed ad already put live stays live, and approving the recorded Version clears its flag (D-61).
  update launch.launches set approval_flag = null, lock_version = lock_version + 1
  where version_id = v_review.version_id and approval_flag is not null;
  update creative.variants
  set state = case when live_at is null then 'approved' else state end,
    live_without_approval = live_without_approval and exists (
      select 1 from launch.launches where variant_id = v_review.variant_id and status = 'live' and approval_flag is not null),
    lock_version = lock_version + 1
  where id = v_review.variant_id
  returning * into v_variant;

  perform app.close_tasks('version_submitted', v_review.id);
  v_event_id := app.record_event(v_caller.id, 'member', 'review', v_review.id, v_review.lock_version, 'version_approved',
    jsonb_build_object('variant_id', v_variant.id, 'version_id', v_review.version_id, 'code', v_variant.code),
    v_correlation_id);
  -- D-56: approval notifies the Marketing Owner.
  perform app.notify(v_event_id, 'version_approved', format('Plan Launches for %s', v_variant.code),
    'variant', v_variant.id, array[app.marketing_owner_of(v_variant.creative_id)],
    jsonb_build_object('code', v_variant.code, 'version_id', v_review.version_id));

  return app.remember_result(v_caller.id, 'approve_version', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_review.id, 'decision', v_review.decision, 'version_id', v_review.version_id,
    'lock_version', v_review.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

create or replace function api.create_variant(
  p_creative_id uuid,
  p_labels jsonb,
  p_derived_from_variant_id uuid,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('creative_id', p_creative_id, 'labels', p_labels,
    'derived_from_variant_id', p_derived_from_variant_id);
  v_replayed jsonb;
  v_errors jsonb;
  v_creative creative.creatives;
  v_media_kind text;
  v_letter text;
  v_variant creative.variants;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'create_variant', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select * into v_creative from creative.creatives where id = p_creative_id for update;
  if v_creative.id is null or v_creative.archived_at is not null then
    perform app.fail('not_found');
  end if;
  v_media_kind := app.format_media_kind(p_creative_id);
  v_errors := app.variant_label_errors(coalesce(p_labels, '{}'::jsonb), v_media_kind);
  if p_derived_from_variant_id is not null and not exists (
    select 1 from creative.variants where id = p_derived_from_variant_id and creative_id = p_creative_id) then
    v_errors := v_errors || jsonb_build_object('derived_from_variant_id', 'Choose a Variant of this Creative');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  update creative.creatives set last_variant_number = last_variant_number + 1
  where id = p_creative_id
  returning * into v_creative;
  v_letter := app.variant_letter(v_creative.last_variant_number);

  insert into creative.variants
    (creative_id, letter, code, hook_type_id, length_id, aspect_ratio_id, production_stage, derived_from_variant_id)
  values (
    p_creative_id, v_letter, v_creative.code || '-' || v_letter,
    (p_labels ->> 'hook_type_id')::uuid, (p_labels ->> 'length_id')::uuid, (p_labels ->> 'aspect_ratio_id')::uuid,
    (app.production_stages(v_media_kind))[1], p_derived_from_variant_id)
  returning * into v_variant;

  -- A new Variant derived from a live one is how changes requested on the live one are made (D-25).
  if p_derived_from_variant_id is not null then
    perform app.close_tasks('changes_requested', p_derived_from_variant_id);
  end if;
  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'variant_created',
    jsonb_build_object('code', v_variant.code, 'creative_id', p_creative_id), v_correlation_id);

  return app.remember_result(v_caller.id, 'create_variant', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_variant.id, 'code', v_variant.code, 'lock_version', v_variant.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

reset role;

grant execute on function worker.record_meta_sync(text, jsonb) to service_role;
