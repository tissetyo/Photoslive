alter table public.booths
  add column if not exists voucher_version bigint not null default 0
  check (voucher_version >= 0);

alter table public.voucher_events
  add column if not exists legacy_id text;

create unique index if not exists voucher_events_booth_legacy_id_idx
  on public.voucher_events(booth_id, legacy_id)
  where legacy_id is not null;

create or replace function public.photoslive_persist_voucher_batch(
  p_booth_code text,
  p_vouchers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booth_id uuid;
  v_version bigint;
  v_requested integer;
  v_inserted integer;
begin
  if p_booth_code is null or p_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid booth code';
  end if;
  if jsonb_typeof(p_vouchers) <> 'array' then
    raise exception 'voucher batch must be an array';
  end if;
  v_requested := jsonb_array_length(p_vouchers);
  if v_requested < 1 or v_requested > 100 then
    raise exception 'voucher batch must contain 1 to 100 rows';
  end if;

  select id into v_booth_id
  from public.booths
  where code = p_booth_code
  for update;
  if v_booth_id is null then raise exception 'booth not found'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_vouchers) as item(code text, "eventId" text, "includesPrint" boolean, "createdAt" timestamptz)
    where item.code is null or item.code !~ '^[A-Z0-9-]{4,40}$'
  ) then raise exception 'invalid voucher code'; end if;

  insert into public.vouchers (booth_id, event_id, code, includes_print, created_at)
  select
    v_booth_id,
    case when item."eventId" is null then null else (
      select event.id from public.voucher_events event
      where event.booth_id = v_booth_id and event.legacy_id = item."eventId"
    ) end,
    item.code,
    coalesce(item."includesPrint", false),
    coalesce(item."createdAt", now())
  from jsonb_to_recordset(p_vouchers) as item(code text, "eventId" text, "includesPrint" boolean, "createdAt" timestamptz)
  on conflict (booth_id, code) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted <> v_requested then raise exception 'voucher code already exists'; end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_vouchers) as item(code text, "eventId" text)
    where item."eventId" is not null and not exists (
      select 1 from public.voucher_events event
      where event.booth_id = v_booth_id and event.legacy_id = item."eventId"
    )
  ) then raise exception 'voucher event not found'; end if;

  update public.booths
  set voucher_version = voucher_version + 1, updated_at = now()
  where id = v_booth_id
  returning voucher_version into v_version;

  return jsonb_build_object('version', v_version, 'inserted', v_inserted, 'requested', v_requested);
end;
$$;

revoke all on function public.photoslive_persist_voucher_batch(text, jsonb) from public, anon, authenticated;
grant execute on function public.photoslive_persist_voucher_batch(text, jsonb) to service_role;

comment on function public.photoslive_persist_voucher_batch(text, jsonb) is
  'Service-role-only transactional voucher batch insert. Locks one booth and advances voucher_version exactly once.';

create or replace function public.photoslive_persist_voucher_event(
  p_booth_code text,
  p_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_booth_id uuid;
  v_event_id uuid;
  v_version bigint;
begin
  select id into v_booth_id from public.booths where code = p_booth_code for update;
  if v_booth_id is null then raise exception 'booth not found'; end if;
  if coalesce(p_event->>'id', '') = '' or char_length(coalesce(p_event->>'name', '')) not between 1 and 120 then
    raise exception 'invalid voucher event';
  end if;
  if (p_event->>'expiresAt')::timestamptz <= now() then raise exception 'voucher event already expired'; end if;

  insert into public.voucher_events (booth_id, legacy_id, name, expires_at, includes_print, created_at)
  values (
    v_booth_id, p_event->>'id', p_event->>'name', (p_event->>'expiresAt')::timestamptz,
    coalesce((p_event->>'includesPrint')::boolean, false),
    coalesce((p_event->>'createdAt')::timestamptz, now())
  )
  on conflict (booth_id, legacy_id) where legacy_id is not null do update
    set name = excluded.name, expires_at = excluded.expires_at, includes_print = excluded.includes_print
  returning id into v_event_id;

  update public.booths set voucher_version = voucher_version + 1, updated_at = now()
  where id = v_booth_id returning voucher_version into v_version;
  return jsonb_build_object('version', v_version, 'eventId', v_event_id, 'legacyId', p_event->>'id');
end;
$$;

create or replace function public.photoslive_delete_voucher(p_booth_code text, p_code text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_booth_id uuid; v_deleted integer; v_version bigint;
begin
  select id into v_booth_id from public.booths where code = p_booth_code for update;
  if v_booth_id is null then raise exception 'booth not found'; end if;
  delete from public.vouchers where booth_id = v_booth_id and code = p_code and redeemed_at is null;
  get diagnostics v_deleted = row_count;
  if v_deleted <> 1 then raise exception 'voucher not found or already redeemed'; end if;
  update public.booths set voucher_version = voucher_version + 1, updated_at = now()
  where id = v_booth_id returning voucher_version into v_version;
  return jsonb_build_object('version', v_version, 'deleted', true);
end;
$$;

create or replace function public.photoslive_redeem_voucher(p_booth_code text, p_code text, p_redeemed_at timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_booth_id uuid; v_record public.vouchers%rowtype; v_version bigint;
begin
  select id into v_booth_id from public.booths where code = p_booth_code for update;
  if v_booth_id is null then raise exception 'booth not found'; end if;
  update public.vouchers set redeemed_at = coalesce(p_redeemed_at, now())
  where booth_id = v_booth_id and code = p_code and redeemed_at is null
  returning * into v_record;
  if v_record.id is null then raise exception 'voucher not found or already redeemed'; end if;
  update public.booths set voucher_version = voucher_version + 1, updated_at = now()
  where id = v_booth_id returning voucher_version into v_version;
  return jsonb_build_object('version', v_version, 'code', v_record.code, 'redeemedAt', v_record.redeemed_at);
end;
$$;

create or replace function public.photoslive_voucher_snapshot(p_booth_code text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'version', booth.voucher_version,
    'vouchers', coalesce((select jsonb_agg(jsonb_build_object(
      'code', voucher.code, 'boothCode', booth.code, 'eventId', event.legacy_id,
      'includesPrint', voucher.includes_print, 'createdAt', voucher.created_at,
      'redeemedAt', voucher.redeemed_at
    ) order by voucher.created_at desc) from public.vouchers voucher
      left join public.voucher_events event on event.id = voucher.event_id
      where voucher.booth_id = booth.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'id', event.legacy_id, 'boothCode', booth.code, 'name', event.name,
      'expiresAt', event.expires_at, 'includesPrint', event.includes_print,
      'createdAt', event.created_at
    ) order by event.created_at desc) from public.voucher_events event
      where event.booth_id = booth.id), '[]'::jsonb)
  )
  from public.booths booth where booth.code = p_booth_code;
$$;

revoke all on function public.photoslive_persist_voucher_event(text, jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_delete_voucher(text, text) from public, anon, authenticated;
revoke all on function public.photoslive_redeem_voucher(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.photoslive_voucher_snapshot(text) from public, anon, authenticated;
grant execute on function public.photoslive_persist_voucher_event(text, jsonb) to service_role;
grant execute on function public.photoslive_delete_voucher(text, text) to service_role;
grant execute on function public.photoslive_redeem_voucher(text, text, timestamptz) to service_role;
grant execute on function public.photoslive_voucher_snapshot(text) to service_role;
