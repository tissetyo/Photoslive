-- Repair account-first booths that were created by the QR claim flow without
-- the legacy organization directory row expected by the cloud runtime.
insert into private.organization_directory_links (organization_id, legacy_id)
select organization.id, 'account-org:' || organization.id::text
from public.organizations organization
left join private.organization_directory_links link
  on link.organization_id = organization.id
where link.organization_id is null
on conflict do nothing;

create or replace function private.photoslive_ensure_directory_links()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  insert into private.organization_directory_links (organization_id, legacy_id)
  values (new.organization_id, 'account-org:' || new.organization_id::text)
  on conflict (organization_id) do nothing;

  if new.machine_id is not null and trim(new.machine_id) <> '' then
    insert into private.booth_directory_links (booth_id, machine_id)
    values (new.id, new.machine_id)
    on conflict (booth_id) do update
      set machine_id = excluded.machine_id;
  end if;
  return new;
end;
$$;

drop trigger if exists photoslive_ensure_directory_links on public.booths;
create trigger photoslive_ensure_directory_links
after insert or update of organization_id, machine_id on public.booths
for each row execute function private.photoslive_ensure_directory_links();

create or replace function public.photoslive_booth_directory_snapshot(p_booth_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'boothCode', booth.code,
    'machineId', coalesce(booth_link.machine_id, booth.machine_id),
    'organizationId', booth.organization_id,
    'organizationLegacyId', coalesce(
      organization_link.legacy_id,
      'account-org:' || booth.organization_id::text
    ),
    'name', booth.name,
    'location', booth.location,
    'accessEnabled', booth.access_enabled,
    'updatedAt', booth.updated_at
  )
  from public.booths booth
  left join private.booth_directory_links booth_link
    on booth_link.booth_id = booth.id
  left join private.organization_directory_links organization_link
    on organization_link.organization_id = booth.organization_id
  where booth.code = lower(trim(p_booth_code))
    and coalesce(booth_link.machine_id, booth.machine_id) is not null;
$$;

revoke all on function private.photoslive_ensure_directory_links() from public, anon, authenticated;
revoke all on function public.photoslive_booth_directory_snapshot(text) from public, anon, authenticated;
grant execute on function public.photoslive_booth_directory_snapshot(text) to service_role;
