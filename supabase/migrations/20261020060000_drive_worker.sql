-- The real Drive worker (B2; D-65, D-69, D-80; TRD T-19). Registering a Drive file now queues a `drive_register` job.
-- The drive-worker Edge Function reads the file's metadata from Drive and reports it through
-- worker.record_drive_metadata, the call the tests' Drive stand-in makes. When Drive can't give the details, the
-- worker fails the registration with a reason the Variant page explains. The change check queues one `drive_check`
-- job per due file, which the same function reads and reports through worker.record_drive_check.

-- The list of files due a check moves to app, so worker functions can share it: api_owner owns the worker functions
-- but has no usage on that schema.
alter function worker.drive_files_to_check() set schema app;
revoke execute on function app.drive_files_to_check() from service_role;

set role api_owner;

-- As before, and the registration is queued for the Drive worker.
create or replace function api.register_drive_media(p_variant_id uuid, p_drive_ref text, p_idempotency_key uuid)
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
  perform app.enqueue_job('drive_register', jsonb_build_object('file_id', v_file.id, 'drive_file_id', v_drive_file_id), v_file.id::text);

  perform app.record_event(v_caller.id, 'member', 'file', v_file.id, null, 'drive_file_registered',
    jsonb_build_object('variant_id', p_variant_id, 'drive_file_id', v_drive_file_id), v_correlation_id);

  return app.remember_result(v_caller.id, 'register_drive_media', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_file.id, 'verification_state', v_file.verification_state, 'correlation_id', v_correlation_id));
end;
$$;

-- Worker only: Drive couldn't give a registered file's details (T-19). `not_found`: Drive has no such file shared with
-- the workstation, so the link is wrong or the file isn't in the Version files folder. `still_processing`: a video's
-- duration still hadn't appeared after about an hour. `not_read`: Drive kept failing or refused the workstation.
-- The member registers the file again; a decided registration is left as it is.
create function worker.fail_drive_registration(p_file_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_file core.files;
begin
  if p_reason is null or p_reason not in ('not_found', 'still_processing', 'not_read') then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('reason', 'Unknown reason')));
  end if;
  select * into v_file from core.files where id = p_file_id for update;
  if v_file.id is null or v_file.provider <> 'google_drive' then
    perform app.fail('not_found');
  end if;
  if v_file.verification_state not in ('pending', 'verifying') then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_verified'));
  end if;

  update core.files set verification_state = 'failed', failure_reason = p_reason, last_checked_at = now()
  where id = p_file_id
  returning * into v_file;
  perform app.record_event(null, 'worker', 'file', v_file.id, null, 'drive_file_failed',
    jsonb_build_object('failure_reason', p_reason), v_correlation_id);

  return jsonb_build_object('id', v_file.id, 'verification_state', v_file.verification_state, 'correlation_id', v_correlation_id);
end;
$$;

-- Workers still call worker.drive_files_to_check; the list itself now lives in app (above).
create function worker.drive_files_to_check() returns table (file_id uuid, drive_file_id text, why text[])
language sql
stable
security definer
set search_path = ''
as $$
  select * from app.drive_files_to_check();
$$;

-- The scheduled change check (D-80): one `drive_check` job per file due a check, unless one is already waiting.
-- Returns how many files are due.
create function worker.queue_drive_checks() returns integer
language sql
security definer
set search_path = ''
as $$
  select count(app.enqueue_job('drive_check', jsonb_build_object('file_id', d.file_id, 'drive_file_id', d.drive_file_id), d.file_id::text))::integer
  from app.drive_files_to_check() d;
$$;

reset role;

-- Registrations made before the worker existed are queued too.
select app.enqueue_job('drive_register', jsonb_build_object('file_id', id, 'drive_file_id', drive_file_id), id::text)
from core.files
where provider = 'google_drive' and verification_state in ('pending', 'verifying');

grant execute on function worker.fail_drive_registration(uuid, text), worker.drive_files_to_check(), worker.queue_drive_checks() to service_role;
