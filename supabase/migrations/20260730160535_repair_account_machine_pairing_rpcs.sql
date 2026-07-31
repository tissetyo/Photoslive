-- Repair migration for installations where the v2 ownership tables were
-- created but the RPC functions were not deployed.  Every RPC remains
-- service-role-only; browser clients go through the server API.
create extension if not exists pgcrypto;

create or replace function private.photoslive_next_code(p_prefix text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return upper(p_prefix || '-' || substr(encode(gen_random_bytes(8), 'hex'), 1, 8));
end;
$$;

create or replace function public.photoslive_account_snapshot(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with member as (
    select organization_id, role from public.organization_members
    where user_id = p_user_id order by created_at limit 1
  )
  select jsonb_build_object(
    'userId', p.id,
    'email', p.email,
    'displayName', coalesce(p.display_name, 'Pemilik'),
    'adminCode', p.admin_code,
    'organizationId', o.id,
    'organizationCode', o.public_code,
    'organizationName', o.name,
    'role', member.role,
    'machines', coalesce((select jsonb_agg(jsonb_build_object(
      'machineId', m.machine_id, 'machineCode', m.machine_code,
      'name', m.name, 'status', m.status, 'platform', m.platform,
      'agentVersion', m.agent_version, 'controllerVersion', m.controller_version,
      'lastSeenAt', m.last_seen_at, 'pairedAt', m.paired_at
    ) order by m.created_at) from public.machines m where m.organization_id = o.id), '[]'::jsonb),
    'booths', coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'boothCode', b.code, 'machineId', b.machine_id,
      'name', b.name, 'location', b.location, 'accessEnabled', b.access_enabled
    ) order by b.created_at) from public.booths b where b.organization_id = o.id), '[]'::jsonb)
  )
  from public.profiles p join member on true join public.organizations o on o.id = member.organization_id
  where p.id = p_user_id;
$$;

