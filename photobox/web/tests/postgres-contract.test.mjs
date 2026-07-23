import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationPath = path.join(workspace, "supabase/migrations/20260720035058_platform_core.sql");
const migration = fs.readFileSync(migrationPath, "utf8").toLowerCase();
const shadowMigration = fs.readFileSync(path.join(workspace, "supabase/migrations/20260720071108_add_migration_shadow_events.sql"), "utf8").toLowerCase();
const paymentShadowMigration = fs.readFileSync(path.join(workspace, "supabase/migrations/20260721102309_extend_shadow_payment_entities.sql"), "utf8").toLowerCase();
const financeMigration = fs.readFileSync(path.join(workspace, "supabase/migrations/20260721104654_create_payment_ledger.sql"), "utf8").toLowerCase();
const payoutMigration = fs.readFileSync(path.join(workspace, "supabase/migrations/20260721170000_create_manual_payouts.sql"), "utf8").toLowerCase();
const publicTables = [
  "organizations", "profiles", "platform_memberships", "booths", "booth_memberships",
  "booth_configs", "voucher_events", "vouchers", "photo_sessions", "assets",
  "feature_flags", "provider_connections", "audit_logs",
];

test("every exposed platform table enables row level security", () => {
  for (const table of publicTables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`), table);
  }
});

test("tenant data policies are constrained by booth membership and role", () => {
  assert.match(migration, /create or replace function private\.can_access_booth/);
  for (const table of ["booths", "booth_configs", "voucher_events", "vouchers", "photo_sessions", "assets"]) {
    assert.match(migration, new RegExp(`create policy [^;]+ on public\\.${table}[^;]+private\\.can_access_booth`, "s"), table);
  }
  assert.match(migration, /booth_memberships_write_owner[^;]+private\.can_access_booth\(booth_id, array\['owner'\]\)/s);
  assert.match(migration, /provider_connections_write[^;]+private\.has_platform_role\(array\['platform_owner', 'integration_admin'\]\)/s);
});

test("postgres contract keeps secrets server-side and anon access revoked", () => {
  assert.match(migration, /secret_reference text/);
  assert.doesNotMatch(migration, /api_key\s+text|secret_value\s+text|access_token\s+text/);
  assert.match(migration, /revoke all on all tables in schema public from anon/);
  assert.doesNotMatch(migration, /grant\s+(update|delete)[^;]*audit_logs/);
});

test("shared protocol v2 schemas are valid JSON with stable identifiers", () => {
  for (const name of ["heartbeat.schema.json", "hardware-job.schema.json", "session-sync.schema.json", "multipart-checkpoint.schema.json"]) {
    const schema = JSON.parse(fs.readFileSync(path.join(workspace, "photobox/contracts/v2", name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /photoslive/);
    assert.equal(schema.type, "object");
  }
});

test("migration shadow journal is server-only, idempotent, and protected by RLS", () => {
  assert.match(shadowMigration, /idempotency_key text not null unique/);
  assert.match(shadowMigration, /alter table public\.migration_shadow_events enable row level security/);
  assert.match(shadowMigration, /revoke all on public\.migration_shadow_events from public, anon, authenticated/);
  assert.match(shadowMigration, /grant select, insert, update, delete on public\.migration_shadow_events to service_role/);
  assert.doesNotMatch(shadowMigration, /grant[^;]+to (anon|authenticated)/);
});

test("payment and ledger shadow entities are explicitly allowlisted by migration", () => {
  assert.match(paymentShadowMigration, /drop constraint if exists migration_shadow_events_entity_type_check/);
  assert.match(paymentShadowMigration, /entity_type in \([^)]*'payment'[^)]*'ledger'[^)]*\)/);
  assert.doesNotMatch(paymentShadowMigration, /grant .* to (public|anon|authenticated)/);
});

test("payment migration provides immutable fee snapshots and append-only ledger entries", () => {
  assert.match(financeMigration, /create table public\.payment_intents/);
  assert.match(financeMigration, /platform_fee_bps integer not null/);
  assert.match(financeMigration, /review_status text not null default 'not_required'/);
  assert.match(financeMigration, /reviewed_at timestamptz/);
  assert.match(financeMigration, /review_note text check/);
  assert.match(financeMigration, /provider_connection_id text/);
  assert.match(financeMigration, /provider_credential_version integer/);
  assert.match(financeMigration, /provider_credential_fingerprint text/);
  assert.match(financeMigration, /immutable payment identity or fee snapshot cannot be changed/);
  assert.match(financeMigration, /create table public\.financial_ledger_entries/);
  assert.match(financeMigration, /financial ledger entries are append-only/);
  assert.match(financeMigration, /before update or delete on public\.financial_ledger_entries/);
  assert.match(financeMigration, /idempotency_key text not null unique/);
  assert.match(financeMigration, /entry_hash text not null/);
  assert.match(financeMigration, /create table public\.payment_refunds/);
  assert.match(financeMigration, /provider_refund_id text not null unique/);
  assert.match(financeMigration, /immutable refund identity cannot be changed/);
  assert.match(financeMigration, /terminal refund status cannot be changed/);
  assert.match(financeMigration, /create table public\.payment_chargebacks/);
  assert.match(financeMigration, /provider_chargeback_id text not null unique/);
  assert.match(financeMigration, /payment_id text not null unique/);
});

test("payment migration secures reconciliation and uses bounded partial indexes", () => {
  for (const table of ["payment_intents", "payment_refunds", "payment_chargebacks", "financial_ledger_entries", "payment_reconciliation_jobs"]) {
    assert.match(financeMigration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(financeMigration, /where status = 'pending'/);
  assert.match(financeMigration, /where status in \('pending', 'running'\)/);
  assert.match(financeMigration, /revoke all on public\.payment_reconciliation_jobs from authenticated/);
  assert.match(financeMigration, /revoke update, delete on public\.financial_ledger_entries from authenticated, service_role/);
  assert.doesNotMatch(financeMigration, /grant (insert|update|delete)[^;]*financial_ledger_entries to authenticated/);
  assert.doesNotMatch(financeMigration, /grant[^;]*payment_reconciliation_jobs to authenticated/);
});

test("manual payout migration keeps encrypted accounts server-only and payout ledger linked", () => {
  for (const table of ["payout_policies", "payout_accounts", "payouts"]) {
    assert.match(payoutMigration, new RegExp(`create table public\\.${table}`));
    assert.match(payoutMigration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(payoutMigration, new RegExp(`revoke all on public\\.${table} from anon, authenticated`));
  }
  assert.match(payoutMigration, /sealed_account jsonb not null/);
  assert.match(payoutMigration, /add column payout_id text references public\.payouts/);
  assert.match(payoutMigration, /num_nonnulls\(payment_id, payout_id\) = 1/);
  assert.match(payoutMigration, /immutable payout fields cannot be changed/);
  assert.match(payoutMigration, /paid payout cannot transition/);
  assert.doesNotMatch(payoutMigration, /grant all on public\.payout_accounts to (anon|authenticated)/);
});
