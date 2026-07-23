import QRCode from "qrcode";
import { now, randomId, sha256 } from "./_store.mjs";

const PAYMENT_STATUS = new Set(["pending", "paid", "settled", "expired", "failed", "refunded", "chargeback"]);
const TERMINAL_STATUS = new Set(["paid", "settled", "expired", "failed", "refunded", "chargeback"]);
const REFUND_STATUS = new Set(["pending", "succeeded", "failed", "cancelled"]);
const PAYMENT_TTL_SECONDS = 7 * 24 * 60 * 60;
const PAYMENT_INDEX_LIMIT = 500;
const RECONCILIATION_INDEX_LIMIT = 2_000;
const WEBHOOK_TTL_SECONDS = 30 * 24 * 60 * 60;
const XENDIT_API_VERSION = "2024-11-11";
const XENDIT_API_BASE = "https://api.xendit.co";

const paymentKey = id => `photoslive:payment:${id}`;
const providerPaymentKey = id => `photoslive:payment-provider:xendit:${id}`;
const paymentIntentKey = (boothCode, purpose, sessionId) => `photoslive:booth:${boothCode}:payment-intent:${purpose}:${sessionId}`;
const paymentIndexKey = boothCode => `photoslive:booth:${boothCode}:payments`;
const ledgerKey = id => `photoslive:ledger:${id}`;
const ledgerIndexKey = boothCode => `photoslive:booth:${boothCode}:ledger`;
const reconciliationKey = id => `photoslive:payment-reconciliation:${id}`;
const reconciliationIndexKey = "photoslive:payment-reconciliation:index";
const ledgerReconciliationRunKey = id => `photoslive:ledger-reconciliation-run:${id}`;
const ledgerReconciliationRunIndexKey = "photoslive:ledger-reconciliation-run:index";
const refundKey = id => `photoslive:refund:${id}`;
const refundIntentKey = paymentId => `photoslive:payment:${paymentId}:refund-intent`;
const providerRefundKey = id => `photoslive:refund-provider:xendit:${id}`;
const chargebackKey = id => `photoslive:chargeback:${id}`;
const paymentChargebackKey = paymentId => `photoslive:payment:${paymentId}:chargeback`;
const providerChargebackKey = id => `photoslive:chargeback-provider:xendit:${id}`;

function boundedText(value, maximum = 160) {
  return String(value || "").trim().slice(0, maximum);
}

function normalizePurpose(value) {
  const purpose = String(value || "").toLowerCase();
  if (!new Set(["session", "print"]).has(purpose)) throw new Error("Tujuan pembayaran tidak valid");
  return purpose;
}

function normalizeAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1_000 || amount > 10_000_000) throw new Error("Nominal pembayaran QRIS tidak valid");
  return amount;
}

function normalizeStatus(value) {
  const source = String(value || "").toUpperCase();
  if (source === "SETTLED") return "settled";
  if (source === "SUCCEEDED" || source === "COMPLETED" || source === "PAID") return "paid";
  if (source === "EXPIRED" || source === "CANCELED") return "expired";
  if (source === "FAILED") return "failed";
  return "pending";
}

function normalizeRefundStatus(value) {
  const source = String(value || "").toUpperCase();
  if (source === "SUCCEEDED" || source === "COMPLETED") return "succeeded";
  if (source === "FAILED") return "failed";
  if (source === "CANCELLED" || source === "CANCELED") return "cancelled";
  return "pending";
}

function normalizeRefundReason(value) {
  const reason = String(value || "REQUESTED_BY_CUSTOMER").toUpperCase();
  if (!new Set(["FRAUDULENT", "DUPLICATE", "REQUESTED_BY_CUSTOMER", "CANCELLATION", "OTHERS"]).has(reason)) {
    throw new Error("Alasan refund tidak valid");
  }
  return reason;
}

function normalizeProviderConnectionRef(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) return null;
  const providerId = boundedText(value.providerId, 40).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const source = boundedText(value.source, 40).toLowerCase();
  const connectionId = value.connectionId ? boundedText(value.connectionId, 320) : null;
  const credentialVersion = Number(value.credentialVersion || 0);
  const credentialFingerprint = boundedText(value.credentialFingerprint, 64).toLowerCase();
  if (!providerId || !new Set(["byo", "platform-managed", "deployment-environment"]).has(source)) throw new Error("Referensi koneksi pembayaran tidak valid");
  if (connectionId && (!Number.isSafeInteger(credentialVersion) || credentialVersion < 1)) throw new Error("Versi koneksi pembayaran tidak valid");
  if (!connectionId && source !== "deployment-environment") throw new Error("Identitas koneksi pembayaran tidak lengkap");
  if (credentialFingerprint && !/^[a-f0-9]{64}$/.test(credentialFingerprint)) throw new Error("Fingerprint koneksi pembayaran tidak valid");
  return Object.freeze({ providerId, source, connectionId, credentialVersion: connectionId ? credentialVersion : 0, credentialFingerprint: credentialFingerprint || null });
}

function basicAuthorization(secretKey) {
  return `Basic ${btoa(`${String(secretKey || "")}:`)}`;
}

function xenditEnvironment(environment = process.env) {
  const secretKey = String(environment.XENDIT_SECRET_KEY || "").trim();
  const webhookToken = String(environment.XENDIT_WEBHOOK_TOKEN || "").trim();
  if (!secretKey || !webhookToken) throw new Error("Credential Xendit belum lengkap");
  return { secretKey, webhookToken };
}

