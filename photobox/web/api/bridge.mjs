import {
  authenticateWebSession,
  getRedis,
  boothKey,
  jobKey,
  machineKey,
  now,
  pairingCode,
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
import { persistPostgresSession, postgresSessionStatus } from "./_postgres_sessions.mjs";

const json = (response, status = 200) => new Response(JSON.stringify(response), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  },
});

async function body(request) {
  if (request.method === "GET") return {};
  return request.json().catch(() => ({}));
}

async function authenticateAgent(redis, request, machineId) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!machineId || !token) return null;
  const machine = await redis.get(machineKey(machineId));
  if (!machine || machine.agentTokenHash !== await sha256(token)) return null;
  return machine;
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
  await redis.set(syncedSessionFileKey(boothCode, shareCode, file.fileId), { ...publicFile, ...storage }, { ex: ttl });
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
  await redis.set(syncedSessionKey(boothCode, shareCode), record, { ex: ttl });
  await trackPublicSessionFileRetention(redis, record, { ...publicFile, ...storage });
  if (postgresSessionStatus().enabled) await persistPostgresSession(record);
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
  const previous = await redis.get(key);
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
  const postgres = postgresSessionStatus();
  if (postgres.primary) {
    const persisted = await persistPostgresSession(record);
    if (!persisted.ok) return json({ error: "Metadata sesi belum dapat disimpan ke cloud. Foto lokal tetap aman dan sinkronisasi akan dicoba lagi.", retryable: true }, 503);
  }
  await redis.set(key, record, { ex: ttl });
  await trackPublicSessionRetention(redis, record);
  if (postgres.mode === "dual") await persistPostgresSession(record);
  return json({ session: record, url: `/${boothCode}/sesi/${shareCode}` }, previous ? 200 : 201);
}

async function syncSessionFile(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  const shareCode = normalizedPublicSessionCode(payload.shareCode);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const file = normalizedSessionFile(payload);
  const record = await redis.get(syncedSessionKey(boothCode, shareCode));
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
  const record = await redis.get(syncedSessionKey(boothCode, shareCode));
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
  const record = await redis.get(syncedSessionKey(intent.boothCode, intent.shareCode));
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
  const record = await redis.get(syncedSessionKey(intent.boothCode, intent.shareCode));
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
  const machineId = randomId("machine");
  const agentToken = payload.agentToken || randomId("agent");
  const code = pairingCode();
  const createdAt = now();
  const machine = {
    id: machineId,
    name: String(payload.name || "Photoslive Booth").slice(0, 80),
    platform: String(payload.platform || "Unknown").slice(0, 120),
    agentVersion: String(payload.agentVersion || "dev").slice(0, 40),
    status: "waiting_pairing",
    paired: false,
    pairingCode: code,
    boothCode: code.toLowerCase(),
    agentTokenHash: await sha256(agentToken),
    createdAt,
    lastSeenAt: null,
    telemetry: {},
    devices: [],
    agentState: "starting",
    controllerState: "offline",
    desiredState: "running",
    update: { status: "idle" },
    commandKey: randomId("command"),
  };
  await redis.set(machineKey(machineId), machine);
  await redis.set(`photoslive:pairing:${code}`, machineId, { ex: 900 });
  return { machineId, agentToken, commandKey: machine.commandKey, pairingCode: code, expiresInSeconds: 900 };
}

export async function claimPairing(redis, request, payload) {
  const session = await authenticateWebSession(redis, request);
  if (!session || !["owner", "admin", "superadmin"].includes(session.role)) {
    return json({ error: "Login admin diperlukan untuk memasangkan mesin" }, 401);
  }
  const code = String(payload.code || "").trim().toUpperCase();
  const machineId = await redis.get(`photoslive:pairing:${code}`);
  if (!machineId) return json({ error: "Kode pairing tidak ditemukan atau sudah kedaluwarsa" }, 404);
  const machine = await redis.get(machineKey(machineId));
  if (!machine) return json({ error: "Data mesin tidak ditemukan" }, 404);
  if (machine.pairingCode !== code) return json({ error: "Kode pairing bukan kode terbaru untuk mesin ini" }, 409);
  machine.paired = true;
  machine.status = "offline";
  machine.name = String(payload.name || machine.name).slice(0, 80);
  machine.location = String(payload.location || "").slice(0, 120);
  machine.pairedAt = now();
  machine.boothCode = persistentBoothCode(machine, machine.boothCode || code);
  delete machine.pairingCode;
  await redis.set(machineKey(machineId), machine);
  await redis.set(boothKey(machine.boothCode), machineId);
  await redis.del(`photoslive:pairing:${code}`);
  return json({ machine: publicMachine(machine) });
}


export async function createSetupCode(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const code = pairingCode();
  const previousCode = String(machine.pairingCode || "").trim().toUpperCase();
  if (previousCode) await redis.del(`photoslive:pairing:${previousCode}`);
  machine.pairingCode = code;
  machine.boothCode = persistentBoothCode(machine);
  await redis.set(machineKey(machine.id), machine);
  await redis.set(`photoslive:pairing:${code}`, machine.id, { ex: 900 });
  await redis.set(boothKey(machine.boothCode), machine.id);
  // Keep the short code useful after onboarding as an alias to the canonical
  // photobox. The expiring pairing key still controls whether setup is valid.
  await redis.set(boothKey(code), machine.id);
  return json({ pairingCode: code, boothCode: machine.boothCode, expiresInSeconds: 900 });
}

