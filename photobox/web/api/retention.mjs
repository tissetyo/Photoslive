import { boothKey, getRedis, machineKey } from "./_store.mjs";
import { cleanupExpiredPublicSessions } from "./_session_retention.mjs";
import { deleteObject } from "./_object_storage.mjs";
import { resolveProviderRuntime, resolveProviderRuntimeForCapability, resolveProviderRuntimeReference } from "./_provider_connections.mjs";
import { processAlertDeliveries } from "./_alert_routing.mjs";
import { reconcilePendingPayments } from "./_payments.mjs";
import { appendPostgresLedgerEntry, writePostgresPaymentIntent, writePostgresReconciliationJob } from "./_postgres.mjs";
import { processProviderMigrationQueue } from "./_provider_migration_worker.mjs";

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

export async function handler(request) {
  const secret = String(process.env.CRON_SECRET || "");
  const supplied = String(request.headers.get("authorization") || "");
  if (!secret || supplied !== `Bearer ${secret}`) return json({ error: "Akses cleanup retensi ditolak" }, 401);
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Metode tidak didukung" }, 405);
  const redis = getRedis();
  const runtimeCache = new Map();
  const result = await cleanupExpiredPublicSessions(redis, {
    limit: 50,
    deleteObjectImpl: async ({ objectKey, storageProvider, boothCode }) => {
      const cacheKey = `${boothCode}:${storageProvider || "default"}`;
      let runtime = runtimeCache.get(cacheKey);
      if (!runtimeCache.has(cacheKey)) {
        const machineId = await redis.get(boothKey(boothCode));
        const machine = machineId ? await redis.get(machineKey(machineId)) : null;
        const context = { boothCode, organizationId: machine?.organizationId || "" };
        runtime = storageProvider
          ? await resolveProviderRuntime(redis, storageProvider, context)
          : await resolveProviderRuntimeForCapability(redis, "cloudStorage", context);
        runtimeCache.set(cacheKey, runtime);
      }
      return deleteObject({ objectKey, environment: runtime?.environment || process.env });
    },
  });
  const alerts = await processAlertDeliveries(redis, { limit: 20 });
  const paymentReconciliation = await reconcilePendingPayments(redis, {
    limit: 25,
    runtimeResolver: async ({ boothCode, providerId, providerConnectionRef }) => {
      const machineId = await redis.get(boothKey(boothCode));
      const machine = machineId ? await redis.get(machineKey(machineId)) : null;
      const context = { boothCode, organizationId: machine?.organizationId || "" };
      return providerConnectionRef
        ? resolveProviderRuntimeReference(redis, providerConnectionRef, context)
        : resolveProviderRuntime(redis, providerId, context);
    },
    onResult: async ({ payment, ledger, reconciliation }) => {
      await Promise.all([
        writePostgresPaymentIntent(payment),
        reconciliation ? writePostgresReconciliationJob(reconciliation) : Promise.resolve(),
        ledger ? appendPostgresLedgerEntry(ledger) : Promise.resolve(),
      ]);
    },
  });
  const providerMigrations = await processProviderMigrationQueue(redis, { limitMigrations: 3, limit: 5 });
  return json(
    { ...result, alerts, paymentReconciliation, providerMigrations },
    result.failed || alerts.failed || paymentReconciliation.failed || providerMigrations.failed ? 207 : 200,
  );
}

export default { fetch: handler };