async function xenditFetch(path, options = {}) {
  const environment = options.environment || process.env;
  const fetchImplementation = options.fetchImplementation || fetch;
  const { secretKey } = xenditEnvironment(environment);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(15_000, Number(options.timeoutMs || 8_000))));
  try {
    const response = await fetchImplementation(`${XENDIT_API_BASE}${path}`, {
      method: options.method || "GET",
      headers: {
        authorization: basicAuthorization(secretKey),
        "api-version": XENDIT_API_VERSION,
        "content-type": "application/json",
        ...(options.idempotencyKey ? { "idempotency-key": boundedText(options.idempotencyKey, 100) } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = boundedText(payload?.message || payload?.error_code || payload?.error || `Xendit gagal (${response.status})`, 300);
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Xendit terlalu lama merespons. Coba lagi.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function qrStringFromXendit(payload = {}) {
  return boundedText(
    payload.actions?.find(action => action?.descriptor === "QR_STRING" && action?.value)?.value
      || payload.payment_method?.qr_code?.channel_properties?.qr_string
      || payload.qr_string,
    8_000,
  );
}

function providerPaymentId(payload = {}) {
  return boundedText(payload.payment_request_id || payload.id, 120);
}

function validExistingPayment(record) {
  return Boolean(record && record.status === "pending" && Date.parse(record.expiresAt || "") > Date.now() && record.qrString);
}

function providerExpiry(provider, checkoutExpiresAt) {
  const supplied = Date.parse(provider?.expires_at || provider?.expiresAt || "");
  const checkout = Date.parse(checkoutExpiresAt);
  const fallback = Date.now() + 48 * 60 * 60 * 1_000;
  return new Date(Math.max(checkout || 0, Number.isFinite(supplied) ? supplied : fallback)).toISOString();
}

async function pushBounded(redis, key, value, limit = PAYMENT_INDEX_LIMIT) {
  if (typeof redis.pipeline === "function") {
    const pipeline = redis.pipeline();
    pipeline.lpush(key, value);
    pipeline.ltrim(key, 0, limit - 1);
    await pipeline.exec();
    return;
  }
  await redis.lpush(key, value);
  await redis.ltrim(key, 0, limit - 1);
}


async function updateReconciliation(redis, payment, input = {}) {
  const key = reconciliationKey(payment.id);
  const existing = await redis.get(key);
  const record = {
    paymentId: payment.id,
    boothCode: payment.boothCode,
    status: input.status || existing?.status || "pending",
    reason: input.reason || existing?.reason || "provider_pending",
    attempts: Number(input.attempts ?? existing?.attempts ?? 0),
    nextAttemptAt: input.nextAttemptAt || existing?.nextAttemptAt || payment.expiresAt,
    lastError: boundedText(input.lastError ?? existing?.lastError, 500) || null,
    lastProviderStatus: boundedText(input.lastProviderStatus ?? existing?.lastProviderStatus, 40) || null,
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
    resolvedAt: input.resolvedAt ?? existing?.resolvedAt ?? null,
  };
  await redis.set(key, record, { ex: WEBHOOK_TTL_SECONDS });
  if (!existing) await pushBounded(redis, reconciliationIndexKey, payment.id, RECONCILIATION_INDEX_LIMIT);
  return record;
}

async function recordPaymentOutcome(redis, payment) {
  if (payment.status === "paid" || payment.status === "settled") {
    const paidAt = Date.parse(payment.paidAt || "") || Date.now();
    payment.latePayment = paidAt > Date.parse(payment.expiresAt || "");
    payment.reviewStatus = payment.latePayment ? (payment.reviewStatus === "approved" || payment.reviewStatus === "rejected" ? payment.reviewStatus : "pending") : "not_required";
    payment.reconciliationState = payment.latePayment ? "review" : "resolved";
    return updateReconciliation(redis, payment, {
      status: payment.latePayment ? "review" : "resolved",
      reason: payment.latePayment ? "late_payment" : "provider_pending",
      resolvedAt: payment.latePayment ? null : now(),
      nextAttemptAt: payment.providerExpiresAt || payment.expiresAt,
      lastProviderStatus: payment.status,
    });
  }
  if (TERMINAL_STATUS.has(payment.status)) {
    payment.reconciliationState = "resolved";
    return updateReconciliation(redis, payment, { status: "resolved", resolvedAt: now(), lastProviderStatus: payment.status });
  }
  const checkoutExpired = Date.now() > Date.parse(payment.expiresAt || "");
  payment.reconciliationState = "pending";
  return updateReconciliation(redis, payment, {
    status: "pending",
    reason: checkoutExpired ? "checkout_expired" : "provider_pending",
    nextAttemptAt: checkoutExpired ? now() : payment.expiresAt,
    lastProviderStatus: payment.status,
  });
}

export function safePayment(record, options = {}) {
  if (!record) return null;
  const safe = {
    id: record.id,
    boothCode: record.boothCode,
    sessionId: record.sessionId,
    purpose: record.purpose,
    amount: record.amount,
    currency: record.currency,
    provider: record.provider,
    providerPaymentId: record.providerPaymentId,
    status: PAYMENT_STATUS.has(record.status) ? record.status : "failed",
    expiresAt: record.expiresAt,
    paidAt: record.paidAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    failureCode: boundedText(record.failureCode, 120) || null,
    latePayment: Boolean(record.latePayment),
    reviewStatus: boundedText(record.reviewStatus || "not_required", 24),
  };
  if (options.includeQr && record.qrImageUrl && safe.status === "pending") safe.qrImageUrl = record.qrImageUrl;
  return safe;
}

export function safeRefund(record) {
  if (!record) return null;
  return {
    id: record.id,
    paymentId: record.paymentId,
    boothCode: record.boothCode,
    provider: record.provider,
    providerRefundId: record.providerRefundId,
    amount: record.amount,
    currency: record.currency,
    reason: record.reason,
    status: REFUND_STATUS.has(record.status) ? record.status : "failed",
    failureCode: boundedText(record.failureCode, 120) || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt || null,
  };
}

export function safeChargeback(record) {
  if (!record) return null;
  return {
    id: record.id,
    paymentId: record.paymentId,
    boothCode: record.boothCode,
    provider: record.provider,
    providerChargebackId: record.providerChargebackId,
    amount: record.amount,
    currency: record.currency,
    reason: boundedText(record.reason, 500),
    status: "confirmed",
    disputedAt: record.disputedAt,
    createdAt: record.createdAt,
  };
}

export async function createQrisPayment(redis, input = {}, options = {}) {
  const boothCode = boundedText(input.boothCode, 100).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const sessionId = boundedText(input.sessionId, 120).replace(/[^a-zA-Z0-9_-]/g, "");
  const purpose = normalizePurpose(input.purpose);
  const amount = normalizeAmount(input.amount);
  const currency = String(input.currency || "IDR").toUpperCase();
  if (!boothCode || !sessionId) throw new Error("Identitas pembayaran tidak lengkap");
  if (currency !== "IDR") throw new Error("Photoslive v1 hanya mendukung pembayaran IDR");
  const providerConnectionRef = normalizeProviderConnectionRef(input.providerConnectionRef);
  if (providerConnectionRef && providerConnectionRef.providerId !== "xendit") throw new Error("Provider QRIS transaksi tidak valid");

  const intentKey = paymentIntentKey(boothCode, purpose, sessionId);
  const existingId = await redis.get(intentKey);
  const existing = existingId ? await redis.get(paymentKey(existingId)) : null;
  if (validExistingPayment(existing)) return { payment: safePayment(existing, { includeQr: true }), reused: true };

  const lockKey = `${intentKey}:lock`;
  const locked = await redis.set(lockKey, "1", { nx: true, ex: 15 });
  if (!locked) throw Object.assign(new Error("Pembayaran sedang dibuat. Coba lagi sebentar."), { status: 409 });
  try {
    const paymentId = randomId("pay");
    const expiresAt = new Date(Date.now() + Math.max(2, Math.min(30, Number(input.expiryMinutes || 10))) * 60_000).toISOString();
    const configuredFeeBps = input.platformFeeBps ?? options.environment?.PHOTOSLIVE_PLATFORM_FEE_BPS ?? process.env.PHOTOSLIVE_PLATFORM_FEE_BPS ?? 0;
    const feeBps = Math.max(0, Math.min(10_000, Number(configuredFeeBps) || 0));
    const requestPayload = {
      reference_id: paymentId,
      type: "PAY",
      country: "ID",
      currency,
      request_amount: amount,
      capture_method: "AUTOMATIC",
      channel_code: "QRIS",
      channel_properties: { qr_string_type: "DYNAMIC" },
      description: purpose === "print" ? "Cetak foto Photoslive" : "Sesi photobox Photoslive",
      metadata: { payment_id: paymentId, booth_code: boothCode, session_id: sessionId, purpose },
    };
    const provider = await xenditFetch("/v3/payment_requests", {
      method: "POST",
      body: requestPayload,
      idempotencyKey: input.idempotencyKey || paymentId,
      environment: options.environment,
      fetchImplementation: options.fetchImplementation,
    });
    const providerId = providerPaymentId(provider);
    const qrString = qrStringFromXendit(provider);
    if (!providerId || !qrString) throw new Error("Xendit tidak mengembalikan QRIS yang dapat ditampilkan");
    const record = {
      id: paymentId,
      boothCode,
      sessionId,
      purpose,
      amount,
      currency,
      provider: "xendit",
      providerConnectionRef,
      providerPaymentId: providerId,
      status: normalizeStatus(provider.status),
      qrString,
      qrImageUrl: await QRCode.toDataURL(qrString, { errorCorrectionLevel: "M", margin: 2, width: 360 }),
      expiresAt,
      providerExpiresAt: providerExpiry(provider, expiresAt),
      paidAt: null,
      failureCode: boundedText(provider.failure_code, 120) || null,
      feeSnapshot: { platformFeeBps: feeBps, platformFee: Math.floor(amount * feeBps / 10_000) },
      latePayment: false,
      reviewStatus: "not_required",
      reconciliationState: "pending",
      lastProviderCheckAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };
    await redis.set(paymentKey(record.id), record, { ex: PAYMENT_TTL_SECONDS });
    await redis.set(providerPaymentKey(providerId), record.id, { ex: PAYMENT_TTL_SECONDS });
    await redis.set(intentKey, record.id, { ex: Math.max(60, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1_000)) });
    await pushBounded(redis, paymentIndexKey(boothCode), record.id);
    await recordPaymentOutcome(redis, record);
    return { payment: safePayment(record, { includeQr: true }), reused: false, record };
  } finally {
    await redis.del(lockKey);
  }
}

export async function getPayment(redis, id) {
  return redis.get(paymentKey(boundedText(id, 120)));
}

export async function listPayments(redis, boothCode, limit = 100) {
  const boundedLimit = Math.max(1, Math.min(PAYMENT_INDEX_LIMIT, Number(limit || 100)));
  const ids = await redis.lrange(paymentIndexKey(boundedText(boothCode, 100)), 0, boundedLimit - 1);
  const records = await Promise.all([...new Set(ids)].map(id => redis.get(paymentKey(id))));
  return records.filter(Boolean).map(record => safePayment(record));
}

export async function getRefund(redis, id) {
  return redis.get(refundKey(boundedText(id, 120)));
}

export async function getPaymentLedgerEntry(redis, id) {
  return redis.get(ledgerKey(boundedText(id, 120)));
}

export async function getPaymentReconciliation(redis, id) {
  return redis.get(reconciliationKey(boundedText(id, 120)));
}

export async function listPaymentReconciliation(redis, options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit || 100)));
  const status = boundedText(options.status, 24);
  const boothCode = boundedText(options.boothCode, 100);
  const ids = [...new Set(await redis.lrange(reconciliationIndexKey, 0, Math.max(limit * 4, limit) - 1))];
  const records = [];
  for (const id of ids) {
    if (records.length >= limit) break;
    const [payment, reconciliation] = await Promise.all([getPayment(redis, id), getPaymentReconciliation(redis, id)]);
    if (!payment || !reconciliation) continue;
    if (status && reconciliation.status !== status) continue;
    if (boothCode && payment.boothCode !== boothCode) continue;
    records.push({ payment: safePayment(payment), reconciliation });
  }
  return records;
}

export async function reviewLatePayment(redis, input = {}) {
  const paymentId = boundedText(input.paymentId, 120);
  const decision = boundedText(input.decision, 24).toLowerCase();
  const reviewerId = boundedText(input.reviewerId, 120);
  const note = boundedText(input.note, 500) || null;
  if (!paymentId || !new Set(["approved", "rejected"]).has(decision)) throw new Error("Keputusan review pembayaran tidak valid");
  const lockKey = `photoslive:payment:${paymentId}:review-lock`;
  const locked = await redis.set(lockKey, reviewerId || "finance-review", { nx: true, ex: 15 });
  if (!locked) throw Object.assign(new Error("Pembayaran sedang direview. Coba lagi sebentar."), { status: 409 });
  try {
    const [payment, reconciliation] = await Promise.all([getPayment(redis, paymentId), getPaymentReconciliation(redis, paymentId)]);
    if (!payment || !reconciliation) throw Object.assign(new Error("Pembayaran review tidak ditemukan"), { status: 404 });
    if (payment.reviewStatus === "approved" || payment.reviewStatus === "rejected") {
      if (payment.reviewStatus !== decision) throw Object.assign(new Error("Review pembayaran sudah memiliki keputusan berbeda"), { status: 409 });
      return { payment, reconciliation, reused: true };
    }
    if (!payment.latePayment || reconciliation.status !== "review") throw Object.assign(new Error("Pembayaran ini tidak memerlukan review"), { status: 409 });
    const reviewedAt = now();
    payment.reviewStatus = decision;
    payment.reviewedAt = reviewedAt;
    payment.reviewedBy = reviewerId || "finance-review";
    payment.reviewNote = note;
    payment.updatedAt = reviewedAt;
    const nextReconciliation = await updateReconciliation(redis, payment, {
      status: "resolved",
      reason: "manual",
      resolvedAt: reviewedAt,
      lastProviderStatus: payment.status,
    });
    nextReconciliation.reviewDecision = decision;
    nextReconciliation.reviewedAt = reviewedAt;
    nextReconciliation.reviewedBy = payment.reviewedBy;
    nextReconciliation.reviewNote = note;
    await Promise.all([
      redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS }),
      redis.set(reconciliationKey(payment.id), nextReconciliation, { ex: WEBHOOK_TTL_SECONDS }),
    ]);
    return { payment, reconciliation: nextReconciliation, reused: false };
  } finally {
    await redis.del(lockKey);
  }
}

