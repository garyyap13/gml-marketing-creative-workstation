-- A0 foundations: schemas, roles, access rules and the shared command pattern (TRD T-01–T-04, T-09, T-10).

create schema api;    -- domain commands called through RPC (exposed)
create schema core;   -- members and settings (exposed, read-only to members)
create schema audit;  -- activity log (exposed, read-only to members)
create schema work;   -- tasks, delivery queue, idempotency keys (exposed, read-only to members)
create schema app;    -- private helpers for command functions (never exposed)
create schema ingest; -- raw provider data (never exposed, D-08)

-- Command functions run as this non-login role. It owns no tables and does not bypass RLS,
-- so every table it writes grants it an explicit policy (T-04, T-09).
create role api_owner nologin;
grant api_owner to postgres;
grant usage on schema core, audit, work, app to api_owner;
grant create on schema api, app to api_owner; -- needed to own the functions there

revoke all on schema api, app from public;
grant usage on schema api to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Errors: a stable code as the message; the PTnnn SQLSTATE becomes the HTTP status (T-04). The JSON
-- detail always carries the command's correlation id.

-- First step of every command: starts the correlation id that its errors and activity-log events share.
create function app.begin_command() returns uuid
language sql
set search_path = ''
as $$
  select set_config('app.correlation_id', gen_random_uuid()::text, true)::uuid;
$$;
alter function app.begin_command() owner to api_owner;

create function app.fail(p_code text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_errcode text := case p_code
    when 'unauthenticated' then 'PT401'
    when 'forbidden' then 'PT403'
    when 'not_found' then 'PT404'
    when 'conflict' then 'PT409'
    when 'invalid' then 'PT422'
    when 'throttled' then 'PT429'
  end;
begin
  if v_errcode is null then
    raise exception 'app.fail: unknown error code %', p_code;
  end if;
  raise exception using
    errcode = v_errcode,
    message = p_code,
    detail = jsonb_strip_nulls(
      jsonb_build_object('correlationId', nullif(current_setting('app.correlation_id', true), '')) || p_detail
    )::text;
end;
$$;
alter function app.fail(text, jsonb) owner to api_owner;

-- ---------------------------------------------------------------------------------------------
-- Caller identity, from the verified Supabase Auth JWT (T-03 step 1). Reads the request claims the
-- same way auth.uid() does, so command functions need no grants on the auth schema.

create function app.caller_id() returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
$$;
alter function app.caller_id() owner to api_owner;

create function app.caller_email() returns text
language sql
stable
set search_path = ''
as $$
  select lower(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email');
$$;
alter function app.caller_email() owner to api_owner;

-- ---------------------------------------------------------------------------------------------
-- Members (D-03, D-49, D-70). A member is invited by email and linked to a sign-in on acceptance.

create table core.members (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id),
  email text not null,
  display_name text not null,
  team text not null check (team in ('marketing', 'creative')),
  is_approver boolean not null default false,
  is_admin boolean not null default false,
  whatsapp_number text,
  whatsapp_opt_in_at timestamptz,
  active boolean not null default true,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  lock_version integer not null default 0,
  constraint members_approver_is_marketing check (not is_approver or team = 'marketing')
);
create unique index members_email_key on core.members (lower(email));

alter table core.members enable row level security;
grant select, insert, update on core.members to api_owner;
create policy members_commands on core.members to api_owner using (true) with check (true);

-- The active member behind the current sign-in, or null.
create function app.signed_in_member() returns core.members
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
  from core.members m
  where m.auth_user_id = (select app.caller_id()) and m.active and m.archived_at is null;
$$;
alter function app.signed_in_member() owner to api_owner;

create function app.is_active_member() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (app.signed_in_member()).id is not null;
$$;
alter function app.is_active_member() owner to api_owner;

-- T-03 step 1: every command starts here. Identity, team and flags never come from arguments.
create function app.require_member() returns core.members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member core.members := app.signed_in_member();
begin
  if v_member.id is null then
    perform app.fail('unauthenticated');
  end if;
  return v_member;
end;
$$;
alter function app.require_member() owner to api_owner;

grant usage on schema core, app to authenticated;
grant select on core.members to authenticated;
create policy members_read on core.members for select to authenticated using ((select app.is_active_member()));

-- ---------------------------------------------------------------------------------------------
-- Activity log (D-45, T-10): append-only, written in the same transaction as the command's changes.

create table audit.activity_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default clock_timestamp(),
  actor_member_id uuid references core.members (id),
  actor_kind text not null check (actor_kind in ('member', 'operator', 'worker', 'system')),
  entity_type text not null,
  entity_id uuid not null,
  entity_version integer,
  action text not null,
  reason text,
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid not null,
  constraint activity_member_actor check ((actor_kind = 'member') = (actor_member_id is not null))
);
create index activity_log_entity_idx on audit.activity_log (entity_id, occurred_at);

