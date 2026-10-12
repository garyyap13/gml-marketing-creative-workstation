-- Creatives (D-09–D-11, D-17, D-51; FR-01, FR-03, T-01): a permanent, never-reused code per Creative.

create table core.settings (
  id boolean primary key default true check (id),
  brand_prefix text not null default 'GML' check (brand_prefix ~ '^[A-Z]{2,10}$'),
  time_zone text not null default 'UTC',
  reporting_currency text,
  lock_version integer not null default 0
);
insert into core.settings default values;

create table core.code_counters (
  prefix text primary key,
  last_number integer not null
);

alter table core.settings enable row level security;
alter table core.code_counters enable row level security;
grant select, update on core.settings to api_owner;
grant select, insert, update on core.code_counters to api_owner;
create policy settings_commands on core.settings to api_owner using (true) with check (true);
create policy code_counters_commands on core.code_counters to api_owner using (true) with check (true);
grant select on core.settings to authenticated;
create policy settings_read on core.settings for select to authenticated using ((select app.is_active_member()));

create table creative.creatives (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  brand text not null,
  title text not null,
  brief_version_id uuid references brief.brief_versions (id),
  is_legacy boolean not null default false,
  format_id uuid references label.items (id),
  format_confirmed_by uuid references core.members (id),
  format_confirmed_at timestamptz,
  narrative_style_id uuid references label.items (id),
  creative_owner_id uuid not null references core.members (id),
  due_date date not null,
  first_live_at timestamptz,
  last_variant_number integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  lock_version integer not null default 0,
  constraint creatives_brief_unless_legacy check (is_legacy or brief_version_id is not null),
  constraint creatives_confirmed_format check ((format_confirmed_by is null) = (format_confirmed_at is null)),
  constraint creatives_confirmation_needs_format check (format_confirmed_by is null or format_id is not null)
);

alter table creative.creatives enable row level security;
grant select, insert, update on creative.creatives to api_owner;
create policy creatives_commands on creative.creatives to api_owner using (true) with check (true);
grant select on creative.creatives to authenticated;
create policy creatives_read on creative.creatives for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Issues the next Creative Code for the brand prefix, e.g. GML-0007 (T-01). Gaps are allowed.
create function app.next_creative_code() returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text := (select brand_prefix from core.settings);
  v_number integer;
begin
  insert into core.code_counters (prefix, last_number) values (v_prefix, 1)
  on conflict (prefix) do update set last_number = core.code_counters.last_number + 1
  returning last_number into v_number;
  return v_prefix || '-' || case when v_number < 10000 then lpad(v_number::text, 4, '0') else v_number::text end;
end;
$$;

create function app.require_creative_owner(p_member_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from core.members
    where id = p_member_id and team = 'creative' and active and archived_at is null) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('creative_owner_id', 'Choose an active Creative Team member')));
  end if;
end;
$$;

-- Either team may add a Creative; only a Marketing Team member's Format counts as confirmed (D-51).
create function api.create_creative(
  p_brief_version_id uuid,
  p_title text,
  p_format_id uuid,
  p_creative_owner_id uuid,
  p_due_date date,
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
  v_request jsonb := jsonb_build_object('brief_version_id', p_brief_version_id, 'title', p_title,
    'format_id', p_format_id, 'creative_owner_id', p_creative_owner_id, 'due_date', p_due_date);
  v_replayed jsonb;
  v_creative creative.creatives;
begin
  if coalesce(trim(p_title), '') = '' then
    v_errors := v_errors || jsonb_build_object('title', 'Enter a title');
  end if;
  if p_due_date is null then
    v_errors := v_errors || jsonb_build_object('due_date', 'Choose a due date');
  end if;
  if not app.is_label(p_format_id::text, 'format') then
    v_errors := v_errors || jsonb_build_object('format_id', 'Choose a Format');
  elsif p_format_id is null and v_caller.team = 'marketing' then
    v_errors := v_errors || jsonb_build_object('format_id', 'Choose a Format');
  end if;
  -- New Creatives follow the Brief's latest version.
  if not exists (
    select 1 from brief.brief_versions bv join brief.briefs b on b.id = bv.brief_id
    where bv.id = p_brief_version_id and b.archived_at is null
      and bv.version_number = (select max(version_number) from brief.brief_versions where brief_id = bv.brief_id)) then
    v_errors := v_errors || jsonb_build_object('brief_version_id', 'Choose the Brief''s latest version');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  perform app.require_creative_owner(p_creative_owner_id);

  v_replayed := app.replayed_result(v_caller.id, 'create_creative', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  insert into creative.creatives
    (code, brand, title, brief_version_id, format_id, format_confirmed_by, format_confirmed_at, creative_owner_id, due_date)
  values (
    app.next_creative_code(), (select brand_prefix from core.settings), trim(p_title), p_brief_version_id, p_format_id,
    case when v_caller.team = 'marketing' then v_caller.id end,
    case when v_caller.team = 'marketing' then now() end,
    p_creative_owner_id, p_due_date)
  returning * into v_creative;

  perform app.record_event(v_caller.id, 'member', 'creative', v_creative.id, v_creative.lock_version, 'creative_created',
    jsonb_build_object('code', v_creative.code, 'brief_version_id', v_creative.brief_version_id,
      'format_confirmed', v_creative.format_confirmed_by is not null), v_correlation_id);

  return app.remember_result(v_caller.id, 'create_creative', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_creative.id, 'code', v_creative.code, 'lock_version', v_creative.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

-- Only the Marketing Team sets or confirms a Creative's Format, before go-live (D-51).
create function api.confirm_format(p_creative_id uuid, p_format_id uuid, p_expected_lock_version integer)
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
  if v_creative.first_live_at is not null then
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

-- The Creative Team sets the Narrative Style until go-live (D-13, D-14).
create function api.set_creative_labels(p_creative_id uuid, p_narrative_style_id uuid, p_expected_lock_version integer)
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
  if v_creative.first_live_at is not null then
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

reset role;

grant execute on function api.create_creative(uuid, text, uuid, uuid, date, uuid) to authenticated;
grant execute on function api.confirm_format(uuid, uuid, integer) to authenticated;
grant execute on function api.set_creative_labels(uuid, uuid, integer) to authenticated;