export async function refreshQrisPayment(redis, id, options = {}) {
  const record = await getPayment(redis, id);
  if (!record) return null;
  if (TERMINAL_STATUS.has(record.status)) return record;
  const lastChecked = Date.parse(record.lastProviderCheckAt || "") || 0;
  if (!options.force && Date.now() - lastChecked < 3_000) return record;
  const provider = await xenditFetch(`/v3/payment_requests/${encodeURIComponent(record.providerPaymentId)}`, {
    environment: options.environment,
    fetchImplementation: options.fetchImplementation,
  });
  const nextStatus = normalizeStatus(provider.status);
  record.lastProviderCheckAt = now();
  record.updatedAt = now();
  record.failureCode = boundedText(provider.failure_code, 120) || record.failureCode || null;
  if (record.status !== "paid" && record.status !== "settled") record.status = nextStatus;
  if ((nextStatus === "paid" || nextStatus === "settled") && !record.paidAt) record.paidAt = now();
  await recordPaymentOutcome(redis, record);
  if (nextStatus === "paid" || nextStatus === "settled") {
    const ledger = await appendSettlementLedger(redis, record);
    record.settlementLedgerId = ledger?.id || record.settlementLedgerId || null;
  }
  await redis.set(paymentKey(record.id), record, { ex: PAYMENT_TTL_SECONDS });
  return record;
}

export async function probeXendit(options = {}) {
  const startedAt = performance.now();
  try {
    const payload = await xenditFetch("/balance?account_type=CASH&currency=IDR", {
      environment: options.environment,
      fetchImplementation: options.fetchImplementation,
      timeoutMs: options.timeoutMs || 3_000,
    });
    if (!Number.isFinite(Number(payload.balance))) throw new Error("Xendit tidak mengembalikan status akun yang valid");
    return {
      provider: "xendit",
      state: "ready",
      latencyMs: Number((performance.now() - startedAt).toFixed(1)),
      message: "Credential Xendit valid dan endpoint pembayaran dapat dijangkau",
      checkedAt: now(),
    };
  } catch (error) {
    return {
      provider: "xendit",
      state: "error",
      latencyMs: Number((performance.now() - startedAt).toFixed(1)),
      message: boundedText(error instanceof Error ? error.message : "Xendit tidak dapat dijangkau", 240),
      checkedAt: now(),
    };
  }
}

