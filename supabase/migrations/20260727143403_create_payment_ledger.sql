create table public.payment_intents (
  id text primary key check (id ~ '^pay_[a-f0-9]{32}$'),
  booth_code text not null references public.booths(code) on update cascade on delete restrict,
  session_id text not null check (char_length(session_id) between 1 and 120),
  purpose text not null check (purpose in ('session', 'print')),
  amount bigint not null check (amount between 1000 and 10000000),
  currency text not null default 'IDR' check (currency = 'IDR'),
  provider text not null check (char_length(provider) between 1 and 40),
  provider_connection_id text,
  provider_connection_source text check (provider_connection_source is null or provider_connection_source in ('byo', 'platform-managed', 'deployment-environment')),
  provider_credential_version integer check (provider_credential_version is null or provider_credential_version >= 0),
  provider_credential_fingerprint text check (provider_credential_fingerprint is null or provider_credential_fingerprint ~ '^[a-f0-9]{64}$'),
  provider_payment_id text not null unique check (char_length(provider_payment_id) between 1 and 120),
  provider_transaction_id text,
  status text not null check (status in ('pending', 'paid', 'settled', 'expired', 'failed', 'refunded', 'chargeback')),
  checkout_expires_at timestamptz not null,
  provider_expires_at timestamptz,
  paid_at timestamptz,
  refunded_at timestamptz,
  chargeback_at timestamptz,
  failure_code text,
  platform_fee_bps integer not null check (platform_fee_bps between 0 and 10000),
  platform_fee bigint not null check (platform_fee >= 0 and platform_fee <= amount),
  late_payment boolean not null default false,
  review_status text not null default 'not_required' check (review_status in ('not_required', 'pending', 'approved', 'rejected')),
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (provider_expires_at is null or provider_expires_at >= checkout_expires_at),
  check (
    (provider_connection_source is null and provider_connection_id is null and provider_credential_version is null and provider_credential_fingerprint is null)
    or (provider_connection_source = 'deployment-environment' and provider_connection_id is null and provider_credential_version = 0 and provider_credential_fingerprint is not null)
    or (provider_connection_source in ('byo', 'platform-managed') and provider_connection_id is not null and provider_credential_version >= 1 and provider_credential_fingerprint is not null)
  ),
  check ((late_payment and review_status <> 'not_required') or (not late_payment))
);

create index payment_intents_booth_created_idx
  on public.payment_intents(booth_code, created_at desc);
create index payment_intents_pending_reconcile_idx
  on public.payment_intents(updated_at, provider_expires_at)
  where status = 'pending';
create index payment_intents_session_idx
  on public.payment_intents(booth_code, session_id, purpose, created_at desc);

create table public.payment_refunds (
  id text primary key check (id ~ '^refund_[a-f0-9]{32}$'),
  payment_id text not null references public.payment_intents(id) on update cascade on delete restrict,
  booth_code text not null references public.booths(code) on update cascade on delete restrict,
  provider text not null check (char_length(provider) between 1 and 40),
  provider_refund_id text not null unique check (char_length(provider_refund_id) between 1 and 120),
  amount bigint not null check (amount between 1000 and 10000000),
  currency text not null default 'IDR' check (currency = 'IDR'),
  reason text not null check (reason in ('FRAUDULENT', 'DUPLICATE', 'REQUESTED_BY_CUSTOMER', 'CANCELLATION', 'OTHERS')),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  failure_code text,
  requested_by text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  completed_at timestamptz,
  check ((status in ('succeeded', 'failed', 'cancelled') and completed_at is not null) or (status = 'pending'))
);

create index payment_refunds_payment_created_idx
  on public.payment_refunds(payment_id, created_at desc);
create index payment_refunds_booth_created_idx
  on public.payment_refunds(booth_code, created_at desc);

create table public.payment_chargebacks (
  id text primary key check (id ~ '^chargeback_[a-f0-9]{32}$'),
  payment_id text not null unique references public.payment_intents(id) on update cascade on delete restrict,
  booth_code text not null references public.booths(code) on update cascade on delete restrict,
  provider text not null check (char_length(provider) between 1 and 40),
  provider_chargeback_id text not null unique check (char_length(provider_chargeback_id) between 1 and 120),
  amount bigint not null check (amount between 1000 and 10000000),
  currency text not null default 'IDR' check (currency = 'IDR'),
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'confirmed' check (status = 'confirmed'),
  disputed_at timestamptz not null,
  recorded_by text,
  created_at timestamptz not null
);

