-- Uploads (D-52, D-59, D-62; T-05): Brief attachments and Launch thumbnails go to private Storage buckets. An upload
-- intent opens one path for one file, for the member who asked, and the file-verifier Edge Function checks what
-- arrived before anyone else can read it. Version files never come here; they stay in Drive (D-65).

-- Brief attachments (D-52): an uploaded file or a link, with a label and a role. They belong to one Brief version: added
-- or removed while it is being edited, frozen at hand-off, and carried forward by a Rebrief (PD-26).
create table brief.attachments (
  id uuid primary key default gen_random_uuid(),
  brief_version_id uuid not null references brief.brief_versions (id),
  file_id uuid references core.files (id),
  link_url text check (link_url ~ '^https://[^[:space:]]+$' and length(link_url) <= 2000),
  label text not null check (length(label) between 1 and 120),
  role text not null check (role in ('script', 'reference', 'rough_material')),
  added_by uuid not null references core.members (id),
  added_at timestamptz not null default now(),
  removed_by uuid references core.members (id),
  removed_at timestamptz,
  constraint attachments_link_or_file check ((file_id is null) <> (link_url is null)),
  constraint attachments_removed_pair check ((removed_at is null) = (removed_by is null))
);
create index attachments_by_version on brief.attachments (brief_version_id);
create unique index attachments_one_per_file on brief.attachments (brief_version_id, file_id) where removed_at is null and file_id is not null;

alter table brief.attachments enable row level security;
grant select, insert, update on brief.attachments to api_owner;
create policy attachments_commands on brief.attachments to api_owner using (true) with check (true);
grant select on brief.attachments to authenticated;
create policy attachments_read on brief.attachments for select to authenticated using ((select app.is_active_member()));

alter table core.files
  add column target_brief_version_id uuid references brief.brief_versions (id),
  add column target_launch_id uuid references launch.launches (id),
  add constraint files_storage_identity check (provider <> 'supabase_storage' or (storage_bucket is not null and storage_path is not null and name is not null)),
  add constraint files_upload_target check ((kind <> 'brief_attachment' or target_brief_version_id is not null)
    and (kind <> 'launch_thumbnail' or target_launch_id is not null));
create unique index files_one_per_storage_path on core.files (storage_bucket, storage_path) where storage_path is not null;

-- A Launch's thumbnail (D-62): a checked picture uploaded for that Launch. A newer one replaces it on screen; the
-- earlier file stays on record.
alter table launch.launches add column thumbnail_file_id uuid references core.files (id);

set role api_owner;

-- Each uploadable kind's bucket, size limit (proposed, D-58) and accepted types (PD-26): each type with the content
-- family the verifier must find and the file-name endings it may have, so a download never saves as something that
-- runs. CSV imports arrive with results import (A5).
create function app.upload_rules(p_kind text) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'brief_attachment' then jsonb_build_object('bucket', 'brief-attachments', 'limit', 26214400, 'limit_text', '25 MiB',
      'types_text', 'Upload a PDF, picture, video, Office document, zip or plain text file, or add a link instead',
      'types', jsonb_build_object(
        'application/pdf', 'pdf', 'image/jpeg', 'jpeg', 'image/png', 'png', 'image/webp', 'webp', 'image/gif', 'gif',
        'video/mp4', 'video', 'video/quicktime', 'video', 'application/zip', 'zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'zip',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'zip',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'zip',
        'text/plain', 'text', 'text/csv', 'text', 'text/markdown', 'text'),
      'endings', jsonb_build_object(
        'application/pdf', '["pdf"]'::jsonb, 'image/jpeg', '["jpg", "jpeg"]'::jsonb, 'image/png', '["png"]'::jsonb,
        'image/webp', '["webp"]'::jsonb, 'image/gif', '["gif"]'::jsonb, 'video/mp4', '["mp4", "m4v"]'::jsonb,
        'video/quicktime', '["mov"]'::jsonb, 'application/zip', '["zip"]'::jsonb,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '["docx"]'::jsonb,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '["xlsx"]'::jsonb,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', '["pptx"]'::jsonb,
        'text/plain', '["txt"]'::jsonb, 'text/csv', '["csv"]'::jsonb, 'text/markdown', '["md", "markdown"]'::jsonb))
    when 'launch_thumbnail' then jsonb_build_object('bucket', 'launch-thumbnails', 'limit', 52428800, 'limit_text', '50 MiB',
      'types_text', 'Upload a JPEG, PNG, WebP or GIF picture',
      'types', jsonb_build_object('image/jpeg', 'jpeg', 'image/png', 'png', 'image/webp', 'webp', 'image/gif', 'gif'),
      'endings', jsonb_build_object('image/jpeg', '["jpg", "jpeg"]'::jsonb, 'image/png', '["png"]'::jsonb,
        'image/webp', '["webp"]'::jsonb, 'image/gif', '["gif"]'::jsonb))
  end;
