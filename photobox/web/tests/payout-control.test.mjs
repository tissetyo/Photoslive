import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  approveManualPayout,
  attachPayoutProof,
  cancelManualPayout,
  createManualPayout,
  getPayout,
  getPayoutAccount,
  getPayoutPolicy,
  listPayouts,
  markManualPayoutPaid,
  openPayoutAccount,
  payoutStorageKeys,
  savePayoutAccount,
  setPayoutPolicy,
  summarizePayoutEmailDelivery,
  verifyPayoutAccount,
} from "../api/_payouts.mjs";
import { listPaymentLedger, summarizeLedgerBalance } from "../api/_payments.mjs";
import { financePayoutControl } from "../api/platform.mjs";
import { boothKey, machineKey, sessionKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); this.sets = new Map(); this.failEmailQueue = false; }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, structuredClone(value)); return "OK"; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { if (this.failEmailQueue && key === "photoslive:email-deliveries") throw new Error("Email queue unavailable"); const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
  async sadd(key, ...values) { const set = this.sets.get(key) || new Set(); values.forEach(value => set.add(value)); this.sets.set(key, set); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
  pipeline() {
    const operations = [];
    return {
      lpush: (key, value) => operations.push(() => this.lpush(key, value)),
      ltrim: (key, start, stop) => operations.push(() => this.ltrim(key, start, stop)),
      exec: async () => Promise.all(operations.map(operation => operation())),
    };
  }
}

const environment = {
  PAYOUT_VAULT_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64url") }),
  PAYOUT_VAULT_ACTIVE_KEY_VERSION: "v1",
};
const sessionSecret = "payout-control-session-secret-tests-2026";

async function credentialHash(value, salt = "abcdef0123456789abcdef0123456789") {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 120_000, hash: "SHA-256" }, material, 256);
  return `${salt}:${[...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const hex = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${hex}`)}`;
}

const ledger = (boothCode, amount = 90_000, id = "ledger_income") => ({
  id, boothCode, paymentId: "pay_1", type: "payment_captured", currency: "IDR", gross: amount,
  providerFee: 0, providerFeeFinal: true, platformFee: 0, boothEarning: amount,
  provider: "xendit", providerPaymentId: "provider_1", createdAt: new Date().toISOString(),
});

async function verifiedAccount(redis, boothCode = "booth-one") {
  await savePayoutAccount(redis, { boothCode, bankCode: "ID_BCA", accountName: "Zoe Owner", accountNumber: "1234567890" }, "maker-account", environment);
  return verifyPayoutAccount(redis, { boothCode, reference: "bank-check-1" }, "platform-owner");
}

test("payout account is encrypted at rest and only exposes a masked number", async () => {
  const redis = new MemoryRedis();
  const result = await savePayoutAccount(redis, { boothCode: "booth-one", bankCode: "ID_BCA", accountName: "Zoe Owner", accountNumber: "1234567890" }, "maker-account", environment);
  assert.equal(result.account.accountNumberMasked, "•••• 7890");
  assert.equal(result.account.status, "pending_verification");
  const raw = await redis.get(payoutStorageKeys.accountKey("booth-one"));
  assert.ok(raw.sealed.ciphertext);
  assert.doesNotMatch(JSON.stringify(raw), /1234567890/);
  assert.deepEqual(await openPayoutAccount(raw, environment), { bankCode: "ID_BCA", accountName: "Zoe Owner", accountNumber: "1234567890" });
});

test("payout delivery metrics distinguish delivered, pending, failed, and missing email", () => {
  const payouts = [
    { id: "one", status: "paid", emailDeliveryId: "email-delivered" },
    { id: "two", status: "paid", emailDeliveryId: "email-pending" },
    { id: "three", status: "paid", emailDeliveryId: "email-failed" },
    { id: "four", status: "paid", emailDeliveryId: null },
    { id: "five", status: "approved", emailDeliveryId: null },
  ];
  const result = summarizePayoutEmailDelivery(payouts, [
    { id: "email-delivered", status: "delivered" }, { id: "email-pending", status: "queued" }, { id: "email-failed", status: "bounced" },
  ]);
  assert.deepEqual(result.summary, { paid: 4, delivered: 1, pending: 1, failed: 1, missing: 1 });
  assert.equal(result.records.find(item => item.id === "three").emailStatus, "bounced");
});

test("account verification requires maker-checker separation", async () => {
  const redis = new MemoryRedis();
  await savePayoutAccount(redis, { boothCode: "booth-one", bankCode: "ID_BRI", accountName: "Operator", accountNumber: "9988776655" }, "same-actor", environment);
  await assert.rejects(verifyPayoutAccount(redis, { boothCode: "booth-one", reference: "check" }, "same-actor"), /Maker dan verifier/);
  const account = await verifyPayoutAccount(redis, { boothCode: "booth-one", reference: "check" }, "other-actor");
  assert.equal(account.status, "verified");
  assert.equal((await getPayoutAccount(redis, "booth-one")).verificationReference, "check");
});

test("manual payout is idempotent and freezes all available balance", async () => {
  const redis = new MemoryRedis();
  await verifiedAccount(redis);
  await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
  assert.equal((await getPayoutPolicy(redis, "booth-one")).mode, "manual_superadmin");
  const first = await createManualPayout(redis, { boothCode: "booth-one", period: "2026-07-21", actorId: "finance-maker" }, { ledgerRecords: [ledger("booth-one")] });
  const replay = await createManualPayout(redis, { boothCode: "booth-one", period: "2026-07-21", actorId: "another-maker" }, { ledgerRecords: [ledger("booth-one")] });
  assert.equal(first.payout.amount, 90_000);
  assert.equal(first.payout.status, "pending_approval");
  assert.equal(replay.reused, true);
  assert.equal(replay.payout.id, first.payout.id);
  assert.equal((await listPayouts(redis)).length, 1);
});

test("manual payout cannot be created below minimum or without verified account", async () => {
  const redis = new MemoryRedis();
  await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 50_000 }, "finance-admin");
  await assert.rejects(createManualPayout(redis, { boothCode: "booth-one" }, { ledgerRecords: [ledger("booth-one")] }), /belum diverifikasi/);
  await verifiedAccount(redis);
  await assert.rejects(createManualPayout(redis, { boothCode: "booth-one" }, { ledgerRecords: [ledger("booth-one", 40_000)] }), /minimum payout/);
});

test("payout approval requires a different actor and stable account version", async () => {
  const redis = new MemoryRedis();
  await verifiedAccount(redis);
  await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
  const { payout } = await createManualPayout(redis, { boothCode: "booth-one", actorId: "maker" }, { ledgerRecords: [ledger("booth-one")] });
  await assert.rejects(approveManualPayout(redis, { id: payout.id }, "maker"), /Maker tidak boleh/);
  const approved = await approveManualPayout(redis, { id: payout.id }, "checker");
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, "checker");
});

test("payout mutations reject a second worker while the record lock is held", async () => {
  const redis = new MemoryRedis();
  await verifiedAccount(redis);
  await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
  const { payout } = await createManualPayout(redis, { boothCode: "booth-one", actorId: "maker" }, { ledgerRecords: [ledger("booth-one")] });
  const lockKey = payoutStorageKeys.payoutMutationLockKey(payout.id);
  await redis.set(lockKey, "other-worker");
  await assert.rejects(approveManualPayout(redis, { id: payout.id }, "checker"), /sedang diproses/);
  assert.equal((await getPayout(redis, payout.id)).status, "pending_approval");
  await redis.del(lockKey);
  assert.equal((await approveManualPayout(redis, { id: payout.id }, "checker")).status, "approved");
});

test("changing the bank account invalidates pending and approved payouts", async () => {
  const redis = new MemoryRedis();
  await verifiedAccount(redis);
  await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
  const { payout } = await createManualPayout(redis, { boothCode: "booth-one", actorId: "maker" }, { ledgerRecords: [ledger("booth-one")] });
  await approveManualPayout(redis, { id: payout.id }, "checker");
  const changed = await savePayoutAccount(redis, { boothCode: "booth-one", bankCode: "ID_BNI", accountName: "Zoe Owner", accountNumber: "111122223333" }, "account-editor", environment);
  assert.equal(changed.invalidatedPayouts, 1);
  const cancelled = await getPayout(redis, payout.id);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.cancellationReason, /Rekening payout berubah/);
});

test("mark paid requires verified proof, writes one immutable payout ledger, and is idempotent", async () => {
  const redis = new MemoryRedis();
  await verifiedAccount(redis);
  await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
  const { payout } = await createManualPayout(redis, { boothCode: "booth-one", period: "2026-07-21", actorId: "maker" }, { ledgerRecords: [ledger("booth-one")] });
  await approveManualPayout(redis, { id: payout.id }, "checker");
  await assert.rejects(markManualPayoutPaid(redis, { id: payout.id, transferReference: "TRX-1" }, "payer"), /Bukti transfer/);
  await attachPayoutProof(redis, { id: payout.id, objectKey: `payout-proofs/booth-one/${payout.id}/proof.pdf`, checksum: "a".repeat(64) }, "proof-uploader");
  const paid = await markManualPayoutPaid(redis, { id: payout.id, transferReference: "TRX-1" }, "payer");
  const replay = await markManualPayoutPaid(redis, { id: payout.id, transferReference: "TRX-1" }, "payer");
  assert.equal(paid.payout.status, "paid");
  assert.equal(paid.ledger.type, "payout");
  assert.equal(paid.ledger.boothEarning, -90_000);
  assert.equal(replay.reused, true);
  const records = await listPaymentLedger(redis, "booth-one");
  assert.equal(records.filter(entry => entry.type === "payout").length, 1);
  assert.equal(summarizeLedgerBalance([ledger("booth-one"), ...records]).availableBalance, 0);
});

test("proof scope and payout cancellation inputs are validated", async () => {
  const redis = new MemoryRedis();
  await verifiedAccount(redis);
  await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
  const { payout } = await createManualPayout(redis, { boothCode: "booth-one", actorId: "maker" }, { ledgerRecords: [ledger("booth-one")] });
  await approveManualPayout(redis, { id: payout.id }, "checker");
  await assert.rejects(attachPayoutProof(redis, { id: payout.id, objectKey: "other/proof.pdf", checksum: "a".repeat(64) }, "uploader"), /belum tervalidasi/);
  const cancelled = await cancelManualPayout(redis, { id: payout.id, reason: "Rekening belum siap" }, "finance-admin");
  assert.equal(cancelled.status, "cancelled");
});

test("payout control enforces finance RBAC, owner verification, and secret-safe audit", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousKeys = process.env.PAYOUT_VAULT_KEYS;
  const previousActive = process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.PAYOUT_VAULT_KEYS = environment.PAYOUT_VAULT_KEYS;
  process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION = environment.PAYOUT_VAULT_ACTIVE_KEY_VERSION;
  try {
    const redis = new MemoryRedis();
    await redis.set(boothKey("booth-one"), "machine-one");
    await redis.set(machineKey("machine-one"), { machineId: "machine-one", boothCode: "booth-one", name: "Booth One", accessEnabled: true });
    await redis.set("photoslive:user:booth-owner", { id: "booth-owner", boothCode: "booth-one", role: "owner", active: true, email: "owner@example.test" });
    await redis.sadd("photoslive:booth:booth-one:users", "booth-owner");
    await redis.set(sessionKey("auditor-session"), { id: "auditor-session", userId: "auditor-1", role: "superadmin", platformRole: "auditor", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("finance-session"), { id: "finance-session", userId: "finance-1", role: "superadmin", platformRole: "finance_admin", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("owner-session"), { id: "owner-session", userId: "owner-1", role: "superadmin", platformRole: "platform_owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set("photoslive:platform-staff:finance-1", { id: "finance-1", status: "active", passwordHash: await credentialHash("finance-password") });
    await redis.set("photoslive:platform-staff:owner-1", { id: "owner-1", status: "active", passwordHash: await credentialHash("owner-password") });
    const request = async (session, method = "GET") => new Request("https://photoslive.test/api/platform?action=finance_payout", { method, headers: { cookie: await signedCookie(session) } });
    assert.equal((await financePayoutControl(redis, await request("auditor-session"))).status, 200);
    assert.equal((await financePayoutControl(redis, await request("auditor-session", "POST"), { operation: "policy", boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 })).status, 403);
    assert.equal((await financePayoutControl(redis, await request("finance-session", "POST"), { operation: "policy", boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "corr-payout-policy")).status, 200);
    const missingPassword = await financePayoutControl(redis, await request("finance-session", "POST"), { operation: "account_save", boothCode: "booth-one", bankCode: "ID_BCA", accountName: "Owner", accountNumber: "1234567890" }, "corr-payout-reauth-missing");
    assert.equal(missingPassword.status, 401);
    assert.equal((await financePayoutControl(redis, await request("finance-session", "POST"), { operation: "account_save", boothCode: "booth-one", bankCode: "ID_BCA", accountName: "Owner", accountNumber: "1234567890", reauthPassword: "finance-password" }, "corr-payout-account")).status, 201);
    assert.equal((await financePayoutControl(redis, await request("finance-session", "POST"), { operation: "account_verify", boothCode: "booth-one", reference: "verified-bank" })).status, 403);
    assert.equal((await financePayoutControl(redis, await request("owner-session", "POST"), { operation: "account_verify", boothCode: "booth-one", reference: "verified-bank", reauthPassword: "owner-password" }, "corr-payout-verify")).status, 200);
    const changedResponse = await financePayoutControl(redis, await request("finance-session", "POST"), { operation: "account_save", boothCode: "booth-one", bankCode: "ID_BCA", accountName: "Owner", accountNumber: "9999999999", reauthPassword: "finance-password" }, "corr-payout-account-change");
    const changed = await changedResponse.json();
    assert.equal(changedResponse.status, 201);
    assert.equal(changed.account.version, 2);
    assert.equal(changed.alertDelivery.template, "system_alert");
    assert.match(changed.alertDelivery.recipient, /ow\*+@example\.test/);
    const audit = (await redis.lrange("photoslive:audit:global", 0, 20)).join("\n");
    assert.match(audit, /payout\.policy_updated/);
    assert.match(audit, /payout\.account_saved/);
    assert.match(audit, /payout\.account_verified/);
    assert.match(audit, /payout\.reauthentication_failed/);
    assert.doesNotMatch(audit, /1234567890|9999999999|PAYOUT_VAULT_KEYS/);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
    if (previousKeys === undefined) delete process.env.PAYOUT_VAULT_KEYS; else process.env.PAYOUT_VAULT_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION; else process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION = previousActive;
  }
});

test("paid payout stays final when summary email cannot be queued", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousKeys = process.env.PAYOUT_VAULT_KEYS;
  const previousActive = process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.PAYOUT_VAULT_KEYS = environment.PAYOUT_VAULT_KEYS;
  process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION = environment.PAYOUT_VAULT_ACTIVE_KEY_VERSION;
  try {
    const redis = new MemoryRedis();
    await redis.set(boothKey("booth-one"), "machine-one");
    await redis.set(machineKey("machine-one"), { machineId: "machine-one", boothCode: "booth-one", name: "Booth One", accessEnabled: true });
    await redis.set(sessionKey("owner-session"), { id: "owner-session", userId: "platform-owner", role: "superadmin", platformRole: "platform_owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set("photoslive:platform-staff:platform-owner", { id: "platform-owner", status: "active", passwordHash: await credentialHash("owner-password") });
    await redis.set("photoslive:user:booth-owner", { id: "booth-owner", boothCode: "booth-one", role: "owner", active: true, email: "owner@example.test" });
    await redis.sadd("photoslive:booth:booth-one:users", "booth-owner");
    await verifiedAccount(redis);
    await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
    const { payout } = await createManualPayout(redis, { boothCode: "booth-one", period: "2026-07-22", actorId: "maker" }, { ledgerRecords: [ledger("booth-one")] });
    await approveManualPayout(redis, { id: payout.id }, "checker");
    await attachPayoutProof(redis, { id: payout.id, objectKey: `payout-proofs/booth-one/${payout.id}/proof.pdf`, checksum: "a".repeat(64) }, "proof-uploader");
    redis.failEmailQueue = true;
    const request = new Request("https://photoslive.test/api/platform?action=finance_payout", { method: "POST", headers: { cookie: await signedCookie("owner-session") } });
    const response = await financePayoutControl(redis, request, { operation: "mark_paid", id: payout.id, transferReference: "TRX-FINAL", reauthPassword: "owner-password" }, "corr-email-outage");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.payout.status, "paid");
    assert.match(body.emailWarning, /email ringkasan belum berhasil/);
    assert.equal((await getPayout(redis, payout.id)).status, "paid");
    assert.match((await redis.lrange("photoslive:audit:global", 0, 20)).join("\n"), /payout\.email_enqueue_failed/);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
    if (previousKeys === undefined) delete process.env.PAYOUT_VAULT_KEYS; else process.env.PAYOUT_VAULT_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION; else process.env.PAYOUT_VAULT_ACTIVE_KEY_VERSION = previousActive;
  }
});

test("verified payout proof is exposed only as an audited five-minute signed link", async () => {
  const previous = Object.fromEntries(["SESSION_SECRET", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    SESSION_SECRET: sessionSecret,
    R2_ACCOUNT_ID: "account-test",
    R2_ACCESS_KEY_ID: "access-test",
    R2_SECRET_ACCESS_KEY: "secret-test",
    R2_BUCKET: "proofs-test",
  });
  try {
    const redis = new MemoryRedis();
    await redis.set(boothKey("booth-one"), "machine-one");
    await redis.set(machineKey("machine-one"), { machineId: "machine-one", boothCode: "booth-one", name: "Booth One", accessEnabled: true });
    await redis.set(sessionKey("auditor-session"), { id: "auditor-session", userId: "auditor-1", role: "superadmin", platformRole: "auditor", expiresAt: "2099-01-01T00:00:00.000Z" });
    await verifiedAccount(redis);
    await setPayoutPolicy(redis, { boothCode: "booth-one", mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
    const { payout } = await createManualPayout(redis, { boothCode: "booth-one", actorId: "maker" }, { ledgerRecords: [ledger("booth-one")] });
    await approveManualPayout(redis, { id: payout.id }, "checker");
    await attachPayoutProof(redis, { id: payout.id, objectKey: `payout-proofs/booth-one/${payout.id}/proof.pdf`, checksum: "a".repeat(64), provider: "cloudflare-r2" }, "proof-uploader");
    const request = new Request("https://photoslive.test/api/platform?action=finance_payout", { headers: { cookie: await signedCookie("auditor-session") } });
    const response = await financePayoutControl(redis, request, { operation: "proof_download", id: payout.id }, "corr-proof-view");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(body.download.url, /^https:\/\/account-test\.r2\.cloudflarestorage\.com\/proofs-test\/payout-proofs\//);
    assert.match(body.download.url, /X-Amz-Expires=300/);
    const remaining = Date.parse(body.download.expiresAt) - Date.now();
    assert.ok(remaining > 290_000 && remaining <= 301_000);
    assert.match((await redis.lrange("photoslive:audit:global", 0, 20)).join("\n"), /payout\.proof_viewed/);
    assert.doesNotMatch(JSON.stringify(body), /secret-test|R2_SECRET_ACCESS_KEY/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("superadmin payout UI exposes the complete real workflow without account secrets", () => {
  const html = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(html, /id="finance-payout-card"/);
  assert.match(html, /id="finance-payout-proof-file"/);
  assert.match(html, /id="finance-payout-action-password"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(script, /operation: "account_save"/);
  assert.match(script, /operation: "account_verify"/);
  assert.match(script, /operation: "proof_prepare"/);
  assert.match(script, /operation: "proof_finalize"/);
  assert.match(script, /operation=proof_download/);
  assert.match(script, /operation: "mark_paid"/);
  assert.match(script, /reauthPassword/);
  assert.match(script, /result\.emailWarning/);
  assert.doesNotMatch(script, /1234567890|PAYOUT_VAULT_KEYS/);
});