create index payment_chargebacks_booth_disputed_idx
  on public.payment_chargebacks(booth_code, disputed_at desc);

create table public.financial_ledger_entries (
  id text primary key check (id ~ '^ledger_[a-f0-9]{32}$'),
  booth_code text not null references public.booths(code) on update cascade on delete restrict,
  payment_id text not null references public.payment_intents(id) on update cascade on delete restrict,
  entry_type text not null check (entry_type in ('payment_captured', 'provider_fee', 'platform_fee_adjustment', 'refund', 'chargeback', 'payout', 'adjustment')),
  currency text not null default 'IDR' check (currency = 'IDR'),
  gross bigint not null,
  provider_fee bigint,
  provider_fee_final boolean not null default false,
  platform_fee bigint not null,
  booth_earning bigint not null,
  provider text not null check (char_length(provider) between 1 and 40),
  provider_payment_id text not null check (char_length(provider_payment_id) between 1 and 120),
  idempotency_key text not null unique check (char_length(idempotency_key) between 12 and 180),
  entry_hash text not null check (entry_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  check (provider_fee is null or provider_fee >= 0),
  check (entry_type <> 'payment_captured' or gross > 0)
);

create index financial_ledger_booth_created_idx
  on public.financial_ledger_entries(booth_code, created_at desc);
create index financial_ledger_payment_idx
  on public.financial_ledger_entries(payment_id, created_at);

create table public.payment_reconciliation_jobs (
  payment_id text primary key references public.payment_intents(id) on update cascade on delete cascade,
  booth_code text not null references public.booths(code) on update cascade on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'running', 'review', 'resolved', 'dead')),
  reason text not null default 'provider_pending' check (reason in ('provider_pending', 'checkout_expired', 'late_payment', 'provider_error', 'manual')),
  attempts integer not null default 0 check (attempts between 0 and 100),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  last_provider_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index payment_reconciliation_due_idx
  on public.payment_reconciliation_jobs(next_attempt_at, created_at)
  where status in ('pending', 'running');
create index payment_reconciliation_review_idx
  on public.payment_reconciliation_jobs(booth_code, updated_at desc)
  where status = 'review';

create or replace function private.guard_payment_intent_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(old.booth_code, old.session_id, old.purpose, old.amount, old.currency, old.provider, old.provider_connection_id, old.provider_connection_source, old.provider_credential_version, old.provider_credential_fingerprint, old.provider_payment_id, old.platform_fee_bps, old.platform_fee, old.created_at)
    is distinct from
    row(new.booth_code, new.session_id, new.purpose, new.amount, new.currency, new.provider, new.provider_connection_id, new.provider_connection_source, new.provider_credential_version, new.provider_credential_fingerprint, new.provider_payment_id, new.platform_fee_bps, new.platform_fee, new.created_at) then
    raise exception 'immutable payment identity or fee snapshot cannot be changed';
  end if;

  if old.status in ('refunded', 'chargeback') and new.status <> old.status then
    raise exception 'terminal payment status cannot be changed';
  end if;
  if old.status in ('paid', 'settled') and new.status in ('pending', 'expired', 'failed') then
    raise exception 'payment status cannot regress';
  end if;
  return new;
end;
$$;

create trigger payment_intents_guard_update
before update on public.payment_intents
for each row execute function private.guard_payment_intent_update();

create or replace function private.guard_payment_refund_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(old.payment_id, old.booth_code, old.provider, old.provider_refund_id, old.amount, old.currency, old.reason, old.requested_by, old.created_at)
    is distinct from
    row(new.payment_id, new.booth_code, new.provider, new.provider_refund_id, new.amount, new.currency, new.reason, new.requested_by, new.created_at) then
    raise exception 'immutable refund identity cannot be changed';
  end if;
  if old.status in ('succeeded', 'failed', 'cancelled') and new.status <> old.status then
    raise exception 'terminal refund status cannot be changed';
  end if;
  return new;
end;
$$;

create trigger payment_refunds_guard_update
before update on public.payment_refunds
for each row execute function private.guard_payment_refund_update();

