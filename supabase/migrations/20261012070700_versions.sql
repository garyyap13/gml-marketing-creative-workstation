-- Versions and Reviews (D-20–D-22, D-56; FR-03, FR-04, T-02): a submitted Version is immutable and opens
-- exactly one Review.

create table creative.versions (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references creative.variants (id),
  version_number integer not null,
  brief_version_id uuid references brief.brief_versions (id),
  submitted_by uuid not null references core.members (id),
  submitted_at timestamptz not null default now(),
  notes text,
  unique (variant_id, version_number)
);

create table creative.version_files (
  version_id uuid not null references creative.versions (id),
  file_id uuid not null unique references core.files (id),
  card_position integer not null check (card_position >= 1),
  primary key (version_id, card_position)
);

create table review.reviews (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null unique references creative.versions (id),
  variant_id uuid not null references creative.variants (id),
  round_number integer not null,
  opened_at timestamptz not null default now(),
  decision text check (decision in ('approve', 'request_changes')),
  decided_by uuid references core.members (id),
  decided_at timestamptz,
  approval_ended_at timestamptz,
  approval_end_reason text check (approval_end_reason in ('withdrawn', 'superseded')),
  lock_version integer not null default 0,
  constraint reviews_decision_complete check ((decision is null) = (decided_by is null) and (decision is null) = (decided_at is null)),
  constraint reviews_approval_end check (
    (approval_ended_at is null) = (approval_end_reason is null) and (approval_ended_at is null or decision = 'approve'))
);
create unique index reviews_one_open_per_variant on review.reviews (variant_id) where decision is null;

alter table creative.versions enable row level security;
alter table creative.version_files enable row level security;
alter table review.reviews enable row level security;
grant select, insert on creative.versions, creative.version_files to api_owner;
grant select, insert, update on review.reviews to api_owner;
create policy versions_commands on creative.versions to api_owner using (true) with check (true);
create policy version_files_commands on creative.version_files to api_owner using (true) with check (true);
create policy reviews_commands on review.reviews to api_owner using (true) with check (true);
grant select on creative.versions, creative.version_files, review.reviews to authenticated;
create policy versions_read on creative.versions for select to authenticated using ((select app.is_active_member()));
create policy version_files_read on creative.version_files for select to authenticated using ((select app.is_active_member()));
create policy reviews_read on review.reviews for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- The Marketing Owner of the Brief a Creative follows.
create function app.marketing_owner_of(p_creative_id uuid) returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.marketing_owner_id
  from creative.creatives c
  join brief.brief_versions bv on bv.id = c.brief_version_id
  join brief.briefs b on b.id = bv.brief_id
  where c.id = p_creative_id;
$$;

