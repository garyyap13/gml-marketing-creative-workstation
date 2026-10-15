-- The Meta connection, kept raw responses and Meta object history (D-32, D-33; TRD §4.4, §4.5, T-07).
-- The system user's token lives in Supabase Vault; a connection row names the Vault secret and never holds the token.
-- Raw responses are stored with credentials removed, never change, and are never exposed (D-08). Each change to a
-- campaign, ad set or ad's status or setup is appended to its history. Until the Meta connection exists (B3), worker
-- stand-ins record connections and responses, as record_meta_sync does for sync generations.

create table ingest.connections (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('meta_system_user')),
  -- The name of the Vault secret that holds the token: lower-case letters, digits, dots, dashes and underscores, so a
  -- pasted token (which has capitals) can never be stored here by mistake.
  vault_secret_name text not null unique check (vault_secret_name ~ '^[a-z0-9][a-z0-9_.-]{2,100}$'),
  granted_permissions text[] not null default '{}',
  capabilities jsonb not null default '{}'::jsonb check (jsonb_typeof(capabilities) = 'object'),
  authorisation_state text not null default 'connected' check (authorisation_state in ('connected', 'needs_reauthorisation', 'revoked')),
  last_error text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table launch.accounts add column connection_id uuid references ingest.connections (id);
alter table ingest.sync_runs add column connection_id uuid references ingest.connections (id);

create table ingest.raw_responses (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references ingest.sync_runs (id),
  request jsonb not null,
  page_cursor text,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'), -- of the request, cursor and payload
  received_at timestamptz not null default now(),
  payload jsonb not null,
  unique (run_id, checksum) -- a replayed request and page is stored once
);
alter table ingest.quarantine_rows add column raw_response_id uuid references ingest.raw_responses (id);

create table meta.object_history (
  id uuid primary key default gen_random_uuid(),
  object_type text not null check (object_type in ('campaign', 'ad_set', 'ad')),
  object_id uuid not null,
  external_id text not null,
  snapshot jsonb not null,
  observed_at timestamptz not null default clock_timestamp() -- orders changes within one sync
);
create index object_history_by_object on meta.object_history (object_id, observed_at desc);

alter table ingest.connections enable row level security;
alter table ingest.raw_responses enable row level security;
alter table meta.object_history enable row level security;
grant select, insert, update on ingest.connections to api_owner;
grant select, insert on ingest.raw_responses, meta.object_history to api_owner; -- append-only
create policy connections_commands on ingest.connections to api_owner using (true) with check (true);
create policy raw_responses_commands on ingest.raw_responses to api_owner using (true) with check (true);
create policy object_history_commands on meta.object_history to api_owner using (true) with check (true);
grant update (connection_id) on launch.accounts to api_owner;
grant select on meta.object_history to authenticated;
create policy object_history_read on meta.object_history for select to authenticated using ((select app.is_active_member()));
-- Members see a connection's state through data health; the connection rows and raw responses stay internal.

-- Raw responses never change once stored, whoever tries.
create function app.refuse_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows never change', tg_table_name using errcode = 'P0001';
end;
$$;
create trigger raw_responses_immutable before update or delete on ingest.raw_responses for each row execute function app.refuse_change();
create trigger object_history_immutable before update or delete on meta.object_history for each row execute function app.refuse_change();

set role api_owner;

