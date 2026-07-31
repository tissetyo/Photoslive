import {
  authenticateWebSession,
  getRedis,
  isUpstashMaxRequestsError,
  boothKey,
  jobKey,
  machineKey,
  now,
  pairingCode,
  setupToken,
  queueKey,
  randomId,
  sha256,
  signHardwareJob,
  verifyScopedToken,
} from "./_store.mjs";
import { enqueueRemoteJob, HARDWARE_JOB_TYPES } from "./_remote_jobs.mjs";
import { requestContext, observedError, observedResponse } from "./_observability.mjs";
import {
  completeMultipartUpload,
  initiateMultipartUpload,
  inspectObject,
  objectStorageConfiguration,
  presignMultipartPart,
  presignObjectRequest,
  publicObjectStorageStatus,
} from "./_object_storage.mjs";
import { resolveMachineIncident } from "./_fleet_health.mjs";
import { recordTelemetrySnapshot } from "./_telemetry_history.mjs";
import { trackPublicSessionFileRetention, trackPublicSessionRetention } from "./_session_retention.mjs";
import { resolveProviderRuntime, resolveProviderRuntimeForCapability } from "./_provider_connections.mjs";
import { persistPostgresSession, postgresSessionStatus, readPostgresSession, reconcilePostgresSessions } from "./_postgres_sessions.mjs";
import { postgresSettingsStatus, readPostgresSettings } from "./_postgres_settings.mjs";
import { postgresVoucherStatus, readPostgresVoucherSnapshot, redeemPostgresVoucher } from "./_postgres_vouchers.mjs";
import {
  activatePostgresHelper,
  bootstrapPostgresBrowserStation,
  claimPostgresMachine,
  createPostgresMachineClaim,
  inspectPostgresMachineClaim,
  postgresAccountsStatus,
  registerPostgresBrowserInstallation,
  updatePostgresBrowserCapabilities,
  updatePostgresHelperRuntime,
} from "./_postgres_accounts.mjs";
import QRCode from "qrcode";
import {
  createPostgresSetupCode,
  markPostgresMachinePaired,
  persistPostgresHeartbeat,
  persistPostgresMachine,
  postgresMachineStatus,
  readPostgresMachine,
  readPostgresMachineStatus,
  readPostgresPairing,
} from "./_postgres_machines.mjs";

const json = (response, status = 200, headers = {}) => new Response(JSON.stringify(response), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...headers,
  },
});

const STATION_COOKIE_NAMES = ["__Host-photoslive_station", "photoslive_station"];

