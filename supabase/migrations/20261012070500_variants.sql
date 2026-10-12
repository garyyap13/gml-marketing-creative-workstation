-- Variants (D-10, D-11, D-13, D-18, D-19, D-20, D-58; FR-01, FR-03, T-13): one cut of a Creative, coded
-- with the Creative Code plus a letter, moving through its Format's Production Stages.

create table creative.variants (
  id uuid primary key default gen_random_uuid(),
  creative_id uuid not null references creative.creatives (id),
  letter text not null,
  code text not null unique,
  hook_type_id uuid references label.items (id),
  length_id uuid references label.items (id),
  aspect_ratio_id uuid references label.items (id),
  state text not null default 'in_production' check (state in (
    'in_production', 'awaiting_review', 'changes_requested', 'approved', 'live', 'retired', 'cancelled')),
  production_stage text check (production_stage in (
    'narrative', 'rough_cut', 'fine_cut', 'concept', 'layout', 'refinement', 'ready')),
  working_file_link text,
  meta_media_id text,
  derived_from_variant_id uuid references creative.variants (id),
  live_at timestamptz,
  retired_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  live_without_approval boolean not null default false,
  created_at timestamptz not null default now(),
  lock_version integer not null default 0,
  unique (creative_id, letter)
);

alter table creative.variants enable row level security;
grant select, insert, update on creative.variants to api_owner;
create policy variants_commands on creative.variants to api_owner using (true) with check (true);
grant select on creative.variants to authenticated;
create policy variants_read on creative.variants for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- A, B, … Z, then AA, AB, … (D-58).
create function app.variant_letter(p_number integer) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_n integer := p_number;
  v_letters text := '';
begin
  while v_n > 0 loop
    v_letters := chr(65 + (v_n - 1) % 26) || v_letters;
    v_n := (v_n - 1) / 26;
  end loop;
  return v_letters;
end;
$$;

-- The Production Stages for a Format's media kind (D-18; carousels follow the static track, D-58).
create function app.production_stages(p_media_kind text) returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_media_kind
    when 'video' then array['narrative', 'rough_cut', 'fine_cut', 'ready']
    when 'image' then array['concept', 'layout', 'refinement', 'ready']
    when 'carousel' then array['concept', 'layout', 'refinement', 'ready']
  end;
$$;

create function app.format_media_kind(p_creative_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select f.media_kind from creative.creatives c join label.items f on f.id = c.format_id where c.id = p_creative_id;
$$;

-- Field errors for Variant labels (hook type, length, aspect ratio); a Hook type only on video (T-13).
create function app.variant_label_errors(p_labels jsonb, p_media_kind text) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_errors jsonb := '{}'::jsonb;
  v_key text;
begin
  if jsonb_typeof(p_labels) is distinct from 'object' then
    return jsonb_build_object('labels', 'Provide the Variant labels');
  end if;
  for v_key in select jsonb_object_keys(p_labels) loop
    if v_key not in ('hook_type_id', 'length_id', 'aspect_ratio_id') then
      v_errors := v_errors || jsonb_build_object(v_key, 'Not a Variant label');
    end if;
  end loop;
  if not app.is_label(p_labels ->> 'hook_type_id', 'hook_type') then
    v_errors := v_errors || jsonb_build_object('hook_type_id', 'Choose a Hook type');
  elsif p_labels ->> 'hook_type_id' is not null and p_media_kind is distinct from 'video' and p_media_kind is not null then
    v_errors := v_errors || jsonb_build_object('hook_type_id', 'Only video Variants have a Hook type');
  end if;
  if not app.is_label(p_labels ->> 'length_id', 'length') then
    v_errors := v_errors || jsonb_build_object('length_id', 'Choose a length');
  end if;
  if not app.is_label(p_labels ->> 'aspect_ratio_id', 'aspect_ratio') then
    v_errors := v_errors || jsonb_build_object('aspect_ratio_id', 'Choose an aspect ratio');
  end if;
  return v_errors;
end;
$$;

create function api.create_variant(
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

  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'variant_created',
    jsonb_build_object('code', v_variant.code, 'creative_id', p_creative_id), v_correlation_id);

  return app.remember_result(v_caller.id, 'create_variant', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_variant.id, 'code', v_variant.code, 'lock_version', v_variant.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

create function api.set_production_stage(p_variant_id uuid, p_stage text, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_variant creative.variants;
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
  if v_variant.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_variant.lock_version));
  end if;
  if v_variant.state not in ('in_production', 'changes_requested') then
    perform app.fail('conflict', jsonb_build_object('reason', 'not_in_production'));
  end if;
  if p_stage is null or not p_stage = any (coalesce(app.production_stages(app.format_media_kind(v_variant.creative_id)), '{}')) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('stage', 'Choose a stage on this Format''s track')));
  end if;

  update creative.variants set production_stage = p_stage, lock_version = lock_version + 1
  where id = p_variant_id
  returning * into v_variant;

  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'production_stage_set',
    jsonb_build_object('stage', p_stage), v_correlation_id);

  return jsonb_build_object('id', v_variant.id, 'lock_version', v_variant.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- Sets or changes Variant labels until the Creative's go-live lock (D-13, D-14). Only keys present change.
create function api.set_variant_labels(p_variant_id uuid, p_labels jsonb, p_expected_lock_version integer)
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
  if exists (select 1 from creative.creatives where id = v_variant.creative_id and first_live_at is not null) then
    perform app.fail('conflict', jsonb_build_object('reason', 'labels_locked_after_go_live'));
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

-- The Creative Team keeps a link to the Variant's working files, e.g. a Drive folder (D-07, D-62).
-- It is only a link: it is never checked and never becomes a Version file.
create function api.set_working_file_link(p_variant_id uuid, p_link text, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_variant creative.variants;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null or (p_link is not null and trim(p_link) !~* '^https://[^[:space:]]+$') then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'link', case when p_link is not null and trim(p_link) !~* '^https://[^[:space:]]+$' then 'Paste a link starting with https://' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;

  select * into v_variant from creative.variants where id = p_variant_id for update;
  if v_variant.id is null then
    perform app.fail('not_found');
  end if;
  if v_variant.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_variant.lock_version));
  end if;

  update creative.variants set working_file_link = nullif(trim(p_link), ''), lock_version = lock_version + 1
  where id = p_variant_id
  returning * into v_variant;

  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'working_file_link_set',
    jsonb_build_object('link', v_variant.working_file_link), v_correlation_id);

  return jsonb_build_object('id', v_variant.id, 'lock_version', v_variant.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.set_working_file_link(uuid, text, integer) to authenticated;
grant execute on function api.create_variant(uuid, jsonb, uuid, uuid) to authenticated;
grant execute on function api.set_production_stage(uuid, text, integer) to authenticated;
grant execute on function api.set_variant_labels(uuid, jsonb, integer) to authenticated;
