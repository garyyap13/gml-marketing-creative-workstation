-- Brief lifecycle (D-16, D-51; FR-02): hand-off locks a Brief version; a Rebrief starts the next one.

set role api_owner;

create function api.hand_off_brief(p_brief_id uuid, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('brief_id', p_brief_id, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_missing jsonb := '{}'::jsonb;
  v_brief brief.briefs;
  v_version brief.brief_versions;
  v_event_id uuid;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'hand_off_brief', p_idempotency_key, v_request);
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
  select * into v_version from brief.brief_versions where brief_id = p_brief_id and state = 'editing';
  if v_version.id is null then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_handed_off'));
  end if;

  if v_version.product_id is null then v_missing := v_missing || '{"product_id": "Choose a Product"}'; end if;
  if v_version.avatar_id is null then v_missing := v_missing || '{"avatar_id": "Choose an Avatar"}'; end if;
  if v_version.angle_id is null then v_missing := v_missing || '{"angle_id": "Choose an Angle"}'; end if;
  if v_version.funnel_stage_id is null then v_missing := v_missing || '{"funnel_stage_id": "Choose a Funnel Stage"}'; end if;
  if v_version.key_message is null then v_missing := v_missing || '{"key_message": "Write the key message"}'; end if;
  if v_version.cta is null and not v_version.cta_none then
    v_missing := v_missing || '{"cta": "Write the CTA, or mark it as none"}';
  end if;
  -- A Creative counts on any version of the Brief: after a Rebrief, Creatives move up only once the new
  -- version is handed off.
  if not exists (
    select 1 from creative.creatives c join brief.brief_versions bv on bv.id = c.brief_version_id
    where bv.brief_id = p_brief_id and c.archived_at is null and c.format_confirmed_by is not null) then
    v_missing := v_missing || '{"creatives": "Add at least one Creative with a confirmed Format, Creative Owner and due date"}';
  end if;
  if v_missing <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_missing));
  end if;

  update brief.brief_versions
  set state = 'handed_off', handed_off_by = v_caller.id, handed_off_at = now()
  where id = v_version.id;
  update brief.briefs set lock_version = lock_version + 1 where id = p_brief_id returning * into v_brief;

  v_event_id := app.record_event(v_caller.id, 'member', 'brief', v_brief.id, v_brief.lock_version, 'brief_handed_off',
    jsonb_build_object('brief_version_id', v_version.id, 'version_number', v_version.version_number), v_correlation_id);

  -- D-56: a hand-off or Rebrief notifies the Creative Owners of the Brief's Creatives.
  perform app.notify(v_event_id, 'brief_handed_off', 'Start the Creatives for this Brief', 'brief', v_brief.id,
    array(
      select c.creative_owner_id from creative.creatives c join brief.brief_versions bv on bv.id = c.brief_version_id
      where bv.brief_id = p_brief_id and c.archived_at is null),
    jsonb_build_object('brief_title', v_brief.title, 'brief_version_id', v_version.id));

  return app.remember_result(v_caller.id, 'hand_off_brief', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_brief.id, 'brief_version_id', v_version.id, 'lock_version', v_brief.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

create function api.rebrief(p_brief_id uuid, p_reason text, p_expected_lock_version integer, p_idempotency_key uuid)
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
  update brief.briefs set lock_version = lock_version + 1 where id = p_brief_id returning * into v_brief;

  perform app.record_event(v_caller.id, 'member', 'brief', v_brief.id, v_brief.lock_version, 'brief_rebriefed',
    jsonb_build_object('brief_version_id', v_version.id, 'version_number', v_version.version_number), v_correlation_id,
    trim(p_reason));

  return app.remember_result(v_caller.id, 'rebrief', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_brief.id, 'brief_version_id', v_version.id, 'lock_version', v_brief.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

-- A never-live Creative may follow a newer handed-off version of its Brief (D-51, D-14).
create function api.adopt_brief_version(p_creative_id uuid, p_brief_version_id uuid, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_creative creative.creatives;
  v_current brief.brief_versions;
  v_target brief.brief_versions;
begin
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;

  select * into v_creative from creative.creatives where id = p_creative_id for update;
  if v_creative.id is null or v_creative.archived_at is not null then
    perform app.fail('not_found');
  end if;
  if v_creative.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_creative.lock_version));
  end if;
  if v_creative.first_live_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'creative_has_been_live'));
  end if;

  select * into v_current from brief.brief_versions where id = v_creative.brief_version_id;
  select * into v_target from brief.brief_versions where id = p_brief_version_id;
  if v_target.id is null or v_target.brief_id is distinct from v_current.brief_id or v_target.state <> 'handed_off'
     or v_target.version_number <= v_current.version_number then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('brief_version_id', 'Choose a newer, handed-off version of this Brief')));
  end if;

  update creative.creatives set brief_version_id = v_target.id, lock_version = lock_version + 1
  where id = p_creative_id
  returning * into v_creative;

  perform app.record_event(v_caller.id, 'member', 'creative', v_creative.id, v_creative.lock_version,
    'brief_version_adopted', jsonb_build_object('from', v_current.id, 'to', v_target.id), v_correlation_id);
  -- Moving up to the handed-off version completes the Creative Owner's hand-off task for it.
  perform app.close_tasks('brief_handed_off', v_target.brief_id, v_creative.creative_owner_id);

  return jsonb_build_object('id', v_creative.id, 'lock_version', v_creative.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.hand_off_brief(uuid, integer, uuid) to authenticated;
grant execute on function api.rebrief(uuid, text, integer, uuid) to authenticated;
grant execute on function api.adopt_brief_version(uuid, uuid, integer) to authenticated;
