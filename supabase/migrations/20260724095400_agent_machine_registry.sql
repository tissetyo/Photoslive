create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.agent_machines (
  machine_id text primary key check (machine_id ~ '^[A-Za-z0-9._:-]{3,160}$'),
  agent_token_hash text not null check (agent_token_hash ~ '^[a-f0-9]{64}$'),
  command_key text not null,
  booth_code text not null check (booth_code = lower(booth_code) and booth_code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  pairing_code text check (pairing_code is null or pairing_code ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$'),
  pairing_expires_at timestamptz,
  paired boolean not null default false,
  snapshot jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists agent_machines_pairing_code_active_idx
  on private.agent_machines(pairing_code)
  where pairing_code is not null;

create index if not exists agent_machines_booth_code_idx
  on private.agent_machines(booth_code);

revoke all on table private.agent_machines from public, anon, authenticated;

create or replace function private.agent_machine_public_snapshot(p_record private.agent_machines)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $$
  select (coalesce(p_record.snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'id', p_record.machine_id,
      'boothCode', p_record.booth_code,
      'paired', p_record.paired,
      'pairingCode', p_record.pairing_code,
      'pairingExpiresAt', p_record.pairing_expires_at,
      'agentTokenHash', p_record.agent_token_hash,
      'commandKey', p_record.command_key,
      'lastSeenAt', p_record.last_seen_at,
      'createdAt', p_record.created_at,
      'updatedAt', p_record.updated_at
    ));
$$;

create or replace function public.photoslive_agent_machine_snapshot(
  p_machine_id text,
  p_agent_token_hash text
)
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
  where machine_id = trim(coalesce(p_machine_id, ''))
    and agent_token_hash = lower(trim(coalesce(p_agent_token_hash, '')));

  if v_record.machine_id is null then
    return null;
  end if;

  return private.agent_machine_public_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_persist_agent_machine(
  p_machine jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_machine_id text := trim(coalesce(p_machine->>'id', ''));
  v_token_hash text := lower(trim(coalesce(p_machine->>'agentTokenHash', '')));
  v_command_key text := left(trim(coalesce(p_machine->>'commandKey', '')), 160);
  v_booth_code text := lower(regexp_replace(trim(coalesce(p_machine->>'boothCode', '')), '[^a-z0-9-]', '', 'g'));
  v_pairing_code text := nullif(upper(trim(coalesce(p_machine->>'pairingCode', ''))), '');
  v_pairing_expires_at timestamptz := null;
  v_paired boolean := coalesce((p_machine->>'paired')::boolean, false);
  v_record private.agent_machines%rowtype;
begin
  if v_machine_id !~ '^[A-Za-z0-9._:-]{3,160}$' or v_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid agent machine credential';
  end if;
  if v_command_key = '' then
    raise exception 'missing agent command key';
  end if;
  if v_booth_code = '' then
    v_booth_code := lower(regexp_replace(v_machine_id, '^machine[_:-]?', 'pl-', 'i'));
    v_booth_code := regexp_replace(v_booth_code, '[^a-z0-9-]', '', 'g');
    v_booth_code := left(v_booth_code, 64);
  end if;
  if v_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid booth code';
  end if;
  if v_pairing_code is not null and v_pairing_code !~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$' then
    raise exception 'invalid pairing code';
  end if;
  if v_pairing_code is not null then
    v_pairing_expires_at := coalesce((p_machine->>'pairingExpiresAt')::timestamptz, now() + interval '15 minutes');
  end if;

  insert into private.agent_machines (
    machine_id, agent_token_hash, command_key, booth_code, pairing_code,
    pairing_expires_at, paired, snapshot, last_seen_at
  )
  values (
    v_machine_id, v_token_hash, v_command_key, v_booth_code, v_pairing_code,
    v_pairing_expires_at, v_paired, p_machine - 'agentTokenHash' - 'commandKey',
    nullif(p_machine->>'lastSeenAt', '')::timestamptz
  )
  on conflict (machine_id) do update set
    agent_token_hash = excluded.agent_token_hash,
    command_key = excluded.command_key,
    booth_code = excluded.booth_code,
    pairing_code = excluded.pairing_code,
    pairing_expires_at = excluded.pairing_expires_at,
    paired = excluded.paired,
    snapshot = excluded.snapshot,
    last_seen_at = excluded.last_seen_at,
    updated_at = now()
  returning * into v_record;

  return private.agent_machine_public_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_create_agent_setup_code(
  p_machine_id text,
  p_agent_token_hash text,
  p_pairing_code text,
  p_booth_code text,
  p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_record private.agent_machines%rowtype;
  v_booth_code text := lower(regexp_replace(trim(coalesce(p_booth_code, '')), '[^a-z0-9-]', '', 'g'));
begin
  if upper(trim(coalesce(p_pairing_code, ''))) !~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$' then
    raise exception 'invalid setup code';
  end if;

  select * into v_record
  from private.agent_machines
  where machine_id = trim(coalesce(p_machine_id, ''))
    and agent_token_hash = lower(trim(coalesce(p_agent_token_hash, '')))
  for update;

  if v_record.machine_id is null then
    raise exception 'agent machine not found';
  end if;

  if v_booth_code = '' then
    v_booth_code := v_record.booth_code;
  end if;
  if v_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid booth code';
  end if;

  update private.agent_machines
  set pairing_code = upper(trim(p_pairing_code)),
      pairing_expires_at = now() + interval '15 minutes',
      booth_code = v_booth_code,
      snapshot = coalesce(p_snapshot, snapshot) - 'agentTokenHash' - 'commandKey',
      updated_at = now()
  where machine_id = v_record.machine_id
  returning * into v_record;

  return private.agent_machine_public_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_pairing_machine_snapshot(p_pairing_code text)
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
  where pairing_code = upper(trim(coalesce(p_pairing_code, '')))
    and pairing_expires_at > now();

  if v_record.machine_id is null then
    return null;
  end if;

  return private.agent_machine_public_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_mark_agent_machine_paired(
  p_pairing_code text,
  p_booth_code text,
  p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_record private.agent_machines%rowtype;
  v_booth_code text := lower(regexp_replace(trim(coalesce(p_booth_code, '')), '[^a-z0-9-]', '', 'g'));
begin
  if v_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid booth code';
  end if;

  select * into v_record
  from private.agent_machines
  where pairing_code = upper(trim(coalesce(p_pairing_code, '')))
    and pairing_expires_at > now()
  for update;

  if v_record.machine_id is null then
    raise exception 'setup code not found';
  end if;

  update private.agent_machines
  set paired = true,
      pairing_code = null,
      pairing_expires_at = null,
      booth_code = v_booth_code,
      snapshot = coalesce(p_snapshot, snapshot) - 'agentTokenHash' - 'commandKey',
      updated_at = now()
  where machine_id = v_record.machine_id
  returning * into v_record;

  return private.agent_machine_public_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_update_agent_heartbeat(
  p_machine_id text,
  p_agent_token_hash text,
  p_snapshot jsonb
)
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
  where machine_id = trim(coalesce(p_machine_id, ''))
    and agent_token_hash = lower(trim(coalesce(p_agent_token_hash, '')))
  for update;

  if v_record.machine_id is null then
    raise exception 'agent machine not found';
  end if;

  update private.agent_machines
  set snapshot = coalesce(p_snapshot, snapshot) - 'agentTokenHash' - 'commandKey',
      paired = coalesce((p_snapshot->>'paired')::boolean, paired),
      booth_code = coalesce(nullif(lower(regexp_replace(trim(coalesce(p_snapshot->>'boothCode', '')), '[^a-z0-9-]', '', 'g')), ''), booth_code),
      last_seen_at = now(),
      updated_at = now()
  where machine_id = v_record.machine_id
  returning * into v_record;

  return private.agent_machine_public_snapshot(v_record);
end;
$$;

revoke all on function private.agent_machine_public_snapshot(private.agent_machines) from public, anon, authenticated;
revoke all on function public.photoslive_agent_machine_snapshot(text, text) from public, anon, authenticated;
revoke all on function public.photoslive_persist_agent_machine(jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_create_agent_setup_code(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_pairing_machine_snapshot(text) from public, anon, authenticated;
revoke all on function public.photoslive_mark_agent_machine_paired(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_update_agent_heartbeat(text, text, jsonb) from public, anon, authenticated;

grant execute on function public.photoslive_agent_machine_snapshot(text, text) to service_role;
grant execute on function public.photoslive_persist_agent_machine(jsonb) to service_role;
grant execute on function public.photoslive_create_agent_setup_code(text, text, text, text, jsonb) to service_role;
grant execute on function public.photoslive_pairing_machine_snapshot(text) to service_role;
grant execute on function public.photoslive_mark_agent_machine_paired(text, text, jsonb) to service_role;
grant execute on function public.photoslive_update_agent_heartbeat(text, text, jsonb) to service_role;
