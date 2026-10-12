-- Comments (D-22, D-23; FR-04, T-07 anchors): attached to an exact Version, blocking (必改) or suggestion (建议),
-- optionally at a video time range, an image box or a carousel card.

create table review.comments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references creative.versions (id),
  review_id uuid not null references review.reviews (id),
  author_id uuid not null references core.members (id),
  parent_id uuid references review.comments (id),
  body text not null,
  kind text check (kind in ('blocking', 'suggestion')),
  anchor jsonb,
  resolved_by uuid references core.members (id),
  resolved_at timestamptz,
  resolution_note text,
  resolving_version_id uuid references creative.versions (id),
  created_at timestamptz not null default clock_timestamp(),
  constraint comments_kind_on_top_level check ((parent_id is null) = (kind is not null)),
  constraint comments_replies_unanchored check (parent_id is null or anchor is null)
);
create index comments_by_version on review.comments (version_id);

alter table review.comments enable row level security;
grant select, insert, update on review.comments to api_owner;
create policy comments_commands on review.comments to api_owner using (true) with check (true);
grant select on review.comments to authenticated;
create policy comments_read on review.comments for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Validates an anchor against the exact Version's files and returns it normalised (TRD §7):
-- video {start_ms, end_ms} within the duration; image {x, y, width, height} within [0, 1];
-- carousel {card} with an optional box.
create function app.normalised_anchor(p_version_id uuid, p_anchor jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cards integer;
  v_duration bigint;
  v_mime text;
  v_start bigint;
  v_end bigint;
  v_box jsonb;
  v_card integer;
begin
  if p_anchor is null or p_anchor = 'null'::jsonb then
    return null;
  end if;
  select count(*), max(f.duration_ms), max(f.mime)
  into v_cards, v_duration, v_mime
  from creative.version_files vf join core.files f on f.id = vf.file_id
  where vf.version_id = p_version_id;

  begin
    if v_cards = 1 and v_mime like 'video/%' then
      v_start := (p_anchor ->> 'start_ms')::bigint;
      v_end := coalesce((p_anchor ->> 'end_ms')::bigint, v_start);
      if v_start is not null and v_start >= 0 and v_end >= v_start and v_end <= v_duration then
        return jsonb_build_object('start_ms', v_start, 'end_ms', v_end);
      end if;
    else
      if v_cards > 1 then
        v_card := (p_anchor ->> 'card')::integer;
        if v_card is null or v_card < 1 or v_card > v_cards then
          perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('anchor', 'Choose a card in this carousel')));
        end if;
      end if;
      v_box := case when p_anchor ? 'x' then jsonb_build_object(
        'x', (p_anchor ->> 'x')::numeric, 'y', (p_anchor ->> 'y')::numeric,
        'width', (p_anchor ->> 'width')::numeric, 'height', (p_anchor ->> 'height')::numeric) end;
      if v_box is null and v_card is not null then
        return jsonb_build_object('card', v_card);
      end if;
      if (v_box ->> 'x')::numeric >= 0 and (v_box ->> 'y')::numeric >= 0
         and (v_box ->> 'width')::numeric > 0 and (v_box ->> 'height')::numeric > 0
         and (v_box ->> 'x')::numeric + (v_box ->> 'width')::numeric <= 1
         and (v_box ->> 'y')::numeric + (v_box ->> 'height')::numeric <= 1 then
        return case when v_card is null then v_box else v_box || jsonb_build_object('card', v_card) end;
      end if;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    null; -- fall through to the invalid-anchor error below
  end;
  perform app.fail('invalid', jsonb_build_object('fieldErrors',
    jsonb_build_object('anchor', 'Choose a position inside this Version')));
  return null;
end;
$$;

-- Marketing comments on a Version; anyone may reply (D-22).
create function api.add_comment(
  p_version_id uuid,
  p_body text,
  p_kind text,
  p_anchor jsonb,
  p_parent_id uuid,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('version_id', p_version_id, 'body', p_body, 'kind', p_kind,
    'anchor', p_anchor, 'parent_id', p_parent_id);
  v_replayed jsonb;
  v_parent review.comments;
  v_review_id uuid;
  v_comment review.comments;
begin
  if p_parent_id is null and v_caller.team <> 'marketing' then
    perform app.fail('forbidden');
  end if;
  if coalesce(trim(p_body), '') = '' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('body', 'Write the comment')));
  end if;
  if p_parent_id is null and (p_kind is null or p_kind not in ('blocking', 'suggestion')) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('kind', 'Choose blocking or suggestion')));
  end if;
  if p_parent_id is not null and (p_kind is not null or p_anchor is not null) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('kind', 'Replies have no kind or position')));
  end if;

  v_replayed := app.replayed_result(v_caller.id, 'add_comment', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;

  select id into v_review_id from review.reviews where version_id = p_version_id;
  if v_review_id is null then
    perform app.fail('not_found');
  end if;
  if p_parent_id is null then
    -- Lock the Variant (lock order: Variant before Review) so a new comment and an approval run one after the
    -- other. A Blocking Comment cannot join an approval in effect: withdraw the approval first (D-23, D-24).
    perform 1 from creative.variants where id = (select variant_id from creative.versions where id = p_version_id) for update;
    if p_kind = 'blocking' and exists (
      select 1 from review.reviews r join creative.versions v on v.variant_id = r.variant_id
      where v.id = p_version_id and r.decision = 'approve' and r.approval_ended_at is null) then
      perform app.fail('conflict', jsonb_build_object('reason', 'approval_in_effect'));
    end if;
  end if;
  if p_parent_id is not null then
    select * into v_parent from review.comments where id = p_parent_id;
    if v_parent.id is null or v_parent.version_id <> p_version_id or v_parent.parent_id is not null then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('parent_id', 'Reply to a comment on this Version')));
    end if;
  end if;

  insert into review.comments (version_id, review_id, author_id, parent_id, body, kind, anchor)
  values (p_version_id, v_review_id, v_caller.id, p_parent_id, trim(p_body), p_kind,
    app.normalised_anchor(p_version_id, p_anchor))
  returning * into v_comment;

  perform app.record_event(v_caller.id, 'member', 'comment', v_comment.id, null, 'comment_added',
    jsonb_build_object('version_id', p_version_id, 'kind', p_kind, 'parent_id', p_parent_id), v_correlation_id);

  return app.remember_result(v_caller.id, 'add_comment', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_comment.id, 'correlation_id', v_correlation_id));
end;
$$;

reset role;

grant execute on function api.add_comment(uuid, text, text, jsonb, uuid, uuid) to authenticated;
