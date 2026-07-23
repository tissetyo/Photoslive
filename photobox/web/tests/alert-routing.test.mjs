import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { enqueueIncidentAlert, listAlertDeliveries, probeMonitoringWebhook, processAlertDeliveries, retryAlertDelivery } from "../api/_alert_routing.mjs";
import { evaluateMachineHealth, resolveMachineIncident } from "../api/_fleet_health.mjs";
import { deploymentCapabilities, providerDefinitions } from "../api/_providers.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
}

const incident = {
  id: "incident-1", severity: "critical", machineId: "machine-1", boothCode: "lobby-1",
  organizationId: "org-1", machineName: "Lobby Booth", openedAt: "2026-07-21T00:00:00.000Z",
};
const environment = {
  MONITORING_WEBHOOK_URL: "https://monitor.example.test/photoslive",
  MONITORING_WEBHOOK_SECRET: "monitoring-secret-long-enough",
};

test("monitoring webhook is a real provider capability", () => {
  assert.equal(providerDefinitions()["monitoring-webhook"].adapterImplemented, true);
  assert.equal(deploymentCapabilities(environment).monitoringAlert.available, true);
});

test("monitoring provider test sends a signed non-operational test event", async () => {
  let captured;
  const check = await probeMonitoringWebhook({ environment, fetchImpl: async (url, options) => {
    captured = { url, options };
    return new Response(null, { status: 204 });
  } });
  assert.equal(check.state, "ready");
  assert.equal(captured.url, environment.MONITORING_WEBHOOK_URL);
  assert.equal(captured.options.headers["x-photoslive-event"], "photoslive.integration.test");
  assert.match(captured.options.headers["x-photoslive-signature"], /^sha256=[a-f0-9]{64}$/);
});

test("incident alert enqueue is deduplicated and safe projection excludes credentials", async () => {
  const redis = new MemoryRedis();
  const first = await enqueueIncidentAlert(redis, incident);
  const repeated = await enqueueIncidentAlert(redis, incident);
  assert.equal(first.id, repeated.id);
  assert.equal((await listAlertDeliveries(redis)).length, 1);
  assert.doesNotMatch(JSON.stringify(await listAlertDeliveries(redis)), /monitoring-secret|webhook_url/i);
});

test("alert delivery signs the exact body and persists only safe status", async () => {
  const redis = new MemoryRedis();
  await enqueueIncidentAlert(redis, incident);
  const atMs = Date.now() + 1_000;
  let request;
  const result = await processAlertDeliveries(redis, {
    environment,
    atMs,
    fetchImpl: async (url, options) => { request = { url, options }; return new Response(null, { status: 204 }); },
  });
  assert.equal(result.delivered, 1);
  assert.equal(request.url, environment.MONITORING_WEBHOOK_URL);
  assert.equal(request.options.headers["idempotency-key"], request.options.headers["x-photoslive-delivery"]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(environment.MONITORING_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(request.options.body));
  const expected = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(request.options.headers["x-photoslive-signature"], `sha256=${expected}`);
  const listed = await listAlertDeliveries(redis);
  assert.equal(listed[0].status, "delivered");
  assert.doesNotMatch(JSON.stringify([...redis.values.values()]), /monitoring-secret-long-enough|monitor\.example\.test/);
});

test("missing provider waits safely and failed webhook uses backoff plus manual retry", async () => {
  const redis = new MemoryRedis();
  await enqueueIncidentAlert(redis, incident);
  const atMs = Date.now() + 1_000;
  const missing = await processAlertDeliveries(redis, { environment: {}, atMs, fetchImpl: async () => { throw new Error("should not run"); } });
  assert.equal(missing.waiting, 1);
  let [delivery] = await listAlertDeliveries(redis);
  assert.equal(delivery.status, "waiting_configuration");
  await retryAlertDelivery(redis, delivery.id, "fleet-admin");
  const retryAtMs = atMs + 1_000;
  const failed = await processAlertDeliveries(redis, { environment, atMs: retryAtMs, fetchImpl: async () => new Response(null, { status: 503 }) });
  assert.equal(failed.retrying, 1);
  [delivery] = await listAlertDeliveries(redis);
  assert.equal(delivery.status, "retry");
  assert.equal(delivery.lastError, "Webhook merespons HTTP 503");
  assert.ok(Date.parse(delivery.nextAttemptAt) > retryAtMs);
});

test("fleet recovery creates a separate deduplicated resolved alert", async () => {
  const redis = new MemoryRedis();
  const machine = { id: "machine-2", boothCode: "lobby-2", organizationId: "org-2", name: "Lobby 2", lastSeenAt: "2026-07-21T00:00:00.000Z" };
  await evaluateMachineHealth(redis, machine, Date.parse("2026-07-21T00:10:00.000Z"));
  await resolveMachineIncident(redis, machine, "2026-07-21T00:11:00.000Z");
  await resolveMachineIncident(redis, machine, "2026-07-21T00:12:00.000Z");
  const deliveries = await listAlertDeliveries(redis);
  assert.deepEqual(deliveries.map(item => item.eventType).sort(), ["fleet.incident.opened", "fleet.incident.resolved"]);
});

test("superadmin alert routing exposes working process and retry controls", () => {
  const html = fs.readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");
  assert.match(html, /id="alert-routing-card"/);
  assert.match(html, /id="alert-routing-process"/);
  assert.match(script, /data-retry-alert/);
  assert.match(script, /operation: "process"/);
  assert.match(api, /action === "alert_routing"/);
});