function stationCookie(request, machineId, credential) {
  const secure = new URL(request.url).protocol === "https:";
  const name = secure ? STATION_COOKIE_NAMES[0] : STATION_COOKIE_NAMES[1];
  const value = encodeURIComponent(`${machineId}:${credential}`);
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? "; Secure" : ""}`;
}

function stationIdentity(request, payload = {}) {
  const cookies = String(request.headers.get("cookie") || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean);
  let cookieValue = "";
  for (const name of STATION_COOKIE_NAMES) {
    const prefix = `${name}=`;
    const match = cookies.find(part => part.startsWith(prefix));
    if (match) {
      cookieValue = match.slice(prefix.length);
      break;
    }
  }
  let cookieMachineId = "";
  let cookieCredential = "";
  if (cookieValue) {
    try {
      const decoded = decodeURIComponent(cookieValue);
      const separator = decoded.lastIndexOf(":");
      if (separator > 0) {
        cookieMachineId = decoded.slice(0, separator);
        cookieCredential = decoded.slice(separator + 1);
      }
    } catch {
      // Invalid cookies fail normal credential verification below.
    }
  }
  return {
    machineId: String(cookieMachineId || payload.machineId || payload.installationId || "").trim(),
    credential: String(cookieCredential || payload.credential || payload.stationCredential || "").trim(),
  };
}

async function body(request) {
  if (request.method === "GET") return {};
  return request.json().catch(() => ({}));
}

async function authenticateAgent(redis, request, machineId) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!machineId || !token) return null;
  const tokenHash = await sha256(token);
  const postgresStatus = postgresMachineStatus();
  if (postgresStatus.primary) {
    const durable = await readPostgresMachine(machineId, tokenHash);
    if (durable) return durable;
  }
  if (redis) {
    try {
      const machine = await redis.get(machineKey(machineId));
      if (machine?.agentTokenHash === tokenHash) return machine;
    } catch (error) {
      if (!isUpstashMaxRequestsError(error)) throw error;
    }
  }
  if (postgresStatus.enabled && !postgresStatus.primary) {
    const durable = await readPostgresMachine(machineId, tokenHash);
    if (durable) return durable;
  }
  return null;
}

async function bestEffortRedis(operation, fallback = null) {
  try {
    return await operation();
  } catch (error) {
    if (!isUpstashMaxRequestsError(error)) throw error;
    return fallback;
  }
}

function optionalRedis() {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

async function readSyncedSession(redis, boothCode, shareCode) {
  const postgres = postgresSessionStatus();
  if (postgres.primary) {
    return await readPostgresSession(boothCode, shareCode)
      || await bestEffortRedis(() => redis.get(syncedSessionKey(boothCode, shareCode)), null);
  }
  const cached = await bestEffortRedis(() => redis.get(syncedSessionKey(boothCode, shareCode)), null);
  if (cached || !postgres.enabled) return cached;
  return readPostgresSession(boothCode, shareCode);
}

export const boothControllerPathAllowed = value => {
  const path = String(value || "").split("?")[0];
  return path === "/api/devices"
    || path === "/api/devices/camera/preview.jpg"
    || path === "/api/booth/sessions"
    || path === "/api/booth/print"
    || /^\/api\/sessions\/[^/]+\/(capture|capture-upload|select|complete)$/.test(path);
};

async function authorizeOperator(redis, request, machineId, payload = null) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const scoped = bearer ? await verifyScopedToken(bearer) : null;
  if (scoped?.scope === "booth.hardware" && scoped.machineId === machineId) {
    if (payload?.type && payload.type !== "controller.request") return null;
    if (payload?.type === "controller.request" && !boothControllerPathAllowed(payload.payload?.path)) return null;
    return { kind: "booth", ...scoped };
  }
  const session = await authenticateWebSession(redis, request);
  if (!session || (session.role !== "superadmin" && session.machineId !== machineId)) return null;
  return { kind: "admin", ...session };
}

function publicMachine(machine) {
  if (!machine) return null;
  const safe = { ...machine };
  delete safe.agentTokenHash;
  delete safe.commandKey;
  const lastSeen = safe.lastSeenAt ? Date.parse(safe.lastSeenAt) : 0;
  safe.online = Boolean(lastSeen && Date.now() - lastSeen < 90_000);
  safe.agentState = safe.online ? (safe.agentState || "running") : "offline";
  safe.controllerState = safe.online && safe.controller?.online ? "online" : "offline";
  safe.desiredState ||= "running";
  return safe;
}

function persistentBoothCode(machine, preferred = "") {
  const clean = String(preferred || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return clean || machine.boothCode || `pl-${String(machine.id).replace(/^machine_/, "").slice(0, 8)}`;
}

const syncedSessionKey = (boothCode, shareCode) => `photoslive:public-session:${boothCode}:${shareCode}`;
const syncedSessionFileKey = (boothCode, shareCode, fileId) => `photoslive:public-session-file:${boothCode}:${shareCode}:${fileId}`;
const sessionUploadIntentKey = uploadId => `photoslive:session-upload-intent:${uploadId}`;
const PUBLIC_SESSION_TTL_SECONDS = 86_400;
const PUBLIC_SESSION_CODE_PATTERN = /^[A-Za-z0-9_-]{32,100}$/;
const SESSION_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const SESSION_FILE_KINDS = new Set(["capture", "composite", "gif"]);
const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MIN_INTERVAL_MS = Math.max(60_000, Number(process.env.PHOTOSLIVE_HEARTBEAT_MIN_INTERVAL_MS || 300_000));
const REDIS_QUOTA_RETRY_AFTER_SECONDS = Math.max(300, Number(process.env.PHOTOSLIVE_REDIS_QUOTA_RETRY_AFTER_SECONDS || 1_800));
const IDLE_JOB_POLL_SECONDS = Math.max(60, Number(process.env.PHOTOSLIVE_IDLE_JOB_POLL_SECONDS || 300));
const heartbeatCache = globalThis.__photosliveHeartbeatCache ||= new Map();

function normalizedPublicSessionCode(value) {
  const code = String(value || "").trim();
  return PUBLIC_SESSION_CODE_PATTERN.test(code) ? code : "";
}

function sessionRemainingTtl(record) {
  const remaining = Math.ceil((Date.parse(record?.expiresAt || "") - Date.now()) / 1000);
  return Number.isFinite(remaining) ? Math.max(0, Math.min(PUBLIC_SESSION_TTL_SECONDS, remaining)) : 0;
}

function multipartPartSize() {
  return Math.max(MULTIPART_MIN_PART_BYTES, Math.min(20 * 1024 * 1024, Number(process.env.PHOTOSLIVE_MULTIPART_PART_BYTES || MULTIPART_MIN_PART_BYTES)));
}

function multipartThreshold() {
  return Math.max(MULTIPART_MIN_PART_BYTES, Number(process.env.PHOTOSLIVE_MULTIPART_THRESHOLD_BYTES || MULTIPART_MIN_PART_BYTES));
}

async function heartbeatCacheKey(request, payload) {
  const machineId = String(payload.machineId || "");
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  return machineId && token ? `${machineId}:${await sha256(token)}` : "";
}

function cachedHeartbeatResponse(cacheKey) {
  const cached = cacheKey ? heartbeatCache.get(cacheKey) : null;
  if (!cached || Date.now() - Number(cached.acceptedAt || 0) > HEARTBEAT_MIN_INTERVAL_MS) return null;
  return json({
    ...cached.response,
    ok: true,
    cached: true,
    minimumHeartbeatSeconds: Math.ceil(HEARTBEAT_MIN_INTERVAL_MS / 1000),
    serverTime: now(),
  });
}

function storeHeartbeatResponse(cacheKey, response) {
  if (!cacheKey) return;
  heartbeatCache.set(cacheKey, { acceptedAt: Date.now(), response });
  if (heartbeatCache.size <= 500) return;
  const cutoff = Date.now() - HEARTBEAT_MIN_INTERVAL_MS * 2;
  for (const [key, value] of heartbeatCache) {
    if (Number(value.acceptedAt || 0) < cutoff) heartbeatCache.delete(key);
    if (heartbeatCache.size <= 400) break;
  }
}

function redisQuotaResponse(contextId = "") {
  return json({
    error: "Cache Redis Upstash sedang mencapai batas gratis. Data utama tetap disimpan di Supabase jika mode PostgreSQL aktif.",
    code: "UPSTASH_MAX_REQUESTS_EXCEEDED",
    retryable: true,
    degraded: true,
    actionRequired: "Tidak perlu install ulang Agent. Tunggu reset kuota Redis atau ganti credential Redis hanya untuk memulihkan cache, job remote, dan status real-time.",
    retryAfterSeconds: REDIS_QUOTA_RETRY_AFTER_SECONDS,
    correlationId: contextId || undefined,
  }, 503, { "retry-after": String(REDIS_QUOTA_RETRY_AFTER_SECONDS) });
}

function normalizedSessionFile(payload) {
  const fileKind = SESSION_FILE_KINDS.has(String(payload.fileKind || "capture")) ? String(payload.fileKind || "capture") : "capture";
  const slotIndex = fileKind === "capture" ? Math.max(1, Math.min(8, Number(payload.slotIndex || 1))) : 0;
  const fileId = String(payload.fileId || `${fileKind}-${slotIndex}`).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 120);
  const contentType = String(payload.contentType || "image/jpeg").toLowerCase();
  const checksumSha256 = String(payload.checksumSha256 || "").toLowerCase();
  const contentMd5 = String(payload.contentMd5 || "").trim();
  const size = Math.max(0, Number(payload.size || 0));
  return { fileKind, slotIndex, fileId, contentType, checksumSha256, contentMd5, size };
}

function sessionObjectKey(boothCode, shareCode, file) {
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[file.contentType] || "bin";
  return `sessions/${boothCode}/${shareCode}/${file.fileId}.${extension}`;
}

async function storageRuntimeForMachine(redis, machine, providerId = "") {
  const context = {
    boothCode: persistentBoothCode(machine),
    organizationId: machine?.organizationId || "",
  };
  return providerId
    ? resolveProviderRuntime(redis, providerId, context)
    : resolveProviderRuntimeForCapability(redis, "cloudStorage", context);
}

async function storeSessionFileRecord(redis, record, boothCode, shareCode, file, storage = {}) {
  const publicFile = {
    id: file.fileId,
    kind: file.fileKind,
    slotIndex: file.slotIndex,
    contentType: file.contentType,
    size: file.size,
    checksumSha256: file.checksumSha256,
    url: `/api/platform?action=public_session_file&booth=${encodeURIComponent(boothCode)}&session=${encodeURIComponent(shareCode)}&file=${encodeURIComponent(file.fileId)}`,
    uploadedAt: now(),
  };
  const ttl = sessionRemainingTtl(record);
  if (!ttl) throw new Error("Sesi upload sudah kedaluwarsa");
  record.files = [...(record.files || []).filter(item => item.id !== file.fileId && !(file.fileKind === "capture" && (item.kind || "capture") === "capture" && Number(item.slotIndex) === file.slotIndex)), publicFile]
    .sort((left, right) => Number(left.slotIndex || 0) - Number(right.slotIndex || 0));
  record.fileManifests = (record.fileManifests || []).filter(item => item.id !== file.fileId);
  if (storage.storageMode === "object-storage" && storage.objectKey) {
    record.fileManifests.push({
      id: file.fileId,
      storageMode: "object-storage",
      storageProvider: String(storage.storageProvider || ""),
      objectKey: String(storage.objectKey),
      etag: String(storage.etag || ""),
    });
  }
  record.updatedAt = now();
  const postgres = postgresSessionStatus();
  if (postgres.primary && storage.storageMode === "object-storage") {
    const persisted = await persistPostgresSession(record);
    if (!persisted.ok) throw new Error(persisted.reason || "Metadata file belum dapat disimpan ke PostgreSQL");
  }
  const fileRecord = { ...publicFile, ...storage };
  const redisRequired = storage.storageMode === "legacy-redis";
  const cacheWrite = async () => {
    await redis.set(syncedSessionFileKey(boothCode, shareCode, file.fileId), fileRecord, { ex: ttl });
    await redis.set(syncedSessionKey(boothCode, shareCode), record, { ex: ttl });
    await trackPublicSessionFileRetention(redis, record, fileRecord);
  };
  if (redisRequired) {
    await cacheWrite();
  } else {
    await bestEffortRedis(cacheWrite);
  }
  if (postgres.mode === "dual" || (postgres.primary && storage.storageMode !== "object-storage")) {
    const persisted = await persistPostgresSession(record);
    if (postgres.primary && !persisted.ok) throw new Error(persisted.reason || "Metadata file belum dapat disimpan ke PostgreSQL");
  }
  return publicFile;
}

async function syncSessionMetadata(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  const session = payload.session && typeof payload.session === "object" ? payload.session : {};
  const shareCode = normalizedPublicSessionCode(session.shareCode);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const key = syncedSessionKey(boothCode, shareCode);
  const postgres = postgresSessionStatus();
  const previous = postgres.primary
    ? await readPostgresSession(boothCode, shareCode) || await bestEffortRedis(() => redis.get(key), null) || {}
    : await redis.get(key) || {};
  const hadPrevious = Boolean(previous?.shareCode);
  const record = {
    ...previous,
    boothCode,
    machineId: machine.id,
    shareCode,
    localSessionId: String(session.id || previous?.localSessionId || ""),
    status: "completed",
    frameId: String(session.frameId || previous?.frameId || ""),
    photoSlots: Math.max(1, Math.min(8, Number(session.photoSlots || previous?.photoSlots || 1))),
    files: Array.isArray(previous?.files) ? previous.files : [],
    createdAt: session.createdAt || previous?.createdAt || now(),
    completedAt: session.completedAt || previous?.completedAt || now(),
    expiresAt: previous?.expiresAt || new Date(Date.now() + PUBLIC_SESSION_TTL_SECONDS * 1000).toISOString(),
    updatedAt: now(),
  };
  const ttl = sessionRemainingTtl(record);
  if (!ttl) return json({ error: "Sesi sudah kedaluwarsa" }, 404);
  if (postgres.primary) {
    const persisted = await persistPostgresSession(record);
    if (!persisted.ok) return json({ error: "Metadata sesi belum dapat disimpan ke cloud. Foto lokal tetap aman dan sinkronisasi akan dicoba lagi.", retryable: true }, 503);
  }
  await bestEffortRedis(() => redis.set(key, record, { ex: ttl }));
  await bestEffortRedis(() => trackPublicSessionRetention(redis, record));
  if (postgres.mode === "dual") await persistPostgresSession(record);
  return json({ session: record, url: `/${boothCode}/sesi/${shareCode}` }, hadPrevious ? 200 : 201);
}

async function reconcileSessions(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const sessions = Array.isArray(payload.sessions) ? payload.sessions.slice(0, 500) : [];
  let result;
  try {
    result = await reconcilePostgresSessions(persistentBoothCode(machine), machine.id, sessions);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.message : "Rekonsiliasi sesi tidak valid",
      code: "SESSION_RECONCILIATION_INVALID",
      retryable: false,
    }, 400);
  }
  if (!result.ok || result.skipped) {
    return json({
      error: result.reason || "Rekonsiliasi sesi belum dapat disimpan ke PostgreSQL",
      code: "POSTGRES_RECONCILIATION_FAILED",
      retryable: true,
    }, Number(result.status || 503));
  }
  return json({
    updated: Number(result.updated || 0),
    reconciledAt: result.reconciledAt || now(),
    source: "postgres",
  });
}

async function syncSessionFile(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  const shareCode = normalizedPublicSessionCode(payload.shareCode);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const file = normalizedSessionFile(payload);
  const record = await readSyncedSession(redis, boothCode, shareCode);
  if (!record || record.machineId !== machine.id || !sessionRemainingTtl(record)) return json({ error: "Metadata sesi belum tersinkron atau sudah kedaluwarsa" }, 409);
  if (!file.fileId) return json({ error: "ID file sesi tidak valid" }, 400);
  if (!SESSION_CONTENT_TYPES.has(file.contentType)) return json({ error: "Format foto tidak didukung" }, 415);
  let bytes;
  try {
    bytes = Uint8Array.from(atob(String(payload.bodyBase64 || "")), character => character.charCodeAt(0));
  } catch {
    return json({ error: "File foto bukan Base64 yang valid" }, 400);
  }
  if (!bytes.byteLength || bytes.byteLength > 1_800_000) return json({ error: "Foto cloud maksimal 1,8 MB" }, 413);
  const checksumSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (file.checksumSha256 && checksumSha256 !== file.checksumSha256) return json({ error: "Checksum foto tidak cocok" }, 422);
  const stored = await storeSessionFileRecord(redis, record, boothCode, shareCode, { ...file, size: bytes.byteLength, checksumSha256 }, { storageMode: "legacy-redis", bodyBase64: payload.bodyBase64 });
  return json({ file: stored, storageMode: "legacy-redis" }, 201);
}

async function prepareSessionFile(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  const shareCode = normalizedPublicSessionCode(payload.shareCode);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const record = await readSyncedSession(redis, boothCode, shareCode);
  if (!record || record.machineId !== machine.id || !sessionRemainingTtl(record)) return json({ error: "Metadata sesi belum tersinkron atau sudah kedaluwarsa" }, 409);
  const file = normalizedSessionFile(payload);
  if (!file.fileId) return json({ error: "ID file sesi tidak valid" }, 400);
  if (!SESSION_CONTENT_TYPES.has(file.contentType)) return json({ error: "Format foto tidak didukung" }, 415);
  if (!/^[a-f0-9]{64}$/.test(file.checksumSha256)) return json({ error: "Checksum SHA-256 wajib diisi" }, 400);
  if (!/^[A-Za-z0-9+/]{22}==$/.test(file.contentMd5)) return json({ error: "Content-MD5 wajib diisi" }, 400);
  if (!file.size || file.size > 25_000_000) return json({ error: "File sesi maksimal 25 MB" }, 413);
  const runtime = await storageRuntimeForMachine(redis, machine);
  const environment = runtime?.environment || process.env;
  if (!objectStorageConfiguration(environment)) return json({ mode: "legacy-redis", maxFileBytes: 1_800_000 });
  const resumeUploadId = String(payload.resumeUploadId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
  if (resumeUploadId) {
    const previous = await redis.get(sessionUploadIntentKey(resumeUploadId));
    if (previous?.mode === "multipart-object-storage"
      && previous.machineId === machine.id
      && previous.shareCode === shareCode
      && previous.file?.fileId === file.fileId
      && previous.file?.checksumSha256 === file.checksumSha256) {
      return json({
        mode: previous.mode,
        uploadId: previous.uploadId,
        partSize: previous.partSize,
        totalParts: previous.totalParts,
        maxFileBytes: 25_000_000,
        resumed: true,
      });
    }
  }
  const uploadId = randomId("upload");
  const objectKey = sessionObjectKey(boothCode, shareCode, file);
  if (file.size >= multipartThreshold()) {
    const partSize = multipartPartSize();
    const totalParts = Math.ceil(file.size / partSize);
    const multipart = await initiateMultipartUpload({ objectKey, contentType: file.contentType, checksumSha256: file.checksumSha256, environment });
    await redis.set(sessionUploadIntentKey(uploadId), {
      uploadId,
      mode: "multipart-object-storage",
      multipartUploadId: multipart.multipartUploadId,
      boothCode,
      shareCode,
      machineId: machine.id,
      objectKey,
      provider: multipart.provider,
      file,
      partSize,
      totalParts,
      createdAt: now(),
    }, { ex: sessionRemainingTtl(record) });
    return json({ mode: "multipart-object-storage", uploadId, partSize, totalParts, maxFileBytes: 25_000_000 }, 201);
  }
  const upload = await presignObjectRequest({ method: "PUT", objectKey, contentType: file.contentType, checksumSha256: file.checksumSha256, contentMd5: file.contentMd5, expiresIn: 600, environment });
  await redis.set(sessionUploadIntentKey(uploadId), { uploadId, mode: "direct-object-storage", boothCode, shareCode, machineId: machine.id, objectKey, provider: upload.provider, file, createdAt: now() }, { ex: sessionRemainingTtl(record) });
  return json({ mode: "direct-object-storage", uploadId, upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt }, maxFileBytes: 25_000_000 }, 201);
}

async function prepareSessionFilePart(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const uploadId = String(payload.uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
  const intent = await redis.get(sessionUploadIntentKey(uploadId));
  if (!intent || intent.machineId !== machine.id || intent.mode !== "multipart-object-storage") return json({ error: "Multipart upload tidak ditemukan atau sudah kedaluwarsa" }, 404);
  const partNumber = Number(payload.partNumber);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > intent.totalParts) return json({ error: "Nomor part multipart tidak valid" }, 400);
  const runtime = await storageRuntimeForMachine(redis, machine, intent.provider);
  const upload = await presignMultipartPart({ objectKey: intent.objectKey, multipartUploadId: intent.multipartUploadId, partNumber, expiresIn: 600, environment: runtime?.environment || process.env });
  return json({ uploadId, partNumber, upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt } }, 201);
}

async function completeSessionFileMultipart(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const uploadId = String(payload.uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
  const intent = await redis.get(sessionUploadIntentKey(uploadId));
  if (!intent || intent.machineId !== machine.id || intent.mode !== "multipart-object-storage") return json({ error: "Multipart upload tidak ditemukan atau sudah kedaluwarsa" }, 404);
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const partNumbers = new Set(parts.map(part => Number(part?.partNumber)));
  if (parts.length !== intent.totalParts || partNumbers.size !== intent.totalParts || ![...partNumbers].every(number => number >= 1 && number <= intent.totalParts)) {
    return json({ error: "Checkpoint part multipart belum lengkap" }, 409);
  }
  const record = await readSyncedSession(redis, intent.boothCode, intent.shareCode);
  if (!record || record.machineId !== machine.id || !sessionRemainingTtl(record)) return json({ error: "Sesi upload tidak valid atau sudah kedaluwarsa" }, 409);
  const runtime = await storageRuntimeForMachine(redis, machine, intent.provider);
  const environment = runtime?.environment || process.env;
  const completed = await completeMultipartUpload({ objectKey: intent.objectKey, multipartUploadId: intent.multipartUploadId, parts, environment });
  const object = await inspectObject({ objectKey: intent.objectKey, environment });
  if (!object || object.size !== intent.file.size) return json({ error: "Ukuran file multipart tidak cocok" }, 422);
  if (object.checksumSha256 && object.checksumSha256 !== intent.file.checksumSha256) return json({ error: "Checksum multipart tidak cocok" }, 422);
  const file = await storeSessionFileRecord(redis, record, intent.boothCode, intent.shareCode, intent.file, {
    storageMode: "object-storage",
    storageProvider: intent.provider,
    objectKey: intent.objectKey,
    etag: object.etag || completed.etag,
  });
  await redis.del(sessionUploadIntentKey(uploadId));
  return json({ file, storageMode: "object-storage", multipart: true }, 201);
}

async function finalizeSessionFile(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const uploadId = String(payload.uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 160);
  const intent = await redis.get(sessionUploadIntentKey(uploadId));
  if (!intent || intent.machineId !== machine.id) return json({ error: "Upload tidak ditemukan atau sudah kedaluwarsa" }, 404);
  const record = await readSyncedSession(redis, intent.boothCode, intent.shareCode);
  if (!record || record.machineId !== machine.id || !sessionRemainingTtl(record)) return json({ error: "Sesi upload tidak valid atau sudah kedaluwarsa" }, 409);
  const runtime = await storageRuntimeForMachine(redis, machine, intent.provider);
  const object = await inspectObject({ objectKey: intent.objectKey, environment: runtime?.environment || process.env });
  if (!object || object.size !== intent.file.size) return json({ error: "Ukuran file object storage tidak cocok" }, 422);
  if (object.checksumSha256 && object.checksumSha256 !== intent.file.checksumSha256) return json({ error: "Checksum object storage tidak cocok" }, 422);
  const file = await storeSessionFileRecord(redis, record, intent.boothCode, intent.shareCode, intent.file, { storageMode: "object-storage", storageProvider: intent.provider, objectKey: intent.objectKey, etag: object.etag });
  await redis.del(sessionUploadIntentKey(uploadId));
  return json({ file, storageMode: "object-storage" }, 201);
}

async function commandSignature(secret, job) {
  return signHardwareJob(secret, job);
}

async function createPairing(redis, payload) {
  const postgresStatus = postgresMachineStatus();
  const accountStatus = postgresAccountsStatus();
  const suppliedMachineId = String(payload.machineId || "").trim();
  const machineId = /^[A-Za-z0-9._:-]{3,160}$/.test(suppliedMachineId)
    ? suppliedMachineId
    : randomId("machine");
  const agentToken = payload.agentToken || randomId("agent");
  const localSetup = payload.localSetup && typeof payload.localSetup === "object" ? payload.localSetup : {};
  const preferredBoothCode = String(payload.boothCode || localSetup.boothCode || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 63);
  // The machine registry still keeps a short recovery code for legacy Agents,
  // but operator onboarding no longer depends on it. Keep the value compatible
  // with the PostgreSQL 4-4 constraint so background registration cannot fail.
  const code = pairingCode();
  const claimToken = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const createdAt = now();
  const agentTokenHash = await sha256(agentToken);
  const machine = {
    id: machineId,
    name: String(payload.name || "Photoslive Booth").slice(0, 80),
    location: String(payload.location || "").slice(0, 120),
    platform: String(payload.platform || "Unknown").slice(0, 120),
    agentVersion: String(payload.agentVersion || "dev").slice(0, 40),
    status: "waiting_pairing",
    paired: false,
    pairingCode: code,
    boothCode: /^[a-z0-9][a-z0-9-]{2,62}$/.test(preferredBoothCode)
      ? preferredBoothCode
      : `pl-${machineId.replace(/^machine_/, "").slice(0, 8).toLowerCase()}`,
    pairingExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    agentTokenHash,
    createdAt,
    lastSeenAt: null,
    telemetry: {},
    devices: [],
    agentState: "starting",
    controllerState: "offline",
    desiredState: "running",
    update: { status: "idle" },
    commandKey: randomId("command"),
    pairedAt: null,
  };
  if (postgresStatus.primary) {
    const persisted = await persistPostgresMachine(machine);
    if (!persisted.ok) throw Object.assign(new Error(persisted.reason || "Pairing PostgreSQL gagal dibuat"), { status: Number(persisted.status || 503) });
  }
  let claimId = null;
  if (accountStatus.primary) {
    const claim = await createPostgresMachineClaim({
      machineId,
      tokenHash: await sha256(claimToken),
      codeHash: await sha256(code),
      expiresAt: machine.pairingExpiresAt,
      snapshot: {
        name: machine.name,
        platform: machine.platform,
        agentVersion: machine.agentVersion,
        controllerVersion: String(localSetup.controllerVersion || ""),
        devices: Array.isArray(localSetup.devices) ? localSetup.devices.slice(0, 24) : [],
        boothCode: machine.boothCode,
        installationMode: String(localSetup.installationMode || "agent").slice(0, 24),
      },
      idempotencyKey: `install:${machineId}:${code}`,
    });
    if (!claim.ok) {
      throw Object.assign(new Error(claim.reason || "Claim PostgreSQL gagal dibuat"), {
        status: Number(claim.status || 503),
      });
    }
    claimId = String(claim.payload?.claimId || claim.payload?.claim_id || "") || null;
  }
  if (redis) {
    await bestEffortRedis(async () => {
      await redis.set(machineKey(machineId), machine);
      await redis.set(`photoslive:pairing:${code}`, machineId, { ex: 900 });
    });
  }
  if (postgresStatus.mode === "dual") await persistPostgresMachine(machine);
  return {
    machineId,
    agentToken,
    commandKey: machine.commandKey,
    setupToken: code,
    // Temporary compatibility for Agent versions older than 0.10.
    pairingCode: code,
    pairingToken: claimToken,
    pairingUrl: `https://photoslive.vercel.app/pair/${claimToken}`,
    claimId,
    expiresInSeconds: 900,
    boothCode: machine.boothCode,
    paired: false,
  };
}

