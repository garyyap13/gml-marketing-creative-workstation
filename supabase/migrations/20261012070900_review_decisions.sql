-- Review decisions (D-21, D-23, D-24, D-50, D-53, D-56; FR-04, FR-05): every Review ends in an explicit Approve
-- or Request Changes, and an unresolved Blocking Comment on any Version of the Variant prevents approval.
-- An approval stays in effect until it is withdrawn or superseded by a new Version.

create table review.approval_withdrawals (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null unique references review.reviews (id),
  version_id uuid not null references creative.versions (id),
  approver_id uuid not null references core.members (id),
  reason text not null,
  created_at timestamptz not null default now()
);

alter table review.approval_withdrawals enable row level security;
grant select, insert on review.approval_withdrawals to api_owner;
create policy approval_withdrawals_commands on review.approval_withdrawals to api_owner using (true) with check (true);
grant select on review.approval_withdrawals to authenticated;
create policy approval_withdrawals_read on review.approval_withdrawals for select to authenticated
  using ((select app.is_active_member()));

set role api_owner;

-- Locks a Review's Variant, then the Review itself (lock order: Variant before Review).
create function app.lock_variant_then_review(p_review_id uuid) returns review.reviews
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review review.reviews;
begin
  perform 1 from creative.variants
  where id = (select variant_id from review.reviews where id = p_review_id)
  for update;
  select * into v_review from review.reviews where id = p_review_id for update;
  return v_review;
end;
$$;

-- Locks an open Review for a decision and checks the caller's expected lock version.
create function app.lock_open_review(p_review_id uuid, p_expected_lock_version integer) returns review.reviews
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review review.reviews;
begin
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;
  v_review := app.lock_variant_then_review(p_review_id);
  if v_review.id is null then
    perform app.fail('not_found');
  end if;
  if v_review.lock_version <> p_expected_lock_version or v_review.decision is not null then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_review.lock_version));
  end if;
  return v_review;
end;
$$;

