create or replace function public.photoslive_persist_booth_config(p_booth_code text, p_config jsonb)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_booth_id uuid; v_version bigint; v_name text; v_location text;
begin
  if jsonb_typeof(p_config) <> 'object' or octet_length(p_config::text) > 500000 then
    raise exception 'invalid booth config';
  end if;
  select id into v_booth_id from public.booths where code = p_booth_code for update;
  if v_booth_id is null then raise exception 'booth not found'; end if;
  v_name := left(coalesce(p_config #>> '{booth,name}', ''), 120);
  v_location := left(coalesce(p_config #>> '{booth,location}', ''), 120);
  if v_name = '' then raise exception 'booth name is required'; end if;

  update public.booths set config_version = config_version + 1, name = v_name,
    location = v_location, updated_at = now()
  where id = v_booth_id returning config_version into v_version;
  insert into public.booth_configs (booth_id, version, config, updated_at)
  values (v_booth_id, v_version, p_config, now())
  on conflict (booth_id) do update set version = excluded.version,
    config = excluded.config, updated_at = excluded.updated_at;
  return jsonb_build_object('version', v_version);
end;
$$;

create or replace function public.photoslive_booth_config_snapshot(p_booth_code text)
returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object('version', config.version, 'config', config.config)
  from public.booths booth join public.booth_configs config on config.booth_id = booth.id
  where booth.code = p_booth_code;
$$;

revoke all on function public.photoslive_persist_booth_config(text, jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_booth_config_snapshot(text) from public, anon, authenticated;
grant execute on function public.photoslive_persist_booth_config(text, jsonb) to service_role;
grant execute on function public.photoslive_booth_config_snapshot(text) to service_role;
