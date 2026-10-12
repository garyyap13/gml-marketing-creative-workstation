-- Video annotations (D-60, D-68; FR-16, T-17): the measured duration, timed transcript and Content Sections of an
-- exact video Version, kept as append-only revisions so corrections never rewrite what was cited before.

create table creative.annotation_revisions (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references creative.versions (id),
  file_id uuid not null references core.files (id),
  revision_number integer not null check (revision_number >= 1),
  prior_revision_id uuid references creative.annotation_revisions (id),
  source text not null check (source in ('manual', 'import', 'automatic')),
  source_reference text,
  language text,
  transcript_state text not null check (transcript_state in ('not_started', 'draft', 'reviewed', 'no_speech')),
  section_state text not null check (section_state in ('not_started', 'draft', 'reviewed')),
  created_by uuid not null references core.members (id),
  created_at timestamptz not null default now(),
  unique (version_id, file_id, revision_number)
);

create table creative.transcript_cues (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references creative.annotation_revisions (id),
  sequence integer not null,
  start_ms bigint not null,
  end_ms bigint not null,
  text text not null,
  speaker text,
  unique (revision_id, sequence),
  check (0 <= start_ms and start_ms < end_ms)
);

create table creative.content_sections (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references creative.annotation_revisions (id),
  sequence integer not null,
  section_type text not null check (section_type in ('hook', 'body', 'cta', 'other')),
  detail_label text check (detail_label in ('problem', 'solution', 'demo', 'benefit', 'proof', 'objection', 'offer')),
  start_ms bigint not null,
  end_ms bigint not null,
  on_screen_text text,
  notes text,
  unique (revision_id, sequence),
  check (0 <= start_ms and start_ms < end_ms)
);

alter table creative.annotation_revisions enable row level security;
alter table creative.transcript_cues enable row level security;
alter table creative.content_sections enable row level security;
-- Append-only: the command role can add revisions but never change them.
grant select, insert on creative.annotation_revisions, creative.transcript_cues, creative.content_sections to api_owner;
create policy annotation_revisions_commands on creative.annotation_revisions to api_owner using (true) with check (true);
create policy transcript_cues_commands on creative.transcript_cues to api_owner using (true) with check (true);
create policy content_sections_commands on creative.content_sections to api_owner using (true) with check (true);
grant select on creative.annotation_revisions, creative.transcript_cues, creative.content_sections to authenticated;
create policy annotation_revisions_read on creative.annotation_revisions for select to authenticated using ((select app.is_active_member()));
create policy transcript_cues_read on creative.transcript_cues for select to authenticated using ((select app.is_active_member()));
create policy content_sections_read on creative.content_sections for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- A video time for messages: 30040 → '00:30.04'.
create function app.format_ms(p_ms numeric) returns text
language sql
immutable
set search_path = ''
as $$
  select lpad(floor(p_ms / 60000)::text, 2, '0') || ':' || lpad(floor(mod(p_ms, 60000) / 1000)::text, 2, '0')
    || case when mod(p_ms, 1000) > 0 then '.' || rtrim(lpad(mod(p_ms, 1000)::text, 3, '0'), '0') else '' end;
$$;

-- Field errors for a set of annotations against the video's measured duration (T-17): half-open intervals
-- [start_ms, end_ms) inside the video; Content Sections never overlap; one speaker's cues never overlap,
-- though two speakers may talk at once. Each message names the first cue or section at fault by its position
-- in the list as sent, so a long imported transcript can be fixed without a hunt.
create function app.annotation_errors(p_annotations jsonb, p_duration_ms bigint) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_errors jsonb := '{}'::jsonb;
  v_cues jsonb := coalesce(p_annotations -> 'cues', '[]'::jsonb);
  v_sections jsonb := coalesce(p_annotations -> 'sections', '[]'::jsonb);
  v_source text := coalesce(p_annotations ->> 'source', 'manual');
  v_transcript_state text := coalesce(p_annotations ->> 'transcript_state', 'draft');
  v_section_state text := coalesce(p_annotations ->> 'section_state', 'draft');
  v_end text := app.format_ms(p_duration_ms);
  v_problem text;
