-- Breakdown settings (D-35, D-58; TRD §4.1 core.breakdown_settings, §8.2). Each enabled set is its own breakdown schema,
-- pulled alongside the totals by the Meta sync (B3). The sets are combinations Meta's Insights API documents as allowed
-- together (checked 2026-10-15); age × gender and placement are on by default. A set turned on is collected from the
-- next sync and over the 28-day re-pull; older history needs an explicit backfill (D-58). The Admin changes them (D-49).

create table core.breakdown_settings (
  id uuid primary key default gen_random_uuid(),
  breakdown_set text not null unique check (breakdown_set ~ '^[a-z][a-z_]*$'),
  breakdowns text[] not null check (cardinality(breakdowns) between 1 and 3),
  enabled boolean not null default false,
  changed_by uuid references core.members (id),
  changed_at timestamptz,
  lock_version integer not null default 0
);
insert into core.breakdown_settings (breakdown_set, breakdowns, enabled) values
  ('age_gender', '{age,gender}', true),
  ('placement', '{publisher_platform,platform_position}', true),
  ('placement_device', '{publisher_platform,impression_device}', false),
  ('country', '{country}', false),
  ('region', '{region}', false);

alter table core.breakdown_settings enable row level security;
grant select, update on core.breakdown_settings to api_owner;
create policy breakdown_settings_commands on core.breakdown_settings to api_owner using (true) with check (true);
grant select on core.breakdown_settings to authenticated;
create policy breakdown_settings_read on core.breakdown_settings for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- The Admin turns a Breakdown set on or off (D-35, D-49). Saving the same value changes nothing.
create function api.set_breakdown(p_breakdown_set text, p_enabled boolean, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_setting core.breakdown_settings;
begin
  if not v_caller.is_admin then
    perform app.fail('forbidden');
  end if;
  if p_enabled is null or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'enabled', case when p_enabled is null then 'On or off' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;
  select * into v_setting from core.breakdown_settings where breakdown_set = p_breakdown_set for update;
  if v_setting.id is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('breakdown_set', 'Choose one of the Breakdowns listed')));
  end if;
  if v_setting.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_setting.lock_version));
  end if;
  if v_setting.enabled = p_enabled then
    return jsonb_build_object('id', v_setting.id, 'enabled', v_setting.enabled, 'lock_version', v_setting.lock_version, 'correlation_id', v_correlation_id);
  end if;
  update core.breakdown_settings set enabled = p_enabled, changed_by = v_caller.id, changed_at = now(), lock_version = lock_version + 1
  where id = v_setting.id
  returning * into v_setting;
  perform app.record_event(v_caller.id, 'member', 'breakdown_setting', v_setting.id, v_setting.lock_version,
    case when p_enabled then 'breakdown_enabled' else 'breakdown_disabled' end,
    jsonb_build_object('breakdown_set', v_setting.breakdown_set, 'breakdowns', to_jsonb(v_setting.breakdowns)), v_correlation_id);
  return jsonb_build_object('id', v_setting.id, 'enabled', v_setting.enabled, 'lock_version', v_setting.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- The Breakdown sets the Meta sync pulls, with when each was last turned on, so a newly enabled set is collected
-- from the next sync and over the 28-day re-pull only (D-58).
create function worker.enabled_breakdowns() returns table (breakdown_set text, breakdowns text[], enabled_since timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select breakdown_set, breakdowns, changed_at from core.breakdown_settings where enabled order by breakdown_set;
$$;

reset role;

grant execute on function api.set_breakdown(text, boolean, integer) to authenticated;
grant execute on function worker.enabled_breakdowns() to service_role;
