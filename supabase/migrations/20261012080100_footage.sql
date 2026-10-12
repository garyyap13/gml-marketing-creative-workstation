-- Footage (D-71, FR-18, T-20): raw footage batches with their own RAW- codes, linked to the Variants that use them.

-- Footage Codes have no brand prefix, so the brand prefix can never be RAW.
alter table core.settings add constraint settings_prefix_not_footage check (brand_prefix <> 'RAW');

create table creative.footage (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  source text not null check (source in ('own_shoot', 'creator', 'stock', 'product_shots')),
  shot_on date,
  presenter_id uuid references label.items (id),
  drive_folder_link text not null,
  usable_until date,
  added_by uuid not null references core.members (id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  lock_version integer not null default 0
);

-- A removed link is marked removed rather than deleted (D-46), so the Variant's Footage history stays.
create table creative.variant_footage (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references creative.variants (id),
  footage_id uuid not null references creative.footage (id),
  added_at timestamptz not null default now(),
  removed_at timestamptz
);
create unique index variant_footage_current on creative.variant_footage (variant_id, footage_id) where removed_at is null;
create index variant_footage_by_footage on creative.variant_footage (footage_id);

alter table creative.footage enable row level security;
alter table creative.variant_footage enable row level security;
grant select, insert, update on creative.footage to api_owner;
grant select, insert, update on creative.variant_footage to api_owner;
create policy footage_commands on creative.footage to api_owner using (true) with check (true);
create policy variant_footage_commands on creative.variant_footage to api_owner using (true) with check (true);
grant select on creative.footage, creative.variant_footage to authenticated;
create policy footage_read on creative.footage for select to authenticated using ((select app.is_active_member()));
create policy variant_footage_read on creative.variant_footage for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Either team adds Footage; the code comes from the RAW counter (T-01, D-71).
create function api.add_footage(
  p_title text,
  p_source text,
  p_shot_on date,
  p_presenter_id uuid,
  p_drive_folder_link text,
  p_usable_until date,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('title', p_title, 'source', p_source, 'shot_on', p_shot_on,
    'presenter_id', p_presenter_id, 'drive_folder_link', p_drive_folder_link, 'usable_until', p_usable_until);
  v_replayed jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_number integer;
  v_footage creative.footage;
begin
  if coalesce(trim(p_title), '') = '' then
    v_errors := v_errors || jsonb_build_object('title', 'Enter a title');
  end if;
  if p_source is null or p_source not in ('own_shoot', 'creator', 'stock', 'product_shots') then
    v_errors := v_errors || jsonb_build_object('source', 'Choose own shoot, creator, stock or product shots');
  end if;
  if coalesce(trim(p_drive_folder_link), '') !~* '^https://[^[:space:]]+$' then
    v_errors := v_errors || jsonb_build_object('drive_folder_link', 'Paste the Drive folder link');
  end if;
  if not app.is_label(p_presenter_id::text, 'presenter') then
    v_errors := v_errors || jsonb_build_object('presenter_id', 'Choose a presenter from the list');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'add_footage', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  insert into core.code_counters (prefix, last_number) values ('RAW', 1)
  on conflict (prefix) do update set last_number = core.code_counters.last_number + 1
  returning last_number into v_number;

  insert into creative.footage (code, title, source, shot_on, presenter_id, drive_folder_link, usable_until, added_by)
  values ('RAW-' || case when v_number < 10000 then lpad(v_number::text, 4, '0') else v_number::text end,
    trim(p_title), p_source, p_shot_on, p_presenter_id, trim(p_drive_folder_link), p_usable_until, v_caller.id)
  returning * into v_footage;

  perform app.record_event(v_caller.id, 'member', 'footage', v_footage.id, v_footage.lock_version, 'footage_added',
    jsonb_build_object('code', v_footage.code, 'title', v_footage.title, 'source', v_footage.source), v_correlation_id);

  return app.remember_result(v_caller.id, 'add_footage', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_footage.id, 'code', v_footage.code, 'lock_version', v_footage.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

-- The Creative Team replaces the list of Footage a Variant uses, until the Creative's go-live lock (D-71, D-14).
create function api.set_variant_footage(p_variant_id uuid, p_footage_ids uuid[], p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_variant creative.variants;
  v_ids uuid[] := array(select distinct x from unnest(coalesce(p_footage_ids, '{}')) x);
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;
  if (select count(*) from creative.footage where id = any (v_ids) and archived_at is null) <> cardinality(v_ids) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('footage_ids', 'Choose Footage from the library')));
  end if;

  select * into v_variant from creative.variants where id = p_variant_id for update;
  if v_variant.id is null then
    perform app.fail('not_found');
  end if;
  if v_variant.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_variant.lock_version));
  end if;
  if exists (select 1 from creative.creatives where id = v_variant.creative_id and first_live_at is not null) then
    perform app.fail('conflict', jsonb_build_object('reason', 'labels_locked_after_go_live'));
  end if;

  update creative.variant_footage set removed_at = now()
  where variant_id = p_variant_id and removed_at is null and not footage_id = any (v_ids);
  insert into creative.variant_footage (variant_id, footage_id)
  select p_variant_id, x from unnest(v_ids) x
  on conflict (variant_id, footage_id) where removed_at is null do nothing;
  update creative.variants set lock_version = lock_version + 1 where id = p_variant_id returning * into v_variant;

  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'variant_footage_set',
    jsonb_build_object('footage_ids', to_jsonb(v_ids)), v_correlation_id);

  return jsonb_build_object('id', v_variant.id, 'lock_version', v_variant.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.add_footage(text, text, date, uuid, text, date, uuid) to authenticated;
grant execute on function api.set_variant_footage(uuid, uuid[], integer) to authenticated;
