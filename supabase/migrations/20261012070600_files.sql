-- Files (D-52, D-64, D-65, D-69; T-05, T-19). Version files stay in Google Drive and are registered, not
-- uploaded; the Drive worker records their identity. Storage uploads arrive in A1b.

create table core.files (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('version_media', 'brief_attachment', 'launch_thumbnail', 'csv_import')),
  provider text not null check (provider in ('google_drive', 'supabase_storage')),
  variant_id uuid references creative.variants (id),
  storage_bucket text,
  storage_path text,
  drive_file_id text,
  drive_revision_id text,
  drive_version bigint,
  checksum text,
  checksum_algorithm text check (checksum_algorithm in ('sha256', 'md5')),
  mime text,
  bytes bigint,
  width integer,
  height integer,
  duration_ms bigint check (duration_ms > 0),
  verification_state text not null default 'pending' check (verification_state in ('pending', 'verifying', 'ready', 'failed')),
  failure_reason text,
  drift_state text check (drift_state in ('unchanged', 'changed', 'trashed', 'inaccessible')),
  last_checked_at timestamptz,
  registered_by uuid references core.members (id),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  attached_at timestamptz,
  constraint files_provider_by_kind check ((kind = 'version_media') = (provider = 'google_drive')),
  constraint files_drive_identity check (provider <> 'google_drive' or (drive_file_id is not null and variant_id is not null)),
  constraint files_ready_identity check (verification_state <> 'ready' or (checksum is not null and mime is not null))
);
create index files_by_variant on core.files (variant_id);
create index files_by_drive_file on core.files (drive_file_id);
-- A Drive file backs at most one Version (D-69): only one attached row per Drive file ID.
create unique index files_one_attached_per_drive_file on core.files (drive_file_id) where attached_at is not null;

alter table core.files enable row level security;
grant select, insert, update on core.files to api_owner;
create policy files_commands on core.files to api_owner using (true) with check (true);
grant select on core.files to authenticated;
create policy files_read on core.files for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Registers a Drive file as a candidate Version file for a never-live Variant (T-19).
create function api.register_drive_media(p_variant_id uuid, p_drive_ref text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('variant_id', p_variant_id, 'drive_ref', p_drive_ref);
  v_replayed jsonb;
  v_ref text := trim(coalesce(p_drive_ref, ''));
  v_drive_file_id text;
  v_variant creative.variants;
  v_file core.files;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;

  if v_ref ~* 'drive\.google\.com/(drive/)?(u/[0-9]+/)?folders/' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('drive_ref', 'This is a folder link. Paste the link to the file itself')));
  end if;
  if v_ref ~* '(docs|sheets|slides)\.google\.com/' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('drive_ref', 'This is a Google Docs, Sheets or Slides file, not a video or image')));
  end if;
  v_drive_file_id := coalesce(
    substring(v_ref from '/file/d/([A-Za-z0-9_-]{10,})'),
    substring(v_ref from '[?&]id=([A-Za-z0-9_-]{10,})'),
    case when v_ref ~ '^[A-Za-z0-9_-]{20,}$' then v_ref end);
  if v_drive_file_id is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('drive_ref', 'Paste a Google Drive file link')));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'register_drive_media', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select * into v_variant from creative.variants where id = p_variant_id;
  if v_variant.id is null then
    perform app.fail('not_found');
  end if;
  if v_variant.live_at is not null or v_variant.state = 'cancelled' then
    perform app.fail('conflict', jsonb_build_object('reason', 'variant_is_live_or_cancelled'));
  end if;
  -- A Drive file backs at most one Version (D-69): new content needs a new Drive file.
  if exists (
    select 1 from core.files f join creative.version_files vf on vf.file_id = f.id
    where f.drive_file_id = v_drive_file_id) then
    perform app.fail('conflict', jsonb_build_object('fieldErrors',
      jsonb_build_object('drive_ref', 'This Drive file is already used by a Version. Upload new content as a new file')));
  end if;

  insert into core.files (kind, provider, variant_id, drive_file_id, registered_by)
  values ('version_media', 'google_drive', p_variant_id, v_drive_file_id, v_caller.id)
  returning * into v_file;

  perform app.record_event(v_caller.id, 'member', 'file', v_file.id, null, 'drive_file_registered',
    jsonb_build_object('variant_id', p_variant_id, 'drive_file_id', v_drive_file_id), v_correlation_id);

  return app.remember_result(v_caller.id, 'register_drive_media', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_file.id, 'verification_state', v_file.verification_state, 'correlation_id', v_correlation_id));