begin
  if jsonb_typeof(p_annotations) is distinct from 'object' or jsonb_typeof(v_cues) <> 'array' or jsonb_typeof(v_sections) <> 'array' then
    return jsonb_build_object('annotations', 'Provide the transcript cues and sections as lists');
  end if;

  if jsonb_typeof(p_annotations -> 'language') not in ('string', 'null') or length(p_annotations ->> 'language') > 35 then
    v_errors := v_errors || jsonb_build_object('language', 'Choose the spoken language');
  end if;

  -- V1 has no automatic transcription (D-68); an import records which subtitle file it came from.
  if v_source not in ('manual', 'import') then
    v_errors := v_errors || jsonb_build_object('source', 'Type the transcript or import a subtitle file');
  elsif jsonb_typeof(p_annotations -> 'source_reference') not in ('string', 'null') or length(p_annotations ->> 'source_reference') > 500 then
    v_errors := v_errors || jsonb_build_object('source', 'The subtitle file reference is not valid');
  elsif v_source = 'import' and coalesce(trim(p_annotations ->> 'source_reference'), '') = '' then
    v_errors := v_errors || jsonb_build_object('source', 'Record the subtitle file the cues came from');
  end if;

  -- "Not transcribed yet" and "no speech" both have no cues but mean different things; a reviewed transcript has
  -- words, and imported subtitles start as a draft because they can include on-screen text that is not speech.
  if v_transcript_state not in ('not_started', 'draft', 'reviewed', 'no_speech') then
    v_errors := v_errors || jsonb_build_object('transcript_state', 'Choose a transcript state');
  elsif v_transcript_state in ('not_started', 'no_speech') and jsonb_array_length(v_cues) > 0 then
    v_errors := v_errors || jsonb_build_object('transcript_state', 'A transcript with words is a draft or reviewed');
  elsif v_transcript_state = 'reviewed' and jsonb_array_length(v_cues) = 0 then
    v_errors := v_errors || jsonb_build_object('transcript_state', 'A reviewed transcript has words. Mark a silent video as no speech');
  elsif v_transcript_state <> 'draft' and v_source = 'import' then
    v_errors := v_errors || jsonb_build_object('transcript_state', 'Imported subtitles start as a draft');
  end if;

  if v_section_state not in ('not_started', 'draft', 'reviewed') then
    v_errors := v_errors || jsonb_build_object('section_state', 'Choose a section state');
  elsif v_section_state = 'not_started' and jsonb_array_length(v_sections) > 0 then
    v_errors := v_errors || jsonb_build_object('section_state', 'Marked sections are a draft or reviewed');
  end if;

  -- Cues: each one on its own first, then overlaps within one speaker. Times are compared as numerics, so
  -- nothing here can fail on a fraction, a string or a huge number.
  if jsonb_array_length(v_cues) > 3000 then
    v_problem := 'A transcript has at most 3,000 cues';
  else
    select problem into v_problem
    from (
      select position, case
        when jsonb_typeof(cue) <> 'object' then format('Cue %s is not a cue', position)
        when jsonb_typeof(cue -> 'start_ms') is distinct from 'number' or jsonb_typeof(cue -> 'end_ms') is distinct from 'number'
          or (cue ->> 'start_ms')::numeric <> trunc((cue ->> 'start_ms')::numeric) or (cue ->> 'end_ms')::numeric <> trunc((cue ->> 'end_ms')::numeric)
          then format('Cue %s needs a start and end in whole milliseconds', position)
        when (cue ->> 'start_ms')::numeric < 0 or (cue ->> 'end_ms')::numeric <= (cue ->> 'start_ms')::numeric
          then format('Cue %s must end after it starts', position)
        when (cue ->> 'end_ms')::numeric > p_duration_ms
          then format('Cue %s ends at %s, after the video ends at %s', position, app.format_ms((cue ->> 'end_ms')::numeric), v_end)
        when jsonb_typeof(cue -> 'text') is distinct from 'string' or trim(cue ->> 'text') = '' then format('Cue %s has no words', position)
        when length(cue ->> 'text') > 2000 then format('Cue %s is longer than 2,000 characters', position)
        when jsonb_typeof(cue -> 'speaker') not in ('string', 'null') or length(cue ->> 'speaker') > 100
          then format('Cue %s needs a speaker name of up to 100 characters, or none', position)
      end as problem
      from jsonb_array_elements(v_cues) with ordinality as c(cue, position)
    ) checked
    where problem is not null
    order by position
    limit 1;

    if v_problem is null then
      select format(case when speaker = '' then 'Cue %s overlaps another cue. If two people talk at once, give each a speaker'
                         else 'Cue %s overlaps another cue from %s' end, position, speaker) into v_problem
      from (
        select position, speaker, start_ms,
          max(end_ms) over (partition by speaker order by start_ms, end_ms, position rows between unbounded preceding and 1 preceding) as earlier_end
        from (
          select position, coalesce(nullif(trim(cue ->> 'speaker'), ''), '') as speaker,
            (cue ->> 'start_ms')::bigint as start_ms, (cue ->> 'end_ms')::bigint as end_ms
          from jsonb_array_elements(v_cues) with ordinality as c(cue, position)
        ) timed
      ) ordered
      where start_ms < earlier_end
      order by position
      limit 1;
    end if;
  end if;
  if v_problem is not null then
    v_errors := v_errors || jsonb_build_object('cues', v_problem);
  end if;

  -- Sections: each one on its own, then overlaps between any two.
  v_problem := null;
  if jsonb_array_length(v_sections) > 200 then
    v_problem := 'A video has at most 200 sections';
  else
    select problem into v_problem
    from (
      select position, case
        when jsonb_typeof(section) <> 'object' then format('Section %s is not a section', position)
        when coalesce(section ->> 'type', '') not in ('hook', 'body', 'cta', 'other')
          then format('Section %s needs a type: Hook, Body, CTA or Other', position)
        when jsonb_typeof(section -> 'detail') not in ('string', 'null')
          or (section ->> 'detail') not in ('problem', 'solution', 'demo', 'benefit', 'proof', 'objection', 'offer')
          then format('Section %s has an unknown detail', position)
        when jsonb_typeof(section -> 'start_ms') is distinct from 'number' or jsonb_typeof(section -> 'end_ms') is distinct from 'number'
          or (section ->> 'start_ms')::numeric <> trunc((section ->> 'start_ms')::numeric) or (section ->> 'end_ms')::numeric <> trunc((section ->> 'end_ms')::numeric)
          then format('Section %s needs a start and end in whole milliseconds', position)
        when (section ->> 'start_ms')::numeric < 0 or (section ->> 'end_ms')::numeric <= (section ->> 'start_ms')::numeric
          then format('Section %s must end after it starts', position)
        when (section ->> 'end_ms')::numeric > p_duration_ms
          then format('Section %s ends at %s, after the video ends at %s', position, app.format_ms((section ->> 'end_ms')::numeric), v_end)
        when jsonb_typeof(section -> 'on_screen_text') not in ('string', 'null') or length(section ->> 'on_screen_text') > 1000
          then format('Section %s on-screen text must be text of up to 1,000 characters', position)
        when jsonb_typeof(section -> 'notes') not in ('string', 'null') or length(section ->> 'notes') > 2000
          then format('Section %s notes must be text of up to 2,000 characters', position)
      end as problem
      from jsonb_array_elements(v_sections) with ordinality as s(section, position)
    ) checked
    where problem is not null
    order by position
    limit 1;

    if v_problem is null then
      select format('Section %s overlaps another section. Each moment belongs to one section', position) into v_problem
      from (
        select position, start_ms,
          max(end_ms) over (order by start_ms, end_ms, position rows between unbounded preceding and 1 preceding) as earlier_end
        from (
          select position, (section ->> 'start_ms')::bigint as start_ms, (section ->> 'end_ms')::bigint as end_ms
          from jsonb_array_elements(v_sections) with ordinality as s(section, position)
        ) timed
      ) ordered
      where start_ms < earlier_end
      order by position
      limit 1;
    end if;
  end if;
  if v_problem is not null then
    v_errors := v_errors || jsonb_build_object('sections', v_problem);
  end if;
  return v_errors;
