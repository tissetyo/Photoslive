import { now, randomId, sha256 } from "./_store.mjs";

const INDEX_KEY = "photoslive:webhook-events";
const MAX_EVENTS = 500;
const safeText = (value, length = 240) => String(value || "").slice(0, length);
const ALLOWED_STATES = new Set(["received", "succeeded", "failed", "duplicate"]);

export function safeWebhookEvent(record) {
  if (!record) return null;
  return {
    id: safeText(record.id, 120), provider: safeText(record.provider, 40), eventType: safeText(record.eventType, 100),
    providerEventRef: safeText(record.providerEventRef, 64), boothCode: safeText(record.boothCode, 100) || null,
    paymentId: safeText(record.paymentId, 120) || null, state: ALLOWED_STATES.has(record.state) ? record.state : "failed",
    httpStatus: Math.max(0, Number(record.httpStatus || 0)), duplicate: Boolean(record.duplicate),
    latencyMs: Math.max(0, Number(record.latencyMs || 0)), error: safeText(record.error, 240) || null,
    correlationId: safeText(record.correlationId, 120) || null, receivedAt: record.receivedAt || null,
  };
}

export async function appendWebhookEvent(redis, input = {}) {
  const providerEventId = safeText(input.providerEventId, 240);
  const providerEventRef = providerEventId ? (await sha256(providerEventId)).slice(0, 16) : "unavailable";
  const record = {
    id: randomId("webhook"), provider: safeText(input.provider || "unknown", 40),
    eventType: safeText(input.eventType || "unknown", 100), providerEventRef,
    boothCode: safeText(input.boothCode, 100) || null, paymentId: safeText(input.paymentId, 120) || null,
    state: ALLOWED_STATES.has(input.state) ? input.state : "failed", httpStatus: Math.max(0, Number(input.httpStatus || 0)),
    duplicate: Boolean(input.duplicate), latencyMs: Math.max(0, Math.round(Number(input.latencyMs || 0) * 10) / 10),
    error: safeText(input.error, 240) || null, correlationId: safeText(input.correlationId, 120) || null,
    receivedAt: input.receivedAt || now(),
  };
  await redis.lpush(INDEX_KEY, record);
  await redis.ltrim(INDEX_KEY, 0, MAX_EVENTS - 1);
  return safeWebhookEvent(record);
}

export async function listWebhookEvents(redis, limit = 100) {
  const boundedLimit = Math.max(1, Math.min(200, Number(limit || 100)));
  const records = (await redis.lrange(INDEX_KEY, 0, boundedLimit - 1)).map(value => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return null; }
  }).filter(Boolean).map(safeWebhookEvent);
  const summary = records.reduce((result, event) => {
    result.total += 1;
    result[event.state] = (result[event.state] || 0) + 1;
    return result;
  }, { total: 0, succeeded: 0, failed: 0, duplicate: 0, received: 0 });
  return { checkedAt: now(), records, summary };
}

export const webhookEventStorage = Object.freeze({ indexKey: INDEX_KEY, maxEvents: MAX_EVENTS });
