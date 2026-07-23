import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  listProviderEconomics,
  PROVIDER_USAGE_SNAPSHOT_LIMIT,
  providerQuotaDecision,
  recordProviderUsageSnapshot,
  saveProviderEntitlement,
} from "../api/_provider_economics.mjs";
import { providerEconomicsControl } from "../api/platform.mjs";
import { sessionKey } from "../api/_store.mjs";

class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async sadd(key, ...values) { const set = this.sets.get(key) || new Set(); values.forEach(value => set.add(value)); this.sets.set(key, set); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(structuredClone(value)); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
  pipeline() { const queue = []; return { lpush: (...args) => queue.push(() => this.lpush(...args)), ltrim: (...args) => queue.push(() => this.ltrim(...args)), exec: async () => Promise.all(queue.map(operation => operation())) }; }
}

const context = { providerId: "cloudflare-r2", scope: "booth", targetId: "booth-a" };

test("provider entitlement combines free allowance and paid add-on into an enforceable quota", async () => {
  const redis = new FakeRedis();
  const saved = await saveProviderEntitlement(redis, { ...context, plan: "addon", metric: "bytes", allowance: 1_000, addon: 500, monthlyPriceIdr: 49_000, hardLimit: true }, "integration-admin");
  assert.equal(saved.allowance, 1_000);
  assert.equal(saved.addon, 500);
  assert.equal(saved.monthlyPriceIdr, 49_000);
  await recordProviderUsageSnapshot(redis, { ...context, metric: "bytes", used: 1_250 });
  const result = await listProviderEconomics(redis);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.warning, 1);
  assert.deepEqual(result.records[0].quota, { used: 1_250, limit: 1_500, remaining: 250, percent: 83.3, state: "warning", allowed: true });
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

test("hard quota blocks new usage while warning-only plan remains allowed", async () => {
  const redis = new FakeRedis();
  await saveProviderEntitlement(redis, { ...context, plan: "free", metric: "requests", allowance: 100, addon: 0, hardLimit: true }, "owner");
  await recordProviderUsageSnapshot(redis, { ...context, metric: "requests", used: 100 });
  assert.deepEqual(await providerQuotaDecision(redis, context), { used: 100, limit: 100, remaining: 0, percent: 100, state: "exhausted", allowed: false });
  await saveProviderEntitlement(redis, { ...context, plan: "managed", metric: "requests", allowance: 100, addon: 0, hardLimit: false }, "owner");
  assert.equal((await providerQuotaDecision(redis, context)).allowed, true);
});

test("usage history is bounded and invalid economic data is rejected", async () => {
  const redis = new FakeRedis();
  await saveProviderEntitlement(redis, { ...context, plan: "free", metric: "requests", allowance: 100, addon: 0 }, "owner");
  for (let index = 0; index < PROVIDER_USAGE_SNAPSHOT_LIMIT + 12; index += 1) await recordProviderUsageSnapshot(redis, { ...context, metric: "requests", used: index });
  const key = [...redis.lists.keys()][0];
  assert.equal(redis.lists.get(key).length, PROVIDER_USAGE_SNAPSHOT_LIMIT);
  await assert.rejects(() => saveProviderEntitlement(redis, { ...context, plan: "unlimited", metric: "requests", allowance: 1 }, "owner"), /Plan provider tidak valid/);
  await assert.rejects(() => recordProviderUsageSnapshot(redis, { ...context, metric: "secret", used: 1 }), /Metrik pemakaian tidak valid/);
});

const sessionSecret = "provider-economics-session-secret-2026";
async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const hex = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${hex}`)}`;
}

test("provider economics API is role-protected, persistent, and secret-safe", async () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = sessionSecret;
  try {
    const redis = new FakeRedis();
    await redis.set(sessionKey("integration"), { id: "integration", userId: "integration-1", role: "superadmin", platformRole: "integration_admin", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("auditor"), { id: "auditor", userId: "audit-1", role: "superadmin", platformRole: "auditor", expiresAt: "2099-01-01T00:00:00.000Z" });
    const integrationCookie = await signedCookie("integration");
    const auditorCookie = await signedCookie("auditor");
    const globalContext = { providerId: "cloudflare-r2", scope: "global", targetId: "" };
    const saved = await providerEconomicsControl(redis, new Request("https://photoslive.test/api/platform?action=provider_economics", { method: "POST", headers: { cookie: integrationCookie } }), { operation: "save_entitlement", ...globalContext, plan: "free", metric: "bytes", allowance: 5_000, addon: 0, hardLimit: true });
    assert.equal(saved.status, 200);
    const denied = await providerEconomicsControl(redis, new Request("https://photoslive.test/api/platform?action=provider_economics", { method: "POST", headers: { cookie: auditorCookie } }), { operation: "record_usage", ...globalContext, metric: "bytes", used: 10 });
    assert.equal(denied.status, 403);
    const read = await providerEconomicsControl(redis, new Request("https://photoslive.test/api/platform?action=provider_economics", { headers: { cookie: auditorCookie } }));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).records.length, 1);
    const audit = (await redis.lrange("photoslive:audit:global", 0, 9)).join("\n");
    assert.match(audit, /provider_entitlement\.updated/);
    assert.doesNotMatch(audit, /secret|credential|api.?key/i);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous;
  }
});

test("superadmin provider economics UI exposes real loading, empty, retry, save, and error states", () => {
  const html = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(html, /id="provider-economics-card"/);
  assert.match(html, /id="provider-entitlement-form"/);
  assert.match(html, /Memuat plan provider/);
  assert.match(script, /refreshProviderEconomics/);
  assert.match(script, /provider_economics/);
  assert.match(script, /Plan provider tidak dapat dimuat/);
  assert.match(script, /Plan, allowance, add-on, dan snapshot pemakaian tersimpan/);
});
