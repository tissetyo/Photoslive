-- Keep the public web pairing screen useful after a claim has completed.
-- The raw one-time token remains private; this RPC is service-role-only.
create or replace function public.photoslive_machine_claim_snapshot(
  p_token_hash text default null,
  p_code_hash text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claim private.machine_claims;
  m public.machines;
  b public.booths;
begin
  select *
    into claim
    from private.machine_claims c
   where (p_token_hash is not null and c.token_hash = p_token_hash)
      or (p_code_hash is not null and c.fallback_code_hash = p_code_hash)
   order by c.created_at desc
   limit 1;

  if claim.id is null then
    return null;
  end if;

  if claim.status = 'pending' and claim.expires_at <= now() then
    update private.machine_claims
       set status = 'expired', updated_at = now()
     where id = claim.id
     returning * into claim;
  end if;

  select * into m from public.machines where machine_id = claim.machine_id;
  select * into b from public.booths where machine_id = claim.machine_id limit 1;

  return jsonb_build_object(
    'claimId', claim.id,
    'machineId', m.machine_id,
    'machineCode', m.machine_code,
    'name', m.name,
    'platform', m.platform,
    'agentVersion', m.agent_version,
    'controllerVersion', m.controller_version,
    'devices', coalesce(claim.snapshot->'devices', '[]'::jsonb),
    'installationMode', coalesce(claim.snapshot->>'installationMode', 'agent'),
    'status', claim.status,
    'expiresAt', claim.expires_at,
    'boothCode', b.code,
    'boothName', b.name,
    'location', b.location
  );
end;
$$;

grant execute on function public.photoslive_machine_claim_snapshot(text, text) to service_role;
revoke all on function public.photoslive_machine_claim_snapshot(text, text) from public, anon, authenticated;
