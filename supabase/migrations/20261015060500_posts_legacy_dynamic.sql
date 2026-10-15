-- Meta posts, Legacy Codes and Dynamic Launches (D-12, D-29–D-31, D-34, D-54, D-58, D-61; TRD §4.2, §4.4, T-14).
-- - meta.posts: a pasted post link queues a job that resolves the post's Meta ID (D-54); the worker records the
--   account's posts and each is tied to the Post Launch with the same link. An Ad built from a Post links to that
--   Post's Launch, and their results are never added together (D-30).
-- - creative.legacy_codes: older codes such as GML-TESTI-0007 match through an alias. The 6-month backfill turns an
--   unknown one into a Legacy Creative with a new code and a live Variant -A (D-34, D-58). Each empty label of a
--   Legacy Creative can be filled once, then locks (D-61).
-- - launch.dynamic_ad_variants: an ad naming several Variants gets a Dynamic Launch listing them. It is still reported
--   at ad level only and kept out of single-Variant results (D-31). Planning a Dynamic Launch in advance is later work.
-- Until the Meta connection exists (B3), worker stand-ins report posts and sync generations.

create table meta.posts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references launch.accounts (id),
  external_id text not null,
  permalink text,
  permalink_key text,
  published_at timestamptz,
  launch_id uuid unique references launch.launches (id), -- a post backs at most one Launch
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (account_id, external_id)
);
create index posts_by_external_id on meta.posts (external_id);
create index posts_by_link on meta.posts (permalink_key);

-- An ad built from a Facebook post carries its story ID; one built from an Instagram post carries the media ID, and
-- may carry both when it also runs on Facebook placements, so both are kept.
alter table meta.ads add column legacy_codes text[] not null default '{}', add column promoted_post_external_id text,
  add column promoted_instagram_media_id text;
alter table launch.launches add column promoted_post_launch_id uuid references launch.launches (id);

create table creative.legacy_codes (
  code text primary key check (code ~ '^[A-Z]{2,10}-[A-Z]{2,12}-[0-9]{1,6}$'),
  creative_id uuid not null references creative.creatives (id),
  variant_id uuid not null references creative.variants (id),
  created_at timestamptz not null default now()
);

-- A Launch's Variants are listed only when it is Dynamic: the key carries the flag, so a listing can't point at an
-- ordinary Launch.
alter table launch.launches add constraint launches_id_dynamic unique (id, is_dynamic);
create table launch.dynamic_ad_variants (
  launch_id uuid not null,
  variant_id uuid not null references creative.variants (id),
  position integer not null check (position >= 1), -- the order the ad's name gives them
  is_dynamic boolean not null default true check (is_dynamic),
  primary key (launch_id, variant_id),
  unique (launch_id, position),
  foreign key (launch_id, is_dynamic) references launch.launches (id, is_dynamic)
);
create index dynamic_ad_variants_by_variant on launch.dynamic_ad_variants (variant_id);

alter table meta.posts enable row level security;
alter table creative.legacy_codes enable row level security;
alter table launch.dynamic_ad_variants enable row level security;
grant select, insert, update on meta.posts to api_owner;
grant select, insert on creative.legacy_codes, launch.dynamic_ad_variants to api_owner;
grant update (raw_response_id) on ingest.quarantine_rows to api_owner;
create policy posts_commands on meta.posts to api_owner using (true) with check (true);
create policy legacy_codes_commands on creative.legacy_codes to api_owner using (true) with check (true);
create policy dynamic_ad_variants_commands on launch.dynamic_ad_variants to api_owner using (true) with check (true);
grant select on meta.posts, creative.legacy_codes, launch.dynamic_ad_variants to authenticated;
create policy posts_read on meta.posts for select to authenticated using ((select app.is_active_member()));
create policy legacy_codes_read on creative.legacy_codes for select to authenticated using ((select app.is_active_member()));
create policy dynamic_ad_variants_read on launch.dynamic_ad_variants for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Creates a Legacy Creative for a Legacy Code first seen during the backfill: no Brief, a new Creative Code, the Legacy
-- Code kept as its alias, and a Variant -A that is live from the start (D-34, D-54, D-58). Until someone else takes it
-- on, the Admin owns it, due the day it was found (proposed, PD-31). Its labels are filled in later (D-61).
create function app.create_legacy_creative(p_code text, p_ad_name text, p_correlation_id uuid) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_creative creative.creatives;
  v_variant creative.variants;
