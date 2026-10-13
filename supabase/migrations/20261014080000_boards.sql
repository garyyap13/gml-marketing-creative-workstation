-- Whiteboards (D-75): boards of sticky notes and labelled frames that both teams arrange, optionally attached to a
-- Brief or a Creative, with links to Briefs, Creatives, Variants, Footage and Findings. Each note saves on its own
-- with a version check, so a stale move never overwrites a newer one. Removing archives; nothing is deleted.

create schema board; -- boards and their items (exposed, read-only to members)
grant usage on schema board to authenticated, api_owner;

-- Lock order: a board item is its own aggregate. Commands on an item lock the item, then read its board under a
-- share lock; adding an item share-locks the board; archiving a board locks only the board.

create table board.boards (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 120),
  brief_id uuid references brief.briefs (id),
  creative_id uuid references creative.creatives (id),
  created_by uuid not null references core.members (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references core.members (id),
  lock_version integer not null default 0,
  constraint boards_one_home check (brief_id is null or creative_id is null)
);

create table board.items (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references board.boards (id),
  kind text not null check (kind in ('note', 'frame')),
  text text not null,
  colour text check (colour in ('yellow', 'green', 'blue', 'purple')),
  x numeric(9, 1) not null check (x between -100000 and 100000),
  y numeric(9, 1) not null check (y between -100000 and 100000),
  width numeric(7, 1) check (width between 40 and 4000),
  height numeric(7, 1) check (height between 40 and 4000),
  link_type text check (link_type in ('brief', 'creative', 'variant', 'footage', 'finding')),
  link_id uuid,
  created_by uuid not null references core.members (id),
  created_at timestamptz not null default now(),
  updated_by uuid references core.members (id),
  updated_at timestamptz,
  archived_at timestamptz,
  lock_version integer not null default 0,
  constraint items_text_length check (length(text) <= case kind when 'note' then 1000 else 120 end),
  constraint items_note_colour check ((kind = 'note') = (colour is not null)),
  constraint items_frame_size check (kind = 'note' or (width is not null and height is not null)),
  constraint items_link_pair check ((link_type is null) = (link_id is null))
);
create index items_by_board on board.items (board_id);

alter table board.boards enable row level security;
alter table board.items enable row level security;
grant select, insert, update on board.boards, board.items to api_owner;
create policy boards_commands on board.boards to api_owner using (true) with check (true);
create policy items_commands on board.items to api_owner using (true) with check (true);
grant select on board.boards, board.items to authenticated;
create policy boards_read on board.boards for select to authenticated using ((select app.is_active_member()));
create policy items_read on board.items for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Whether a link points at a real record of its kind.
create function app.board_link_exists(p_type text, p_id uuid) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_type
    when 'brief' then exists (select 1 from brief.briefs where id = p_id)
    when 'creative' then exists (select 1 from creative.creatives where id = p_id)
    when 'variant' then exists (select 1 from creative.variants where id = p_id)
    when 'footage' then exists (select 1 from creative.footage where id = p_id)
    when 'finding' then exists (select 1 from learning.retrospective_findings where id = p_id)
    else false
  end;
$$;

