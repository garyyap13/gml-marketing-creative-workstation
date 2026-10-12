-- My Tasks and the WhatsApp delivery queue (D-44, D-45, D-56; T-10, T-16). Tasks are derived from an
-- activity-log event in the command's own transaction; the outbox only queues WhatsApp messages.

create table work.tasks (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references audit.activity_log (id),
  kind text not null,
  recipient_member_id uuid references core.members (id),
  recipient_team text check (recipient_team in ('marketing')),
  action_needed text not null,
  entity_type text not null,
  entity_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  constraint tasks_one_recipient_kind check ((recipient_member_id is null) <> (recipient_team is null)),
  unique (event_id, recipient_member_id)
);
create index tasks_open_by_recipient on work.tasks (recipient_member_id) where done_at is null;
create index tasks_by_entity on work.tasks (entity_id);

create table work.task_reads (
  task_id uuid not null references work.tasks (id),
  member_id uuid not null references core.members (id),
  read_at timestamptz not null default now(),
  primary key (task_id, member_id)
);

create table work.outbox (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null unique references work.tasks (id),
  recipient_number text not null,
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  delivery_state text not null default 'queued' check (delivery_state in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  whatsapp_message_id text,
  last_error text,
  created_at timestamptz not null default now()
);

alter table work.tasks enable row level security;
alter table work.task_reads enable row level security;
alter table work.outbox enable row level security;
grant select, insert, update on work.tasks, work.task_reads, work.outbox to api_owner;
create policy tasks_commands on work.tasks to api_owner using (true) with check (true);
create policy task_reads_commands on work.task_reads to api_owner using (true) with check (true);
create policy outbox_commands on work.outbox to api_owner using (true) with check (true);
grant usage on schema work to authenticated;
grant select on work.tasks, work.task_reads, work.outbox to authenticated;
create policy tasks_read on work.tasks for select to authenticated using ((select app.is_active_member()));
create policy task_reads_read on work.task_reads for select to authenticated using ((select app.is_active_member()));
create policy outbox_read on work.outbox for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Creates one task per recipient for an activity-log event, and queues one WhatsApp message for each
-- recipient with a number and a recorded opt-in. Repeating it for the same event adds nothing.
create function app.notify(
  p_event_id uuid,
  p_kind text,
  p_action_needed text,
  p_entity_type text,
  p_entity_id uuid,
  p_recipient_ids uuid[],
  p_payload jsonb
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into work.tasks (event_id, kind, recipient_member_id, action_needed, entity_type, entity_id, payload)
  select distinct p_event_id, p_kind, recipient_id, p_action_needed, p_entity_type, p_entity_id, p_payload
  from unnest(p_recipient_ids) as recipient_id
  where recipient_id is not null
  on conflict (event_id, recipient_member_id) do nothing;

  insert into work.outbox (task_id, recipient_number, template, payload)
  select t.id, m.whatsapp_number, p_kind, p_payload
  from work.tasks t
  join core.members m on m.id = t.recipient_member_id
  where t.event_id = p_event_id
    and m.whatsapp_number is not null and m.whatsapp_opt_in_at is not null
    and m.active and m.archived_at is null
  on conflict (task_id) do nothing;
$$;

-- Marks open tasks done when the action they ask for commits (T-16), optionally for one recipient.
create function app.close_tasks(p_kind text, p_entity_id uuid, p_recipient_id uuid default null) returns void
language sql
security definer
set search_path = ''
as $$
  update work.tasks set done_at = now()
  where kind = p_kind and entity_id = p_entity_id and done_at is null
    and (p_recipient_id is null or recipient_member_id = p_recipient_id);
$$;

-- Read is tracked per person; a team task can be marked read by any member of that team (T-16).
create function api.mark_task_read(p_task_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_task work.tasks;
begin
  select * into v_task from work.tasks where id = p_task_id;
  if v_task.id is null then
    perform app.fail('not_found');
  end if;
  if v_task.recipient_member_id is distinct from v_caller.id and v_task.recipient_team is distinct from v_caller.team then
    perform app.fail('forbidden');
  end if;

  insert into work.task_reads (task_id, member_id) values (p_task_id, v_caller.id)
  on conflict (task_id, member_id) do nothing;

  return jsonb_build_object('id', p_task_id, 'correlation_id', v_correlation_id);
end;
$$;

reset role;

grant execute on function api.mark_task_read(uuid) to authenticated;
