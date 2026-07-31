create or replace function public.photoslive_request_photo_session_deletion(p_booth_code text, p_share_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_session public.photo_sessions%rowtype;
  target_booth public.booths%rowtype;
begin
  if p_share_code !~ '^[A-Za-z0-9_-]{32,100}$' then raise exception 'invalid share code'; end if;
  select * into target_booth from public.booths where code = lower(p_booth_code);
  if target_booth.id is null then raise exception 'booth not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_booth.id::text || ':' || p_share_code, 0));

  update public.photo_sessions session
  set metadata = coalesce(session.metadata, '{}'::jsonb) || jsonb_build_object(
        'deletionRequested', true,
        'deletionRequestedAt', coalesce(session.metadata -> 'deletionRequestedAt', to_jsonb(now()))
      ),
      updated_at = now()
  where session.booth_id = target_booth.id and session.share_code = p_share_code
  returning * into target_session;

  if target_session.id is null then return null; end if;
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

revoke all on function public.photoslive_request_photo_session_deletion(text, text) from public, anon, authenticated;
grant execute on function public.photoslive_request_photo_session_deletion(text, text) to service_role;
