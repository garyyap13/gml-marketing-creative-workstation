-- Telegram notifications (D-82; D-44, D-56; TRD T-10, T-16). A Telegram bot sends one private message to the member
-- who must act; My Tasks is unchanged and stays the full list. The delivery queue becomes channel-neutral, so WhatsApp
-- (deferred by D-82) can be added later as another channel.
--
-- Connecting: a member asks for a one-time connect code, opens the bot with it (t.me/<bot>?start=<code>) and presses
-- Start. The telegram-worker Edge Function passes the "/start <code>" it receives to worker.connect_telegram, which
-- records that chat for the member. A member disconnects in Settings, by sending /stop, or by blocking the bot.
--
-- Sending: app.notify queues one Telegram message per personal task whose recipient has Telegram connected. The worker
-- claims due messages, sends them and reports each outcome; failures retry with backoff like jobs do. The bot's token
-- lives only in function secrets; the database keeps the bot's username and whether the worker could use the token.

-- ---------------------------------------------------------------------------------------------
-- The bot, as the Telegram worker last found it: ready with its username, not configured (no token in the function
-- secrets), or refused (Telegram rejected the token). One row, written by the worker on each run.

create table core.telegram_bot (
  id boolean primary key default true check (id),
  state text not null check (state in ('ready', 'not_configured', 'refused')),
  username text check (username ~ '^[A-Za-z][A-Za-z0-9_]{3,31}$'),
  last_error text,
  checked_at timestamptz not null default now(),
  constraint telegram_bot_ready_has_username check (state <> 'ready' or username is not null)
);

-- Which Telegram chat each member's messages go to. A member has at most one connected chat and a chat belongs to at
-- most one member. Ending a connection keeps its row, with why it ended (D-46): in the workstation (`member`), by /stop
-- (`stopped`), by blocking the bot or Telegram refusing to deliver (`blocked`), or because the member or the chat
-- connected again elsewhere (`replaced`).
create table core.telegram_connections (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references core.members (id),
  chat_id bigint not null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  disconnect_reason text check (disconnect_reason in ('member', 'stopped', 'blocked', 'replaced')),
  constraint telegram_connections_reason_when_ended check ((disconnected_at is null) = (disconnect_reason is null))
);
create unique index telegram_connections_one_per_member on core.telegram_connections (member_id) where disconnected_at is null;
create unique index telegram_connections_one_per_chat on core.telegram_connections (chat_id) where disconnected_at is null;

-- One-time connect codes. Only the code's SHA-256 is kept; the code itself is shown once, to the member who asked.
create table work.telegram_connect_codes (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references core.members (id),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_chat_id bigint,
  revoked_at timestamptz
);
create index telegram_connect_codes_by_member on work.telegram_connect_codes (member_id, created_at);

alter table core.telegram_bot enable row level security;
alter table core.telegram_connections enable row level security;
alter table work.telegram_connect_codes enable row level security;
grant select, insert, update on core.telegram_bot, core.telegram_connections, work.telegram_connect_codes to api_owner;
create policy telegram_bot_commands on core.telegram_bot to api_owner using (true) with check (true);
create policy telegram_connections_commands on core.telegram_connections to api_owner using (true) with check (true);
create policy telegram_connect_codes_commands on work.telegram_connect_codes to api_owner using (true) with check (true);
-- Members see the bot's state and username (for the Connect link) and who has connected, never a chat ID. Connect
-- codes stay internal.
grant select on core.telegram_bot to authenticated;
grant select (id, member_id, connected_at, disconnected_at, disconnect_reason) on core.telegram_connections to authenticated;
create policy telegram_bot_read on core.telegram_bot for select to authenticated using ((select app.is_active_member()));
create policy telegram_connections_read on core.telegram_connections for select to authenticated using ((select app.is_active_member()));

