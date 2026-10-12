-- Label lists (D-13, T-13): each kind belongs to one team, and renames keep the item's ID.
-- Rename and merge history lives in the activity log.

create table label.items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'product', 'avatar', 'angle', 'funnel_stage', 'initiative', 'format',
    'narrative_style', 'hook_type', 'length', 'aspect_ratio', 'presenter')),
  name text not null,
  media_kind text check (media_kind in ('video', 'image', 'carousel')),
  starts_on date,
  ends_on date,
  merged_into_id uuid references label.items (id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  lock_version integer not null default 0,
  constraint items_media_kind_only_for_format check ((kind = 'format') = (media_kind is not null)),
  constraint items_dates_only_for_initiative check (kind = 'initiative' or (starts_on is null and ends_on is null))
);
create unique index items_active_name_key on label.items (kind, lower(name))
  where archived_at is null and merged_into_id is null;

alter table label.items enable row level security;
grant select, insert, update on label.items to api_owner;
create policy items_commands on label.items to api_owner using (true) with check (true);
grant select on label.items to authenticated;
create policy items_read on label.items for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- The team that owns a label kind, or null for an unknown kind.
create function app.label_owner(p_kind text) returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_kind in ('product', 'avatar', 'angle', 'funnel_stage', 'initiative', 'format') then 'marketing'
    when p_kind in ('narrative_style', 'hook_type', 'length', 'aspect_ratio', 'presenter') then 'creative'
  end;
$$;

create function api.add_label_item(p_kind text, p_name text, p_media_kind text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_errors jsonb := '{}'::jsonb;
  v_request jsonb := jsonb_build_object('kind', p_kind, 'name', p_name, 'media_kind', p_media_kind);
  v_replayed jsonb;
  v_item label.items;
begin
  if app.label_owner(p_kind) is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('kind', 'Unknown label list')));
  end if;
  if app.label_owner(p_kind) <> v_caller.team then
    perform app.fail('forbidden');
  end if;

  if coalesce(trim(p_name), '') = '' then
    v_errors := v_errors || jsonb_build_object('name', 'Enter a name');
  end if;
  if p_kind = 'format' and p_media_kind is distinct from 'video' and p_media_kind is distinct from 'image'
     and p_media_kind is distinct from 'carousel' then
    v_errors := v_errors || jsonb_build_object('media_kind', 'Choose video, image or carousel');
  elsif p_kind <> 'format' and p_media_kind is not null then
    v_errors := v_errors || jsonb_build_object('media_kind', 'Only Formats have a media kind');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'add_label_item', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  insert into label.items (kind, name, media_kind)
  values (p_kind, trim(p_name), p_media_kind)
  on conflict (kind, lower(name)) where archived_at is null and merged_into_id is null do nothing
  returning * into v_item;
  if v_item.id is null then
    perform app.fail('conflict', jsonb_build_object('fieldErrors', jsonb_build_object('name', 'Already in this list')));
  end if;

  perform app.record_event(v_caller.id, 'member', 'label_item', v_item.id, v_item.lock_version, 'label_item_added',
    jsonb_build_object('kind', v_item.kind, 'name', v_item.name), v_correlation_id);

  return app.remember_result(v_caller.id, 'add_label_item', p_idempotency_key, v_request,
    jsonb_build_object('id', v_item.id, 'lock_version', v_item.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

create function api.rename_label_item(p_item_id uuid, p_name text, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_item label.items;
  v_old_name text;
begin
  if coalesce(trim(p_name), '') = '' or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'name', case when coalesce(trim(p_name), '') = '' then 'Enter a name' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;

  select * into v_item from label.items where id = p_item_id for update;
  if v_item.id is null or v_item.archived_at is not null or v_item.merged_into_id is not null then
    perform app.fail('not_found');
  end if;
  if app.label_owner(v_item.kind) <> v_caller.team then
    perform app.fail('forbidden');
  end if;
  if v_item.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_item.lock_version));
  end if;

  v_old_name := v_item.name;
  begin
    update label.items set name = trim(p_name), lock_version = lock_version + 1
    where id = p_item_id
    returning * into v_item;
  exception when unique_violation then
    perform app.fail('conflict', jsonb_build_object('fieldErrors', jsonb_build_object('name', 'Already in this list')));
  end;

  perform app.record_event(v_caller.id, 'member', 'label_item', v_item.id, v_item.lock_version, 'label_item_renamed',
    jsonb_build_object('kind', v_item.kind, 'old_name', v_old_name, 'new_name', v_item.name), v_correlation_id);

  return jsonb_build_object('id', v_item.id, 'lock_version', v_item.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.add_label_item(text, text, text, uuid) to authenticated;
grant execute on function api.rename_label_item(uuid, text, integer) to authenticated;
