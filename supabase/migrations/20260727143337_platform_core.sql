create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('platform_owner', 'integration_admin', 'finance_admin', 'fleet_admin', 'support', 'auditor')),
  created_at timestamptz not null default now()
);

create table public.booths (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code text not null unique check (code = lower(code) and code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  name text not null check (char_length(name) between 1 and 120),
  location text not null default '',
  access_enabled boolean not null default true,
  config_version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.booth_memberships (
  booth_id uuid not null references public.booths(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'operator')),
  created_at timestamptz not null default now(),
  primary key (booth_id, user_id)
);

create table public.booth_configs (
  booth_id uuid primary key references public.booths(id) on delete cascade,
  version bigint not null default 1 check (version > 0),
  config jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.voucher_events (
  id uuid primary key default gen_random_uuid(),
  booth_id uuid not null references public.booths(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  expires_at timestamptz not null,
  includes_print boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.vouchers (
  id uuid primary key default gen_random_uuid(),
  booth_id uuid not null references public.booths(id) on delete cascade,
  event_id uuid references public.voucher_events(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9-]{4,40}$'),
  includes_print boolean not null default false,
  redeemed_at timestamptz,
  redeemed_session_id uuid,
  idempotency_key text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (booth_id, code),
  unique (booth_id, idempotency_key)
);

create table public.photo_sessions (
  id uuid primary key,
  booth_id uuid not null references public.booths(id) on delete cascade,
  share_code text not null,
  status text not null check (status in ('active', 'completed', 'cancelled', 'expired', 'sync_pending')),
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null,
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booth_id, share_code)
);

alter table public.vouchers
  add constraint vouchers_redeemed_session_fk
  foreign key (redeemed_session_id) references public.photo_sessions(id) on delete set null;

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  booth_id uuid not null references public.booths(id) on delete cascade,
  kind text not null check (kind in ('background', 'frame', 'logo', 'sticker', 'capture', 'render', 'gif')),
  object_key text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (booth_id, object_key)
);

create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  scope text not null check (scope in ('global', 'organization', 'booth')),
  organization_id uuid references public.organizations(id) on delete cascade,
  booth_id uuid references public.booths(id) on delete cascade,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (
    (scope = 'global' and organization_id is null and booth_id is null) or
    (scope = 'organization' and organization_id is not null and booth_id is null) or
    (scope = 'booth' and booth_id is not null)
  )
);

create unique index feature_flags_scope_unique on public.feature_flags
  (key, scope, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(booth_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  capability text not null,
  scope text not null check (scope in ('global', 'organization', 'booth')),
  organization_id uuid references public.organizations(id) on delete cascade,
  booth_id uuid references public.booths(id) on delete cascade,
  secret_reference text not null,
  masked_identifier text not null default '',
  status text not null default 'paused' check (status in ('active', 'paused', 'error', 'expired')),
  health jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope = 'global' and organization_id is null and booth_id is null) or
    (scope = 'organization' and organization_id is not null and booth_id is null) or
    (scope = 'booth' and booth_id is not null)
  )
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  booth_id uuid references public.booths(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null,
  action text not null,
  target_type text not null default '',
  target_id text not null default '',
  correlation_id text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index booth_memberships_user_idx on public.booth_memberships(user_id, booth_id);
create index vouchers_booth_active_idx on public.vouchers(booth_id, redeemed_at, created_at desc);
create index voucher_events_booth_idx on public.voucher_events(booth_id, expires_at);
create index sessions_booth_created_idx on public.photo_sessions(booth_id, created_at desc);
create index assets_booth_kind_idx on public.assets(booth_id, kind, created_at desc);
create index audit_logs_booth_created_idx on public.audit_logs(booth_id, created_at desc);

create or replace function private.has_platform_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.platform_memberships membership
    where membership.user_id = (select auth.uid())
      and membership.role = any(allowed_roles)
  );
$$;

create or replace function private.can_access_booth(target_booth uuid, allowed_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    private.has_platform_role(array['platform_owner', 'fleet_admin', 'support', 'auditor'])
    or exists (
      select 1 from public.booth_memberships membership
      where membership.user_id = (select auth.uid())
        and membership.booth_id = target_booth
        and (allowed_roles is null or membership.role = any(allowed_roles))
    )
  );
$$;

revoke all on function private.has_platform_role(text[]) from public, anon;
revoke all on function private.can_access_booth(uuid, text[]) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.has_platform_role(text[]) to authenticated;
grant execute on function private.can_access_booth(uuid, text[]) to authenticated;

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.platform_memberships enable row level security;
alter table public.booths enable row level security;
alter table public.booth_memberships enable row level security;
alter table public.booth_configs enable row level security;
alter table public.voucher_events enable row level security;
alter table public.vouchers enable row level security;
alter table public.photo_sessions enable row level security;
alter table public.assets enable row level security;
alter table public.feature_flags enable row level security;
alter table public.provider_connections enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_select_self on public.profiles for select to authenticated using ((select auth.uid()) = id or private.has_platform_role(array['platform_owner', 'support', 'auditor']));
create policy profiles_update_self on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy platform_memberships_select_self on public.platform_memberships for select to authenticated using ((select auth.uid()) = user_id or private.has_platform_role(array['platform_owner', 'auditor']));
create policy organizations_select_member on public.organizations for select to authenticated using (private.has_platform_role(array['platform_owner', 'fleet_admin', 'support', 'auditor']) or exists (select 1 from public.booths booth where booth.organization_id = id and private.can_access_booth(booth.id)));
create policy booths_select_member on public.booths for select to authenticated using (private.can_access_booth(id));
create policy booths_update_admin on public.booths for update to authenticated using (private.can_access_booth(id, array['owner', 'admin']) or private.has_platform_role(array['platform_owner', 'fleet_admin'])) with check (private.can_access_booth(id, array['owner', 'admin']) or private.has_platform_role(array['platform_owner', 'fleet_admin']));
create policy booth_memberships_select_member on public.booth_memberships for select to authenticated using (private.can_access_booth(booth_id));
create policy booth_memberships_write_owner on public.booth_memberships for all to authenticated using (private.can_access_booth(booth_id, array['owner']) or private.has_platform_role(array['platform_owner'])) with check (private.can_access_booth(booth_id, array['owner']) or private.has_platform_role(array['platform_owner']));
create policy booth_configs_select_member on public.booth_configs for select to authenticated using (private.can_access_booth(booth_id));
create policy booth_configs_write_admin on public.booth_configs for all to authenticated using (private.can_access_booth(booth_id, array['owner', 'admin'])) with check (private.can_access_booth(booth_id, array['owner', 'admin']));
create policy voucher_events_member on public.voucher_events for select to authenticated using (private.can_access_booth(booth_id));
create policy voucher_events_admin on public.voucher_events for all to authenticated using (private.can_access_booth(booth_id, array['owner', 'admin'])) with check (private.can_access_booth(booth_id, array['owner', 'admin']));
create policy vouchers_member on public.vouchers for select to authenticated using (private.can_access_booth(booth_id));
create policy vouchers_admin on public.vouchers for all to authenticated using (private.can_access_booth(booth_id, array['owner', 'admin'])) with check (private.can_access_booth(booth_id, array['owner', 'admin']));
create policy sessions_member on public.photo_sessions for select to authenticated using (private.can_access_booth(booth_id));
create policy sessions_operator_write on public.photo_sessions for all to authenticated using (private.can_access_booth(booth_id, array['owner', 'admin', 'operator'])) with check (private.can_access_booth(booth_id, array['owner', 'admin', 'operator']));
create policy assets_member on public.assets for select to authenticated using (private.can_access_booth(booth_id));
create policy assets_admin on public.assets for all to authenticated using (private.can_access_booth(booth_id, array['owner', 'admin'])) with check (private.can_access_booth(booth_id, array['owner', 'admin']));
create policy feature_flags_read on public.feature_flags for select to authenticated using (private.has_platform_role(array['platform_owner', 'fleet_admin', 'support', 'auditor']) or (booth_id is not null and private.can_access_booth(booth_id)));
create policy feature_flags_write on public.feature_flags for all to authenticated using (private.has_platform_role(array['platform_owner', 'fleet_admin'])) with check (private.has_platform_role(array['platform_owner', 'fleet_admin']));
create policy provider_connections_read on public.provider_connections for select to authenticated using (private.has_platform_role(array['platform_owner', 'integration_admin', 'auditor']) or (booth_id is not null and private.can_access_booth(booth_id, array['owner'])));
create policy provider_connections_write on public.provider_connections for all to authenticated using (private.has_platform_role(array['platform_owner', 'integration_admin'])) with check (private.has_platform_role(array['platform_owner', 'integration_admin']));
create policy audit_logs_read on public.audit_logs for select to authenticated using (private.has_platform_role(array['platform_owner', 'support', 'auditor']) or (booth_id is not null and private.can_access_booth(booth_id, array['owner', 'admin'])));

grant select, insert, update, delete on public.organizations, public.profiles, public.platform_memberships, public.booths, public.booth_memberships, public.booth_configs, public.voucher_events, public.vouchers, public.photo_sessions, public.assets, public.feature_flags, public.provider_connections to authenticated;
grant select on public.audit_logs to authenticated;
revoke all on all tables in schema public from anon;

comment on table public.provider_connections is 'Secret values live in a server-side secret manager; only an opaque reference and masked identifier are stored here.';
comment on table public.audit_logs is 'Append-only audit records. No authenticated UPDATE or DELETE grant is provided.';
