import { now, randomId } from "./_store.mjs";

const INDEX_KEY = "photoslive:provider-migrations";
const migrationKey = id => `photoslive:provider-migration:${id}`;
const VALID_STATES = new Set(["queued", "running", "paused", "completed", "failed"]);
const clean = (value, maximum = 160) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, maximum);

function safeItem(item) {
  return {
    id: String(item.id || "").slice(0, 160),
    objectKey: String(item.objectKey || "").slice(0, 500),
    checksumSha256: String(item.checksumSha256 || "").toLowerCase().slice(0, 64),
    contentType: String(item.contentType || "application/octet-stream").slice(0, 120),
    size: Math.max(0, Number(item.size || 0)),
    state: ["pending", "copied", "failed"].includes(item.state) ? item.state : "pending",
    attempts: Math.max(0, Number(item.attempts || 0)),
    lastError: item.lastError ? String(item.lastError).slice(0, 300) : null,
    copiedAt: item.copiedAt || null,
  };
}

export function safeProviderMigration(record) {
  if (!record) return null;
  const items = (record.items || []).map(safeItem);
  const copied = items.filter(item => item.state === "copied").length;
  const failed = items.filter(item => item.state === "failed").length;
  return {
    id: record.id, boothCode: record.boothCode, sourceProvider: record.sourceProvider,
    destinationProvider: record.destinationProvider, state: VALID_STATES.has(record.state) ? record.state : "failed",
    total: items.length, copied, failed, pending: items.length - copied - failed,
    progressPercent: items.length ? Math.round((copied / items.length) * 1000) / 10 : 100,
    cutoverReady: record.state === "completed" && copied === items.length,
    createdAt: record.createdAt, updatedAt: record.updatedAt, completedAt: record.completedAt || null,
    finalizedAt: record.finalizedAt || null,
    finalizedBy: record.finalizedBy || null,
    sourceRetirement: record.sourceRetirement || null,
    lastError: record.lastError ? String(record.lastError).slice(0, 300) : null,
  };
}

export async function createProviderMigration(redis, input = {}, actorId = "system") {
  const boothCode = clean(input.boothCode);
  const sourceProvider = clean(input.sourceProvider);
  const destinationProvider = clean(input.destinationProvider);
  if (!boothCode || !sourceProvider || !destinationProvider) throw new Error("Booth dan provider migrasi wajib diisi");
  if (sourceProvider === destinationProvider) throw new Error("Provider tujuan harus berbeda");
  const items = (Array.isArray(input.items) ? input.items : []).map(item => safeItem({ ...item, state: "pending", attempts: 0 }));
  if (!items.length) throw new Error("Tidak ada object yang dapat dimigrasikan");
  if (items.length > 5_000) throw new Error("Maksimal 5.000 object per migrasi");
  if (items.some(item => !item.id || !item.objectKey || !/^[a-f0-9]{64}$/.test(item.checksumSha256))) throw new Error("Metadata object migrasi tidak valid");
  const timestamp = now();
  const record = {
    id: randomId("provider-migration"), boothCode, sourceProvider, destinationProvider,
    state: "queued", items, cursor: 0, createdAt: timestamp, updatedAt: timestamp,
    completedAt: null, lastError: null, createdBy: String(actorId || "system").slice(0, 120),
  };
  await Promise.all([redis.set(migrationKey(record.id), record), redis.lpush(INDEX_KEY, record.id), redis.ltrim(INDEX_KEY, 0, 199)]);
  return safeProviderMigration(record);
}

export async function listProviderMigrations(redis, limit = 100) {
  const ids = await redis.lrange(INDEX_KEY, 0, Math.max(0, Math.min(200, Number(limit || 100))) - 1);
  return (await Promise.all(ids.map(id => redis.get(migrationKey(id))))).filter(Boolean).map(safeProviderMigration);
}

