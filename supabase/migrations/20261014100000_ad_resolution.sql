-- Resolving Untracked and Mismatched Ads, and data health (D-38, D-55, D-56, D-61, D-76; T-14 step 7, T-16).
-- A Marketing Team member links an ad to a Variant or keeps it out with a reason. The resolution is kept on the ad,
-- so later syncs honour it: a linked ad stays with its Variant until its media changes again, when it becomes
-- Mismatched (D-61), and a kept-out ad stays out until someone links it. Untracked Ads keep one Marketing Team task
-- open until none is left; a Mismatched Ad gives its Variant's Marketing Owner a task (D-56).

alter table meta.ads
  add column resolution text check (resolution in ('linked', 'kept_out')),
  add column resolved_variant_id uuid references creative.variants (id),
  add column resolved_media_id text, -- the ad's media when it was linked; a different media later is Mismatched again
  add column resolved_by uuid references core.members (id),
  add column resolved_at timestamptz,
  add column resolution_reason text,
  add constraint ads_resolution_variant check ((resolution is not distinct from 'linked') = (resolved_variant_id is not null)),
  drop constraint ads_match_state_check,
  add constraint ads_match_state_check check (match_state in ('matched', 'mismatched', 'untracked', 'dynamic', 'kept_out'));

-- At most one open Untracked Ads task, addressed to the Marketing Team as a whole (T-16).
create unique index tasks_one_open_untracked on work.tasks (kind) where kind = 'untracked_ads' and done_at is null;

-- Data health reads sync runs and the reasons rows were set aside, never their raw payloads (T-08).
grant usage on schema ingest to authenticated;
grant select (id, account_id, generation, kind, state, counts, started_at, published_at) on ingest.sync_runs to authenticated;
create policy sync_runs_read on ingest.sync_runs for select to authenticated using ((select app.is_active_member()));
grant select (id, run_id, row_locator, error, resolution, created_at) on ingest.quarantine_rows to authenticated;
create policy quarantine_rows_read on ingest.quarantine_rows for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Matches one ad seen in a sync, or just resolved, to its Variant and Launch (T-14). A resolution wins over the ad's
-- name (PD-27): a kept-out ad stays out, and a linked ad stays with its Variant while its media is the one it was
-- linked with; other media makes it Mismatched against that Variant. An ad that backs a Launch and loses its code is
-- Mismatched too, so it keeps its Launch. p_actor and p_reason describe who changed the match, for the ad's match
-- history; a sync passes neither.
create function app.match_ad(p_ad_id uuid, p_correlation_id uuid, p_actor uuid default null, p_reason text default null) returns void
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
  v_event uuid;