$$;

-- Names and labels never carry control characters or the invisible marks that can disguise a file's ending.
create function app.has_hidden_characters(p_text text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_text ~ '[[:cntrl:]\u200e\u200f\u202a-\u202e\u2066-\u2069]';
$$;

-- Storage access: a member uploads only into a slot they opened in the last hour, and nobody overwrites or deletes
-- an object. Members read a file once it has been checked; the uploader can also read it while it is being checked.
create function app.upload_slot_open(p_bucket text, p_path text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from core.files
    where storage_bucket = p_bucket and storage_path = p_path and verification_state = 'pending'
      and registered_by = (app.signed_in_member()).id and created_at > now() - interval '1 hour');
$$;

create function app.stored_file_readable(p_bucket text, p_path text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from core.files
    where storage_bucket = p_bucket and storage_path = p_path and (app.signed_in_member()).id is not null
      and (verification_state = 'ready' or (verification_state in ('pending', 'verifying') and registered_by = (app.signed_in_member()).id)));
$$;

-- Marketing opens an upload slot for one file: an attachment on a Brief's editing version, or a thumbnail for a
-- Launch that is planned or live, even while its Variant is live (D-52, D-62).
create function api.create_upload_intent(p_kind text, p_target_id uuid, p_name text, p_bytes bigint, p_mime text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('kind', p_kind, 'target_id', p_target_id, 'name', p_name, 'bytes', p_bytes, 'mime', p_mime);
  v_replayed jsonb;
  v_rules jsonb := app.upload_rules(p_kind);
  v_errors jsonb := '{}'::jsonb;
  v_version brief.brief_versions;
  v_launch launch.launches;
  v_id uuid := gen_random_uuid();
  v_file core.files;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'create_upload_intent', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if v_rules is null then
    v_errors := jsonb_build_object('kind', 'Upload a Brief attachment or a Launch thumbnail');
  else
    if coalesce(trim(p_name), '') = '' or length(p_name) > 200 or app.has_hidden_characters(p_name) then
      v_errors := v_errors || jsonb_build_object('name', 'Name the file, in up to 200 characters');
    elsif (v_rules -> 'types') ? coalesce(p_mime, '')
        and not (v_rules -> 'endings' -> p_mime) ? lower(coalesce(substring(p_name from '\.([^.]+)$'), '')) then
      v_errors := v_errors || jsonb_build_object('name', 'The file name''s ending doesn''t match its type');
    end if;
    if p_bytes is null or p_bytes < 1 or p_bytes > (v_rules ->> 'limit')::bigint then
      v_errors := v_errors || jsonb_build_object('bytes', 'Up to ' || (v_rules ->> 'limit_text'));
    end if;
    if not (v_rules -> 'types') ? coalesce(p_mime, '') then
      v_errors := v_errors || jsonb_build_object('mime', v_rules ->> 'types_text');
    end if;
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  if p_kind = 'brief_attachment' then
    select * into v_version from brief.brief_versions where brief_id = p_target_id and state = 'editing';
    if v_version.id is null and exists (select 1 from brief.briefs where id = p_target_id and archived_at is null) then
      perform app.fail('conflict', jsonb_build_object('reason', 'handed_off_use_rebrief'));
    elsif v_version.id is null then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('target', 'Choose a Brief')));
    end if;
  else
    select * into v_launch from launch.launches where id = p_target_id;
    if v_launch.id is null then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('target', 'Choose a Launch')));
    elsif v_launch.status not in ('planned', 'live') then
      perform app.fail('conflict', jsonb_build_object('reason', 'launch_closed'));
    end if;
  end if;

  insert into core.files (id, kind, provider, storage_bucket, storage_path, name, mime, bytes, registered_by, target_brief_version_id, target_launch_id)
  values (v_id, p_kind, 'supabase_storage', v_rules ->> 'bucket', p_target_id || '/' || v_id, trim(p_name), p_mime, p_bytes, v_caller.id,
    v_version.id, v_launch.id)
  returning * into v_file;
  perform app.record_event(v_caller.id, 'member', 'file', v_file.id, null, 'upload_started',
    jsonb_build_object('kind', p_kind, 'target_id', p_target_id, 'bytes', p_bytes, 'mime', p_mime), v_correlation_id);
  return app.remember_result(v_caller.id, 'create_upload_intent', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_file.id, 'bucket', v_file.storage_bucket, 'path', v_file.storage_path, 'correlation_id', v_correlation_id));