async function createWebPairing(redis, request, payload) {
  const suppliedInstallationId = String(payload.installationId || "").trim();
  const installationId = /^[A-Za-z0-9._:-]{12,160}$/.test(suppliedInstallationId)
    ? suppliedInstallationId
    : `web_${crypto.randomUUID().replaceAll("-", "")}`;
  const stationCredential = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const browserCapabilities = {
    camera: { source: "browser", available: true },
    print: { mode: "dialog", available: true, silent: false },
    helper: { installed: false, enabled: false, online: false },
    dslr: false,
    managedLocalStorage: false,
    fullOffline: false,
  };
  const result = await createPairing(redis, {
    machineId: installationId,
    name: String(payload.name || "Photoslive Web Booth").slice(0, 80),
    location: "",
    platform: String(payload.platform || request.headers.get("user-agent") || "Web browser").slice(0, 120),
    agentVersion: "web-only",
    localSetup: {
      controllerVersion: "web",
      devices: [],
      installationMode: "web",
    },
  });
  const station = await registerPostgresBrowserInstallation({
    machineId: result.machineId,
    credentialHash: await sha256(stationCredential),
    capabilities: browserCapabilities,
  });
  if (!station.ok) {
    throw Object.assign(new Error(station.reason || "Credential station belum dapat disimpan"), {
      status: Number(station.status || 503),
    });
  }
  const qrImage = await QRCode.toDataURL(result.pairingUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 440,
    color: { dark: "#17191f", light: "#ffffff" },
  });
  return {
    installationId,
    machineId: result.machineId,
    machineCode: null,
    pairingCode: result.pairingCode,
    pairingToken: result.pairingToken,
    pairingUrl: result.pairingUrl,
    claimId: result.claimId,
    _stationCredential: stationCredential,
    qrImage,
    expiresInSeconds: result.expiresInSeconds,
    expiresAt: new Date(Date.now() + (result.expiresInSeconds * 1000)).toISOString(),
    paired: false,
    installationMode: "web",
    installationKind: "browser",
    capabilities: browserCapabilities,
    realtime: {
      url: String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/g, ""),
      publishableKey: String(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""),
      topic: result.claimId ? `pairing:${result.claimId}` : "",
    },
  };
}