-- ---------------------------------------------------------------------------------------------
-- The delivery queue, channel-neutral. Each message names its channel and the recipient's address on it (a Telegram
-- chat ID; later a WhatsApp number). A task gets at most one message per channel. `sending` holds a lease while a
-- worker sends, as jobs do; `cancelled` is a message that no longer needs sending: its recipient disconnected or was
-- deactivated, or the task was done first.

alter table work.outbox add column channel text not null default 'whatsapp' check (channel in ('telegram', 'whatsapp'));
alter table work.outbox alter column channel drop default;
alter table work.outbox rename column recipient_number to recipient_address;
alter table work.outbox rename column whatsapp_message_id to provider_message_id;
alter table work.outbox add column lease_until timestamptz, add column sent_at timestamptz;
alter table work.outbox drop constraint outbox_task_id_key;
alter table work.outbox add constraint outbox_one_per_task_and_channel unique (task_id, channel);
alter table work.outbox drop constraint outbox_delivery_state_check;
alter table work.outbox add constraint outbox_delivery_state_check
  check (delivery_state in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled'));
alter table work.outbox add constraint outbox_lease_while_sending check ((delivery_state = 'sending') = (lease_until is not null));
create index outbox_due on work.outbox (channel, next_attempt_at) where delivery_state = 'queued';

-- Members see each message's channel, state, attempts, error (so a failed send shows on its task) and Telegram's ID
-- for it, never the address it went to or its payload.
revoke select on work.outbox from authenticated;
grant select (id, task_id, channel, delivery_state, attempts, last_error, provider_message_id, created_at, sent_at) on work.outbox to authenticated;

set role api_owner;

-- Telegram bot tokens (123456789:AA…) are removed from stored errors too, as Meta tokens and bearer tokens are.
create or replace function app.without_credentials_text(p_text text) returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(p_text,
    '(access_token|input_token|fb_exchange_token|appsecret_proof|client_secret|refresh_token|id_token)=[^&#"\s]*', '\1=REDACTED', 'gi'),
    '(bearer|oauth)\s+[A-Za-z0-9._~+/=-]{8,}', '\1 REDACTED', 'gi'),
    'EAA[A-Za-z0-9]{20,}', 'REDACTED', 'g'),
    '[0-9]{5,}:[A-Za-z0-9_-]{30,}', 'REDACTED', 'g');
$$;