async function constantTimeTokenMatch(supplied, expected) {
  if (!supplied || !expected) return false;
  const [left, right] = await Promise.all([sha256(String(supplied)), sha256(String(expected))]);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function appendSettlementLedger(redis, payment) {
  const existingId = await redis.get(`photoslive:payment:${payment.id}:settlement-ledger`);
  if (existingId) return redis.get(ledgerKey(existingId));
  const platformFee = Math.max(0, Math.min(payment.amount, Number(payment.feeSnapshot?.platformFee || 0)));
  const entry = Object.freeze({
    id: randomId("ledger"),
    boothCode: payment.boothCode,
    paymentId: payment.id,
    type: "payment_captured",
    currency: payment.currency,
    gross: payment.amount,
    providerFee: null,
    providerFeeFinal: false,
    platformFee,
    boothEarning: payment.amount - platformFee,
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    idempotencyKey: `ledger:${payment.id}:payment_captured`,
    latePayment: Boolean(payment.latePayment),
    createdAt: now(),
  });
  const claimed = await redis.set(`photoslive:payment:${payment.id}:settlement-ledger`, entry.id, { nx: true, ex: PAYMENT_TTL_SECONDS });
  if (!claimed) return redis.get(ledgerKey(await redis.get(`photoslive:payment:${payment.id}:settlement-ledger`)));
  await redis.set(ledgerKey(entry.id), entry, { ex: PAYMENT_TTL_SECONDS });
  await pushBounded(redis, ledgerIndexKey(payment.boothCode), entry.id);
  return entry;
}

async function appendRefundLedger(redis, payment, refund) {
  const markerKey = `photoslive:refund:${refund.id}:ledger`;
  const existingId = await redis.get(markerKey);
  if (existingId) return redis.get(ledgerKey(existingId));
  const originalPlatformFee = Math.max(0, Math.min(payment.amount, Number(payment.feeSnapshot?.platformFee || 0)));
  const entry = Object.freeze({
    id: randomId("ledger"),
    boothCode: payment.boothCode,
    paymentId: payment.id,
    type: "refund",
    currency: payment.currency,
    gross: -refund.amount,
    providerFee: null,
    providerFeeFinal: false,
    platformFee: -originalPlatformFee,
    boothEarning: -(payment.amount - originalPlatformFee),
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    providerRefundId: refund.providerRefundId,
    idempotencyKey: `ledger:${payment.id}:refund:${refund.providerRefundId}`,
    latePayment: Boolean(payment.latePayment),
    createdAt: now(),
  });
  const claimed = await redis.set(markerKey, entry.id, { nx: true, ex: WEBHOOK_TTL_SECONDS });
  if (!claimed) return redis.get(ledgerKey(await redis.get(markerKey)));
  await redis.set(ledgerKey(entry.id), entry, { ex: PAYMENT_TTL_SECONDS });
  await pushBounded(redis, ledgerIndexKey(payment.boothCode), entry.id);
  return entry;
}

async function appendChargebackLedger(redis, payment, chargeback) {
  const markerKey = `photoslive:chargeback:${chargeback.id}:ledger`;
  const existingId = await redis.get(markerKey);
  if (existingId) return redis.get(ledgerKey(existingId));
  const originalPlatformFee = Math.max(0, Math.min(payment.amount, Number(payment.feeSnapshot?.platformFee || 0)));
  const entry = Object.freeze({
    id: randomId("ledger"),
    boothCode: payment.boothCode,
    paymentId: payment.id,
    type: "chargeback",
    currency: payment.currency,
    gross: -payment.amount,
    providerFee: null,
    providerFeeFinal: false,
    platformFee: -originalPlatformFee,
    boothEarning: -(payment.amount - originalPlatformFee),
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    providerChargebackId: chargeback.providerChargebackId,
    idempotencyKey: `ledger:${payment.id}:chargeback:${chargeback.providerChargebackId}`,
    latePayment: Boolean(payment.latePayment),
    createdAt: now(),
  });
  const claimed = await redis.set(markerKey, entry.id, { nx: true, ex: WEBHOOK_TTL_SECONDS });
  if (!claimed) return redis.get(ledgerKey(await redis.get(markerKey)));
  await redis.set(ledgerKey(entry.id), entry, { ex: PAYMENT_TTL_SECONDS });
  await pushBounded(redis, ledgerIndexKey(payment.boothCode), entry.id);
  return entry;
}

export async function createLedgerAdjustment(redis, input = {}, options = {}) {
  const paymentId = boundedText(input.paymentId, 120);
  const reference = boundedText(input.reference, 80).replace(/[^a-zA-Z0-9._:-]/g, "-");
  const reason = boundedText(input.reason, 500);
  const amount = Number(input.amount);
  const createdBy = boundedText(input.createdBy, 120) || "finance-adjustment";
  if (!paymentId || !reference || !reason) throw new Error("Data koreksi ledger belum lengkap");
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 10_000_000) throw new Error("Nominal koreksi ledger tidak valid");

  let payment = await getPayment(redis, paymentId);
  if (!payment && options.paymentResolver) payment = await options.paymentResolver(paymentId);
  if (!payment) throw Object.assign(new Error("Pembayaran koreksi tidak ditemukan"), { status: 404 });
  if (!new Set(["paid", "settled", "refunded", "chargeback"]).has(payment.status)) {
    throw Object.assign(new Error("Koreksi hanya dapat dibuat untuk pembayaran berhasil"), { status: 409 });
  }

  const markerKey = `photoslive:payment:${payment.id}:adjustment:${reference}`;
  const existingId = await redis.get(markerKey);
  if (existingId) {
    const existing = await getPaymentLedgerEntry(redis, existingId);
    if (existing) {
      if (existing.boothEarning !== amount || existing.adjustmentReason !== reason) {
        throw Object.assign(new Error("Referensi koreksi sudah digunakan dengan data berbeda"), { status: 409 });
      }
      return { payment, ledger: existing, reused: true };
    }
  }

  const entry = Object.freeze({
    id: randomId("ledger"),
    boothCode: payment.boothCode,
    paymentId: payment.id,
    type: "adjustment",
    currency: payment.currency,
    gross: 0,
    providerFee: null,
    providerFeeFinal: false,
    platformFee: 0,
    boothEarning: amount,
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    adjustmentReference: reference,
    adjustmentReason: reason,
    createdBy,
    idempotencyKey: `ledger:${payment.id}:adjustment:${reference}`,
    latePayment: Boolean(payment.latePayment),
    createdAt: now(),
  });
  const claimed = await redis.set(markerKey, entry.id, { nx: true, ex: WEBHOOK_TTL_SECONDS });
  if (!claimed) {
    const claimedId = await redis.get(markerKey);
    const existing = claimedId ? await getPaymentLedgerEntry(redis, claimedId) : null;
    if (existing) return { payment, ledger: existing, reused: true };
    throw Object.assign(new Error("Koreksi sedang diproses. Coba lagi."), { status: 409 });
  }
  await redis.set(ledgerKey(entry.id), entry, { ex: PAYMENT_TTL_SECONDS });
  await pushBounded(redis, ledgerIndexKey(payment.boothCode), entry.id);
  return { payment, ledger: entry, reused: false };
}

