-- Browser stations are first-class installations. The raw station credential
-- never reaches PostgreSQL; only its SHA-256 hash is persisted.
alter table private.machine_installations
  add column if not exists installation_kind text not null default 'helper'
    check (installation_kind in ('browser', 'helper')),
  add column if not exists credential_hash text,
  add column if not exists capability_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists config_version bigint not null default 1,
  add column if not exists last_sync_at timestamptz,
  add column if not exists helper_desired_state text not null default 'disabled'
    check (helper_desired_state in ('enabled', 'disabled')),
  add column if not exists helper_actual_state text not null default 'not_installed'
    check (helper_actual_state in ('not_installed', 'offline', 'online', 'paused', 'error')),
  add column if not exists helper_bootstrap_hash text,
  add column if not exists helper_bootstrap_expires_at timestamptz,
  add column if not exists helper_bootstrap_used_at timestamptz;

alter table private.machine_installations
  drop constraint if exists machine_installations_credential_hash_check;
alter table private.machine_installations
  add constraint machine_installations_credential_hash_check
    check (credential_hash is null or credential_hash ~ '^[a-f0-9]{64}$');

create unique index if not exists machine_installations_credential_hash_unique
  on private.machine_installations(credential_hash)
  where credential_hash is not null;

alter table private.machine_installations
  drop constraint if exists machine_installations_helper_bootstrap_hash_check;
alter table private.machine_installations
  add constraint machine_installations_helper_bootstrap_hash_check
    check (helper_bootstrap_hash is null or helper_bootstrap_hash ~ '^[a-f0-9]{64}$');

create unique index if not exists machine_installations_helper_bootstrap_hash_unique
  on private.machine_installations(helper_bootstrap_hash)
  where helper_bootstrap_hash is not null;

-- Every existing machine receives one installation record before capability
-- negotiation is enabled. Legacy web stations remain browser-first, while
-- pre-existing Agent installations become optional Helper installations.
insert into private.machine_installations(machine_id)
select machine_id from public.machines
on conflict (machine_id) do nothing;

update private.machine_installations as installation
set installation_kind = case
      when coalesce(machine.agent_version = 'web-only', false)
        or coalesce(machine.metadata->>'installationKind' = 'browser', false)
        or coalesce(machine.metadata->>'installationMode' = 'web', false)
      then 'browser'
      else 'helper'
    end,
    capability_snapshot = case
      when installation.capability_snapshot <> '{}'::jsonb then installation.capability_snapshot
      when jsonb_typeof(machine.metadata->'capabilities') = 'object' then machine.metadata->'capabilities'
      when coalesce(machine.agent_version = 'web-only', false)
        or coalesce(machine.metadata->>'installationKind' = 'browser', false)
        or coalesce(machine.metadata->>'installationMode' = 'web', false)
      then jsonb_build_object(
        'camera', jsonb_build_object('source', 'browser', 'available', true),
        'print', jsonb_build_object('mode', 'dialog', 'available', true, 'silent', false),
        'helper', jsonb_build_object('installed', false, 'enabled', false, 'online', false),
        'dslr', false,
        'managedLocalStorage', false,
        'fullOffline', false
      )
      else '{}'::jsonb
    end,
    helper_desired_state = case
      when coalesce(machine.metadata->>'helperInstalled' = 'true', false)
        or not (
          coalesce(machine.agent_version = 'web-only', false)
          or coalesce(machine.metadata->>'installationKind' = 'browser', false)
          or coalesce(machine.metadata->>'installationMode' = 'web', false)
        )
      then 'enabled'
      else 'disabled'
    end,
    helper_actual_state = case
      when installation.helper_actual_state <> 'not_installed' then installation.helper_actual_state
      when coalesce(machine.metadata->>'helperInstalled' = 'true', false)
        or not (
          coalesce(machine.agent_version = 'web-only', false)
          or coalesce(machine.metadata->>'installationKind' = 'browser', false)
          or coalesce(machine.metadata->>'installationMode' = 'web', false)
        )
      then 'offline'
      else 'not_installed'
    end,
    updated_at = now()
