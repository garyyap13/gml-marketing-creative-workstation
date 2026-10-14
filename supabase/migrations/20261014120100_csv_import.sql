-- CSV import of results for TikTok, Xiaohongshu and YouTube (D-36, D-55, D-59, D-76; TRD §8.3). The Marketing Team
-- uploads a CSV made from the workstation's template to a private import bucket, for one account entered by hand.
-- The import-csv Edge Function opens an import as the member (import_csv), reads the checked file with the secret key,
-- and hands the parsed rows to record_csv_import, which members cannot call, so the rows always come from the file.
-- Each usable row becomes that period's entry with the file as its provenance; every other row is set aside with the
-- reason. Imported data is never labelled as API data.

alter table core.files
  add column target_account_id uuid references launch.accounts (id),
  drop constraint files_upload_target,
  add constraint files_upload_target check ((kind <> 'brief_attachment' or target_brief_version_id is not null)
    and (kind <> 'launch_thumbnail' or target_launch_id is not null) and (kind <> 'csv_import' or target_account_id is not null));

create table ingest.csv_imports (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null unique references core.files (id), -- a file is imported once
  account_id uuid not null references launch.accounts (id),
  requested_by uuid not null references core.members (id),
  state text not null default 'pending' check (state in ('pending', 'imported', 'failed')),
  failure_reason text,
  run_id uuid references ingest.sync_runs (id),
  imported_rows integer not null default 0,
  set_aside_rows integer not null default 0,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table ingest.csv_imports enable row level security;
grant select, insert, update on ingest.csv_imports to api_owner;
create policy csv_imports_commands on ingest.csv_imports to api_owner using (true) with check (true);
grant select on ingest.csv_imports to authenticated;
create policy csv_imports_read on ingest.csv_imports for select to authenticated using ((select app.is_active_member()));

set role api_owner;

create or replace function app.upload_rules(p_kind text) returns jsonb
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
    when 'csv_import' then jsonb_build_object('bucket', 'csv-imports', 'limit', 5242880, 'limit_text', '5 MiB',
      'types_text', 'Upload a CSV file made from the template',
      'types', jsonb_build_object('text/csv', 'text'), 'endings', jsonb_build_object('text/csv', '["csv"]'::jsonb))
    when 'launch_thumbnail' then jsonb_build_object('bucket', 'launch-thumbnails', 'limit', 52428800, 'limit_text', '50 MiB',
      'types_text', 'Upload a JPEG, PNG, WebP or GIF picture',
      'types', jsonb_build_object('image/jpeg', 'jpeg', 'image/png', 'png', 'image/webp', 'webp', 'image/gif', 'gif'),
      'endings', jsonb_build_object('image/jpeg', '["jpg", "jpeg"]'::jsonb, 'image/png', '["png"]'::jsonb,
        'image/webp', '["webp"]'::jsonb, 'image/gif', '["gif"]'::jsonb))
  end;
$$;

create or replace function api.create_upload_intent(p_kind text, p_target_id uuid, p_name text, p_bytes bigint, p_mime text, p_idempotency_key uuid)
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
  v_account launch.accounts;
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
    v_errors := jsonb_build_object('kind', 'Upload a Brief attachment, a Launch thumbnail or a CSV import');
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
  elsif p_kind = 'csv_import' then
    -- A CSV import is for one account whose results are entered by hand (D-76).
    select * into v_account from launch.accounts where id = p_target_id and source = 'manual';
    if v_account.id is null then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('target', 'Choose a TikTok, Xiaohongshu or YouTube account')));
    end if;
  else
    select * into v_launch from launch.launches where id = p_target_id;
    if v_launch.id is null then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('target', 'Choose a Launch')));
    elsif v_launch.status not in ('planned', 'live') then
      perform app.fail('conflict', jsonb_build_object('reason', 'launch_closed'));
    end if;
  end if;

  insert into core.files (id, kind, provider, storage_bucket, storage_path, name, mime, bytes, registered_by, target_brief_version_id, target_launch_id,
    target_account_id)
  values (v_id, p_kind, 'supabase_storage', v_rules ->> 'bucket', p_target_id || '/' || v_id, trim(p_name), p_mime, p_bytes, v_caller.id,
    v_version.id, v_launch.id, v_account.id)
  returning * into v_file;
  perform app.record_event(v_caller.id, 'member', 'file', v_file.id, null, 'upload_started',
    jsonb_build_object('kind', p_kind, 'target_id', p_target_id, 'bytes', p_bytes, 'mime', p_mime), v_correlation_id);
  return app.remember_result(v_caller.id, 'create_upload_intent', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_file.id, 'bucket', v_file.storage_bucket, 'path', v_file.storage_path, 'correlation_id', v_correlation_id));
