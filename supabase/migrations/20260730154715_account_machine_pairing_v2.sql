create extension if not exists pgcrypto;
create schema if not exists private;

alter table public.profiles
  add column if not exists admin_code text;
create unique index if not exists profiles_admin_code_unique
  on public.profiles(admin_code) where admin_code is not null;

alter table public.organizations
  add column if not exists public_code text;
create unique index if not exists organizations_public_code_unique
  on public.organizations(public_code) where public_code is not null;

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'operator')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.machines (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null unique check (machine_id ~ '^[A-Za-z0-9._:-]{3,160}$'),
  machine_code text not null unique check (machine_code ~ '^MCH-[A-Z0-9]{8}$'),
  organization_id uuid references public.organizations(id) on delete restrict,
  status text not null default 'unpaired' check (status in ('unpaired', 'paired', 'revoked', 'conflict')),
  name text not null default 'Photoslive Machine',
  platform text not null default '',
  agent_version text not null default '',
  controller_version text not null default '',
  last_seen_at timestamptz,
  paired_at timestamptz,
  paired_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  installation_generation bigint not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.booths
  add column if not exists machine_id text;
create unique index if not exists booths_machine_id_unique
  on public.booths(machine_id) where machine_id is not null;

create table if not exists public.machine_ownership_history (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null,
  from_organization_id uuid references public.organizations(id) on delete set null,
  to_organization_id uuid references public.organizations(id) on delete set null,
  action text not null check (action in ('paired', 'revoked', 'reassigned', 'conflict', 'recovered')),
  actor_id uuid references auth.users(id) on delete set null,
  reason text not null default '',
  idempotency_key text not null unique,
  correlation_id text not null,
  created_at timestamptz not null default now()
);

create table if not exists private.machine_installations (
  machine_id text primary key,
  credential_generation bigint not null default 1,
  credential_rotated_at timestamptz,
  local_mapping_version bigint not null default 1,
  last_acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists private.machine_claims (
  id uuid primary key default gen_random_uuid(),
  machine_id text not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  fallback_code_hash text not null unique check (fallback_code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'expired', 'revoked', 'failed')),
  requester_id uuid references auth.users(id) on delete set null,
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_organization_id uuid references public.organizations(id) on delete set null,
  claimed_at timestamptz,
  idempotency_key text not null unique,
  snapshot jsonb not null default '{}'::jsonb,
  failure_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists machine_claims_pending_expiry_idx
  on private.machine_claims(expires_at) where status = 'pending';

create table if not exists private.trusted_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_hash text not null unique check (session_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  user_agent_hash text,
  created_at timestamptz not null default now()
);

revoke all on table private.machine_installations from public, anon, authenticated;
revoke all on table private.machine_claims from public, anon, authenticated;
revoke all on table private.trusted_sessions from public, anon, authenticated;

create or replace function private.photoslive_unique_public_code(p_prefix text, p_table text, p_column text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate text;
  exists_value boolean;
begin
  for attempt in 1..20 loop
    candidate := upper(p_prefix || '-' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8));
    execute format('select exists(select 1 from %s where %I = $1)', p_table, p_column)
      into exists_value using candidate;
    if not exists_value then return candidate; end if;
  end loop;
  raise exception 'unique public code unavailable';
end;
$$;

revoke all on function private.photoslive_unique_public_code(text, text, text) from public, anon, authenticated;

create or replace function public.photoslive_bootstrap_account(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_organization uuid;
  target_admin_code text;
  target_org_code text;
begin
  if p_user_id is null or coalesce(trim(p_email), '') = '' then
    raise exception 'invalid account identity';
  end if;

  insert into public.profiles(id, email, display_name, admin_code)
  values (
    p_user_id,
    lower(trim(p_email)),
    left(coalesce(nullif(trim(p_display_name), ''), 'Pemilik'), 120),
    private.photoslive_unique_public_code('ADM', 'public.profiles', 'admin_code')
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(public.profiles.display_name, excluded.display_name),
    admin_code = coalesce(public.profiles.admin_code, excluded.admin_code),
    updated_at = now()
  returning admin_code into target_admin_code;

  select membership.organization_id
    into target_organization
  from public.organization_members membership
  where membership.user_id = p_user_id
  order by membership.created_at
  limit 1;

  if target_organization is null then
    target_org_code := private.photoslive_unique_public_code('ORG', 'public.organizations', 'public_code');
    insert into public.organizations(name, public_code)
    values (left(split_part(lower(trim(p_email)), '@', 1) || ' Photoslive', 120), target_org_code)
    returning id into target_organization;

    insert into public.organization_members(organization_id, user_id, role)
    values (target_organization, p_user_id, 'owner');
  end if;

  insert into public.audit_logs(actor_id, actor_role, action, target_type, target_id, correlation_id, detail)
  select p_user_id, 'owner', 'account.bootstrap', 'organization', target_organization::text,
    coalesce(nullif(p_idempotency_key, ''), gen_random_uuid()::text),
    jsonb_build_object('email', lower(trim(p_email)))
  where not exists (
    select 1 from public.audit_logs
    where action = 'account.bootstrap'
      and actor_id = p_user_id
      and correlation_id = coalesce(nullif(p_idempotency_key, ''), '')
  );

  return public.photoslive_account_snapshot(p_user_id);
end;
$$;

create or replace function public.photoslive_account_snapshot(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with membership as (
    select om.organization_id, om.role
    from public.organization_members om
    where om.user_id = p_user_id
    order by om.created_at
    limit 1
  )
  select jsonb_build_object(
    'userId', profile.id,
    'email', profile.email,
    'displayName', coalesce(profile.display_name, 'Pemilik'),
    'adminCode', profile.admin_code,
    'organizationId', organization.id,
    'organizationCode', organization.public_code,
    'organizationName', organization.name,
    'role', membership.role,
    'machines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'machineId', machine.machine_id,
        'machineCode', machine.machine_code,
        'name', machine.name,
        'status', machine.status,
        'platform', machine.platform,
        'agentVersion', machine.agent_version,
        'controllerVersion', machine.controller_version,
        'lastSeenAt', machine.last_seen_at,
        'pairedAt', machine.paired_at
      ) order by machine.created_at)
      from public.machines machine
      where machine.organization_id = organization.id
    ), '[]'::jsonb),
    'booths', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', booth.id,
        'boothCode', booth.code,
        'machineId', booth.machine_id,
        'name', booth.name,
        'location', booth.location,
        'accessEnabled', booth.access_enabled
      ) order by booth.created_at)
      from public.booths booth
      where booth.organization_id = organization.id
    ), '[]'::jsonb)
  )
  from public.profiles profile
  join membership on true
  join public.organizations organization on organization.id = membership.organization_id
  where profile.id = p_user_id;
