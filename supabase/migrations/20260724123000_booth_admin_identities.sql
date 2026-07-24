create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.booth_admin_identities (
  user_id text primary key check (user_id ~ '^[A-Za-z0-9._:-]{3,120}$'),
  booth_code text not null check (booth_code = lower(booth_code) and booth_code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  machine_id text not null check (machine_id ~ '^[A-Za-z0-9._:-]{3,160}$'),
  email text not null unique check (email = lower(email) and position('@' in email) > 1 and char_length(email) <= 160),
  name text not null check (char_length(name) between 1 and 80),
  role text not null check (role in ('owner', 'admin', 'operator')),
  password_hash text,
  pin_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists booth_admin_identities_booth_idx on private.booth_admin_identities(booth_code, active, role);

revoke all on table private.booth_admin_identities from public, anon, authenticated;

create or replace function private.admin_user_public_snapshot(p_record private.booth_admin_identities)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $$
  select jsonb_build_object(
    'id', p_record.user_id,
    'boothCode', p_record.booth_code,
    'machineId', p_record.machine_id,
    'email', p_record.email,
    'name', p_record.name,
    'role', p_record.role,
    'passwordHash', coalesce(p_record.password_hash, ''),
    'pinHash', p_record.pin_hash,
    'active', p_record.active,
    'createdAt', p_record.created_at,
    'updatedAt', p_record.updated_at
  );
$$;

create or replace function public.photoslive_persist_admin_user(p_user jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user_id text := trim(coalesce(p_user->>'id', ''));
  v_booth_code text := lower(regexp_replace(trim(coalesce(p_user->>'boothCode', '')), '[^a-z0-9-]', '', 'g'));
  v_machine_id text := trim(coalesce(p_user->>'machineId', ''));
  v_email text := lower(trim(coalesce(p_user->>'email', '')));
  v_name text := left(trim(coalesce(p_user->>'name', 'Pengguna')), 80);
  v_role text := lower(trim(coalesce(p_user->>'role', 'operator')));
  v_password_hash text := nullif(trim(coalesce(p_user->>'passwordHash', '')), '');
  v_pin_hash text := trim(coalesce(p_user->>'pinHash', ''));
  v_record private.booth_admin_identities%rowtype;
begin
  if v_user_id !~ '^[A-Za-z0-9._:-]{3,120}$'
    or v_booth_code !~ '^[a-z0-9][a-z0-9-]{2,63}$'
    or v_machine_id !~ '^[A-Za-z0-9._:-]{3,160}$'
    or position('@' in v_email) <= 1
    or char_length(v_pin_hash) < 32
    or v_role not in ('owner', 'admin', 'operator') then
    raise exception 'invalid admin user input';
  end if;

  insert into private.booth_admin_identities (
    user_id, booth_code, machine_id, email, name, role, password_hash, pin_hash, active
  )
  values (
    v_user_id, v_booth_code, v_machine_id, v_email, coalesce(nullif(v_name, ''), 'Pengguna'),
    v_role, v_password_hash, v_pin_hash, coalesce((p_user->>'active')::boolean, true)
  )
  on conflict (user_id) do update set
    booth_code = excluded.booth_code,
    machine_id = excluded.machine_id,
    email = excluded.email,
    name = excluded.name,
    role = excluded.role,
    password_hash = excluded.password_hash,
    pin_hash = excluded.pin_hash,
    active = excluded.active,
    updated_at = now()
  returning * into v_record;

  return private.admin_user_public_snapshot(v_record);
end;
$$;

create or replace function public.photoslive_admin_user_by_email(p_email text)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select private.admin_user_public_snapshot(identity)
  from private.booth_admin_identities identity
  where identity.email = lower(trim(p_email))
  limit 1;
$$;

create or replace function public.photoslive_admin_user_by_id(p_user_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select private.admin_user_public_snapshot(identity)
  from private.booth_admin_identities identity
  where identity.user_id = trim(p_user_id)
  limit 1;
$$;

create or replace function public.photoslive_admin_users_for_booth(p_booth_code text)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
  select coalesce(jsonb_agg(private.admin_user_public_snapshot(identity) order by identity.created_at), '[]'::jsonb)
  from private.booth_admin_identities identity
  where identity.booth_code = lower(trim(p_booth_code));
$$;

revoke all on function private.admin_user_public_snapshot(private.booth_admin_identities) from public, anon, authenticated;
revoke all on function public.photoslive_persist_admin_user(jsonb) from public, anon, authenticated;
revoke all on function public.photoslive_admin_user_by_email(text) from public, anon, authenticated;
revoke all on function public.photoslive_admin_user_by_id(text) from public, anon, authenticated;
revoke all on function public.photoslive_admin_users_for_booth(text) from public, anon, authenticated;

grant execute on function public.photoslive_persist_admin_user(jsonb) to service_role;
grant execute on function public.photoslive_admin_user_by_email(text) to service_role;
grant execute on function public.photoslive_admin_user_by_id(text) to service_role;
grant execute on function public.photoslive_admin_users_for_booth(text) to service_role;
