create or replace function public.photoslive_reconcile_photo_sessions(
  p_booth_code text,
  p_machine_id text,
  p_sessions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  updated_count integer := 0;
  item_status text;
  item_started_at timestamptz;
  item_completed_at timestamptz;
  item_expires_at timestamptz;
  item_metadata jsonb;
begin
  if p_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid booth code';
  end if;
  if p_machine_id is null or length(p_machine_id) < 8 or length(p_machine_id) > 160 then
    raise exception 'invalid machine id';
  end if;
  if p_sessions is null or jsonb_typeof(p_sessions) <> 'array' or jsonb_array_length(p_sessions) > 500 then
    raise exception 'invalid reconciliation batch';
  end if;

  for item in select value from jsonb_array_elements(p_sessions)
  loop
    item_status := coalesce(nullif(item ->> 'status', ''), 'active');
    item_started_at := (item ->> 'createdAt')::timestamptz;
    item_completed_at := nullif(item ->> 'completedAt', '')::timestamptz;
    item_expires_at := (item ->> 'expiresAt')::timestamptz;
    item_metadata := jsonb_strip_nulls(jsonb_build_object(
      'machineId', p_machine_id,
      'localSessionId', item ->> 'localSessionId',
      'frameId', item ->> 'frameId',
      'photoSlots', greatest(1, least(8, coalesce((item ->> 'photoSlots')::integer, 1))),
      'files', coalesce(item -> 'files', '[]'::jsonb)
    ));

    perform public.photoslive_persist_photo_session(
      p_booth_code,
      item ->> 'shareCode',
      item_status,
      item_metadata,
      item_started_at,
      item_completed_at,
      item_expires_at
    );
    updated_count := updated_count + 1;
  end loop;

  return jsonb_build_object(
    'updated', updated_count,
    'reconciledAt', now()
  );
end;
$$;

revoke all on function public.photoslive_reconcile_photo_sessions(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.photoslive_reconcile_photo_sessions(text, text, jsonb)
  to service_role;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'photo_sessions'
  ) then
    alter publication supabase_realtime add table public.photo_sessions;
  end if;
end;
$$;
