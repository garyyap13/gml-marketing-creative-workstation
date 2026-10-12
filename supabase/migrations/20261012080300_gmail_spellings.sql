-- Gmail ignores dots and anything after "+" in the part before @, and googlemail.com is the same as gmail.com.
-- One person is therefore one member however their Gmail address is spelt. Google sign-in itself still matches
-- the Auth account by its exact address, so the Admin enters the address as the person's Google account shows it.

set role api_owner;

create function app.canonical_email(p_email text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(lower(trim(p_email)), '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(split_part(split_part(lower(trim(p_email)), '@', 1), '+', 1), '.', '') || '@gmail.com'
    else lower(trim(p_email))
  end;
$$;

reset role;

-- The table owner builds the index, so it needs to run the function.
grant execute on function app.canonical_email(text) to postgres;

-- Two members who are one Gmail account under different spellings must be merged by hand before this runs.
do $$
declare
  v_duplicates text;
begin
  select string_agg(addresses, '; ') into v_duplicates
  from (
    select string_agg(email, ', ' order by email) as addresses
    from core.members group by app.canonical_email(email) having count(*) > 1
  ) groups;
  if v_duplicates is not null then
    raise exception 'These members are one Gmail account spelt differently; merge them first: %', v_duplicates;
  end if;
end;
$$;

drop index core.members_email_key;
create unique index members_canonical_email_key on core.members (app.canonical_email(email));

set role api_owner;

create or replace function api.invite_member(
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

  -- One member per email address, however a Gmail address is spelt. ON CONFLICT also covers a simultaneous
  -- invitation of the same address.
  insert into core.members (email, display_name, team, is_approver)
  values (lower(trim(p_email)), trim(p_display_name), p_team, coalesce(p_is_approver, false))
  on conflict ((app.canonical_email(email))) do nothing
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


create or replace function api.accept_invitation() returns jsonb
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
    where app.canonical_email(email) = app.canonical_email((select app.caller_email()))
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


create or replace function app.before_user_created(event jsonb) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from core.members
    where app.canonical_email(email) = app.canonical_email(event -> 'user' ->> 'email') and active and archived_at is null) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'This email address has not been invited to the workstation.',
    'http_code', 403));
end;
$$;

reset role;