end;
$$;

-- Worker only: records what the Drive API reports for a registered file (fields as in Drive's files.get).
-- A video stays 'verifying' until Drive reports its duration (T-19).
create function worker.record_drive_metadata(p_file_id uuid, p_metadata jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_file core.files;
  v_media_kind text;
  v_mime text := p_metadata ->> 'mimeType';
  v_media jsonb := coalesce(p_metadata -> 'videoMediaMetadata', p_metadata -> 'imageMediaMetadata');
  v_algorithm text := case
    when p_metadata ->> 'sha256Checksum' is not null then 'sha256'
    when p_metadata ->> 'md5Checksum' is not null then 'md5'
  end;
  v_bytes bigint := (p_metadata ->> 'size')::bigint;
  v_state text := 'ready';
  v_reason text;
begin
  select * into v_file from core.files where id = p_file_id for update;
  if v_file.id is null or v_file.provider <> 'google_drive' then
    perform app.fail('not_found');
  end if;
  if v_file.verification_state not in ('pending', 'verifying') then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_verified'));
  end if;
  if p_metadata ->> 'id' is distinct from v_file.drive_file_id then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('id', 'Details are for a different Drive file')));
  end if;

  v_media_kind := app.format_media_kind((select creative_id from creative.variants where id = v_file.variant_id));
  if coalesce(v_mime, '') like 'application/vnd.google-apps.%' then
    v_state := 'failed'; v_reason := 'not_a_media_file';
  elsif coalesce((p_metadata ->> 'trashed')::boolean, false) then
    v_state := 'failed'; v_reason := 'trashed';
  elsif (v_media_kind = 'video' and coalesce(v_mime, '') not like 'video/%')
     or (v_media_kind in ('image', 'carousel') and coalesce(v_mime, '') not like 'image/%')
     or (v_media_kind is null and coalesce(v_mime, '') not like 'video/%' and coalesce(v_mime, '') not like 'image/%') then
    v_state := 'failed'; v_reason := 'wrong_type';
  elsif v_algorithm is null then
    v_state := 'failed'; v_reason := 'no_checksum';
  elsif (v_mime like 'video/%' and v_bytes > 1073741824) or (v_mime like 'image/%' and v_bytes > 52428800) then
    v_state := 'failed'; v_reason := 'too_large'; -- proposed limits: 1 GiB per video, 50 MiB per image (D-47)
  elsif (v_mime like 'video/%' and v_media ->> 'durationMillis' is null)
     or (v_mime like 'image/%' and v_media ->> 'width' is null) then
    v_state := 'verifying'; -- Drive is still processing the file
  end if;

  update core.files set
    verification_state = v_state,
    failure_reason = v_reason,
    drive_revision_id = p_metadata ->> 'headRevisionId',
    drive_version = (p_metadata ->> 'version')::bigint,
    checksum = coalesce(p_metadata ->> 'sha256Checksum', p_metadata ->> 'md5Checksum'),
    checksum_algorithm = v_algorithm,
    mime = v_mime,
    bytes = v_bytes,
    width = (v_media ->> 'width')::integer,
    height = (v_media ->> 'height')::integer,
    duration_ms = (v_media ->> 'durationMillis')::bigint,
    verified_at = case when v_state = 'ready' then now() end,
    drift_state = case when v_state = 'ready' then 'unchanged' end,
    last_checked_at = now()
  where id = p_file_id
  returning * into v_file;

  if v_state <> 'verifying' then
    perform app.record_event(null, 'worker', 'file', v_file.id, null, 'drive_file_' || v_state,
      jsonb_strip_nulls(jsonb_build_object('failure_reason', v_reason, 'checksum', v_file.checksum,
        'drive_revision_id', v_file.drive_revision_id)), v_correlation_id);
  end if;

  return jsonb_build_object('id', v_file.id, 'verification_state', v_file.verification_state,
    'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.register_drive_media(uuid, text, uuid) to authenticated;
grant execute on function worker.record_drive_metadata(uuid, jsonb) to service_role;
