alter table public.assets add column if not exists legacy_id text;
alter table public.assets add column if not exists deletion_requested_at timestamptz;
create unique index if not exists assets_booth_legacy_id_idx on public.assets(booth_id, legacy_id) where legacy_id is not null;

create or replace function public.photoslive_persist_booth_asset(
  p_booth_code text,
  p_legacy_id text,
  p_kind text,
  p_object_key text,
  p_content_type text,
  p_byte_size bigint,
  p_checksum_sha256 text,
  p_metadata jsonb,
  p_created_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_booth public.booths%rowtype;
  target_asset public.assets%rowtype;
begin
  if p_legacy_id !~ '^[A-Za-z0-9_-]{3,160}$' then raise exception 'invalid asset id'; end if;
  if p_kind not in ('background', 'frame', 'logo', 'sticker') then raise exception 'invalid asset kind'; end if;
  if p_object_key not like ('assets/' || lower(p_booth_code) || '/' || p_kind || '/%') or position('..' in p_object_key) > 0 then raise exception 'invalid object key'; end if;
  if p_content_type !~ '^image/(jpeg|png|webp|gif)$' then raise exception 'invalid content type'; end if;
  if p_byte_size < 1 or p_byte_size > 25000000 then raise exception 'invalid asset size'; end if;
  if p_checksum_sha256 !~ '^[a-f0-9]{64}$' then raise exception 'invalid checksum'; end if;
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' or pg_column_size(p_metadata) > 16384 then raise exception 'invalid metadata'; end if;

  select * into target_booth from public.booths where code = lower(p_booth_code) for update;
  if target_booth.id is null then raise exception 'booth not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_booth.id::text || ':asset:' || p_legacy_id, 0));

  insert into public.assets (booth_id, legacy_id, kind, object_key, content_type, byte_size, checksum_sha256, metadata, created_at)
  values (target_booth.id, p_legacy_id, p_kind, p_object_key, p_content_type, p_byte_size, p_checksum_sha256, p_metadata, coalesce(p_created_at, now()))
  on conflict (booth_id, legacy_id) where legacy_id is not null do update set
    kind = excluded.kind,
    object_key = excluded.object_key,
    content_type = excluded.content_type,
    byte_size = excluded.byte_size,
    checksum_sha256 = excluded.checksum_sha256,
    metadata = excluded.metadata,
    deletion_requested_at = public.assets.deletion_requested_at
  returning * into target_asset;

  return coalesce(target_asset.metadata, '{}'::jsonb) || jsonb_build_object(
    'id', target_asset.legacy_id, 'boothCode', target_booth.code, 'kind', target_asset.kind,
    'objectKey', target_asset.object_key, 'contentType', target_asset.content_type,
    'size', target_asset.byte_size, 'checksumSha256', target_asset.checksum_sha256,
    'createdAt', target_asset.created_at, 'deletionRequested', target_asset.deletion_requested_at is not null,
    'deletionRequestedAt', target_asset.deletion_requested_at
  );
end;
$$;

create or replace function public.photoslive_booth_assets_snapshot(p_booth_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(coalesce(asset.metadata, '{}'::jsonb) || jsonb_build_object(
    'id', asset.legacy_id, 'boothCode', booth.code, 'kind', asset.kind,
    'objectKey', asset.object_key, 'contentType', asset.content_type,
    'size', asset.byte_size, 'checksumSha256', asset.checksum_sha256,
    'createdAt', asset.created_at, 'deletionRequested', asset.deletion_requested_at is not null,
    'deletionRequestedAt', asset.deletion_requested_at
  ) order by asset.created_at desc), '[]'::jsonb)
  from public.booths booth
  left join public.assets asset on asset.booth_id = booth.id and asset.legacy_id is not null
  where booth.code = lower(p_booth_code);
$$;

create or replace function public.photoslive_request_booth_asset_deletion(p_booth_code text, p_legacy_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_booth public.booths%rowtype;
  target_asset public.assets%rowtype;
begin
  select * into target_booth from public.booths where code = lower(p_booth_code);
  if target_booth.id is null then raise exception 'booth not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_booth.id::text || ':asset:' || p_legacy_id, 0));
  update public.assets set deletion_requested_at = coalesce(deletion_requested_at, now())
  where booth_id = target_booth.id and legacy_id = p_legacy_id returning * into target_asset;
  if target_asset.id is null then return null; end if;
  return coalesce(target_asset.metadata, '{}'::jsonb) || jsonb_build_object(
    'id', target_asset.legacy_id, 'boothCode', target_booth.code, 'kind', target_asset.kind,
    'objectKey', target_asset.object_key, 'contentType', target_asset.content_type,
    'size', target_asset.byte_size, 'checksumSha256', target_asset.checksum_sha256,
    'createdAt', target_asset.created_at, 'deletionRequested', true,
    'deletionRequestedAt', target_asset.deletion_requested_at
  );
end;
$$;

create or replace function public.photoslive_delete_booth_asset(p_booth_code text, p_legacy_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  delete from public.assets asset using public.booths booth
  where booth.id = asset.booth_id and booth.code = lower(p_booth_code)
    and asset.legacy_id = p_legacy_id and asset.deletion_requested_at is not null;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

revoke all on function public.photoslive_persist_booth_asset(text, text, text, text, text, bigint, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.photoslive_booth_assets_snapshot(text) from public, anon, authenticated;
revoke all on function public.photoslive_request_booth_asset_deletion(text, text) from public, anon, authenticated;
revoke all on function public.photoslive_delete_booth_asset(text, text) from public, anon, authenticated;
grant execute on function public.photoslive_persist_booth_asset(text, text, text, text, text, bigint, text, jsonb, timestamptz) to service_role;
grant execute on function public.photoslive_booth_assets_snapshot(text) to service_role;
grant execute on function public.photoslive_request_booth_asset_deletion(text, text) to service_role;
grant execute on function public.photoslive_delete_booth_asset(text, text) to service_role;
