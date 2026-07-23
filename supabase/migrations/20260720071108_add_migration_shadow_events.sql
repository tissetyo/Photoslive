create table public.migration_shadow_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (char_length(idempotency_key) between 12 and 180),
  entity_type text not null check (entity_type in ('audit', 'booth', 'config', 'voucher', 'voucher_event', 'asset', 'session', 'user')),
  legacy_key text not null check (char_length(legacy_key) between 1 and 240),
  operation text not null check (operation in ('upsert', 'delete')),
  payload jsonb not null,
  payload_checksum text not null check (payload_checksum ~ '^[a-f0-9]{64}$'),
  correlation_id text not null check (char_length(correlation_id) between 1 and 128),
  status text not null default 'pending' check (status in ('pending', 'applied', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index migration_shadow_events_pending_idx
  on public.migration_shadow_events(status, created_at)
  where status in ('pending', 'failed');

alter table public.migration_shadow_events enable row level security;

revoke all on public.migration_shadow_events from public, anon, authenticated;
grant select, insert, update, delete on public.migration_shadow_events to service_role;

comment on table public.migration_shadow_events is
  'Server-only staging journal for the Redis-to-PostgreSQL migration. It is intentionally inaccessible to browser roles.';