end;
$$;

-- The uploader, in the Marketing Team, opens the import of one checked CSV file (D-55). The import-csv Edge Function
-- calls this as the member, then reads the file and records its rows. An import that stopped before finishing (the
-- function crashed or timed out) can be opened again after 15 minutes.
create function api.import_csv(p_file_id uuid, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('file_id', p_file_id);
  v_replayed jsonb;
  v_file core.files;
  v_import ingest.csv_imports;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'import_csv', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  select * into v_file from core.files where id = p_file_id for update;
  if v_file.id is null or v_file.kind <> 'csv_import' or v_file.verification_state <> 'ready' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('file_id', 'Choose a checked CSV file')));
  end if;
  if v_file.registered_by is distinct from v_caller.id then
    perform app.fail('forbidden');
  end if;
  select * into v_import from ingest.csv_imports where file_id = p_file_id for update;
  if v_import.id is not null and (v_import.state <> 'pending' or v_import.created_at > now() - interval '15 minutes') then
    perform app.fail('conflict', jsonb_build_object('reason', case when v_import.state = 'pending' then 'import_in_progress' else 'already_imported' end));
  elsif v_import.id is not null then
    update ingest.csv_imports set created_at = now() where id = v_import.id returning * into v_import;
  else
    insert into ingest.csv_imports (file_id, account_id, requested_by)
    values (p_file_id, v_file.target_account_id, v_caller.id)
    returning * into v_import;
  end if;
  update core.files set attached_at = coalesce(attached_at, now()) where id = p_file_id;
  perform app.record_event(v_caller.id, 'member', 'file', p_file_id, null, 'csv_import_started',
    jsonb_build_object('import_id', v_import.id, 'account_id', v_import.account_id), v_correlation_id);
  return app.remember_result(v_caller.id, 'import_csv', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_import.id, 'bucket', v_file.storage_bucket, 'path', v_file.storage_path, 'correlation_id', v_correlation_id));
end;
$$;

-- Worker only: records the rows the import-csv Edge Function parsed from the file, or why the file can't be used.
-- p_rows: [{line, values: {column: text}, problem?}]. Numbers are plain digits with an optional decimal point, so a
-- locale's separators are never guessed at; dates are YYYY-MM-DD.
create function worker.record_csv_import(p_import_id uuid, p_rows jsonb, p_problem text default null) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_import ingest.csv_imports;
  v_account launch.accounts;
  v_run ingest.sync_runs;
  v_row jsonb;
  v_v jsonb;
  v_errors jsonb;
  v_messages text[];
  v_launch launch.launches;
  v_values jsonb;
  v_key text;
  v_from date;
  v_to date;
  v_channel text;
  v_seen jsonb := '{}'::jsonb;
  v_identity text;
  v_imported integer := 0;
  v_set_aside integer := 0;
  v_matches integer;