-- Field errors for a board item, or for the fields a patch changes (p_kind is the item's kind).
create function app.board_item_errors(p_kind text, p_fields jsonb, p_partial boolean) returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_errors jsonb := '{}'::jsonb;
  v_key text;
  v_has_link boolean := p_fields ? 'link_type' or p_fields ? 'link_id';
  v_clears_link boolean := coalesce(p_fields -> 'link_type' = 'null'::jsonb and p_fields -> 'link_id' = 'null'::jsonb, false);
begin
  if p_kind is null or p_kind not in ('note', 'frame') then
    return jsonb_build_object('kind', 'A note or a frame');
  end if;
  if p_partial and p_fields = '{}'::jsonb then
    return jsonb_build_object('patch', 'Provide at least one change');
  end if;
  -- Only the fields this kind of item has; a colour belongs to notes and a size to frames.
  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key = 'kind' and not p_partial then
      continue;
    elsif v_key = 'colour' and p_kind = 'frame' then
      v_errors := v_errors || jsonb_build_object(v_key, 'Only notes have a colour');
    elsif v_key in ('width', 'height') and p_kind = 'note' then
      v_errors := v_errors || jsonb_build_object(v_key, 'Only frames have a size');
    elsif v_key not in ('text', 'colour', 'x', 'y', 'width', 'height', 'link_type', 'link_id') then
      v_errors := v_errors || jsonb_build_object(v_key, 'Not something a board item has');
    end if;
  end loop;
  if not p_partial or p_fields ? 'text' then
    if jsonb_typeof(p_fields -> 'text') is distinct from 'string' or (p_kind = 'frame' and trim(p_fields ->> 'text') = '')
      or length(p_fields ->> 'text') > (case p_kind when 'note' then 1000 else 120 end) then
      v_errors := v_errors || jsonb_build_object('text', case p_kind when 'note' then 'Up to 1,000 characters' else 'Name the frame, in up to 120 characters' end);
    end if;
  end if;
  if p_kind = 'note' and (not p_partial or p_fields ? 'colour') and coalesce(p_fields ->> 'colour', '') not in ('yellow', 'green', 'blue', 'purple') then
    v_errors := v_errors || jsonb_build_object('colour', 'Yellow, green, blue or purple');
  end if;
  foreach v_key in array array['x', 'y'] loop
    if (not p_partial or p_fields ? v_key) and (jsonb_typeof(p_fields -> v_key) is distinct from 'number'
        or abs((p_fields ->> v_key)::numeric) > 100000) then
      v_errors := v_errors || jsonb_build_object(v_key, 'A position on the board');
    end if;
  end loop;
  if p_kind = 'frame' then
    foreach v_key in array array['width', 'height'] loop
      if (not p_partial or p_fields ? v_key) and (jsonb_typeof(p_fields -> v_key) is distinct from 'number'
          or (p_fields ->> v_key)::numeric not between 40 and 4000) then
        v_errors := v_errors || jsonb_build_object(v_key, 'Between 40 and 4,000');
      end if;
    end loop;
  end if;
  -- A link is set or cleared as a pair: both fields null clears it.
  if v_has_link and not v_clears_link then
    if coalesce(p_fields ->> 'link_type', '') not in ('brief', 'creative', 'variant', 'footage', 'finding') then
      v_errors := v_errors || jsonb_build_object('link_type', 'Link a Brief, Creative, Variant, Footage or Finding');
    elsif coalesce(p_fields ->> 'link_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or not app.board_link_exists(p_fields ->> 'link_type', (p_fields ->> 'link_id')::uuid) then
      v_errors := v_errors || jsonb_build_object('link_id', 'Choose a record that exists');
    end if;
  end if;
  return v_errors;
end;
$$;

-- Either team starts a board, optionally on a Brief or a Creative.
create function api.create_board(p_title text, p_attach jsonb, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('title', p_title, 'attach', p_attach);
  v_replayed jsonb;
  v_brief uuid;
  v_creative uuid;
  v_board board.boards;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  v_replayed := app.replayed_result(v_caller.id, 'create_board', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  if coalesce(trim(p_title), '') = '' or length(p_title) > 120 then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('title', 'Name the board, in up to 120 characters')));
  end if;
  if jsonb_typeof(coalesce(p_attach, '{}'::jsonb)) <> 'object' or (p_attach ? 'brief_id' and p_attach ? 'creative_id'
      and p_attach -> 'brief_id' <> 'null'::jsonb and p_attach -> 'creative_id' <> 'null'::jsonb) then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('attach', 'Attach the board to a Brief or a Creative, not both')));
  end if;
  if p_attach ->> 'brief_id' is not null then
    if p_attach ->> 'brief_id' !~* v_uuid or not app.board_link_exists('brief', (p_attach ->> 'brief_id')::uuid) then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('attach', 'Choose a Brief that exists')));
    end if;
    v_brief := (p_attach ->> 'brief_id')::uuid;
  elsif p_attach ->> 'creative_id' is not null then
    if p_attach ->> 'creative_id' !~* v_uuid or not app.board_link_exists('creative', (p_attach ->> 'creative_id')::uuid) then
      perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('attach', 'Choose a Creative that exists')));
    end if;
    v_creative := (p_attach ->> 'creative_id')::uuid;
  end if;

  insert into board.boards (title, brief_id, creative_id, created_by)
  values (trim(p_title), v_brief, v_creative, v_caller.id)
  returning * into v_board;
  perform app.record_event(v_caller.id, 'member', 'board', v_board.id, v_board.lock_version, 'board_created',
    jsonb_build_object('title', v_board.title), v_correlation_id);
  return app.remember_result(v_caller.id, 'create_board', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_board.id, 'lock_version', v_board.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- Either team adds a note or a frame to a board that is not archived.
create function api.add_board_item(p_board_id uuid, p_item jsonb, p_idempotency_key uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_request jsonb := jsonb_build_object('board_id', p_board_id, 'item', p_item);
  v_replayed jsonb;
  v_errors jsonb;
  v_board board.boards;
  v_item board.items;
begin
  v_replayed := app.replayed_result(v_caller.id, 'add_board_item', p_idempotency_key, v_request);
  if v_replayed is not null then
    return v_replayed;
  end if;
  v_errors := app.board_item_errors(p_item ->> 'kind', coalesce(p_item, '{}'::jsonb), false);
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  select * into v_board from board.boards where id = p_board_id for share;
  if v_board.id is null then
    perform app.fail('not_found');
  end if;
  if v_board.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'board_archived'));
  end if;

  insert into board.items (board_id, kind, text, colour, x, y, width, height, link_type, link_id, created_by)
  values (p_board_id, p_item ->> 'kind', case when p_item ->> 'kind' = 'frame' then trim(p_item ->> 'text') else p_item ->> 'text' end,
    case when p_item ->> 'kind' = 'note' then p_item ->> 'colour' end,
    (p_item ->> 'x')::numeric, (p_item ->> 'y')::numeric,
    case when p_item ->> 'kind' = 'frame' then (p_item ->> 'width')::numeric end,
    case when p_item ->> 'kind' = 'frame' then (p_item ->> 'height')::numeric end,
    p_item ->> 'link_type', (p_item ->> 'link_id')::uuid, v_caller.id)
  returning * into v_item;
  perform app.record_event(v_caller.id, 'member', 'board_item', v_item.id, v_item.lock_version, 'board_item_added',
    jsonb_build_object('board_id', p_board_id, 'kind', v_item.kind), v_correlation_id);
  return app.remember_result(v_caller.id, 'add_board_item', p_idempotency_key, v_request, jsonb_build_object(
    'id', v_item.id, 'lock_version', v_item.lock_version, 'correlation_id', v_correlation_id));