begin
  select id into v_owner from core.members where is_admin and active and archived_at is null order by (auth_user_id is null), created_at limit 1;
  if v_owner is null then
    raise exception 'no active Admin to own the Legacy Creative for %', p_code;
  end if;
  insert into creative.creatives (code, brand, title, is_legacy, creative_owner_id, due_date, last_variant_number)
  values (app.next_creative_code(), (select brand_prefix from core.settings), left(coalesce(nullif(trim(regexp_replace(p_ad_name, '\s+', ' ', 'g')), ''), p_code), 200), true, v_owner,
    app.team_today(), 1)
  returning * into v_creative;
  insert into creative.variants (creative_id, letter, code) values (v_creative.id, 'A', v_creative.code || '-A') returning * into v_variant;
  insert into creative.legacy_codes (code, creative_id, variant_id) values (p_code, v_creative.id, v_variant.id);
  perform app.record_event(null, 'worker', 'creative', v_creative.id, v_creative.lock_version, 'legacy_creative_created',
    jsonb_build_object('code', v_creative.code, 'legacy_code', p_code, 'variant_code', v_variant.code), p_correlation_id);
  perform app.go_live(v_variant.id);
  return v_variant.id;
end;
$$;

-- Whether a Variant is the one a Legacy Code created: its ads predate the workstation's approvals (proposed, PD-31).
-- Variants added to a Legacy Creative later are made and approved in the workstation like any other.
create function app.is_legacy_variant(p_variant_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from creative.legacy_codes where variant_id = p_variant_id);
$$;

