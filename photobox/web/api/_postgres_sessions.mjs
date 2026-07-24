import { redactLogValue } from "./_observability.mjs";

const MODES = new Set(["off", "dual", "primary"]);
const STATUSES = new Set(["active", "completed", "cancelled", "expired", "sync_pending"]);
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value, 500).replace(/\/+$/g, "");
const supabaseUrl = environment => baseUrl(environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL);
const boothPattern = /^[a-z0-9][a-z0-9-]{2,63}$/;
const sharePattern = /^[A-Za-z0-9_-]{32,100}$/;

export function postgresSessionStatus(environment = process.env) {
  const requested = clean(environment.PHOTOSLIVE_POSTGRES_SESSIONS, 20).toLowerCase() || "off";
  const mode = MODES.has(requested) ? requested : "off";
  const configured = Boolean(supabaseUrl(environment) && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 8));
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || 1_500);
  return {
    mode, primary: mode === "primary", enabled: mode !== "off", configured,
    timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(5_000, Math.round(configuredTimeout))) : 1_500,
    reason: mode === "off" ? "PostgreSQL metadata sesi belum diaktifkan" : configured ? "" : "Credential Supabase server belum lengkap",
  };
}

async function sessionRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const status = postgresSessionStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, status: 503, reason: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await (options.fetchImplementation || fetch)(`${supabaseUrl(environment)}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: environment.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`PostgreSQL sesi gagal (${response.status})`), { status: response.status });
    return { ok: true, skipped: false, payload: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `PostgreSQL sesi timeout setelah ${status.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.session.failed", operation: name, identity, reason })));
    return { ok: false, skipped: false, status: Number(error?.status || 503), reason };
  } finally { clearTimeout(timeout); }
}

function safeFiles(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).map(file => ({
    id: clean(file?.id, 160), kind: clean(file?.kind || "capture", 20),
    slotIndex: Math.max(0, Math.min(8, Number(file?.slotIndex || 0))),
    contentType: clean(file?.contentType, 80), size: Math.max(0, Number(file?.size || 0)),
    checksumSha256: /^[a-f0-9]{64}$/.test(String(file?.checksumSha256 || "")) ? file.checksumSha256 : "",
    url: clean(file?.url, 500), uploadedAt: clean(file?.uploadedAt, 64),
  })).filter(file => file.id);
}

function safeFileManifests(value, boothCode, shareCode, allowedFileIds) {
  if (!Array.isArray(value)) return [];
  const requiredPrefix = `sessions/${boothCode}/${shareCode}/`;
  return value.slice(0, 16).map(item => ({
    id: clean(item?.id, 160),
    storageMode: clean(item?.storageMode, 32),
    storageProvider: clean(item?.storageProvider, 120).toLowerCase(),
    objectKey: clean(item?.objectKey, 500),
    etag: clean(item?.etag, 200),
  })).filter(item => allowedFileIds.has(item.id)
    && item.storageMode === "object-storage"
    && item.objectKey.startsWith(requiredPrefix)
    && !item.objectKey.includes(".."));
}

function safeSession(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const boothCode = clean(payload.boothCode, 64).toLowerCase();
  const shareCode = clean(payload.shareCode, 100);
  const status = clean(payload.status, 20);
  const createdAt = clean(payload.createdAt, 64);
  const expiresAt = clean(payload.expiresAt, 64);
  if (!boothPattern.test(boothCode) || !sharePattern.test(shareCode) || !STATUSES.has(status) || !Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(expiresAt))) return null;
  const files = safeFiles(payload.files);
  return {
    boothCode, shareCode, status,
    machineId: clean(payload.machineId, 160), localSessionId: clean(payload.localSessionId, 160),
    frameId: clean(payload.frameId, 160), photoSlots: Math.max(1, Math.min(8, Number(payload.photoSlots || 1))),
    files,
    fileManifests: safeFileManifests(payload.fileManifests, boothCode, shareCode, new Set(files.map(file => file.id))),
    deletionRequested: payload.deletionRequested === true,
    deletionRequestedAt: clean(payload.deletionRequestedAt, 64) || null,
    createdAt, completedAt: clean(payload.completedAt, 64) || null,
    expiresAt, updatedAt: clean(payload.updatedAt, 64), deleted: payload.deleted === true,
  };
}

function sessionInput(record = {}) {
  const safe = safeSession(record);
  if (!safe) throw new Error("Metadata sesi PostgreSQL tidak valid");
  const metadata = {
    machineId: safe.machineId, localSessionId: safe.localSessionId, frameId: safe.frameId,
    photoSlots: safe.photoSlots, files: safe.files, fileManifests: safe.fileManifests,
    ...(safe.deletionRequested ? { deletionRequested: true, deletionRequestedAt: safe.deletionRequestedAt } : {}),
  };
  return { safe, metadata };
}

export async function persistPostgresSession(record = {}, options = {}) {
  const { safe, metadata } = sessionInput(record);
  const result = await sessionRpc("photoslive_persist_photo_session", {
    p_booth_code: safe.boothCode, p_share_code: safe.shareCode, p_status: safe.status,
    p_metadata: metadata, p_started_at: safe.createdAt, p_completed_at: safe.completedAt,
    p_expires_at: safe.expiresAt,
  }, `${safe.boothCode}:${safe.shareCode.slice(0, 8)}`, options);
  if (!result.ok || result.skipped) return result;
  const session = safeSession(result.payload);
  return session ? { ...result, session } : { ok: false, skipped: false, status: 503, reason: "Snapshot sesi PostgreSQL tidak valid" };
}

export async function readPostgresSession(boothCodeInput, shareCodeInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  const shareCode = clean(shareCodeInput, 100);
  if (!boothPattern.test(boothCode) || !sharePattern.test(shareCode)) return null;
  const result = await sessionRpc("photoslive_photo_session_snapshot", { p_booth_code: boothCode, p_share_code: shareCode }, `${boothCode}:${shareCode.slice(0, 8)}`, options);
  return result.ok ? safeSession(result.payload) : null;
}

export async function expirePostgresSession(boothCodeInput, shareCodeInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  const shareCode = clean(shareCodeInput, 100);
  if (!boothPattern.test(boothCode) || !sharePattern.test(shareCode)) throw new Error("Identitas sesi PostgreSQL tidak valid");
  return sessionRpc("photoslive_expire_photo_session", { p_booth_code: boothCode, p_share_code: shareCode }, `${boothCode}:${shareCode.slice(0, 8)}`, options);
}

export async function requestPostgresSessionDeletion(boothCodeInput, shareCodeInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  const shareCode = clean(shareCodeInput, 100);
  if (!boothPattern.test(boothCode) || !sharePattern.test(shareCode)) throw new Error("Identitas sesi PostgreSQL tidak valid");
  const result = await sessionRpc("photoslive_request_photo_session_deletion", { p_booth_code: boothCode, p_share_code: shareCode }, `${boothCode}:${shareCode.slice(0, 8)}`, options);
  if (!result.ok || result.skipped) return result;
  const session = safeSession(result.payload);
  return session ? { ...result, session } : { ok: false, skipped: false, status: 503, reason: "Snapshot permintaan hapus PostgreSQL tidak valid" };
}
