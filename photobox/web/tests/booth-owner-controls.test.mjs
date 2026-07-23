import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { boothFinanceControl, boothIntegrationsControl } from "../api/platform.mjs";
import { saveProviderConnection } from "../api/_provider_connections.mjs";
import { paymentStorageKeys } from "../api/_payments.mjs";
import { boothKey, machineKey, sessionKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async sadd(key, ...values) { const set = this.sets.get(key) || new Set(); values.forEach(value => set.add(value)); this.sets.set(key, set); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || [])]; }
  async mget(...keys) { return Promise.all(keys.map(key => this.get(key))); }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
}

const secret = "booth-owner-control-test-session-secret-2026";
async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const signature = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${signature}`)}`;
}

async function fixture(role = "owner") {
  process.env.SESSION_SECRET = secret;
  const redis = new MemoryRedis();
  await redis.set(boothKey("booth-a"), "machine-a");
  await redis.set(machineKey("machine-a"), { id: "machine-a", boothCode: "booth-a", name: "Booth A", accessEnabled: true });
  await redis.set(sessionKey(`session-${role}`), { id: `session-${role}`, userId: `user-${role}`, boothCode: "booth-a", role, expiresAt: "2099-01-01T00:00:00.000Z" });
  return { redis, cookie: await signedCookie(`session-${role}`) };
}

test("booth integrations are tenant-scoped, masked, and owner-only", async () => {
  const { redis, cookie } = await fixture();
  await saveProviderConnection(redis, { providerId: "resend", scope: "global", source: "platform-managed" }, "superadmin", {});
  await saveProviderConnection(redis, { providerId: "cloudflare-r2", scope: "booth", targetId: "booth-a", source: "platform-managed" }, "superadmin", {});
  await saveProviderConnection(redis, { providerId: "xendit", scope: "booth", targetId: "booth-b", source: "platform-managed" }, "superadmin", {});
  const response = await boothIntegrationsControl(redis, new Request("https://photoslive.test/api/platform?action=booth_integrations", { headers: { cookie } }), { boothCode: "booth-a" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.connections.map(item => item.providerId).sort(), ["cloudflare-r2", "resend"]);
  assert.equal(body.permissions.canManageCredentials, false);
  assert.doesNotMatch(JSON.stringify(body.connections), /ciphertext|sealed|credentialEnvelope|super-secret/i);
  assert.ok(body.connections.every(item => item.credentialFields.length === 0));
  const operator = await fixture("operator");
  assert.equal((await boothIntegrationsControl(operator.redis, new Request("https://photoslive.test", { headers: { cookie: operator.cookie } }), { boothCode: "booth-a" })).status, 403);
});

test("booth finance returns only the authenticated booth ledger and rejects mutation", async () => {
  const { redis, cookie } = await fixture();
  const ownEntry = { id: "ledger-own", boothCode: "booth-a", type: "payment_captured", currency: "IDR", gross: 35_000, platformFee: 3_500, providerFee: 1_000, boothEarning: 30_500, createdAt: "2026-07-22T01:00:00.000Z" };
  const foreignEntry = { ...ownEntry, id: "ledger-foreign", boothCode: "booth-b", boothEarning: 999_999 };
  await redis.set(paymentStorageKeys.ledgerKey(ownEntry.id), ownEntry);
  await redis.set(paymentStorageKeys.ledgerKey(foreignEntry.id), foreignEntry);
  await redis.lpush(paymentStorageKeys.ledgerIndexKey("booth-a"), ownEntry.id);
  await redis.lpush(paymentStorageKeys.ledgerIndexKey("booth-b"), foreignEntry.id);
  const payment = { id: "pay-own", boothCode: "booth-a", sessionId: "session-a", purpose: "session", amount: 35_000, currency: "IDR", provider: "xendit", providerPaymentId: "provider-a", status: "paid", createdAt: "2026-07-22T01:00:00.000Z", updatedAt: "2026-07-22T01:01:00.000Z" };
  await redis.set(paymentStorageKeys.paymentKey(payment.id), payment);
  await redis.lpush(paymentStorageKeys.paymentIndexKey("booth-a"), payment.id);
  const request = new Request("https://photoslive.test/api/platform?action=booth_finance", { headers: { cookie } });
  const response = await boothFinanceControl(redis, request, { boothCode: "booth-a" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.entries.length, 1);
  assert.equal(body.entries[0].id, ownEntry.id);
  assert.equal(body.balance.totalBalance, 30_500);
  assert.equal(body.report.payments.length, 1);
  assert.equal(body.report.payments[0].id, payment.id);
  assert.equal(body.report.totals.gross, 35_000);
  assert.equal(body.report.totals.providerFee, 1_000);
  assert.equal(body.report.totals.platformFee, 3_500);
  assert.equal(body.report.totals.totalBalance, 30_500);
  assert.equal(JSON.stringify(body).includes("999999"), false);
  const mutation = await boothFinanceControl(redis, new Request("https://photoslive.test", { method: "POST", headers: { cookie } }), { boothCode: "booth-a" });
  assert.equal(mutation.status, 405);
  const operator = await fixture("operator");
  assert.equal((await boothFinanceControl(operator.redis, new Request("https://photoslive.test", { headers: { cookie: operator.cookie } }), { boothCode: "booth-a" })).status, 403);
});

test("admin integrations and finance UI have real loading, retry, and API handlers", () => {
  const html = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(html, /id="integrations-view"/);
  assert.match(html, /id="finance-view"/);
  assert.match(script, /platformApi\("booth_integrations"/);
  assert.match(script, /platformApi\("booth_finance"/);
  assert.match(script, /retry-integrations/);
  assert.match(script, /retry-finance/);
  assert.match(html, /id="finance-date-from"/);
  assert.match(html, /id="finance-payment-rows"/);
  assert.match(html, /id="export-finance-csv"/);
  assert.match(script, /exportBoothFinanceCsv/);
  assert.match(script, /text\/csv/);
  assert.match(html, /Credential dilindungi superadmin/);
});
