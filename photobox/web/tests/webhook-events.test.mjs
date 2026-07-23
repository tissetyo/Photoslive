import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { appendWebhookEvent, listWebhookEvents, webhookEventStorage } from "../api/_webhook_events.mjs";
import { webhookEventsControl, xenditWebhookControl } from "../api/platform.mjs";
import { sessionKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, structuredClone(value)); return "OK"; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(structuredClone(value)); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
}

const secret = "webhook-event-control-session-secret-2026";
async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const hex = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${hex}`)}`;
}

test("webhook log is bounded, summarized, and redacts provider event identity", async () => {
  const redis = new MemoryRedis();
  await appendWebhookEvent(redis, { provider: "xendit", providerEventId: "provider-secret-event-id", eventType: "payment.capture", boothCode: "booth-one", paymentId: "pay-one", state: "succeeded", httpStatus: 200, latencyMs: 12.34 });
  await appendWebhookEvent(redis, { provider: "xendit", providerEventId: "provider-secret-event-id-2", eventType: "payment.failure", state: "failed", httpStatus: 409, error: "Nominal tidak sesuai" });
  const result = await listWebhookEvents(redis, 100);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.succeeded, 1);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.records[1].latencyMs, 12.3);
  assert.doesNotMatch(JSON.stringify(result), /provider-secret-event-id/);
  assert.equal(webhookEventStorage.maxEvents, 500);
});

test("failed Xendit delivery is recorded without raw payload or callback token", async () => {
  const redis = new MemoryRedis();
  const request = new Request("https://photoslive.test/api/platform?action=xendit_webhook", { method: "POST", headers: { "x-callback-token": "never-store-this-token", "webhook-id": "private-event-reference" } });
  const response = await xenditWebhookControl(redis, request, { event: "payment.capture", data: { payment_request_id: "missing-payment", private_customer_value: "never-store-this-payload" } }, "corr-webhook-failure");
  assert.equal(response.status, 404);
  const result = await listWebhookEvents(redis);
  assert.equal(result.records[0].state, "failed");
  assert.equal(result.records[0].correlationId, "corr-webhook-failure");
  assert.doesNotMatch(JSON.stringify(result), /never-store-this-token|never-store-this-payload|private-event-reference/);
});

test("webhook event endpoint enforces finance read permission", async () => {
  const redis = new MemoryRedis();
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = secret;
  try {
    await redis.set(sessionKey("auditor-session"), { id: "auditor-session", userId: "auditor", role: "superadmin", platformRole: "auditor", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("support-session"), { id: "support-session", userId: "support", role: "superadmin", platformRole: "support", expiresAt: "2099-01-01T00:00:00.000Z" });
    const request = async id => new Request("https://photoslive.test/api/platform?action=webhook_events", { headers: { cookie: await signedCookie(id) } });
    assert.equal((await webhookEventsControl(redis, await request("auditor-session"))).status, 200);
    assert.equal((await webhookEventsControl(redis, await request("support-session"))).status, 403);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous;
  }
});

test("superadmin renders webhook metrics, safe empty state, and retry control", () => {
  const html = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(html, /id="webhook-events-card"/);
  assert.match(html, /id="webhook-events-retry"/);
  assert.match(html, /id="webhook-summary-failed"/);
  assert.match(script, /api\("webhook_events&limit=100"\)/);
  assert.match(script, /renderWebhookEventsError/);
  assert.match(script, /platform\.finance\.read/);
});
