-- The workstation always keeps an active Admin (deferred polish, D-78). update_member is as in
-- 20261012060000_foundations.sql, except that it refuses to demote or deactivate the last active Admin, and refuses
-- flags that aren't true or false. An Admin who has never signed in, perhaps invited at a mistyped address, doesn't
-- count.

set role api_owner;

create or replace function api.update_member(p_member_id uuid, p_changes jsonb, p_expected_lock_version integer)
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
      if v_key not in ('display_name', 'team', 'is_approver', 'is_admin', 'active', 'whatsapp_number', 'whatsapp_opt_in') then
        v_errors := v_errors || jsonb_build_object(v_key, 'Cannot be changed');
      end if;
    end loop;
  end if;
  if p_changes ? 'whatsapp_number' and p_changes ->> 'whatsapp_number' is not null
     and p_changes ->> 'whatsapp_number' !~ '^\+[1-9][0-9]{6,14}$' then
    v_errors := v_errors || jsonb_build_object('whatsapp_number', 'Use international format, e.g. +60123456789');
  end if;
  if p_changes ? 'whatsapp_opt_in' and jsonb_typeof(p_changes -> 'whatsapp_opt_in') <> 'boolean' then
    v_errors := v_errors || jsonb_build_object('whatsapp_opt_in', 'Must be true or false');
  end if;
  -- The flags must be true or false, so a malformed value is a field error rather than a database error.
  foreach v_key in array array['is_approver', 'is_admin', 'active'] loop
    if p_changes ? v_key and jsonb_typeof(p_changes -> v_key) is distinct from 'boolean' then
      v_errors := v_errors || jsonb_build_object(v_key, 'Must be true or false');
    end if;
  end loop;
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
  -- The workstation keeps at least one active Admin who has signed in, so nobody locks everyone out of Settings.
  -- Admin changes take turns, so two Admins can't demote each other at the same moment, and a caller demoted while
  -- waiting is refused.
  if p_changes ? 'is_admin' or p_changes ? 'active' then
    perform pg_advisory_xact_lock(hashtextextended('core.members.admins', 0));
    if not exists (select 1 from core.members where id = v_caller.id and is_admin and active and archived_at is null) then
      perform app.fail('forbidden');
    end if;
    if v_member.is_admin and v_member.active
        and not (coalesce((p_changes ->> 'is_admin')::boolean, true) and coalesce((p_changes ->> 'active')::boolean, true))
        and not exists (select 1 from core.members where is_admin and active and archived_at is null and auth_user_id is not null and id <> v_member.id) then
      v_errors := v_errors || jsonb_build_object(case when coalesce((p_changes ->> 'is_admin')::boolean, true) then 'active' else 'is_admin' end,
        'The workstation needs at least one active Admin who has signed in; make someone else an Admin first');
    end if;
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
      whatsapp_number = case when p_changes ? 'whatsapp_number' then p_changes ->> 'whatsapp_number' else whatsapp_number end,
      whatsapp_opt_in_at = case
        when not p_changes ? 'whatsapp_opt_in' then whatsapp_opt_in_at
        when (p_changes ->> 'whatsapp_opt_in')::boolean then coalesce(whatsapp_opt_in_at, now())
      end,
      lock_version = lock_version + 1
  where id = p_member_id
  returning * into v_member;

  perform app.record_event(v_caller.id, 'member', 'member', v_member.id, v_member.lock_version, 'member_updated',
    jsonb_build_object('changes', p_changes), v_correlation_id);

  return jsonb_build_object('id', v_member.id, 'lock_version', v_member.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

reset role;
