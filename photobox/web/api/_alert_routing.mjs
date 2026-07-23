import { now, randomId } from "./_store.mjs";
import { resolveProviderRuntimeForCapability } from "./_provider_connections.mjs";

const INDEX_KEY = "photoslive:alert-deliveries";
const deliveryKey = id => `photoslive:alert-delivery:${id}`;
const dedupeKey = (eventType, incidentId) => `photoslive:alert-dedupe:${eventType}:${incidentId}`;
const encoder = new TextEncoder();
const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 5_000;

const safeText = (value, length = 240) => String(value || "").slice(0, length);
const dueAt = (attempts, atMs) => new Date(atMs + Math.min(3_600_000, 15_000 * (2 ** Math.max(0, attempts - 1)))).toISOString();

export function safeAlertDelivery(record) {
  if (!record) return null;
  return {
    id: safeText(record.id, 120),
    incidentId: safeText(record.incidentId, 120),
    eventType: safeText(record.eventType, 120),
    severity: safeText(record.severity, 40),
    machineId: safeText(record.machineId, 120),
    boothCode: safeText(record.boothCode, 100),
    organizationId: safeText(record.organizationId, 100),
    machineName: safeText(record.machineName, 120),
    status: ["queued", "retry", "waiting_configuration", "delivered", "failed"].includes(record.status) ? record.status : "failed",
    attempts: Math.max(0, Number(record.attempts || 0)),
    nextAttemptAt: record.nextAttemptAt || null,
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    deliveredAt: record.deliveredAt || null,
    lastError: safeText(record.lastError, 240) || null,
  };
}

export async function enqueueIncidentAlert(redis, incident, eventType = "fleet.incident.opened") {
  if (!incident?.id) throw new Error("Insiden alert tidak valid");
  const dedupe = dedupeKey(eventType, incident.id);
  const id = randomId("alert");
  const acquired = await redis.set(dedupe, id, { nx: true, ex: 60 * 60 * 24 * 30 });
  if (!acquired) {
    const existingId = await redis.get(dedupe);
    return existingId ? safeAlertDelivery(await redis.get(deliveryKey(existingId))) : null;
  }
  const timestamp = now();
  const record = {
    id,
    incidentId: incident.id,
    eventType,
    severity: incident.severity || "critical",
    machineId: incident.machineId || "",
    boothCode: incident.boothCode || "",
    organizationId: incident.organizationId || "",
    machineName: incident.machineName || "Photoslive Booth",
    status: "queued",
    attempts: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    deliveredAt: null,
    lastError: null,
  };
  await redis.set(deliveryKey(id), record);
  await redis.lpush(INDEX_KEY, id);
  await redis.ltrim(INDEX_KEY, 0, 499);
  return safeAlertDelivery(record);
}