create or replace function private.prepare_financial_ledger_entry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.entry_hash := encode(public.digest(concat_ws('|',
    new.id,
    new.booth_code,
    new.payment_id,
    new.entry_type,
    new.currency,
    new.gross::text,
    coalesce(new.provider_fee::text, ''),
    new.provider_fee_final::text,
    new.platform_fee::text,
    new.booth_earning::text,
    new.provider,
    new.provider_payment_id,
    new.idempotency_key,
    new.created_at::text,
    new.metadata::text
  ), 'sha256'), 'hex');
  return new;
end;
$$;

create trigger financial_ledger_prepare_insert
before insert on public.financial_ledger_entries
for each row execute function private.prepare_financial_ledger_entry();

create or replace function private.reject_financial_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'financial ledger entries are append-only';
end;
$$;

create trigger financial_ledger_reject_update_delete
before update or delete on public.financial_ledger_entries
for each row execute function private.reject_financial_ledger_mutation();

revoke all on function private.guard_payment_intent_update() from public, anon, authenticated;
revoke all on function private.guard_payment_refund_update() from public, anon, authenticated;
revoke all on function private.prepare_financial_ledger_entry() from public, anon, authenticated;
revoke all on function private.reject_financial_ledger_mutation() from public, anon, authenticated;

alter table public.payment_intents enable row level security;
alter table public.payment_refunds enable row level security;
alter table public.payment_chargebacks enable row level security;
alter table public.financial_ledger_entries enable row level security;
alter table public.payment_reconciliation_jobs enable row level security;

create policy payment_intents_finance_read on public.payment_intents
for select to authenticated
using (
  private.has_platform_role(array['platform_owner', 'finance_admin', 'auditor'])
  or exists (
    select 1 from public.booths booth
    where booth.code = payment_intents.booth_code
      and private.can_access_booth(booth.id, array['owner', 'admin'])
  )
);

create policy financial_ledger_finance_read on public.financial_ledger_entries
for select to authenticated
using (
  private.has_platform_role(array['platform_owner', 'finance_admin', 'auditor'])
  or exists (
    select 1 from public.booths booth
    where booth.code = financial_ledger_entries.booth_code
      and private.can_access_booth(booth.id, array['owner', 'admin'])
  )
);

create policy payment_refunds_finance_read on public.payment_refunds
for select to authenticated
using (
  private.has_platform_role(array['platform_owner', 'finance_admin', 'auditor'])
  or exists (
    select 1 from public.booths booth
    where booth.code = payment_refunds.booth_code
      and private.can_access_booth(booth.id, array['owner', 'admin'])
  )
);

create policy payment_chargebacks_finance_read on public.payment_chargebacks
for select to authenticated
using (
  private.has_platform_role(array['platform_owner', 'finance_admin', 'auditor'])
  or exists (
    select 1 from public.booths booth
    where booth.code = payment_chargebacks.booth_code
      and private.can_access_booth(booth.id, array['owner', 'admin'])
  )
);

grant select on public.payment_intents, public.payment_refunds, public.payment_chargebacks, public.financial_ledger_entries to authenticated;
grant select, insert, update on public.payment_intents, public.payment_refunds, public.payment_reconciliation_jobs to service_role;
grant select, insert on public.payment_chargebacks to service_role;
grant select, insert on public.financial_ledger_entries to service_role;
revoke all on public.payment_intents, public.payment_refunds, public.payment_chargebacks, public.financial_ledger_entries, public.payment_reconciliation_jobs from public, anon;
revoke update, delete on public.financial_ledger_entries from authenticated, service_role;
revoke all on public.payment_reconciliation_jobs from authenticated;

comment on table public.payment_intents is
  'Server-written payment intents. Amount, tenant, provider identity, and fee snapshot are immutable after creation.';
comment on table public.financial_ledger_entries is
  'Append-only financial journal. Corrections must be represented by a new compensating entry; update and delete are rejected by trigger.';
comment on table public.payment_reconciliation_jobs is
  'Server-only work queue for missed webhooks, checkout expiry, provider retries, and late-payment review.';
comment on table public.payment_refunds is
  'Server-written full refund attempts. Final status is updated only from a verified provider webhook.';
comment on table public.payment_chargebacks is
  'Server-written confirmed provider disputes. Each payment and provider case can be recorded only once.';