alter table audit.activity_log enable row level security;
grant insert on audit.activity_log to api_owner;
create policy activity_log_commands on audit.activity_log for insert to api_owner with check (true);
grant usage on schema audit to authenticated;
grant select on audit.activity_log to authenticated;
create policy activity_log_read on audit.activity_log for select to authenticated using ((select app.is_active_member()));

create function app.record_event(
  p_actor_member_id uuid,
  p_actor_kind text,
  p_entity_type text,
  p_entity_id uuid,
  p_entity_version integer,
  p_action text,
  p_payload jsonb,
  p_correlation_id uuid,
  p_reason text default null
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into audit.activity_log
    (actor_member_id, actor_kind, entity_type, entity_id, entity_version, action, reason, payload, correlation_id)
  values
    (p_actor_member_id, p_actor_kind, p_entity_type, p_entity_id, p_entity_version, p_action, p_reason, p_payload, p_correlation_id);
$$;
alter function app.record_event(uuid, text, text, uuid, integer, text, jsonb, uuid, text) owner to api_owner;

-- ---------------------------------------------------------------------------------------------
-- Idempotency (T-03 step 4): the same key and request return the stored result; the same key with a
-- different request is a conflict. Results are kept at least 30 days.

create table work.idempotency_keys (
  actor_member_id uuid not null references core.members (id),
  command text not null,
  key uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  primary key (actor_member_id, command, key)
);

alter table work.idempotency_keys enable row level security;
grant select, insert on work.idempotency_keys to api_owner;
create policy idempotency_keys_commands on work.idempotency_keys to api_owner using (true) with check (true);

-- The stored result for a repeated request, or null for a new one. Serialises concurrent requests
-- that share a key, so the second waits and then replays the first.
create function app.replayed_result(p_actor_member_id uuid, p_command text, p_key uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stored work.idempotency_keys;
begin
  if p_key is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('idempotency_key', 'Required')));
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_actor_member_id::text || '/' || p_command || '/' || p_key::text, 0));

  select * into v_stored
  from work.idempotency_keys
  where actor_member_id = p_actor_member_id and command = p_command and key = p_key;

  if v_stored.key is null then
    return null;
  end if;
  if v_stored.request_hash <> encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex') then
    perform app.fail('conflict', jsonb_build_object(
      'fieldErrors', jsonb_build_object('idempotency_key', 'Already used for a different request')));
  end if;
  return v_stored.result;
end;
$$;
alter function app.replayed_result(uuid, text, uuid, jsonb) owner to api_owner;

