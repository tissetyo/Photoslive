import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getFinanceRisk, listFinanceRisks, recordFinanceRisk, reviewFinanceRisk, summarizeFinanceRisks } from "../api/_finance_risk.mjs";
import { approveManualPayout, attachPayoutProof, createManualPayout, markManualPayoutPaid, savePayoutAccount, setPayoutPolicy, verifyPayoutAccount } from "../api/_payouts.mjs";
import { financePayoutControl, financeRiskControl } from "../api/platform.mjs";
import { boothKey, machineKey, sessionKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); this.sets = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, structuredClone(value)); return "OK"; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
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

const sessionSecret = "finance-risk-session-secret-tests-2026";
const vaultEnvironment = {
  PAYOUT_VAULT_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 11).toString("base64url") }),
  PAYOUT_VAULT_ACTIVE_KEY_VERSION: "v1",
};

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

const ledger = (boothCode, amount, id) => ({
  id, boothCode, paymentId: `pay-${id}`, type: "payment_captured", currency: "IDR", gross: amount,
  providerFee: 0, providerFeeFinal: true, platformFee: 0, boothEarning: amount,
  provider: "xendit", providerPaymentId: `provider-${id}`, createdAt: new Date().toISOString(),
});

async function createApprovedPayout(redis, boothCode, amount, suffix) {
  await savePayoutAccount(redis, { boothCode, bankCode: "ID_BCA", accountName: `Owner ${suffix}`, accountNumber: `12345678${suffix}` }, `maker-${suffix}`, vaultEnvironment);
  await verifyPayoutAccount(redis, { boothCode, reference: `verified-${suffix}` }, `checker-${suffix}`);
  await setPayoutPolicy(redis, { boothCode, mode: "manual_superadmin", minimumAmount: 10_000 }, "finance-admin");
  const { payout } = await createManualPayout(redis, { boothCode, period: `2026-07-${suffix}`, actorId: `maker-payout-${suffix}` }, { ledgerRecords: [ledger(boothCode, amount, `ledger-${suffix}`)] });
  await approveManualPayout(redis, { id: payout.id }, `approver-${suffix}`);
  await attachPayoutProof(redis, { id: payout.id, objectKey: `payout-proofs/${boothCode}/${payout.id}/proof.pdf`, checksum: "a".repeat(64) }, `proof-${suffix}`);
  return payout;
}

test("finance risk cases are deduplicated, persistent, filterable, and reviewable", async () => {
  const redis = new MemoryRedis();
  const first = await recordFinanceRisk(redis, {
    rule: "high_value_payout", severity: "high", boothCode: "booth-one", entityType: "payout", entityId: "payout-1",
    title: "Payout nominal tinggi", metadata: { amount: 12_000_000, secret: null },
  }, "rule-engine");
  const duplicate = await recordFinanceRisk(redis, {
    rule: "high_value_payout", severity: "high", boothCode: "booth-one", entityType: "payout", entityId: "payout-1",
    title: "Payout nominal tinggi", metadata: { amount: 12_000_000 },
  }, "rule-engine");
  assert.equal(first.reused, false);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.risk.occurrenceCount, 2);
  assert.equal((await listFinanceRisks(redis, { status: "open" })).length, 1);
  const acknowledged = await reviewFinanceRisk(redis, { id: first.risk.id, operation: "acknowledge", note: "Rekening dan saldo sedang diperiksa" }, "finance-admin");
  assert.equal(acknowledged.risk.status, "acknowledged");
  const resolved = await reviewFinanceRisk(redis, { id: first.risk.id, operation: "resolve", note: "Saldo dan rekening cocok dengan laporan bank" }, "platform-owner");
  assert.equal(resolved.risk.status, "resolved");
  assert.equal((await getFinanceRisk(redis, first.risk.id)).history.length, 3);
  assert.deepEqual(summarizeFinanceRisks(await listFinanceRisks(redis)), { total: 1, open: 0, acknowledged: 0, resolved: 1, low: 0, medium: 0, high: 1, critical: 0 });
});

test("a transfer reference can finalize only one payout", async () => {
  const redis = new MemoryRedis();
  const first = await createApprovedPayout(redis, "booth-one", 90_000, "21");
  const second = await createApprovedPayout(redis, "booth-two", 80_000, "22");
  await markManualPayoutPaid(redis, { id: first.id, transferReference: "BANK-REFERENCE-1" }, "platform-owner");
  await assert.rejects(markManualPayoutPaid(redis, { id: second.id, transferReference: "bank-reference-1" }, "platform-owner"), error => {
    assert.equal(error.status, 409);
    assert.equal(error.riskCode, "duplicate_transfer_reference");
    assert.equal(error.existingPayoutId, first.id);
    return true;
  });
});

