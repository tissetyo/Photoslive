import { redactLogValue } from "./_observability.mjs";

const DEFAULT_TIMEOUT_MS = 400;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 2_000;
const ALLOWED_ENTITY_TYPES = new Set(["audit", "booth", "config", "voucher", "voucher_event", "asset", "session", "user", "payment", "ledger", "payout", "payout_account", "payout_policy"]);
const ALLOWED_OPERATIONS = new Set(["upsert", "delete"]);

function normalizedBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function timeoutMs(environment) {
  const configured = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(configured)));
}

export function postgresShadowStatus(environment = process.env) {
  const enabled = String(environment.PHOTOSLIVE_POSTGRES_SHADOW || "").toLowerCase() === "true";
  const url = normalizedBaseUrl(environment.SUPABASE_URL);
  const serviceRoleKey = String(environment.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const configured = Boolean(url && serviceRoleKey);
  return {
    enabled,
    configured,
    available: enabled && configured,
    timeoutMs: timeoutMs(environment),
    reason: !enabled
      ? "PostgreSQL shadow write belum diaktifkan"
      : configured
        ? ""
        : "SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi di server",
  };
}

export function postgresFinanceStatus(environment = process.env) {
  const enabled = String(environment.PHOTOSLIVE_POSTGRES_FINANCE || "").toLowerCase() === "true";
  const url = normalizedBaseUrl(environment.SUPABASE_URL);
  const serviceRoleKey = String(environment.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const configured = Boolean(url && serviceRoleKey);
  return {
    enabled,
    configured,
    available: enabled && configured,
    timeoutMs: timeoutMs(environment),
    reason: !enabled
      ? "PostgreSQL finance write belum diaktifkan"
      : configured
        ? ""
        : "SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi di server",
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function cleanIdentifier(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

export async function writePostgresShadowEvent(input, options = {}) {
  const environment = options.environment || process.env;
  const fetchImplementation = options.fetchImplementation || fetch;
  const status = postgresShadowStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, reason: status.reason };

  const entityType = cleanIdentifier(input.entityType, 40);
  const operation = cleanIdentifier(input.operation || "upsert", 12);
  const legacyKey = cleanIdentifier(input.legacyKey, 240);
  const idempotencyKey = cleanIdentifier(input.idempotencyKey, 180);
  const correlationId = cleanIdentifier(input.correlationId, 128);
  if (!ALLOWED_ENTITY_TYPES.has(entityType)) throw new Error("Jenis entity shadow write tidak valid");
  if (!ALLOWED_OPERATIONS.has(operation)) throw new Error("Operasi shadow write tidak valid");
  if (!legacyKey || idempotencyKey.length < 12 || !correlationId) throw new Error("Identitas shadow write tidak lengkap");

  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const serializedPayload = JSON.stringify(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await fetchImplementation(
      `${normalizedBaseUrl(environment.SUPABASE_URL)}/rest/v1/migration_shadow_events?on_conflict=idempotency_key`,
      {
        method: "POST",
        headers: {
          apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
          prefer: "resolution=ignore-duplicates,return=minimal",
        },
        body: JSON.stringify({
          idempotency_key: idempotencyKey,
          entity_type: entityType,
          legacy_key: legacyKey,
          operation,
          payload,
          payload_checksum: await sha256(serializedPayload),
          correlation_id: correlationId,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`PostgreSQL shadow write gagal (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return { ok: true, skipped: false };
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? `PostgreSQL shadow write timeout setelah ${status.timeoutMs} ms`
      : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({
      level: "warn",
      event: "postgres.shadow_write.failed",
      entityType,
      legacyKey,
      correlationId,
      reason,
    })));
    return { ok: false, skipped: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

function financeHeaders(environment, prefer) {
  return {
    apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    prefer,
  };
}

async function writeFinanceRow(table, body, query, prefer, identity, options = {}) {
  const environment = options.environment || process.env;
  const fetchImplementation = options.fetchImplementation || fetch;
  const status = postgresFinanceStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, reason: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await fetchImplementation(
      `${normalizedBaseUrl(environment.SUPABASE_URL)}/rest/v1/${table}${query}`,
      {
        method: "POST",
        headers: financeHeaders(environment, prefer),
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`PostgreSQL finance write gagal (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    return { ok: true, skipped: false };
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? `PostgreSQL finance write timeout setelah ${status.timeoutMs} ms`
      : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.finance_write.failed", table, identity, reason })));
    return { ok: false, skipped: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function readFinanceRows(table, query, identity, options = {}) {
  const environment = options.environment || process.env;
  const fetchImplementation = options.fetchImplementation || fetch;
  const status = postgresFinanceStatus(environment);
  if (!status.available) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await fetchImplementation(`${normalizedBaseUrl(environment.SUPABASE_URL)}/rest/v1/${table}${query}`, {
      method: "GET",
      headers: financeHeaders(environment, "return=representation"),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`PostgreSQL finance read gagal (${response.status})`);
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? `PostgreSQL finance read timeout setelah ${status.timeoutMs} ms`
      : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.finance_read.failed", table, identity, reason })));
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function paymentFromPostgresRow(row) {
  if (!row) return null;
  const providerConnectionRef = row.provider_connection_source ? {
    providerId: row.provider,
    source: row.provider_connection_source,
    connectionId: row.provider_connection_id || null,
    credentialVersion: Number(row.provider_credential_version || 0),
    credentialFingerprint: row.provider_credential_fingerprint || null,
  } : null;
  return {
    id: row.id,
    boothCode: row.booth_code,
    sessionId: row.session_id,
    purpose: row.purpose,
    amount: Number(row.amount),
    currency: row.currency,
    provider: row.provider,
    providerConnectionRef,
    providerPaymentId: row.provider_payment_id,
    providerTransactionId: row.provider_transaction_id || null,
    status: row.status,
    expiresAt: row.checkout_expires_at,
    providerExpiresAt: row.provider_expires_at || null,
    paidAt: row.paid_at || null,
    refundedAt: row.refunded_at || null,
    chargebackAt: row.chargeback_at || null,
    failureCode: row.failure_code || null,
    feeSnapshot: { platformFeeBps: Number(row.platform_fee_bps || 0), platformFee: Number(row.platform_fee || 0) },
    latePayment: Boolean(row.late_payment),
    reviewStatus: row.review_status || "not_required",
    reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by || null,
    reviewNote: row.review_note || null,
    reconciliationState: row.metadata?.reconciliationState || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readPostgresPaymentByProviderId(providerPaymentId, options = {}) {
  const providerId = cleanIdentifier(providerPaymentId, 120);
  if (!providerId) return null;
  const rows = await readFinanceRows(
    "payment_intents",
    `?provider_payment_id=eq.${encodeURIComponent(providerId)}&select=*&limit=1`,
    providerId,
    options,
  );
  return paymentFromPostgresRow(rows[0]);
}

export async function readPostgresPaymentById(paymentId, options = {}) {
  const id = cleanIdentifier(paymentId, 120);
  if (!id) return null;
  const rows = await readFinanceRows(
    "payment_intents",
    `?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    id,
    options,
  );
  return paymentFromPostgresRow(rows[0]);
}

export async function readPostgresChargebackByPaymentId(paymentId, options = {}) {
  const id = cleanIdentifier(paymentId, 120);
  if (!id) return null;
  const rows = await readFinanceRows(
    "payment_chargebacks",
    `?payment_id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    id,
    options,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id, paymentId: row.payment_id, boothCode: row.booth_code, provider: row.provider,
    providerChargebackId: row.provider_chargeback_id, amount: Number(row.amount), currency: row.currency,
    reason: row.reason, status: "confirmed", disputedAt: row.disputed_at,
    recordedBy: row.recorded_by || null, createdAt: row.created_at,
  };
}

function ledgerFromPostgresRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    boothCode: row.booth_code,
    paymentId: row.payment_id,
    type: row.entry_type,
    currency: row.currency,
    gross: Number(row.gross || 0),
    providerFee: row.provider_fee === null || row.provider_fee === undefined ? null : Number(row.provider_fee),
    providerFeeFinal: Boolean(row.provider_fee_final),
    platformFee: Number(row.platform_fee || 0),
    boothEarning: Number(row.booth_earning || 0),
    provider: row.provider,
    providerPaymentId: row.provider_payment_id,
    idempotencyKey: row.idempotency_key,
    latePayment: Boolean(row.metadata?.latePayment),
    providerRefundId: row.metadata?.providerRefundId || null,
    providerChargebackId: row.metadata?.providerChargebackId || null,
    providerFeeReference: row.metadata?.providerFeeReference || null,
    recordedBy: row.metadata?.recordedBy || null,
    adjustmentReference: row.metadata?.adjustmentReference || null,
    adjustmentReason: row.metadata?.adjustmentReason || null,
    createdBy: row.metadata?.createdBy || null,
    createdAt: row.created_at,
  };
}

export async function readPostgresLedgerEntries(boothCodes = [], options = {}) {
  const codes = [...new Set((Array.isArray(boothCodes) ? boothCodes : [boothCodes]).map(value => cleanIdentifier(value, 100)).filter(Boolean))].slice(0, 200);
  if (!codes.length) return [];
  const limit = Math.max(1, Math.min(5_000, Number(options.limit || 1_000)));
  const filter = codes.length === 1
    ? `eq.${encodeURIComponent(codes[0])}`
    : `in.(${codes.map(value => encodeURIComponent(value)).join(",")})`;
  const rows = await readFinanceRows(
    "financial_ledger_entries",
    `?booth_code=${filter}&select=*&order=created_at.desc&limit=${limit}`,
    codes.join(","),
    options,
  );
  return rows.map(ledgerFromPostgresRow).filter(Boolean);
}

export async function writePostgresPaymentIntent(payment, options = {}) {
  if (!payment?.id || !payment?.boothCode || !payment?.providerPaymentId) throw new Error("Payment PostgreSQL tidak lengkap");
  const providerConnectionRef = payment.providerConnectionRef && typeof payment.providerConnectionRef === "object"
    ? payment.providerConnectionRef
    : null;
  const body = {
    id: cleanIdentifier(payment.id, 120),
    booth_code: cleanIdentifier(payment.boothCode, 100),
    session_id: cleanIdentifier(payment.sessionId, 120),
    purpose: cleanIdentifier(payment.purpose, 20),
    amount: Number(payment.amount),
    currency: cleanIdentifier(payment.currency || "IDR", 3),
    provider: cleanIdentifier(payment.provider, 40),
    provider_connection_id: cleanIdentifier(providerConnectionRef?.connectionId, 320) || null,
    provider_connection_source: cleanIdentifier(providerConnectionRef?.source, 40) || null,
    provider_credential_version: providerConnectionRef ? Number(providerConnectionRef.credentialVersion || 0) : null,
    provider_credential_fingerprint: /^[a-f0-9]{64}$/.test(String(providerConnectionRef?.credentialFingerprint || ""))
      ? providerConnectionRef.credentialFingerprint
      : null,
    provider_payment_id: cleanIdentifier(payment.providerPaymentId, 120),
    provider_transaction_id: cleanIdentifier(payment.providerTransactionId, 120) || null,
    status: cleanIdentifier(payment.status, 20),
    checkout_expires_at: payment.expiresAt,
    provider_expires_at: payment.providerExpiresAt || null,
    paid_at: payment.paidAt || null,
    refunded_at: payment.refundedAt || null,
    chargeback_at: payment.chargebackAt || null,
    failure_code: cleanIdentifier(payment.failureCode, 120) || null,
    platform_fee_bps: Number(payment.feeSnapshot?.platformFeeBps || 0),
    platform_fee: Number(payment.feeSnapshot?.platformFee || 0),
    late_payment: Boolean(payment.latePayment),
    review_status: cleanIdentifier(payment.reviewStatus || "not_required", 24),
    reviewed_at: payment.reviewedAt || null,
    reviewed_by: cleanIdentifier(payment.reviewedBy, 120) || null,
    review_note: String(payment.reviewNote || "").slice(0, 500) || null,
    metadata: { source: "photoslive-cloud", reconciliationState: payment.reconciliationState || null },
    created_at: payment.createdAt,
    updated_at: payment.updatedAt,
  };
  return writeFinanceRow("payment_intents", body, "?on_conflict=id", "resolution=merge-duplicates,return=minimal", payment.id, options);
}

export async function writePostgresRefund(refund, options = {}) {
  if (!refund?.id || !refund?.paymentId || !refund?.providerRefundId) throw new Error("Refund PostgreSQL tidak lengkap");
  const body = {
    id: cleanIdentifier(refund.id, 120),
    payment_id: cleanIdentifier(refund.paymentId, 120),
    booth_code: cleanIdentifier(refund.boothCode, 100),
    provider: cleanIdentifier(refund.provider, 40),
    provider_refund_id: cleanIdentifier(refund.providerRefundId, 120),
    amount: Number(refund.amount),
    currency: cleanIdentifier(refund.currency || "IDR", 3),
    reason: cleanIdentifier(refund.reason, 40),
    status: cleanIdentifier(refund.status, 20),
    failure_code: cleanIdentifier(refund.failureCode, 120) || null,
    requested_by: cleanIdentifier(refund.requestedBy || refund.createdBy, 120) || null,
    created_at: refund.createdAt,
    updated_at: refund.updatedAt,
    completed_at: refund.completedAt || null,
  };
  return writeFinanceRow("payment_refunds", body, "?on_conflict=id", "resolution=merge-duplicates,return=minimal", refund.id, options);
}

export async function writePostgresChargeback(chargeback, options = {}) {
  if (!chargeback?.id || !chargeback?.paymentId || !chargeback?.providerChargebackId) throw new Error("Chargeback PostgreSQL tidak lengkap");
  const body = {
    id: cleanIdentifier(chargeback.id, 120),
    payment_id: cleanIdentifier(chargeback.paymentId, 120),
    booth_code: cleanIdentifier(chargeback.boothCode, 100),
    provider: cleanIdentifier(chargeback.provider, 40),
    provider_chargeback_id: cleanIdentifier(chargeback.providerChargebackId, 120),
    amount: Number(chargeback.amount),
    currency: cleanIdentifier(chargeback.currency || "IDR", 3),
    reason: String(chargeback.reason || "").slice(0, 500),
    status: "confirmed",
    disputed_at: chargeback.disputedAt,
    recorded_by: cleanIdentifier(chargeback.recordedBy, 120) || null,
    created_at: chargeback.createdAt,
  };
  return writeFinanceRow("payment_chargebacks", body, "?on_conflict=id", "resolution=ignore-duplicates,return=minimal", chargeback.id, options);
}

export async function appendPostgresLedgerEntry(entry, options = {}) {
  if (!entry?.id || (!entry?.paymentId && !entry?.payoutId) || !entry?.boothCode) throw new Error("Ledger PostgreSQL tidak lengkap");
  const body = {
    id: cleanIdentifier(entry.id, 120),
    booth_code: cleanIdentifier(entry.boothCode, 100),
    payment_id: cleanIdentifier(entry.paymentId, 120) || null,
    payout_id: cleanIdentifier(entry.payoutId, 120) || null,
    entry_type: cleanIdentifier(entry.type, 40),
    currency: cleanIdentifier(entry.currency || "IDR", 3),
    gross: Number(entry.gross || 0),
    provider_fee: entry.providerFee !== null && entry.providerFee !== undefined && Number.isFinite(Number(entry.providerFee))
      ? Number(entry.providerFee)
      : null,
    provider_fee_final: Boolean(entry.providerFeeFinal),
    platform_fee: Number(entry.platformFee || 0),
    booth_earning: Number(entry.boothEarning || 0),
    provider: cleanIdentifier(entry.provider, 40),
    provider_payment_id: cleanIdentifier(entry.providerPaymentId, 120),
    idempotency_key: cleanIdentifier(entry.idempotencyKey || `ledger:${entry.paymentId || entry.payoutId}:${entry.type}`, 180),
    entry_hash: "0".repeat(64),
    metadata: {
      provisional: entry.providerFeeFinal !== true,
      latePayment: Boolean(entry.latePayment),
      providerRefundId: cleanIdentifier(entry.providerRefundId, 120) || null,
      providerChargebackId: cleanIdentifier(entry.providerChargebackId, 120) || null,
      providerFeeReference: cleanIdentifier(entry.providerFeeReference, 120) || null,
      recordedBy: cleanIdentifier(entry.recordedBy, 120) || null,
      adjustmentReference: cleanIdentifier(entry.adjustmentReference, 80) || null,
      adjustmentReason: String(entry.adjustmentReason || "").slice(0, 500) || null,
      createdBy: cleanIdentifier(entry.createdBy, 120) || null,
    },
    created_at: entry.createdAt,
  };
  return writeFinanceRow("financial_ledger_entries", body, "?on_conflict=idempotency_key", "resolution=ignore-duplicates,return=minimal", entry.id, options);
}

export async function writePostgresPayoutPolicy(policy, options = {}) {
  if (!policy?.boothCode) throw new Error("Kebijakan payout PostgreSQL tidak lengkap");
  const body = {
    booth_code: cleanIdentifier(policy.boothCode, 100),
    mode: cleanIdentifier(policy.mode || "disabled", 40),
    minimum_amount: Number(policy.minimumAmount || 10_000),
    created_at: policy.createdAt || new Date().toISOString(),
    updated_at: policy.updatedAt || new Date().toISOString(),
    updated_by: cleanIdentifier(policy.updatedBy, 120) || null,
  };
  return writeFinanceRow("payout_policies", body, "?on_conflict=booth_code", "resolution=merge-duplicates,return=minimal", policy.boothCode, options);
}

export async function writePostgresPayoutAccount(account, options = {}) {
  if (!account?.boothCode || !account?.sealed) throw new Error("Rekening payout PostgreSQL tidak lengkap");
  const body = {
    booth_code: cleanIdentifier(account.boothCode, 100),
    bank_code: cleanIdentifier(account.bankCode, 32),
    account_name: String(account.accountName || "").slice(0, 120),
    account_number_masked: String(account.accountNumberMasked || "").slice(0, 40),
    sealed_account: account.sealed,
    status: cleanIdentifier(account.status || "pending_verification", 30),
    version: Number(account.version || 1),
    verified_at: account.verifiedAt || null,
    verified_by: cleanIdentifier(account.verifiedBy, 120) || null,
    verification_reference: String(account.verificationReference || "").slice(0, 120) || null,
    created_at: account.createdAt || new Date().toISOString(),
    updated_at: account.updatedAt || new Date().toISOString(),
    updated_by: cleanIdentifier(account.updatedBy, 120) || null,
  };
  return writeFinanceRow("payout_accounts", body, "?on_conflict=booth_code", "resolution=merge-duplicates,return=minimal", account.boothCode, options);
}

export async function writePostgresPayout(payout, options = {}) {
  if (!payout?.id || !payout?.boothCode) throw new Error("Payout PostgreSQL tidak lengkap");
  const body = {
    id: cleanIdentifier(payout.id, 120),
    booth_code: cleanIdentifier(payout.boothCode, 100),
    period: cleanIdentifier(payout.period, 32),
    mode: cleanIdentifier(payout.mode || "manual_superadmin", 40),
    currency: cleanIdentifier(payout.currency || "IDR", 3),
    amount: Number(payout.amount || 0),
    status: cleanIdentifier(payout.status, 30),
    account_version: Number(payout.accountVersion || 0),
    account_snapshot: payout.account || {},
    prepared_by: cleanIdentifier(payout.preparedBy, 120) || null,
    approved_by: cleanIdentifier(payout.approvedBy, 120) || null,
    approved_at: payout.approvedAt || null,
    paid_by: cleanIdentifier(payout.paidBy, 120) || null,
    paid_at: payout.paidAt || null,
    transfer_reference: String(payout.transferReference || "").slice(0, 120) || null,
    proof_object_key: String(payout.proofObjectKey || "").slice(0, 500) || null,
    proof_verified_at: payout.proofVerifiedAt || null,
    ledger_entry_id: cleanIdentifier(payout.ledgerEntryId, 120) || null,
    email_delivery_id: cleanIdentifier(payout.emailDeliveryId, 120) || null,
    cancellation_reason: String(payout.cancellationReason || "").slice(0, 500) || null,
    cancelled_at: payout.cancelledAt || null,
    created_at: payout.createdAt || new Date().toISOString(),
    updated_at: payout.updatedAt || new Date().toISOString(),
  };
  return writeFinanceRow("payouts", body, "?on_conflict=id", "resolution=merge-duplicates,return=minimal", payout.id, options);
}

export async function writePostgresReconciliationJob(job, options = {}) {
  if (!job?.paymentId || !job?.boothCode) throw new Error("Reconciliation job PostgreSQL tidak lengkap");
  const body = {
    payment_id: cleanIdentifier(job.paymentId, 120),
    booth_code: cleanIdentifier(job.boothCode, 100),
    status: cleanIdentifier(job.status || "pending", 20),
    reason: cleanIdentifier(job.reason || "provider_pending", 30),
    attempts: Math.max(0, Math.min(100, Number(job.attempts || 0))),
    next_attempt_at: job.nextAttemptAt || new Date().toISOString(),
    last_error: String(job.lastError || "").slice(0, 500) || null,
    last_provider_status: cleanIdentifier(job.lastProviderStatus, 40) || null,
    created_at: job.createdAt || new Date().toISOString(),
    updated_at: job.updatedAt || new Date().toISOString(),
    resolved_at: job.resolvedAt || null,
  };
  return writeFinanceRow("payment_reconciliation_jobs", body, "?on_conflict=payment_id", "resolution=merge-duplicates,return=minimal", job.paymentId, options);
}