async function stationBootstrap(request, payload) {
  const { machineId, credential } = stationIdentity(request, payload);
  if (!machineId || credential.length < 32) return json({ error: "Identitas station belum tersedia" }, 400);
  const result = await bootstrapPostgresBrowserStation({
    machineId,
    credentialHash: await sha256(credential),
  });
  if (!result.ok) {
    const status = /not paired/i.test(result.reason || "") ? 409 : /invalid/i.test(result.reason || "") ? 401 : Number(result.status || 503);
    return json({ error: result.reason || "Station belum dapat dibuka", retryable: status >= 500 }, status);
  }
  return json({ station: result.payload, paired: true });
}

async function updateStationCapabilities(request, payload) {
  const { machineId, credential } = stationIdentity(request, payload);
  if (!machineId || credential.length < 32) return json({ error: "Identitas station belum tersedia" }, 400);
  const capabilities = payload.capabilities && typeof payload.capabilities === "object" ? payload.capabilities : {};
  const result = await updatePostgresBrowserCapabilities({
    machineId,
    credentialHash: await sha256(credential),
    capabilities,
  });
  return result.ok
    ? json({ station: result.payload })
    : json({ error: result.reason || "Capability station belum dapat diperbarui", retryable: Number(result.status || 503) >= 500 }, Number(result.status || 503));
}