async function heartbeat(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
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
  await redis.set(machineKey(machine.id), machine);
  await recordTelemetrySnapshot(redis, machine).catch(() => null);
  await resolveMachineIncident(redis, machine, machine.lastSeenAt);
  await redis.sadd("photoslive:machines", machine.id);
  if (machine.paired) await redis.set(boothKey(machine.boothCode), machine.id);
  const voucherVersion = machine.paired ? Number(await redis.get(`photoslive:booth:${machine.boothCode}:voucher-version`) || 0) : 0;
  const settingsVersion = machine.paired ? Number(await redis.get(`photoslive:booth:${machine.boothCode}:settings-version`) || 0) : 0;
  const protocolVersion = Math.max(1, Number(payload.protocolVersion || request.headers.get("x-photoslive-protocol-version") || 1));
  if (protocolVersion > 2) return json({ error: "Versi protokol Agent lebih baru daripada Cloud", minimumProtocolVersion: 1, protocolVersion: 2 }, 426);
  machine.protocolVersion = protocolVersion;
  await redis.set(machineKey(machine.id), machine);
  const accessEnabled = machine.accessEnabled !== false;
  return json({
    ok: true, paired: machine.paired, boothCode: machine.boothCode,
    desiredState: machine.desiredState, commandKey: machine.commandKey,
    voucherVersion, settingsVersion, accessEnabled,
    offlinePolicy: { version: 1, validForSeconds: 72 * 60 * 60, accessEnabled, qrisAllowed: accessEnabled },
    minimumProtocolVersion: 1, protocolVersion: 2, serverTime: now(),
  });
}

async function settingsSnapshot(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  return json({
    boothCode,
    version: Number(await redis.get(`photoslive:booth:${boothCode}:settings-version`) || 0),
    settings: await redis.get(`photoslive:booth:${boothCode}:settings`) || null,
  });
}

async function voucherSnapshot(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  const codes = await redis.smembers(`photoslive:booth:${boothCode}:vouchers`);
  const eventIds = await redis.smembers(`photoslive:booth:${boothCode}:voucher-events`);
  const vouchers = (await Promise.all(codes.slice(0, 5000).map(code => redis.get(`photoslive:booth:${boothCode}:voucher:${code}`)))).filter(Boolean);
  const events = (await Promise.all(eventIds.slice(0, 500).map(id => redis.get(`photoslive:booth:${boothCode}:voucher-event:${id}`)))).filter(Boolean);
  return json({ boothCode, version: Number(await redis.get(`photoslive:booth:${boothCode}:voucher-version`) || 0), vouchers, events });
}

async function syncVoucherRedemptions(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  let updated = 0;
  for (const item of (Array.isArray(payload.redemptions) ? payload.redemptions : []).slice(0, 500)) {
    const code = String(item.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
    const record = code ? await redis.get(`photoslive:booth:${boothCode}:voucher:${code}`) : null;
    if (!record || record.redeemedAt) continue;
    record.redeemedAt = item.redeemedAt || now();
    record.redeemedOffline = true;
    await redis.set(`photoslive:booth:${boothCode}:voucher:${code}`, record);
    updated += 1;
  }
  if (updated) await redis.incr(`photoslive:booth:${boothCode}:voucher-version`);
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
  const id = await redis.lpop(queueKey(machine.id));
  if (!id) return json({ job: null });
  const job = await redis.get(jobKey(id));
  if (!job) return json({ job: null });
  if (job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) {
    job.status = "expired";
    job.error = "Command kedaluwarsa sebelum dijalankan";
    job.updatedAt = now();
    await redis.set(jobKey(id), job, { ex: 86_400 });
    return claimJob(redis, request, payload);
  }
  job.status = "claimed";
  job.claimedAt = now();
  job.updatedAt = now();
  job.attempts = Number(job.attempts || 0) + 1;
  await redis.set(jobKey(id), job, { ex: 86_400 });
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
    if (action === "health") return json({ status: "ok", metadataStorage: "upstash", objectStorage: publicObjectStorageStatus(), time: now() });
    const redis = getRedis();
    if (action === "create_pairing" && request.method === "POST") return json(await createPairing(redis, payload), 201);
    if (action === "claim_pairing" && request.method === "POST") return claimPairing(redis, request, payload);
    if (action === "create_setup_code" && request.method === "POST") return createSetupCode(redis, request, payload);
    if (action === "heartbeat" && request.method === "POST") return heartbeat(redis, request, payload);
    if (action === "settings_snapshot" && request.method === "POST") return settingsSnapshot(redis, request, payload);
    if (action === "voucher_snapshot" && request.method === "POST") return voucherSnapshot(redis, request, payload);
    if (action === "sync_voucher_redemptions" && request.method === "POST") return syncVoucherRedemptions(redis, request, payload);
    if (action === "sync_session_metadata" && request.method === "POST") return syncSessionMetadata(redis, request, payload);
    if (action === "prepare_session_file" && request.method === "POST") return prepareSessionFile(redis, request, payload);
    if (action === "prepare_session_file_part" && request.method === "POST") return prepareSessionFilePart(redis, request, payload);
    if (action === "complete_session_file_multipart" && request.method === "POST") return completeSessionFileMultipart(redis, request, payload);
    if (action === "finalize_session_file" && request.method === "POST") return finalizeSessionFile(redis, request, payload);
    if (action === "sync_session_file" && request.method === "POST") return syncSessionFile(redis, request, payload);
    if (action === "machine_status" && request.method === "GET") {
      const machineId = String(payload.machineId || "");
      if (!await authorizeOperator(redis, request, machineId)) return json({ error: "Login admin diperlukan" }, 401);
      return json({ machine: publicMachine(await redis.get(machineKey(machineId))) });
    }
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
    observedError(error, context, { action });
    return observedResponse(json({ error: error instanceof Error ? error.message : "Kesalahan server", correlationId: context.id }, 500), context, { action });
  }
}

const bridgeFunction = { fetch: handler };
export { commandSignature };
export default bridgeFunction;