export async function listAlertDeliveries(redis, limit = 100) {
  const bounded = Math.max(1, Math.min(200, Number(limit || 100)));
  const ids = await redis.lrange(INDEX_KEY, 0, bounded - 1);
  const records = (await Promise.all(ids.map(id => redis.get(deliveryKey(id))))).filter(Boolean);
  return records.map(safeAlertDelivery).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function webhookUrl(value) {
  let url;
  try { url = new URL(String(value || "")); }
  catch { throw new Error("URL monitoring webhook tidak valid"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Monitoring webhook wajib memakai HTTPS tanpa credential pada URL");
  return url.toString();
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function probeMonitoringWebhook({ environment = process.env, fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  const startedAt = performance.now();
  const checkedAt = now();
  const id = randomId("alert-test");
  const body = JSON.stringify({ id, event: "photoslive.integration.test", createdAt: checkedAt });
  const controller = new AbortController();
  let timer;
  try {
    const url = webhookUrl(environment.MONITORING_WEBHOOK_URL);
    const secret = String(environment.MONITORING_WEBHOOK_SECRET || "");
    if (secret.length < 16) throw new Error("Signing secret monitoring webhook terlalu pendek");
    const signature = await hmacHex(secret, body);
    timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(10_000, Number(timeoutMs || 3_000))));
    const response = await fetchImpl(url, { method: "POST", headers: {
      "content-type": "application/json", "user-agent": "Photoslive-Alert-Router/1.0",
      "x-photoslive-event": "photoslive.integration.test", "x-photoslive-delivery": id,
      "x-photoslive-signature": `sha256=${signature}`, "idempotency-key": id,
    }, body, signal: controller.signal });
    if (!response.ok) throw new Error(`Webhook merespons HTTP ${response.status}`);
    return { provider: "monitoring-webhook", state: "ready", latencyMs: Math.round((performance.now() - startedAt) * 10) / 10, message: "Test event diterima endpoint monitoring", checkedAt };
  } catch (error) {
    const message = error?.name === "AbortError" ? "Monitoring webhook timeout" : safeText(error.message || "Monitoring webhook gagal");
    return { provider: "monitoring-webhook", state: "error", latencyMs: Math.round((performance.now() - startedAt) * 10) / 10, message, checkedAt };
  } finally { if (timer) clearTimeout(timer); }
}

function webhookPayload(record) {
  return {
    id: record.id,
    event: record.eventType,
    createdAt: record.createdAt,
    incident: {
      id: record.incidentId,
      severity: record.severity,
      machineId: record.machineId,
      boothCode: record.boothCode,
      organizationId: record.organizationId,
      machineName: record.machineName,
    },
  };
}

async function deliver(redis, record, { fetchImpl, environment, atMs }) {
  const timestamp = new Date(atMs).toISOString();
  const attempts = Number(record.attempts || 0) + 1;
  let runtime;
  try {
    runtime = await resolveProviderRuntimeForCapability(redis, "monitoringAlert", {
      boothCode: record.boothCode,
      organizationId: record.organizationId,
    }, environment);
  } catch (error) {
    runtime = null;
    record.lastError = safeText(error.message || "Credential monitoring tidak dapat dibuka");
  }
  if (!runtime) {
    const updated = { ...record, status: "waiting_configuration", attempts, nextAttemptAt: new Date(atMs + 3_600_000).toISOString(), updatedAt: timestamp, lastError: record.lastError || "Monitoring webhook belum dikonfigurasi" };
    await redis.set(deliveryKey(record.id), updated);
    return updated;
  }

  const controller = new AbortController();
  let timer;
  try {
    const url = webhookUrl(runtime.environment.MONITORING_WEBHOOK_URL);
    const secret = String(runtime.environment.MONITORING_WEBHOOK_SECRET || "");
    if (secret.length < 16) throw new Error("Signing secret monitoring webhook terlalu pendek");
    const body = JSON.stringify(webhookPayload(record));
    const signature = await hmacHex(secret, body);
    timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Photoslive-Alert-Router/1.0",
        "x-photoslive-event": record.eventType,
        "x-photoslive-delivery": record.id,
        "x-photoslive-signature": `sha256=${signature}`,
        "idempotency-key": record.id,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Webhook merespons HTTP ${response.status}`);
    const updated = { ...record, status: "delivered", attempts, nextAttemptAt: null, updatedAt: timestamp, deliveredAt: timestamp, lastError: null };
    await redis.set(deliveryKey(record.id), updated);
    return updated;
  } catch (error) {
    const final = attempts >= MAX_ATTEMPTS;
    const message = error?.name === "AbortError" ? "Monitoring webhook timeout" : safeText(error.message || "Monitoring webhook gagal");
    const updated = { ...record, status: final ? "failed" : "retry", attempts, nextAttemptAt: final ? null : dueAt(attempts, atMs), updatedAt: timestamp, lastError: message };
    await redis.set(deliveryKey(record.id), updated);
    return updated;
  } finally { if (timer) clearTimeout(timer); }
}

export async function processAlertDeliveries(redis, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit || 10)));
  const fetchImpl = options.fetchImpl || fetch;
  const environment = options.environment || process.env;
  const atMs = Number(options.atMs || Date.now());
  const records = await listAlertDeliveries(redis, 200);
  const due = records.filter(record => ["queued", "retry", "waiting_configuration"].includes(record.status)
    && (!record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= atMs)).slice(0, limit);
  const processed = [];
  for (const safeRecord of due) {
    const raw = await redis.get(deliveryKey(safeRecord.id));
    if (raw) processed.push(safeAlertDelivery(await deliver(redis, raw, { fetchImpl, environment, atMs })));
  }
  return {
    checkedAt: new Date(atMs).toISOString(),
    processed: processed.length,
    delivered: processed.filter(item => item.status === "delivered").length,
    failed: processed.filter(item => item.status === "failed").length,
    waiting: processed.filter(item => item.status === "waiting_configuration").length,
    retrying: processed.filter(item => item.status === "retry").length,
  };
}

export async function retryAlertDelivery(redis, id, actorId = "superadmin") {
  const record = await redis.get(deliveryKey(String(id || "")));
  if (!record) return null;
  if (!["failed", "waiting_configuration", "retry"].includes(record.status)) return safeAlertDelivery(record);
  const updated = { ...record, status: "queued", nextAttemptAt: now(), updatedAt: now(), lastError: null, retryRequestedBy: safeText(actorId, 120) };
  await redis.set(deliveryKey(record.id), updated);
  return safeAlertDelivery(updated);
}