async function activateHelper(payload) {
  const bootstrapToken = String(payload.bootstrapToken || "").trim();
  const agentToken = String(payload.agentToken || "").trim();
  const commandKey = String(payload.commandKey || "").trim();
  if (bootstrapToken.length < 32 || agentToken.length < 32 || commandKey.length < 32) {
    return json({ error: "Bootstrap Photoslive Helper tidak valid" }, 400);
  }
  const result = await activatePostgresHelper({
    tokenHash: await sha256(bootstrapToken),
    agentTokenHash: await sha256(agentToken),
    commandKey,
    platform: payload.platform,
    agentVersion: payload.agentVersion,
  });
  if (!result.ok) {
    const status = /expired|invalid|used/i.test(result.reason || "") ? 409 : Number(result.status || 503);
    return json({ error: result.reason || "Photoslive Helper belum dapat diaktifkan", retryable: status >= 500 }, status);
  }
  return json({ helper: result.payload, paired: true, activated: true });
}

export async function claimPairing(redis, request, payload) {
  const session = await authenticateWebSession(redis, request);
  if (!session || !["owner", "admin", "superadmin"].includes(session.role)) {
    return json({ error: "Login admin diperlukan untuk memasangkan mesin" }, 401);
  }
  const code = String(payload.code || "").trim().toUpperCase();
  const token = String(payload.token || "").trim();
  const tokenHash = token ? await sha256(token) : "";
  const codeHash = code ? await sha256(code) : "";
  if (session.authProvider === "supabase" && session.authUserId && session.organizationId) {
    const durable = await claimPostgresMachine({
      userId: session.authUserId,
      organizationId: session.organizationId,
      tokenHash,
      codeHash,
      name: payload.name,
      location: payload.location,
      idempotencyKey: String(payload.idempotencyKey || `claim:${session.organizationId}:${tokenHash || codeHash}`).slice(0, 160),
      correlationId: request.headers.get("x-correlation-id") || crypto.randomUUID(),
    });
    if (!durable.ok) {
      const status = /expired|used|claimed|conflict/i.test(durable.reason || "") ? 409 : Number(durable.status || 503);
      return json({ error: durable.reason || "Mesin belum dapat dihubungkan", retryable: status >= 500 }, status);
    }
    const claimed = durable.payload || {};
    // The durable RPC returns nested machine/booth records. Read that shape
    // first so the optional legacy cache mirrors the permanent Postgres claim
    // instead of silently missing the machine identifier.
    const claimedMachine = claimed.machine || claimed;
    const claimedBooth = claimed.booth || null;
    const claimedMachineId = String(claimedMachine.machineId || claimedMachine.machine_id || "");
    const boothCode = String(claimedBooth?.boothCode || claimedBooth?.booth_code || claimed.boothCode || claimed.booth_code || "");
    if (claimedMachineId) {
      const legacyMachine = redis
        ? await bestEffortRedis(() => redis.get(machineKey(claimedMachineId)), null)
        : null;
      if (legacyMachine) {
        legacyMachine.paired = true;
        legacyMachine.status = "offline";
        legacyMachine.name = String(payload.name || legacyMachine.name).slice(0, 80);
        legacyMachine.location = String(payload.location || legacyMachine.location || "").slice(0, 120);
        legacyMachine.pairedAt ||= now();
        legacyMachine.boothCode = boothCode || persistentBoothCode(legacyMachine);
        delete legacyMachine.pairingCode;
        await bestEffortRedis(() => redis.set(machineKey(claimedMachineId), legacyMachine));
        if (legacyMachine.boothCode) await bestEffortRedis(() => redis.set(boothKey(legacyMachine.boothCode), claimedMachineId));
      }
      if (redis && code) await bestEffortRedis(() => redis.del(`photoslive:pairing:${code}`));
    }
    return json({
      machine: claimed.machine || claimed,
      booth: claimed.booth || null,
      organization: claimed.organization || null,
      paired: true,
      permanent: true,
    });
  }
  // The pre-account setup route did not have a durable organization boundary.
  // Leave it available only during an explicitly approved migration window;
  // normal installations must claim through the Postgres transaction above.
  if (process.env.PHOTOSLIVE_LEGACY_PAIRING !== "1") {
    return json({
      error: "Pairing lama dinonaktifkan. Masuk dengan akun Photoslive lalu scan QR dari Local Manager.",
      code: "ACCOUNT_PAIRING_REQUIRED",
    }, 403);
  }
  if (!code) return json({ error: "Masukkan kode pairing" }, 400);
  const postgresStatus = postgresMachineStatus();
  let machine = postgresStatus.primary ? await readPostgresPairing(code) : null;
  const machineId = machine?.id || (redis ? await bestEffortRedis(() => redis.get(`photoslive:pairing:${code}`), null) : null);
  if (!machineId) return json({ error: "Kode pairing tidak ditemukan atau sudah kedaluwarsa" }, 404);
  if (!machine && redis) machine = await bestEffortRedis(() => redis.get(machineKey(machineId)), null);
  if (!machine) return json({ error: "Data mesin tidak ditemukan" }, 404);
  if (machine.pairingCode !== code) return json({ error: "Kode pairing bukan kode terbaru untuk mesin ini" }, 409);
  machine.paired = true;
  machine.status = "offline";
  machine.name = String(payload.name || machine.name).slice(0, 80);
  machine.location = String(payload.location || "").slice(0, 120);
  machine.pairedAt = now();
  machine.boothCode = persistentBoothCode(machine, machine.boothCode || code);
  delete machine.pairingCode;
  if (postgresStatus.primary) {
    const persisted = await markPostgresMachinePaired(code, machine, machine.boothCode);
    if (!persisted.ok) return json({ error: persisted.reason || "Pairing belum dapat disimpan ke database", retryable: true }, Number(persisted.status || 503));
    machine = persisted.machine || machine;
  }
  if (redis) {
    await bestEffortRedis(() => redis.set(machineKey(machineId), machine));
    await bestEffortRedis(() => redis.set(boothKey(machine.boothCode), machineId));
    await bestEffortRedis(() => redis.del(`photoslive:pairing:${code}`));
  }
  if (postgresStatus.mode === "dual") await markPostgresMachinePaired(code, machine, machine.boothCode).catch(() => null);
  return json({ machine: publicMachine(machine) });
}