export async function recordProviderFee(redis, input = {}, options = {}) {
  const paymentId = boundedText(input.paymentId, 120);
  const reference = boundedText(input.reference, 120).replace(/[^a-zA-Z0-9._:-]/g, "-");
  const amount = Number(input.amount);
  const recordedBy = boundedText(input.recordedBy, 120) || "finance-provider-fee";
  if (!paymentId || !reference) throw new Error("ID pembayaran dan referensi biaya provider wajib diisi");
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 10_000_000) throw new Error("Biaya provider harus berupa nominal IDR yang valid");

  let payment = await getPayment(redis, paymentId);
  if (!payment && options.paymentResolver) payment = await options.paymentResolver(paymentId);
  if (!payment) throw Object.assign(new Error("Pembayaran biaya provider tidak ditemukan"), { status: 404 });
  if (!new Set(["paid", "settled", "refunded", "chargeback"]).has(payment.status)) {
    throw Object.assign(new Error("Biaya provider hanya dapat difinalisasi untuk pembayaran berhasil"), { status: 409 });
  }

  const markerKey = `photoslive:payment:${payment.id}:provider-fee-ledger`;
  const existingId = await redis.get(markerKey);
  if (existingId) {
    const existing = await getPaymentLedgerEntry(redis, existingId);
    if (existing) {
      if (existing.providerFee !== amount || existing.providerFeeReference !== reference) {
        throw Object.assign(new Error("Biaya provider sudah difinalisasi dengan data berbeda"), { status: 409 });
      }
      return { payment, ledger: existing, reused: true };
    }
  }

  const entry = Object.freeze({
    id: randomId("ledger"),
    boothCode: payment.boothCode,
    paymentId: payment.id,
    type: "provider_fee",
    currency: payment.currency,
    gross: 0,
    providerFee: amount,
    providerFeeFinal: true,
    platformFee: 0,
    boothEarning: -amount,
    provider: payment.provider,
    providerPaymentId: payment.providerPaymentId,
    providerFeeReference: reference,
    recordedBy,
    idempotencyKey: `ledger:${payment.id}:provider_fee`,
    latePayment: Boolean(payment.latePayment),
    createdAt: now(),
  });
  const claimed = await redis.set(markerKey, entry.id, { nx: true, ex: WEBHOOK_TTL_SECONDS });
  if (!claimed) {
    const claimedId = await redis.get(markerKey);
    const existing = claimedId ? await getPaymentLedgerEntry(redis, claimedId) : null;
    if (existing) return { payment, ledger: existing, reused: true };
    throw Object.assign(new Error("Finalisasi biaya provider sedang diproses. Coba lagi."), { status: 409 });
  }
  await redis.set(ledgerKey(entry.id), entry, { ex: PAYMENT_TTL_SECONDS });
  await pushBounded(redis, ledgerIndexKey(payment.boothCode), entry.id);
  return { payment, ledger: entry, reused: false };
}

export async function recordManualChargeback(redis, input = {}, options = {}) {
  const paymentId = boundedText(input.paymentId, 120);
  const providerChargebackId = boundedText(input.providerChargebackId, 120);
  const reason = boundedText(input.reason, 500);
  const disputedAtValue = Date.parse(input.disputedAt || "");
  if (!paymentId || !providerChargebackId || !reason) throw new Error("Data chargeback belum lengkap");
  if (!Number.isFinite(disputedAtValue) || disputedAtValue > Date.now() + 5 * 60_000) throw new Error("Waktu chargeback tidak valid");

  let payment = await getPayment(redis, paymentId);
  if (!payment && options.paymentResolver) payment = await options.paymentResolver(paymentId);
  if (!payment) throw Object.assign(new Error("Pembayaran chargeback tidak ditemukan"), { status: 404 });
  if (!new Set(["paid", "settled", "chargeback"]).has(payment.status)) {
    throw Object.assign(new Error("Hanya pembayaran berhasil yang dapat ditandai chargeback"), { status: 409 });
  }

  const existingId = await redis.get(paymentChargebackKey(payment.id)) || await redis.get(providerChargebackKey(providerChargebackId));
  let existing = existingId ? await redis.get(chargebackKey(existingId)) : null;
  if (!existing && options.chargebackResolver) existing = await options.chargebackResolver(payment.id);
  if (existing) {
    if (existing.paymentId !== payment.id || existing.providerChargebackId !== providerChargebackId) {
      throw Object.assign(new Error("Referensi chargeback sudah digunakan"), { status: 409 });
    }
    const ledger = payment.chargebackLedgerId ? await getPaymentLedgerEntry(redis, payment.chargebackLedgerId) : await appendChargebackLedger(redis, payment, existing);
    await Promise.all([
      redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS }),
      redis.set(providerPaymentKey(payment.providerPaymentId), payment.id, { ex: PAYMENT_TTL_SECONDS }),
      redis.set(chargebackKey(existing.id), existing, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(paymentChargebackKey(payment.id), existing.id, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(providerChargebackKey(providerChargebackId), existing.id, { ex: WEBHOOK_TTL_SECONDS }),
    ]);
    return { chargeback: safeChargeback(existing), record: existing, payment, ledger, reused: true };
  }

  const lockKey = `${paymentChargebackKey(payment.id)}:lock`;
  const locked = await redis.set(lockKey, "1", { nx: true, ex: 15 });
  if (!locked) throw Object.assign(new Error("Chargeback sedang dicatat. Coba lagi sebentar."), { status: 409 });
  try {
    const record = Object.freeze({
      id: randomId("chargeback"), paymentId: payment.id, boothCode: payment.boothCode,
      provider: payment.provider, providerChargebackId, amount: payment.amount, currency: payment.currency,
      reason, status: "confirmed", disputedAt: new Date(disputedAtValue).toISOString(),
      recordedBy: boundedText(input.recordedBy, 120) || null, createdAt: now(),
    });
    payment.status = "chargeback";
    payment.chargebackId = record.id;
    payment.chargebackAt = record.disputedAt;
    payment.updatedAt = now();
    const ledger = await appendChargebackLedger(redis, payment, record);
    payment.chargebackLedgerId = ledger?.id || null;
    await Promise.all([
      redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS }),
      redis.set(providerPaymentKey(payment.providerPaymentId), payment.id, { ex: PAYMENT_TTL_SECONDS }),
      redis.set(chargebackKey(record.id), record, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(paymentChargebackKey(payment.id), record.id, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(providerChargebackKey(providerChargebackId), record.id, { ex: WEBHOOK_TTL_SECONDS }),
      recordPaymentOutcome(redis, payment),
    ]);
    return { chargeback: safeChargeback(record), record, payment, ledger, reused: false };
  } finally {
    await redis.del(lockKey);
  }
}

