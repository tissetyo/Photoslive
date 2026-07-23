import { redactLogValue } from "./_observability.mjs";

const MODES = new Set(["off", "dual", "primary"]);
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value, 500).replace(/\/+$/g, "");

export function postgresSettingsStatus(environment = process.env) {
  const requested = clean(environment.PHOTOSLIVE_POSTGRES_SETTINGS, 20).toLowerCase() || "off";
  const mode = MODES.has(requested) ? requested : "off";
  const configured = Boolean(baseUrl(environment.SUPABASE_URL) && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 8));
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || 1_500);
  return {
    mode,
    primary: mode === "primary",
    enabled: mode !== "off",
    configured,
    timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(5_000, Math.round(configuredTimeout))) : 1_500,
    reason: mode === "off" ? "PostgreSQL settings belum diaktifkan" : configured ? "" : "Credential Supabase server belum lengkap",
  };
}

async function settingsRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const status = postgresSettingsStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, status: 503, reason: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await (options.fetchImplementation || fetch)(`${baseUrl(environment.SUPABASE_URL)}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`PostgreSQL settings gagal (${response.status})`), { status: response.status });
    return { ok: true, skipped: false, payload: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `PostgreSQL settings timeout setelah ${status.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.settings.failed", operation: name, identity, reason })));
    return { ok: false, skipped: false, status: Number(error?.status || 503), reason };
  } finally {
    clearTimeout(timeout);
  }
}

export async function persistPostgresSettings(input = {}, options = {}) {
  const boothCode = clean(input.boothCode, 64).toLowerCase();
  const config = input.config && typeof input.config === "object" && !Array.isArray(input.config) ? input.config : null;
  if (!boothCode || !config || JSON.stringify(config).length > 500_000) throw new Error("Snapshot settings PostgreSQL tidak valid");
  const result = await settingsRpc("photoslive_persist_booth_config", { p_booth_code: boothCode, p_config: config }, boothCode, options);
  if (!result.ok) return result;
  const version = Number(result.payload?.version || 0);
  return Number.isSafeInteger(version) && version > 0 ? { ...result, version } : { ok: false, skipped: false, status: 503, reason: "Versi settings PostgreSQL tidak valid" };
}

export async function readPostgresSettings(boothCodeInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  if (!boothCode) return null;
  const result = await settingsRpc("photoslive_booth_config_snapshot", { p_booth_code: boothCode }, boothCode, options);
  if (!result.ok || !result.payload || typeof result.payload !== "object") return null;
  const version = Number(result.payload.version || 0);
  const config = result.payload.config;
  if (!Number.isSafeInteger(version) || version < 1 || !config || typeof config !== "object" || Array.isArray(config)) return null;
  return { version, config };
}