end;
$$;

-- Either team moves, resizes, rewords, recolours or relinks an item; a stale version is a conflict (D-75).
create function api.update_board_item(p_item_id uuid, p_patch jsonb, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_item board.items;
  v_board board.boards;
  v_errors jsonb;
begin
  if p_expected_lock_version is null or jsonb_typeof(p_patch) is distinct from 'object' then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('patch', 'Provide the changes and the item''s lock version')));
  end if;
  select * into v_item from board.items where id = p_item_id for update;
  if v_item.id is null then
    perform app.fail('not_found');
  end if;
  select * into v_board from board.boards where id = v_item.board_id for share;
  if v_board.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'board_archived'));
  end if;
  if v_item.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'item_archived'));
  end if;
  v_errors := app.board_item_errors(v_item.kind, p_patch, true);
  if v_errors <> '{}'::jsonb then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', v_errors));
  end if;
  if v_item.lock_version <> p_expected_lock_version then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_item.lock_version));
  end if;

  update board.items set
    text = case when p_patch ? 'text' then case when kind = 'frame' then trim(p_patch ->> 'text') else p_patch ->> 'text' end else text end,
    colour = case when p_patch ? 'colour' then p_patch ->> 'colour' else colour end,
    x = case when p_patch ? 'x' then (p_patch ->> 'x')::numeric else x end,
    y = case when p_patch ? 'y' then (p_patch ->> 'y')::numeric else y end,
    width = case when p_patch ? 'width' then (p_patch ->> 'width')::numeric else width end,
    height = case when p_patch ? 'height' then (p_patch ->> 'height')::numeric else height end,
    link_type = case when p_patch ? 'link_type' then p_patch ->> 'link_type' else link_type end,
    link_id = case when p_patch ? 'link_id' then (p_patch ->> 'link_id')::uuid else link_id end,
    updated_by = v_caller.id, updated_at = now(), lock_version = lock_version + 1
  where id = p_item_id
  returning * into v_item;
  perform app.record_event(v_caller.id, 'member', 'board_item', v_item.id, v_item.lock_version, 'board_item_changed',
    jsonb_build_object('board_id', v_item.board_id, 'fields', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)), v_correlation_id);
  return jsonb_build_object('id', v_item.id, 'lock_version', v_item.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- Archives an item, or puts an archived one back, on a board that is still open.
create function app.set_board_item_archived(p_item_id uuid, p_expected_lock_version integer, p_archive boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_item board.items;
  v_board board.boards;
begin
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;
  select * into v_item from board.items where id = p_item_id for update;
  if v_item.id is null then
    perform app.fail('not_found');
  end if;
  select * into v_board from board.boards where id = v_item.board_id for share;
  if v_board.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'board_archived'));
  end if;
  if p_archive and v_item.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('reason', 'item_archived'));
  end if;
  if v_item.lock_version <> p_expected_lock_version or (not p_archive and v_item.archived_at is null) then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_item.lock_version));
  end if;
  update board.items set archived_at = case when p_archive then now() end, updated_by = v_caller.id, updated_at = now(),
    lock_version = lock_version + 1
  where id = p_item_id
  returning * into v_item;
  perform app.record_event(v_caller.id, 'member', 'board_item', v_item.id, v_item.lock_version,
    case when p_archive then 'board_item_archived' else 'board_item_restored' end,
    jsonb_build_object('board_id', v_item.board_id), v_correlation_id);
  return jsonb_build_object('id', v_item.id, 'lock_version', v_item.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

-- Removing a note or frame archives it, and either team can put it back while the board is open (D-75).
create function api.archive_board_item(p_item_id uuid, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.set_board_item_archived(p_item_id, p_expected_lock_version, true);
end;
$$;

create function api.restore_board_item(p_item_id uuid, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return app.set_board_item_archived(p_item_id, p_expected_lock_version, false);
end;
$$;

-- The board's creator or the Admin archives a board (D-61's archiving pattern).
create function api.archive_board(p_board_id uuid, p_expected_lock_version integer) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_board board.boards;
begin
  if p_expected_lock_version is null then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('expected_lock_version', 'Required')));
  end if;
  select * into v_board from board.boards where id = p_board_id for update;
  if v_board.id is null then
    perform app.fail('not_found');
  end if;
  if v_caller.id <> v_board.created_by and not v_caller.is_admin then
    perform app.fail('forbidden');
  end if;
  if v_board.lock_version <> p_expected_lock_version or v_board.archived_at is not null then
    perform app.fail('conflict', jsonb_build_object('currentLockVersion', v_board.lock_version));
  end if;
  update board.boards set archived_at = now(), archived_by = v_caller.id, lock_version = lock_version + 1
  where id = p_board_id
  returning * into v_board;
  perform app.record_event(v_caller.id, 'member', 'board', v_board.id, v_board.lock_version, 'board_archived', '{}'::jsonb, v_correlation_id);
  return jsonb_build_object('id', v_board.id, 'lock_version', v_board.lock_version, 'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.create_board(text, jsonb, uuid) to authenticated;
grant execute on function api.add_board_item(uuid, jsonb, uuid) to authenticated;
grant execute on function api.update_board_item(uuid, jsonb, integer) to authenticated;
grant execute on function api.archive_board_item(uuid, integer) to authenticated;
grant execute on function api.restore_board_item(uuid, integer) to authenticated;
grant execute on function api.archive_board(uuid, integer) to authenticated;