-- As before for tasks. Each personal task's recipient who is an active member with Telegram connected also gets one
-- Telegram message (D-82). Team tasks have no member recipient, so they never send one (D-56). WhatsApp messages
-- (D-44) are queued here again once their sender exists. Repeating it for the same event adds nothing.
create or replace function app.notify(
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

  insert into work.outbox (task_id, channel, recipient_address, template, payload)
  select t.id, 'telegram', c.chat_id::text, p_kind, p_payload
  from work.tasks t
  join core.members m on m.id = t.recipient_member_id
  join core.telegram_connections c on c.member_id = m.id and c.disconnected_at is null
  where t.event_id = p_event_id
    and m.active and m.archived_at is null
  on conflict (task_id, channel) do nothing;
$$;

-- Ends a Telegram connection and cancels the messages still waiting for that chat.
create function app.end_telegram_connection(
  p_connection_id uuid,
  p_reason text,
  p_actor_member_id uuid,
  p_correlation_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection core.telegram_connections;
begin
  update core.telegram_connections set disconnected_at = now(), disconnect_reason = p_reason
  where id = p_connection_id and disconnected_at is null
  returning * into v_connection;
  if v_connection.id is null then
    return;
  end if;

  update work.outbox set delivery_state = 'cancelled', lease_until = null, last_error = 'Telegram was disconnected before this was sent'
  where channel = 'telegram' and recipient_address = v_connection.chat_id::text and delivery_state = 'queued';

  perform app.record_event(p_actor_member_id, case when p_actor_member_id is null then 'worker' else 'member' end,
    'member', v_connection.member_id, null, 'telegram_disconnected', jsonb_build_object('reason', p_reason), p_correlation_id);
end;
$$;

-- The signed-in member asks for a one-time connect code. It works once, for 15 minutes, and a newer code replaces any
-- the member still holds. Repeating the call just issues another code, so it takes no idempotency key: storing its
-- result would keep the code. Only active members can connect, and only once the bot is set up.
create function api.start_telegram_connection() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_bot core.telegram_bot;
  -- 24 bytes from two random UUIDs (a strong random source; over 180 random bits) as 32 base64url characters, which
  -- fit Telegram's start parameter (A-Z, a-z, 0-9, _ and -, up to 64).
  v_code text := translate(encode(substring(decode(
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for 24), 'base64'), '+/', '-_');
  v_expires_at timestamptz := now() + interval '15 minutes';
begin
  select * into v_bot from core.telegram_bot;
  if v_bot.state is distinct from 'ready' then
    perform app.fail('conflict', jsonb_build_object('reason', 'telegram_not_set_up'));
  end if;

  perform pg_advisory_xact_lock(hashtextextended('telegram_connect_codes/' || v_caller.id::text, 0));
  if (select count(*) from work.telegram_connect_codes where member_id = v_caller.id and created_at > now() - interval '10 minutes') >= 10 then
    perform app.fail('throttled');
  end if;

  update work.telegram_connect_codes set revoked_at = now()
  where member_id = v_caller.id and used_at is null and revoked_at is null;
  insert into work.telegram_connect_codes (member_id, code_hash, expires_at)
  values (v_caller.id, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_expires_at);

  perform app.record_event(v_caller.id, 'member', 'member', v_caller.id, null, 'telegram_code_issued',
    jsonb_build_object('expires_at', v_expires_at), v_correlation_id);

  return jsonb_build_object('code', v_code, 'bot_username', v_bot.username, 'expires_at', v_expires_at, 'correlation_id', v_correlation_id);
end;
$$;

-- The signed-in member disconnects Telegram. Safe to repeat.
create function api.disconnect_telegram() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_caller core.members := app.require_member();
  v_connection_id uuid;
begin
  select id into v_connection_id from core.telegram_connections
  where member_id = v_caller.id and disconnected_at is null
  for update;
  if v_connection_id is not null then
    perform app.end_telegram_connection(v_connection_id, 'member', v_caller.id, v_correlation_id);
  end if;
  return jsonb_build_object('disconnected', v_connection_id is not null, 'correlation_id', v_correlation_id);
end;
$$;

-- Worker only: what the bot is, as the worker found it on this run.
create function worker.record_telegram_bot(p_state text, p_username text, p_error text default null) returns void
language sql
security definer
set search_path = ''
as $$
  insert into core.telegram_bot (id, state, username, last_error, checked_at)
  values (true, p_state, p_username, left(app.without_credentials_text(p_error), 2000), now())
  on conflict (id) do update
  set state = excluded.state, username = coalesce(excluded.username, core.telegram_bot.username),
      last_error = excluded.last_error, checked_at = excluded.checked_at;
$$;

-- Worker only: someone pressed Start with a connect code in a private chat with the bot. `connected` when the code
-- links the chat to its member (also when Telegram repeats the same /start), `used` when the code already linked
-- another chat, `expired` when it ran out or a newer code replaced it, `unknown` when it was never issued, and
-- `inactive` when its member can no longer sign in. Connecting ends the member's other chat and the chat's other
-- member, so one person's messages go to one place.
create function worker.connect_telegram(p_code text, p_chat_id bigint) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_code work.telegram_connect_codes;
  v_member core.members;
  v_previous core.telegram_connections;
begin
  if p_chat_id is null or coalesce(p_code, '') !~ '^[A-Za-z0-9_-]{1,64}$' then
    return jsonb_build_object('outcome', 'unknown');
  end if;
  select * into v_code from work.telegram_connect_codes
  where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
  for update;
  if v_code.id is null then
    return jsonb_build_object('outcome', 'unknown');
  end if;
  select * into v_member from core.members where id = v_code.member_id;
  if v_code.used_at is not null then
    return jsonb_build_object('outcome', case when v_code.used_by_chat_id = p_chat_id then 'connected' else 'used' end,
      'member_name', case when v_code.used_by_chat_id = p_chat_id then v_member.display_name end);
  end if;
  if v_code.revoked_at is not null or v_code.expires_at <= now() then
    return jsonb_build_object('outcome', 'expired');
  end if;
  if not v_member.active or v_member.archived_at is not null then
    return jsonb_build_object('outcome', 'inactive');
  end if;

  perform 1 from core.members where id = v_member.id for update; -- one connection change per member at a time
  for v_previous in
    select * from core.telegram_connections
    where disconnected_at is null and ((member_id = v_member.id) <> (chat_id = p_chat_id))
    for update
  loop
    perform app.end_telegram_connection(v_previous.id, 'replaced', null, v_correlation_id);
  end loop;
  if not exists (select 1 from core.telegram_connections where member_id = v_member.id and chat_id = p_chat_id and disconnected_at is null) then
    insert into core.telegram_connections (member_id, chat_id) values (v_member.id, p_chat_id);
    perform app.record_event(null, 'worker', 'member', v_member.id, null, 'telegram_connected', '{}'::jsonb, v_correlation_id);
  end if;
  update work.telegram_connect_codes set used_at = now(), used_by_chat_id = p_chat_id where id = v_code.id;

  return jsonb_build_object('outcome', 'connected', 'member_name', v_member.display_name);
end;
$$;

-- Worker only: the chat sent /stop (`stopped`) or blocked the bot (`blocked`). `disconnected`, or `not_connected` when
-- the chat had no connection. Safe to repeat.
create function worker.disconnect_telegram_chat(p_chat_id bigint, p_reason text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_connection_id uuid;
begin
  if p_reason is null or p_reason not in ('stopped', 'blocked') then
    perform app.fail('invalid', jsonb_build_object('fieldErrors', jsonb_build_object('reason', 'Unknown reason')));
  end if;
  select id into v_connection_id from core.telegram_connections where chat_id = p_chat_id and disconnected_at is null for update;
  if v_connection_id is null then
    return jsonb_build_object('outcome', 'not_connected');
  end if;
  perform app.end_telegram_connection(v_connection_id, p_reason, null, v_correlation_id);
  return jsonb_build_object('outcome', 'disconnected');
end;
$$;

-- Worker only: leases up to p_limit due Telegram messages, with what each one says. Concurrent workers never receive
-- the same message. First, a message that no longer needs sending is cancelled: its recipient disconnected or was
-- deactivated, or its task was done. A message whose lease lapsed after 8 attempts (its worker kept dying) fails.
create function worker.claim_telegram_messages(p_limit integer, p_lease_seconds integer)
returns table (outbox_id uuid, attempts integer, chat_id text, task_id uuid, kind text, action_needed text, payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update work.outbox o
  set delivery_state = 'cancelled', lease_until = null,
      last_error = case when t.done_at is not null then 'The task was done before this was sent'
        else 'Telegram was disconnected before this was sent' end
  from work.tasks t
  join core.members m on m.id = t.recipient_member_id
  where o.task_id = t.id and o.channel = 'telegram'
    and (o.delivery_state = 'queued' or (o.delivery_state = 'sending' and o.lease_until <= now()))
    and (t.done_at is not null or not m.active or m.archived_at is not null or not exists (
      select 1 from core.telegram_connections c
      where c.member_id = m.id and c.chat_id::text = o.recipient_address and c.disconnected_at is null));

  update work.outbox o set delivery_state = 'failed', lease_until = null,
    last_error = left(coalesce(o.last_error || ' · ', '') || 'its worker stopped answering 8 times', 2000)
  where o.channel = 'telegram' and o.delivery_state = 'sending' and o.lease_until <= now() and o.attempts >= 8;

  return query
  update work.outbox o
  set delivery_state = 'sending', attempts = o.attempts + 1, lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 0))
  from work.tasks t
  where t.id = o.task_id and o.id in (
    select id from work.outbox
    where channel = 'telegram'
      and ((delivery_state = 'queued' and next_attempt_at <= now()) or (delivery_state = 'sending' and lease_until <= now()))
    order by next_attempt_at, created_at
    limit greatest(p_limit, 0)
    for update skip locked)
  returning o.id, o.attempts, o.recipient_address, t.id, t.kind, t.action_needed, t.payload;
end;
$$;

-- Worker only: Telegram accepted the message. The worker passes the attempt it claimed, so a worker whose lease lapsed
-- can't overwrite what another worker has since recorded. Repeating it changes nothing.
create function worker.record_message_sent(p_outbox_id uuid, p_attempt integer, p_provider_message_id text) returns void
language sql
security definer
set search_path = ''
as $$
  update work.outbox
  set delivery_state = 'sent', provider_message_id = p_provider_message_id, sent_at = now(), lease_until = null, last_error = null
  where id = p_outbox_id and delivery_state = 'sending' and attempts = p_attempt;
$$;

-- Worker only: a send failed. A retryable failure waits for p_retry_after_seconds when Telegram gave one, else 30
-- seconds doubled per attempt with jitter, up to 6 hours, as jobs do (D-58); after 8 attempts, or at once when
-- p_permanent, the message fails and its task stays in My Tasks with the error. When Telegram says the recipient can't
-- be reached (p_recipient_gone: they blocked the bot), their chat is disconnected and its other messages cancelled.
create function worker.record_message_failed(
  p_outbox_id uuid,
  p_attempt integer,
  p_error text,
  p_retry_after_seconds integer default null,
  p_permanent boolean default false,
  p_recipient_gone boolean default false
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_correlation_id uuid := app.begin_command();
  v_message work.outbox;
  v_connection_id uuid;
  v_wait double precision;
  v_error text := left(app.without_credentials_text(p_error), 2000);
begin
  select * into v_message from work.outbox where id = p_outbox_id for update;
  if v_message.id is null or v_message.delivery_state <> 'sending' or v_message.attempts <> p_attempt then
    return 'ignored';
  end if;

  if p_recipient_gone then
    select c.id into v_connection_id from core.telegram_connections c
    where c.chat_id::text = v_message.recipient_address and c.disconnected_at is null
    for update;
    if v_connection_id is not null then
      perform app.end_telegram_connection(v_connection_id, 'blocked', null, v_correlation_id);
    end if;
    -- Messages to the same chat claimed in the same run would fail the same way; the worker skips them.
    update work.outbox set delivery_state = 'cancelled', lease_until = null, last_error = 'Telegram was disconnected before this was sent'
    where channel = 'telegram' and recipient_address = v_message.recipient_address and delivery_state = 'sending' and id <> p_outbox_id;
  end if;
  if p_permanent or p_recipient_gone or v_message.attempts >= 8 then
    update work.outbox set delivery_state = 'failed', lease_until = null, last_error = v_error where id = p_outbox_id;
    return 'failed';
  end if;
  v_wait := coalesce(p_retry_after_seconds::double precision,
    least(30 * power(2, greatest(v_message.attempts - 1, 0)), 21600) * (0.8 + random() * 0.4));
  update work.outbox
  set delivery_state = 'queued', lease_until = null, last_error = v_error, next_attempt_at = now() + make_interval(secs => greatest(v_wait, 1))
  where id = p_outbox_id;
  return 'retrying';
end;
$$;

reset role;

grant execute on function api.start_telegram_connection(), api.disconnect_telegram() to authenticated;
grant execute on function worker.record_telegram_bot(text, text, text), worker.connect_telegram(text, bigint),
  worker.disconnect_telegram_chat(bigint, text), worker.claim_telegram_messages(integer, integer),
  worker.record_message_sent(uuid, integer, text), worker.record_message_failed(uuid, integer, text, integer, boolean, boolean)
  to service_role;
