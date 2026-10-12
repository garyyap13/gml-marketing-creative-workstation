-- Briefs (D-13, D-16, D-17, D-51, D-67; FR-02): a Brief version is editable until hand-off, then locked.

create table brief.briefs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  marketing_owner_id uuid not null references core.members (id),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  lock_version integer not null default 0
);

create table brief.brief_versions (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references brief.briefs (id),
  version_number integer not null,
  product_id uuid references label.items (id),
  avatar_id uuid references label.items (id),
  angle_id uuid references label.items (id),
  funnel_stage_id uuid references label.items (id),
  initiative_id uuid references label.items (id),
  key_message text,
  cta text,
  cta_none boolean not null default false,
  hypothesis text,
  state text not null default 'editing' check (state in ('editing', 'handed_off')),
  handed_off_by uuid references core.members (id),
  handed_off_at timestamptz,
  rebrief_reason text,
  created_at timestamptz not null default now(),
  unique (brief_id, version_number),
  constraint brief_versions_cta_or_none check (not (cta_none and cta is not null))
);
create unique index brief_versions_one_editing on brief.brief_versions (brief_id) where state = 'editing';

alter table brief.briefs enable row level security;
alter table brief.brief_versions enable row level security;
grant select, insert, update on brief.briefs, brief.brief_versions to api_owner;
create policy briefs_commands on brief.briefs to api_owner using (true) with check (true);
create policy brief_versions_commands on brief.brief_versions to api_owner using (true) with check (true);
grant select on brief.briefs, brief.brief_versions to authenticated;
create policy briefs_read on brief.briefs for select to authenticated using ((select app.is_active_member()));
create policy brief_versions_read on brief.brief_versions for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- True when the value is empty (clearing the field) or names an active item of that label kind.
create function app.is_label(p_value text, p_kind text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_value is null
    or (p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and exists (
          select 1 from label.items
          where id = p_value::uuid and kind = p_kind and archived_at is null and merged_into_id is null));
$$;

create function app.require_marketing_owner(p_member_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from core.members
    where id = p_member_id and team = 'marketing' and active and archived_at is null) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('marketing_owner_id', 'Choose an active Marketing Team member')));
  end if;
end;
$$;

