-- Durable Helper command queue. Redis remains an optional cache, while the
-- production command path is stored in PostgreSQL so an exhausted cache quota
-- cannot disable camera, printer, or Controller requests.
create table if not exists private.agent_jobs (
  job_id text primary key check (job_id ~ '^job_[a-f0-9]{32}$'),
  machine_id text not null references private.agent_machines(machine_id) on delete cascade,
  job_type text not null check (length(job_type) between 3 and 80),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'running', 'completed', 'failed', 'expired')),
  signature text not null check (signature ~ '^[a-f0-9]{64}$'),
  idempotency_key text,
  retry_of text,
  attempts integer not null default 0 check (attempts >= 0),
  result jsonb not null default '{}'::jsonb,
  error text,
  expires_at timestamptz not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agent_jobs_machine_idempotency_idx
  on private.agent_jobs(machine_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists agent_jobs_claim_idx
  on private.agent_jobs(machine_id, status, created_at);

revoke all on table private.agent_jobs from public, anon, authenticated;

create or replace function private.agent_job_snapshot(p_record private.agent_jobs)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'id', p_record.job_id,
    'machineId', p_record.machine_id,
    'type', p_record.job_type,
    'payload', p_record.payload,
    'status', p_record.status,
    'signature', p_record.signature,
    'idempotencyKey', p_record.idempotency_key,
    'retryOf', p_record.retry_of,
    'attempts', p_record.attempts,
    'result', p_record.result,
    'error', p_record.error,
    'expiresAt', p_record.expires_at,
    'claimedAt', p_record.claimed_at,
    'createdAt', p_record.created_at,
    'updatedAt', p_record.updated_at
  );
$$;

create or replace function public.photoslive_agent_machine_internal(p_machine_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_record private.agent_machines%rowtype;
begin
  select * into v_record
  from private.agent_machines
  where machine_id = trim(coalesce(p_machine_id, ''));

  if v_record.machine_id is null then
    return null;
  end if;
  return private.agent_machine_public_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_enqueue_agent_job(p_job jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_job_id text := trim(coalesce(p_job->>'id', ''));
  v_machine_id text := trim(coalesce(p_job->>'machineId', ''));
  v_type text := left(trim(coalesce(p_job->>'type', '')), 80);
  v_payload jsonb := coalesce(p_job->'payload', '{}'::jsonb);
  v_signature text := lower(trim(coalesce(p_job->>'signature', '')));
  v_idempotency_key text := nullif(left(trim(coalesce(p_job->>'idempotencyKey', '')), 120), '');
  v_retry_of text := nullif(left(trim(coalesce(p_job->>'retryOf', '')), 80), '');
  v_expires_at timestamptz := nullif(p_job->>'expiresAt', '')::timestamptz;
  v_machine private.agent_machines%rowtype;
  v_record private.agent_jobs%rowtype;
begin
  if v_job_id !~ '^job_[a-f0-9]{32}$' or v_machine_id = '' or v_type = '' or v_signature !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid agent job';
  end if;
  if octet_length(v_payload::text) > 16384 or v_expires_at is null or v_expires_at <= now() then
    raise exception 'invalid agent job payload or expiry';
  end if;

  select * into v_machine
  from private.agent_machines
  where machine_id = v_machine_id
  for update;
  if v_machine.machine_id is null or not v_machine.paired then
    raise exception 'agent machine is not paired';
  end if;

  if v_idempotency_key is not null then
    select * into v_record
    from private.agent_jobs
    where machine_id = v_machine_id and idempotency_key = v_idempotency_key;
    if v_record.job_id is not null then
      return private.agent_job_snapshot(v_record) || jsonb_build_object('reused', true);
    end if;
  end if;

  insert into private.agent_jobs (
    job_id, machine_id, job_type, payload, signature, idempotency_key,
    retry_of, expires_at
  ) values (
    v_job_id, v_machine_id, v_type, v_payload, v_signature,
    v_idempotency_key, v_retry_of, v_expires_at
  )
  returning * into v_record;

  return private.agent_job_snapshot(v_record) || jsonb_build_object('reused', false);
exception
  when unique_violation then
    select * into v_record
    from private.agent_jobs
    where machine_id = v_machine_id and idempotency_key = v_idempotency_key;
    if v_record.job_id is null then
      raise;
    end if;
    return private.agent_job_snapshot(v_record) || jsonb_build_object('reused', true);
end;
$$;

create or replace function public.photoslive_claim_agent_job(p_machine_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_record private.agent_jobs%rowtype;
begin
  update private.agent_jobs
  set status = 'expired', error = 'Command kedaluwarsa sebelum dijalankan', updated_at = now()
  where machine_id = trim(coalesce(p_machine_id, ''))
    and status = 'queued'
    and expires_at <= now();

  select * into v_record
  from private.agent_jobs
  where machine_id = trim(coalesce(p_machine_id, ''))
    and status = 'queued'
    and expires_at > now()
  order by created_at
  for update skip locked
  limit 1;

  if v_record.job_id is null then
    return null;
  end if;

  update private.agent_jobs
  set status = 'claimed', claimed_at = now(), updated_at = now(), attempts = attempts + 1
  where job_id = v_record.job_id
  returning * into v_record;
  return private.agent_job_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_update_agent_job(
  p_machine_id text,
  p_job_id text,
  p_status text,
  p_result jsonb default '{}'::jsonb,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_record private.agent_jobs%rowtype;
begin
  if not (trim(coalesce(p_status, '')) = any(array['running', 'completed', 'failed'])) then
    raise exception 'invalid agent job status';
  end if;
  if octet_length(coalesce(p_result, '{}'::jsonb)::text) > 65536 then
    raise exception 'agent job result too large';
  end if;

  update private.agent_jobs
  set status = trim(p_status),
      result = coalesce(p_result, '{}'::jsonb),
      error = case when trim(p_status) = 'failed' then left(coalesce(p_error, 'Job gagal'), 500) else null end,
      updated_at = now()
  where job_id = trim(coalesce(p_job_id, ''))
    and machine_id = trim(coalesce(p_machine_id, ''))
  returning * into v_record;

  if v_record.job_id is null then
    return null;
  end if;
  return private.agent_job_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_agent_job_status(p_machine_id text, p_job_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select private.agent_job_snapshot(job)
  from private.agent_jobs job
  where job.machine_id = trim(coalesce(p_machine_id, ''))
    and job.job_id = trim(coalesce(p_job_id, ''));
$$;

revoke all on function private.agent_job_snapshot(private.agent_jobs) from public, anon, authenticated;
revoke all on function public.photoslive_agent_machine_internal(text) from public, anon, authenticated;
revoke all on function public.photoslive_enqueue_agent_job(jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_claim_agent_job(text) from public, anon, authenticated;
revoke all on function public.photoslive_update_agent_job(text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.photoslive_agent_job_status(text, text) from public, anon, authenticated;

grant execute on function public.photoslive_agent_machine_internal(text) to service_role;
grant execute on function public.photoslive_enqueue_agent_job(jsonb) to service_role;
grant execute on function public.photoslive_claim_agent_job(text) to service_role;
grant execute on function public.photoslive_update_agent_job(text, text, text, jsonb, text) to service_role;
grant execute on function public.photoslive_agent_job_status(text, text) to service_role;