begin
  select * into v_import from ingest.csv_imports where id = p_import_id for update;
  if v_import.id is null then
    perform app.fail('not_found');
  end if;
  if v_import.state <> 'pending' then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_imported'));
  end if;
  if p_problem is not null then
    update ingest.csv_imports set state = 'failed', failure_reason = p_problem, finished_at = now() where id = p_import_id;
    perform app.record_event(null, 'worker', 'file', v_import.file_id, null, 'csv_import_failed', jsonb_build_object('reason', p_problem), v_correlation_id);
    return jsonb_build_object('imported', 0, 'set_aside', 0, 'failure_reason', p_problem);
  end if;

  select * into v_account from launch.accounts where id = v_import.account_id for update;
  insert into ingest.sync_runs (account_id, generation, kind, state, entered_by, file_id)
  values (v_account.id, coalesce((select max(generation) from ingest.sync_runs where account_id = v_account.id), 0) + 1, 'csv_import', 'running',
    v_import.requested_by, v_import.file_id)
  returning * into v_run;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_v := coalesce(v_row -> 'values', '{}'::jsonb);
    v_errors := '{}'::jsonb;
    v_messages := '{}';
    v_launch := null;
    v_values := '{}'::jsonb;
    if v_row ->> 'problem' is not null then
      v_messages := array[v_row ->> 'problem'];
    else
      -- Figures: plain numbers only.
      foreach v_key in array array['spend', 'views', 'clicks', 'results', 'reach', 'likes', 'comments', 'shares', 'saves'] loop
        if coalesce(trim(v_v ->> v_key), '') = '' then
          continue;
        elsif trim(v_v ->> v_key) !~ '^[0-9]+([.][0-9]+)?$' then
          v_errors := v_errors || jsonb_build_object(v_key, 'Write numbers without commas or currency signs');
        else
          v_values := v_values || jsonb_build_object(v_key, trim(v_v ->> v_key)::numeric);
        end if;
      end loop;
      if coalesce(trim(v_v ->> 'result_type'), '') <> '' then
        v_values := v_values || jsonb_build_object('result_type', lower(trim(v_v ->> 'result_type')));
      end if;
      v_channel := case lower(trim(coalesce(v_v ->> 'channel', ''))) when 'organic' then 'organic_only' when 'paid' then 'paid_only' when 'both' then 'combined' end;
      if v_channel is null then
        v_errors := v_errors || jsonb_build_object('channel', 'organic, paid or both');
      end if;
      v_from := null;
      v_to := null;
      if coalesce(v_v ->> 'period_start', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and coalesce(v_v ->> 'period_end', '') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        begin
          v_from := (v_v ->> 'period_start')::date;
          v_to := (v_v ->> 'period_end')::date;
        exception when others then
          v_from := null;
        end;
      end if;
      if v_from is null or v_to is null or v_from > v_to or v_to > (now() at time zone coalesce(v_account.time_zone, 'UTC'))::date or v_to - v_from > 366 then
        v_errors := v_errors || jsonb_build_object('period', 'A period of up to a year that has already ended or ends today');
      end if;
      if coalesce(trim(v_v ->> 'currency'), '') <> '' and upper(trim(v_v ->> 'currency')) is distinct from v_account.currency then
        v_errors := v_errors || jsonb_build_object('currency', 'This account''s currency is ' || coalesce(v_account.currency, 'not set'));
      end if;
      if v_errors = '{}'::jsonb then
        v_errors := app.manual_values_errors(v_values, v_account.currency is not null, v_channel);
      end if;
      if v_errors <> '{}'::jsonb then
        v_messages := array(select key || ': ' || (value #>> '{}') from jsonb_each(v_errors) order by key);
      else
        -- The Launch: by its post link, or by the Variant's one live or ended Launch on this account.
        if coalesce(trim(v_v ->> 'post_link'), '') <> '' then
          select * into v_launch from launch.launches
          where account_id = v_account.id and post_link_key = app.post_link_key(trim(v_v ->> 'post_link')) and status in ('live', 'ended');
          if v_launch.id is null then
            v_messages := array['No live or ended Launch on this account has this post link'];
          elsif coalesce(trim(v_v ->> 'variant_code'), '') <> ''
              and upper(trim(v_v ->> 'variant_code')) is distinct from (select code from creative.variants where id = v_launch.variant_id) then
            v_messages := array['The post link and the Variant code point at different Launches'];
            v_launch := null;
          end if;
        elsif coalesce(trim(v_v ->> 'variant_code'), '') <> '' then
          select count(*) into v_matches from launch.launches l join creative.variants va on va.id = l.variant_id
          where l.account_id = v_account.id and va.code = upper(trim(v_v ->> 'variant_code')) and l.status in ('live', 'ended');
          if v_matches = 1 then
            select l.* into v_launch from launch.launches l join creative.variants va on va.id = l.variant_id
            where l.account_id = v_account.id and va.code = upper(trim(v_v ->> 'variant_code')) and l.status in ('live', 'ended');
          else
            v_messages := array[case when v_matches = 0 then 'This Variant has no live or ended Launch on this account'
              else 'This Variant has several Launches on this account; give the post link instead' end];
          end if;
        else
          v_messages := array['Give the post link or the Variant code'];
        end if;
      end if;
      -- One authoritative row per Launch, period and channel in a file; a second one is set aside, never added (§8.3).
      if v_launch.id is not null then
        v_identity := v_launch.id || '|' || v_from || '|' || v_to || '|' || v_channel;
        if v_seen ? v_identity then
          v_messages := array['The same Launch, period and channel as line ' || (v_seen ->> v_identity)];
        else
          v_seen := v_seen || jsonb_build_object(v_identity, v_row ->> 'line');
        end if;
      end if;
    end if;

    if cardinality(v_messages) > 0 then
      insert into ingest.quarantine_rows (run_id, row_locator, payload, error)
      values (v_run.id, 'line ' || coalesce(v_row ->> 'line', '?'), v_v, array_to_string(v_messages, '; '));
      v_set_aside := v_set_aside + 1;
    else
      perform app.record_period_results(v_run, v_launch, v_account, v_from, v_to, v_channel, v_values, 'csv_import');
      v_imported := v_imported + 1;
    end if;
  end loop;

  update ingest.sync_runs set state = 'published', published_at = now(),
    counts = jsonb_build_object('imported', v_imported, 'quarantined', v_set_aside)
  where id = v_run.id;
  update ingest.csv_imports set state = 'imported', run_id = v_run.id, imported_rows = v_imported, set_aside_rows = v_set_aside, finished_at = now()
  where id = p_import_id;
  perform app.record_event(null, 'worker', 'file', v_import.file_id, null, 'csv_imported',
    jsonb_build_object('import_id', p_import_id, 'imported', v_imported, 'set_aside', v_set_aside), v_correlation_id);
  return jsonb_build_object('imported', v_imported, 'set_aside', v_set_aside, 'run_id', v_run.id);
end;
$$;

reset role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select 'csv-imports', 'csv-imports', false, (app.upload_rules('csv_import') ->> 'limit')::bigint, array['text/csv'];

drop policy uploads_into_open_slots on storage.objects;
drop policy checked_files_readable on storage.objects;
create policy uploads_into_open_slots on storage.objects for insert to authenticated
  with check (bucket_id in ('brief-attachments', 'launch-thumbnails', 'csv-imports') and app.upload_slot_open(bucket_id, name));
create policy checked_files_readable on storage.objects for select to authenticated
  using (bucket_id in ('brief-attachments', 'launch-thumbnails', 'csv-imports') and app.stored_file_readable(bucket_id, name));

-- Set-aside rows now also say what kind of run set them aside: a sync, or a CSV import (as in
-- 20261014100000_ad_resolution.sql, plus the run's kind).
create or replace view reporting.sync_problems with (security_invoker = true) as
select q.id, r.account_id, r.generation, q.row_locator, q.error, q.resolution, q.created_at, r.kind as run_kind
from ingest.quarantine_rows q
join ingest.sync_runs r on r.id = q.run_id;

-- Each CSV import, with its file, account, outcome and counts.
create view reporting.csv_imports with (security_invoker = true) as
select i.id, i.file_id, f.name as file_name, i.account_id, i.requested_by, i.state, i.failure_reason, i.imported_rows, i.set_aside_rows,
  r.generation, i.created_at, i.finished_at
from ingest.csv_imports i
join core.files f on f.id = i.file_id
left join ingest.sync_runs r on r.id = i.run_id;

grant select on reporting.csv_imports to authenticated;
grant execute on function api.import_csv(uuid, uuid) to authenticated;
grant execute on function worker.record_csv_import(uuid, jsonb, text) to service_role;
