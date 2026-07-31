-- Admin status reads are durable and must not depend on the optional Redis
-- cache. This RPC exposes only the operational snapshot; Agent credentials
-- remain private and are never returned to the web application.
create or replace function public.photoslive_agent_machine_status(
  p_machine_id text
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
  where machine_id = trim(coalesce(p_machine_id, ''));

  if v_record.machine_id is null then
    return null;
  end if;

  return coalesce(v_record.snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'id', v_record.machine_id,
      'boothCode', v_record.booth_code,
      'paired', v_record.paired,
      'pairingCode', v_record.pairing_code,
      'pairingExpiresAt', v_record.pairing_expires_at,
      'lastSeenAt', v_record.last_seen_at,
      'createdAt', v_record.created_at,
      'updatedAt', v_record.updated_at
    );
end;
$$;

revoke all on function public.photoslive_agent_machine_status(text) from public, anon, authenticated;
grant execute on function public.photoslive_agent_machine_status(text) to service_role;