create function api.create_brief(p_title text, p_marketing_owner_id uuid, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('title', p_title, 'marketing_owner_id', p_marketing_owner_id);
  v_replayed jsonb;
  v_brief brief.briefs;
  v_version brief.brief_versions;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if coalesce(trim(p_title), '') = '' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('title', 'Enter a title')));
  end if;
  perform app.require_marketing_owner(p_marketing_owner_id);

  v_replayed := app.replayed_result(v_caller.id, 'create_brief', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  insert into brief.briefs (title, marketing_owner_id)
  values (trim(p_title), p_marketing_owner_id)
  returning * into v_brief;
  insert into brief.brief_versions (brief_id, version_number)
  values (v_brief.id, 1)
  returning * into v_version;

  perform app.record_event(v_caller.id, 'member', 'brief', v_brief.id, v_brief.lock_version, 'brief_created',
    jsonb_build_object('title', v_brief.title, 'brief_version_id', v_version.id), v_correlation_id);

  return app.remember_result(v_caller.id, 'create_brief', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_brief.id, 'brief_version_id', v_version.id, 'lock_version', v_brief.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

-- Saves fields on the Brief's editing version. A field present with null clears it.
create function api.save_brief(p_brief_id uuid, p_fields jsonb, p_expected_lock_version integer)
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
  v_brief brief.briefs;
  v_version brief.brief_versions;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;

  if p_expected_lock_version is null then
    v_errors := v_errors || jsonb_build_object('expected_lock_version', 'Required');
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object' then
    v_errors := v_errors || jsonb_build_object('fields', 'Provide the fields to save');
  else
    for v_key in select jsonb_object_keys(p_fields) loop
      if v_key not in ('title', 'product_id', 'avatar_id', 'angle_id', 'funnel_stage_id', 'initiative_id',
                       'key_message', 'cta', 'cta_none', 'hypothesis') then
        v_errors := v_errors || jsonb_build_object(v_key, 'Cannot be changed');
      end if;
    end loop;
    if p_fields ? 'title' and coalesce(trim(p_fields ->> 'title'), '') = '' then
      v_errors := v_errors || jsonb_build_object('title', 'Enter a title');
    end if;
    if not app.is_label(p_fields ->> 'product_id', 'product') then
      v_errors := v_errors || jsonb_build_object('product_id', 'Choose a Product');
    end if;
    if not app.is_label(p_fields ->> 'avatar_id', 'avatar') then
      v_errors := v_errors || jsonb_build_object('avatar_id', 'Choose an Avatar');
    end if;
    if not app.is_label(p_fields ->> 'angle_id', 'angle') then
      v_errors := v_errors || jsonb_build_object('angle_id', 'Choose an Angle');
    end if;
    if not app.is_label(p_fields ->> 'funnel_stage_id', 'funnel_stage') then
      v_errors := v_errors || jsonb_build_object('funnel_stage_id', 'Choose a Funnel Stage');
    end if;
    if not app.is_label(p_fields ->> 'initiative_id', 'initiative') then
      v_errors := v_errors || jsonb_build_object('initiative_id', 'Choose an Initiative');
    end if;
    if p_fields ? 'cta_none' and jsonb_typeof(p_fields -> 'cta_none') <> 'boolean' then
      v_errors := v_errors || jsonb_build_object('cta_none', 'Must be true or false');
    elsif (p_fields ->> 'cta_none')::boolean and coalesce(trim(p_fields ->> 'cta'), '') <> '' then
      v_errors := v_errors || jsonb_build_object('cta', 'Write a CTA or choose none, not both');
    end if;
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  select * into v_brief from brief.briefs where id = p_brief_id for update;
  if v_brief.id is null or v_brief.archived_at is not null then
    perform app.fail('not_found');
  end if;
  if v_brief.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_brief.lock_version));
  end if;
  select * into v_version from brief.brief_versions where brief_id = p_brief_id and state = 'editing';
  if v_version.id is null then
    perform app.fail('conflict', jsonb_build_object('reason', 'handed_off_use_rebrief'));
  end if;

  update brief.brief_versions set
    product_id = case when p_fields ? 'product_id' then (p_fields ->> 'product_id')::uuid else product_id end,
    avatar_id = case when p_fields ? 'avatar_id' then (p_fields ->> 'avatar_id')::uuid else avatar_id end,
    angle_id = case when p_fields ? 'angle_id' then (p_fields ->> 'angle_id')::uuid else angle_id end,
    funnel_stage_id = case when p_fields ? 'funnel_stage_id' then (p_fields ->> 'funnel_stage_id')::uuid else funnel_stage_id end,
    initiative_id = case when p_fields ? 'initiative_id' then (p_fields ->> 'initiative_id')::uuid else initiative_id end,
    key_message = case when p_fields ? 'key_message' then nullif(trim(p_fields ->> 'key_message'), '') else key_message end,
    -- Choosing no CTA clears the CTA; writing a CTA clears no-CTA.
    cta = case
      when p_fields ? 'cta' then nullif(trim(p_fields ->> 'cta'), '')
      when (p_fields ->> 'cta_none')::boolean then null
      else cta end,
    cta_none = case
      when p_fields ? 'cta_none' then (p_fields ->> 'cta_none')::boolean
      when nullif(trim(p_fields ->> 'cta'), '') is not null then false
      else cta_none end,
    hypothesis = case when p_fields ? 'hypothesis' then nullif(trim(p_fields ->> 'hypothesis'), '') else hypothesis end
  where id = v_version.id;

  update brief.briefs
  set title = case when p_fields ? 'title' then trim(p_fields ->> 'title') else title end,
      lock_version = lock_version + 1
  where id = p_brief_id
  returning * into v_brief;

  perform app.record_event(v_caller.id, 'member', 'brief', v_brief.id, v_brief.lock_version, 'brief_saved',
    jsonb_build_object('brief_version_id', v_version.id, 'fields', p_fields), v_correlation_id);

  return jsonb_build_object('id', v_brief.id, 'brief_version_id', v_version.id, 'lock_version', v_brief.lock_version,
    'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.create_brief(text, uuid, uuid) to authenticated;
grant execute on function api.save_brief(uuid, jsonb, integer) to authenticated;
