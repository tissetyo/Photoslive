import { now, randomId } from "./_store.mjs";
import { paymentStorageKeys, summarizeLedgerBalance } from "./_payments.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const PAYOUT_INDEX_KEY = "photoslive:payout:index";
const ACCOUNT_INDEX_KEY = "photoslive:payout-account:index";
const ACTIVE_PAYOUT_STATES = new Set(["pending_approval", "approved"]);
const PAYOUT_STATES = new Set(["pending_approval", "approved", "paid", "cancelled"]);
const MODES = new Set(["disabled", "manual_superadmin"]);
const MAX_PAYOUT = 1_000_000_000;

const clean = (value, maximum = 160) => String(value || "").trim().slice(0, maximum);
const safeId = (value, maximum = 100) => clean(value, maximum).toLowerCase().replace(/[^a-z0-9_-]/g, "");
const accountKey = boothCode => `photoslive:payout-account:${safeId(boothCode)}`;
const policyKey = boothCode => `photoslive:payout-policy:${safeId(boothCode)}`;
const payoutKey = id => `photoslive:payout:${clean(id, 120)}`;
const payoutBusinessKey = (boothCode, period) => `photoslive:payout-business:${safeId(boothCode)}:${clean(period, 32)}`;
const payoutLedgerMarkerKey = id => `photoslive:payout:${clean(id, 120)}:ledger`;
const payoutMutationLockKey = id => `photoslive:payout:${clean(id, 120)}:mutation-lock`;
const payoutTransferReferenceKey = reference => `photoslive:payout-transfer-reference:${clean(reference, 120).toLowerCase()}`;

const base64url = bytes => Buffer.from(bytes).toString("base64url");
const fromBase64url = value => new Uint8Array(Buffer.from(String(value || ""), "base64url"));

function vaultConfig(environment = process.env) {
  let source = {};
  if (environment.PAYOUT_VAULT_KEYS) {
    try { source = JSON.parse(environment.PAYOUT_VAULT_KEYS); }
    catch { throw new Error("PAYOUT_VAULT_KEYS bukan JSON yang valid"); }
  } else if (environment.PROVIDER_CREDENTIAL_KEYS) {
    try { source = JSON.parse(environment.PROVIDER_CREDENTIAL_KEYS); }
    catch { throw new Error("PROVIDER_CREDENTIAL_KEYS bukan JSON yang valid"); }
  } else if (environment.PAYOUT_VAULT_MASTER_KEY || environment.PROVIDER_CREDENTIAL_MASTER_KEY) {
    source = { v1: environment.PAYOUT_VAULT_MASTER_KEY || environment.PROVIDER_CREDENTIAL_MASTER_KEY };
  }
  const keys = new Map();
  for (const [version, value] of Object.entries(source || {})) {
    const id = safeId(version, 40);
    const bytes = fromBase64url(value);
    if (!id || bytes.byteLength !== 32) throw new Error("Setiap kunci payout vault harus base64 32 byte");
    keys.set(id, bytes);
  }
  const activeVersion = safeId(environment.PAYOUT_VAULT_ACTIVE_KEY_VERSION || environment.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION || [...keys.keys()][0], 40);
  return { available: keys.has(activeVersion), activeVersion, keys };
}

async function sealAccount(details, boothCode, version, environment = process.env) {
  const vault = vaultConfig(environment);
  if (!vault.available) throw new Error("Vault payout belum dikonfigurasi");
  const key = await crypto.subtle.importKey("raw", vault.keys.get(vault.activeVersion), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encoder.encode(`photoslive-payout-v1:${safeId(boothCode)}:${version}`);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, encoder.encode(JSON.stringify(details)));
  return { format: "aes-256-gcm", keyVersion: vault.activeVersion, iv: base64url(iv), ciphertext: base64url(new Uint8Array(encrypted)) };
}

export async function openPayoutAccount(record, environment = process.env) {
  if (!record?.sealed) throw new Error("Detail rekening payout tidak tersedia");
  const vault = vaultConfig(environment);
  const keyBytes = vault.keys.get(safeId(record.sealed.keyVersion, 40));
  if (!keyBytes || record.sealed.format !== "aes-256-gcm") throw new Error("Kunci rekening payout tidak tersedia");
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const aad = encoder.encode(`photoslive-payout-v1:${safeId(record.boothCode)}:${record.version}`);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(record.sealed.iv), additionalData: aad }, key, fromBase64url(record.sealed.ciphertext));
    return JSON.parse(decoder.decode(plain));
  } catch { throw new Error("Detail rekening payout tidak dapat didekripsi"); }
}

function maskAccountNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? `•••• ${digits.slice(-4)}` : "Belum diisi";
}

export function safePayoutAccount(record) {
  if (!record) return null;
  return {
    boothCode: record.boothCode,
    bankCode: record.bankCode,
    accountName: record.accountName,
    accountNumberMasked: record.accountNumberMasked,
    status: record.status,
    version: Number(record.version || 0),
    verifiedAt: record.verifiedAt || null,
    verifiedBy: record.verifiedBy || null,
    verificationReference: record.verificationReference || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export function safePayout(record) {
  if (!record) return null;
  return {
    id: record.id,
    boothCode: record.boothCode,
    period: record.period,
    mode: record.mode,
    currency: record.currency,
    amount: record.amount,
    status: record.status,
    accountVersion: record.accountVersion,
    account: record.account,
    preparedBy: record.preparedBy,
    approvedBy: record.approvedBy || null,
    approvedAt: record.approvedAt || null,
    paidBy: record.paidBy || null,
    paidAt: record.paidAt || null,
    transferReference: record.transferReference || null,
    proofObjectKey: record.proofObjectKey || null,
    proofProvider: record.proofProvider || null,
    proofVerifiedAt: record.proofVerifiedAt || null,
    ledgerEntryId: record.ledgerEntryId || null,
    emailDeliveryId: record.emailDeliveryId || null,
    cancellationReason: record.cancellationReason || null,
    cancelledAt: record.cancelledAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function summarizePayoutEmailDelivery(payouts = [], deliveries = []) {
  const emailById = new Map(deliveries.map(delivery => [delivery.id, delivery]));
  const failedStates = new Set(["failed", "bounced", "complained", "suppressed"]);
  const pendingStates = new Set(["queued", "retry", "waiting_configuration", "sent"]);
  const records = payouts.map(payout => ({ ...payout, emailStatus: payout.emailDeliveryId ? emailById.get(payout.emailDeliveryId)?.status || "unknown" : null }));
  const paidPayouts = records.filter(payout => payout.status === "paid");
  const summary = paidPayouts.reduce((result, payout) => {
    if (!payout.emailDeliveryId || payout.emailStatus === "unknown") result.missing += 1;
    else if (failedStates.has(payout.emailStatus)) result.failed += 1;
    else if (pendingStates.has(payout.emailStatus)) result.pending += 1;
    else if (payout.emailStatus === "delivered") result.delivered += 1;
    return result;
  }, { paid: paidPayouts.length, delivered: 0, pending: 0, failed: 0, missing: 0 });
  return { records, summary };
}

async function pushBounded(redis, key, value, limit = 2_000) {
  await redis.lpush(key, value);
  await redis.ltrim(key, 0, limit - 1);
}

async function withPayoutMutationLock(redis, id, operation, handler) {
  const payoutId = clean(id, 120);
  if (!payoutId) throw new Error("ID payout wajib diisi");
  const key = payoutMutationLockKey(payoutId);
  const token = `${clean(operation, 40) || "mutation"}:${crypto.randomUUID()}`;
  const claimed = await redis.set(key, token, { nx: true, ex: 30 });
  if (!claimed) throw Object.assign(new Error("Payout sedang diproses oleh tindakan lain. Perbarui lalu coba lagi."), { status: 409 });
  try {
    return await handler();
  } finally {
    // Do not remove a newer worker's lock if this operation ran past its TTL.
    if (await redis.get(key) === token) await redis.del(key);
  }
}

export async function setPayoutPolicy(redis, input = {}, actorId = "system") {
  const boothCode = safeId(input.boothCode);
  const mode = clean(input.mode, 40).toLowerCase();
  const minimumAmount = Number(input.minimumAmount || 10_000);
  if (!boothCode || !MODES.has(mode)) throw new Error("Mode payout tidak valid");
  if (!Number.isSafeInteger(minimumAmount) || minimumAmount < 10_000 || minimumAmount > 100_000_000) throw new Error("Minimum payout tidak valid");
  const previous = await redis.get(policyKey(boothCode));
  const record = { boothCode, mode, minimumAmount, createdAt: previous?.createdAt || now(), updatedAt: now(), updatedBy: clean(actorId, 120) || "system" };
  await redis.set(policyKey(boothCode), record);
  return record;
}

export async function getPayoutPolicy(redis, boothCode) {
  return await redis.get(policyKey(boothCode)) || { boothCode: safeId(boothCode), mode: "disabled", minimumAmount: 10_000, createdAt: null, updatedAt: null, updatedBy: null };
}

async function invalidateActivePayouts(redis, boothCode, accountVersion, actorId) {
  const ids = await redis.lrange(PAYOUT_INDEX_KEY, 0, 1_999);
  let invalidated = 0;
  for (const id of [...new Set(ids)]) {
    const record = await redis.get(payoutKey(id));
    if (record?.boothCode !== boothCode || !ACTIVE_PAYOUT_STATES.has(record.status) || Number(record.accountVersion) === Number(accountVersion)) continue;
    record.status = "cancelled";
    record.cancellationReason = "Rekening payout berubah; approval lama dibatalkan";
    record.cancelledAt = now();
    record.cancelledBy = clean(actorId, 120);
    record.updatedAt = record.cancelledAt;
    await redis.set(payoutKey(record.id), record);
    invalidated += 1;
  }
  return invalidated;
}

export async function savePayoutAccount(redis, input = {}, actorId = "system", environment = process.env) {
  const boothCode = safeId(input.boothCode);
  const bankCode = clean(input.bankCode, 32).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const accountName = clean(input.accountName, 120);
  const accountNumber = String(input.accountNumber || "").replace(/\s/g, "");
  if (!boothCode || !bankCode || !accountName || !/^\d{6,24}$/.test(accountNumber)) throw new Error("Data rekening payout belum valid");
  const previous = await redis.get(accountKey(boothCode));
  const version = Number(previous?.version || 0) + 1;
  const record = {
    boothCode, bankCode, accountName, accountNumberMasked: maskAccountNumber(accountNumber),
    sealed: await sealAccount({ bankCode, accountName, accountNumber }, boothCode, version, environment),
    status: "pending_verification", version, verifiedAt: null, verifiedBy: null, verificationReference: null,
    createdAt: previous?.createdAt || now(), updatedAt: now(), updatedBy: clean(actorId, 120) || "system",
  };
  await redis.set(accountKey(boothCode), record);
  if (typeof redis.sadd === "function") await redis.sadd(ACCOUNT_INDEX_KEY, boothCode);
  const invalidatedPayouts = await invalidateActivePayouts(redis, boothCode, version, actorId);
  return { account: safePayoutAccount(record), invalidatedPayouts };
}

export async function verifyPayoutAccount(redis, input = {}, actorId = "system") {
  const boothCode = safeId(input.boothCode);
  const reference = clean(input.reference, 120);
  const record = await redis.get(accountKey(boothCode));
  if (!record) throw Object.assign(new Error("Rekening payout belum diisi"), { status: 404 });
  if (!reference) throw new Error("Referensi verifikasi rekening wajib diisi");
  if (clean(actorId, 120) === record.updatedBy) throw Object.assign(new Error("Maker dan verifier rekening harus berbeda"), { status: 409 });
  record.status = "verified";
  record.verifiedAt = now();
  record.verifiedBy = clean(actorId, 120);
  record.verificationReference = reference;
  record.updatedAt = record.verifiedAt;
  await redis.set(accountKey(boothCode), record);
  return safePayoutAccount(record);
}

export async function getPayoutAccount(redis, boothCode) {
  return safePayoutAccount(await redis.get(accountKey(boothCode)));
}

// Server-only persistence shape. Never return this record from an HTTP handler:
// it contains the encrypted account payload required for PostgreSQL recovery.
export async function getPayoutAccountPersistence(redis, boothCode) {
  return await redis.get(accountKey(boothCode));
}

export async function listPayoutAccounts(redis) {
  const booths = typeof redis.smembers === "function" ? await redis.smembers(ACCOUNT_INDEX_KEY) : [];
  const records = await Promise.all(booths.map(code => redis.get(accountKey(code))));
  return records.filter(Boolean).map(safePayoutAccount).sort((a, b) => a.boothCode.localeCompare(b.boothCode));
}

async function activeReservedAmount(redis, boothCode) {
  const ids = await redis.lrange(PAYOUT_INDEX_KEY, 0, 1_999);
  const records = await Promise.all([...new Set(ids)].map(id => redis.get(payoutKey(id))));
  return records.filter(item => item?.boothCode === boothCode && ACTIVE_PAYOUT_STATES.has(item.status)).reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

export async function createManualPayout(redis, input = {}, options = {}) {
  const boothCode = safeId(input.boothCode);
  const period = clean(input.period || new Date().toISOString().slice(0, 10), 32).replace(/[^0-9A-Za-z._:-]/g, "-");
  const actorId = clean(input.actorId, 120) || "finance-maker";
  const policy = await getPayoutPolicy(redis, boothCode);
  if (policy.mode !== "manual_superadmin") throw Object.assign(new Error("Payout manual belum diaktifkan untuk photobox"), { status: 409 });
  const rawAccount = await redis.get(accountKey(boothCode));
  if (!rawAccount || rawAccount.status !== "verified") throw Object.assign(new Error("Rekening payout belum diverifikasi"), { status: 409 });
  const marker = payoutBusinessKey(boothCode, period);
  const existingId = await redis.get(marker);
  if (existingId) {
    const existing = await redis.get(payoutKey(existingId));
    if (existing) return { payout: safePayout(existing), reused: true };
  }
  const summary = summarizeLedgerBalance(Array.isArray(options.ledgerRecords) ? options.ledgerRecords : []);
  const reserved = await activeReservedAmount(redis, boothCode);
  const available = Math.max(0, Number(summary.availableBalance || 0) - reserved);
  if (!Number.isSafeInteger(available) || available < policy.minimumAmount) throw Object.assign(new Error(`Saldo tersedia belum mencapai minimum payout Rp${policy.minimumAmount.toLocaleString("id-ID")}`), { status: 409 });
  if (available > MAX_PAYOUT) throw new Error("Nominal payout melebihi batas aman");
  const id = randomId("payout");
  const claimed = await redis.set(marker, id, { nx: true });
  if (!claimed) {
    const reused = await redis.get(payoutKey(await redis.get(marker)));
    if (reused) return { payout: safePayout(reused), reused: true };
    throw Object.assign(new Error("Batch payout sedang diproses"), { status: 409 });
  }
  const record = {
    id, boothCode, period, mode: policy.mode, currency: "IDR", amount: available,
    status: "pending_approval", accountVersion: rawAccount.version,
    account: { bankCode: rawAccount.bankCode, accountName: rawAccount.accountName, accountNumberMasked: rawAccount.accountNumberMasked },
    preparedBy: actorId, approvedBy: null, approvedAt: null, paidBy: null, paidAt: null,
    transferReference: null, proofObjectKey: null, proofProvider: null, proofVerifiedAt: null, ledgerEntryId: null,
    emailDeliveryId: null, cancellationReason: null, cancelledAt: null, createdAt: now(), updatedAt: now(),
  };
  await redis.set(payoutKey(id), record);
  await pushBounded(redis, PAYOUT_INDEX_KEY, id);
  return { payout: safePayout(record), reused: false };
}

export async function approveManualPayout(redis, input = {}, actorId = "system") {
  return withPayoutMutationLock(redis, input.id, "approve", async () => {
    const record = await redis.get(payoutKey(input.id));
    if (!record) throw Object.assign(new Error("Payout tidak ditemukan"), { status: 404 });
    if (record.status === "approved") return safePayout(record);
    if (record.status !== "pending_approval") throw Object.assign(new Error("Payout tidak menunggu approval"), { status: 409 });
    if (record.preparedBy === clean(actorId, 120)) throw Object.assign(new Error("Maker tidak boleh menyetujui payout sendiri"), { status: 409 });
    const account = await redis.get(accountKey(record.boothCode));
    if (!account || account.status !== "verified" || Number(account.version) !== Number(record.accountVersion)) {
      record.status = "cancelled"; record.cancellationReason = "Rekening berubah atau tidak lagi terverifikasi"; record.cancelledAt = now(); record.updatedAt = record.cancelledAt;
      await redis.set(payoutKey(record.id), record);
      throw Object.assign(new Error(record.cancellationReason), { status: 409 });
    }
    record.status = "approved";
    record.approvedBy = clean(actorId, 120);
    record.approvedAt = now();
    record.updatedAt = record.approvedAt;
    await redis.set(payoutKey(record.id), record);
    return safePayout(record);
  });
}

export async function attachPayoutProof(redis, input = {}, actorId = "system") {
  return withPayoutMutationLock(redis, input.id, "attach-proof", async () => {
    const record = await redis.get(payoutKey(input.id));
    if (!record) throw Object.assign(new Error("Payout tidak ditemukan"), { status: 404 });
    if (record.status !== "approved") throw Object.assign(new Error("Bukti hanya dapat dipasang pada payout yang telah disetujui"), { status: 409 });
    const objectKey = clean(input.objectKey, 500);
    const checksum = clean(input.checksum, 64).toLowerCase();
    if (!objectKey.startsWith(`payout-proofs/${record.boothCode}/${record.id}/`) || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error("Bukti transfer belum tervalidasi");
    record.proofObjectKey = objectKey;
    record.proofProvider = clean(input.provider, 80) || null;
    record.proofChecksum = checksum;
    record.proofVerifiedAt = now();
    record.proofVerifiedBy = clean(actorId, 120);
    record.updatedAt = record.proofVerifiedAt;
    await redis.set(payoutKey(record.id), record);
    return safePayout(record);
  });
}

async function appendPayoutLedger(redis, payout, transferReference) {
  const marker = payoutLedgerMarkerKey(payout.id);
  const existingId = await redis.get(marker);
  if (existingId) return redis.get(paymentStorageKeys.ledgerKey(existingId));
  const entry = Object.freeze({
    id: randomId("ledger"), boothCode: payout.boothCode, paymentId: null, payoutId: payout.id,
    type: "payout", currency: payout.currency, gross: 0, providerFee: 0, providerFeeFinal: true,
    platformFee: 0, boothEarning: -payout.amount, provider: "manual_bank_transfer",
    providerPaymentId: transferReference, idempotencyKey: `ledger:payout:${payout.id}`,
    recordedBy: payout.paidBy, createdAt: payout.paidAt,
  });
  const claimed = await redis.set(marker, entry.id, { nx: true });
  if (!claimed) return redis.get(paymentStorageKeys.ledgerKey(await redis.get(marker)));
  await redis.set(paymentStorageKeys.ledgerKey(entry.id), entry);
  await pushBounded(redis, paymentStorageKeys.ledgerIndexKey(payout.boothCode), entry.id, 5_000);
  return entry;
}

async function claimPayoutTransferReference(redis, payout, transferReference) {
  const marker = payoutTransferReferenceKey(transferReference);
  let existingId = await redis.get(marker);
  if (!existingId) {
    // Backfill protection for payouts finalized before the unique marker existed.
    const ids = await redis.lrange(PAYOUT_INDEX_KEY, 0, 1_999);
    const records = await Promise.all([...new Set(ids)].map(id => redis.get(payoutKey(id))));
    const historical = records.find(record => record?.status === "paid"
      && record.id !== payout.id
      && String(record.transferReference || "").toLowerCase() === transferReference.toLowerCase());
    if (historical) {
      await redis.set(marker, historical.id, { nx: true });
      existingId = historical.id;
    }
  }
  if (existingId && existingId !== payout.id) {
    throw Object.assign(new Error("Referensi transfer sudah digunakan oleh payout lain"), {
      status: 409,
      riskCode: "duplicate_transfer_reference",
      existingPayoutId: existingId,
      transferReference,
    });
  }
  if (!existingId) {
    const claimed = await redis.set(marker, payout.id, { nx: true });
    if (!claimed) {
      existingId = await redis.get(marker);
      if (existingId !== payout.id) {
        throw Object.assign(new Error("Referensi transfer sudah digunakan oleh payout lain"), {
          status: 409,
          riskCode: "duplicate_transfer_reference",
          existingPayoutId: existingId,
          transferReference,
        });
      }
    }
  }
  return marker;
}

export async function markManualPayoutPaid(redis, input = {}, actorId = "system") {
  return withPayoutMutationLock(redis, input.id, "mark-paid", async () => {
    const record = await redis.get(payoutKey(input.id));
    if (!record) throw Object.assign(new Error("Payout tidak ditemukan"), { status: 404 });
    if (record.status === "paid") return { payout: safePayout(record), ledger: await redis.get(paymentStorageKeys.ledgerKey(record.ledgerEntryId)), reused: true };
    if (record.status !== "approved") throw Object.assign(new Error("Payout belum disetujui"), { status: 409 });
    const transferReference = clean(input.transferReference, 120).replace(/[^a-zA-Z0-9._:-]/g, "-");
    if (!transferReference) throw new Error("Referensi transfer wajib diisi");
    if (!record.proofObjectKey || !record.proofVerifiedAt) throw Object.assign(new Error("Bukti transfer terverifikasi wajib diunggah"), { status: 409 });
    const account = await redis.get(accountKey(record.boothCode));
    if (!account || Number(account.version) !== Number(record.accountVersion) || account.status !== "verified") throw Object.assign(new Error("Rekening payout telah berubah; approval harus diulang"), { status: 409 });
    const referenceMarker = await claimPayoutTransferReference(redis, record, transferReference);
    try {
      record.status = "paid";
      record.transferReference = transferReference;
      record.paidBy = clean(actorId, 120);
      record.paidAt = now();
      record.updatedAt = record.paidAt;
      const ledger = await appendPayoutLedger(redis, record, transferReference);
      record.ledgerEntryId = ledger.id;
      await redis.set(payoutKey(record.id), record);
      return { payout: safePayout(record), ledger, reused: false };
    } catch (error) {
      // Avoid permanently reserving a reference if ledger/persistence failed.
      if (await redis.get(referenceMarker) === record.id) await redis.del(referenceMarker);
      throw error;
    }
  });
}

export async function setPayoutEmailDelivery(redis, id, deliveryId) {
  const record = await redis.get(payoutKey(id));
  if (!record) return null;
  record.emailDeliveryId = clean(deliveryId, 120) || null;
  record.updatedAt = now();
  await redis.set(payoutKey(record.id), record);
  return safePayout(record);
}

export async function cancelManualPayout(redis, input = {}, actorId = "system") {
  return withPayoutMutationLock(redis, input.id, "cancel", async () => {
    const record = await redis.get(payoutKey(input.id));
    if (!record) throw Object.assign(new Error("Payout tidak ditemukan"), { status: 404 });
    if (!ACTIVE_PAYOUT_STATES.has(record.status)) throw Object.assign(new Error("Payout tidak dapat dibatalkan pada status ini"), { status: 409 });
    const reason = clean(input.reason, 500);
    if (!reason) throw new Error("Alasan pembatalan wajib diisi");
    record.status = "cancelled"; record.cancellationReason = reason; record.cancelledAt = now(); record.cancelledBy = clean(actorId, 120); record.updatedAt = record.cancelledAt;
    await redis.set(payoutKey(record.id), record);
    return safePayout(record);
  });
}

export async function getPayout(redis, id) {
  return safePayout(await redis.get(payoutKey(id)));
}

export async function listPayouts(redis, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const boothCode = safeId(options.boothCode);
  const status = clean(options.status, 40).toLowerCase();
  if (status && !PAYOUT_STATES.has(status)) throw new Error("Filter status payout tidak valid");
  const ids = await redis.lrange(PAYOUT_INDEX_KEY, 0, Math.max(limit * 5, limit) - 1);
  const records = await Promise.all([...new Set(ids)].map(id => redis.get(payoutKey(id))));
  return records.filter(record => record && (!boothCode || record.boothCode === boothCode) && (!status || record.status === status)).slice(0, limit).map(safePayout);
}

export const payoutStorageKeys = Object.freeze({ accountKey, policyKey, payoutKey, payoutBusinessKey, payoutLedgerMarkerKey, payoutMutationLockKey, payoutTransferReferenceKey, PAYOUT_INDEX_KEY, ACCOUNT_INDEX_KEY });
