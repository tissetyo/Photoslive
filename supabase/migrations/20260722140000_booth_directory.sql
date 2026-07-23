create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.organization_directory_links (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  legacy_id text not null unique check (legacy_id ~ '^[A-Za-z0-9._:-]{3,120}$'),
  created_at timestamptz not null default now()
);

create table if not exists private.booth_directory_links (
  booth_id uuid primary key references public.booths(id) on delete cascade,
  machine_id text not null unique check (machine_id ~ '^[A-Za-z0-9._:-]{3,160}$'),
  created_at timestamptz not null default now()
);

revoke all on table private.organization_directory_links from public, anon, authenticated;
revoke all on table private.booth_directory_links from public, anon, authenticated;

create or replace function public.photoslive_persist_booth_directory(
  p_booth_code text,
  p_machine_id text,
  p_organization_legacy_id text,
  p_organization_name text,
  p_name text,
  p_location text,
  p_access_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_booth_code text := lower(trim(coalesce(p_booth_code, '')));
  v_machine_id text := trim(coalesce(p_machine_id, ''));
  v_org_legacy_id text := trim(coalesce(p_organization_legacy_id, ''));
  v_org_name text := trim(coalesce(p_organization_name, ''));
  v_name text := trim(coalesce(p_name, ''));
  v_location text := left(trim(coalesce(p_location, '')), 120);
  v_organization_id uuid;
  v_booth_id uuid;
  v_linked_booth_id uuid;
  v_existing_machine_id text;
  v_updated_at timestamptz;
begin
  if v_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$'
    or v_machine_id !~ '^[A-Za-z0-9._:-]{3,160}$'
    or v_org_legacy_id !~ '^[A-Za-z0-9._:-]{3,120}$'
    or char_length(v_org_name) not between 1 and 120
    or char_length(v_name) not between 1 and 120 then
    raise exception 'invalid booth directory input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('photoslive:directory:' || v_booth_code, 0));
  perform pg_advisory_xact_lock(hashtextextended('photoslive:organization:' || v_org_legacy_id, 0));

  select organization_id into v_organization_id
  from private.organization_directory_links
  where legacy_id = v_org_legacy_id;

  if v_organization_id is null then
    insert into public.organizations (name) values (v_org_name) returning id into v_organization_id;
    insert into private.organization_directory_links (organization_id, legacy_id)
    values (v_organization_id, v_org_legacy_id);
  else
    update public.organizations set name = v_org_name, updated_at = now()
    where id = v_organization_id;
  end if;

  select booth_id into v_linked_booth_id
  from private.booth_directory_links
  where machine_id = v_machine_id;

  select id into v_booth_id from public.booths where code = v_booth_code for update;
  if v_booth_id is null then
    if v_linked_booth_id is not null then raise exception 'machine already belongs to another booth'; end if;
    insert into public.booths (organization_id, code, name, location, access_enabled)
    values (v_organization_id, v_booth_code, v_name, v_location, coalesce(p_access_enabled, true))
    returning id, updated_at into v_booth_id, v_updated_at;
    insert into private.booth_directory_links (booth_id, machine_id) values (v_booth_id, v_machine_id);
  else
    select machine_id into v_existing_machine_id from private.booth_directory_links where booth_id = v_booth_id;
    if v_existing_machine_id is not null and v_existing_machine_id <> v_machine_id then
      raise exception 'booth already belongs to another machine';
    end if;
    if v_linked_booth_id is not null and v_linked_booth_id <> v_booth_id then
      raise exception 'machine already belongs to another booth';
    end if;
    if v_existing_machine_id is null then
      insert into private.booth_directory_links (booth_id, machine_id) values (v_booth_id, v_machine_id);
    end if;
    update public.booths set organization_id = v_organization_id, name = v_name,
      location = v_location, access_enabled = coalesce(p_access_enabled, true), updated_at = now()
    where id = v_booth_id returning updated_at into v_updated_at;
  end if;

  return jsonb_build_object(
    'boothCode', v_booth_code,
    'machineId', v_machine_id,
    'organizationId', v_organization_id,
    'organizationLegacyId', v_org_legacy_id,
    'name', v_name,
    'location', v_location,
    'accessEnabled', coalesce(p_access_enabled, true),
    'updatedAt', v_updated_at
  );
end;
$$;

create or replace function public.photoslive_booth_directory_snapshot(p_booth_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'boothCode', booth.code,
    'machineId', booth_link.machine_id,
    'organizationId', booth.organization_id,
    'organizationLegacyId', organization_link.legacy_id,
    'name', booth.name,
    'location', booth.location,
    'accessEnabled', booth.access_enabled,
    'updatedAt', booth.updated_at
  )
  from public.booths booth
  join private.booth_directory_links booth_link on booth_link.booth_id = booth.id
  join private.organization_directory_links organization_link on organization_link.organization_id = booth.organization_id
  where booth.code = lower(trim(p_booth_code));
$$;

create or replace function public.photoslive_set_booth_access(p_booth_code text, p_access_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare v_booth_id uuid;
begin
  select id into v_booth_id from public.booths where code = lower(trim(p_booth_code)) for update;
  if v_booth_id is null then raise exception 'booth not found'; end if;
  update public.booths set access_enabled = coalesce(p_access_enabled, false), updated_at = now() where id = v_booth_id;
  return public.photoslive_booth_directory_snapshot(lower(trim(p_booth_code)));
end;
$$;

revoke all on function public.photoslive_persist_booth_directory(text, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.photoslive_booth_directory_snapshot(text) from public, anon, authenticated;
revoke all on function public.photoslive_set_booth_access(text, boolean) from public, anon, authenticated;
grant execute on function public.photoslive_persist_booth_directory(text, text, text, text, text, text, boolean) to service_role;
grant execute on function public.photoslive_booth_directory_snapshot(text) to service_role;
grant execute on function public.photoslive_set_booth_access(text, boolean) to service_role;