create function api.submit_version(
  p_variant_id uuid,
  p_file_ids uuid[],
  p_notes text,
  p_expected_lock_version integer,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('variant_id', p_variant_id, 'file_ids', to_jsonb(p_file_ids), 'notes', p_notes,
    'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_variant creative.variants;
  v_creative creative.creatives;
  v_media_kind text;
  v_file_count integer := coalesce(cardinality(p_file_ids), 0);
  v_usable integer;
  v_videos integer;
  v_images integer;
  v_version creative.versions;
  v_review review.reviews;
  v_owner_id uuid;
  v_owner_is_approver boolean;
  v_event_id uuid;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null or v_file_count = 0 then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end,
      'files', case when v_file_count = 0 then 'Choose the Version''s files' end))));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'submit_version', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select * into v_variant from creative.variants where id = p_variant_id for update;
  if v_variant.id is null then
    perform app.fail('not_found');
  end if;
  if v_variant.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_variant.lock_version));
  end if;
  if v_variant.state <> 'in_production' then
    perform app.fail('conflict', jsonb_build_object('reason', 'variant_not_in_production'));
  end if;

  select * into v_creative from creative.creatives where id = v_variant.creative_id;
  v_media_kind := app.format_media_kind(v_creative.id);
  -- A Version records the Brief version it followed, which must be locked by hand-off (D-16).
  if not exists (select 1 from brief.brief_versions where id = v_creative.brief_version_id and state = 'handed_off') then
    v_errors := v_errors || jsonb_build_object('brief', 'The Marketing Team must hand off the Brief first');
  end if;
  if v_creative.format_confirmed_by is null then
    v_errors := v_errors || jsonb_build_object('format', 'The Marketing Team must confirm the Format first');
  end if;
  if v_creative.narrative_style_id is null then
    v_errors := v_errors || jsonb_build_object('narrative_style_id', 'Choose a Narrative Style');
  end if;
  if v_media_kind = 'video' and v_variant.hook_type_id is null then
    v_errors := v_errors || jsonb_build_object('hook_type_id', 'Choose a Hook type');
  elsif v_media_kind is distinct from 'video' and v_variant.hook_type_id is not null then
    v_errors := v_errors || jsonb_build_object('hook_type_id', 'Only video Variants have a Hook type');
  end if;
  if v_variant.length_id is null then
    v_errors := v_errors || jsonb_build_object('length_id', 'Choose a length');
  end if;
  if v_variant.aspect_ratio_id is null then
    v_errors := v_errors || jsonb_build_object('aspect_ratio_id', 'Choose an aspect ratio');
  end if;

  select count(*), count(*) filter (where f.mime like 'video/%'), count(*) filter (where f.mime like 'image/%')
  into v_usable, v_videos, v_images
  from core.files f
  where f.id = any (p_file_ids)
    and f.kind = 'version_media' and f.variant_id = p_variant_id
    and f.verification_state = 'ready' and f.drift_state = 'unchanged'
    and not exists (select 1 from creative.version_files vf where vf.file_id = f.id);
  if v_usable <> v_file_count or (select count(distinct x) from unnest(p_file_ids) x) <> v_file_count then
    v_errors := v_errors || jsonb_build_object('files', 'Use verified Drive files registered for this Variant');
  elsif (select count(distinct f.drive_file_id) from core.files f where f.id = any (p_file_ids)) <> v_file_count then
    v_errors := v_errors || jsonb_build_object('files', 'Each file must be a different Drive file');
  elsif (v_media_kind = 'video' and not (v_file_count = 1 and v_videos = 1))
     or (v_media_kind = 'image' and not (v_file_count = 1 and v_images = 1))
     or (v_media_kind = 'carousel' and not (v_file_count >= 2 and v_images = v_file_count)) then
    v_errors := v_errors || jsonb_build_object('files', case v_media_kind
      when 'video' then 'A video Version has one video file'
      when 'image' then 'A static Version has one image file'
      else 'A carousel Version has two or more images, in card order' end);
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  -- D-69: a Drive file already used by a Version cannot back another one.
  if exists (
    select 1 from core.files f join core.files used on used.drive_file_id = f.drive_file_id and used.attached_at is not null
    where f.id = any (p_file_ids)) then
    perform app.fail('conflict', jsonb_build_object('fieldErrors',
      jsonb_build_object('files', 'This Drive file is already used by a Version. Upload new content as a new file')));
  end if;

  insert into creative.versions (variant_id, version_number, brief_version_id, submitted_by, notes)
  values (p_variant_id,
    coalesce((select max(version_number) from creative.versions where variant_id = p_variant_id), 0) + 1,
    v_creative.brief_version_id, v_caller.id, nullif(trim(p_notes), ''))
  returning * into v_version;
  insert into creative.version_files (version_id, file_id, card_position)
  select v_version.id, file_id, position from unnest(p_file_ids) with ordinality as cards (file_id, position);
  begin
    update core.files set attached_at = now() where id = any (p_file_ids);
  exception when unique_violation then -- a simultaneous submission attached the same Drive file
    perform app.fail('conflict', jsonb_build_object('fieldErrors',
      jsonb_build_object('files', 'This Drive file is already used by a Version. Upload new content as a new file')));
  end;
  insert into review.reviews (version_id, variant_id, round_number)
  values (v_version.id, p_variant_id, v_version.version_number)
  returning * into v_review;
  update creative.variants set state = 'awaiting_review', lock_version = lock_version + 1
  where id = p_variant_id
  returning * into v_variant;

  v_event_id := app.record_event(v_caller.id, 'member', 'review', v_review.id, v_review.lock_version, 'version_submitted',
    jsonb_build_object('variant_id', p_variant_id, 'version_id', v_version.id, 'version_number', v_version.version_number,
      'code', v_variant.code), v_correlation_id);

  -- Submitting completes the Creative Owner's hand-off task and any changes-requested task for this Variant.
  perform app.close_tasks('changes_requested', p_variant_id);
  perform app.close_tasks('brief_handed_off',
    (select brief_id from brief.brief_versions where id = v_creative.brief_version_id), v_creative.creative_owner_id);

  -- D-56: the Brief's Marketing Owner, plus the Approvers if that owner is not one.
  v_owner_id := app.marketing_owner_of(v_creative.id);
  select is_approver into v_owner_is_approver from core.members where id = v_owner_id;
  perform app.notify(v_event_id, 'version_submitted',
    format('Review %s v%s', v_variant.code, v_version.version_number), 'review', v_review.id,
    array_append(
      case when v_owner_is_approver then '{}'::uuid[]
      else array(select id from core.members where is_approver and active and archived_at is null) end,
      v_owner_id),
    jsonb_build_object('code', v_variant.code, 'version_number', v_version.version_number, 'version_id', v_version.id));

  return app.remember_result(v_caller.id, 'submit_version', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_variant.id, 'state', v_variant.state, 'lock_version', v_variant.lock_version,
    'version_id', v_version.id, 'version_number', v_version.version_number, 'review_id', v_review.id,
    'correlation_id', v_correlation_id));
end;
$$;

reset role;

grant execute on function api.submit_version(uuid, uuid[], text, integer, uuid) to authenticated;