create function api.request_changes(p_review_id uuid, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('review_id', p_review_id, 'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_review review.reviews;
  v_variant creative.variants;
  v_creative creative.creatives;
  v_event_id uuid;
begin
  if v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'request_changes', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  v_review := app.lock_open_review(p_review_id, p_expected_lock_version);
  update review.reviews
  set decision = 'request_changes', decided_by = v_caller.id, decided_at = now(), lock_version = lock_version + 1
  where id = p_review_id
  returning * into v_review;
  update creative.variants set state = 'changes_requested', lock_version = lock_version + 1
  where id = v_review.variant_id
  returning * into v_variant;
  select * into v_creative from creative.creatives where id = v_variant.creative_id;

  perform app.close_tasks('version_submitted', v_review.id);
  v_event_id := app.record_event(v_caller.id, 'member', 'review', v_review.id, v_review.lock_version, 'changes_requested',
    jsonb_build_object('variant_id', v_variant.id, 'version_id', v_review.version_id, 'code', v_variant.code),
    v_correlation_id);
  -- D-56: changes requested notifies the Creative Owner.
  perform app.notify(v_event_id, 'changes_requested', format('Make the requested changes to %s', v_variant.code),
    'variant', v_variant.id, array[v_creative.creative_owner_id],
    jsonb_build_object('code', v_variant.code, 'review_id', v_review.id));

  return app.remember_result(v_caller.id, 'request_changes', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_review.id, 'decision', v_review.decision, 'version_id', v_review.version_id,
    'lock_version', v_review.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

create function api.approve_version(p_review_id uuid, p_version_id uuid, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('review_id', p_review_id, 'version_id', p_version_id,
    'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_review review.reviews;
  v_variant creative.variants;
  v_blocking uuid[];
  v_event_id uuid;
begin
  if not v_caller.is_approver then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'approve_version', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  v_review := app.lock_open_review(p_review_id, p_expected_lock_version);
  if p_version_id is distinct from v_review.version_id then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('version_id', 'This Review is for a different Version')));
  end if;
  v_blocking := array(
    select c.id from review.comments c join creative.versions v on v.id = c.version_id
    where v.variant_id = v_review.variant_id and c.kind = 'blocking' and c.resolved_at is null
    order by c.created_at);
  if cardinality(v_blocking) > 0 then
    perform app.fail('invalid', jsonb_build_object('reason', 'open_blocking_comments', 'blockingCommentIds', to_jsonb(v_blocking)));
  end if;
  if exists (
    select 1 from creative.version_files vf join core.files f on f.id = vf.file_id
    where vf.version_id = v_review.version_id and f.drift_state is distinct from 'unchanged') then
    perform app.fail('invalid', jsonb_build_object('reason', 'file_changed_in_drive'));
  end if;

  update review.reviews
  set decision = 'approve', decided_by = v_caller.id, decided_at = now(), lock_version = lock_version + 1
  where id = p_review_id
  returning * into v_review;
  update creative.variants set state = 'approved', lock_version = lock_version + 1
  where id = v_review.variant_id
  returning * into v_variant;

  perform app.close_tasks('version_submitted', v_review.id);
  v_event_id := app.record_event(v_caller.id, 'member', 'review', v_review.id, v_review.lock_version, 'version_approved',
    jsonb_build_object('variant_id', v_variant.id, 'version_id', v_review.version_id, 'code', v_variant.code),
    v_correlation_id);
  -- D-56: approval notifies the Marketing Owner.
  perform app.notify(v_event_id, 'version_approved', format('Plan Launches for %s', v_variant.code),
    'variant', v_variant.id, array[app.marketing_owner_of(v_variant.creative_id)],
    jsonb_build_object('code', v_variant.code, 'version_id', v_review.version_id));

  return app.remember_result(v_caller.id, 'approve_version', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_review.id, 'decision', v_review.decision, 'version_id', v_review.version_id,
    'lock_version', v_review.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

create function api.start_next_version(p_variant_id uuid, p_expected_lock_version integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_variant creative.variants;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;

  select * into v_variant from creative.variants where id = p_variant_id for update;
  if v_variant.id is null then
    perform app.fail('not_found');
  end if;
  if v_variant.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_variant.lock_version));
  end if;
  if not (v_variant.state = 'changes_requested' or (v_variant.state = 'approved' and v_variant.live_at is null)) then
    perform app.fail('conflict', jsonb_build_object('reason', 'cannot_start_next_version'));
  end if;

  -- D-53: a new Version of an approved, never-live Variant supersedes that approval.
  update review.reviews
  set approval_ended_at = now(), approval_end_reason = 'superseded', lock_version = lock_version + 1
  where variant_id = p_variant_id and decision = 'approve' and approval_ended_at is null;
  update creative.variants set state = 'in_production', lock_version = lock_version + 1
  where id = p_variant_id
  returning * into v_variant;

  perform app.record_event(v_caller.id, 'member', 'variant', v_variant.id, v_variant.lock_version, 'next_version_started',
    '{}'::jsonb, v_correlation_id);

  return jsonb_build_object('id', v_variant.id, 'state', v_variant.state, 'lock_version', v_variant.lock_version,
    'correlation_id', v_correlation_id);
end;
$$;

-- The Creative Team resolves a Comment, optionally naming the Version that fixed it (D-22, D-23).
create function api.resolve_comment(p_comment_id uuid, p_note text, p_resolving_version_id uuid, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('comment_id', p_comment_id, 'note', p_note,
    'resolving_version_id', p_resolving_version_id);
  v_replayed jsonb;
  v_comment review.comments;
begin
  if v_caller.team <> 'creative' then
    perform app.fail('forbidden');
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'resolve_comment', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select * into v_comment from review.comments where id = p_comment_id for update;
  if v_comment.id is null or v_comment.parent_id is not null then
    perform app.fail('not_found');
  end if;
  if v_comment.resolved_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'already_resolved'));
  end if;
  if p_resolving_version_id is not null and not exists (
    select 1 from creative.versions resolving join creative.versions commented on commented.variant_id = resolving.variant_id
    where resolving.id = p_resolving_version_id and commented.id = v_comment.version_id) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors',
      jsonb_build_object('resolving_version_id', 'Choose a Version of the same Variant')));
  end if;

  update review.comments
  set resolved_by = v_caller.id, resolved_at = now(), resolution_note = nullif(trim(p_note), ''),
      resolving_version_id = p_resolving_version_id
  where id = p_comment_id
  returning * into v_comment;

  perform app.record_event(v_caller.id, 'member', 'comment', v_comment.id, null, 'comment_resolved',
    jsonb_build_object('resolving_version_id', p_resolving_version_id), v_correlation_id);

  return app.remember_result(v_caller.id, 'resolve_comment', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_comment.id, 'correlation_id', v_correlation_id));