$$;

create or replace function public.photoslive_create_machine_claim(
  p_machine_id text,
  p_token_hash text,
  p_code_hash text,
  p_expires_at timestamptz,
  p_snapshot jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_claim private.machine_claims;
  target_machine public.machines;
begin
  if p_machine_id !~ '^[A-Za-z0-9._:-]{3,160}$'
    or p_token_hash !~ '^[a-f0-9]{64}$'
    or p_code_hash !~ '^[a-f0-9]{64}$'
    or p_expires_at <= now() then
    raise exception 'invalid machine claim';
  end if;

  insert into public.machines(machine_id, machine_code, name, platform, agent_version, controller_version, metadata)
  values (
    p_machine_id,
    private.photoslive_unique_public_code('MCH', 'public.machines', 'machine_code'),
    left(coalesce(nullif(p_snapshot->>'name', ''), 'Photoslive Machine'), 120),
    left(coalesce(p_snapshot->>'platform', ''), 120),
    left(coalesce(p_snapshot->>'agentVersion', ''), 40),
    left(coalesce(p_snapshot->>'controllerVersion', ''), 40),
    coalesce(p_snapshot, '{}'::jsonb)
  )
  on conflict (machine_id) do update set
    name = excluded.name,
    platform = excluded.platform,
    agent_version = excluded.agent_version,
    controller_version = excluded.controller_version,
    metadata = public.machines.metadata || excluded.metadata,
    updated_at = now()
  returning * into target_machine;

  update private.machine_claims
  set status = 'revoked', updated_at = now()
  where machine_id = p_machine_id and status = 'pending';

  insert into private.machine_claims(machine_id, token_hash, fallback_code_hash, expires_at, snapshot, idempotency_key)
  values (p_machine_id, p_token_hash, p_code_hash, p_expires_at, coalesce(p_snapshot, '{}'::jsonb), p_idempotency_key)
  on conflict (idempotency_key) do update set updated_at = private.machine_claims.updated_at
  returning * into target_claim;

  insert into private.machine_installations(machine_id)
  values (p_machine_id)
  on conflict (machine_id) do nothing;

  return jsonb_build_object(
    'claimId', target_claim.id,
    'machineId', target_machine.machine_id,
    'machineCode', target_machine.machine_code,
    'status', target_claim.status,
    'expiresAt', target_claim.expires_at
  );
end;
$$;

create or replace function public.photoslive_machine_claim_snapshot(
  p_token_hash text default null,
  p_code_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_claim private.machine_claims;
  target_machine public.machines;
begin
  select * into target_claim
  from private.machine_claims claim
  where (p_token_hash is not null and claim.token_hash = p_token_hash)
     or (p_code_hash is not null and claim.fallback_code_hash = p_code_hash)
  order by claim.created_at desc
  limit 1;

  if target_claim.id is null then return null; end if;
  if target_claim.status = 'pending' and target_claim.expires_at <= now() then
    update private.machine_claims set status = 'expired', updated_at = now()
    where id = target_claim.id
    returning * into target_claim;
  end if;
  select * into target_machine from public.machines where machine_id = target_claim.machine_id;
  return jsonb_build_object(
    'claimId', target_claim.id,
    'machineId', target_machine.machine_id,
    'machineCode', target_machine.machine_code,
    'name', target_machine.name,
    'platform', target_machine.platform,
    'agentVersion', target_machine.agent_version,
    'controllerVersion', target_machine.controller_version,
    'devices', coalesce(target_claim.snapshot->'devices', '[]'::jsonb),
    'status', target_claim.status,
    'expiresAt', target_claim.expires_at
  );
end;
$$;

create or replace function public.photoslive_claim_machine(
  p_user_id uuid,
  p_organization_id uuid,
  p_token_hash text,
  p_code_hash text,
  p_booth_name text,
  p_location text,
  p_idempotency_key text,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_claim private.machine_claims;
  target_machine public.machines;
  target_booth public.booths;
  booth_code text;
begin
  if not exists (
    select 1 from public.organization_members membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.role in ('owner', 'admin')
  ) then raise exception 'organization access denied'; end if;

  select * into target_claim
  from private.machine_claims claim
  where ((p_token_hash is not null and claim.token_hash = p_token_hash)
      or (p_code_hash is not null and claim.fallback_code_hash = p_code_hash))
  for update;

  if target_claim.id is null then raise exception 'pairing not found'; end if;
  if target_claim.status = 'claimed' then
    if target_claim.idempotency_key = p_idempotency_key or target_claim.claimed_by = p_user_id then
      select * into target_machine from public.machines where machine_id = target_claim.machine_id;
      select * into target_booth from public.booths where machine_id = target_claim.machine_id;
      return jsonb_build_object('machine', to_jsonb(target_machine), 'booth', to_jsonb(target_booth), 'replayed', true);
    end if;
    raise exception 'pairing already used';
  end if;
  if target_claim.status <> 'pending' or target_claim.expires_at <= now() then
    update private.machine_claims set status = 'expired', updated_at = now() where id = target_claim.id;
    raise exception 'pairing expired';
  end if;

  select * into target_machine
  from public.machines
  where machine_id = target_claim.machine_id
  for update;

  if target_machine.organization_id is not null
    and target_machine.organization_id <> p_organization_id
    and target_machine.status = 'paired' then
    update public.machines set status = 'conflict', updated_at = now() where id = target_machine.id;
    raise exception 'machine already owned';
  end if;

  update public.machines set
    organization_id = p_organization_id,
    status = 'paired',
    paired_at = coalesce(paired_at, now()),
    paired_by = p_user_id,
    revoked_at = null,
    installation_generation = installation_generation + 1,
    updated_at = now()
  where id = target_machine.id
  returning * into target_machine;

  booth_code := lower(coalesce(
    nullif(target_claim.snapshot->>'boothCode', ''),
    'pl-' || substr(replace(target_machine.machine_id, 'machine_', ''), 1, 8)
  ));
  booth_code := regexp_replace(booth_code, '[^a-z0-9-]', '', 'g');
  if char_length(booth_code) < 3 then booth_code := 'pl-' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8); end if;

  select * into target_booth from public.booths where machine_id = target_machine.machine_id for update;
  if target_booth.id is null then
    if exists(select 1 from public.booths where code = booth_code) then
      booth_code := 'pl-' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8);
    end if;
    insert into public.booths(organization_id, code, machine_id, name, location)
    values (
      p_organization_id,
      booth_code,
      target_machine.machine_id,
      left(coalesce(nullif(trim(p_booth_name), ''), target_machine.name), 120),
      left(coalesce(p_location, ''), 120)
    )
    returning * into target_booth;
  else
    update public.booths set
      organization_id = p_organization_id,
      name = left(coalesce(nullif(trim(p_booth_name), ''), name), 120),
      location = left(coalesce(p_location, location), 120),
      updated_at = now()
    where id = target_booth.id
    returning * into target_booth;
  end if;

  insert into public.booth_memberships(booth_id, user_id, role)
  values (target_booth.id, p_user_id, 'owner')
  on conflict (booth_id, user_id) do update set role = 'owner';

  update private.machine_claims set
    status = 'claimed',
    requester_id = coalesce(requester_id, p_user_id),
    claimed_by = p_user_id,
    claimed_organization_id = p_organization_id,
    claimed_at = now(),
    idempotency_key = p_idempotency_key,
    updated_at = now()
  where id = target_claim.id;

  update private.machine_installations set
    credential_generation = credential_generation + 1,
    credential_rotated_at = now(),
    updated_at = now()
  where machine_id = target_machine.machine_id;

  -- Keep the existing Agent registry authoritative for heartbeat authentication
  -- while ownership moves to the normalized account tables. This makes a
  -- successful claim survive reconnects without another setup code.
  update private.agent_machines set
    paired = true,
    booth_code = target_booth.code,
    pairing_code = null,
    pairing_expires_at = null,
    snapshot = coalesce(snapshot, '{}'::jsonb)
      || jsonb_build_object(
        'paired', true,
        'status', 'offline',
        'boothCode', target_booth.code,
        'machineCode', target_machine.machine_code,
        'pairedAt', coalesce(target_machine.paired_at, now())
      ),
    updated_at = now()
  where machine_id = target_machine.machine_id;

  insert into private.booth_directory_links(booth_id, machine_id)
  values (target_booth.id, target_machine.machine_id)
  on conflict (booth_id) do update set machine_id = excluded.machine_id;

  insert into public.machine_ownership_history(
    machine_id, from_organization_id, to_organization_id, action,
    actor_id, reason, idempotency_key, correlation_id
  ) values (
    target_machine.machine_id, null, p_organization_id, 'paired',
    p_user_id, 'owner claim', p_idempotency_key, p_correlation_id
  ) on conflict (idempotency_key) do nothing;

  insert into public.audit_logs(
    booth_id, actor_id, actor_role, action, target_type, target_id, correlation_id, detail
  ) values (
    target_booth.id, p_user_id, 'owner', 'machine.paired', 'machine',
    target_machine.machine_id, p_correlation_id,
    jsonb_build_object('machineCode', target_machine.machine_code, 'organizationId', p_organization_id)
  );

  return jsonb_build_object(
    'machine', jsonb_build_object(
      'machineId', target_machine.machine_id,
      'machineCode', target_machine.machine_code,
      'name', target_machine.name,
      'status', target_machine.status,
      'platform', target_machine.platform,
      'agentVersion', target_machine.agent_version
    ),
    'booth', jsonb_build_object(
      'id', target_booth.id,
      'boothCode', target_booth.code,
      'name', target_booth.name,
      'location', target_booth.location,
      'accessEnabled', target_booth.access_enabled
    ),
    'replayed', false
  );
end;
$$;

create or replace function public.photoslive_revoke_machine_pairing(
  p_machine_id text,
  p_actor_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.machines;
  target_booth_id uuid;
begin
  if exists(
    select 1 from public.machine_ownership_history
    where idempotency_key = p_idempotency_key
  ) then
    return jsonb_build_object('machineId', p_machine_id, 'status', 'revoked', 'replayed', true);
  end if;
  select * into target from public.machines where machine_id = p_machine_id for update;
  if target.id is null then raise exception 'machine not found'; end if;
  select id into target_booth_id from public.booths where machine_id = p_machine_id limit 1;
  update public.machines set status = 'revoked', revoked_at = now(), installation_generation = installation_generation + 1, updated_at = now()
  where id = target.id returning * into target;
  update public.booths set access_enabled = false, updated_at = now() where machine_id = p_machine_id;
  update private.agent_machines set
    paired = false,
    snapshot = coalesce(snapshot, '{}'::jsonb)
      || jsonb_build_object('paired', false, 'status', 'revoked'),
    updated_at = now()
  where machine_id = p_machine_id;
  insert into public.machine_ownership_history(
    machine_id, from_organization_id, to_organization_id, action, actor_id, reason, idempotency_key, correlation_id
  ) values (p_machine_id, target.organization_id, null, 'revoked', p_actor_id, left(coalesce(p_reason, ''), 240), p_idempotency_key, p_correlation_id)
  on conflict (idempotency_key) do nothing;
  insert into public.audit_logs(
    booth_id, actor_id, actor_role, action, target_type, target_id, correlation_id, detail
  ) values (
    target_booth_id, p_actor_id, 'superadmin', 'machine.pairing_revoked', 'machine',
    p_machine_id, p_correlation_id, jsonb_build_object('reason', left(coalesce(p_reason, ''), 240))
  );
  return jsonb_build_object('machineId', p_machine_id, 'status', target.status, 'replayed', false);
end;
$$;

create or replace function public.photoslive_reassign_machine(
  p_machine_id text,
  p_target_organization_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.machines;
  previous_organization uuid;
  target_booth_id uuid;
begin
  if exists(
    select 1 from public.machine_ownership_history
    where idempotency_key = p_idempotency_key
  ) then
    return jsonb_build_object(
      'machineId', p_machine_id,
      'organizationId', p_target_organization_id,
      'status', 'paired',
      'replayed', true
    );
  end if;
  select * into target from public.machines where machine_id = p_machine_id for update;
  if target.id is null then raise exception 'machine not found'; end if;
  if not exists(select 1 from public.organizations where id = p_target_organization_id) then raise exception 'organization not found'; end if;
  previous_organization := target.organization_id;
  select id into target_booth_id from public.booths where machine_id = p_machine_id limit 1;
  update public.machines set organization_id = p_target_organization_id, status = 'paired', installation_generation = installation_generation + 1, updated_at = now()
  where id = target.id returning * into target;
  update public.booths set organization_id = p_target_organization_id, updated_at = now() where machine_id = p_machine_id;
  update private.agent_machines set
    paired = true,
    snapshot = coalesce(snapshot, '{}'::jsonb)
      || jsonb_build_object('paired', true, 'status', 'offline'),
    updated_at = now()
  where machine_id = p_machine_id;
  insert into public.machine_ownership_history(
    machine_id, from_organization_id, to_organization_id, action, actor_id, reason, idempotency_key, correlation_id
  ) values (p_machine_id, previous_organization, p_target_organization_id, 'reassigned', p_actor_id, left(coalesce(p_reason, ''), 240), p_idempotency_key, p_correlation_id)
  on conflict (idempotency_key) do nothing;
  insert into public.audit_logs(
    booth_id, actor_id, actor_role, action, target_type, target_id, correlation_id, detail
  ) values (
    target_booth_id, p_actor_id, 'superadmin', 'machine.reassigned', 'machine',
    p_machine_id, p_correlation_id,
    jsonb_build_object(
      'fromOrganizationId', previous_organization,
      'toOrganizationId', p_target_organization_id,
      'reason', left(coalesce(p_reason, ''), 240)
    )
  );
  return jsonb_build_object(
    'machineId', p_machine_id,
    'status', target.status,
    'organizationId', target.organization_id,
    'replayed', false
  );
end;
$$;

create or replace function public.photoslive_machine_fleet()
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'machineId', machine.machine_id,
    'machineCode', machine.machine_code,
    'name', machine.name,
    'status', machine.status,
    'platform', machine.platform,
    'agentVersion', machine.agent_version,
    'controllerVersion', machine.controller_version,
    'lastSeenAt', machine.last_seen_at,
    'pairedAt', machine.paired_at,
    'pairedBy', machine.paired_by,
    'organizationId', machine.organization_id,
    'organizationName', organization.name,
    'owner', (
      select jsonb_build_object('userId', profile.id, 'adminCode', profile.admin_code, 'email', profile.email)
      from public.organization_members member
      join public.profiles profile on profile.id = member.user_id
      where member.organization_id = machine.organization_id and member.role = 'owner'
      order by member.created_at limit 1
    ),
    'booth', (
      select jsonb_build_object('boothCode', booth.code, 'name', booth.name, 'location', booth.location, 'accessEnabled', booth.access_enabled)
      from public.booths booth where booth.machine_id = machine.machine_id limit 1
    )
  )
  from public.machines machine
  left join public.organizations organization on organization.id = machine.organization_id
  order by machine.updated_at desc;
$$;

create or replace function public.photoslive_pairing_history(p_limit integer default 100)
returns setof jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', history.id,
    'machineId', history.machine_id,
    'fromOrganizationId', history.from_organization_id,
    'toOrganizationId', history.to_organization_id,
    'action', history.action,
    'actorId', history.actor_id,
    'reason', history.reason,
    'correlationId', history.correlation_id,
    'createdAt', history.created_at
  )
  from public.machine_ownership_history history
  order by history.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

alter table public.organization_members enable row level security;
alter table public.machines enable row level security;
alter table public.machine_ownership_history enable row level security;

drop policy if exists organization_members_select_self on public.organization_members;
create policy organization_members_select_self on public.organization_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.has_platform_role(array['platform_owner', 'support', 'auditor']));