export async function createXenditRefund(redis, input = {}, options = {}) {
  const paymentId = boundedText(input.paymentId, 120);
  let payment = await getPayment(redis, paymentId);
  if (!payment && options.paymentResolver) {
    payment = await options.paymentResolver(paymentId);
    if (payment) {
      await Promise.all([
        redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS }),
        redis.set(providerPaymentKey(payment.providerPaymentId), payment.id, { ex: PAYMENT_TTL_SECONDS }),
      ]);
    }
  }
  if (!payment) throw Object.assign(new Error("Pembayaran refund tidak ditemukan"), { status: 404 });
  if (!new Set(["paid", "settled"]).has(payment.status)) {
    if (payment.status === "refunded") {
      const existingId = await redis.get(refundIntentKey(payment.id));
      const existing = existingId ? await getRefund(redis, existingId) : null;
      if (existing) return { refund: safeRefund(existing), record: existing, payment, reused: true };
    }
    throw Object.assign(new Error("Hanya pembayaran berhasil yang dapat direfund"), { status: 409 });
  }
  const amount = Number(input.amount || payment.amount);
  if (amount !== payment.amount) throw new Error("Photoslive v1 hanya mendukung refund penuh");
  const reason = normalizeRefundReason(input.reason);
  const existingId = await redis.get(refundIntentKey(payment.id));
  const existing = existingId ? await getRefund(redis, existingId) : null;
  if (existing && new Set(["pending", "succeeded"]).has(existing.status)) {
    return { refund: safeRefund(existing), record: existing, payment, reused: true };
  }
  const lockKey = `${refundIntentKey(payment.id)}:lock`;
  const locked = await redis.set(lockKey, "1", { nx: true, ex: 20 });
  if (!locked) throw Object.assign(new Error("Refund sedang diproses. Coba lagi sebentar."), { status: 409 });
  try {
    const id = randomId("refund");
    const provider = await xenditFetch("/refunds", {
      method: "POST",
      body: {
        reference_id: id,
        payment_request_id: payment.providerPaymentId,
        currency: payment.currency,
        amount,
        reason,
        metadata: { payment_id: payment.id, booth_code: payment.boothCode },
      },
      environment: options.environment,
      fetchImplementation: options.fetchImplementation,
    });
    const providerRefundId = boundedText(provider.id, 120);
    if (!providerRefundId) throw new Error("Xendit tidak mengembalikan identitas refund");
    const record = {
      id,
      paymentId: payment.id,
      boothCode: payment.boothCode,
      provider: payment.provider,
      providerConnectionRef: payment.providerConnectionRef || null,
      providerPaymentId: payment.providerPaymentId,
      providerRefundId,
      amount,
      currency: payment.currency,
      reason,
      status: normalizeRefundStatus(provider.status),
      failureCode: boundedText(provider.failure_code, 120) || null,
      createdBy: boundedText(input.requestedBy, 120) || null,
      createdAt: now(),
      updatedAt: now(),
      completedAt: null,
    };
    await Promise.all([
      redis.set(refundKey(record.id), record, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(refundIntentKey(payment.id), record.id, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(providerRefundKey(providerRefundId), record.id, { ex: WEBHOOK_TTL_SECONDS }),
    ]);
    return { refund: safeRefund(record), record, payment, reused: false };
  } finally {
    await redis.del(lockKey);
  }
}

export async function processXenditWebhook(redis, request, payload = {}, options = {}) {
  const providerId = boundedText(payload?.data?.payment_request_id || payload?.payment_request_id, 120);
  if (!providerId) throw Object.assign(new Error("Webhook tidak memiliki payment_request_id"), { status: 400 });
  let paymentId = await redis.get(providerPaymentKey(providerId));
  let payment = paymentId ? await getPayment(redis, paymentId) : null;
  if (!payment && options.paymentResolver) {
    payment = await options.paymentResolver(providerId);
    paymentId = payment?.id || null;
    if (payment) {
      await Promise.all([
        redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS }),
        redis.set(providerPaymentKey(providerId), payment.id, { ex: PAYMENT_TTL_SECONDS }),
      ]);
    }
  }
  if (!payment) throw Object.assign(new Error("Pembayaran tidak ditemukan"), { status: 404 });
  const runtime = await options.runtimeResolver({ boothCode: payment.boothCode, providerId: payment.provider, providerConnectionRef: payment.providerConnectionRef || null });
  const expected = xenditEnvironment(runtime?.environment || {}).webhookToken;
  if (!await constantTimeTokenMatch(request.headers.get("x-callback-token"), expected)) throw Object.assign(new Error("Signature webhook tidak valid"), { status: 401 });

  const event = String(payload.event || "").toLowerCase();
  if (!new Set(["payment.capture", "payment.failure", "payment.expiry", "refund.succeeded", "refund.failed"]).has(event)) {
    throw Object.assign(new Error("Jenis webhook pembayaran tidak didukung"), { status: 400 });
  }
  const incomingStatus = normalizeStatus(payload?.data?.status || (event.includes("expiry") ? "EXPIRED" : event.includes("failure") ? "FAILED" : ""));
  const paid = event === "payment.capture" && (incomingStatus === "paid" || incomingStatus === "settled");
  const refundEvent = event.startsWith("refund.");
  const amount = Number(payload?.data?.request_amount || payment.amount);
  const currency = String(payload?.data?.currency || payment.currency).toUpperCase();
  if (paid && (amount !== payment.amount || currency !== payment.currency)) throw Object.assign(new Error("Nominal webhook tidak sesuai payment intent"), { status: 409 });
  if (refundEvent && (Number(payload?.data?.amount) !== payment.amount || currency !== payment.currency)) {
    throw Object.assign(new Error("Nominal webhook refund tidak sesuai payment intent"), { status: 409 });
  }
  const providerRefundId = refundEvent ? boundedText(payload?.data?.id, 120) : null;
  if (refundEvent && !providerRefundId) throw Object.assign(new Error("Webhook refund tidak memiliki refund id"), { status: 400 });

  const eventId = boundedText(request.headers.get("webhook-id"), 180) || await sha256(JSON.stringify(payload));
  const deliveryKey = `photoslive:webhook:xendit:${eventId}`;
  const firstDelivery = await redis.set(deliveryKey, { receivedAt: now(), paymentId: payment.id }, { nx: true, ex: WEBHOOK_TTL_SECONDS });
  if (!firstDelivery) return { payment: safePayment(payment), record: payment, duplicate: true, ledger: null };

  if (refundEvent) {
    const storedRefundId = await redis.get(providerRefundKey(providerRefundId));
    let refund = storedRefundId ? await getRefund(redis, storedRefundId) : null;
    if (!refund) {
      refund = {
        id: randomId("refund"), paymentId: payment.id, boothCode: payment.boothCode, provider: payment.provider,
        providerConnectionRef: payment.providerConnectionRef || null, providerPaymentId: payment.providerPaymentId,
        providerRefundId, amount: payment.amount, currency: payment.currency,
        reason: normalizeRefundReason(payload?.data?.reason || "OTHERS"), status: "pending",
        failureCode: null, createdBy: "provider", createdAt: boundedText(payload.created, 60) || now(), updatedAt: now(), completedAt: null,
      };
    }
    const nextRefundStatus = event === "refund.succeeded" ? "succeeded" : "failed";
    if (new Set(["succeeded", "failed"]).has(refund.status)) {
      if (refund.status !== nextRefundStatus) {
        throw Object.assign(new Error("Status refund final tidak boleh berubah"), { status: 409 });
      }
      return {
        payment: safePayment(payment), record: payment, previousStatus: payment.status, duplicate: true,
        ledger: payment.refundLedgerId ? await getPaymentLedgerEntry(redis, payment.refundLedgerId) : null,
        refund: safeRefund(refund), refundRecord: refund,
      };
    }
    const previousStatus = payment.status;
    refund.status = nextRefundStatus;
    refund.failureCode = boundedText(payload?.data?.failure_code, 120) || null;
    refund.updatedAt = now();
    refund.completedAt = now();
    let ledger = null;
    if (refund.status === "succeeded") {
      payment.status = "refunded";
      payment.refundedAt = refund.completedAt;
      payment.refundId = refund.id;
      ledger = await appendRefundLedger(redis, payment, refund);
      payment.refundLedgerId = ledger?.id || payment.refundLedgerId || null;
    }
    payment.updatedAt = now();
    await recordPaymentOutcome(redis, payment);
    await Promise.all([
      redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS }),
      redis.set(refundKey(refund.id), refund, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(refundIntentKey(payment.id), refund.id, { ex: WEBHOOK_TTL_SECONDS }),
      redis.set(providerRefundKey(providerRefundId), refund.id, { ex: WEBHOOK_TTL_SECONDS }),
    ]);
    return { payment: safePayment(payment), record: payment, previousStatus, duplicate: false, ledger, refund: safeRefund(refund), refundRecord: refund };
  }

  const previousStatus = payment.status;
  if (!new Set(["paid", "settled", "refunded", "chargeback"]).has(previousStatus)) payment.status = incomingStatus;
  if (paid && !payment.paidAt) payment.paidAt = boundedText(payload.created, 60) || now();
  payment.providerTransactionId = boundedText(payload?.data?.payment_id, 120) || payment.providerTransactionId || null;
  payment.failureCode = boundedText(payload?.data?.failure_code, 120) || payment.failureCode || null;
  payment.updatedAt = now();
  await recordPaymentOutcome(redis, payment);
  await redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS });
  const ledger = paid ? await appendSettlementLedger(redis, payment) : null;
  if (ledger) {
    payment.settlementLedgerId = ledger.id;
    await redis.set(paymentKey(payment.id), payment, { ex: PAYMENT_TTL_SECONDS });
  }
  return { payment: safePayment(payment), record: payment, previousStatus, duplicate: false, ledger };
}