create or replace function public.photoslive_bootstrap_account(
  p_user_id uuid, p_email text, p_display_name text, p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare target_org uuid; target_admin_code text; target_org_code text;
begin
  if p_user_id is null or coalesce(trim(p_email), '') = '' then raise exception 'invalid account identity'; end if;
  select admin_code into target_admin_code from public.profiles where id = p_user_id for update;
  if target_admin_code is null then
    loop
      target_admin_code := private.photoslive_next_code('ADM');
      begin
        insert into public.profiles(id, email, display_name, admin_code)
        values (p_user_id, lower(trim(p_email)), left(coalesce(nullif(trim(p_display_name), ''), 'Pemilik'), 120), target_admin_code)
        on conflict (id) do update set email = excluded.email, admin_code = coalesce(public.profiles.admin_code, excluded.admin_code), updated_at = now();
        exit;
      exception when unique_violation then end;
    end loop;
  else
    update public.profiles set email = lower(trim(p_email)), updated_at = now() where id = p_user_id;
  end if;
  select organization_id into target_org from public.organization_members where user_id = p_user_id order by created_at limit 1;
  if target_org is null then
    loop
      target_org_code := private.photoslive_next_code('ORG');
      begin
        insert into public.organizations(name, public_code)
        values (left(split_part(lower(trim(p_email)), '@', 1) || ' Photoslive', 120), target_org_code)
        returning id into target_org;
        exit;
      exception when unique_violation then end;
    end loop;
    insert into public.organization_members(organization_id, user_id, role) values (target_org, p_user_id, 'owner');
  end if;
  insert into public.audit_logs(actor_id, actor_role, action, target_type, target_id, correlation_id, detail)
  values (p_user_id, 'owner', 'account.bootstrap', 'organization', target_org::text, coalesce(nullif(p_idempotency_key, ''), gen_random_uuid()::text), jsonb_build_object('email', lower(trim(p_email))))
  on conflict do nothing;
  return public.photoslive_account_snapshot(p_user_id);
end;
$$;

create or replace function public.photoslive_create_machine_claim(
  p_machine_id text, p_token_hash text, p_code_hash text, p_expires_at timestamptz, p_snapshot jsonb, p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare m public.machines; claim private.machine_claims; machine_code text;
begin
  if p_machine_id !~ '^[A-Za-z0-9._:-]{3,160}$' or p_token_hash !~ '^[a-f0-9]{64}$' or p_code_hash !~ '^[a-f0-9]{64}$' or p_expires_at <= now() then
    raise exception 'invalid machine claim';
  end if;
  select * into m from public.machines where machine_id = p_machine_id for update;
  if m.id is null then
    loop
      machine_code := private.photoslive_next_code('MCH');
      begin
        insert into public.machines(machine_id, machine_code, name, platform, agent_version, controller_version, metadata)
        values (p_machine_id, machine_code, left(coalesce(nullif(p_snapshot->>'name', ''), 'Photoslive Machine'),120), left(coalesce(p_snapshot->>'platform',''),120), left(coalesce(p_snapshot->>'agentVersion',''),40), left(coalesce(p_snapshot->>'controllerVersion',''),40), coalesce(p_snapshot,'{}'::jsonb))
        returning * into m;
        exit;
      exception when unique_violation then end;
    end loop;
  elsif m.status = 'paired' then
    return jsonb_build_object('machineId', m.machine_id, 'machineCode', m.machine_code, 'status', 'paired', 'paired', true);
  else
    update public.machines set name = left(coalesce(nullif(p_snapshot->>'name',''),name),120), metadata = metadata || coalesce(p_snapshot,'{}'::jsonb), updated_at = now() where id = m.id returning * into m;
  end if;
  update private.machine_claims set status = 'revoked', updated_at = now() where machine_id = p_machine_id and status = 'pending';
  insert into private.machine_claims(machine_id, token_hash, fallback_code_hash, expires_at, snapshot, idempotency_key)
  values (p_machine_id, p_token_hash, p_code_hash, p_expires_at, coalesce(p_snapshot,'{}'::jsonb), p_idempotency_key)
  on conflict (idempotency_key) do update set updated_at = now()
  returning * into claim;
  insert into private.machine_installations(machine_id) values (p_machine_id) on conflict do nothing;
  return jsonb_build_object('claimId', claim.id, 'machineId',m.machine_id,'machineCode',m.machine_code,'status',claim.status,'expiresAt',claim.expires_at);
end;
$$;

create or replace function public.photoslive_machine_claim_snapshot(p_token_hash text default null, p_code_hash text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare claim private.machine_claims; m public.machines;
begin
  select * into claim from private.machine_claims c where (p_token_hash is not null and c.token_hash = p_token_hash) or (p_code_hash is not null and c.fallback_code_hash = p_code_hash) order by c.created_at desc limit 1;
  if claim.id is null then return null; end if;
  if claim.status = 'pending' and claim.expires_at <= now() then update private.machine_claims set status = 'expired', updated_at = now() where id = claim.id returning * into claim; end if;
  select * into m from public.machines where machine_id = claim.machine_id;
  return jsonb_build_object('claimId',claim.id,'machineId',m.machine_id,'machineCode',m.machine_code,'name',m.name,'platform',m.platform,'agentVersion',m.agent_version,'controllerVersion',m.controller_version,'devices',coalesce(claim.snapshot->'devices','[]'::jsonb),'status',claim.status,'expiresAt',claim.expires_at);
end;
$$;

create or replace function public.photoslive_claim_machine(
  p_user_id uuid, p_organization_id uuid, p_token_hash text, p_code_hash text, p_booth_name text, p_location text, p_idempotency_key text, p_correlation_id text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare claim private.machine_claims; m public.machines; b public.booths; booth_code text;
begin
  if not exists(select 1 from public.organization_members om where om.organization_id = p_organization_id and om.user_id = p_user_id and om.role in ('owner','admin')) then raise exception 'organization access denied'; end if;
  select * into claim from private.machine_claims c where ((p_token_hash is not null and c.token_hash = p_token_hash) or (p_code_hash is not null and c.fallback_code_hash = p_code_hash)) for update;
  if claim.id is null then raise exception 'pairing not found'; end if;
  if claim.status = 'claimed' then
    if claim.claimed_organization_id = p_organization_id and claim.claimed_by = p_user_id then
      select * into m from public.machines where machine_id = claim.machine_id;
      select * into b from public.booths where machine_id = claim.machine_id;
      return jsonb_build_object('machine',to_jsonb(m),'booth',to_jsonb(b),'replayed',true);
    end if;
    raise exception 'pairing already used';
  end if;
  if claim.status <> 'pending' or claim.expires_at <= now() then update private.machine_claims set status='expired',updated_at=now() where id=claim.id; raise exception 'pairing expired'; end if;
  select * into m from public.machines where machine_id = claim.machine_id for update;
  if m.organization_id is not null and m.organization_id <> p_organization_id then raise exception 'machine already owned'; end if;
  update public.machines set organization_id=p_organization_id,status='paired',paired_at=coalesce(paired_at,now()),paired_by=p_user_id,revoked_at=null,installation_generation=installation_generation+1,updated_at=now() where id=m.id returning * into m;
  booth_code := lower(coalesce(nullif(claim.snapshot->>'boothCode',''), 'pl-' || substr(replace(m.machine_id,'machine_',''),1,8)));
  booth_code := regexp_replace(booth_code,'[^a-z0-9-]','','g');
  if char_length(booth_code) < 3 or exists(select 1 from public.booths where code=booth_code and machine_id is distinct from m.machine_id) then booth_code := 'pl-' || substr(encode(gen_random_bytes(8),'hex'),1,8); end if;
  select * into b from public.booths where machine_id=m.machine_id for update;
  if b.id is null then
    insert into public.booths(organization_id,code,machine_id,name,location) values (p_organization_id,booth_code,m.machine_id,left(coalesce(nullif(trim(p_booth_name),''),m.name),120),left(coalesce(p_location,''),120)) returning * into b;
  else
    update public.booths set organization_id=p_organization_id,name=left(coalesce(nullif(trim(p_booth_name),''),name),120),location=left(coalesce(p_location,location),120),updated_at=now() where id=b.id returning * into b;
  end if;
  insert into public.booth_memberships(booth_id,user_id,role) values(b.id,p_user_id,'owner') on conflict(booth_id,user_id) do update set role='owner';
  update private.machine_claims set status='claimed',claimed_by=p_user_id,claimed_organization_id=p_organization_id,claimed_at=now(),updated_at=now() where id=claim.id;
  update private.machine_installations set credential_generation=credential_generation+1,credential_rotated_at=now(),updated_at=now() where machine_id=m.machine_id;
  update private.agent_machines set paired=true,booth_code=b.code,pairing_code=null,pairing_expires_at=null,snapshot=coalesce(snapshot,'{}'::jsonb)||jsonb_build_object('paired',true,'boothCode',b.code,'machineCode',m.machine_code),updated_at=now() where machine_id=m.machine_id;
  insert into private.booth_directory_links(booth_id,machine_id) values(b.id,m.machine_id) on conflict(booth_id) do update set machine_id=excluded.machine_id;
  insert into public.machine_ownership_history(machine_id,from_organization_id,to_organization_id,action,actor_id,reason,idempotency_key,correlation_id) values(m.machine_id,null,p_organization_id,'paired',p_user_id,'owner claim',p_idempotency_key,p_correlation_id) on conflict(idempotency_key) do nothing;
  insert into public.audit_logs(booth_id,actor_id,actor_role,action,target_type,target_id,correlation_id,detail) values(b.id,p_user_id,'owner','machine.paired','machine',m.machine_id,p_correlation_id,jsonb_build_object('machineCode',m.machine_code,'organizationId',p_organization_id));
  return jsonb_build_object('machine',jsonb_build_object('machineId',m.machine_id,'machineCode',m.machine_code,'name',m.name,'status',m.status,'platform',m.platform,'agentVersion',m.agent_version),'booth',jsonb_build_object('id',b.id,'boothCode',b.code,'name',b.name,'location',b.location,'accessEnabled',b.access_enabled),'replayed',false);
end;
$$;

grant execute on function public.photoslive_bootstrap_account(uuid,text,text,text), public.photoslive_account_snapshot(uuid), public.photoslive_create_machine_claim(text,text,text,timestamptz,jsonb,text), public.photoslive_machine_claim_snapshot(text,text), public.photoslive_claim_machine(uuid,uuid,text,text,text,text,text,text) to service_role;
revoke all on function public.photoslive_bootstrap_account(uuid,text,text,text), public.photoslive_account_snapshot(uuid), public.photoslive_create_machine_claim(text,text,text,timestamptz,jsonb,text), public.photoslive_machine_claim_snapshot(text,text), public.photoslive_claim_machine(uuid,uuid,text,text,text,text,text,text) from public, anon, authenticated;