drop policy if exists machines_select_member on public.machines;
create policy machines_select_member on public.machines
  for select to authenticated
  using (
    exists (
      select 1 from public.organization_members membership
      where membership.organization_id = machines.organization_id
        and membership.user_id = (select auth.uid())
    )
    or private.has_platform_role(array['platform_owner', 'fleet_admin', 'support', 'auditor'])
  );

drop policy if exists machine_history_select_member on public.machine_ownership_history;
create policy machine_history_select_member on public.machine_ownership_history
  for select to authenticated
  using (
    exists (
      select 1 from public.organization_members membership
      where membership.user_id = (select auth.uid())
        and membership.organization_id in (machine_ownership_history.from_organization_id, machine_ownership_history.to_organization_id)
    )
    or private.has_platform_role(array['platform_owner', 'fleet_admin', 'support', 'auditor'])
  );

grant select on public.organization_members, public.machines, public.machine_ownership_history to authenticated;
grant execute on function public.photoslive_bootstrap_account(uuid, text, text, text) to service_role;
grant execute on function public.photoslive_account_snapshot(uuid) to service_role;
grant execute on function public.photoslive_create_machine_claim(text, text, text, timestamptz, jsonb, text) to service_role;
grant execute on function public.photoslive_machine_claim_snapshot(text, text) to service_role;
grant execute on function public.photoslive_claim_machine(uuid, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.photoslive_revoke_machine_pairing(text, uuid, text, text, text) to service_role;
grant execute on function public.photoslive_reassign_machine(text, uuid, uuid, text, text, text) to service_role;
grant execute on function public.photoslive_machine_fleet() to service_role;
grant execute on function public.photoslive_pairing_history(integer) to service_role;

revoke all on function public.photoslive_bootstrap_account(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.photoslive_account_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.photoslive_create_machine_claim(text, text, text, timestamptz, jsonb, text) from public, anon, authenticated;
revoke all on function public.photoslive_machine_claim_snapshot(text, text) from public, anon, authenticated;
revoke all on function public.photoslive_claim_machine(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.photoslive_revoke_machine_pairing(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.photoslive_reassign_machine(text, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.photoslive_machine_fleet() from public, anon, authenticated;
revoke all on function public.photoslive_pairing_history(integer) from public, anon, authenticated;