-- Removes credentials from a request or response before it is stored: keys such as access_token, and tokens in
-- query strings, as in the paging links Meta returns.
create function app.without_credentials(p_value jsonb) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'object' then coalesce((
      select jsonb_object_agg(k, app.without_credentials(v)) from jsonb_each(p_value) e(k, v)
      where lower(k) not in ('access_token', 'input_token', 'fb_exchange_token', 'refresh_token', 'id_token', 'appsecret_proof', 'client_secret',
        'token', 'authorization', 'password')), '{}'::jsonb)
    when 'array' then coalesce((select jsonb_agg(app.without_credentials(v) order by n) from jsonb_array_elements(p_value) with ordinality a(v, n)), '[]'::jsonb)
    when 'string' then to_jsonb(app.without_credentials_text(p_value #>> '{}'))
    else p_value end;
$$;

-- Stores one page of a provider response for a run, credentials removed. The same request, cursor and page again
-- returns the stored one.
create function app.record_raw_response(p_run_id uuid, p_request jsonb, p_cursor text, p_payload jsonb) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb := app.without_credentials(p_payload);
  v_request jsonb := app.without_credentials(coalesce(p_request, '{}'::jsonb));
  v_cursor text := app.without_credentials_text(p_cursor);
  v_checksum text := encode(sha256(convert_to(jsonb_build_array(v_request, v_cursor, v_payload)::text, 'UTF8')), 'hex');
  v_id uuid;
begin
  insert into ingest.raw_responses (run_id, request, page_cursor, checksum, payload)
  values (p_run_id, v_request, v_cursor, v_checksum, v_payload)
  on conflict (run_id, checksum) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from ingest.raw_responses where run_id = p_run_id and checksum = v_checksum;
  end if;
  return v_id;
end;
$$;

create function worker.record_raw_response(p_run_id uuid, p_request jsonb, p_cursor text, p_payload jsonb) returns uuid
language sql
security definer
set search_path = ''
as $$
  select app.record_raw_response(p_run_id, p_request, p_cursor, p_payload);
$$;

-- Records the Meta system user connection: the Vault secret's name, the permissions Meta granted and what the accounts
-- support, and which accounts it serves (T-07). A connection recorded again is updated and counts as reconnected.
create function worker.record_meta_connection(p_vault_secret_name text, p_permissions text[], p_capabilities jsonb, p_account_external_ids text[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := set_config('app.correlation_id', gen_random_uuid()::text, true)::uuid;
  v_connection ingest.connections;
begin
  insert into ingest.connections (kind, vault_secret_name, granted_permissions, capabilities)
  values ('meta_system_user', p_vault_secret_name, coalesce(p_permissions, '{}'), coalesce(p_capabilities, '{}'::jsonb))
  on conflict (vault_secret_name) do update
  set granted_permissions = excluded.granted_permissions, capabilities = excluded.capabilities, checked_at = now()
  returning * into v_connection;
  update launch.accounts set connection_id = v_connection.id
  where platform in ('meta_ad_account', 'facebook_page', 'instagram') and external_id = any (coalesce(p_account_external_ids, '{}'))
    and connection_id is distinct from v_connection.id;
  perform app.record_event(null, 'worker', 'connection', v_connection.id, null, 'meta_connection_recorded',
    jsonb_build_object('permissions', to_jsonb(v_connection.granted_permissions), 'accounts', to_jsonb(coalesce(p_account_external_ids, '{}'))), v_correlation_id);
  perform app.set_connection_state(v_connection.id, 'connected', null, v_correlation_id);
  return v_connection.id;
end;
$$;

-- Changes a connection's authorisation state. Losing it (needs reauthorisation, or revoked) asks every active Admin to
-- reconnect; getting it back closes those tasks (T-07). Rate limits are not a state: those jobs just retry.
create function app.set_connection_state(p_connection_id uuid, p_state text, p_error text, p_correlation_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection ingest.connections;
  v_was text;
  v_event uuid;
begin
  if p_state not in ('connected', 'needs_reauthorisation', 'revoked') then
    raise exception 'unknown connection state %', p_state;
  end if;
  select * into v_connection from ingest.connections where id = p_connection_id for update;
  if v_connection.id is null then
    raise exception 'unknown connection %', p_connection_id;
  end if;
  v_was := v_connection.authorisation_state;
  update ingest.connections set authorisation_state = p_state, last_error = left(app.without_credentials_text(p_error), 2000), checked_at = now()
  where id = p_connection_id;
  if p_state <> 'connected' and v_was = 'connected' then
    v_event := app.record_event(null, 'worker', 'connection', p_connection_id, null, 'meta_connection_lost',
      jsonb_build_object('state', p_state, 'error', left(app.without_credentials_text(p_error), 500)), p_correlation_id);
    perform app.notify(v_event, 'reconnect_meta', 'Reconnect the Meta connection: Meta results have stopped syncing', 'connection', p_connection_id,
      array(select id from core.members where is_admin and active and archived_at is null), jsonb_build_object('state', p_state));
  elsif p_state = 'connected' and v_was <> 'connected' then
    perform app.record_event(null, 'worker', 'connection', p_connection_id, null, 'meta_connection_restored', '{}'::jsonb, p_correlation_id);
    perform app.close_tasks('reconnect_meta', p_connection_id);
  end if;
end;
$$;

create function worker.record_connection_state(p_connection_id uuid, p_state text, p_error text) returns void
language sql
security definer
set search_path = ''
as $$
  select app.set_connection_state(p_connection_id, p_state, p_error, set_config('app.correlation_id', gen_random_uuid()::text, true)::uuid);
$$;

-- Appends a campaign's, ad set's or ad's status and setup to its history whenever they change.
create function app.record_object_history() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := case tg_table_name when 'campaigns' then 'campaign' when 'ad_sets' then 'ad_set' else 'ad' end;
  v_row jsonb := to_jsonb(new);
  -- The fields that make up each kind of object's status and setup.
  v_snapshot jsonb := (select jsonb_object_agg(k, v_row -> k) from unnest(case tg_table_name
    when 'campaigns' then array['name', 'objective']
    when 'ad_sets' then array['name', 'campaign_id', 'optimization_goal', 'attribution_setting']
    else array['name', 'effective_status', 'media_id', 'ad_set_id'] end) k);
begin
  if tg_op = 'INSERT' or v_snapshot is distinct from (
      select h.snapshot from meta.object_history h where h.object_id = (v_row ->> 'id')::uuid order by h.observed_at desc, h.id desc limit 1) then
    insert into meta.object_history (object_type, object_id, external_id, snapshot) values (v_type, (v_row ->> 'id')::uuid, v_row ->> 'external_id', v_snapshot);
  end if;
  return new;
end;
$$;

reset role;

create trigger campaigns_history after insert or update on meta.campaigns for each row execute function app.record_object_history();
create trigger ad_sets_history after insert or update on meta.ad_sets for each row execute function app.record_object_history();
create trigger ads_history after insert or update on meta.ads for each row execute function app.record_object_history();

-- Data health also shows whether the account's Meta connection is working (D-38).
create or replace view reporting.data_health with (security_invoker = true) as
select a.id as account_id, a.platform, a.name as account_name, a.source, a.currency, a.time_zone,
  last.published_at as last_published_at, last.generation,
  coalesce((last.counts ->> 'quarantined')::integer, 0) as quarantined,
  (select count(*) from ingest.sync_runs f
   where f.account_id = a.id and f.state = 'failed' and f.started_at > coalesce(last.published_at, '-infinity'::timestamptz)) as failed_since,
  (select count(*) from meta.ads m where m.account_id = a.id) as ads_seen,
  (select count(*) from meta.ads m where m.account_id = a.id and m.match_state = 'matched') as ads_matched,
  case when a.platform = 'meta_ad_account' then coalesce(last.published_at < now() - interval '12 hours', true) end as stale,
  (select c.authorisation_state from ingest.connections c where c.id = a.connection_id) as connection_state
from launch.accounts a
left join lateral (
  select r.published_at, r.generation, r.counts from ingest.sync_runs r
  where r.account_id = a.id and r.state = 'published' order by r.generation desc limit 1
) last on true;
grant select (id, authorisation_state) on ingest.connections to authenticated;
create policy connections_state_read on ingest.connections for select to authenticated using ((select app.is_active_member()));

grant execute on function worker.record_raw_response(uuid, jsonb, text, jsonb), worker.record_meta_connection(text, text[], jsonb, text[]),
  worker.record_connection_state(uuid, text, text) to service_role;
