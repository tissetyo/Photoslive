import { redactLogValue } from "./_observability.mjs";

const MODES = new Set(["off", "dual", "primary"]);
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value, 500).replace(/\/+$/g, "");
const supabaseUrl = environment => baseUrl(environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL);

export function postgresUsersStatus(environment = process.env) {
  const requested = clean(environment.PHOTOSLIVE_POSTGRES_USERS, 20).toLowerCase() || "off";
  const mode = MODES.has(requested) ? requested : "off";
  const configured = Boolean(supabaseUrl(environment) && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 8));
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || 1_500);
  return {
    mode,
    primary: mode === "primary",
    enabled: mode !== "off",
    configured,
    timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(5_000, Math.round(configuredTimeout))) : 1_500,
    reason: mode === "off" ? "User PostgreSQL belum diaktifkan" : configured ? "" : "Credential Supabase server belum lengkap",
  };
}

async function userRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const status = postgresUsersStatus(environment);
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
    if (!response.ok) throw Object.assign(new Error(`PostgreSQL admin users gagal (${response.status})`), { status: response.status });
    return { ok: true, skipped: false, payload: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `PostgreSQL admin users timeout setelah ${status.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.users.failed", operation: name, identity, reason })));
    return { ok: false, skipped: false, status: Number(error?.status || 503), reason };
  } finally {
    clearTimeout(timeout);
  }
}

function safeUser(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = clean(payload.id, 120);
  const boothCode = clean(payload.boothCode, 64).toLowerCase();
  const machineId = clean(payload.machineId, 160);
  const email = clean(payload.email, 160).toLowerCase();
  if (!id || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(boothCode) || !email.includes("@")) return null;
  return {
    id,
    boothCode,
    machineId,
    email,
    name: clean(payload.name || "Pengguna", 80),
    role: ["owner", "admin", "operator"].includes(payload.role) ? payload.role : "operator",
    passwordHash: clean(payload.passwordHash, 260),
    pinHash: clean(payload.pinHash, 260),
    active: payload.active !== false,
    createdAt: clean(payload.createdAt, 64),
    updatedAt: clean(payload.updatedAt, 64),
  };
}

function publicUserInput(user = {}) {
  return {
    id: clean(user.id, 120),
    boothCode: clean(user.boothCode, 64).toLowerCase(),
    machineId: clean(user.machineId, 160),
    email: clean(user.email, 160).toLowerCase(),
    name: clean(user.name || "Pengguna", 80),
    role: ["owner", "admin", "operator"].includes(user.role) ? user.role : "operator",
    passwordHash: clean(user.passwordHash, 260),
    pinHash: clean(user.pinHash, 260),
    active: user.active !== false,
  };
}

export async function persistPostgresAdminUser(user, options = {}) {
  const safe = publicUserInput(user);
  if (!safe.id || !safe.boothCode || !safe.email || !safe.pinHash) throw new Error("User admin PostgreSQL tidak valid");
  const result = await userRpc("photoslive_persist_admin_user", { p_user: safe }, safe.id, options);
  if (!result.ok || result.skipped) return result;
  const stored = safeUser(result.payload);
  return stored ? { ...result, user: stored } : { ok: false, skipped: false, status: 503, reason: "Snapshot user PostgreSQL tidak valid" };
}

export async function readPostgresAdminUserByEmail(email, options = {}) {
  const result = await userRpc("photoslive_admin_user_by_email", { p_email: clean(email, 160).toLowerCase() }, email, options);
  return result.ok ? safeUser(result.payload) : null;
}

export async function readPostgresAdminUserById(id, options = {}) {
  const result = await userRpc("photoslive_admin_user_by_id", { p_user_id: clean(id, 120) }, id, options);
  return result.ok ? safeUser(result.payload) : null;
}

export async function listPostgresAdminUsers(boothCode, options = {}) {
  const result = await userRpc("photoslive_admin_users_for_booth", { p_booth_code: clean(boothCode, 64).toLowerCase() }, boothCode, options);
  if (!result.ok || !Array.isArray(result.payload)) return [];
  return result.payload.map(safeUser).filter(Boolean);
}