export async function setProviderMigrationState(redis, id, state, actorId = "system") {
  const record = await redis.get(migrationKey(String(id || "")));
  if (!record) return null;
  const next = String(state || "").toLowerCase();
  if (!["paused", "queued"].includes(next)) throw new Error("State migrasi tidak didukung");
  if (["completed", "failed"].includes(record.state)) throw new Error("Migrasi final tidak dapat diubah");
  const updated = { ...record, state: next, updatedAt: now(), stateChangedBy: String(actorId || "system").slice(0, 120), lastError: next === "queued" ? null : record.lastError };
  await redis.set(migrationKey(record.id), updated);
  return safeProviderMigration(updated);
}

export async function processProviderMigration(redis, id, options = {}) {
  const record = await redis.get(migrationKey(String(id || "")));
  if (!record) return null;
  if (record.state === "paused" || record.state === "completed") return safeProviderMigration(record);
  const copyObject = options.copyObject;
  if (typeof copyObject !== "function") throw new Error("Worker copy provider tidak tersedia");
  const limit = Math.max(1, Math.min(20, Number(options.limit || 5)));
  let processed = 0;
  record.state = "running";
  record.updatedAt = now();
  await redis.set(migrationKey(record.id), record);
  for (let index = 0; index < record.items.length && processed < limit; index += 1) {
    const item = record.items[index];
    if (item.state === "copied" || (item.state === "failed" && Number(item.attempts || 0) >= 8)) continue;
    processed += 1;
    item.attempts = Number(item.attempts || 0) + 1;
    try {
      const result = await copyObject({ migration: safeProviderMigration(record), item: safeItem(item) });
      if (String(result?.checksumSha256 || "").toLowerCase() !== item.checksumSha256) throw new Error("Checksum tujuan tidak cocok");
      if (Number(result?.size || item.size) !== Number(item.size)) throw new Error("Ukuran object tujuan tidak cocok");
      item.state = "copied";
      item.copiedAt = now();
      item.lastError = null;
      if (typeof options.onCopied === "function") await options.onCopied({ migration: record, item, result });
    } catch (error) {
      item.state = "failed";
      item.lastError = String(error?.message || "Migrasi object gagal").slice(0, 300);
      record.lastError = item.lastError;
    }
    record.updatedAt = now();
    await redis.set(migrationKey(record.id), record); // durable checkpoint per object
  }
  const allCopied = record.items.every(item => item.state === "copied");
  const hasRetryable = record.items.some(item => item.state !== "copied" && Number(item.attempts || 0) < 8);
  record.state = allCopied ? "completed" : hasRetryable ? "queued" : "failed";
  record.completedAt = allCopied ? now() : null;
  record.updatedAt = now();
  await redis.set(migrationKey(record.id), record);
  return safeProviderMigration(record);
}

export async function providerMigrationRecord(redis, id) {
  return redis.get(migrationKey(String(id || "")));
}

export async function finalizeProviderMigration(redis, id, options = {}) {
  const record = await redis.get(migrationKey(String(id || "")));
  if (!record) return null;
  if (record.finalizedAt) return safeProviderMigration(record);
  const allCopied = Array.isArray(record.items) && record.items.length > 0
    && record.items.every(item => item.state === "copied");
  if (record.state !== "completed" || !allCopied) throw new Error("Migrasi belum siap difinalisasi");
  if (typeof options.verifyCutover !== "function") throw new Error("Verifikasi cutover tidak tersedia");
  await options.verifyCutover({ migration: record, items: record.items.map(safeItem) });
  let sourceRetirement = { state: "retained", reason: "Provider sumber dipertahankan untuk rollback" };
  if (typeof options.retireSource === "function") {
    sourceRetirement = await options.retireSource({ migration: record }) || sourceRetirement;
  }
  record.finalizedAt = now();
  record.finalizedBy = String(options.actorId || "system").slice(0, 120);
  record.sourceRetirement = {
    state: String(sourceRetirement.state || "retained").slice(0, 80),
    reason: String(sourceRetirement.reason || "").slice(0, 300),
    connectionId: sourceRetirement.connectionId ? String(sourceRetirement.connectionId).slice(0, 320) : null,
  };
  record.updatedAt = now();
  await redis.set(migrationKey(record.id), record);
  return safeProviderMigration(record);
}