end;
$$;

-- An Approver withdraws an approval in effect, with a reason (D-24, D-53). Before go-live the Variant returns to
-- production; after go-live it stays live and no new Launch may use that Version.
create function api.withdraw_approval(p_review_id uuid, p_reason text, p_expected_lock_version integer, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('review_id', p_review_id, 'reason', p_reason,
    'expected_lock_version', p_expected_lock_version);
  v_replayed jsonb;
  v_review review.reviews;
  v_variant creative.variants;
  v_creative creative.creatives;
  v_event_id uuid;
begin
  if not v_caller.is_approver then
    perform app.fail('forbidden');
  end if;
  if coalesce(trim(p_reason), '') = '' or p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_strip_nulls(jsonb_build_object(
      'reason', case when coalesce(trim(p_reason), '') = '' then 'Say why the approval is withdrawn' end,
      'expected_lock_version', case when p_expected_lock_version is null then 'Required' end))));
  end if;
  v_replayed := app.replayed_result(v_caller.id, 'withdraw_approval', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  v_review := app.lock_variant_then_review(p_review_id);
  if v_review.id is null then
    perform app.fail('not_found');
  end if;
  if v_review.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_review.lock_version));
  end if;
  if v_review.decision is distinct from 'approve' or v_review.approval_ended_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'approval_not_in_effect'));
  end if;

  insert into review.approval_withdrawals (review_id, version_id, approver_id, reason)
  values (v_review.id, v_review.version_id, v_caller.id, trim(p_reason));
  update review.reviews
  set approval_ended_at = now(), approval_end_reason = 'withdrawn', lock_version = lock_version + 1
  where id = p_review_id
  returning * into v_review;
  update creative.variants
  set state = case when live_at is null then 'in_production' else state end, lock_version = lock_version + 1
  where id = v_review.variant_id
  returning * into v_variant;
  select * into v_creative from creative.creatives where id = v_variant.creative_id;

  v_event_id := app.record_event(v_caller.id, 'member', 'review', v_review.id, v_review.lock_version, 'approval_withdrawn',
    jsonb_build_object('variant_id', v_variant.id, 'version_id', v_review.version_id, 'code', v_variant.code),
    v_correlation_id, trim(p_reason));
  -- D-56: a withdrawal notifies both owners.
  perform app.notify(v_event_id, 'approval_withdrawn', format('Approval of %s was withdrawn', v_variant.code),
    'variant', v_variant.id, array[app.marketing_owner_of(v_creative.id), v_creative.creative_owner_id],
    jsonb_build_object('code', v_variant.code, 'reason', trim(p_reason)));

  return app.remember_result(v_caller.id, 'withdraw_approval', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_review.id, 'state', v_variant.state, 'lock_version', v_review.lock_version,
    'correlation_id', v_correlation_id));
end;
$$;

reset role;

grant execute on function api.withdraw_approval(uuid, text, integer, uuid) to authenticated;
grant execute on function api.request_changes(uuid, integer, uuid) to authenticated;
grant execute on function api.approve_version(uuid, uuid, integer, uuid) to authenticated;
grant execute on function api.start_next_version(uuid, integer) to authenticated;
grant execute on function api.resolve_comment(uuid, text, uuid, uuid) to authenticated;