test("risk control enforces read, acknowledge, owner resolve, reauthentication, and audit", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = sessionSecret;
  try {
    const redis = new MemoryRedis();
    await redis.set(sessionKey("auditor-session"), { id: "auditor-session", userId: "auditor-1", role: "superadmin", platformRole: "auditor", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("finance-session"), { id: "finance-session", userId: "finance-1", role: "superadmin", platformRole: "finance_admin", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("owner-session"), { id: "owner-session", userId: "owner-1", role: "superadmin", platformRole: "platform_owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set("photoslive:platform-staff:owner-1", { id: "owner-1", status: "active", passwordHash: await credentialHash("owner-password") });
    const { risk } = await recordFinanceRisk(redis, { rule: "payout_account_changed", severity: "high", boothCode: "booth-one", entityType: "payout_account", entityId: "booth-one:v2", title: "Rekening berubah" });
    const request = async (session, method = "GET") => new Request("https://photoslive.test/api/platform?action=finance_risk", { method, headers: { cookie: await signedCookie(session) } });
    assert.equal((await financeRiskControl(redis, await request("auditor-session"))).status, 200);
    assert.equal((await financeRiskControl(redis, await request("auditor-session", "POST"), { operation: "acknowledge", id: risk.id, note: "Sedang diperiksa" })).status, 403);
    assert.equal((await financeRiskControl(redis, await request("finance-session", "POST"), { operation: "acknowledge", id: risk.id, note: "Rekening dikonfirmasi ke owner" }, "corr-risk-ack")).status, 200);
    assert.equal((await financeRiskControl(redis, await request("finance-session", "POST"), { operation: "resolve", id: risk.id, note: "Selesai" })).status, 403);
    assert.equal((await financeRiskControl(redis, await request("owner-session", "POST"), { operation: "resolve", id: risk.id, note: "Bukti rekening sudah cocok" }, "corr-risk-no-password")).status, 401);
    const resolved = await financeRiskControl(redis, await request("owner-session", "POST"), { operation: "resolve", id: risk.id, note: "Bukti rekening sudah cocok", reauthPassword: "owner-password" }, "corr-risk-resolve");
    assert.equal(resolved.status, 200);
    assert.equal((await resolved.json()).risk.status, "resolved");
    const audit = (await redis.lrange("photoslive:audit:global", 0, 20)).join("\n");
    assert.match(audit, /finance\.risk_acknowledged/);
    assert.match(audit, /finance\.risk_resolved/);
    assert.match(audit, /finance\.risk_reauthentication_failed/);
    assert.doesNotMatch(audit, /owner-password/);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
  }
});

test("duplicate payout finalization creates a critical persistent risk and audit event", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = sessionSecret;
  try {
    const redis = new MemoryRedis();
    for (const [boothCode, machineId] of [["booth-one", "machine-one"], ["booth-two", "machine-two"]]) {
      await redis.set(boothKey(boothCode), machineId);
      await redis.set(machineKey(machineId), { machineId, boothCode, name: boothCode, accessEnabled: true });
    }
    await redis.set(sessionKey("owner-session"), { id: "owner-session", userId: "owner-1", role: "superadmin", platformRole: "platform_owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set("photoslive:platform-staff:owner-1", { id: "owner-1", status: "active", passwordHash: await credentialHash("owner-password") });
    const first = await createApprovedPayout(redis, "booth-one", 90_000, "23");
    const second = await createApprovedPayout(redis, "booth-two", 80_000, "24");
    await markManualPayoutPaid(redis, { id: first.id, transferReference: "DUPLICATE-REF" }, "owner-1");
    const request = new Request("https://photoslive.test/api/platform?action=finance_payout", { method: "POST", headers: { cookie: await signedCookie("owner-session") } });
    const response = await financePayoutControl(redis, request, { operation: "mark_paid", id: second.id, transferReference: "duplicate-ref", reauthPassword: "owner-password" }, "corr-duplicate-ref");
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /sudah digunakan/);
    const risks = await listFinanceRisks(redis, { severity: "critical" });
    assert.equal(risks.length, 1);
    assert.equal(risks[0].rule, "duplicate_transfer_reference");
    assert.equal(risks[0].metadata.existingpayoutid, first.id);
    assert.match((await redis.lrange("photoslive:audit:global", 0, 20)).join("\n"), /payout\.duplicate_transfer_blocked/);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
  }
});

test("superadmin risk UI exposes filters, retry, real review actions, and reauthentication", () => {
  const html = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(html, /id="finance-risk-card"/);
  assert.match(html, /id="finance-risk-status-filter"/);
  assert.match(html, /id="finance-risk-severity-filter"/);
  assert.match(html, /id="finance-risk-action-password"/);
  assert.match(script, /api\("finance_risk"/);
  assert.match(script, /data-finance-risk-action="acknowledge"/);
  assert.match(script, /data-finance-risk-action="resolve"/);
  assert.match(script, /refreshFinanceRisks/);
});