export async function listPaymentLedger(redis, boothCode, limit = 100) {
  const ids = await redis.lrange(ledgerIndexKey(boundedText(boothCode, 100)), 0, Math.max(0, Math.min(500, Number(limit || 100)) - 1));
  const records = await Promise.all(ids.map(id => redis.get(ledgerKey(id))));
  return records.filter(Boolean);
}

export function summarizeLedgerBalance(records = [], options = {}) {
  const currency = boundedText(options.currency || "IDR", 3).toUpperCase() || "IDR";
  const unique = new Map();
  for (const entry of Array.isArray(records) ? records : []) {
    if (!entry?.id || boundedText(entry.currency || "IDR", 3).toUpperCase() !== currency) continue;
    if (!unique.has(entry.id)) unique.set(entry.id, entry);
  }
  const finalizedProviderFeePayments = new Set([...unique.values()]
    .filter(entry => entry.type === "provider_fee" && entry.providerFeeFinal === true && entry.paymentId)
    .map(entry => entry.paymentId));
  const summary = {
    currency,
    pendingBalance: 0,
    availableBalance: 0,
    totalBalance: 0,
    gross: 0,
    platformFee: 0,
    providerFee: 0,
    entryCount: 0,
    provisionalEntryCount: 0,
    latestEntryAt: null,
  };
  for (const entry of unique.values()) {
    const boothEarning = Number(entry.boothEarning || 0);
    const gross = Number(entry.gross || 0);
    const platformFee = Number(entry.platformFee || 0);
    const providerFee = Number(entry.providerFee || 0);
    if (![boothEarning, gross, platformFee, providerFee].every(Number.isSafeInteger)) continue;
    const available = entry.type === "adjustment"
      || entry.providerFeeFinal === true
      || (entry.type === "payment_captured" && finalizedProviderFeePayments.has(entry.paymentId));
    if (available) summary.availableBalance += boothEarning;
    else {
      summary.pendingBalance += boothEarning;
      summary.provisionalEntryCount += 1;
    }
    summary.totalBalance += boothEarning;
    summary.gross += gross;
    summary.platformFee += platformFee;
    summary.providerFee += providerFee;
    summary.entryCount += 1;
    if (!summary.latestEntryAt || Date.parse(entry.createdAt || "") > Date.parse(summary.latestEntryAt)) summary.latestEntryAt = entry.createdAt || null;
  }
  return Object.freeze(summary);
}

export function reconcileProviderLedger(records = [], providerRows = [], options = {}) {
  const currency = boundedText(options.currency || "IDR", 3).toUpperCase() || "IDR";
  const uniqueLedger = new Map();
  for (const entry of Array.isArray(records) ? records : []) {
    if (!entry?.id || boundedText(entry.currency || "IDR", 3).toUpperCase() !== currency) continue;
    if (!uniqueLedger.has(entry.id)) uniqueLedger.set(entry.id, entry);
  }
  const ledgerByProviderId = new Map();
  for (const entry of uniqueLedger.values()) {
    const providerPaymentId = boundedText(entry.providerPaymentId, 120);
    if (!providerPaymentId) continue;
    const bucket = ledgerByProviderId.get(providerPaymentId) || [];
    bucket.push(entry);
    ledgerByProviderId.set(providerPaymentId, bucket);
  }

  const normalizedRows = [];
  const seenProviderIds = new Set();
  for (const row of Array.isArray(providerRows) ? providerRows : []) {
    const providerPaymentId = boundedText(row?.providerPaymentId || row?.provider_payment_id, 120);
    const gross = Number(row?.gross ?? row?.amount);
    const providerFee = Number(row?.providerFee ?? row?.provider_fee ?? 0);
    const status = boundedText(row?.status || "settled", 24).toLowerCase();
    if (!providerPaymentId) throw new Error("Setiap baris provider wajib memiliki provider_payment_id");
    if (seenProviderIds.has(providerPaymentId)) throw new Error(`Provider payment ${providerPaymentId} muncul lebih dari sekali`);
    if (!Number.isSafeInteger(gross) || gross < 0 || !Number.isSafeInteger(providerFee) || providerFee < 0) {
      throw new Error(`Nominal provider ${providerPaymentId} tidak valid`);
    }
    seenProviderIds.add(providerPaymentId);
    normalizedRows.push({ providerPaymentId, gross, providerFee, status });
  }

  const details = normalizedRows.map(row => {
    const entries = ledgerByProviderId.get(row.providerPaymentId) || [];
    const captureEntries = entries.filter(entry => entry.type === "payment_captured");
    const providerFeeEntries = entries.filter(entry => entry.type === "provider_fee" && entry.providerFeeFinal === true);
    const ledgerGross = captureEntries.reduce((sum, entry) => sum + Number(entry.gross || 0), 0);
    const ledgerProviderFee = providerFeeEntries.reduce((sum, entry) => sum + Number(entry.providerFee || 0), 0);
    const ledgerBoothEarning = entries.reduce((sum, entry) => sum + Number(entry.boothEarning || 0), 0);
    const grossDifference = ledgerGross - row.gross;
    const providerFeeDifference = ledgerProviderFee - row.providerFee;
    const providerFinal = new Set(["paid", "settled", "succeeded", "completed"]).has(row.status);
    const matched = captureEntries.length === 1 && providerFeeEntries.length === 1
      && grossDifference === 0 && providerFeeDifference === 0 && providerFinal;
    return Object.freeze({
      ...row,
      paymentId: captureEntries[0]?.paymentId || entries[0]?.paymentId || null,
      ledgerGross,
      ledgerProviderFee,
      ledgerBoothEarning,
      grossDifference,
      providerFeeDifference,
      matched,
      reason: matched ? "matched"
        : !captureEntries.length ? "missing_ledger_payment"
          : captureEntries.length > 1 ? "duplicate_ledger_capture"
            : !providerFeeEntries.length ? "provider_fee_not_final"
              : providerFeeEntries.length > 1 ? "duplicate_provider_fee"
                : !providerFinal ? "provider_not_final"
                  : grossDifference !== 0 ? "gross_difference" : "provider_fee_difference",
    });
  });
  const missingFromProvider = [...ledgerByProviderId.entries()]
    .filter(([providerPaymentId, entries]) => !seenProviderIds.has(providerPaymentId) && entries.some(entry => entry.type === "payment_captured"))
    .map(([providerPaymentId, entries]) => Object.freeze({
      providerPaymentId,
      paymentId: entries.find(entry => entry.type === "payment_captured")?.paymentId || null,
      ledgerGross: entries.filter(entry => entry.type === "payment_captured").reduce((sum, entry) => sum + Number(entry.gross || 0), 0),
      reason: "missing_provider_report",
    }));
  const mismatchCount = details.filter(row => !row.matched).length + missingFromProvider.length;
  return Object.freeze({
    currency,
    providerRowCount: normalizedRows.length,
    ledgerEntryCount: uniqueLedger.size,
    matchedCount: details.filter(row => row.matched).length,
    mismatchCount,
    grossDifference: details.reduce((sum, row) => sum + row.grossDifference, 0)
      + missingFromProvider.reduce((sum, row) => sum + row.ledgerGross, 0),
    providerFeeDifference: details.reduce((sum, row) => sum + row.providerFeeDifference, 0),
    zeroDifference: mismatchCount === 0,
    details: Object.freeze(details),
    missingFromProvider: Object.freeze(missingFromProvider),
  });
}