async function inspectPairing(payload) {
  const token = String(payload.token || "").trim();
  const code = String(payload.code || "").trim().toUpperCase();
  if (!token && !code) return json({ error: "Token atau kode pairing wajib diisi" }, 400);
  const claim = await inspectPostgresMachineClaim({
    tokenHash: token ? await sha256(token) : "",
    codeHash: code ? await sha256(code) : "",
  });
  if (!claim) return json({ error: "Pairing tidak ditemukan atau sudah kedaluwarsa" }, 404);
  return json({ claim });
}


export async function createSetupCode(redis, request, payload) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const tokenHash = token ? await sha256(token) : "";
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const postgresStatus = postgresMachineStatus();
  const code = setupToken();
  const previousCode = String(machine.pairingCode || "").trim().toUpperCase();
  if (previousCode) await bestEffortRedis(() => redis.del(`photoslive:pairing:${previousCode}`));
  machine.pairingCode = code;
  machine.pairingExpiresAt = new Date(Date.now() + 900_000).toISOString();
  machine.boothCode = persistentBoothCode(machine);
  if (postgresStatus.primary) {
    const persisted = await createPostgresSetupCode(machine, tokenHash, code);
    if (!persisted.ok) return json({ error: persisted.reason || "Kode setup belum dapat dibuat di database", retryable: true }, Number(persisted.status || 503));
  }
  await bestEffortRedis(async () => {
    await redis.set(machineKey(machine.id), machine);
    await redis.set(`photoslive:pairing:${code}`, machine.id, { ex: 900 });
    await redis.set(boothKey(machine.boothCode), machine.id);
  });
  // Keep the short code useful after onboarding as an alias to the canonical
  // photobox. The expiring pairing key still controls whether setup is valid.
  await bestEffortRedis(() => redis.set(boothKey(code), machine.id));
  if (postgresStatus.mode === "dual") await createPostgresSetupCode(machine, tokenHash, code);
  return json({
    setupToken: code,
    // Temporary compatibility for Agent versions older than 0.10.
    pairingCode: code,
    boothCode: machine.boothCode,
    expiresInSeconds: 900,
  });
}