begin
  select * into v_ad from meta.ads where id = p_ad_id;
  -- Shown to people, or paused after that (D-54); an ad still in review or rejected has not been shown yet.
  v_running := v_ad.effective_status in ('ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'WITH_ISSUES');
  v_gone := v_ad.effective_status in ('ARCHIVED', 'DELETED');
  select * into v_ad_set from meta.ad_sets where id = v_ad.ad_set_id;
  -- An ad linked before Meta reported its media takes the first media it reports.
  if v_ad.resolution = 'linked' and v_ad.resolved_media_id is null and v_ad.media_id is not null then
    update meta.ads set resolved_media_id = media_id where id = v_ad.id returning * into v_ad;
  end if;

  if v_ad.resolution = 'kept_out' then
    v_state := 'kept_out';
  elsif v_ad.resolution = 'linked' then
    -- Lock order: Creative, then Variant, then Launch.
    perform 1 from creative.creatives c join creative.variants v on v.creative_id = c.id where v.id = v_ad.resolved_variant_id for update of c;
    select * into v_variant from creative.variants where id = v_ad.resolved_variant_id for update;
    if v_ad.media_id is distinct from v_ad.resolved_media_id then
      v_state := 'mismatched';
    else
      v_state := 'matched';
      -- Linking records the Variant's media when none is recorded yet, as the first matched ad would (D-28).
      if v_variant.meta_media_id is null and v_ad.media_id is not null then
        update creative.variants set meta_media_id = v_ad.media_id, lock_version = lock_version + 1
        where id = v_variant.id
        returning * into v_variant;
        perform app.record_event(null, 'worker', 'variant', v_variant.id, v_variant.lock_version, 'variant_media_recorded',
          jsonb_build_object('meta_ad_id', v_ad.external_id, 'media_id', v_ad.media_id), p_correlation_id);
      end if;
    end if;
  else
    -- 1. Parse: Variant codes in brackets; a Creative Code without a letter only suggests the Creative (D-61).
    v_codes := array(select c from unnest(v_ad.parsed_codes) c where c ~ '^[A-Z][A-Z0-9]*-[0-9]+-[A-Z]+$');
    if cardinality(v_codes) > 1 then
      v_state := 'dynamic'; -- several Variants in one ad: reported at ad level only (D-31, D-58)
    elsif cardinality(v_codes) = 1 then
      perform 1 from creative.creatives c join creative.variants v on v.creative_id = c.id where v.code = v_codes[1] for update of c;
      select * into v_variant from creative.variants where code = v_codes[1] for update;
      v_state := case when v_variant.id is null then 'untracked' else 'matched' end;
    else
      v_state := 'untracked';
      select c.id into v_suggested from creative.creatives c where c.code = any (v_ad.parsed_codes) limit 1;
    end if;

    -- An ad already backing a Launch was renamed to another Variant's code, to no code or to several: it stays with
    -- that Launch, flagged as Mismatched against the Launch's Variant.
    if v_ad.launch_id is not null and (v_state in ('untracked', 'dynamic')
        or (v_state = 'matched' and (select variant_id from launch.launches where id = v_ad.launch_id) is distinct from v_variant.id)) then
      if v_state <> 'matched' then
        select * into v_variant from creative.variants where id = (select variant_id from launch.launches where id = v_ad.launch_id);
      end if;
      v_state := 'mismatched';
      v_suggested := null;
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
    insert into meta.ad_match_events (ad_id, from_state, to_state, variant_id, actor_member_id, reason)
    values (v_ad.id, v_ad.match_state, v_state, v_variant.id, p_actor, coalesce(p_reason, case when p_actor is null then 'sync' else 'resolved' end));
  end if;
  -- A newly Mismatched Ad is a task for its Variant's Marketing Owner (D-56); it is done once the ad is resolved.
  if v_state = 'mismatched' and v_ad.match_state is distinct from 'mismatched' then
    v_event := app.record_event(null, 'worker', 'meta_ad', v_ad.id, null, 'ad_mismatched',
      jsonb_build_object('variant_id', v_variant.id, 'meta_ad_id', v_ad.external_id, 'ad_name', v_ad.name), p_correlation_id);
    perform app.notify(v_event, 'ad_mismatched', 'Check the Mismatched Ad ' || v_ad.name, 'meta_ad', v_ad.id,
      array[(select b.marketing_owner_id from creative.creatives c join brief.brief_versions bv on bv.id = c.brief_version_id
             join brief.briefs b on b.id = bv.brief_id where c.id = v_variant.creative_id)],
      jsonb_build_object('variant_code', v_variant.code, 'ad_name', v_ad.name));
  elsif v_state <> 'mismatched' and v_ad.match_state = 'mismatched' then
    perform app.close_tasks('ad_mismatched', v_ad.id);
  end if;
  -- A Mismatched or kept-out ad keeps any Launch it already backed, but its results stay out (T-14).
  update meta.ads
  set match_state = v_state, variant_id = v_variant.id, suggested_creative_id = v_suggested,
    launch_id = case when v_state = 'matched' then v_launch.id when v_state in ('mismatched', 'kept_out') then launch_id end
  where id = v_ad.id;
end;
$$;

-- Keeps the one Marketing Team task for Untracked Ads in step with how many there are: opened by the first, updated
-- with the count, and done when none is left. It never sends WhatsApp (D-56, T-16).
create function app.refresh_untracked_task(p_correlation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_first uuid;
  v_task work.tasks;
  v_event uuid;
begin
  select count(*), (array_agg(id order by first_seen_at, id))[1] into v_count, v_first from meta.ads where match_state = 'untracked';
  select * into v_task from work.tasks where kind = 'untracked_ads' and done_at is null for update;
  if v_count > 0 and v_task.id is null then
    v_event := app.record_event(null, 'worker', 'meta_ad', v_first, null, 'untracked_ads_found', jsonb_build_object('count', v_count), p_correlation_id);
    insert into work.tasks (event_id, kind, recipient_team, action_needed, entity_type, entity_id, payload)
    values (v_event, 'untracked_ads', 'marketing', 'Resolve the Untracked Ads', 'untracked_ads', v_first, jsonb_build_object('count', v_count));
  elsif v_count > 0 and (v_task.payload ->> 'count')::integer is distinct from v_count then
    update work.tasks set payload = jsonb_build_object('count', v_count) where id = v_task.id;
  elsif v_count = 0 and v_task.id is not null then
    update work.tasks set done_at = now() where id = v_task.id;
  end if;
end;
$$;

-- Links each ad seen in a sync run to its Variant and Launch, then updates the Untracked Ads task (T-14, T-16).
create or replace function app.match_ads(p_account_id uuid, p_run_id uuid, p_correlation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ad_id uuid;
begin
  -- One matching run at a time, so two ad accounts syncing together never lock the same Variants in opposite orders.
  perform pg_advisory_xact_lock(hashtextextended('match_ads', 0));
  for v_ad_id in select id from meta.ads where account_id = p_account_id and last_seen_run_id = p_run_id order by first_seen_at, external_id loop
    perform app.match_ad(v_ad_id, p_correlation_id);
  end loop;
  perform app.refresh_untracked_task(p_correlation_id);
end;
$$;

-- A Marketing Team member links an Untracked, Mismatched or kept-out ad to a Variant, or keeps it out with a reason
-- (D-55). A Mismatched ad that backs a Launch can only be linked to that Launch's Variant. A new Variant, where the
-- media really differs, is added by its Creative Owner first.
create function api.resolve_ad(p_meta_ad_id uuid, p_variant_id uuid, p_reason text, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('meta_ad_id', p_meta_ad_id, 'variant_id', p_variant_id, 'reason', p_reason);
  v_replayed jsonb;
  v_ad meta.ads;
  v_variant creative.variants;
  v_launch_variant uuid;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'resolve_ad', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if (p_variant_id is null and coalesce(trim(p_reason), '') = '') or length(p_reason) > 500 then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('reason', 'Say why this ad is kept out, in up to 500 characters')));
  end if;

  -- The ad's row first, then the matching lock. A sync writes its ads before it takes that lock, so this order means
  -- a resolution waits for a sync of the same ad to finish instead of deadlocking with it.
  select * into v_ad from meta.ads where id = p_meta_ad_id for update;
  perform pg_advisory_xact_lock(hashtextextended('match_ads', 0));
  if v_ad.id is null then
    perform app.fail('not_found');
  end if;
  if v_ad.match_state = 'matched' then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_matched'));
  elsif v_ad.match_state = 'dynamic' then
    perform app.fail('conflict', jsonb_build_object('reason', 'dynamic_ad'));
  end if;
  if p_variant_id is not null then
    select * into v_variant from creative.variants where id = p_variant_id;
    if v_variant.id is null then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('variant_id', 'Choose a Variant')));
    end if;
    select variant_id into v_launch_variant from launch.launches where id = v_ad.launch_id;
    if v_launch_variant is not null and v_launch_variant <> p_variant_id then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('variant_id',
        'This ad backs a Launch of ' || (select code from creative.variants where id = v_launch_variant) || '. Link it to that Variant or keep it out')));
    end if;
  end if;

  update meta.ads set
    resolution = case when p_variant_id is null then 'kept_out' else 'linked' end,
    resolved_variant_id = p_variant_id, resolved_media_id = case when p_variant_id is null then null else media_id end,
    resolved_by = v_caller.id, resolved_at = now(), resolution_reason = nullif(trim(p_reason), '')
  where id = p_meta_ad_id;
  perform app.record_event(v_caller.id, 'member', 'meta_ad', v_ad.id, null, 'ad_resolved',
    jsonb_build_object('resolution', case when p_variant_id is null then 'kept_out' else 'linked' end, 'variant_id', p_variant_id,
      'from_state', v_ad.match_state), v_correlation_id, nullif(trim(p_reason), ''));
  perform app.match_ad(p_meta_ad_id, v_correlation_id, v_caller.id, nullif(trim(p_reason), ''));
  perform app.refresh_untracked_task(v_correlation_id);

  -- Every resolution goes on the ad's match history, even one that leaves its state as it was (kept out again).
  if (select match_state from meta.ads where id = p_meta_ad_id) is not distinct from v_ad.match_state then
    insert into meta.ad_match_events (ad_id, from_state, to_state, variant_id, actor_member_id, reason)
    values (v_ad.id, v_ad.match_state, v_ad.match_state, p_variant_id, v_caller.id, coalesce(nullif(trim(p_reason), ''), 'resolved'));
  end if;
  select * into v_ad from meta.ads where id = p_meta_ad_id;
  return app.remember_result(v_caller.id, 'resolve_ad', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_ad.id, 'match_state', v_ad.match_state, 'launch_id', v_ad.launch_id, 'correlation_id', v_correlation_id));
