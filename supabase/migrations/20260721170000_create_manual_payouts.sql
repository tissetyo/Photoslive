-- Manual payout control plane. Sensitive account payloads are service-role only.

alter table public.migration_shadow_events
  drop constraint if exists migration_shadow_events_entity_type_check;

alter table public.migration_shadow_events
  add constraint migration_shadow_events_entity_type_check
  check (entity_type in ('audit', 'booth', 'config', 'voucher', 'voucher_event', 'asset', 'session', 'user', 'payment', 'ledger', 'payout', 'payout_account', 'payout_policy'));

create table public.payout_policies (
  booth_code text primary key references public.booths(code) on update cascade on delete cascade,
  mode text not null default 'disabled' check (mode in ('disabled', 'manual_superadmin')),
  minimum_amount bigint not null default 10000 check (minimum_amount between 10000 and 100000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table public.payout_accounts (
  booth_code text primary key references public.booths(code) on update cascade on delete cascade,
  bank_code text not null check (char_length(bank_code) between 2 and 32),
  account_name text not null check (char_length(account_name) between 2 and 120),
  account_number_masked text not null check (char_length(account_number_masked) between 4 and 40),
  sealed_account jsonb not null,
  status text not null default 'pending_verification' check (status in ('pending_verification', 'verified')),
  version integer not null check (version > 0),
  verified_at timestamptz,
  verified_by text,
  verification_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  check ((status = 'verified') = (verified_at is not null and verified_by is not null and verification_reference is not null))
);

create table public.payouts (
  id text primary key check (id ~ '^payout_[a-f0-9]{32}$'),
  booth_code text not null references public.booths(code) on update cascade on delete restrict,
  period text not null check (char_length(period) between 1 and 32),
  mode text not null check (mode = 'manual_superadmin'),
  currency text not null default 'IDR' check (currency = 'IDR'),
  amount bigint not null check (amount between 10000 and 1000000000),
  status text not null check (status in ('pending_approval', 'approved', 'paid', 'cancelled')),
  account_version integer not null check (account_version > 0),
  account_snapshot jsonb not null,
  prepared_by text not null,
  approved_by text,
  approved_at timestamptz,
  paid_by text,
  paid_at timestamptz,
  transfer_reference text,
  proof_object_key text,
  proof_verified_at timestamptz,
  ledger_entry_id text,
  email_delivery_id text,
  cancellation_reason text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booth_code, period),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  check (status <> 'paid' or (paid_by is not null and paid_at is not null and transfer_reference is not null and proof_object_key is not null and proof_verified_at is not null)),
  check (status <> 'cancelled' or (cancellation_reason is not null and cancelled_at is not null))
);

create index payouts_booth_created_idx on public.payouts(booth_code, created_at desc);
create index payouts_status_created_idx on public.payouts(status, created_at desc);

alter table public.financial_ledger_entries
  alter column payment_id drop not null,
  add column payout_id text references public.payouts(id) on update cascade on delete restrict;

alter table public.financial_ledger_entries
  add constraint financial_ledger_single_source_check
  check (num_nonnulls(payment_id, payout_id) = 1),
  add constraint financial_ledger_payout_type_check
  check ((entry_type = 'payout') = (payout_id is not null));

create index financial_ledger_payout_idx
  on public.financial_ledger_entries(payout_id, created_at)
  where payout_id is not null;

create or replace function private.guard_payout_immutable_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.booth_code <> old.booth_code
    or new.period <> old.period
    or new.mode <> old.mode
    or new.currency <> old.currency
    or new.amount <> old.amount
    or new.account_version <> old.account_version
    or new.account_snapshot <> old.account_snapshot
    or new.prepared_by <> old.prepared_by
    or new.created_at <> old.created_at then
    raise exception 'immutable payout fields cannot be changed';
  end if;
  if old.status = 'paid' and new.status <> 'paid' then
    raise exception 'paid payout cannot transition';
  end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'cancelled payout cannot transition';
  end if;
  return new;
end;
$$;

create trigger payouts_guard_immutable_fields
before update on public.payouts
for each row execute function private.guard_payout_immutable_fields();

alter table public.payout_policies enable row level security;
alter table public.payout_accounts enable row level security;
alter table public.payouts enable row level security;

-- Payout writes and encrypted account reads are intentionally restricted to
-- the server-side service role. Finance users access masked projections via API.
revoke all on public.payout_policies from anon, authenticated;
revoke all on public.payout_accounts from anon, authenticated;
revoke all on public.payouts from anon, authenticated;

grant all on public.payout_policies to service_role;
grant all on public.payout_accounts to service_role;
grant all on public.payouts to service_role;