-- Why a Variant shown in an ad counts as shown without an approval in effect: its latest Version was never approved,
-- or the approval was withdrawn or superseded; null when it is in effect, or for a Legacy Code's Variant (D-54, PD-31).
create function app.variant_approval_flag(p_variant_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when app.is_legacy_variant(v.id) then null when lv.id is null then 'never_approved' else nullif(app.approval_state(lv.id), 'in_effect') end
  from creative.variants v
  left join lateral (select id from creative.versions where variant_id = v.id order by version_number desc limit 1) lv on true
  where v.id = p_variant_id;
$$;

-- Locks a Launch's Creatives, Variants and the Launch itself, in the lock order. A Dynamic Launch locks every Variant it
-- lists, Creatives first, each in id order (as in 20261013060000_launches.sql for an ordinary Launch).
create or replace function app.lock_launch(p_launch_id uuid) returns launch.launches
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_launch launch.launches;
  v_variants uuid[] := array(
    select variant_id from launch.launches where id = p_launch_id
    union select variant_id from launch.dynamic_ad_variants where launch_id = p_launch_id);
begin
  perform 1 from creative.creatives c where c.id in (select creative_id from creative.variants where id = any (v_variants)) order by c.id for update;
  perform 1 from creative.variants v where v.id = any (v_variants) order by v.id for update;
  select * into v_launch from launch.launches where id = p_launch_id for update;
  return v_launch;
end;
$$;

-- Refreshes the liveness of every Variant a Launch carries: its own, and a Dynamic Launch's listed ones (D-54). The
-- caller holds their locks.
create function app.refresh_launch_liveness(p_launch_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variant uuid;
begin
  for v_variant in
    select variant_id from launch.launches where id = p_launch_id
    union select variant_id from launch.dynamic_ad_variants where launch_id = p_launch_id
    order by 1
  loop
    perform app.refresh_liveness(v_variant);
  end loop;
end;
$$;

-- Stand-in for the post-ID job until the Meta connection (B3): records a Page's or Instagram account's posts as the
-- Graph API lists them (id, permalink_url or permalink, created_time or timestamp), ties each to the Post Launch on
-- that account with the same normalised link, finishes those Launches' jobs, and links Ads that promote them (D-30,
-- D-54). B3 must check that the link people paste normalises to the permalink Meta reports.
create function worker.record_meta_posts(p_account_external_id text, p_posts jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := set_config('app.correlation_id', gen_random_uuid()::text, true)::uuid;
  v_account launch.accounts;
  v_post meta.posts;
  v_linked integer := 0;
begin
  select * into v_account from launch.accounts where platform in ('facebook_page', 'instagram') and external_id = p_account_external_id;
  if v_account.id is null then
    raise exception 'unknown Page or Instagram account %', p_account_external_id;
  end if;
  -- Takes turns with matching, which also links promoted Posts to Launches.
  perform pg_advisory_xact_lock(hashtextextended('match_ads', 0));
  insert into meta.posts (account_id, external_id, permalink, permalink_key, published_at)
  select v_account.id, p ->> 'id', coalesce(p ->> 'permalink_url', p ->> 'permalink'), app.post_link_key(coalesce(p ->> 'permalink_url', p ->> 'permalink')),
    case when coalesce(p ->> 'created_time', p ->> 'timestamp') ~ '^[0-9]+$' then to_timestamp(coalesce(p ->> 'created_time', p ->> 'timestamp')::bigint)
      when pg_input_is_valid(coalesce(p ->> 'created_time', p ->> 'timestamp'), 'timestamptz') then coalesce(p ->> 'created_time', p ->> 'timestamp')::timestamptz end
  from jsonb_array_elements(coalesce(p_posts, '[]'::jsonb)) p
  where coalesce(p ->> 'id', '') <> ''
  on conflict (account_id, external_id) do update
  set permalink = coalesce(excluded.permalink, meta.posts.permalink), permalink_key = coalesce(excluded.permalink_key, meta.posts.permalink_key),
    published_at = coalesce(excluded.published_at, meta.posts.published_at), last_seen_at = now();

  -- One post per Launch: should two posts share a link, the earliest published is taken.
  for v_post in
    update meta.posts p set launch_id = m.launch_id
    from (
      select distinct on (l.id) l.id as launch_id, q.id as post_id
      from launch.launches l join meta.posts q on q.account_id = v_account.id and q.permalink_key = l.post_link_key
      where l.kind = 'post' and l.account_id = v_account.id and q.launch_id is null and q.permalink_key is not null
        and not exists (select 1 from meta.posts r where r.launch_id = l.id)
      order by l.id, q.published_at nulls last, q.id
    ) m
    where p.id = m.post_id
    returning p.*
  loop
    v_linked := v_linked + 1;
    perform app.record_event(null, 'worker', 'launch', v_post.launch_id, null, 'post_resolved',
      jsonb_build_object('meta_post_id', v_post.external_id, 'permalink', v_post.permalink), v_correlation_id);
    update work.jobs set state = 'done', lease_until = null, finished_at = now(), last_error = null
    where type = 'resolve_post' and dedupe_key = v_post.launch_id::text and state in ('queued', 'running');
  end loop;

  update launch.launches l set promoted_post_launch_id = p.launch_id
  from meta.ads a join meta.posts p on p.external_id in (a.promoted_post_external_id, a.promoted_instagram_media_id)
  where a.launch_id = l.id and p.account_id = v_account.id and p.launch_id is not null and l.promoted_post_launch_id is distinct from p.launch_id;

  return jsonb_build_object('posts', jsonb_array_length(coalesce(p_posts, '[]'::jsonb)), 'linked', v_linked);
end;
$$;


-- worker.record_meta_sync, as in 20261013060200_results.sql, except that it keeps the raw response, takes the run's kind
-- from the payload (a backfill creates Legacy Creatives), records the connection, and reads Legacy Codes and promoted posts.
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

-- app.match_ad, as in 20261014100000_ad_resolution.sql, plus Legacy Codes, Dynamic Launches and promoted Posts (T-14 steps 1, 3, 4, 6).
create or replace function app.match_ad(p_ad_id uuid, p_correlation_id uuid, p_actor uuid default null, p_reason text default null) returns void
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
  v_members uuid[] := '{}'::uuid[];
  v_member uuid;
  v_legacy text;
  v_post_launch uuid;
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
      v_state := 'dynamic'; -- several Variants in one ad: reported at ad level only, on a Launch listing them (D-31, D-58)
    elsif cardinality(v_codes) = 1 then
      perform 1 from creative.creatives c join creative.variants v on v.creative_id = c.id where v.code = v_codes[1] for update of c;
      select * into v_variant from creative.variants where code = v_codes[1] for update;
      v_state := case when v_variant.id is null then 'untracked' else 'matched' end;
    elsif cardinality(v_ad.legacy_codes) = 1 then
      -- A Legacy Code matches through its alias. During the backfill an unknown one creates a Legacy Creative with a
      -- new code and a Variant -A that is live from the start (D-34, D-54, D-58); at other syncs it stays Untracked.
      v_legacy := v_ad.legacy_codes[1];
      if not exists (select 1 from creative.legacy_codes where code = v_legacy)
          and (select kind from ingest.sync_runs where id = v_ad.last_seen_run_id) = 'backfill' then
        perform app.create_legacy_creative(v_legacy, v_ad.name, p_correlation_id);
      end if;
      perform 1 from creative.creatives c join creative.variants v on v.creative_id = c.id
        join creative.legacy_codes lc on lc.variant_id = v.id where lc.code = v_legacy for update of c;
      select v.* into v_variant from creative.variants v join creative.legacy_codes lc on lc.variant_id = v.id where lc.code = v_legacy for update of v;
      v_state := case when v_variant.id is null then 'untracked' else 'matched' end;
    else
      v_state := 'untracked';
      select c.id into v_suggested from creative.creatives c where c.code = any (v_ad.parsed_codes) limit 1;
    end if;

    -- An ad backing a Dynamic Launch stays Dynamic, whatever its name now says: the Launch lists its Variants (D-58).
    if v_ad.launch_id is not null and coalesce((select is_dynamic from launch.launches where id = v_ad.launch_id), false) then
      v_state := 'dynamic';
      v_variant := null;
    end if;

    -- An ad already backing a Launch was renamed to another Variant's code, to no code or to several: it stays with
    -- that Launch, flagged as Mismatched against the Launch's Variant.
    if v_ad.launch_id is not null and not coalesce((select is_dynamic from launch.launches where id = v_ad.launch_id), false) and (v_state in ('untracked', 'dynamic')
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
      -- A Legacy Code's Variant predates approvals in the workstation, so its ads are not flagged (proposed, PD-31).
      v_flag := case when app.is_legacy_variant(v_variant.id) then null
        when v_launch.version_id is null then 'never_approved' else nullif(app.approval_state(v_launch.version_id), 'in_effect') end;
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

  if v_state = 'dynamic' then
    -- The Variants the ad names, in the order named; codes no Variant has are left out. A Dynamic Launch lists them
    -- once, when it is created (D-58).
    if v_ad.launch_id is not null then
      v_members := array(select variant_id from launch.dynamic_ad_variants where launch_id = v_ad.launch_id order by position);
    else
      v_members := array(select v.id from unnest(v_codes) with ordinality c(code, n) join creative.variants v on v.code = c.code order by c.n);
    end if;
    -- Lock order: every Creative, then every Variant, then the Launch.
    perform 1 from creative.creatives c where c.id in (select creative_id from creative.variants where id = any (v_members)) order by c.id for update;
    perform 1 from creative.variants v where v.id = any (v_members) order by v.id for update;
    if v_ad.launch_id is not null then
      select * into v_launch from launch.launches where id = v_ad.launch_id for update;
    elsif cardinality(v_members) > 0 and (v_running or v_gone) then
      select id into v_version_id from creative.versions where variant_id = v_members[1] order by version_number desc limit 1;
      insert into launch.launches (kind, variant_id, version_id, status, origin, account_id, campaign_name, campaign_external_id,
        ad_set_name, ad_set_external_id, ad_name, utm_content, is_dynamic)
      values ('ad', v_members[1], v_version_id, 'planned', 'unplanned', v_ad.account_id,
        (select name from meta.campaigns where id = v_ad_set.campaign_id), (select external_id from meta.campaigns where id = v_ad_set.campaign_id),
        v_ad_set.name, coalesce(v_ad_set.external_id, v_ad.adset_external_id), v_ad.name, array_to_string(v_codes, ','), true)
      returning * into v_launch;
      insert into launch.dynamic_ad_variants (launch_id, variant_id, position) select v_launch.id, m, n from unnest(v_members) with ordinality u(m, n);
    end if;
    -- A Dynamic Ad that has been shown puts each of its Variants live (proposed, PD-32); each shown without an
    -- approval in effect is flagged, and the Launch carries the first such flag (D-54).
    if v_launch.id is not null and v_launch.status = 'planned' and (v_running or v_gone) then
      select f into v_flag from unnest(v_members) with ordinality m(id, n) cross join lateral app.variant_approval_flag(m.id) f
      where f is not null order by m.n limit 1;
      update launch.launches set status = 'live', live_at = coalesce(live_at, now()), approval_flag = v_flag, lock_version = lock_version + 1
      where id = v_launch.id
      returning * into v_launch;
      foreach v_member in array v_members loop
        perform app.go_live(v_member);
        if app.variant_approval_flag(v_member) is not null then
          update creative.variants set live_without_approval = true where id = v_member;
        end if;
      end loop;
      perform app.record_event(null, 'worker', 'launch', v_launch.id, v_launch.lock_version, 'ad_live',
        jsonb_build_object('variant_ids', to_jsonb(v_members), 'meta_ad_id', v_ad.external_id, 'approval_flag', v_flag, 'dynamic', true), p_correlation_id);
    end if;
  end if;

  -- 4. Promoted Post: an Ad built from a Post that backs a Post Launch links to that Launch; their results are never
  -- added together (D-30).
  if v_launch.id is not null and coalesce(v_ad.promoted_post_external_id, v_ad.promoted_instagram_media_id) is not null then
    select p.launch_id into v_post_launch from meta.posts p
    where p.external_id in (v_ad.promoted_post_external_id, v_ad.promoted_instagram_media_id) and p.launch_id is not null limit 1;
    if v_post_launch is not null then
      update launch.launches set promoted_post_launch_id = v_post_launch where id = v_launch.id and promoted_post_launch_id is distinct from v_post_launch;
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
      -- A Dynamic Launch's Variants were locked above, with the Launch.
      perform app.refresh_launch_liveness(v_launch.id);
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
      -- A Legacy Creative has no Brief, so its owner hears instead.
      array[coalesce((select b.marketing_owner_id from creative.creatives c join brief.brief_versions bv on bv.id = c.brief_version_id
             join brief.briefs b on b.id = bv.brief_id where c.id = v_variant.creative_id),
             (select c.creative_owner_id from creative.creatives c where c.id = v_variant.creative_id))],
      jsonb_build_object('variant_code', v_variant.code, 'ad_name', v_ad.name));
  elsif v_state <> 'mismatched' and v_ad.match_state = 'mismatched' then
    perform app.close_tasks('ad_mismatched', v_ad.id);
  end if;
  -- A Mismatched or kept-out ad keeps any Launch it already backed, but its results stay out (T-14).
  update meta.ads
  set match_state = v_state, variant_id = v_variant.id, suggested_creative_id = v_suggested,
    launch_id = case when v_state = 'matched' then v_launch.id when v_state = 'dynamic' then coalesce(v_launch.id, launch_id)
      when v_state in ('mismatched', 'kept_out') then launch_id end
  where id = v_ad.id;
end;
$$;

-- app.refresh_liveness, as in 20261013060000_launches.sql, counting a Variant's Dynamic Launches too.
create or replace function app.refresh_liveness(p_variant_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active boolean := exists (
    select 1 from launch.launches l where l.status in ('planned', 'live')
      and (l.variant_id = p_variant_id or exists (select 1 from launch.dynamic_ad_variants d where d.launch_id = l.id and d.variant_id = p_variant_id)));
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

-- api.end_launch and api.cancel_launch, as in 20261013060000_launches.sql, refreshing every Variant the Launch carries.
create or replace function api.end_launch(p_launch_id uuid, p_expected_lock_version integer) returns jsonb
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
  perform app.refresh_launch_liveness(v_launch.id);
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'launch_ended',
    jsonb_build_object('variant_id', v_launch.variant_id), v_correlation_id);
  return jsonb_build_object('id', v_launch.id, 'status', v_launch.status, 'lock_version', v_launch.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

create or replace function api.cancel_launch(p_launch_id uuid, p_reason text, p_expected_lock_version integer) returns jsonb
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
  perform app.refresh_launch_liveness(v_launch.id);
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'launch_cancelled',
    jsonb_build_object('variant_id', v_launch.variant_id, 'reason', v_launch.cancel_reason), v_correlation_id);
  return jsonb_build_object('id', v_launch.id, 'status', v_launch.status, 'lock_version', v_launch.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- api.confirm_post_live, as in 20261013060000_launches.sql, plus the job that resolves the post ID.
create or replace function api.confirm_post_live(p_launch_id uuid, p_post_link text, p_expected_lock_version integer, p_idempotency_key uuid)
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
  -- The Meta worker resolves the post ID in the background from the Page or Instagram account (D-54).
  if (select platform from launch.accounts where id = v_launch.account_id) in ('facebook_page', 'instagram') then
    perform app.enqueue_job('resolve_post', jsonb_build_object('launch_id', v_launch.id, 'post_link', v_launch.post_link), v_launch.id::text);
  end if;
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'post_live',
    jsonb_build_object('variant_id', v_launch.variant_id, 'post_link', v_launch.post_link), v_correlation_id);

  return app.remember_result(v_caller.id, 'confirm_post_live', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_launch.id, 'status', v_launch.status, 'lock_version', v_launch.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- api.set_creative_labels, api.confirm_format and api.set_variant_labels, as in 20261012070300_creatives.sql and
-- 20261012070500_variants.sql, except for the Legacy fill-once rule (D-61).
create or replace function api.set_creative_labels(p_creative_id uuid, p_narrative_style_id uuid, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_creative creative.creatives;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  if not app.is_label(p_narrative_style_id::text, 'narrative_style') or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'narrative_style_id', case when not app.is_label(p_narrative_style_id::text, 'narrative_style') then 'Choose a Narrative Style' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;

  select * into v_creative from creative.creatives where id = p_creative_id for update;
  if v_creative.id is null or v_creative.archived_at is not null then
    perform app.fail('not_found');
  end if;
  if v_creative.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_creative.lock_version));
  end if;
  -- Locked after go-live, except that a Legacy Creative's empty label can be filled once (D-61).
  if v_creative.first_live_at is not null and not (v_creative.is_legacy and v_creative.narrative_style_id is null) then
    perform app.fail('conflict', jsonb_build_object('reason', 'labels_locked_after_go_live'));
  end if;

  update creative.creatives set narrative_style_id = p_narrative_style_id, lock_version = lock_version + 1
  where id = p_creative_id
  returning * into v_creative;

  perform app.record_event(v_caller.id, 'member', 'creative', v_creative.id, v_creative.lock_version, 'creative_labels_set',
    jsonb_build_object('narrative_style_id', p_narrative_style_id), v_correlation_id);

  return jsonb_build_object('id', v_creative.id, 'lock_version', v_creative.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

create or replace function api.confirm_format(p_creative_id uuid, p_format_id uuid, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_creative creative.creatives;
  v_new_kind text;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if p_format_id is null or not app.is_label(p_format_id::text, 'format') or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'format_id', case when p_format_id is null or not app.is_label(p_format_id::text, 'format') then 'Choose a Format' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;

  select * into v_creative from creative.creatives where id = p_creative_id for update;
  if v_creative.id is null or v_creative.archived_at is not null then
    perform app.fail('not_found');
  end if;
  if v_creative.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_creative.lock_version));
  end if;
  -- Locked after go-live, except that a Legacy Creative's empty Format can be filled once (D-61).
  if v_creative.first_live_at is not null and not (v_creative.is_legacy and v_creative.format_id is null) then
    perform app.fail('conflict', jsonb_build_object('reason', 'labels_locked_after_go_live'));
  end if;
  -- A different Format is a different Creative (D-10), so the Format freezes once any Version exists.
  if v_creative.format_id is distinct from p_format_id and exists (
    select 1 from creative.versions vs join creative.variants va on va.id = vs.variant_id
    where va.creative_id = p_creative_id) then
    perform app.fail('conflict', jsonb_build_object('reason', 'format_fixed_after_first_version'));
  end if;
  v_new_kind := (select media_kind from label.items where id = p_format_id);
  if v_new_kind <> 'video' and exists (
    select 1 from creative.variants where creative_id = p_creative_id and hook_type_id is not null) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('format_id', 'Remove the Hook type from this Creative''s Variants first')));
  end if;

  -- Variants move to the first stage of the new Format's track unless already on it (D-18).
  update creative.variants
  set production_stage = (app.production_stages(v_new_kind))[1], lock_version = lock_version + 1
  where creative_id = p_creative_id
    and (production_stage is null or not production_stage = any (app.production_stages(v_new_kind)));

  update creative.creatives
  set format_id = p_format_id, format_confirmed_by = v_caller.id, format_confirmed_at = now(),
      lock_version = lock_version + 1
  where id = p_creative_id
  returning * into v_creative;

  perform app.record_event(v_caller.id, 'member', 'creative', v_creative.id, v_creative.lock_version, 'format_confirmed',
    jsonb_build_object('format_id', p_format_id), v_correlation_id);

  return jsonb_build_object('id', v_creative.id, 'lock_version', v_creative.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

create or replace function api.set_variant_labels(p_variant_id uuid, p_labels jsonb, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_variant creative.variants;
  v_errors jsonb;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;

  select * into v_variant from creative.variants where id = p_variant_id for update;
  if v_variant.id is null then
    perform app.fail('not_found');
  end if;
  v_errors := app.variant_label_errors(p_labels, app.format_media_kind(v_variant.creative_id));
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  if v_variant.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_variant.lock_version));
  end if;
  -- Locked after go-live, except that each empty label of a Legacy Creative's Variant can be filled once (D-61).
  if exists (select 1 from creative.creatives where id = v_variant.creative_id and first_live_at is not null)
      and not ((select is_legacy from creative.creatives where id = v_variant.creative_id) and not exists (
        select 1 from jsonb_object_keys(p_labels) k
        where to_jsonb(v_variant) ->> k is not null and (p_labels ->> k) is distinct from (to_jsonb(v_variant) ->> k))) then
    perform app.fail('conflict', jsonb_build_object('reason', 'labels_locked_after_go_live'));
  end if;

  -- A Legacy Creative's Hook type waits for its Format, since only video Variants have one and a filled label can't be
  -- cleared again (D-61).
  if p_labels ->> 'hook_type_id' is not null and app.format_media_kind(v_variant.creative_id) is null
      and (select is_legacy from creative.creatives where id = v_variant.creative_id) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('hook_type_id',
      'Confirm the Creative''s Format first: only video Variants have a Hook type')));
  end if;

  update creative.variants set
    hook_type_id = case when p_labels ? 'hook_type_id' then (p_labels ->> 'hook_type_id')::uuid else hook_type_id end,
    length_id = case when p_labels ? 'length_id' then (p_labels ->> 'length_id')::uuid else length_id end,
    aspect_ratio_id = case when p_labels ? 'aspect_ratio_id' then (p_labels ->> 'aspect_ratio_id')::uuid else aspect_ratio_id end,
    lock_version = lock_version + 1
  where id = p_variant_id
  returning * into v_variant;

  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'variant_labels_set',
    jsonb_build_object('labels', p_labels), v_correlation_id);

  return jsonb_build_object('id', v_variant.id, 'lock_version', v_variant.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

reset role;

-- Post Launches on a Facebook Page or Instagram account whose post ID isn't known yet, with the state of the job
-- resolving it (D-54). Data health lists them.
create view reporting.unresolved_posts with (security_invoker = true) as
select l.id as launch_id, l.variant_id, va.code as variant_code, ac.platform, ac.name as account_name, l.post_link, l.live_at,
  j.state as job_state, j.attempts as job_attempts, j.last_error
from launch.launches l
join launch.accounts ac on ac.id = l.account_id
join creative.variants va on va.id = l.variant_id
left join lateral (
  select jb.state, jb.attempts, jb.last_error from work.jobs jb where jb.type = 'resolve_post' and jb.dedupe_key = l.id::text order by jb.created_at desc limit 1
) j on true
where l.kind = 'post' and l.status in ('live', 'ended') and ac.platform in ('facebook_page', 'instagram')
  and not exists (select 1 from meta.posts p where p.launch_id = l.id);
grant select on reporting.unresolved_posts to authenticated;

-- Post Launches already live before this migration get their lookup queued too.
select app.enqueue_job('resolve_post', jsonb_build_object('launch_id', l.id, 'post_link', l.post_link), l.id::text)
from launch.launches l join launch.accounts a on a.id = l.account_id
where l.kind = 'post' and l.status in ('live', 'ended') and l.post_link is not null and a.platform in ('facebook_page', 'instagram')
  and not exists (select 1 from meta.posts p where p.launch_id = l.id);

grant execute on function worker.record_meta_posts(text, jsonb) to service_role;