end;
$$;

-- The Creative Team saves the next annotation revision of a video file in an exact Version (T-17).
create function api.save_video_annotations(
  p_version_id uuid,
  p_file_id uuid,
  p_expected_prior_revision_id uuid,
  p_annotations jsonb,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('version_id', p_version_id, 'file_id', p_file_id,
    'expected_prior_revision_id', p_expected_prior_revision_id, 'annotations', p_annotations);
  v_replayed jsonb;
  v_file core.files;
  v_latest creative.annotation_revisions;
  v_revision creative.annotation_revisions;
  v_errors jsonb;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'save_video_annotations', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select f.* into v_file
  from core.files f join creative.version_files vf on vf.file_id = f.id
  where vf.version_id = p_version_id and f.id = p_file_id;
  if v_file.id is null then
    perform app.fail('not_found');
  end if;
  if v_file.duration_ms is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('file', 'Only a video with a measured duration has a transcript and sections')));
  end if;
  -- Timings belong to the recorded media; a file that changed in Drive needs a new Version first (T-17, T-19).
  if v_file.drift_state is distinct from 'unchanged' then
    perform app.fail('invalid', jsonb_build_object('reason', 'file_changed_in_drive'));
  end if;
  v_errors := app.annotation_errors(p_annotations, v_file.duration_ms);
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;

  -- Serialise saves of one file's annotations, so two editors cannot both build on the same revision.
  perform pg_advisory_xact_lock(hashtextextended('annotations/' || p_version_id::text || '/' || p_file_id::text, 0));
  select * into v_latest from creative.annotation_revisions
  where version_id = p_version_id and file_id = p_file_id
  order by revision_number desc limit 1;
  if v_latest.id is distinct from p_expected_prior_revision_id then
    perform app.fail('conflict', jsonb_build_object('currentRevisionId', v_latest.id));
  end if;

  insert into creative.annotation_revisions
    (version_id, file_id, revision_number, prior_revision_id, source, source_reference, language,
     transcript_state, section_state, created_by)
  values (p_version_id, p_file_id, coalesce(v_latest.revision_number, 0) + 1, v_latest.id,
    coalesce(p_annotations ->> 'source', 'manual'), p_annotations ->> 'source_reference', p_annotations ->> 'language',
    coalesce(p_annotations ->> 'transcript_state', 'draft'), coalesce(p_annotations ->> 'section_state', 'draft'), v_caller.id)
  returning * into v_revision;

  -- Kept in time order, whatever order they were entered in.
  insert into creative.transcript_cues (revision_id, sequence, start_ms, end_ms, text, speaker)
  select v_revision.id, row_number() over (order by start_ms, end_ms, position), start_ms, end_ms, text, speaker
  from (
    select position, (cue ->> 'start_ms')::bigint as start_ms, (cue ->> 'end_ms')::bigint as end_ms, trim(cue ->> 'text') as text,
      nullif(trim(cue ->> 'speaker'), '') as speaker
    from jsonb_array_elements(coalesce(p_annotations -> 'cues', '[]'::jsonb)) with ordinality as cues (cue, position)
  ) cues;
  insert into creative.content_sections (revision_id, sequence, section_type, detail_label, start_ms, end_ms, on_screen_text, notes)
  select v_revision.id, row_number() over (order by start_ms, end_ms, position), section_type, detail_label, start_ms, end_ms, on_screen_text, notes
  from (
    select position, section ->> 'type' as section_type, section ->> 'detail' as detail_label,
      (section ->> 'start_ms')::bigint as start_ms, (section ->> 'end_ms')::bigint as end_ms,
      nullif(trim(section ->> 'on_screen_text'), '') as on_screen_text, nullif(trim(section ->> 'notes'), '') as notes
    from jsonb_array_elements(coalesce(p_annotations -> 'sections', '[]'::jsonb)) with ordinality as sections (section, position)
  ) sections;

  perform app.record_event(v_caller.id, 'member', 'annotation_revision', v_revision.id, v_revision.revision_number,
    'annotations_saved', jsonb_build_object('version_id', p_version_id, 'file_id', p_file_id), v_correlation_id);

  return app.remember_result(v_caller.id, 'save_video_annotations', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_revision.id, 'revision_number', v_revision.revision_number, 'correlation_id', v_correlation_id));
end;
$$;

reset role;

grant execute on function api.save_video_annotations(uuid, uuid, uuid, jsonb, uuid) to authenticated;
