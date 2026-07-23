import { now } from "./_store.mjs";
import { providerConnectionId } from "./_provider_connections.mjs";

const ENTITLEMENT_INDEX = "photoslive:provider-entitlements";
const SNAPSHOT_LIMIT = 90;
const VALID_SCOPES = new Set(["global", "organization", "booth"]);
const VALID_PLANS = new Set(["free", "managed", "addon"]);
const VALID_METRICS = new Set(["requests", "transactions", "emails", "bytes"]);

const clean = (value, maximum = 120) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, maximum);
const entitlementKey = id => `photoslive:provider-entitlement:${id}`;
const usageKey = id => `photoslive:provider-usage:${id}`;

function context(input = {}) {
  const scope = String(input.scope || "").trim().toLowerCase();
  const targetId = scope === "global" ? "" : clean(input.targetId);
  const providerId = clean(input.providerId);
  if (!VALID_SCOPES.has(scope)) throw new Error("Scope entitlement tidak valid");
  if (scope !== "global" && !targetId) throw new Error("Target entitlement wajib diisi");
  if (!providerId) throw new Error("Provider entitlement wajib diisi");
  const id = providerConnectionId({ providerId, scope, targetId });
  return { id, providerId, scope, targetId };
}

function safeInteger(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`${label} tidak valid`);
  return number;
}

export function safeProviderEntitlement(record) {
  if (!record) return null;
  return {
    id: record.id,
    providerId: record.providerId,
    scope: record.scope,
    targetId: record.targetId || "",
    plan: record.plan,
    metric: record.metric,
    allowance: Number(record.allowance || 0),
    addon: Number(record.addon || 0),
    monthlyPriceIdr: Number(record.monthlyPriceIdr || 0),
    hardLimit: Boolean(record.hardLimit),
    period: String(record.period || "monthly"),
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export async function saveProviderEntitlement(redis, input = {}, actorId = "system") {
  const identity = context(input);
  const plan = String(input.plan || "free").trim().toLowerCase();
  const metric = String(input.metric || "requests").trim().toLowerCase();
  if (!VALID_PLANS.has(plan)) throw new Error("Plan provider tidak valid");
  if (!VALID_METRICS.has(metric)) throw new Error("Metrik kuota tidak valid");
  const previous = await redis.get(entitlementKey(identity.id));
  const record = {
    ...identity,
    plan,
    metric,
    allowance: safeInteger(input.allowance, "Allowance"),
    addon: safeInteger(input.addon || 0, "Add-on"),
    monthlyPriceIdr: safeInteger(input.monthlyPriceIdr || 0, "Biaya bulanan"),
    hardLimit: input.hardLimit !== false,
    period: "monthly",
    createdAt: previous?.createdAt || now(),
    updatedAt: now(),
    updatedBy: String(actorId || "system").slice(0, 120),
  };
  await Promise.all([redis.set(entitlementKey(identity.id), record), redis.sadd(ENTITLEMENT_INDEX, identity.id)]);
  return safeProviderEntitlement(record);
}

export async function recordProviderUsageSnapshot(redis, input = {}) {
  const identity = context(input);
  const used = safeInteger(input.used, "Pemakaian");
  const snapshot = {
    id: `usage_${crypto.randomUUID()}`,
    connectionId: identity.id,
    providerId: identity.providerId,
    scope: identity.scope,
    targetId: identity.targetId,
    metric: String(input.metric || "requests").trim().toLowerCase(),
    used,
    measuredAt: input.measuredAt ? new Date(input.measuredAt).toISOString() : now(),
    source: String(input.source || "provider_probe").slice(0, 80),
  };
  if (!VALID_METRICS.has(snapshot.metric)) throw new Error("Metrik pemakaian tidak valid");
  const pipeline = redis.pipeline?.();
  if (pipeline) {
    pipeline.lpush(usageKey(identity.id), snapshot);
    pipeline.ltrim(usageKey(identity.id), 0, SNAPSHOT_LIMIT - 1);
    await pipeline.exec();
  } else {
    await redis.lpush(usageKey(identity.id), snapshot);
    await redis.ltrim(usageKey(identity.id), 0, SNAPSHOT_LIMIT - 1);
  }
  return snapshot;
}

function economics(entitlement, snapshot) {
  const limit = Number(entitlement?.allowance || 0) + Number(entitlement?.addon || 0);
  const used = Number(snapshot?.used || 0);
  const remaining = Math.max(0, limit - used);
  const ratio = limit > 0 ? used / limit : 0;
  return {
    entitlement: safeProviderEntitlement(entitlement),
    latestUsage: snapshot || null,
    quota: {
      used,
      limit,
      remaining,
      percent: limit > 0 ? Math.min(999, Math.round(ratio * 1000) / 10) : 0,
      state: limit === 0 ? "not_configured" : ratio >= 1 ? "exhausted" : ratio >= 0.8 ? "warning" : "ready",
      allowed: limit === 0 || !entitlement?.hardLimit || used < limit,
    },
  };
}

export async function listProviderEconomics(redis) {
  const ids = await redis.smembers(ENTITLEMENT_INDEX);
  const records = await Promise.all(ids.map(async id => {
    const [entitlement, snapshots] = await Promise.all([
      redis.get(entitlementKey(id)),
      redis.lrange(usageKey(id), 0, 0),
    ]);
    return economics(entitlement, snapshots[0]);
  }));
  return {
    records: records.sort((a, b) => a.entitlement.id.localeCompare(b.entitlement.id)),
    summary: {
      total: records.length,
      ready: records.filter(item => item.quota.state === "ready").length,
      warning: records.filter(item => item.quota.state === "warning").length,
      exhausted: records.filter(item => item.quota.state === "exhausted").length,
      unconfigured: records.filter(item => item.quota.state === "not_configured").length,
    },
    checkedAt: now(),
  };
}

export async function providerQuotaDecision(redis, input = {}) {
  const identity = context(input);
  const [entitlement, snapshots] = await Promise.all([
    redis.get(entitlementKey(identity.id)),
    redis.lrange(usageKey(identity.id), 0, 0),
  ]);
  return economics(entitlement, snapshots[0]).quota;
}

export const PROVIDER_USAGE_SNAPSHOT_LIMIT = SNAPSHOT_LIMIT;
