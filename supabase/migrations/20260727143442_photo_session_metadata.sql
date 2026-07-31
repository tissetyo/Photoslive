create or replace function public.photoslive_persist_photo_session(
  p_booth_code text,
  p_share_code text,
  p_status text,
  p_metadata jsonb,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_booth public.booths%rowtype;
  target_session public.photo_sessions%rowtype;
begin
  if p_share_code !~ '^[A-Za-z0-9_-]{32,100}$' then
    raise exception 'invalid share code';
  end if;
  if p_status not in ('active', 'completed', 'cancelled', 'expired', 'sync_pending') then
    raise exception 'invalid session status';
  end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or pg_column_size(p_metadata) > 262144 then
    raise exception 'invalid session metadata';
  end if;
  if p_started_at is null or p_expires_at is null or p_expires_at <= p_started_at then
    raise exception 'invalid session lifetime';
  end if;

  select * into target_booth from public.booths where code = lower(p_booth_code) for update;
  if target_booth.id is null then raise exception 'booth not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_booth.id::text || ':' || p_share_code, 0));

  insert into public.photo_sessions (id, booth_id, share_code, status, metadata, started_at, completed_at, expires_at)
  values (gen_random_uuid(), target_booth.id, p_share_code, p_status, p_metadata, p_started_at,
    case when p_status = 'completed' then coalesce(p_completed_at, now()) else p_completed_at end,
    p_expires_at)
  on conflict (booth_id, share_code) do update set
    status = case
      when public.photo_sessions.status = 'expired' then 'expired'
      when public.photo_sessions.status = 'completed' and excluded.status in ('active', 'sync_pending') then 'completed'
      else excluded.status
    end,
    metadata = case
      when public.photo_sessions.metadata ->> 'deletionRequested' = 'true' then excluded.metadata || jsonb_build_object(
        'deletionRequested', true,
        'deletionRequestedAt', public.photo_sessions.metadata -> 'deletionRequestedAt'
      )
      else excluded.metadata
    end,
    completed_at = coalesce(excluded.completed_at, public.photo_sessions.completed_at),
    expires_at = excluded.expires_at,
    updated_at = now()
  returning * into target_session;

  return coalesce(target_session.metadata, '{}'::jsonb) || jsonb_build_object(
    'boothCode', target_booth.code,
    'shareCode', target_session.share_code,
    'status', target_session.status,
    'createdAt', target_session.started_at,
    'completedAt', target_session.completed_at,
    'expiresAt', target_session.expires_at,
    'updatedAt', target_session.updated_at
  );
end;
$$;

create or replace function public.photoslive_photo_session_snapshot(p_booth_code text, p_share_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(session.metadata, '{}'::jsonb) || jsonb_build_object(
    'boothCode', booth.code,
    'shareCode', session.share_code,
    'status', session.status,
    'createdAt', session.started_at,
    'completedAt', session.completed_at,
    'expiresAt', session.expires_at,
    'updatedAt', session.updated_at
  )
  from public.photo_sessions session
  join public.booths booth on booth.id = session.booth_id
  where booth.code = lower(p_booth_code) and session.share_code = p_share_code
  limit 1;
$$;

create or replace function public.photoslive_expire_photo_session(p_booth_code text, p_share_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected integer;
begin
  update public.photo_sessions session
  set status = 'expired', metadata = coalesce(session.metadata, '{}'::jsonb) || '{"deleted":true}'::jsonb, updated_at = now()
  from public.booths booth
  where booth.id = session.booth_id and booth.code = lower(p_booth_code) and session.share_code = p_share_code;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.photoslive_persist_photo_session(text, text, text, jsonb, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.photoslive_photo_session_snapshot(text, text) from public, anon, authenticated;
revoke all on function public.photoslive_expire_photo_session(text, text) from public, anon, authenticated;
grant execute on function public.photoslive_persist_photo_session(text, text, text, jsonb, timestamptz, timestamptz, timestamptz) to service_role;
grant execute on function public.photoslive_photo_session_snapshot(text, text) to service_role;
grant execute on function public.photoslive_expire_photo_session(text, text) to service_role;