from public.machines as machine
where machine.machine_id = installation.machine_id;

create or replace function public.photoslive_register_browser_installation(
  p_machine_id text,
  p_credential_hash text,
  p_capability_snapshot jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_machine public.machines;
  target_installation private.machine_installations;
begin
  if p_credential_hash is null or p_credential_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid station credential';
  end if;

  select * into target_machine
  from public.machines
  where machine_id = p_machine_id
  for update;
  if target_machine.id is null then raise exception 'machine not found'; end if;

  insert into private.machine_installations(
    machine_id, installation_kind, credential_hash, capability_snapshot,
    helper_desired_state, helper_actual_state, credential_rotated_at, updated_at
  ) values (
    p_machine_id, 'browser', p_credential_hash, coalesce(p_capability_snapshot, '{}'::jsonb),
    'disabled', 'not_installed', now(), now()
  )
  on conflict (machine_id) do update set
    installation_kind = 'browser',
    credential_hash = excluded.credential_hash,
    capability_snapshot = excluded.capability_snapshot,
    helper_desired_state = 'disabled',
    helper_actual_state = case
      when private.machine_installations.helper_actual_state = 'not_installed' then 'not_installed'
      else private.machine_installations.helper_actual_state
    end,
    credential_generation = private.machine_installations.credential_generation + 1,
    credential_rotated_at = now(),
    updated_at = now()
  returning * into target_installation;

  update public.machines
  set metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object(
        'installationKind', 'browser',
        'capabilities', coalesce(p_capability_snapshot, '{}'::jsonb)
      ),
      updated_at = now()
  where machine_id = p_machine_id;

  return jsonb_build_object(
    'machineId', target_installation.machine_id,
    'installationKind', target_installation.installation_kind,
    'credentialGeneration', target_installation.credential_generation
  );
end;
$$;

create or replace function public.photoslive_station_bootstrap(
  p_machine_id text,
  p_credential_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_installation private.machine_installations;
  target_machine public.machines;
  target_booth public.booths;
begin
  select * into target_installation
  from private.machine_installations
  where machine_id = p_machine_id
    and credential_hash = p_credential_hash
    and installation_kind = 'browser'
  for update;

  if target_installation.machine_id is null then raise exception 'station credential invalid'; end if;

  select * into target_machine
  from public.machines
  where machine_id = p_machine_id;

  if target_machine.id is null or target_machine.status <> 'paired' or target_machine.organization_id is null then
    raise exception 'station not paired';
  end if;

  select * into target_booth
  from public.booths
  where machine_id = p_machine_id
    and organization_id = target_machine.organization_id
  limit 1;
  if target_booth.id is null then raise exception 'booth not found'; end if;

  update private.machine_installations
  set last_acknowledged_at = now(), updated_at = now()
  where machine_id = p_machine_id;

  return jsonb_build_object(
    'machineId', target_machine.machine_id,
    'machineCode', target_machine.machine_code,
    'machineName', target_machine.name,
    'organizationId', target_machine.organization_id,
    'boothCode', target_booth.code,
    'boothName', target_booth.name,
    'location', target_booth.location,
    'installationKind', target_installation.installation_kind,
    'capabilities', target_installation.capability_snapshot,
    'helper', jsonb_build_object(
      'desiredState', target_installation.helper_desired_state,
      'actualState', target_installation.helper_actual_state,
      'available', target_installation.helper_actual_state in ('online', 'paused', 'offline')
    ),
    'configVersion', target_installation.config_version,
    'lastSyncAt', target_installation.last_sync_at
  );
end;
$$;

create or replace function public.photoslive_update_station_capabilities(
  p_machine_id text,
  p_credential_hash text,
  p_capability_snapshot jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated private.machine_installations;
begin
  update private.machine_installations
  set capability_snapshot = coalesce(p_capability_snapshot, '{}'::jsonb),
      last_sync_at = now(),
      updated_at = now()
  where machine_id = p_machine_id
    and credential_hash = p_credential_hash
    and installation_kind = 'browser'
  returning * into updated;
  if updated.machine_id is null then raise exception 'station credential invalid'; end if;

  update public.machines
  set metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object('installationKind', 'browser', 'capabilities', updated.capability_snapshot),
      last_seen_at = now(),
      updated_at = now()
  where machine_id = p_machine_id;

  return jsonb_build_object(
    'machineId', updated.machine_id,
    'capabilities', updated.capability_snapshot,
    'lastSyncAt', updated.last_sync_at
  );
end;
$$;

-- Cloud Admin and the booth bootstrap read the negotiated runtime from one
-- service-role-only snapshot. Machine-id prefixes are deliberately ignored.
create or replace function public.photoslive_machine_runtime(
  p_machine_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_machine public.machines;
  target_installation private.machine_installations;
  resolved_kind text;
  resolved_capabilities jsonb;
begin
  select * into target_machine
  from public.machines
  where machine_id = p_machine_id;
  if target_machine.id is null then return null; end if;

  select * into target_installation
  from private.machine_installations
  where machine_id = p_machine_id;

  resolved_kind := coalesce(
    target_installation.installation_kind,
    nullif(target_machine.metadata->>'installationKind', ''),
    case when target_machine.agent_version = 'web-only' then 'browser' else 'helper' end
  );
  if resolved_kind not in ('browser', 'helper') then resolved_kind := 'browser'; end if;

  resolved_capabilities := coalesce(
    target_installation.capability_snapshot,
    target_machine.metadata->'capabilities',
    '{}'::jsonb
  );

  return jsonb_build_object(
    'machineId', target_machine.machine_id,
    'installationKind', resolved_kind,
    'capabilities', resolved_capabilities,
    'helper', jsonb_build_object(
      'desiredState', coalesce(target_installation.helper_desired_state, 'disabled'),
      'actualState', coalesce(
        target_installation.helper_actual_state,
        case when resolved_kind = 'helper' then 'offline' else 'not_installed' end
      ),
      'available', coalesce(target_installation.helper_actual_state, '') in ('online', 'paused', 'offline')
    ),
    'configVersion', coalesce(target_installation.config_version, 1),
    'lastSyncAt', target_installation.last_sync_at
  );
end;
$$;

create or replace function public.photoslive_revoke_browser_station(
  p_machine_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.machine_installations
  set credential_hash = null,
      credential_generation = credential_generation + 1,
      credential_rotated_at = now(),
      updated_at = now()
  where machine_id = p_machine_id
    and installation_kind = 'browser';
  return jsonb_build_object('machineId', p_machine_id, 'revoked', found);
end;
$$;

create or replace function public.photoslive_set_helper_desired_state(
  p_machine_id text,
  p_organization_id uuid,
  p_enabled boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_machine public.machines;
  updated private.machine_installations;
begin
  select * into target_machine
  from public.machines
  where machine_id = p_machine_id
    and organization_id = p_organization_id
    and status = 'paired'
  for update;
  if target_machine.id is null then raise exception 'machine not found'; end if;

  insert into private.machine_installations(
    machine_id, installation_kind, capability_snapshot,
    helper_desired_state, helper_actual_state, updated_at
  ) values (
    p_machine_id, 'browser', '{}'::jsonb,
    case when p_enabled then 'enabled' else 'disabled' end,
    'not_installed', now()
  )
  on conflict (machine_id) do update set
    helper_desired_state = case when p_enabled then 'enabled' else 'disabled' end,
    updated_at = now()
  returning * into updated;

  return jsonb_build_object(
    'machineId', updated.machine_id,
    'desiredState', updated.helper_desired_state,
    'actualState', updated.helper_actual_state,
    'available', updated.helper_actual_state in ('online', 'paused', 'offline')
  );
end;
$$;

-- Admin creates this short-lived bootstrap only after the browser station is
-- paired. The raw token is returned by the API and never stored in Postgres.
create or replace function public.photoslive_create_helper_bootstrap(
  p_machine_id text,
  p_organization_id uuid,
  p_token_hash text,
  p_expires_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_machine public.machines;
  target_booth public.booths;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid helper bootstrap token';
  end if;
  if p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '30 minutes' then
    raise exception 'invalid helper bootstrap expiry';
  end if;

  select * into target_machine
  from public.machines
  where machine_id = p_machine_id
    and organization_id = p_organization_id
    and status = 'paired'
  for update;
  if target_machine.id is null then raise exception 'machine not found'; end if;

  select * into target_booth
  from public.booths
  where machine_id = p_machine_id
    and organization_id = p_organization_id
  limit 1;
  if target_booth.id is null then raise exception 'booth not found'; end if;

  update private.machine_installations
  set helper_bootstrap_hash = p_token_hash,
      helper_bootstrap_expires_at = p_expires_at,
      helper_bootstrap_used_at = null,
      helper_desired_state = 'enabled',
      updated_at = now()
  where machine_id = p_machine_id;
  if not found then raise exception 'browser installation not found'; end if;

  return jsonb_build_object(
    'machineId', target_machine.machine_id,
    'machineCode', target_machine.machine_code,
    'boothCode', target_booth.code,
    'expiresAt', p_expires_at
  );
end;
$$;

-- The installer exchanges its one-time bootstrap for the normal Helper
-- credential. It does not create or claim another machine.
create or replace function public.photoslive_activate_helper(
  p_token_hash text,
  p_agent_token_hash text,
  p_command_key text,
  p_platform text,
  p_agent_version text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_installation private.machine_installations;
  target_machine public.machines;
  target_booth public.booths;
  helper_snapshot jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_agent_token_hash is null or p_agent_token_hash !~ '^[a-f0-9]{64}$'
    or coalesce(trim(p_command_key), '') = '' then
    raise exception 'invalid helper credential';
  end if;

  select * into target_installation
  from private.machine_installations
  where helper_bootstrap_hash = p_token_hash
    and helper_bootstrap_used_at is null
    and helper_bootstrap_expires_at > now()
  for update;
  if target_installation.machine_id is null then raise exception 'helper bootstrap invalid or expired'; end if;

  select * into target_machine
  from public.machines
  where machine_id = target_installation.machine_id
    and status = 'paired'
    and organization_id is not null
  for update;
  if target_machine.id is null then raise exception 'paired machine not found'; end if;

  select * into target_booth
  from public.booths
  where machine_id = target_machine.machine_id
    and organization_id = target_machine.organization_id
  limit 1;
  if target_booth.id is null then raise exception 'booth not found'; end if;

  helper_snapshot := jsonb_build_object(
    'id', target_machine.machine_id,
    'name', target_machine.name,
    'platform', left(coalesce(p_platform, ''), 240),
    'agentVersion', left(coalesce(p_agent_version, ''), 40),
    'boothCode', target_booth.code,
    'paired', true,
    'agentState', 'starting',
    'desiredState', 'running'
  );

  insert into private.agent_machines(
    machine_id, agent_token_hash, command_key, booth_code, paired,
    snapshot, last_seen_at, updated_at
  ) values (
    target_machine.machine_id, p_agent_token_hash, left(p_command_key, 160),
    target_booth.code, true, helper_snapshot, null, now()
  )
  on conflict (machine_id) do update set
    agent_token_hash = excluded.agent_token_hash,
    command_key = excluded.command_key,
    booth_code = excluded.booth_code,
    pairing_code = null,
    pairing_expires_at = null,
    paired = true,
    snapshot = excluded.snapshot,
    last_seen_at = null,
    updated_at = now();

  update private.machine_installations
  set helper_bootstrap_used_at = now(),
      helper_bootstrap_hash = null,
      helper_bootstrap_expires_at = null,
      helper_desired_state = 'enabled',
      helper_actual_state = 'offline',
      updated_at = now()
  where machine_id = target_machine.machine_id;

  update public.machines
  set platform = left(coalesce(p_platform, platform), 240),
      agent_version = left(coalesce(p_agent_version, ''), 40),
      metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('installationKind', 'browser', 'helperInstalled', true),
      updated_at = now()
  where machine_id = target_machine.machine_id;

  return jsonb_build_object(
    'machineId', target_machine.machine_id,
    'machineCode', target_machine.machine_code,
    'boothCode', target_booth.code,
    'paired', true,
    'helperState', 'offline'
  );
end;
$$;

create or replace function public.photoslive_update_helper_runtime(
  p_machine_id text,
  p_actual_state text,
  p_capability_snapshot jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolved_state text;
  updated private.machine_installations;
begin
  resolved_state := case
    when p_actual_state in ('offline', 'online', 'paused', 'error') then p_actual_state
    else 'error'
  end;
  update private.machine_installations
  set helper_actual_state = resolved_state,
      capability_snapshot = coalesce(capability_snapshot, '{}'::jsonb)
        || jsonb_build_object('helper', coalesce(p_capability_snapshot, '{}'::jsonb)),
      last_sync_at = now(),
      updated_at = now()
  where machine_id = p_machine_id
  returning * into updated;
  if updated.machine_id is null then raise exception 'installation not found'; end if;
  return jsonb_build_object(
    'machineId', updated.machine_id,
    'desiredState', updated.helper_desired_state,
    'actualState', updated.helper_actual_state
  );
end;
$$;

-- Pairing completion wakes the QR screen immediately. The topic contains only
-- an unguessable claim UUID; the permanent station credential is never sent.
create or replace function private.photoslive_broadcast_machine_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'claimed' and old.status is distinct from new.status then
    perform realtime.send(
      jsonb_build_object('claimId', new.id, 'status', new.status),
      'claimed',
      'pairing:' || new.id::text,
      false
    );
  end if;
  return new;
end;
$$;

drop trigger if exists photoslive_machine_claim_broadcast on private.machine_claims;
create trigger photoslive_machine_claim_broadcast
after update of status on private.machine_claims
for each row execute function private.photoslive_broadcast_machine_claim();

grant execute on function public.photoslive_register_browser_installation(text, text, jsonb) to service_role;
grant execute on function public.photoslive_station_bootstrap(text, text) to service_role;
grant execute on function public.photoslive_update_station_capabilities(text, text, jsonb) to service_role;
grant execute on function public.photoslive_revoke_browser_station(text) to service_role;
grant execute on function public.photoslive_machine_runtime(text) to service_role;
grant execute on function public.photoslive_set_helper_desired_state(text, uuid, boolean) to service_role;
grant execute on function public.photoslive_create_helper_bootstrap(text, uuid, text, timestamptz) to service_role;
grant execute on function public.photoslive_activate_helper(text, text, text, text, text) to service_role;
grant execute on function public.photoslive_update_helper_runtime(text, text, jsonb) to service_role;

revoke all on function public.photoslive_register_browser_installation(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_station_bootstrap(text, text) from public, anon, authenticated;
revoke all on function public.photoslive_update_station_capabilities(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_revoke_browser_station(text) from public, anon, authenticated;
revoke all on function public.photoslive_machine_runtime(text) from public, anon, authenticated;
revoke all on function public.photoslive_set_helper_desired_state(text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.photoslive_create_helper_bootstrap(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.photoslive_activate_helper(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.photoslive_update_helper_runtime(text, text, jsonb) from public, anon, authenticated;
