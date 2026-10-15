-- Drive change checks (D-69, PD-25; TRD §4.1 core.file_checks, §7.1 T-19). The Drive check reads each Version file's
-- metadata again and records what it saw, append-only. A file whose revision, checksum or size differs is `changed`;
-- one in the trash is `trashed`; one not found or not shared is `inaccessible`. A new flag is logged and routed to the
-- Creative Owner; while it stands, the Version cannot be submitted, approved or used for a new Launch (those commands
-- already refuse any file whose drift state isn't `unchanged`). A flag clears only when a later check finds the
-- recorded identity again. Lost folder access also asks the Admin to share it again. Until the Drive integration (B2),
-- tests stand in for the Drive check Edge Function and pass Drive API v3 file metadata as Google returns it.

create table core.file_checks (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references core.files (id),
  checked_at timestamptz not null default clock_timestamp(),
  access text not null check (access in ('ok', 'not_found', 'permission_denied')),
  observed_revision_id text,
  observed_drive_version bigint,
  observed_checksum text,
  observed_checksum_algorithm text check (observed_checksum_algorithm in ('sha256', 'md5')),
  observed_bytes bigint,
  trashed boolean,
  outcome text not null check (outcome in ('unchanged', 'changed', 'trashed', 'inaccessible'))
);
create index file_checks_by_file on core.file_checks (file_id, checked_at desc);
create trigger file_checks_immutable before update or delete on core.file_checks for each row execute function app.refuse_change();

alter table core.file_checks enable row level security;
grant select, insert on core.file_checks to api_owner;
create policy file_checks_commands on core.file_checks to api_owner using (true) with check (true);
grant select on core.file_checks to authenticated;
create policy file_checks_read on core.file_checks for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Records one Drive check of a registered Version file and returns its outcome (T-19). p_observed is the Drive API's
-- file metadata (headRevisionId, version, sha256Checksum, md5Checksum, size, trashed), or {"access": "not_found"} or
-- {"access": "permission_denied"} when Drive refused.
create function worker.record_drive_check(p_file_id uuid, p_observed jsonb) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := set_config('app.correlation_id', gen_random_uuid()::text, true)::uuid;
  v_file core.files;
  v_access text := coalesce(p_observed ->> 'access', 'ok');
  v_algorithm text;
  v_checksum text;
  v_outcome text;
  v_was text;
  v_variant creative.variants;
  v_event uuid;
begin
  if v_access not in ('ok', 'not_found', 'permission_denied') then
    raise exception 'unknown Drive access result %', v_access;
  end if;
  select * into v_file from core.files where id = p_file_id for update;
  if v_file.id is null or v_file.provider <> 'google_drive' or v_file.verification_state <> 'ready' then
    raise exception 'file % is not a registered Drive file', p_file_id;
  end if;
  -- Compare like with like: the recorded checksum's algorithm, preferring SHA-256 (T-19).
  v_algorithm := coalesce(v_file.checksum_algorithm, case when p_observed ? 'sha256Checksum' then 'sha256' else 'md5' end);
  v_checksum := case v_algorithm when 'sha256' then p_observed ->> 'sha256Checksum' else p_observed ->> 'md5Checksum' end;
  v_outcome := case
    when v_access <> 'ok' then 'inaccessible'
    when coalesce((p_observed ->> 'trashed')::boolean, false) then 'trashed'
    when p_observed ->> 'headRevisionId' is distinct from v_file.drive_revision_id
      or v_checksum is distinct from v_file.checksum
      or (p_observed ->> 'size')::bigint is distinct from v_file.bytes then 'changed'
    else 'unchanged' end;

  insert into core.file_checks (file_id, access, observed_revision_id, observed_drive_version, observed_checksum, observed_checksum_algorithm,
    observed_bytes, trashed, outcome)
  values (p_file_id, v_access, p_observed ->> 'headRevisionId', (p_observed ->> 'version')::bigint, v_checksum,
    case when v_checksum is not null then v_algorithm end, (p_observed ->> 'size')::bigint, (p_observed ->> 'trashed')::boolean, v_outcome);

  v_was := coalesce(v_file.drift_state, 'unchanged');
  update core.files set drift_state = v_outcome, last_checked_at = now() where id = p_file_id;
  select * into v_variant from creative.variants where id = v_file.variant_id;

  if v_outcome <> 'unchanged' and v_was = 'unchanged' then
    v_event := app.record_event(null, 'worker', 'file', p_file_id, null, 'drive_file_flagged',
      jsonb_build_object('outcome', v_outcome, 'variant_id', v_variant.id, 'drive_file_id', v_file.drive_file_id), v_correlation_id);
    perform app.notify(v_event, 'drive_file_flagged', format('Check %s''s Drive file: %s', v_variant.code, case v_outcome
        when 'changed' then 'it changed after it was registered' when 'trashed' then 'it is in the Drive trash' else 'the workstation can no longer read it' end),
      'file', p_file_id,
      array[(select creative_owner_id from creative.creatives where id = v_variant.creative_id)],
      jsonb_build_object('variant_code', v_variant.code, 'outcome', v_outcome));
  elsif v_outcome = 'unchanged' and v_was <> 'unchanged' then
    perform app.record_event(null, 'worker', 'file', p_file_id, null, 'drive_file_restored',
      jsonb_build_object('was', v_was, 'variant_id', v_variant.id), v_correlation_id);
    perform app.close_tasks('drive_file_flagged', p_file_id);
  end if;

  -- Revoked access: one open task for each Admin to share the folder again, closed only once no file's latest check
  -- is refused, so one file moved out of the folder doesn't open and close it all day (T-19). Checks take turns here.
  if v_access = 'permission_denied' or exists (select 1 from work.tasks where kind = 'drive_access_lost' and done_at is null) then
    perform pg_advisory_xact_lock(hashtextextended('drive_access_lost', 0));
    if v_access = 'permission_denied' and not exists (select 1 from work.tasks where kind = 'drive_access_lost' and done_at is null) then
      v_event := app.record_event(null, 'worker', 'file', p_file_id, null, 'drive_access_lost', jsonb_build_object('drive_file_id', v_file.drive_file_id), v_correlation_id);
      perform app.notify(v_event, 'drive_access_lost', 'Share the Version files folder with the workstation again: Drive refused access',
        'file', p_file_id, array(select id from core.members where is_admin and active and archived_at is null), '{}'::jsonb);
    elsif v_access = 'ok' and not exists (
        select 1 from core.files f
        where f.provider = 'google_drive' and f.drift_state = 'inaccessible'
          and (select fc.access from core.file_checks fc where fc.file_id = f.id order by fc.checked_at desc, fc.id desc limit 1) = 'permission_denied') then
      update work.tasks set done_at = now() where kind = 'drive_access_lost' and done_at is null;
    end if;
  end if;
  return v_outcome;
end;
$$;

-- The Version files the scheduled check reads (proposed scope, PD-25): Versions with an open Review, approved
-- Versions still in effect, Versions behind a planned or live Launch, and files cited as Evidence.
create function worker.drive_files_to_check() returns table (file_id uuid, drive_file_id text, why text[])
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.drive_file_id, array_agg(distinct w.why order by w.why)
  from core.files f
  join (
    select vf.file_id, 'open_review' as why from creative.version_files vf join review.reviews r on r.version_id = vf.version_id where r.decision is null
    union all
    select vf.file_id, 'approved' from creative.version_files vf where app.approval_state(vf.version_id) = 'in_effect'
    union all
    select vf.file_id, 'launched' from creative.version_files vf join launch.launches l on l.version_id = vf.version_id where l.status in ('planned', 'live')
    union all
    select (e ->> 'file_id')::uuid, 'evidence' from learning.plan_evidence pe cross join jsonb_array_elements(pe.files) e
  ) w on w.file_id = f.id
  where f.provider = 'google_drive' and f.verification_state = 'ready'
  group by f.id, f.drive_file_id;
$$;

-- Any member asks for a Version's files to be checked now, from its page (PD-25). Asking again while a check is
-- waiting queues nothing more.
create function api.request_drive_check(p_version_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_jobs uuid[];
begin
  perform app.require_member();
  if not exists (select 1 from creative.versions where id = p_version_id) then
    perform app.fail('not_found');
  end if;
  v_jobs := array(
    select app.enqueue_job('drive_check', jsonb_build_object('file_id', f.id, 'drive_file_id', f.drive_file_id), f.id::text)
    from creative.version_files vf join core.files f on f.id = vf.file_id
    where vf.version_id = p_version_id and f.provider = 'google_drive' and f.verification_state = 'ready');
  return jsonb_build_object('queued', cardinality(v_jobs), 'correlation_id', v_correlation_id);
end;
$$;

reset role;

-- Version files flagged by the Drive check, for data health and the Variant page (D-69).
create view reporting.drive_flags with (security_invoker = true) as
select f.id as file_id, f.drift_state, f.last_checked_at, va.id as variant_id, va.code as variant_code, v.id as version_id, v.version_number
from core.files f
join creative.version_files vf on vf.file_id = f.id
join creative.versions v on v.id = vf.version_id
join creative.variants va on va.id = v.variant_id
where f.provider = 'google_drive' and f.drift_state in ('changed', 'trashed', 'inaccessible');
grant select on reporting.drive_flags to authenticated;

grant execute on function worker.record_drive_check(uuid, jsonb), worker.drive_files_to_check() to service_role;
grant execute on function api.request_drive_check(uuid) to authenticated;