async function heartbeat(redis, request, payload) {
  const cacheKey = await heartbeatCacheKey(request, payload);
  const cached = cachedHeartbeatResponse(cacheKey);
  if (cached) return cached;
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const tokenHash = token ? await sha256(token) : "";
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const postgresStatus = postgresMachineStatus();
  const protocolVersion = Math.max(1, Number(payload.protocolVersion || request.headers.get("x-photoslive-protocol-version") || 1));
  if (protocolVersion > 2) return json({ error: "Versi protokol Agent lebih baru daripada Cloud", minimumProtocolVersion: 1, protocolVersion: 2 }, 426);
  machine.lastSeenAt = now();
  machine.status = machine.paired ? "online" : "waiting_pairing";
  machine.agentVersion = String(payload.agentVersion || machine.agentVersion).slice(0, 40);
  machine.platform = String(payload.platform || machine.platform).slice(0, 120);
  machine.telemetry = payload.telemetry && typeof payload.telemetry === "object" ? payload.telemetry : {};
  machine.devices = Array.isArray(payload.devices) ? payload.devices.slice(0, 24) : [];
  machine.controller = payload.controller && typeof payload.controller === "object" ? payload.controller : {};
  machine.agentState = payload.agentState === "paused" ? "paused" : "running";
  machine.controllerState = machine.controller?.online ? "online" : "offline";
  machine.desiredState ||= "running";
  machine.update = payload.update && typeof payload.update === "object" ? payload.update : (machine.update || { status: "idle" });
  machine.sync = payload.sync && typeof payload.sync === "object" ? payload.sync : (machine.sync || {});
  machine.queue = payload.queue && typeof payload.queue === "object" ? payload.queue : (machine.queue || {});
  machine.syncJobs = Array.isArray(payload.syncJobs) ? payload.syncJobs.slice(0, 10) : [];
  machine.printJobs = Array.isArray(payload.printJobs) ? payload.printJobs.slice(0, 10) : [];
  machine.sessionRecovery = payload.sessionRecovery && typeof payload.sessionRecovery === "object" ? {
    sessions: Array.isArray(payload.sessionRecovery.sessions) ? payload.sessionRecovery.sessions.slice(0, 10).map(session => ({
      id: String(session.id || "").slice(0, 80), status: String(session.status || "unknown").slice(0, 20),
      createdAt: session.createdAt || null, deadlineAt: session.deadlineAt || null,
      photoSlots: Math.max(1, Math.min(8, Number(session.photoSlots || 1))),
      captureCount: Math.max(0, Number(session.captureCount || 0)),
      selectedPhotoCount: Math.max(0, Number(session.selectedPhotoCount || 0)),
    })) : [], measuredAt: payload.sessionRecovery.measuredAt || null,
  } : { sessions: [] };
  machine.commandKey ||= randomId("command");
  machine.boothCode = persistentBoothCode(machine);
  if (redis) {
    await recordTelemetrySnapshot(redis, machine).catch(error => {
      if (!isUpstashMaxRequestsError(error)) throw error;
      return null;
    });
    await bestEffortRedis(() => resolveMachineIncident(redis, machine, machine.lastSeenAt));
    await bestEffortRedis(() => redis.sadd("photoslive:machines", machine.id));
    if (machine.paired) await bestEffortRedis(() => redis.set(boothKey(machine.boothCode), machine.id));
  }
  let voucherVersion = 0;
  let settingsVersion = 0;
  if (machine.paired && postgresVoucherStatus().primary) {
    voucherVersion = Number((await readPostgresVoucherSnapshot(machine.boothCode))?.version || 0);
  } else if (machine.paired && redis) {
    voucherVersion = Number(await bestEffortRedis(() => redis.get(`photoslive:booth:${machine.boothCode}:voucher-version`), 0) || 0);
  }
  if (machine.paired && postgresSettingsStatus().primary) {
    settingsVersion = Number((await readPostgresSettings(machine.boothCode))?.version || 0);
  } else if (machine.paired && redis) {
    settingsVersion = Number(await bestEffortRedis(() => redis.get(`photoslive:booth:${machine.boothCode}:settings-version`), 0) || 0);
  }
  machine.protocolVersion = protocolVersion;
  if (postgresStatus.primary) {
    await persistPostgresHeartbeat(machine, tokenHash).catch(() => null);
    await updatePostgresHelperRuntime({
      machineId: machine.id,
      actualState: machine.agentState === "paused" ? "paused" : "online",
      capabilities: {
        installed: true,
        enabled: true,
        online: true,
        devices: machine.devices,
        controller: machine.controller,
      },
    }).catch(() => null);
  }
  if (redis) await bestEffortRedis(() => redis.set(machineKey(machine.id), machine));
  if (postgresStatus.mode === "dual") await persistPostgresHeartbeat(machine, tokenHash).catch(() => null);
  const accessEnabled = machine.accessEnabled !== false;
  const response = {
    ok: true, paired: machine.paired, boothCode: machine.boothCode,
    desiredState: machine.desiredState, commandKey: machine.commandKey,
    voucherVersion, settingsVersion, accessEnabled,
    offlinePolicy: { version: 1, validForSeconds: 72 * 60 * 60, accessEnabled, qrisAllowed: accessEnabled },
    minimumProtocolVersion: 1, protocolVersion: 2, minimumHeartbeatSeconds: Math.ceil(HEARTBEAT_MIN_INTERVAL_MS / 1000), serverTime: now(),
  };
  storeHeartbeatResponse(cacheKey, response);
  return json(response);
}

async function settingsSnapshot(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  if (postgresSettingsStatus().primary) {
    const snapshot = await readPostgresSettings(boothCode);
    if (snapshot) return json({ boothCode, version: snapshot.version, settings: snapshot.config, source: "postgres" });
    return json({ boothCode, version: 0, settings: null, source: "postgres", empty: true });
  }
  return json({
    boothCode,
    version: Number(await bestEffortRedis(() => redis.get(`photoslive:booth:${boothCode}:settings-version`), 0) || 0),
    settings: await bestEffortRedis(() => redis.get(`photoslive:booth:${boothCode}:settings`), null) || null,
    source: "redis",
  });
}

async function voucherSnapshot(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  if (postgresVoucherStatus().primary) {
    const snapshot = await readPostgresVoucherSnapshot(boothCode);
    if (snapshot) return json({ boothCode, version: snapshot.version, vouchers: snapshot.vouchers, events: snapshot.events, source: "postgres" });
    return json({ boothCode, version: 0, vouchers: [], events: [], source: "postgres", empty: true });
  }
  const codes = await bestEffortRedis(() => redis.smembers(`photoslive:booth:${boothCode}:vouchers`), []);
  const eventIds = await bestEffortRedis(() => redis.smembers(`photoslive:booth:${boothCode}:voucher-events`), []);
  const vouchers = (await Promise.all(codes.slice(0, 5000).map(code => bestEffortRedis(() => redis.get(`photoslive:booth:${boothCode}:voucher:${code}`), null)))).filter(Boolean);
  const events = (await Promise.all(eventIds.slice(0, 500).map(id => bestEffortRedis(() => redis.get(`photoslive:booth:${boothCode}:voucher-event:${id}`), null)))).filter(Boolean);
  return json({ boothCode, version: Number(await bestEffortRedis(() => redis.get(`photoslive:booth:${boothCode}:voucher-version`), 0) || 0), vouchers, events, source: "redis" });
}