create function app.remember_result(p_actor_member_id uuid, p_command text, p_key uuid, p_request jsonb, p_result jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  insert into work.idempotency_keys (actor_member_id, command, key, request_hash, result)
  values (p_actor_member_id, p_command, p_key, encode(sha256(convert_to(p_request::text, 'UTF8')), 'hex'), p_result);
  select p_result;
$$;
alter function app.remember_result(uuid, text, uuid, jsonb, jsonb) owner to api_owner;

-- ---------------------------------------------------------------------------------------------
-- Commands. Each follows T-03 inside its RPC transaction: begin (correlation id) → identify →
-- authorise → validate → idempotency → lock → preconditions → write + activity-log event.

-- Operator-only: creates the first Admin, once (D-49).
create function api.bootstrap_admin(p_email text, p_display_name text, p_team text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_member core.members;
begin
  -- Serialise concurrent operator calls so only one first Admin can be created.
  perform pg_advisory_xact_lock(hashtextextended('api.bootstrap_admin', 0));
  if exists (select 1 from core.members where is_admin) then
    perform app.fail('conflict');
  end if;

  insert into core.members (email, display_name, team, is_admin)
  values (lower(trim(p_email)), trim(p_display_name), p_team, true)
  returning * into v_member;

  perform app.record_event(null, 'operator', 'member', v_member.id, v_member.lock_version, 'admin_bootstrapped',
    jsonb_build_object('email', v_member.email, 'team', v_member.team), v_correlation_id);

  return jsonb_build_object('id', v_member.id, 'lock_version', v_member.lock_version, 'correlation_id', v_correlation_id);
end;
$$;
alter function api.bootstrap_admin(text, text, text) owner to api_owner;

-- Links the signed-in user to the invitation for the email address in their verified sign-in token
-- (D-70). Safe to repeat: someone already linked gets their member record back.
create function api.accept_invitation() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_member core.members;
begin
  if (select app.caller_id()) is null then
    perform app.fail('unauthenticated');
  end if;

  v_member := app.signed_in_member();
  if v_member.id is null then
    update core.members
    set auth_user_id = (select app.caller_id()), lock_version = lock_version + 1
    where lower(email) = (select app.caller_email())
      and auth_user_id is null and active and archived_at is null
    returning * into v_member;

    if v_member.id is not null then
      perform app.record_event(v_member.id, 'member', 'member', v_member.id, v_member.lock_version,
        'invitation_accepted', '{}'::jsonb, v_correlation_id);
    else
      -- A simultaneous call may have just linked this person; that call has committed by now.
      v_member := app.signed_in_member();
      if v_member.id is null then
        perform app.fail('unauthenticated');
      end if;
    end if;
  end if;

  return jsonb_build_object('id', v_member.id, 'lock_version', v_member.lock_version, 'correlation_id', v_correlation_id);
end;
$$;
alter function api.accept_invitation() owner to api_owner;

-- Admin-only: invites a member by email (D-49, D-70).
create function api.invite_member(
  p_email text,
  p_display_name text,
  p_team text,
  p_is_approver boolean,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_errors jsonb := '{}'::jsonb;
  v_request jsonb := jsonb_build_object(
    'email', p_email, 'display_name', p_display_name, 'team', p_team, 'is_approver', p_is_approver);
  v_replayed jsonb;
  v_member core.members;
begin
  if not v_caller.is_admin then
    perform app.fail('forbidden');
  end if;

  if coalesce(trim(p_email), '') !~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    v_errors := v_errors || jsonb_build_object('email', 'Enter an email address');
  end if;
  if coalesce(trim(p_display_name), '') = '' then
    v_errors := v_errors || jsonb_build_object('display_name', 'Enter a name');
  end if;
  if p_team is null or p_team not in ('marketing', 'creative') then
    v_errors := v_errors || jsonb_build_object('team', 'Choose marketing or creative');
  elsif coalesce(p_is_approver, false) and p_team <> 'marketing' then
    v_errors := v_errors || jsonb_build_object('is_approver', 'Only Marketing Team members can be Approvers');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'invite_member', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  -- One member per email address. ON CONFLICT also covers a simultaneous invitation of the same address.
  insert into core.members (email, display_name, team, is_approver)
  values (lower(trim(p_email)), trim(p_display_name), p_team, coalesce(p_is_approver, false))
  on conflict ((lower(email))) do nothing
  returning * into v_member;
  if v_member.id is null then
    perform app.fail('conflict', jsonb_build_object(
      'fieldErrors', jsonb_build_object('email', 'This person is already a member or invited')));
  end if;

  perform app.record_event(v_caller.id, 'member', 'member', v_member.id, v_member.lock_version, 'member_invited',
    jsonb_build_object('email', v_member.email, 'team', v_member.team, 'is_approver', v_member.is_approver),
    v_correlation_id);

  return app.remember_result(v_caller.id, 'invite_member', p_idempotency_key, v_request,
    jsonb_build_object('id', v_member.id, 'lock_version', v_member.lock_version, 'correlation_id', v_correlation_id));
end;
$$;
alter function api.invite_member(text, text, text, boolean, uuid) owner to api_owner;

-- Admin-only: changes a member's name, team, flags or active state (D-49).
create function api.update_member(p_member_id uuid, p_changes jsonb, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_errors jsonb := '{}'::jsonb;
  v_key text;
  v_member core.members;
  v_team text;
  v_is_approver boolean;
begin
  if not v_caller.is_admin then
    perform app.fail('forbidden');
  end if;

  if p_expected_lock_version is null then
    v_errors := v_errors || jsonb_build_object('expected_lock_version', 'Required');
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' or p_changes = '{}'::jsonb then
    v_errors := v_errors || jsonb_build_object('changes', 'Provide at least one change');
  else
    for v_key in select jsonb_object_keys(p_changes) loop
      if v_key not in ('display_name', 'team', 'is_approver', 'is_admin', 'active') then
        v_errors := v_errors || jsonb_build_object(v_key, 'Cannot be changed');
      end if;
    end loop;
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  select * into v_member from core.members where id = p_member_id for update;
  if v_member.id is null or v_member.archived_at is not null then
    perform app.fail('not_found');
  end if;
  if v_member.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_member.lock_version));
  end if;

  v_team := coalesce(p_changes ->> 'team', v_member.team);
  v_is_approver := coalesce((p_changes ->> 'is_approver')::boolean, v_member.is_approver);
  if v_team not in ('marketing', 'creative') then
    v_errors := v_errors || jsonb_build_object('team', 'Choose marketing or creative');
  elsif v_is_approver and v_team <> 'marketing' then
    v_errors := v_errors || jsonb_build_object('is_approver', 'Only Marketing Team members can be Approvers');
  end if;
  if coalesce(trim(coalesce(p_changes ->> 'display_name', v_member.display_name)), '') = '' then
    v_errors := v_errors || jsonb_build_object('display_name', 'Enter a name');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  update core.members
  set display_name = trim(coalesce(p_changes ->> 'display_name', display_name)),
      team = v_team,
      is_approver = v_is_approver,
      is_admin = coalesce((p_changes ->> 'is_admin')::boolean, is_admin),
      active = coalesce((p_changes ->> 'active')::boolean, active),
      lock_version = lock_version + 1
  where id = p_member_id
  returning * into v_member;

  perform app.record_event(v_caller.id, 'member', 'member', v_member.id, v_member.lock_version, 'member_updated',
    jsonb_build_object('changes', p_changes), v_correlation_id);

  return jsonb_build_object('id', v_member.id, 'lock_version', v_member.lock_version, 'correlation_id', v_correlation_id);
end;
$$;
alter function api.update_member(uuid, jsonb, integer) owner to api_owner;

-- ---------------------------------------------------------------------------------------------
-- Function privileges. PostgreSQL lets PUBLIC execute every new function and that default cannot be
-- revoked per schema, so revoke everything here and grant each function to its callers.
-- Later migrations repeat this for the functions they add.

revoke execute on all functions in schema api, app from public, anon, authenticated, service_role;

grant execute on function app.is_active_member() to authenticated; -- used by RLS policies
grant execute on function api.bootstrap_admin(text, text, text) to service_role;
grant execute on function api.accept_invitation() to authenticated;
grant execute on function api.invite_member(text, text, text, boolean, uuid) to authenticated;
grant execute on function api.update_member(uuid, jsonb, integer) to authenticated;
