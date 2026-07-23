import { postgresShadowStatus } from "./_postgres.mjs";
import { providerRegistry } from "./_providers.mjs";
import { probeObjectStorage } from "./_object_storage.mjs";
import { probeXendit } from "./_payments.mjs";
import { probeResend } from "./_email.mjs";

const elapsed = startedAt => Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);

async function probeRedis(redis) {
  const startedAt = performance.now();
  const key = `photoslive:health:${crypto.randomUUID()}`;
  const value = crypto.randomUUID();
  try {
    await redis.set(key, value, { ex: 30 });
    const stored = await redis.get(key);
    await redis.del(key);
    if (stored !== value) throw new Error("Verifikasi read-after-write gagal");
    return { state: "ready", readWrite: true, latencyMs: elapsed(startedAt), message: "Read/write cache berhasil" };
  } catch (error) {
    await redis.del(key).catch(() => {});
    return { state: "error", readWrite: false, latencyMs: elapsed(startedAt), message: error instanceof Error ? error.message.slice(0, 180) : "Probe cache gagal" };
  }
}

async function probePostgres(environment, fetchImplementation) {
  const status = postgresShadowStatus(environment);
  if (!status.enabled) return { state: "disabled", configured: status.configured, latencyMs: null, message: status.reason };
  if (!status.configured) return { state: "error", configured: false, latencyMs: null, message: status.reason };
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const baseUrl = String(environment.SUPABASE_URL || "").replace(/\/+$/g, "");
    const response = await fetchImplementation(`${baseUrl}/rest/v1/migration_shadow_events?select=id&limit=1`, {
      method: "GET",
      headers: {
        apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Probe PostgreSQL gagal (${response.status})`);
    return { state: "ready", configured: true, latencyMs: elapsed(startedAt), message: "Koneksi database berhasil" };
  } catch (error) {
    const message = error?.name === "AbortError" ? `Probe database timeout setelah ${status.timeoutMs} ms` : error instanceof Error ? error.message : "Probe database gagal";
    return { state: "error", configured: true, latencyMs: elapsed(startedAt), message: String(message).slice(0, 180) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function backendHealth(redis, options = {}) {
  const environment = options.environment || process.env;
  const fetchImplementation = options.fetchImplementation || fetch;
  const [cache, database, objectStorage, xendit, resend] = await Promise.all([
    probeRedis(redis),
    probePostgres(environment, fetchImplementation),
    probeObjectStorage({ environment, fetchImpl: options.providerFetchImplementation || fetchImplementation, timeoutMs: options.providerTimeoutMs || 3000 }),
    probeXendit({ environment, fetchImplementation: options.providerFetchImplementation || fetchImplementation, timeoutMs: options.providerTimeoutMs || 3000 }),
    probeResend({ environment, fetchImpl: options.providerFetchImplementation || fetchImplementation, timeoutMs: options.providerTimeoutMs || 3000 }),
  ]);
  const providers = providerRegistry(environment).map(provider => {
    let state = provider.available ? "ready" : provider.configured ? "unavailable" : "not_configured";
    let latencyMs = null;
    let message = provider.configured ? "Adapter belum tersedia" : "Credential belum dikonfigurasi";
    if (provider.kind === "storage" && provider.available) {
      if (provider.id === objectStorage.provider) {
        state = objectStorage.state;
        latencyMs = objectStorage.latencyMs;
        message = objectStorage.message;
      } else {
        state = "standby";
        message = "Dikonfigurasi, tetapi bukan provider storage aktif";
      }
    }
    if (provider.id === "xendit" && provider.available) {
      state = xendit.state;
      latencyMs = xendit.latencyMs;
      message = xendit.message;
    }
    if (provider.id === "resend" && provider.available) {
      state = resend.state;
      latencyMs = resend.latencyMs;
      message = resend.message;
    }
    return {
      id: provider.id, kind: provider.kind, label: provider.label, state, latencyMs, message,
      adapterImplemented: provider.adapterImplemented, configured: provider.configured,
      available: provider.available && ["ready", "standby"].includes(state),
      missingConfigurationCount: provider.missingConfiguration.length,
    };
  });
  return { checkedAt: new Date().toISOString(), cache, database, providers };
}
