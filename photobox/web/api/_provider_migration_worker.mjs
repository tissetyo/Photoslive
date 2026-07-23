import { boothKey, machineKey } from "./_store.mjs";
import { getObject, putObject } from "./_object_storage.mjs";
import { resolveProviderRuntime, setProviderConnectionState } from "./_provider_connections.mjs";
import { finalizeProviderMigration, listProviderMigrations, processProviderMigration, providerMigrationRecord } from "./_provider_migrations.mjs";

const assetKey = (boothCode, id) => `photoslive:booth:${boothCode}:asset:${id}`;
const lockKey = id => `photoslive:provider-migration-lock:${id}`;

async function boothContext(redis, boothCode) {
  const machineId = await redis.get(boothKey(boothCode));
  const machine = machineId ? await redis.get(machineKey(machineId)) : null;
  return { boothCode, organizationId: machine?.organizationId || "" };
}

async function acquireLock(redis, id, ttlSeconds = 55) {
  const token = crypto.randomUUID();
  const result = await redis.set(lockKey(id), token, { nx: true, ex: ttlSeconds });
  return result ? token : null;
}

async function releaseLock(redis, id, token) {
  if (!token) return;
  const current = await redis.get(lockKey(id));
  if (current === token) await redis.del(lockKey(id));
}

export async function processProviderMigrationBatch(redis, id, options = {}) {
  const token = await acquireLock(redis, id, options.lockTtlSeconds);
  if (!token) return { skipped: true, reason: "locked", migration: null };
  try {
    const record = await providerMigrationRecord(redis, id);
    if (!record) return { skipped: true, reason: "not_found", migration: null };
    const context = await boothContext(redis, record.boothCode);
    const runtimeResolver = options.runtimeResolver || resolveProviderRuntime;
    const [source, destination] = await Promise.all([
      runtimeResolver(redis, record.sourceProvider, context),
      runtimeResolver(redis, record.destinationProvider, context),
    ]);
    if (!source || !destination) throw new Error("Credential provider sumber atau tujuan tidak tersedia");
    const getObjectImpl = options.getObjectImpl || getObject;
    const putObjectImpl = options.putObjectImpl || putObject;
    const migration = await processProviderMigration(redis, id, {
      limit: Math.max(1, Math.min(20, Number(options.limit || 5))),
      copyObject: async ({ item }) => {
        const downloaded = await getObjectImpl({ objectKey: item.objectKey, environment: source.environment, maximumBytes: 25_000_000 });
        if (!downloaded || downloaded.checksumSha256 !== item.checksumSha256) throw new Error("Checksum provider sumber tidak cocok");
        await putObjectImpl({ objectKey: item.objectKey, bytes: downloaded.bytes, contentType: item.contentType, checksumSha256: item.checksumSha256, environment: destination.environment });
        return getObjectImpl({ objectKey: item.objectKey, environment: destination.environment, maximumBytes: 25_000_000 });
      },
      onCopied: async ({ item }) => {
        const key = assetKey(record.boothCode, item.id);
        const asset = await redis.get(key);
        if (!asset) throw new Error("Metadata aset tidak ditemukan");
        await redis.set(key, {
          ...asset,
          storageProvider: record.destinationProvider,
          previousStorage: { provider: record.sourceProvider, objectKey: item.objectKey },
          migratedAt: new Date().toISOString(),
          providerMigrationId: record.id,
        });
      },
    });
    return { skipped: false, reason: null, migration };
  } finally {
    await releaseLock(redis, id, token);
  }
}

export async function processProviderMigrationQueue(redis, options = {}) {
  const limitMigrations = Math.max(1, Math.min(10, Number(options.limitMigrations || 3)));
  const candidates = (await listProviderMigrations(redis, 200))
    .filter(item => ["queued", "running"].includes(item.state))
    .slice(0, limitMigrations);
  const results = [];
  for (const migration of candidates) {
    try {
      results.push(await processProviderMigrationBatch(redis, migration.id, options));
    } catch (error) {
      results.push({ skipped: false, reason: null, migration: null, id: migration.id, error: String(error?.message || "Migrasi provider gagal") });
    }
  }
  return {
    inspected: candidates.length,
    processed: results.filter(item => !item.skipped && !item.error).length,
    skipped: results.filter(item => item.skipped).length,
    failed: results.filter(item => item.error).length,
    results,
  };
}

export async function finalizeProviderMigrationCutover(redis, id, actorId = "system", options = {}) {
  const record = await providerMigrationRecord(redis, id);
  if (!record) return null;
  const context = await boothContext(redis, record.boothCode);
  const runtimeResolver = options.runtimeResolver || resolveProviderRuntime;
  const source = await runtimeResolver(redis, record.sourceProvider, context);
  return finalizeProviderMigration(redis, id, {
    actorId,
    verifyCutover: async ({ migration, items }) => {
      for (const item of items) {
        const asset = await redis.get(assetKey(migration.boothCode, item.id));
        if (!asset || asset.storageProvider !== migration.destinationProvider || asset.providerMigrationId !== migration.id) {
          throw new Error(`Metadata aset ${item.id} belum menggunakan provider tujuan`);
        }
      }
    },
    retireSource: async () => {
      const connection = source?.connection;
      if (!connection) return { state: "retained_deployment", reason: "Provider deployment dipertahankan karena dipakai bersama" };
      if (connection.scope !== "booth" || connection.targetId !== record.boothCode) {
        return { state: "retained_shared", reason: "Koneksi provider dipakai organisasi/global dan tidak boleh dipause otomatis", connectionId: connection.id };
      }
      const stateSetter = options.stateSetter || setProviderConnectionState;
      await stateSetter(redis, { providerId: connection.providerId, scope: connection.scope, targetId: connection.targetId, status: "paused" }, actorId);
      return { state: "paused", reason: "Koneksi sumber khusus booth dipause setelah verifikasi lengkap", connectionId: connection.id };
    },
  });
}