end;
$$;

-- The uploader says the file has arrived; the file-verifier Edge Function then checks it. Calling again while it is
-- being checked lets a stalled check run again.
create function api.complete_upload(p_file_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_file core.files;
begin
  select * into v_file from core.files where id = p_file_id for update;
  if v_file.id is null or v_file.provider <> 'supabase_storage' then
    perform app.fail('not_found');
  end if;
  if v_file.registered_by is distinct from v_caller.id then
    perform app.fail('forbidden');
  end if;
  if v_file.verification_state in ('ready', 'failed') then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_verified'));
  end if;
  if v_file.verification_state = 'pending' then
    update core.files set verification_state = 'verifying' where id = p_file_id returning * into v_file;
    perform app.record_event(v_caller.id, 'member', 'file', v_file.id, null, 'upload_completed', '{}'::jsonb, v_correlation_id);
  end if;
  return jsonb_build_object('id', v_file.id, 'verification_state', v_file.verification_state, 'bucket', v_file.storage_bucket,
    'path', v_file.storage_path, 'correlation_id', v_correlation_id);
end;
$$;

-- Worker only: records what the file-verifier found in the stored object, and decides whether the file is ready.
-- p_report: found, bytes, content_type (as stored), family (sniffed from the content), sha256, width and height, and
-- checked_path: where the verifier stored the exact bytes it checked. A ready file is read only from there, a path no
-- member can write, so the upload slot can never swap in other bytes afterwards.
create function worker.record_file_verification(p_file_id uuid, p_report jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_file core.files;
  v_rules jsonb;
  v_expected text;
  v_family text := p_report ->> 'family';
  v_bytes bigint;
  v_width integer;
  v_height integer;
  v_names constant jsonb := jsonb_build_object('pdf', 'a PDF', 'png', 'a PNG image', 'jpeg', 'a JPEG image', 'gif', 'a GIF image',
    'webp', 'a WebP image', 'video', 'a video', 'zip', 'an Office document or zip file', 'text', 'a plain text file');
  v_reason text;
begin
  select * into v_file from core.files where id = p_file_id for update;
  if v_file.id is null or v_file.provider <> 'supabase_storage' then
    perform app.fail('not_found');
  end if;
  if v_file.verification_state <> 'verifying' then
    perform app.fail('conflict', jsonb_build_object('reason',
      case when v_file.verification_state = 'pending' then 'not_uploaded' else 'already_verified' end));
  end if;
  v_rules := app.upload_rules(v_file.kind);
  v_expected := v_rules -> 'types' ->> v_file.mime;
  if jsonb_typeof(p_report -> 'bytes') = 'number' then v_bytes := (p_report ->> 'bytes')::bigint; end if;
  if jsonb_typeof(p_report -> 'width') = 'number' and (p_report ->> 'width')::numeric between 1 and 100000 then
    v_width := (p_report ->> 'width')::integer;
  end if;
  if jsonb_typeof(p_report -> 'height') = 'number' and (p_report ->> 'height')::numeric between 1 and 100000 then
    v_height := (p_report ->> 'height')::integer;
  end if;

  v_reason := case
    when v_expected is null then 'This kind of file can''t be checked yet.'
    when (p_report -> 'found') is distinct from 'true'::jsonb then 'The file never arrived. Upload it again.'
    when v_bytes is null or v_bytes < 1 then 'The check could not read the file. Upload it again.'
    when v_bytes > (v_rules ->> 'limit')::bigint then 'Larger than the ' || (v_rules ->> 'limit_text') || ' limit.'
    when (p_report ->> 'content_type') is distinct from v_file.mime then
      'The file was uploaded as ' || coalesce(p_report ->> 'content_type', 'an unknown type') || ', not ' || v_file.mime || '.'
    when v_family is distinct from v_expected then 'The file''s content is not ' || coalesce(v_names ->> v_expected, 'what it says it is') || '.'
    when coalesce(p_report ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then 'The check could not read the file. Upload it again.'
    when v_expected in ('png', 'jpeg', 'gif', 'webp') and (v_width is null or v_height is null) then
      'The picture''s size could not be read.'
    when (p_report ->> 'checked_path') is distinct from 'checked/' || v_file.storage_path then
      'The check could not keep the file. Upload it again.'
  end;

  update core.files set
    verification_state = case when v_reason is null then 'ready' else 'failed' end,
    failure_reason = v_reason,
    bytes = coalesce(v_bytes, bytes),
    checksum = case when v_reason is null then p_report ->> 'sha256' end,
    checksum_algorithm = case when v_reason is null then 'sha256' end,
    width = case when v_reason is null then v_width end,
    height = case when v_reason is null then v_height end,
    storage_path = case when v_reason is null then p_report ->> 'checked_path' else storage_path end,
    verified_at = now()
  where id = p_file_id
  returning * into v_file;
  perform app.record_event(null, 'worker', 'file', v_file.id, null, 'upload_' || v_file.verification_state,
    jsonb_strip_nulls(jsonb_build_object('bytes', v_file.bytes, 'reason', v_reason)), v_correlation_id);
  return jsonb_build_object('id', v_file.id, 'verification_state', v_file.verification_state, 'failure_reason', v_file.failure_reason,
    'correlation_id', v_correlation_id);
end;
$$;

-- Marketing attaches a checked file uploaded to this Brief, or an https:// link, to the Brief's editing version.
create function api.add_brief_attachment(p_brief_id uuid, p_attachment jsonb, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('brief_id', p_brief_id, 'attachment', p_attachment);
  v_replayed jsonb;
  v_errors jsonb := '{}'::jsonb;
  v_key text;
  v_brief brief.briefs;
  v_version brief.brief_versions;
  v_file core.files;
  v_attachment brief.attachments;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'add_brief_attachment', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if jsonb_typeof(p_attachment) is distinct from 'object' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('attachment', 'Provide a file or a link')));
  end if;
  for v_key in select jsonb_object_keys(p_attachment) loop
    if v_key not in ('file_id', 'link_url', 'label', 'role') then
      v_errors := v_errors || jsonb_build_object(v_key, 'Not part of an attachment');
    end if;
  end loop;
  if (p_attachment ->> 'file_id' is null) = (p_attachment ->> 'link_url' is null) then
    v_errors := v_errors || jsonb_build_object('attachment', 'Attach a file or a link, not both');
  elsif p_attachment ->> 'file_id' is not null and p_attachment ->> 'file_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_errors := v_errors || jsonb_build_object('file_id', 'Choose a checked file uploaded to this Brief');
  elsif p_attachment ->> 'link_url' is not null
      and (p_attachment ->> 'link_url' !~ '^https://[^[:space:]]+$' or length(p_attachment ->> 'link_url') > 2000) then
    v_errors := v_errors || jsonb_build_object('link_url', 'Paste a link that starts with https://');
  end if;
  if coalesce(trim(p_attachment ->> 'label'), '') = '' or length(trim(p_attachment ->> 'label')) > 120
      or app.has_hidden_characters(p_attachment ->> 'label') then
    v_errors := v_errors || jsonb_build_object('label', 'Name it, in up to 120 characters');
  end if;
  if coalesce(p_attachment ->> 'role', '') not in ('script', 'reference', 'rough_material') then
    v_errors := v_errors || jsonb_build_object('role', 'A script, a reference or rough material');
  end if;
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  select * into v_brief from brief.briefs where id = p_brief_id for update;
  if v_brief.id is null or v_brief.archived_at is not null then
    perform app.fail('not_found');
  end if;
  select * into v_version from brief.brief_versions where brief_id = p_brief_id and state = 'editing';
  if v_version.id is null then
    perform app.fail('conflict', jsonb_build_object('reason', 'handed_off_use_rebrief'));
  end if;
  if p_attachment ->> 'file_id' is not null then
    select * into v_file from core.files where id = (p_attachment ->> 'file_id')::uuid for update;
    -- A file uploaded to any version of this Brief, so one carried forward by a Rebrief can be attached again.
    if v_file.id is null or v_file.kind <> 'brief_attachment' or v_file.verification_state <> 'ready'
        or not exists (select 1 from brief.brief_versions where id = v_file.target_brief_version_id and brief_id = p_brief_id) then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('file_id', 'Choose a checked file uploaded to this Brief')));
    end if;
    if exists (select 1 from brief.attachments where brief_version_id = v_version.id and file_id = v_file.id and removed_at is null) then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('file_id', 'This file is already attached')));
    end if;
  end if;

  insert into brief.attachments (brief_version_id, file_id, link_url, label, role, added_by)
  values (v_version.id, v_file.id, p_attachment ->> 'link_url', trim(p_attachment ->> 'label'), p_attachment ->> 'role', v_caller.id)
  returning * into v_attachment;
  if v_file.id is not null then
    update core.files set attached_at = coalesce(attached_at, now()) where id = v_file.id;
  end if;
  perform app.record_event(v_caller.id, 'member', 'brief', v_brief.id, v_brief.lock_version, 'brief_attachment_added',
    jsonb_build_object('attachment_id', v_attachment.id, 'brief_version_id', v_version.id, 'role', v_attachment.role,
      'kind', case when v_file.id is null then 'link' else 'file' end), v_correlation_id);
  return app.remember_result(v_caller.id, 'add_brief_attachment', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_attachment.id, 'correlation_id', v_correlation_id));