async function syncVoucherRedemptions(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  let updated = 0;
  for (const item of (Array.isArray(payload.redemptions) ? payload.redemptions : []).slice(0, 500)) {
    const code = String(item.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
    if (!code) continue;
    if (postgresVoucherStatus().primary) {
      const result = await redeemPostgresVoucher({ boothCode, code, redeemedAt: item.redeemedAt || now() });
      if (result.ok) updated += 1;
      continue;
    }
    const record = code ? await redis.get(`photoslive:booth:${boothCode}:voucher:${code}`) : null;
    if (!record || record.redeemedAt) continue;
    record.redeemedAt = item.redeemedAt || now();
    record.redeemedOffline = true;
    await redis.set(`photoslive:booth:${boothCode}:voucher:${code}`, record);
    updated += 1;
  }
  if (updated) await bestEffortRedis(() => redis.incr(`photoslive:booth:${boothCode}:voucher-version`));
  return json({ updated });
}

async function enqueueJob(redis, request, payload) {
  const machineId = String(payload.machineId || "");
  if (!await authorizeOperator(redis, request, machineId, payload)) return json({ error: "Akses hardware photobox tidak valid" }, 401);
  const machine = await redis.get(machineKey(machineId));
  if (!machine?.paired) return json({ error: "Mesin belum dipasangkan" }, 409);
  if (machine.accessEnabled === false) return json({ error: "Akses photobox dinonaktifkan oleh superadmin" }, 403);
  const rateKey = `photoslive:machine:${machineId}:enqueue-rate:${Math.floor(Date.now() / 10_000)}`;
  const requestCount = Number(await redis.incr(rateKey));
  if (requestCount === 1) await redis.expire(rateKey, 15);
  if (requestCount > 40) return json({ error: "Terlalu banyak perintah. Tunggu beberapa detik." }, 429);
  const type = String(payload.type || "");
  if (!HARDWARE_JOB_TYPES.has(type)) return json({ error: "Jenis job tidak didukung" }, 400);
  try {
    const result = await enqueueRemoteJob(redis, machine, payload, HARDWARE_JOB_TYPES);
    return json({ job: result.job, reused: result.reused }, result.reused ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Perintah hardware gagal dibuat" }, 409);
  }
}

async function claimJob(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const id = await bestEffortRedis(() => redis.lpop(queueKey(machine.id)), null);
  if (!id) return json({ job: null, nextPollSeconds: IDLE_JOB_POLL_SECONDS });
  const job = await bestEffortRedis(() => redis.get(jobKey(id)), null);
  if (!job) return json({ job: null });
  if (job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) {
    job.status = "expired";
    job.error = "Command kedaluwarsa sebelum dijalankan";
    job.updatedAt = now();
    await bestEffortRedis(() => redis.set(jobKey(id), job, { ex: 86_400 }));
    return claimJob(redis, request, payload);
  }
  job.status = "claimed";
  job.claimedAt = now();
  job.updatedAt = now();
  job.attempts = Number(job.attempts || 0) + 1;
  await bestEffortRedis(() => redis.set(jobKey(id), job, { ex: 86_400 }));
  return json({ job });
}

async function updateJob(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const job = await redis.get(jobKey(String(payload.jobId || "")));
  if (!job || job.machineId !== machine.id) return json({ error: "Job tidak ditemukan" }, 404);
  const status = String(payload.status || "");
  if (!["running", "completed", "failed"].includes(status)) return json({ error: "Status job tidak valid" }, 400);
  job.status = status;
  job.updatedAt = now();
  job.result = payload.result && typeof payload.result === "object" ? payload.result : {};
  job.error = status === "failed" ? String(payload.error || "Job gagal").slice(0, 500) : null;
  await redis.set(jobKey(job.id), job, { ex: 86_400 });
  return json({ job });
}

async function jobStatus(redis, request, payload) {
  const machineId = String(payload.machineId || "");
  if (!await authorizeOperator(redis, request, machineId)) return json({ error: "Akses hardware photobox tidak valid" }, 401);
  const job = await redis.get(jobKey(String(payload.jobId || "")));
  if (!job || job.machineId !== machineId) return json({ error: "Job tidak ditemukan" }, 404);
  return json({ job });
}

async function dispatch(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" } });
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "health";
    const payload = { ...Object.fromEntries(url.searchParams), ...await body(request) };
    if (action === "health") return json({
      status: "ok",
      metadataStorage: postgresMachineStatus().primary ? "supabase-postgres" : "upstash",
      cacheStorage: "upstash",
      objectStorage: publicObjectStorageStatus(),
      time: now(),
    });
    // Browser setup, claim, and station bootstrap use PostgreSQL as their
    // source of truth. Redis is only an optional compatibility cache here and
    // must never block a clean machine from becoming a web/PWA photobox.
    if (action === "create_pairing" && request.method === "POST") return json(await createPairing(optionalRedis(), payload), 201);
    if (action === "create_web_pairing" && request.method === "POST") {
      const pairing = await createWebPairing(optionalRedis(), request, payload);
      const { _stationCredential, ...publicPairing } = pairing;
      return json(publicPairing, 201, {
        "set-cookie": stationCookie(request, pairing.machineId, _stationCredential),
      });
    }
    if (action === "pairing_status" && request.method === "GET") return inspectPairing(payload);
    if (action === "claim_pairing" && request.method === "POST") return claimPairing(optionalRedis(), request, payload);
    if (action === "station_bootstrap" && request.method === "POST") return stationBootstrap(request, payload);
    if (action === "update_station_capabilities" && request.method === "POST") return updateStationCapabilities(request, payload);
    if (action === "activate_helper" && request.method === "POST") return activateHelper(payload);
    if (action === "heartbeat" && request.method === "POST") return heartbeat(optionalRedis(), request, payload);
    if (action === "settings_snapshot" && request.method === "POST" && postgresSettingsStatus().primary) return settingsSnapshot(optionalRedis(), request, payload);
    if (action === "voucher_snapshot" && request.method === "POST" && postgresVoucherStatus().primary) return voucherSnapshot(optionalRedis(), request, payload);
    if (action === "machine_status" && request.method === "GET") {
      const machineId = String(payload.machineId || "");
      const redis = optionalRedis();
      if (!await authorizeOperator(redis, request, machineId)) return json({ error: "Login admin diperlukan" }, 401);
      const postgresStatus = postgresMachineStatus();
      if (postgresStatus.primary) {
        const durable = await readPostgresMachineStatus(machineId);
        if (durable) return json({ machine: publicMachine(durable), source: "postgres" });
      }
      const cached = redis ? await bestEffortRedis(() => redis.get(machineKey(machineId)), null) : null;
      if (cached) return json({ machine: publicMachine(cached), source: "redis" });
      if (postgresStatus.enabled && !postgresStatus.primary) {
        const durable = await readPostgresMachineStatus(machineId);
        if (durable) return json({ machine: publicMachine(durable), source: "postgres" });
      }
      return json({ machine: null, source: postgresStatus.enabled ? "postgres" : "redis" });
    }
    const redis = getRedis();
    if (action === "create_setup_code" && request.method === "POST") return createSetupCode(redis, request, payload);
    if (action === "settings_snapshot" && request.method === "POST") return settingsSnapshot(redis, request, payload);
    if (action === "voucher_snapshot" && request.method === "POST") return voucherSnapshot(redis, request, payload);
    if (action === "sync_voucher_redemptions" && request.method === "POST") return syncVoucherRedemptions(redis, request, payload);
    if (action === "sync_session_metadata" && request.method === "POST") return syncSessionMetadata(redis, request, payload);
    if (action === "reconcile_sessions" && request.method === "POST") return reconcileSessions(redis, request, payload);
    if (action === "prepare_session_file" && request.method === "POST") return prepareSessionFile(redis, request, payload);
    if (action === "prepare_session_file_part" && request.method === "POST") return prepareSessionFilePart(redis, request, payload);
    if (action === "complete_session_file_multipart" && request.method === "POST") return completeSessionFileMultipart(redis, request, payload);
    if (action === "finalize_session_file" && request.method === "POST") return finalizeSessionFile(redis, request, payload);
    if (action === "sync_session_file" && request.method === "POST") return syncSessionFile(redis, request, payload);
    if (action === "enqueue_job" && request.method === "POST") return enqueueJob(redis, request, payload);
    if (action === "claim_job" && request.method === "POST") return claimJob(redis, request, payload);
    if (action === "update_job" && request.method === "POST") return updateJob(redis, request, payload);
    if (action === "job_status" && request.method === "GET") return jobStatus(redis, request, payload);
    return json({ error: "Endpoint tidak ditemukan" }, 404);
  } catch (error) {
    throw error;
  }
}

async function handler(request) {
  const context = requestContext(request, "bridge");
  let action = "health";
  try {
    action = new URL(request.url).searchParams.get("action") || "health";
    return observedResponse(await dispatch(request), context, { action });
  } catch (error) {
    try {
      observedError(error, context, { action });
    } catch (logError) {
      console.error(JSON.stringify({
        level: "error",
        event: "http.error.log_failed",
        correlationId: context.id,
        surface: context.surface,
        action,
        error: logError instanceof Error ? logError.message : String(logError),
      }));
    }
    if (isUpstashMaxRequestsError(error)) return observedResponse(redisQuotaResponse(context.id), context, { action });
    return observedResponse(json({ error: error instanceof Error ? error.message : "Kesalahan server", correlationId: context.id }, 500), context, { action });
  }
}

const bridgeFunction = { fetch: handler };
export { commandSignature };
export default bridgeFunction;