end;
$$;

reset role;

-- Each account's latest published sync, the rows it set aside, failed runs since, match coverage (matched ads of the
-- ads synced, PRD §9), and whether it is stale: more than 12 hours, two missed 6-hourly syncs, since it last
-- published (D-33, D-38; proposed threshold). Only Meta ad accounts sync for now, so staleness is null for the rest.
create view reporting.data_health with (security_invoker = true) as
select a.id as account_id, a.platform, a.name as account_name, a.source, a.currency, a.time_zone,
  last.published_at as last_published_at, last.generation,
  coalesce((last.counts ->> 'quarantined')::integer, 0) as quarantined,
  (select count(*) from ingest.sync_runs f
   where f.account_id = a.id and f.state = 'failed' and f.started_at > coalesce(last.published_at, '-infinity'::timestamptz)) as failed_since,
  (select count(*) from meta.ads m where m.account_id = a.id) as ads_seen,
  (select count(*) from meta.ads m where m.account_id = a.id and m.match_state = 'matched') as ads_matched,
  case when a.platform = 'meta_ad_account' then coalesce(last.published_at < now() - interval '12 hours', true) end as stale
from launch.accounts a
left join lateral (
  select r.published_at, r.generation, r.counts from ingest.sync_runs r
  where r.account_id = a.id and r.state = 'published' order by r.generation desc limit 1
) last on true;

-- The rows syncs set aside, with where they were and why, never their raw payloads.
create view reporting.sync_problems with (security_invoker = true) as
select q.id, r.account_id, r.generation, q.row_locator, q.error, q.resolution, q.created_at
from ingest.quarantine_rows q
join ingest.sync_runs r on r.id = q.run_id;

grant select on reporting.data_health, reporting.sync_problems to authenticated;
grant execute on function api.resolve_ad(uuid, uuid, text, uuid) to authenticated;
