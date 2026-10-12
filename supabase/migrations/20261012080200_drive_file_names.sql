-- Keep the Drive file's name, so people can tell registered files apart when choosing what to submit.

alter table core.files add column name text;

set role api_owner;

-- Worker only: records what the Drive API reports for a registered file (fields as in Drive's files.get).
-- A video stays 'verifying' until Drive reports its duration (T-19).
create or replace function worker.record_drive_metadata(p_file_id uuid, p_metadata jsonb)
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
    name = p_metadata ->> 'name',
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
