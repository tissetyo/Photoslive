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
  v_machine_id text := trim(coalesce(p_machine_id, ''));
  v_token_hash text := lower(trim(coalesce(p_agent_token_hash, '')));
  v_pairing_code text := upper(trim(coalesce(p_pairing_code, '')));
  v_booth_code text := lower(regexp_replace(trim(coalesce(p_booth_code, '')), '[^a-z0-9-]', '', 'g'));
  v_command_key text := left(trim(coalesce(p_snapshot->>'commandKey', '')), 160);
  v_record private.agent_machines%rowtype;
begin
  if v_machine_id !~ '^[A-Za-z0-9._:-]{3,160}$' or v_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid agent machine credential';
  end if;
  if v_pairing_code !~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$' then
    raise exception 'invalid setup code';
  end if;
  if v_booth_code = '' then
    v_booth_code := lower(regexp_replace(v_machine_id, '^machine[_:-]?', 'pl-', 'i'));
    v_booth_code := regexp_replace(v_booth_code, '[^a-z0-9-]', '', 'g');
    v_booth_code := left(v_booth_code, 64);
  end if;
  if v_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid booth code';
  end if;
  if v_command_key = '' then
    v_command_key := 'command_' || substr(md5(v_machine_id || ':' || v_token_hash), 1, 32);
  end if;

  insert into private.agent_machines (
    machine_id, agent_token_hash, command_key, booth_code, paired, snapshot,
    last_seen_at, created_at, updated_at
  )
  values (
    v_machine_id, v_token_hash, v_command_key, v_booth_code, false,
    coalesce(p_snapshot, '{}'::jsonb) - 'agentTokenHash' - 'commandKey',
    now(), now(), now()
  )
  on conflict (machine_id) do update set
    agent_token_hash = excluded.agent_token_hash,
    command_key = coalesce(nullif(private.agent_machines.command_key, ''), excluded.command_key),
    booth_code = coalesce(nullif(v_booth_code, ''), private.agent_machines.booth_code),
    snapshot = coalesce(p_snapshot, private.agent_machines.snapshot) - 'agentTokenHash' - 'commandKey',
    updated_at = now()
  returning * into v_record;

  update private.agent_machines
  set pairing_code = v_pairing_code,
      pairing_expires_at = now() + interval '15 minutes',
      booth_code = v_booth_code,
      snapshot = coalesce(p_snapshot, snapshot) - 'agentTokenHash' - 'commandKey',
      updated_at = now()
  where machine_id = v_record.machine_id
  returning * into v_record;

  return private.agent_machine_public_snapshot(v_record);
end;
$$;

revoke all on function public.photoslive_create_agent_setup_code(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.photoslive_create_agent_setup_code(text, text, text, text, jsonb) to service_role;