export async function createLedgerReconciliationRun(redis, input = {}) {
  const boothCode = boundedText(input.boothCode, 100);
  const reference = boundedText(input.reference, 120).replace(/[^a-zA-Z0-9._:-]/g, "-");
  const provider = boundedText(input.provider || "xendit", 40).toLowerCase();
  const providerRows = Array.isArray(input.providerRows) ? input.providerRows.slice(0, 500) : [];
  const ledgerRecords = Array.isArray(input.ledgerRecords) ? input.ledgerRecords : [];
  const createdBy = boundedText(input.createdBy, 120) || "finance-reconciliation";
  if (!boothCode || !reference || !providerRows.length) throw new Error("Photobox, referensi, dan laporan provider wajib diisi");
  const inputHash = await sha256(JSON.stringify({ boothCode, reference, provider, providerRows }));
  const markerKey = `photoslive:booth:${boothCode}:ledger-reconciliation:${reference}`;
  const existingId = await redis.get(markerKey);
  if (existingId) {
    const existing = await redis.get(ledgerReconciliationRunKey(existingId));
    if (existing) {
      if (existing.inputHash !== inputHash) throw Object.assign(new Error("Referensi rekonsiliasi sudah digunakan untuk laporan berbeda"), { status: 409 });
      return { run: existing, reused: true };
    }
  }
  const result = reconcileProviderLedger(ledgerRecords, providerRows);
  const run = Object.freeze({
    id: randomId("recon"), boothCode, provider, reference, inputHash, createdBy,
    ...result, createdAt: now(),
  });
  const claimed = await redis.set(markerKey, run.id, { nx: true });
  if (!claimed) {
    const claimedId = await redis.get(markerKey);
    const existing = claimedId ? await redis.get(ledgerReconciliationRunKey(claimedId)) : null;
    if (existing?.inputHash === inputHash) return { run: existing, reused: true };
    throw Object.assign(new Error("Rekonsiliasi dengan referensi ini sedang diproses"), { status: 409 });
  }
  await redis.set(ledgerReconciliationRunKey(run.id), run);
  await pushBounded(redis, ledgerReconciliationRunIndexKey, run.id, 500);
  return { run, reused: false };
}

export async function listLedgerReconciliationRuns(redis, options = {}) {
  const boothCode = boundedText(options.boothCode, 100);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 25)));
  const ids = await redis.lrange(ledgerReconciliationRunIndexKey, 0, Math.max(limit * 4, limit) - 1);
  const records = await Promise.all([...new Set(ids)].map(id => redis.get(ledgerReconciliationRunKey(id))));
  return records.filter(record => record && (!boothCode || record.boothCode === boothCode)).slice(0, limit);
}

export async function reconcilePendingPayments(redis, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 25)));
  const ids = [...new Set(await redis.lrange(reconciliationIndexKey, 0, Math.max(limit * 5, limit) - 1))];
  const result = { scanned: 0, checked: 0, resolved: 0, review: 0, pending: 0, failed: 0, payments: [] };
  for (const id of ids) {
    if (result.checked >= limit) break;
    const [payment, job] = await Promise.all([getPayment(redis, id), getPaymentReconciliation(redis, id)]);
    if (!payment || !job) continue;
    result.scanned += 1;
    if (job.status === "resolved" || job.status === "review") continue;
    if (Date.parse(job.nextAttemptAt || "") > Date.now()) continue;
    result.checked += 1;
    try {
      const runtime = await options.runtimeResolver({ boothCode: payment.boothCode, providerId: payment.provider, providerConnectionRef: payment.providerConnectionRef || null });
      if (!runtime?.environment) throw new Error("Runtime provider pembayaran tidak tersedia");
      const refreshed = await refreshQrisPayment(redis, payment.id, { force: true, environment: runtime.environment, fetchImplementation: options.fetchImplementation });
      const nextJob = await getPaymentReconciliation(redis, payment.id);
      if (nextJob?.status === "review") result.review += 1;
      else if (nextJob?.status === "resolved") result.resolved += 1;
      else {
        result.pending += 1;
        await updateReconciliation(redis, refreshed, {
          attempts: Number(job.attempts || 0) + 1,
          nextAttemptAt: new Date(Date.now() + Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(8, Number(job.attempts || 0))))).toISOString(),
          lastError: null,
        });
      }
      const ledger = refreshed.settlementLedgerId ? await getPaymentLedgerEntry(redis, refreshed.settlementLedgerId) : null;
      result.payments.push({ payment: refreshed, ledger, reconciliation: await getPaymentReconciliation(redis, payment.id) });
      await options.onResult?.({ payment: refreshed, ledger, reconciliation: await getPaymentReconciliation(redis, payment.id) });
    } catch (error) {
      result.failed += 1;
      const attempts = Number(job.attempts || 0) + 1;
      const nextJob = await updateReconciliation(redis, payment, {
        status: attempts >= 10 ? "dead" : "pending",
        reason: "provider_error",
        attempts,
        lastError: error instanceof Error ? error.message : String(error),
        nextAttemptAt: new Date(Date.now() + Math.min(6 * 60 * 60_000, 30_000 * (2 ** Math.min(8, attempts - 1)))).toISOString(),
      });
      await options.onResult?.({ payment, ledger: null, reconciliation: nextJob });
    }
  }
  return result;
}

export const paymentStorageKeys = Object.freeze({ paymentKey, providerPaymentKey, paymentIntentKey, paymentIndexKey, ledgerKey, ledgerIndexKey, reconciliationKey, reconciliationIndexKey, ledgerReconciliationRunKey, ledgerReconciliationRunIndexKey, refundKey, refundIntentKey, providerRefundKey, chargebackKey, paymentChargebackKey, providerChargebackKey });