end;
$$;

-- Marketing removes an attachment from the editing version. It stays on record; nothing is deleted.
create function api.remove_brief_attachment(p_attachment_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_attachment brief.attachments;
  v_version brief.brief_versions;
  v_brief brief.briefs;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  select * into v_attachment from brief.attachments where id = p_attachment_id;
  if v_attachment.id is null then
    perform app.fail('not_found');
  end if;
  -- Lock the Brief first (lock order), then read the version's state again in case it was just handed off.
  select * into v_brief from brief.briefs
  where id = (select brief_id from brief.brief_versions where id = v_attachment.brief_version_id) for update;
  select * into v_version from brief.brief_versions where id = v_attachment.brief_version_id;
  if v_version.state <> 'editing' then
    perform app.fail('conflict', jsonb_build_object('reason', 'handed_off_use_rebrief'));
  end if;
  select * into v_attachment from brief.attachments where id = p_attachment_id for update;
  if v_attachment.removed_at is null then
    update brief.attachments set removed_at = now(), removed_by = v_caller.id where id = p_attachment_id returning * into v_attachment;
    perform app.record_event(v_caller.id, 'member', 'brief', v_brief.id, v_brief.lock_version, 'brief_attachment_removed',
      jsonb_build_object('attachment_id', v_attachment.id, 'brief_version_id', v_version.id), v_correlation_id);
  end if;
  return jsonb_build_object('id', v_attachment.id, 'correlation_id', v_correlation_id);
end;
$$;

-- Marketing sets a planned or live Launch's thumbnail, even while its Variant is live (D-62; AC-06).
create function api.set_launch_thumbnail(p_launch_id uuid, p_file_id uuid, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('launch_id', p_launch_id, 'file_id', p_file_id, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_launch launch.launches;
  v_file core.files;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if p_file_id is null or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'file_id', case when p_file_id is null then 'Choose a picture' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'set_launch_thumbnail', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  v_launch := app.lock_launch(p_launch_id);
  if v_launch.id is null then
    perform app.fail('not_found');
  end if;
  if v_launch.status not in ('planned', 'live') then
    perform app.fail('conflict', jsonb_build_object('reason', 'launch_closed'));
  end if;
  if v_launch.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_launch.lock_version));
  end if;
  select * into v_file from core.files where id = p_file_id for update;
  if v_file.id is null or v_file.kind <> 'launch_thumbnail' or v_file.target_launch_id is distinct from v_launch.id
      or v_file.verification_state <> 'ready' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('file_id', 'Choose a checked picture uploaded for this Launch')));
  end if;

  update launch.launches set thumbnail_file_id = v_file.id, lock_version = lock_version + 1
  where id = p_launch_id
  returning * into v_launch;
  update core.files set attached_at = coalesce(attached_at, now()) where id = v_file.id;
  perform app.record_event(v_caller.id, 'member', 'launch', v_launch.id, v_launch.lock_version, 'launch_thumbnail_set',
    jsonb_build_object('file_id', v_file.id, 'variant_id', v_launch.variant_id), v_correlation_id);
  return app.remember_result(v_caller.id, 'set_launch_thumbnail', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_launch.id, 'thumbnail_file_id', v_file.id, 'lock_version', v_launch.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- A Rebrief also carries the attachments forward (as in 20261012070400_brief_lifecycle.sql otherwise).
create or replace function api.rebrief(p_brief_id uuid, p_reason text, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('brief_id', p_brief_id, 'reason', p_reason,
    'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_brief brief.briefs;
  v_previous brief.brief_versions;
  v_version brief.brief_versions;
  v_carried integer;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if coalesce(trim(p_reason), '') = '' or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'reason', case when coalesce(trim(p_reason), '') = '' then 'Say why the Brief is changing' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'rebrief', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select * into v_brief from brief.briefs where id = p_brief_id for update;
  if v_brief.id is null or v_brief.archived_at is not null then
    perform app.fail('not_found');
  end if;
  if v_brief.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_brief.lock_version));
  end if;
  if exists (select 1 from brief.brief_versions where brief_id = p_brief_id and state = 'editing') then
    perform app.fail('conflict', jsonb_build_object('reason', 'not_handed_off_yet'));
  end if;

  select * into v_previous from brief.brief_versions
  where brief_id = p_brief_id order by version_number desc limit 1;

  insert into brief.brief_versions (brief_id, version_number, product_id, avatar_id, angle_id, funnel_stage_id,
    initiative_id, key_message, cta, cta_none, hypothesis, rebrief_reason)
  values (p_brief_id, v_previous.version_number + 1, v_previous.product_id, v_previous.avatar_id, v_previous.angle_id,
    v_previous.funnel_stage_id, v_previous.initiative_id, v_previous.key_message, v_previous.cta, v_previous.cta_none,
    v_previous.hypothesis, trim(p_reason))
  returning * into v_version;
  -- The new version starts with the attachments the last one had (PD-26).
  insert into brief.attachments (brief_version_id, file_id, link_url, label, role, added_by, added_at)
  select v_version.id, file_id, link_url, label, role, added_by, added_at
  from brief.attachments where brief_version_id = v_previous.id and removed_at is null order by added_at;
  get diagnostics v_carried = row_count;
  update brief.briefs set lock_version = lock_version + 1 where id = p_brief_id returning * into v_brief;

  perform app.record_event(v_caller.id, 'member', 'brief', v_brief.id, v_brief.lock_version, 'brief_rebriefed',
    jsonb_build_object('brief_version_id', v_version.id, 'version_number', v_version.version_number, 'attachments_carried', v_carried),
    v_correlation_id, trim(p_reason));

  return app.remember_result(v_caller.id, 'rebrief', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_brief.id, 'brief_version_id', v_version.id, 'lock_version', v_brief.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

reset role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select bucket, bucket, false, (rules ->> 'limit')::bigint, array(select jsonb_object_keys(rules -> 'types'))
from (values ('brief-attachments', app.upload_rules('brief_attachment')), ('launch-thumbnails', app.upload_rules('launch_thumbnail'))) as b (bucket, rules);

create policy uploads_into_open_slots on storage.objects for insert to authenticated
  with check (bucket_id in ('brief-attachments', 'launch-thumbnails') and app.upload_slot_open(bucket_id, name));
create policy checked_files_readable on storage.objects for select to authenticated
  using (bucket_id in ('brief-attachments', 'launch-thumbnails') and app.stored_file_readable(bucket_id, name));

grant execute on function app.upload_slot_open(text, text) to authenticated;
grant execute on function app.stored_file_readable(text, text) to authenticated;
grant execute on function api.create_upload_intent(text, uuid, text, bigint, text, uuid) to authenticated;
grant execute on function api.complete_upload(uuid) to authenticated;
grant execute on function worker.record_file_verification(uuid, jsonb) to service_role;
grant execute on function api.add_brief_attachment(uuid, jsonb, uuid) to authenticated;
grant execute on function api.remove_brief_attachment(uuid) to authenticated;
grant execute on function api.set_launch_thumbnail(uuid, uuid, integer, uuid) to authenticated;
