-- Editing and archiving Footage (D-71; deferred polish, D-78). Either team corrects a Footage item's details; the
-- member who added it, or the Admin, archives it (D-79). Archived Footage keeps its RAW code and its
-- existing links as history, but is no longer offered or linked anew.

set role api_owner;

-- As in 20261012080100_footage.sql, except that usable-until can't be before the date the Footage was shot or
-- received, matching update_footage, and the log keeps every detail it was added with.
create or replace function api.add_footage(
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
  if p_usable_until < p_shot_on then
    v_errors := v_errors || jsonb_build_object('usable_until', 'Usable until can''t be before the date it was shot or received');
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
    jsonb_build_object('code', v_footage.code, 'title', v_footage.title, 'source', v_footage.source, 'shot_on', v_footage.shot_on,
      'presenter_id', v_footage.presenter_id, 'drive_folder_link', v_footage.drive_folder_link, 'usable_until', v_footage.usable_until),
    v_correlation_id);

  return app.remember_result(v_caller.id, 'add_footage', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_footage.id, 'code', v_footage.code, 'lock_version', v_footage.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

create function api.update_footage(p_footage_id uuid, p_changes jsonb, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_errors jsonb := '{}'::jsonb;
  v_key text;
  v_footage creative.footage;
  v_before jsonb;
  v_after jsonb;
  v_changed jsonb := '{}'::jsonb;
begin
  if p_expected_lock_version is null then
    v_errors := v_errors || jsonb_build_object('expected_lock_version', 'Required');
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' or p_changes = '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors || jsonb_build_object('changes', 'Provide at least one change')));
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('title', 'source', 'shot_on', 'presenter_id', 'drive_folder_link', 'usable_until') then
      v_errors := v_errors || jsonb_build_object(v_key, 'Cannot be changed');
    end if;
  end loop;
  if p_changes ? 'title' and coalesce(trim(p_changes ->> 'title'), '') = '' then
    v_errors := v_errors || jsonb_build_object('title', 'Enter a title');
  end if;
  if p_changes ? 'source' and coalesce(p_changes ->> 'source', '') not in ('own_shoot', 'creator', 'stock', 'product_shots') then
    v_errors := v_errors || jsonb_build_object('source', 'Choose own shoot, creator, stock or product shots');
  end if;
  if p_changes ? 'drive_folder_link' and coalesce(trim(p_changes ->> 'drive_folder_link'), '') !~* '^https://[^[:space:]]+$' then
    v_errors := v_errors || jsonb_build_object('drive_folder_link', 'Paste the Drive folder link');
  end if;
  if p_changes ? 'presenter_id' and not app.is_label(p_changes ->> 'presenter_id', 'presenter') then
    v_errors := v_errors || jsonb_build_object('presenter_id', 'Choose a presenter from the list');
  end if;
  foreach v_key in array array['shot_on', 'usable_until'] loop
    if p_changes ? v_key and p_changes ->> v_key is not null
        and not (p_changes ->> v_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and pg_input_is_valid(p_changes ->> v_key, 'date')) then
      v_errors := v_errors || jsonb_build_object(v_key, 'Enter a real date');
    end if;
  end loop;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  select * into v_footage from creative.footage where id = p_footage_id for update;
  if v_footage.id is null then
    perform app.fail('not_found');
  end if;
  if v_footage.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'footage_archived'));
  end if;
  if v_footage.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_footage.lock_version));
  end if;

  v_before := jsonb_build_object('title', v_footage.title, 'source', v_footage.source, 'shot_on', v_footage.shot_on,
    'presenter_id', v_footage.presenter_id, 'drive_folder_link', v_footage.drive_folder_link, 'usable_until', v_footage.usable_until);
  v_after := v_before || jsonb_strip_nulls(jsonb_build_object('title', trim(p_changes ->> 'title'), 'drive_folder_link', trim(p_changes ->> 'drive_folder_link')))
    || (p_changes - 'title' - 'drive_folder_link');
  for v_key in select jsonb_object_keys(v_before) loop
    if v_after -> v_key is distinct from v_before -> v_key then
      v_changed := v_changed || jsonb_build_object(v_key, jsonb_build_object('from', v_before -> v_key, 'to', v_after -> v_key));
    end if;
  end loop;
  if (v_changed ? 'usable_until' or v_changed ? 'shot_on') and (v_after ->> 'usable_until')::date < (v_after ->> 'shot_on')::date then
    v_errors := v_errors || jsonb_build_object(case when v_changed ? 'usable_until' then 'usable_until' else 'shot_on' end,
      'Usable until can''t be before the date it was shot or received');
  end if;
  -- A Footage item's presenter feeds the Label view, so like a Variant's labels it is fixed once a Variant using it has
  -- gone live (D-14, D-71); otherwise past results would move to another presenter.
  if v_changed ? 'presenter_id' and exists (
      select 1 from creative.variant_footage vf
      join creative.variants v on v.id = vf.variant_id
      join creative.creatives c on c.id = v.creative_id
      where vf.footage_id = p_footage_id and vf.removed_at is null and c.first_live_at is not null) then
    v_errors := v_errors || jsonb_build_object('presenter_id', 'A Variant using this Footage has gone live, so its presenter stays as it was');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  if v_changed = '{}'::jsonb then
    return jsonb_build_object('id', v_footage.id, 'lock_version', v_footage.lock_version, 'correlation_id', v_correlation_id);
  end if;

  update creative.footage set
    title = v_after ->> 'title',
    source = v_after ->> 'source',
    shot_on = (v_after ->> 'shot_on')::date,
    presenter_id = (v_after ->> 'presenter_id')::uuid,
    drive_folder_link = v_after ->> 'drive_folder_link',
    usable_until = (v_after ->> 'usable_until')::date,
    lock_version = lock_version + 1
  where id = p_footage_id
  returning * into v_footage;
  perform app.record_event(v_caller.id, 'member', 'footage', v_footage.id, v_footage.lock_version, 'footage_updated',
    jsonb_build_object('changes', v_changed), v_correlation_id);
  return jsonb_build_object('id', v_footage.id, 'lock_version', v_footage.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

create function api.archive_footage(p_footage_id uuid, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_footage creative.footage;
begin
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;
  select * into v_footage from creative.footage where id = p_footage_id for update;
  if v_footage.id is null then
    perform app.fail('not_found');
  end if;
  if v_footage.added_by <> v_caller.id and not v_caller.is_admin then
    perform app.fail('forbidden');
  end if;
  if v_footage.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'footage_archived'));
  end if;
  if v_footage.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_footage.lock_version));
  end if;
  update creative.footage set archived_at = now(), lock_version = lock_version + 1
  where id = p_footage_id
  returning * into v_footage;
  perform app.record_event(v_caller.id, 'member', 'footage', v_footage.id, v_footage.lock_version, 'footage_archived',
    jsonb_build_object('code', v_footage.code, 'title', v_footage.title), v_correlation_id);
  return jsonb_build_object('id', v_footage.id, 'lock_version', v_footage.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- As in 20261012080100_footage.sql, except that a Variant keeps Footage archived after it was linked: an existing
-- link to archived Footage may stay or be removed, but archived Footage is never linked anew.
create or replace function api.set_variant_footage(p_variant_id uuid, p_footage_ids uuid[], p_expected_lock_version integer)
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
  -- The chosen Footage is held, after the Variant, so an archive can't slip in between this check and the link.
  perform 1 from creative.footage where id = any (v_ids) order by id for share;
  if (select count(*) from creative.footage f
      where f.id = any (v_ids)
        and (f.archived_at is null or exists (
          select 1 from creative.variant_footage vf where vf.variant_id = p_variant_id and vf.footage_id = f.id and vf.removed_at is null))) <> cardinality(v_ids) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('footage_ids', 'Choose Footage from the library; archived Footage can''t be added')));
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

grant execute on function api.update_footage(uuid, jsonb, integer) to authenticated;
grant execute on function api.archive_footage(uuid, integer) to authenticated;
