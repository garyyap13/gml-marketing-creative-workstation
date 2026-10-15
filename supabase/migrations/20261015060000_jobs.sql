-- Background jobs (TRD §4.6 work.jobs): resolving a pasted post's ID, Drive change checks, and later the Meta sync
-- and WhatsApp sender. Delivery is at least once, so every handler is idempotent. A job holds a lease while a worker
-- runs it; a worker that dies lets the lease lapse and the job is claimed again. Failures retry with exponential
-- backoff and are parked once the budget is spent, or at once when retrying cannot help, so data health shows them.

create table work.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type ~ '^[a-z][a-z0-9_]*$'),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  state text not null default 'queued' check (state in ('queued', 'running', 'done', 'parked')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint jobs_lease_while_running check ((state = 'running') = (lease_until is not null))
);
-- One waiting or running job per key, so asking twice queues one job.
create unique index jobs_one_pending_per_key on work.jobs (type, dedupe_key) where dedupe_key is not null and state in ('queued', 'running');
create index jobs_due on work.jobs (next_attempt_at) where state = 'queued';
create index jobs_leased on work.jobs (lease_until) where state = 'running';

alter table work.jobs enable row level security;
grant select, insert, update on work.jobs to api_owner;
create policy jobs_commands on work.jobs to api_owner using (true) with check (true);
-- Members read a job's kind, key, state, attempts and error (credentials removed) for data health, never its payload.
grant usage on schema work to authenticated;
grant select (id, type, dedupe_key, state, attempts, last_error, created_at, finished_at) on work.jobs to authenticated;
create policy jobs_read on work.jobs for select to authenticated using ((select app.is_active_member()));

set role api_owner;

-- Removes credentials from text before it is stored or shown: tokens in query strings (access_token=…, input_token=…),
-- bearer tokens, and bare Meta tokens (EAA…). Used for raw responses, job errors and connection errors.
create function app.without_credentials_text(p_text text) returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(regexp_replace(regexp_replace(p_text,
    '(access_token|input_token|fb_exchange_token|appsecret_proof|client_secret|refresh_token|id_token)=[^&#"\s]*', '\1=REDACTED', 'gi'),
    '(bearer|oauth)\s+[A-Za-z0-9._~+/=-]{8,}', '\1 REDACTED', 'gi'),
    'EAA[A-Za-z0-9]{20,}', 'REDACTED', 'g');
$$;

-- Queues a job unless one with the same key is already waiting or running; returns the job either way.
create function app.enqueue_job(p_type text, p_payload jsonb, p_dedupe_key text default null) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_dedupe_key is not null then
    select id into v_id from work.jobs where type = p_type and dedupe_key = p_dedupe_key and state in ('queued', 'running');
    if v_id is not null then
      return v_id;
    end if;
  end if;
  insert into work.jobs (type, payload, dedupe_key) values (p_type, coalesce(p_payload, '{}'::jsonb), p_dedupe_key)
  on conflict (type, dedupe_key) where dedupe_key is not null and state in ('queued', 'running') do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from work.jobs where type = p_type and dedupe_key = p_dedupe_key and state in ('queued', 'running');
  end if;
  return v_id;
end;
$$;

-- Workers queue follow-up work, such as the schedule queuing a sync (B1).
create function worker.enqueue_job(p_type text, p_payload jsonb, p_dedupe_key text default null) returns uuid
language sql
security definer
set search_path = ''
as $$
  select app.enqueue_job(p_type, p_payload, p_dedupe_key);
$$;

-- Leases up to p_limit due jobs of the given types: queued jobs whose next attempt has come, and running jobs whose
-- lease lapsed. Concurrent workers never receive the same job. A job whose lease lapsed after 8 attempts (its worker
-- kept dying) is parked instead, so the retry budget holds even when fail_job is never called.
create function worker.claim_jobs(p_types text[], p_limit integer, p_lease_seconds integer) returns setof work.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  update work.jobs set state = 'parked', lease_until = null, finished_at = now(),
    last_error = left(coalesce(last_error || ' · ', '') || 'its worker stopped answering 8 times', 2000)
  where type = any (p_types) and state = 'running' and lease_until <= now() and attempts >= 8;
  return query
  update work.jobs j
  set state = 'running', attempts = j.attempts + 1, lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 0))
  where j.id in (
    select id from work.jobs
    where type = any (p_types)
      and ((state = 'queued' and next_attempt_at <= now()) or (state = 'running' and lease_until <= now()))
    order by next_attempt_at, created_at
    limit greatest(p_limit, 0)
    for update skip locked)
  returning j.*;
end;
$$;

-- Marks a job done. Repeating it changes nothing, so a handler that finishes twice is harmless. A worker passes the
-- attempt it claimed, so a worker whose lease lapsed can't finish a job another worker has since claimed.
create function worker.complete_job(p_job_id uuid, p_attempt integer default null) returns void
language sql
security definer
set search_path = ''
as $$
  update work.jobs set state = 'done', lease_until = null, finished_at = now(), last_error = null
  where id = p_job_id and state in ('queued', 'running') and (p_attempt is null or attempts = p_attempt);
$$;

-- Records a failed attempt. A retryable failure waits for p_retry_after_seconds when the provider gave a hint, else
-- 30 seconds doubled per attempt with jitter, up to 6 hours; after 8 attempts, or at once when p_permanent, the job is
-- parked with its error (these numbers are proposed, D-58).
create function worker.fail_job(p_job_id uuid, p_error text, p_retry_after_seconds integer default null, p_permanent boolean default false,
  p_attempt integer default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job work.jobs;
  v_wait double precision;
begin
  select * into v_job from work.jobs where id = p_job_id for update;
  if v_job.id is null or v_job.state in ('done', 'parked') or (p_attempt is not null and v_job.attempts <> p_attempt) then
    return;
  end if;
  if p_permanent or v_job.attempts >= 8 then
    update work.jobs set state = 'parked', lease_until = null, finished_at = now(), last_error = left(app.without_credentials_text(p_error), 2000) where id = p_job_id;
    return;
  end if;
  v_wait := coalesce(p_retry_after_seconds::double precision, least(30 * power(2, greatest(v_job.attempts - 1, 0)), 21600) * (0.8 + random() * 0.4));
  update work.jobs
  set state = 'queued', lease_until = null, last_error = left(app.without_credentials_text(p_error), 2000), next_attempt_at = now() + make_interval(secs => greatest(v_wait, 1))
  where id = p_job_id;
end;
$$;

reset role;

-- Parked jobs for data health: what kind of work stopped, how often it was tried and why, never its payload.
create view reporting.parked_jobs with (security_invoker = true) as
  select id, type, attempts, last_error, created_at, finished_at from work.jobs where state = 'parked';
grant select on reporting.parked_jobs to authenticated;

-- Workers may read the queue they serve; they change it only through the functions above.
grant usage on schema work to service_role;
grant select on work.jobs to service_role;
grant execute on function worker.enqueue_job(text, jsonb, text), worker.claim_jobs(text[], integer, integer),
  worker.complete_job(uuid, integer), worker.fail_job(uuid, text, integer, boolean, integer) to service_role;
