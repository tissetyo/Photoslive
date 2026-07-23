import { now } from "./_store.mjs";

export const FEATURE_FLAG_DEFINITIONS = Object.freeze([
  { key: "direct_object_upload", label: "Upload aset langsung", description: "Upload frame dan background langsung ke object storage.", defaultEnabled: true },
  { key: "tablet_pwa", label: "Tablet PWA", description: "Aktifkan pengalaman instalasi PWA khusus tablet.", defaultEnabled: false },
  { key: "postgres_dual_read", label: "PostgreSQL dual-read", description: "Bandingkan hasil baca legacy dengan PostgreSQL selama migrasi.", defaultEnabled: false },
  { key: "remote_snapshot", label: "Snapshot kamera remote", description: "Izinkan snapshot kamera resolusi rendah dari admin.", defaultEnabled: false },
  { key: "provider_marketplace", label: "Marketplace provider", description: "Tampilkan integrasi provider yang sudah siap digunakan.", defaultEnabled: false },
  { key: "finance_ledger", label: "Finance ledger", description: "Aktifkan modul ledger setelah backend finance siap.", defaultEnabled: false },
]);

const definitionMap = new Map(FEATURE_FLAG_DEFINITIONS.map(item => [item.key, item]));
const scopes = new Set(["global", "organization", "booth"]);
const indexKey = "photoslive:feature-flags";
const normalizeId = value => String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 100);

export function featureFlagRecordId(scope, targetId, key) {
  const normalizedScope = String(scope || "").toLowerCase();
  const normalizedTarget = normalizedScope === "global" ? "_" : normalizeId(targetId);
  return `${normalizedScope}:${normalizedTarget}:${String(key || "").toLowerCase()}`;
}

const recordKey = id => `photoslive:feature-flag:${id}`;

export function validateFeatureFlagInput(input = {}) {
  const key = String(input.key || "").trim().toLowerCase();
  const scope = String(input.scope || "").trim().toLowerCase();
  const targetId = scope === "global" ? "" : normalizeId(input.targetId);
  if (!definitionMap.has(key)) throw new Error("Feature flag tidak dikenal");
  if (!scopes.has(scope)) throw new Error("Scope feature flag tidak valid");
  if (scope !== "global" && !targetId) throw new Error("Target feature flag wajib diisi");
  if (typeof input.enabled !== "boolean") throw new Error("Status feature flag harus boolean");
  const config = input.config == null ? {} : input.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Konfigurasi feature flag harus object");
  if (JSON.stringify(config).length > 4_000) throw new Error("Konfigurasi feature flag terlalu besar");
  return { key, scope, targetId, enabled: input.enabled, config };
}

export async function listFeatureFlagOverrides(redis) {
  const ids = await redis.smembers(indexKey);
  const keys = ids.map(recordKey);
  const records = (keys.length ? (typeof redis.mget === "function" ? await redis.mget(...keys) : await Promise.all(keys.map(key => redis.get(key)))) : []).filter(Boolean);
  return records.sort((a, b) => `${a.key}:${a.scope}:${a.targetId || ""}`.localeCompare(`${b.key}:${b.scope}:${b.targetId || ""}`));
}

export async function setFeatureFlagOverride(redis, input, actorId = "system") {
  const value = validateFeatureFlagInput(input);
  const id = featureFlagRecordId(value.scope, value.targetId, value.key);
  const previous = await redis.get(recordKey(id));
  const record = {
    id,
    ...value,
    createdAt: previous?.createdAt || now(),
    updatedAt: now(),
    updatedBy: String(actorId || "system").slice(0, 120),
  };
  await redis.set(recordKey(id), record);
  await redis.sadd(indexKey, id);
  return record;
}

export async function deleteFeatureFlagOverride(redis, input = {}) {
  const key = String(input.key || "").trim().toLowerCase();
  const scope = String(input.scope || "").trim().toLowerCase();
  const targetId = scope === "global" ? "" : normalizeId(input.targetId);
  if (!definitionMap.has(key) || !scopes.has(scope) || (scope !== "global" && !targetId)) throw new Error("Feature flag tidak valid");
  const id = featureFlagRecordId(scope, targetId, key);
  const previous = await redis.get(recordKey(id));
  await redis.del(recordKey(id));
  await redis.srem(indexKey, id);
  return previous;
}

export async function resolveFeatureFlags(redis, context = {}) {
  const organizationId = normalizeId(context.organizationId);
  const boothCode = normalizeId(context.boothCode);
  const effective = Object.fromEntries(FEATURE_FLAG_DEFINITIONS.map(item => [item.key, {
    enabled: item.defaultEnabled,
    config: {},
    sourceScope: "default",
    sourceTarget: "",
  }]));
  const candidates = [
    ["global", ""],
    ...(organizationId ? [["organization", organizationId]] : []),
    ...(boothCode ? [["booth", boothCode]] : []),
  ];
  const lookups = candidates.flatMap(([scope, targetId]) => FEATURE_FLAG_DEFINITIONS.map(definition => ({ scope, targetId, key: definition.key, redisKey: recordKey(featureFlagRecordId(scope, targetId, definition.key)) })));
  const records = lookups.length ? (typeof redis.mget === "function" ? await redis.mget(...lookups.map(item => item.redisKey)) : await Promise.all(lookups.map(item => redis.get(item.redisKey)))) : [];
  for (const [index, lookup] of lookups.entries()) {
    const record = records[index];
    if (record) effective[lookup.key] = { enabled: Boolean(record.enabled), config: record.config || {}, sourceScope: lookup.scope, sourceTarget: lookup.targetId };
  }
  return effective;
}
