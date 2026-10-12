-- Invite-only sign-in (D-70, T-09), second line of defence. Public sign-up is off and the invite-member Edge
-- Function creates each invited person's account. Should sign-up ever be switched on, Supabase Auth calls this
-- before creating an account through Google or a magic link, and only an address with an active membership
-- passes. Accounts created with the operator's secret key bypass this hook by Supabase's design.

set role api_owner;

create function app.before_user_created(event jsonb) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from core.members
    where lower(email) = lower(event -> 'user' ->> 'email') and active and archived_at is null) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'This email address has not been invited to the workstation.',
    'http_code', 403));
end;
$$;

reset role;

grant usage on schema app to supabase_auth_admin;
grant execute on function app.before_user_created(jsonb) to supabase_auth_admin;
