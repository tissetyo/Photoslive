import { redactLogValue } from "./_observability.mjs";

const MODES = new Set(["off", "dual", "primary"]);
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value, 500).replace(/\/+$/g, "");
const supabaseUrl = environment => baseUrl(environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL);

export function postgresDirectoryStatus(environment = process.env) {
  const requested = clean(environment.PHOTOSLIVE_POSTGRES_DIRECTORY, 20).toLowerCase() || "off";
  const mode = MODES.has(requested) ? requested : "off";
  const configured = Boolean(supabaseUrl(environment) && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 8));
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || 1_500);
  return {
    mode,
    primary: mode === "primary",
    enabled: mode !== "off",
    configured,
    timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(5_000, Math.round(configuredTimeout))) : 1_500,
    reason: mode === "off" ? "Direktori PostgreSQL belum diaktifkan" : configured ? "" : "Credential Supabase server belum lengkap",
  };
}

async function directoryRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const status = postgresDirectoryStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, status: 503, reason: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await (options.fetchImplementation || fetch)(`${supabaseUrl(environment)}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`PostgreSQL directory gagal (${response.status})`), { status: response.status });
    return { ok: true, skipped: false, payload: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `PostgreSQL directory timeout setelah ${status.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.directory.failed", operation: name, identity, reason })));
    return { ok: false, skipped: false, status: Number(error?.status || 503), reason };
  } finally {
    clearTimeout(timeout);
  }
}

function safeDirectory(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const boothCode = clean(payload.boothCode, 64).toLowerCase();
  const machineId = clean(payload.machineId, 160);
  const organizationId = clean(payload.organizationId, 64);
  const organizationLegacyId = clean(payload.organizationLegacyId, 120);
  const name = clean(payload.name, 120);
  if (!boothCode || !machineId || !organizationId || !organizationLegacyId || !name) return null;
  return {
    boothCode,
    machineId,
    organizationId,
    organizationLegacyId,
    name,
    location: clean(payload.location, 120),
    accessEnabled: payload.accessEnabled !== false,
    updatedAt: clean(payload.updatedAt, 64),
  };
}

export async function persistPostgresBoothDirectory(input = {}, options = {}) {
  const boothCode = clean(input.boothCode, 64).toLowerCase();
  const machineId = clean(input.machineId, 160);
  const organizationLegacyId = clean(input.organizationLegacyId, 120);
  const organizationName = clean(input.organizationName || input.name, 120);
  const name = clean(input.name, 120);
  const location = clean(input.location, 120);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(boothCode) || !/^[A-Za-z0-9._:-]{3,160}$/.test(machineId)) throw new Error("Identitas direktori PostgreSQL tidak valid");
  if (!/^[A-Za-z0-9._:-]{3,120}$/.test(organizationLegacyId) || !organizationName || !name) throw new Error("Organisasi atau nama photobox tidak valid");
  const result = await directoryRpc("photoslive_persist_booth_directory", {
    p_booth_code: boothCode,
    p_machine_id: machineId,
    p_organization_legacy_id: organizationLegacyId,
    p_organization_name: organizationName,
    p_name: name,
    p_location: location,
    p_access_enabled: input.accessEnabled !== false,
  }, boothCode, options);
  if (!result.ok) return result;
  if (result.skipped) return result;
  const directory = safeDirectory(result.payload);
  return directory ? { ...result, directory } : { ok: false, skipped: false, status: 503, reason: "Snapshot direktori PostgreSQL tidak valid" };
}

export async function readPostgresBoothDirectory(boothCodeInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(boothCode)) return null;
  const result = await directoryRpc("photoslive_booth_directory_snapshot", { p_booth_code: boothCode }, boothCode, options);
  return result.ok ? safeDirectory(result.payload) : null;
}

export async function updatePostgresBoothAccess(boothCodeInput, enabled, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(boothCode)) throw new Error("Kode photobox PostgreSQL tidak valid");
  const result = await directoryRpc("photoslive_set_booth_access", { p_booth_code: boothCode, p_access_enabled: Boolean(enabled) }, boothCode, options);
  if (!result.ok) return result;
  if (result.skipped) return result;
  const directory = safeDirectory(result.payload);
  return directory ? { ...result, directory } : { ok: false, skipped: false, status: 503, reason: "Status akses PostgreSQL tidak valid" };
}
