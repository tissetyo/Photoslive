import { now } from "./_store.mjs";

const INDEX_KEY = "photoslive:finance-policies";
const VALID_SCOPES = new Set(["global", "booth"]);
const policyKey = (scope, targetId = "") => `photoslive:finance-policy:${scope}:${targetId || "_"}`;

function normalizedBps(value) {
  const bps = Number(value);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("Platform fee harus berupa basis point antara 0 dan 10000");
  return bps;
}

function normalizedContext(input = {}) {
  const scope = String(input.scope || "global").trim().toLowerCase();
  const targetId = scope === "global" ? "" : String(input.targetId || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 100);
  if (!VALID_SCOPES.has(scope)) throw new Error("Scope finance policy tidak valid");
  if (scope === "booth" && !targetId) throw new Error("Photobox wajib dipilih");
  return { scope, targetId };
}

export function safeFinancePolicy(record) {
  if (!record) return null;
  return {
    id: record.id,
    scope: record.scope,
    targetId: record.targetId || "",
    platformFeeBps: Number(record.platformFeeBps || 0),
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export async function setFinancePolicy(redis, input = {}, actorId = "system") {
  const context = normalizedContext(input);
  const id = `${context.scope}:${context.targetId || "_"}`;
  const previous = await redis.get(policyKey(context.scope, context.targetId));
  const record = {
    id,
    ...context,
    platformFeeBps: normalizedBps(input.platformFeeBps),
    createdAt: previous?.createdAt || now(),
    updatedAt: now(),
    updatedBy: String(actorId || "system").slice(0, 120),
  };
  await redis.set(policyKey(context.scope, context.targetId), record);
  await redis.sadd(INDEX_KEY, id);
  return safeFinancePolicy(record);
}

export async function deleteFinancePolicy(redis, input = {}) {
  const context = normalizedContext(input);
  if (context.scope === "global") throw new Error("Policy global tidak dapat dihapus; ubah nilainya menjadi 0 bila fee dinonaktifkan");
  const id = `${context.scope}:${context.targetId}`;
  const existed = Boolean(await redis.get(policyKey(context.scope, context.targetId)));
  await redis.del(policyKey(context.scope, context.targetId));
  await redis.srem(INDEX_KEY, id);
  return existed;
}

export async function listFinancePolicies(redis, environment = process.env) {
  const ids = await redis.smembers(INDEX_KEY);
  const records = (await Promise.all(ids.slice(0, 2_000).map(id => {
    const [scope, targetId] = String(id).split(":");
    return redis.get(policyKey(scope, targetId === "_" ? "" : targetId));
  }))).filter(Boolean).map(safeFinancePolicy);
  if (!records.some(record => record.scope === "global")) records.push({
    id: "global:_",
    scope: "global",
    targetId: "",
    platformFeeBps: Math.max(0, Math.min(10_000, Number(environment.PHOTOSLIVE_PLATFORM_FEE_BPS || 0) || 0)),
    updatedAt: null,
    updatedBy: "environment-default",
  });
  return records.sort((a, b) => `${a.scope}:${a.targetId}`.localeCompare(`${b.scope}:${b.targetId}`));
}

export async function resolvePlatformFeePolicy(redis, boothCode, environment = process.env) {
  const normalizedBooth = String(boothCode || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 100);
  const [booth, global] = await Promise.all([
    normalizedBooth ? redis.get(policyKey("booth", normalizedBooth)) : null,
    redis.get(policyKey("global", "")),
  ]);
  const source = booth || global;
  const platformFeeBps = source
    ? normalizedBps(source.platformFeeBps)
    : Math.max(0, Math.min(10_000, Number(environment.PHOTOSLIVE_PLATFORM_FEE_BPS || 0) || 0));
  return {
    platformFeeBps,
    scope: booth ? "booth" : global ? "global" : "environment",
    policyId: source?.id || null,
  };
}

