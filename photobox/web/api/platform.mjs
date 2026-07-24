import { boothKey, getRedis, isUpstashMaxRequestsError, jobKey, machineKey, now, randomId, sessionKey, sha256, signScopedToken, userKey, verifyScopedToken } from "./_store.mjs";
import { requestContext, observedError, observedResponse } from "./_observability.mjs";
import { appendPostgresLedgerEntry, readPostgresChargebackByPaymentId, readPostgresLedgerEntries, readPostgresPaymentById, readPostgresPaymentByProviderId, writePostgresChargeback, writePostgresPaymentIntent, writePostgresPayout, writePostgresPayoutAccount, writePostgresPayoutPolicy, writePostgresReconciliationJob, writePostgresRefund, writePostgresShadowEvent } from "./_postgres.mjs";
import { deploymentCapabilities } from "./_providers.mjs";
import { deleteObject, getObject, inspectObject, presignObjectRequest, probeObjectStorage, putObject } from "./_object_storage.mjs";
import { deleteFeatureFlagOverride, FEATURE_FLAG_DEFINITIONS, listFeatureFlagOverrides, resolveFeatureFlags, setFeatureFlagOverride } from "./_feature_flags.mjs";
import { acknowledgeFleetIncident, evaluateFleetHealth, machineHealth } from "./_fleet_health.mjs";
import { listAlertDeliveries, probeMonitoringWebhook, processAlertDeliveries, retryAlertDelivery } from "./_alert_routing.mjs";
import { listTelemetryHistory } from "./_telemetry_history.mjs";
import { backendHealth } from "./_backend_health.mjs";
import { enqueueRemoteJob, listRemoteJobs, retryRemoteJob, SUPERADMIN_REMOTE_JOB_TYPES } from "./_remote_jobs.mjs";
import { hasPlatformPermission, normalizePlatformRole, PLATFORM_ROLES, safePlatformIdentity } from "./_platform_roles.mjs";
import { publicPlatformStatus } from "./_public_status.mjs";
import { consumeRateLimit, PLATFORM_RATE_LIMITS } from "./_rate_limit.mjs";
import { validateMutationOrigin } from "./_csrf.mjs";
import { deletePublicSessionArtifacts, trackPublicSessionFileRetention, trackPublicSessionRetention } from "./_session_retention.mjs";
import { listProviderConnections, providerConnectionDefinitions, providerVaultConfig, recordProviderConnectionCheck, resolveProviderRuntime, resolveProviderRuntimeForCapability, resolveProviderRuntimeReference, rewrapProviderConnection, saveProviderConnection, setProviderConnectionState } from "./_provider_connections.mjs";
import { createLedgerAdjustment, createLedgerReconciliationRun, createQrisPayment, createXenditRefund, getPayment, getPaymentLedgerEntry, getPaymentReconciliation, listLedgerReconciliationRuns, listPaymentLedger, listPaymentReconciliation, listPayments, probeXendit, processXenditWebhook, recordManualChargeback, recordProviderFee, refreshQrisPayment, reviewLatePayment, safePayment, summarizeLedgerBalance } from "./_payments.mjs";
import { deleteFinancePolicy, listFinancePolicies, resolvePlatformFeePolicy, setFinancePolicy } from "./_finance_policy.mjs";
import { enqueueEmail, handleResendWebhook, listEmailDeliveries, probeEmailProvider, processEmailDeliveries, processEmailDelivery, retryEmailDelivery } from "./_email.mjs";
import { approveManualPayout, attachPayoutProof, cancelManualPayout, createManualPayout, getPayout, getPayoutAccount, getPayoutAccountPersistence, getPayoutPolicy, listPayoutAccounts, listPayouts, markManualPayoutPaid, savePayoutAccount, setPayoutEmailDelivery, setPayoutPolicy, summarizePayoutEmailDelivery, verifyPayoutAccount } from "./_payouts.mjs";
import { appendWebhookEvent, listWebhookEvents } from "./_webhook_events.mjs";
import { listProviderEconomics, recordProviderUsageSnapshot, saveProviderEntitlement } from "./_provider_economics.mjs";
import { createProviderMigration, listProviderMigrations, setProviderMigrationState } from "./_provider_migrations.mjs";
import { finalizeProviderMigrationCutover, processProviderMigrationBatch } from "./_provider_migration_worker.mjs";
import { listFinanceRisks, recordFinanceRisk, reviewFinanceRisk, summarizeFinanceRisks } from "./_finance_risk.mjs";
import { deletePostgresVoucher, persistPostgresVoucherBatch, persistPostgresVoucherEvent, postgresVoucherStatus, readPostgresVoucherSnapshot, redeemPostgresVoucher } from "./_postgres_vouchers.mjs";
import { persistPostgresSettings, postgresSettingsStatus, readPostgresSettings } from "./_postgres_settings.mjs";
import { persistPostgresBoothDirectory, postgresDirectoryStatus, readPostgresBoothDirectory, updatePostgresBoothAccess } from "./_postgres_directory.mjs";
import { expirePostgresSession, persistPostgresSession, postgresSessionStatus, readPostgresSession, requestPostgresSessionDeletion } from "./_postgres_sessions.mjs";
import { deletePostgresAsset, persistPostgresAsset, postgresAssetStatus, readPostgresAssets, requestPostgresAssetDeletion } from "./_postgres_assets.mjs";
import { markPostgresMachinePaired, postgresMachineStatus, readPostgresPairing } from "./_postgres_machines.mjs";
import { listPostgresAdminUsers, persistPostgresAdminUser, postgresUsersStatus, readPostgresAdminUserByEmail, readPostgresAdminUserById } from "./_postgres_users.mjs";

const encoder = new TextEncoder();
const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

async function requestBody(request) {
  return request.method === "GET" ? {} : request.json().catch(() => ({}));
}

const providerContextForBooth = booth => ({
  boothCode: booth?.boothCode || "",
  organizationId: booth?.organizationId || booth?.organization?.id || "",
});

async function storageRuntime(redis, booth, providerId = "") {
  const context = providerContextForBooth(booth);
  return providerId
    ? resolveProviderRuntime(redis, providerId, context)
    : resolveProviderRuntimeForCapability(redis, "cloudStorage", context);
}

async function deploymentCapabilitiesForBooth(redis, booth) {
  const context = providerContextForBooth(booth);
  const [storage, qris] = await Promise.all([
    resolveProviderRuntimeForCapability(redis, "cloudStorage", context),
    resolveProviderRuntimeForCapability(redis, "qris", context),
  ]);
  return deploymentCapabilities({ ...process.env, ...(storage?.environment || {}), ...(qris?.environment || {}) });
}

function cookieMap(request) {
  return Object.fromEntries((request.headers.get("cookie") || "").split(";").map(value => value.trim()).filter(Boolean).map(value => {
    const index = value.indexOf("="); return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
  }));
}

const bytesToHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const sha256Bytes = async bytes => bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
const hexToBytes = value => {
  if (!/^[a-f0-9]{64}$/i.test(String(value || ""))) return null;
  return new Uint8Array(String(value).match(/.{2}/g).map(byte => Number.parseInt(byte, 16)));
};

async function hashCredential(value, salt = crypto.randomUUID().replaceAll("-", "")) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(String(value)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 120_000, hash: "SHA-256" }, material, 256);
  return `${salt}:${bytesToHex(bits)}`;
}

async function verifyCredential(value, stored = "") {
  const [salt] = String(stored).split(":");
  return Boolean(salt && await hashCredential(value, salt) === stored);
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET production belum dikonfigurasi");
  return secret;
}

async function signature(value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(sessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function encodeSessionPayload(payload) {
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeSessionPayload(encoded) {
  try {
    const normalized = String(encoded || "").replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export async function verifyLocalLoginAssertion(redis, assertion, booth, atMs = Date.now()) {
  const [encoded, supplied] = String(assertion || "").split(".");
  const signatureBytes = hexToBytes(supplied);
  if (!encoded || !signatureBytes || !booth?.machineId || !booth?.boothCode) return { valid: false, error: "Proof login lokal tidak valid" };
  let payload;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    payload = JSON.parse(atob(padded));
  } catch {
    return { valid: false, error: "Proof login lokal rusak" };
  }
  const issuedAt = Number(payload?.iat || 0);
  const expiresAt = Number(payload?.exp || 0);
  const nonce = String(payload?.nonce || "");
  if (payload?.v !== 1 || payload?.purpose !== "admin-pin"
    || payload?.machineId !== booth.machineId
    || normalizeCode(payload?.boothCode) !== normalizeCode(booth.boothCode)
    || !/^[a-f0-9]{32}$/.test(nonce)
    || !issuedAt || !expiresAt || expiresAt <= atMs || issuedAt > atMs + 30_000
    || issuedAt < atMs - 90_000 || expiresAt - issuedAt > 60_000) {
    return { valid: false, error: "Proof login lokal sudah kedaluwarsa atau tidak cocok dengan photobox" };
  }
  const machine = await redis.get(machineKey(booth.machineId));
  if (!machine?.commandKey) return { valid: false, error: "Agent belum siap untuk login PIN lokal" };
  const key = await crypto.subtle.importKey("raw", encoder.encode(machine.commandKey), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const validSignature = await crypto.subtle.verify("HMAC", key, signatureBytes, encoder.encode(`local-login:${encoded}`));
  if (!validSignature) return { valid: false, error: "Tanda tangan proof login lokal tidak valid" };
  const nonceKey = `photoslive:local-login-nonce:${booth.machineId}:${nonce}`;
  const accepted = await redis.set(nonceKey, "used", { nx: true, ex: 120 });
  if (!accepted) return { valid: false, error: "Proof login lokal sudah digunakan. Coba masuk kembali." };
  return { valid: true, payload };
}

const userSessionIndexKey = userId => `photoslive:user:${userId}:sessions`;
const platformStaffIndexKey = "photoslive:platform-staff";
const platformStaffKey = id => `photoslive:platform-staff:${id}`;
const platformStaffEmailKey = email => `photoslive:platform-staff-email:${normalizeEmail(email)}`;

const safePlatformStaff = record => record ? {
  id: String(record.id || ""),
  name: String(record.name || "").slice(0, 80),
  email: normalizeEmail(record.email),
  platformRole: normalizePlatformRole(record.platformRole),
  status: ["invited", "active", "suspended", "revoked"].includes(record.status) ? record.status : "suspended",
  active: record.status === "active",
  mustActivate: record.status === "invited",
  invitedAt: record.invitedAt || null,
  inviteExpiresAt: record.inviteExpiresAt || null,
  activatedAt: record.activatedAt || null,
  lastLoginAt: record.lastLoginAt || null,
  updatedAt: record.updatedAt || null,
} : null;

async function platformStaffForAuth(redis, auth) {
  if (!auth?.userId || auth.userId === "superadmin") return null;
  return redis.get(platformStaffKey(auth.userId));
}

async function platformIdentityEmail(redis, auth) {
  if (auth?.userId === "superadmin") return normalizeEmail(process.env.SUPERADMIN_EMAIL);
  return normalizeEmail((await platformStaffForAuth(redis, auth))?.email);
}

async function verifyPlatformReauthentication(redis, auth, password) {
  if (!auth || !password) return false;
  if (auth.userId === "superadmin") return verifyCredential(password, process.env.SUPERADMIN_PASSWORD_HASH || "");
  const staff = await platformStaffForAuth(redis, auth);
  return Boolean(staff?.status === "active" && await verifyCredential(password, staff.passwordHash));
}

async function createSession(redis, data) {
  const id = randomId("login");
  const record = { id, ...data, createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
  try {
    await redis.set(sessionKey(id), record, { ex: 7 * 86_400 });
    if (record.userId) await redis.sadd(userSessionIndexKey(record.userId), id);
    return `${id}.${await signature(id)}`;
  } catch (error) {
    if (!isUpstashMaxRequestsError(error) && !postgresUsersStatus().primary) throw error;
    const encoded = encodeSessionPayload(record);
    return `st.${encoded}.${await signature(`stateless:${encoded}`)}`;
  }
}

async function authenticate(redis, request) {
  const token = cookieMap(request)["__Host-photoslive_session"] || "";
  if (token.startsWith("st.")) {
    const [, encoded, supplied] = token.split(".");
    if (!encoded || !supplied || supplied !== await signature(`stateless:${encoded}`)) return null;
    const session = decodeSessionPayload(encoded);
    if (!session?.id || (session.expiresAt && Date.parse(session.expiresAt) <= Date.now())) return null;
    return session;
  }
  const [id, supplied] = token.split(".");
  if (!id || !supplied || supplied !== await signature(id)) return null;
  let session = null;
  try {
    session = await redis.get(sessionKey(id));
  } catch (error) {
    if (!isUpstashMaxRequestsError(error)) throw error;
  }
  if (!session) return null;
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) {
    await redisBestEffort(() => redis.del(sessionKey(id)));
    if (session.userId) await redisBestEffort(() => redis.srem(userSessionIndexKey(session.userId), id));
    return null;
  }
  if (session.role === "superadmin" && session.userId !== "superadmin") {
    const staff = await redis.get(platformStaffKey(session.userId));
    // Legacy signed sessions created before the staff registry do not have a
    // record yet. Registered staff, however, are denied immediately once
    // suspended or revoked.
    if (staff && staff.status !== "active") {
      await redisBestEffort(() => redis.del(sessionKey(id)));
      await redisBestEffort(() => redis.srem(userSessionIndexKey(session.userId), id));
      return null;
    }
  }
  return session;
}

export async function logout(redis, request) {
  const auth = await authenticate(redis, request);
  if (auth?.id) {
    await redisBestEffort(() => redis.del(sessionKey(auth.id)));
    if (auth.userId) await redisBestEffort(() => redis.srem(userSessionIndexKey(auth.userId), auth.id));
  }
  return json({ ok: true }, 200, { "set-cookie": clearCookie });
}

async function activeUserSessionIds(redis, userId) {
  const ids = (await redisBestEffort(() => redis.smembers(userSessionIndexKey(userId)), [])).slice(0, 100);
  const active = [];
  for (const id of ids) {
    const session = await redisBestEffort(() => redis.get(sessionKey(id)));
    if (session && (!session.expiresAt || Date.parse(session.expiresAt) > Date.now())) active.push(id);
    else await redisBestEffort(() => redis.srem(userSessionIndexKey(userId), id));
  }
  return active;
}

export const sessionCookie = token => `__Host-photoslive_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
export const clearCookie = "__Host-photoslive_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
const normalizeCode = code => String(code || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
const normalizeEmail = email => String(email || "").trim().toLowerCase().slice(0, 160);
const cloudSettingsKey = boothCode => `photoslive:booth:${boothCode}:settings`;
const voucherIndexKey = boothCode => `photoslive:booth:${boothCode}:vouchers`;
const voucherKey = (boothCode, code) => `photoslive:booth:${boothCode}:voucher:${code}`;
const voucherEventIndexKey = boothCode => `photoslive:booth:${boothCode}:voucher-events`;
const voucherEventKey = (boothCode, id) => `photoslive:booth:${boothCode}:voucher-event:${id}`;
const assetIndexKey = (boothCode, kind) => `photoslive:booth:${boothCode}:assets:${kind}`;
const assetKey = (boothCode, id) => `photoslive:booth:${boothCode}:asset:${id}`;
const assetUploadIntentKey = (boothCode, uploadId) => `photoslive:booth:${boothCode}:asset-upload:${uploadId}`;
const platformFrameIndexKey = "photoslive:platform:frame-library";
const platformFrameKey = id => `photoslive:platform:frame-library:${id}`;
const platformFrameUploadIntentKey = uploadId => `photoslive:platform:frame-upload:${uploadId}`;
const voucherVersionKey = boothCode => `photoslive:booth:${boothCode}:voucher-version`;
const settingsVersionKey = boothCode => `photoslive:booth:${boothCode}:settings-version`;
const publicSessionKey = (boothCode, shareCode) => `photoslive:public-session:${boothCode}:${shareCode}`;
const publicSessionFileKey = (boothCode, shareCode, fileId) => `photoslive:public-session-file:${boothCode}:${shareCode}:${fileId}`;
const PUBLIC_SESSION_TTL_SECONDS = 86_400;
const PUBLIC_SESSION_CODE_PATTERN = /^[A-Za-z0-9_-]{32,100}$/;
const auditKey = boothCode => `photoslive:booth:${boothCode}:audit`;
const ASSET_KINDS = ["background", "frame", "logo", "sticker"];

export function normalizePublicSessionCode(value) {
  const code = String(value || "").trim();
  return PUBLIC_SESSION_CODE_PATTERN.test(code) ? code : "";
}

function publicSessionRemainingTtl(record) {
  const remaining = Math.ceil((Date.parse(record?.expiresAt || "") - Date.now()) / 1000);
  return Number.isFinite(remaining) ? Math.max(0, Math.min(PUBLIC_SESSION_TTL_SECONDS, remaining)) : 0;
}

function publicSessionProjection(record) {
  if (!record) return null;
  const {
    machineId: _machineId,
    localSessionId: _localSessionId,
    fileManifests: _fileManifests,
    deletionRequested: _deletionRequested,
    deletionRequestedAt: _deletionRequestedAt,
    deleted: _deleted,
    ...safe
  } = record;
  return safe;
}

function publicBoothProjection(booth) {
  if (!booth) return null;
  return { boothCode: booth.boothCode, name: booth.name, location: booth.location, enabled: booth.enabled };
}

async function recoverPublicSession(redis, boothCode, shareCode) {
  let record = await redis.get(publicSessionKey(boothCode, shareCode));
  if (!record && postgresSessionStatus().primary) {
    const snapshot = await readPostgresSession(boothCode, shareCode);
    if (snapshot && !snapshot.deleted && !["expired", "cancelled"].includes(snapshot.status) && publicSessionRemainingTtl(snapshot) > 0) {
      record = snapshot;
      const ttl = publicSessionRemainingTtl(record);
      await redis.set(publicSessionKey(boothCode, shareCode), record, { ex: ttl });
      await trackPublicSessionRetention(redis, record);
      const filesById = new Map((record.files || []).map(file => [String(file.id || ""), file]));
      for (const manifest of record.fileManifests || []) {
        const publicFile = filesById.get(String(manifest.id || ""));
        if (!publicFile) continue;
        const fileRecord = { ...publicFile, ...manifest };
        await redis.set(publicSessionFileKey(boothCode, shareCode, manifest.id), fileRecord, { ex: ttl });
        await trackPublicSessionFileRetention(redis, record, fileRecord);
      }
    }
  }
  return record;
}

export { deploymentCapabilities } from "./_providers.mjs";

async function scopedBoothAccess(request, payload, scope) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const access = await verifyScopedToken(token);
  if (!access || access.scope !== scope) return null;
  if (payload.machineId && access.machineId !== payload.machineId) return null;
  if (payload.boothCode && access.boothCode !== normalizeCode(payload.boothCode)) return null;
  return access;
}

const DEFAULT_CLOUD_SETTINGS = {
  booth: { name: "Photoslive Booth", location: "", dailySessionLimit: 120, sessionTimeoutSeconds: 150, countdownSeconds: 15, retakeLimit: 1, unlimitedRetakes: true, photoSlotsPerSession: 3, printsPerSession: 1, localRetentionHours: 24, cloudRetentionDays: 7, maintenanceMode: false },
  payment: { qrisEnabled: false, voucherEnabled: false, price: 35000, currency: "IDR", provider: "Not configured", paidPrintEnabled: false, printPrice: 10000 },
  appearance: {
    activeBackground: "default-gradient", activeFrame: "party-night", activeLogo: "text-logo", welcomeTitle: "Abadikan momenmu", touchPrompt: "Sentuh layar untuk memulai", startButtonLabel: "Mulai foto", fontFamily: "system", screenPreset: "1080x1920", screenSizeInches: 15.6, logoSizePercent: 28, headingFontSize: 48, helperFontSize: 18, buttonFontSize: 16, accentColor: "#6d5dfc", headingTextColor: "#ffffff", helperTextColor: "#ffffff", buttonBackgroundColor: "#ffffff", buttonTextColor: "#7c3049", frameFormat: "photo-strip-vertical",
    framePhotoSlots: { "clean-white": 3, "party-night": 3 }, framePhotoWidths: { "clean-white": 86, "party-night": 86 }, frameBackgroundTransforms: {}, frameSlotTransforms: {}, frameStickers: {}, frameLayoutModes: { "clean-white": "auto", "party-night": "auto" }, frameSizePresets: { "clean-white": "custom", "party-night": "custom" }, frameCanvasSizes: { "clean-white": { width: 800, height: 1600 }, "party-night": { width: 800, height: 1600 } }, frameOriginalCanvasSizes: { "clean-white": { width: 1200, height: 1600 }, "party-night": { width: 1200, height: 1600 } }, frameAspectRatio: "3:4", frameCanvasWidth: 1200, frameCanvasHeight: 1600, frameBottomMarginPercent: 20,
  },
  storage: { cloudEnabled: false, provider: "Cloudflare R2", uploadFinalOnly: true, deleteOnlyAfterUpload: true },
  devices: { preferredCamera: "auto", preferredPrinter: "auto", paperSize: "4x6", printLayout: "photo-strip-vertical", stripsPerSheet: 2, borderless: true, cameraSource: "auto", browserCameraId: "", cameraMirror: false, cameraRotation: "0" },
};

const clone = value => structuredClone(value);
const isObject = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
function mergeObjects(base, incoming) {
  const result = clone(base);
  if (!isObject(incoming)) return result;
  for (const [key, value] of Object.entries(incoming)) result[key] = isObject(value) && isObject(result[key]) ? mergeObjects(result[key], value) : clone(value);
  return result;
}

async function cloudSettings(redis, booth) {
  let stored = null;
  if (postgresSettingsStatus().primary) {
    const snapshot = await readPostgresSettings(booth.boothCode);
    if (snapshot) {
      stored = snapshot.config;
      try {
        const cache = typeof redis.multi === "function" ? redis.multi() : redis.pipeline();
        cache.set(settingsVersionKey(booth.boothCode), snapshot.version);
        await cache.exec();
      } catch {
        // Compatibility cache only. PostgreSQL remains authoritative.
      }
    }
  }
  if (!stored) stored = await redis.get(cloudSettingsKey(booth.boothCode));
  const settings = mergeObjects(DEFAULT_CLOUD_SETTINGS, stored);
  settings.booth.name = stored?.booth?.name || booth.name || settings.booth.name;
  settings.booth.location = stored?.booth?.location ?? booth.location ?? settings.booth.location;
  return settings;
}

export async function persistSettingsSnapshot(redis, boothCode, settings, options = {}) {
  const postgresStatus = postgresSettingsStatus(options.environment || process.env);
  let postgresResult = null;
  if (postgresStatus.primary) {
    postgresResult = await persistPostgresSettings({ boothCode, config: settings }, options);
    if (!postgresResult.ok) throw Object.assign(new Error(postgresResult.reason || "Penyimpanan settings PostgreSQL gagal"), { status: Number(postgresResult.status || 503) });
  }
  const transaction = typeof redis.multi === "function" ? redis.multi() : redis.pipeline();
  if (!postgresStatus.primary) transaction.set(cloudSettingsKey(boothCode), settings);
  if (postgresStatus.primary) transaction.set(settingsVersionKey(boothCode), postgresResult.version);
  else transaction.incr(settingsVersionKey(boothCode));
  let results = [];
  try {
    results = await transaction.exec();
  } catch (error) {
    if (!postgresStatus.primary) throw error;
  }
  const version = postgresStatus.primary ? postgresResult.version : Number(results.at(-1)?.result ?? results.at(-1) ?? 0);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Versi settings tidak dapat diperbarui");
  if (postgresStatus.mode === "dual") await persistPostgresSettings({ boothCode, config: settings }, options);
  return version;
}

async function requireBoothAdmin(redis, request, requestedCode) {
  const auth = await authenticate(redis, request);
  const booth = await resolveBooth(redis, requestedCode || auth?.boothCode);
  if (!auth?.boothCode || !booth || auth.boothCode !== booth.boothCode) return null;
  return { auth, booth };
}

async function appendAudit(redis, auth, boothCode, action, target = "", detail = {}, correlationId = "") {
  const record = {
    id: randomId("audit"),
    correlationId: correlationId || randomId("corr"),
    boothCode,
    actorId: auth?.userId || auth?.role || "system",
    actorRole: auth?.role || "system",
    action,
    target: String(target || "").slice(0, 160),
    detail,
    createdAt: now(),
  };
  await writePostgresShadowEvent({
    entityType: "audit",
    legacyKey: `${boothCode}:${record.id}`,
    operation: "upsert",
    idempotencyKey: `audit:${record.id}`,
    correlationId: record.correlationId,
    payload: record,
  });
  try {
    const serialized = JSON.stringify(record);
    const pipeline = redis.pipeline();
    pipeline.lpush(auditKey(boothCode), serialized);
    pipeline.ltrim(auditKey(boothCode), 0, 499);
    pipeline.lpush("photoslive:audit:global", serialized);
    pipeline.ltrim("photoslive:audit:global", 0, 999);
    await pipeline.exec();
  } catch {
    // Redis is the short ring-buffer for browsing audit logs. Durable audit
    // persistence above keeps admin mutations from failing when free Redis
    // quota is exhausted.
  }
  return record;
}

async function auditLog(redis, request, payload) {
  const auth = await authenticate(redis, request);
  const boothCode = normalizeCode(payload.booth || auth?.boothCode);
  if (!auth || (auth.role === "superadmin" ? !hasPlatformPermission(auth, "platform.audit.read") : (!boothCode || auth.boothCode !== boothCode))) return json({ error: "Akses audit log ditolak" }, 403);
  const raw = await redis.lrange(auth.role === "superadmin" && !boothCode ? "photoslive:audit:global" : auditKey(boothCode), 0, 99);
  const records = raw.map(item => {
    if (typeof item !== "string") return item;
    try { return JSON.parse(item); } catch { return null; }
  }).filter(Boolean);
  return json({ records });
}

export async function backendHealthControl(redis, request) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.backend.read")) return json({ error: "Akses health backend ditolak" }, 403);
  return json(await backendHealth(redis));
}

export async function webhookEventsControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.finance.read")) return json({ error: "Akses log webhook ditolak" }, 403);
  if (request.method !== "GET") return json({ error: "Metode log webhook tidak didukung" }, 405);
  return json(await listWebhookEvents(redis, payload.limit));
}

export async function providerConnectionsControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.integrations.read" : "platform.integrations.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses integrasi provider ditolak" }, 403);
  if (request.method === "GET") {
    const vault = providerVaultConfig();
    return json({
      definitions: providerConnectionDefinitions(),
      connections: await listProviderConnections(redis),
      vault: { available: vault.available, activeKeyVersion: vault.available ? vault.activeKeyVersion : null },
    });
  }
  if (request.method !== "POST") return json({ error: "Metode integrasi provider tidak didukung" }, 405);
  const operation = String(payload.operation || "save").toLowerCase();
  const scope = String(payload.scope || "").toLowerCase();
  const targetId = scope === "global" ? "" : String(payload.targetId || "").toLowerCase();
  if (!await featureFlagTargetExists(redis, scope, targetId)) return json({ error: "Target koneksi provider tidak ditemukan" }, 404);
  try {
    if (operation === "save") {
      const result = await saveProviderConnection(redis, { ...payload, scope, targetId }, auth.userId);
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", `provider_connection.${result.operation}`, result.record.id, {
        providerId: result.record.providerId, scope, targetId, source: result.record.source,
        credentialVersion: result.record.credentialVersion, keyVersion: result.record.keyVersion,
      });
      return json(result, result.operation === "created" ? 201 : 200);
    }
    if (["active", "paused", "revoked"].includes(operation)) {
      const record = await setProviderConnectionState(redis, { ...payload, scope, targetId, status: operation }, auth.userId);
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", `provider_connection.${operation}`, record.id, {
        providerId: record.providerId, scope, targetId,
      });
      return json({ record });
    }
    if (operation === "rewrap") {
      const record = await rewrapProviderConnection(redis, { ...payload, scope, targetId }, auth.userId);
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", "provider_connection.key_rewrapped", record.id, {
        providerId: record.providerId, scope, targetId, keyVersion: record.keyVersion,
      });
      return json({ record });
    }
    if (operation === "test") {
      const providerId = String(payload.providerId || "").toLowerCase();
      const connection = (await listProviderConnections(redis)).find(item => item.providerId === providerId && item.scope === scope && (item.targetId || "") === targetId);
      if (!connection || connection.status !== "active") return json({ error: "Koneksi provider aktif tidak ditemukan" }, 409);
      const context = {
        boothCode: scope === "booth" ? targetId : "",
        organizationId: scope === "organization" ? targetId : "",
      };
      const runtime = await resolveProviderRuntime(redis, providerId, context);
      if (!runtime) return json({ error: "Credential provider aktif tidak ditemukan" }, 409);
      const check = connection.capability === "monitoringAlert"
        ? await probeMonitoringWebhook({ environment: runtime.environment, timeoutMs: 3_000 })
        : connection.capability === "email"
          ? await probeEmailProvider({ providerId: runtime.providerId, environment: runtime.environment, timeoutMs: 3_000 })
        : connection.capability === "qris"
          ? await probeXendit({ environment: runtime.environment, timeoutMs: 3_000 })
          : { ...(await probeObjectStorage({ environment: runtime.environment, timeoutMs: 3_000 })), checkedAt: now() };
      const record = await recordProviderConnectionCheck(redis, { providerId, scope, targetId }, check);
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", "provider_connection.tested", `${scope}:${targetId || "_"}:${providerId}`, {
        providerId, scope, targetId, state: check.state, latencyMs: check.latencyMs,
      });
      return json({ check, record });
    }
    return json({ error: "Operasi koneksi provider tidak dikenal" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Koneksi provider gagal diperbarui" }, 400);
  }
}

export async function providerEconomicsControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.integrations.read" : "platform.integrations.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses kuota provider ditolak" }, 403);
  if (request.method === "GET") return json(await listProviderEconomics(redis));
  if (request.method !== "POST") return json({ error: "Metode kuota provider tidak didukung" }, 405);
  const operation = String(payload.operation || "save_entitlement").toLowerCase();
  const scope = String(payload.scope || "").toLowerCase();
  const targetId = scope === "global" ? "" : String(payload.targetId || "").toLowerCase();
  if (!await featureFlagTargetExists(redis, scope, targetId)) return json({ error: "Target kuota provider tidak ditemukan" }, 404);
  try {
    if (operation === "save_entitlement") {
      const entitlement = await saveProviderEntitlement(redis, { ...payload, scope, targetId }, auth.userId);
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", "provider_entitlement.updated", entitlement.id, {
        providerId: entitlement.providerId, scope, targetId, plan: entitlement.plan, metric: entitlement.metric,
        allowance: entitlement.allowance, addon: entitlement.addon, monthlyPriceIdr: entitlement.monthlyPriceIdr, hardLimit: entitlement.hardLimit,
      });
      return json({ entitlement });
    }
    if (operation === "record_usage") {
      const snapshot = await recordProviderUsageSnapshot(redis, { ...payload, scope, targetId, source: "superadmin_manual" });
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", "provider_usage.recorded", snapshot.id, {
        providerId: snapshot.providerId, scope, targetId, metric: snapshot.metric, used: snapshot.used,
      });
      return json({ snapshot }, 201);
    }
    return json({ error: "Operasi kuota provider tidak dikenal" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Kuota provider gagal diperbarui" }, 400);
  }
}

export async function providerMigrationsControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.integrations.read" : "platform.integrations.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses migrasi provider ditolak" }, 403);
  if (request.method === "GET") return json({ migrations: await listProviderMigrations(redis), checkedAt: now() });
  if (request.method !== "POST") return json({ error: "Metode migrasi provider tidak didukung" }, 405);
  const operation = String(payload.operation || "").toLowerCase();
  try {
    if (operation === "create") {
      const booth = await resolveBooth(redis, payload.boothCode);
      if (!booth) return json({ error: "Photobox tujuan tidak ditemukan" }, 404);
      const assets = await cloudAssets(redis, booth.boothCode);
      const items = Object.values(assets).flat()
        .filter(asset => asset.objectKey && asset.storageProvider === String(payload.sourceProvider || "").toLowerCase())
        .map(asset => ({ id: asset.id, objectKey: asset.objectKey, checksumSha256: asset.checksumSha256, contentType: asset.contentType, size: asset.size }));
      const migration = await createProviderMigration(redis, { ...payload, boothCode: booth.boothCode, items }, auth.userId);
      await appendAudit(redis, auth, booth.boothCode, "provider_migration.created", migration.id, { sourceProvider: migration.sourceProvider, destinationProvider: migration.destinationProvider, total: migration.total });
      return json({ migration }, 201);
    }
    if (["pause", "resume"].includes(operation)) {
      const migration = await setProviderMigrationState(redis, payload.id, operation === "pause" ? "paused" : "queued", auth.userId);
      if (!migration) return json({ error: "Migrasi provider tidak ditemukan" }, 404);
      await appendAudit(redis, auth, migration.boothCode, `provider_migration.${operation}d`, migration.id, { state: migration.state });
      return json({ migration });
    }
    if (operation === "process") {
      const migration = (await listProviderMigrations(redis, 200)).find(item => item.id === String(payload.id || ""));
      if (!migration) return json({ error: "Migrasi provider tidak ditemukan" }, 404);
      const booth = await resolveBooth(redis, migration.boothCode);
      if (!booth) return json({ error: "Photobox migrasi tidak ditemukan" }, 404);
      const batch = await processProviderMigrationBatch(redis, migration.id, { limit: Math.max(1, Math.min(5, Number(payload.limit || 1))) });
      if (batch.skipped) return json({ error: batch.reason === "locked" ? "Migrasi sedang diproses worker lain" : "Migrasi tidak dapat diproses" }, 409);
      const result = batch.migration;
      await appendAudit(redis, auth, booth.boothCode, "provider_migration.processed", result.id, { state: result.state, copied: result.copied, total: result.total, failed: result.failed });
      return json({ migration: result });
    }
    if (operation === "finalize") {
      const migration = await finalizeProviderMigrationCutover(redis, String(payload.id || ""), auth.userId);
      if (!migration) return json({ error: "Migrasi provider tidak ditemukan" }, 404);
      await appendAudit(redis, auth, migration.boothCode, "provider_migration.finalized", migration.id, {
        destinationProvider: migration.destinationProvider,
        sourceRetirement: migration.sourceRetirement,
      });
      return json({ migration });
    }
    return json({ error: "Operasi migrasi provider tidak dikenal" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Migrasi provider gagal" }, 400);
  }
}

const BOOTH_OWNER_ROLES = new Set(["owner", "admin"]);
const boothOwnerAccess = async (redis, request, requestedCode = "") => {
  const access = await requireBoothAdmin(redis, request, requestedCode);
  if (!access || !BOOTH_OWNER_ROLES.has(String(access.auth?.role || "").toLowerCase())) return null;
  return access;
};

// Booth admins can inspect delegated integrations and test only a connection
// owned by their booth. Credential management and platform-wide connections
// remain exclusively in the superadmin control plane.
export async function boothIntegrationsControl(redis, request, payload = {}) {
  const access = await boothOwnerAccess(redis, request, payload.boothCode || payload.booth);
  if (!access) return json({ error: "Akses integrasi photobox ditolak" }, 403);
  const all = await listProviderConnections(redis);
  const connections = all.filter(item => item.scope === "global" || (item.scope === "booth" && item.targetId === access.booth.boothCode));
  if (request.method === "GET") return json({
    definitions: providerConnectionDefinitions(),
    connections,
    boothCode: access.booth.boothCode,
    permissions: { canView: true, canTestBoothConnection: true, canManageCredentials: false },
    checkedAt: now(),
  });
  if (request.method !== "POST") return json({ error: "Metode integrasi photobox tidak didukung" }, 405);
  if (String(payload.operation || "").toLowerCase() !== "test") return json({ error: "Credential integrasi hanya dapat dikelola superadmin" }, 403);
  const providerId = String(payload.providerId || "").trim().toLowerCase();
  const connection = connections.find(item => item.providerId === providerId && item.scope === "booth" && item.targetId === access.booth.boothCode);
  if (!connection || connection.status !== "active") return json({ error: "Koneksi khusus photobox yang aktif tidak ditemukan" }, 409);
  try {
    const runtime = await resolveProviderRuntime(redis, providerId, { boothCode: access.booth.boothCode });
    if (!runtime || runtime.connection?.scope !== "booth") return json({ error: "Credential provider photobox tidak tersedia" }, 409);
    const check = connection.capability === "monitoringAlert"
      ? await probeMonitoringWebhook({ environment: runtime.environment, timeoutMs: 3_000 })
      : connection.capability === "email"
        ? await probeEmailProvider({ providerId: runtime.providerId, environment: runtime.environment, timeoutMs: 3_000 })
        : connection.capability === "qris"
          ? await probeXendit({ environment: runtime.environment, timeoutMs: 3_000 })
          : { ...(await probeObjectStorage({ environment: runtime.environment, timeoutMs: 3_000 })), checkedAt: now() };
    const record = await recordProviderConnectionCheck(redis, { providerId, scope: "booth", targetId: access.booth.boothCode }, check);
    await appendAudit(redis, access.auth, access.booth.boothCode, "provider_connection.tested", record.id, { providerId, state: check.state, latencyMs: check.latencyMs });
    return json({ check, record });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Tes integrasi gagal" }, 400);
  }
}

const safeBoothLedgerEntry = (entry, finalizedProviderFeePayments = new Set()) => ({
  id: String(entry?.id || ""),
  type: String(entry?.type || "unknown"),
  currency: String(entry?.currency || "IDR"),
  gross: Number(entry?.gross || 0),
  platformFee: Number(entry?.platformFee || 0),
  providerFee: Number(entry?.providerFee || 0),
  boothEarning: Number(entry?.boothEarning || 0),
  createdAt: entry?.createdAt || entry?.updatedAt || null,
  available: entry?.type === "adjustment"
    || entry?.providerFeeFinal === true
    || (entry?.type === "payment_captured" && finalizedProviderFeePayments.has(entry?.paymentId)),
});

export async function boothFinanceControl(redis, request, payload = {}) {
  const access = await boothOwnerAccess(redis, request, payload.boothCode || payload.booth);
  if (!access) return json({ error: "Akses finance photobox ditolak" }, 403);
  if (request.method !== "GET") return json({ error: "Finance photobox hanya dapat dibaca" }, 405);
  const limit = Math.max(1, Math.min(100, Number(payload.limit || 50)));
  const [cachedEntries, durableEntries, payments, payouts] = await Promise.all([
    listPaymentLedger(redis, access.booth.boothCode, limit),
    readPostgresLedgerEntries([access.booth.boothCode], { limit }),
    listPayments(redis, access.booth.boothCode, limit),
    listPayouts(redis, { boothCode: access.booth.boothCode, limit }),
  ]);
  const unique = new Map();
  for (const entry of [...cachedEntries, ...durableEntries]) if (entry?.id && !unique.has(entry.id)) unique.set(entry.id, entry);
  const entries = [...unique.values()].sort((a, b) => Date.parse(b.createdAt || b.updatedAt || 0) - Date.parse(a.createdAt || a.updatedAt || 0));
  const finalizedProviderFeePayments = new Set(entries
    .filter(entry => entry.type === "provider_fee" && entry.providerFeeFinal === true && entry.paymentId)
    .map(entry => entry.paymentId));
  const fromTime = payload.from ? Date.parse(`${String(payload.from).slice(0, 10)}T00:00:00.000Z`) : Number.NEGATIVE_INFINITY;
  const toTime = payload.to ? Date.parse(`${String(payload.to).slice(0, 10)}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
  const inPeriod = value => { const time = Date.parse(value || 0); return Number.isFinite(time) && time >= fromTime && time <= toTime; };
  const reportEntries = entries.filter(entry => inPeriod(entry.createdAt || entry.updatedAt));
  const reportPayments = payments.filter(payment => inPeriod(payment.createdAt));
  const reportPayouts = payouts.filter(payout => inPeriod(payout.createdAt));
  const reportTotals = summarizeLedgerBalance(reportEntries);
  return json({
    boothCode: access.booth.boothCode,
    balance: summarizeLedgerBalance(entries),
    entries: entries.slice(0, limit).map(entry => safeBoothLedgerEntry(entry, finalizedProviderFeePayments)),
    report: {
      from: Number.isFinite(fromTime) ? new Date(fromTime).toISOString() : null,
      to: Number.isFinite(toTime) ? new Date(toTime).toISOString() : null,
      totals: reportTotals,
      payments: reportPayments,
      payouts: reportPayouts.map(payout => ({ id: payout.id, period: payout.period, amount: payout.amount, currency: payout.currency, status: payout.status, createdAt: payout.createdAt, paidAt: payout.paidAt })),
    },
    permissions: { canView: true, canManagePayout: false, canRefund: false },
    checkedAt: now(),
  });
}

export async function emailDeliveriesControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.integrations.read" : "platform.integrations.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses pengiriman email ditolak" }, 403);
  if (request.method === "GET") {
    const deliveries = await listEmailDeliveries(redis, payload.limit || 100);
    const summary = deliveries.reduce((result, item) => {
      result.total += 1;
      if (["queued", "retry", "waiting_configuration"].includes(item.status)) result.queued += 1;
      if (item.status === "sent") result.sent += 1;
      if (item.status === "delivered") result.delivered += 1;
      if (["failed", "bounced", "complained", "suppressed"].includes(item.status)) result.problems += 1;
      return result;
    }, { total: 0, queued: 0, sent: 0, delivered: 0, problems: 0 });
    return json({ deliveries, summary, checkedAt: now() });
  }
  if (request.method !== "POST") return json({ error: "Metode pengiriman email tidak didukung" }, 405);
  const operation = String(payload.operation || "process").toLowerCase();
  if (operation === "process") {
    const result = await processEmailDeliveries(redis, { limit: payload.limit || 10 });
    await appendAudit(redis, auth, "platform", "email.queue_processed", correlationId || randomId("email-process"), result);
    return json(result);
  }
  if (operation === "retry") {
    const delivery = await retryEmailDelivery(redis, payload.id, auth.userId);
    if (!delivery) return json({ error: "Pengiriman email tidak ditemukan" }, 404);
    if (delivery.status !== "queued") return json({ error: "Status email ini tidak aman untuk dikirim ulang" }, 409);
    await appendAudit(redis, auth, delivery.boothCode || "platform", "email.retry_requested", delivery.id, { status: delivery.status }, correlationId);
    return json({ delivery });
  }
  if (operation === "test") {
    if (!payload.confirmed) return json({ error: "Konfirmasi pengiriman email tes wajib dipilih" }, 400);
    const delivery = await enqueueEmail(redis, {
      template: "system_alert", to: payload.to,
      data: { boothName: "Photoslive Platform", title: "Tes pengiriman email", message: "Koneksi email Photoslive berhasil menerima antrean tes." },
      businessKey: `manual-test:${correlationId || randomId("email-test")}`,
    });
    const processed = await processEmailDelivery(redis, delivery.id);
    await appendAudit(redis, auth, "platform", "email.test_sent", delivery.id, { recipient: delivery.recipient, status: processed?.status || delivery.status }, correlationId);
    return json({ delivery: processed || delivery }, 202);
  }
  return json({ error: "Operasi pengiriman email tidak dikenal" }, 400);
}

export async function financePolicyControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.finance.read" : "platform.finance.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses kebijakan finance ditolak" }, 403);
  if (request.method === "GET") return json({ policies: await listFinancePolicies(redis) });
  const scope = String(payload.scope || "global");
  const targetId = String(payload.targetId || "");
  if (scope === "booth" && !await resolveBooth(redis, targetId)) return json({ error: "Photobox finance policy tidak ditemukan" }, 404);
  try {
    if (request.method === "POST") {
      const policy = await setFinancePolicy(redis, { scope, targetId, platformFeeBps: payload.platformFeeBps }, auth.userId);
      await appendAudit(redis, auth, policy.targetId || "platform", "finance.policy_updated", policy.id, { scope: policy.scope, platformFeeBps: policy.platformFeeBps });
      return json({ policy });
    }
    if (request.method === "DELETE") {
      const deleted = await deleteFinancePolicy(redis, { scope, targetId });
      if (deleted) await appendAudit(redis, auth, targetId || "platform", "finance.policy_deleted", `${scope}:${targetId || "_"}`, { scope });
      return json({ deleted });
    }
    return json({ error: "Metode kebijakan finance tidak didukung" }, 405);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Kebijakan finance gagal disimpan" }, 400);
  }
}

const payoutProofIntentKey = id => `photoslive:payout-proof-intent:${String(id || "").slice(0, 120)}`;

async function boothOwner(redis, boothCode) {
  const ids = await redis.smembers(`photoslive:booth:${boothCode}:users`);
  const records = await Promise.all(ids.map(id => redis.get(userKey(id))));
  return records.find(user => user?.active && user.role === "owner" && user.email)
    || records.find(user => user?.active && user.email)
    || null;
}

async function persistPayoutAccount(redis, boothCode) {
  const account = await getPayoutAccountPersistence(redis, boothCode);
  return account ? writePostgresPayoutAccount(account).catch(() => null) : null;
}

async function persistPayoutRecord(payout, correlationId = "") {
  if (!payout) return null;
  return Promise.all([
    writePostgresPayout(payout).catch(() => null),
    writePostgresShadowEvent({ entityType: "payout", legacyKey: payout.id, operation: "upsert", idempotencyKey: `payout:${payout.id}:${payout.status}:${payout.updatedAt}`, correlationId: correlationId || randomId("corr"), payload: payout }).catch(() => null),
  ]);
}

async function recordFinanceRiskCase(redis, input, actorId, correlationId = "") {
  const result = await recordFinanceRisk(redis, input, actorId);
  await writePostgresShadowEvent({
    entityType: "finance_risk",
    legacyKey: result.risk.id,
    operation: "upsert",
    idempotencyKey: `finance-risk:${result.risk.id}:${result.risk.status}:${result.risk.updatedAt}`,
    correlationId: correlationId || randomId("corr"),
    payload: result.risk,
  }).catch(() => null);
  return result;
}

export async function financePayoutControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  const readOnly = request.method === "GET";
  if (!hasPlatformPermission(auth, readOnly ? "platform.finance.read" : "platform.finance.write")) return json({ error: "Akses payout finance ditolak" }, 403);
  if (request.method === "GET") {
    if (String(payload.operation || "").toLowerCase() === "proof_download") {
      const payout = await getPayout(redis, payload.id);
      if (!payout?.proofObjectKey || !payout.proofVerifiedAt) return json({ error: "Bukti transfer tidak ditemukan" }, 404);
      const booth = await resolveBooth(redis, payout.boothCode);
      if (!booth) return json({ error: "Photobox payout tidak ditemukan" }, 404);
      const runtime = await storageRuntime(redis, booth, payout.proofProvider || "");
      const download = await presignObjectRequest({
        method: "GET",
        objectKey: payout.proofObjectKey,
        queryParameters: { "response-content-disposition": `inline; filename=\"bukti-${payout.id}.pdf\"` },
        expiresIn: 300,
        environment: runtime?.environment || process.env,
      });
      if (!download) return json({ error: "Object storage bukti transfer tidak tersedia" }, 409);
      await appendAudit(redis, auth, payout.boothCode, "payout.proof_viewed", payout.id, { expiresAt: download.expiresAt }, correlationId);
      return json({ download: { url: download.url, expiresAt: download.expiresAt } });
    }
    const boothCode = String(payload.boothCode || "");
    const [payouts, accounts, policy, emailDeliveries] = await Promise.all([
      listPayouts(redis, { boothCode, status: payload.status, limit: payload.limit }),
      listPayoutAccounts(redis),
      boothCode ? getPayoutPolicy(redis, boothCode) : Promise.resolve(null),
      listEmailDeliveries(redis, 200),
    ]);
    const deliveryMetrics = summarizePayoutEmailDelivery(payouts, emailDeliveries);
    return json({ payouts: deliveryMetrics.records, accounts, policy, deliverySummary: deliveryMetrics.summary, checkedAt: now() });
  }
  if (request.method !== "POST") return json({ error: "Metode payout tidak didukung" }, 405);
  const operation = String(payload.operation || "").toLowerCase();
  const requirePayoutReauthentication = async () => {
    if (await verifyPlatformReauthentication(redis, auth, payload.reauthPassword)) return null;
    await appendAudit(redis, auth, "platform", "payout.reauthentication_failed", String(payload.id || payload.boothCode || "payout"), { operation }, correlationId).catch(() => null);
    return json({ error: "Konfirmasi password Anda diperlukan untuk tindakan payout ini" }, 401);
  };
  try {
    if (operation === "policy") {
      const booth = await resolveBooth(redis, payload.boothCode);
      if (!booth) return json({ error: "Photobox payout tidak ditemukan" }, 404);
      const policy = await setPayoutPolicy(redis, payload, auth.userId);
      await Promise.all([
        writePostgresPayoutPolicy(policy).catch(() => null),
        appendAudit(redis, auth, booth.boothCode, "payout.policy_updated", booth.boothCode, { mode: policy.mode, minimumAmount: policy.minimumAmount }, correlationId),
      ]);
      return json({ policy });
    }
    if (operation === "account_save") {
      const reauthenticationError = await requirePayoutReauthentication();
      if (reauthenticationError) return reauthenticationError;
      const booth = await resolveBooth(redis, payload.boothCode);
      if (!booth) return json({ error: "Photobox payout tidak ditemukan" }, 404);
      const previousAccount = await getPayoutAccount(redis, booth.boothCode);
      const result = await savePayoutAccount(redis, payload, auth.userId);
      let alertDelivery = null;
      let alertWarning = null;
      let riskCase = null;
      if (previousAccount && result.account.version > previousAccount.version) {
        riskCase = await recordFinanceRiskCase(redis, {
          rule: "payout_account_changed", severity: "high", boothCode: booth.boothCode,
          entityType: "payout_account", entityId: `${booth.boothCode}:v${result.account.version}`,
          title: "Rekening payout berubah",
          description: "Perubahan rekening membatalkan payout aktif dan memerlukan verifikasi serta approval ulang.",
          metadata: { accountVersion: result.account.version, invalidatedPayouts: result.invalidatedPayouts, bankCode: result.account.bankCode },
        }, auth.userId, correlationId);
        const owner = await boothOwner(redis, booth.boothCode);
        if (owner?.email) {
          try {
            alertDelivery = await enqueueEmail(redis, {
              template: "system_alert", to: owner.email, boothCode: booth.boothCode,
              data: { boothName: booth.name || booth.boothCode, title: "Rekening payout berubah", message: `Rekening payout kini ${result.account.bankCode} ${result.account.accountNumberMasked}. Seluruh payout yang belum final dibatalkan dan memerlukan approval ulang.` },
              businessKey: `payout-account-changed:${booth.boothCode}:v${result.account.version}`,
            });
          } catch (error) {
            alertWarning = "Rekening tersimpan, tetapi email perubahan belum berhasil diantrekan";
          }
        }
      }
      await Promise.all([
        persistPayoutAccount(redis, booth.boothCode),
        appendAudit(redis, auth, booth.boothCode, "payout.account_saved", booth.boothCode, { bankCode: result.account.bankCode, accountNumberMasked: result.account.accountNumberMasked, accountVersion: result.account.version, invalidatedPayouts: result.invalidatedPayouts, alertDeliveryId: alertDelivery?.id || null, alertWarning }, correlationId),
      ]);
      return json({ ...result, alertDelivery, alertWarning, riskCase: riskCase?.risk || null }, 201);
    }
    if (operation === "account_verify") {
      if (auth.platformRole !== "platform_owner") return json({ error: "Verifikasi rekening hanya dapat dilakukan Platform Owner" }, 403);
      const reauthenticationError = await requirePayoutReauthentication();
      if (reauthenticationError) return reauthenticationError;
      const account = await verifyPayoutAccount(redis, payload, auth.userId);
      await Promise.all([
        persistPayoutAccount(redis, account.boothCode),
        appendAudit(redis, auth, account.boothCode, "payout.account_verified", account.boothCode, { accountVersion: account.version, reference: account.verificationReference }, correlationId),
      ]);
      return json({ account });
    }
    if (operation === "create") {
      const booth = await resolveBooth(redis, payload.boothCode);
      if (!booth) return json({ error: "Photobox payout tidak ditemukan" }, 404);
      const ledger = await listPaymentLedger(redis, booth.boothCode, 500);
      const result = await createManualPayout(redis, { ...payload, boothCode: booth.boothCode, actorId: auth.userId }, { ledgerRecords: ledger });
      let riskCase = null;
      const configuredThreshold = Number(process.env.FINANCE_HIGH_PAYOUT_IDR);
      const highValueThreshold = Number.isSafeInteger(configuredThreshold) && configuredThreshold > 0
        ? Math.max(1_000_000, configuredThreshold)
        : 10_000_000;
      if (!result.reused && result.payout.amount >= highValueThreshold) {
        riskCase = await recordFinanceRiskCase(redis, {
          rule: "high_value_payout", severity: "high", boothCode: booth.boothCode,
          entityType: "payout", entityId: result.payout.id,
          title: "Payout nominal tinggi perlu review",
          description: "Nominal payout melewati ambang review finance yang dikonfigurasi.",
          metadata: { amount: result.payout.amount, currency: result.payout.currency, threshold: highValueThreshold, period: result.payout.period },
        }, auth.userId, correlationId);
      }
      await Promise.all([
        persistPayoutRecord(result.payout, correlationId),
        appendAudit(redis, auth, booth.boothCode, result.reused ? "payout.batch_reused" : "payout.batch_created", result.payout.id, { amount: result.payout.amount, period: result.payout.period }, correlationId),
      ]);
      return json({ ...result, riskCase: riskCase?.risk || null }, result.reused ? 200 : 201);
    }
    if (operation === "approve") {
      if (auth.platformRole !== "platform_owner") return json({ error: "Approval payout hanya dapat dilakukan Platform Owner" }, 403);
      const reauthenticationError = await requirePayoutReauthentication();
      if (reauthenticationError) return reauthenticationError;
      const payout = await approveManualPayout(redis, payload, auth.userId);
      await Promise.all([
        persistPayoutRecord(payout, correlationId),
        appendAudit(redis, auth, payout.boothCode, "payout.approved", payout.id, { amount: payout.amount, accountVersion: payout.accountVersion }, correlationId),
      ]);
      return json({ payout });
    }
    if (operation === "proof_prepare") {
      const payout = await getPayout(redis, payload.id);
      if (!payout) return json({ error: "Payout tidak ditemukan" }, 404);
      if (payout.status !== "approved") return json({ error: "Payout belum disetujui" }, 409);
      const booth = await resolveBooth(redis, payout.boothCode);
      if (!booth) return json({ error: "Photobox payout tidak ditemukan" }, 404);
      const filename = String(payload.filename || "bukti-transfer.pdf").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
      const contentType = String(payload.contentType || "application/pdf").toLowerCase().slice(0, 100);
      const size = Number(payload.size || 0);
      const checksumSha256 = String(payload.checksumSha256 || "").toLowerCase();
      if (!new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]).has(contentType)) return json({ error: "Bukti transfer harus PDF, JPEG, PNG, atau WebP" }, 415);
      if (!Number.isSafeInteger(size) || size < 1 || size > 10_000_000) return json({ error: "Ukuran bukti transfer maksimal 10 MB" }, 413);
      if (!/^[a-f0-9]{64}$/.test(checksumSha256)) return json({ error: "Checksum bukti transfer tidak valid" }, 400);
      const runtime = await storageRuntime(redis, booth);
      const objectKey = `payout-proofs/${booth.boothCode}/${payout.id}/${randomId("proof")}-${filename}`;
      const upload = await presignObjectRequest({ method: "PUT", objectKey, contentType, checksumSha256, expiresIn: 600, environment: runtime?.environment || process.env });
      if (!upload) return json({ error: "Object storage belum tersedia untuk bukti transfer", capability: "cloudStorage" }, 409);
      const uploadId = randomId("payout-proof-upload");
      await redis.set(payoutProofIntentKey(uploadId), { uploadId, payoutId: payout.id, boothCode: booth.boothCode, actorId: auth.userId, objectKey, contentType, size, checksumSha256, provider: upload.provider, createdAt: now() }, { ex: 900 });
      return json({ uploadId, upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt } }, 201);
    }
    if (operation === "proof_finalize") {
      const intent = await redis.get(payoutProofIntentKey(payload.uploadId));
      if (!intent) return json({ error: "Upload bukti sudah kedaluwarsa" }, 404);
      if (intent.actorId !== auth.userId) return json({ error: "Upload bukti dimiliki sesi finance lain" }, 403);
      const booth = await resolveBooth(redis, intent.boothCode);
      if (!booth) return json({ error: "Photobox payout tidak ditemukan" }, 404);
      const runtime = await storageRuntime(redis, booth, intent.provider);
      const object = await inspectObject({ objectKey: intent.objectKey, environment: runtime?.environment || process.env });
      if (!object || object.size !== intent.size || String(object.checksumSha256 || "").toLowerCase() !== intent.checksumSha256) {
        await deleteObject({ objectKey: intent.objectKey, environment: runtime?.environment || process.env }).catch(() => false);
        await redis.del(payoutProofIntentKey(payload.uploadId));
        return json({ error: object?.size !== intent.size ? "Ukuran bukti transfer tidak cocok" : "Checksum bukti transfer tidak cocok" }, 422);
      }
      const payout = await attachPayoutProof(redis, { id: intent.payoutId, objectKey: intent.objectKey, checksum: intent.checksumSha256, provider: intent.provider }, auth.userId);
      await redis.del(payoutProofIntentKey(payload.uploadId));
      await Promise.all([
        persistPayoutRecord(payout, correlationId),
        appendAudit(redis, auth, payout.boothCode, "payout.proof_attached", payout.id, { objectKey: payout.proofObjectKey, checksum: intent.checksumSha256 }, correlationId),
      ]);
      return json({ payout });
    }
    if (operation === "mark_paid") {
      if (auth.platformRole !== "platform_owner") return json({ error: "Finalisasi payout hanya dapat dilakukan Platform Owner" }, 403);
      const reauthenticationError = await requirePayoutReauthentication();
      if (reauthenticationError) return reauthenticationError;
      let result;
      try {
        result = await markManualPayoutPaid(redis, payload, auth.userId);
      } catch (error) {
        if (error?.riskCode === "duplicate_transfer_reference") {
          const payout = await getPayout(redis, payload.id);
          const risk = await recordFinanceRiskCase(redis, {
            rule: "duplicate_transfer_reference", severity: "critical", boothCode: payout?.boothCode,
            entityType: "payout", entityId: payout?.id || payload.id,
            fingerprint: `duplicate_transfer_reference:${String(error.transferReference || "").toLowerCase()}:${payout?.id || payload.id}`,
            title: "Referensi transfer dipakai ulang",
            description: "Finalisasi payout diblokir karena referensi bank sudah terikat ke payout lain.",
            metadata: { attemptedPayoutId: payout?.id || payload.id, existingPayoutId: error.existingPayoutId, transferReference: error.transferReference },
          }, auth.userId, correlationId);
          await appendAudit(redis, auth, payout?.boothCode || "platform", "payout.duplicate_transfer_blocked", payout?.id || String(payload.id || "payout"), {
            existingPayoutId: error.existingPayoutId, riskId: risk.risk.id,
          }, correlationId).catch(() => null);
        }
        throw error;
      }
      const booth = await resolveBooth(redis, result.payout.boothCode);
      const owner = await boothOwner(redis, result.payout.boothCode);
      let delivery = null;
      let emailWarning = null;
      if (owner?.email) {
        try {
          delivery = await enqueueEmail(redis, {
            template: "payout_summary", to: owner.email, boothCode: result.payout.boothCode,
            data: { boothName: booth?.name || result.payout.boothCode, period: result.payout.period, amount: `Rp${Number(result.payout.amount).toLocaleString("id-ID")}`, reference: result.payout.transferReference },
            businessKey: `payout-paid:${result.payout.id}`,
          });
          await setPayoutEmailDelivery(redis, result.payout.id, delivery?.id);
        } catch (error) {
          emailWarning = "Transfer sudah final, tetapi email ringkasan belum berhasil diantrekan";
          await appendAudit(redis, auth, result.payout.boothCode, "payout.email_enqueue_failed", result.payout.id, {
            error: String(error?.message || "Email queue unavailable").slice(0, 240),
          }, correlationId).catch(() => null);
        }
      }
      await Promise.all([
        appendPostgresLedgerEntry(result.ledger).catch(() => null),
        persistPayoutRecord(result.payout, correlationId),
        appendAudit(redis, auth, result.payout.boothCode, result.reused ? "payout.paid_reused" : "payout.marked_paid", result.payout.id, { amount: result.payout.amount, transferReference: result.payout.transferReference, ledgerEntryId: result.ledger?.id, emailDeliveryId: delivery?.id || null }, correlationId),
      ]);
      return json({ ...result, delivery, emailWarning });
    }
    if (operation === "cancel") {
      const reauthenticationError = await requirePayoutReauthentication();
      if (reauthenticationError) return reauthenticationError;
      const payout = await cancelManualPayout(redis, payload, auth.userId);
      await Promise.all([
        persistPayoutRecord(payout, correlationId),
        appendAudit(redis, auth, payout.boothCode, "payout.cancelled", payout.id, { reason: payout.cancellationReason }, correlationId),
      ]);
      return json({ payout });
    }
    if (operation === "resend_email") {
      const payout = await getPayout(redis, payload.id);
      if (!payout?.emailDeliveryId) return json({ error: "Email payout belum pernah dibuat" }, 404);
      const delivery = await retryEmailDelivery(redis, payout.emailDeliveryId, auth.userId);
      if (!delivery || delivery.status !== "queued") return json({ error: "Status email payout tidak aman untuk dikirim ulang" }, 409);
      await appendAudit(redis, auth, payout.boothCode, "payout.email_retry_requested", payout.id, { deliveryId: delivery.id }, correlationId);
      return json({ payout, delivery });
    }
    return json({ error: "Operasi payout tidak dikenal" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Operasi payout gagal" }, Number(error?.status || 400));
  }
}

export async function financeRiskControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  const readOnly = request.method === "GET";
  if (!hasPlatformPermission(auth, readOnly ? "platform.finance.read" : "platform.finance.write")) return json({ error: "Akses risiko finance ditolak" }, 403);
  try {
    if (readOnly) {
      const records = await listFinanceRisks(redis, { boothCode: payload.boothCode, status: payload.status, severity: payload.severity, limit: payload.limit });
      return json({ records, summary: summarizeFinanceRisks(records), checkedAt: now() });
    }
    if (request.method !== "POST") return json({ error: "Metode risiko finance tidak didukung" }, 405);
    const operation = String(payload.operation || "").toLowerCase();
    if (operation === "resolve") {
      if (auth.platformRole !== "platform_owner") return json({ error: "Penyelesaian kasus risiko hanya dapat dilakukan Platform Owner" }, 403);
      if (!await verifyPlatformReauthentication(redis, auth, payload.reauthPassword)) {
        await appendAudit(redis, auth, "platform", "finance.risk_reauthentication_failed", String(payload.id || "finance-risk"), { operation }, correlationId).catch(() => null);
        return json({ error: "Konfirmasi password Anda diperlukan untuk menyelesaikan kasus risiko" }, 401);
      }
    }
    const result = await reviewFinanceRisk(redis, { id: payload.id, operation, note: payload.note }, auth.userId);
    await Promise.all([
      writePostgresShadowEvent({
        entityType: "finance_risk", legacyKey: result.risk.id, operation: "upsert",
        idempotencyKey: `finance-risk:${result.risk.id}:${result.risk.status}:${result.risk.updatedAt}`,
        correlationId: correlationId || randomId("corr"), payload: result.risk,
      }).catch(() => null),
      appendAudit(redis, auth, result.risk.boothCode || "platform", operation === "resolve" ? "finance.risk_resolved" : "finance.risk_acknowledged", result.risk.id, { rule: result.risk.rule, severity: result.risk.severity, note: result.risk.reviewNote }, correlationId),
    ]);
    return json(result);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Operasi risiko finance gagal" }, Number(error?.status || 400));
  }
}

export async function financeReconciliationControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.finance.read" : "platform.finance.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses rekonsiliasi finance ditolak" }, 403);
  if (request.method === "GET") {
    const records = await listPaymentReconciliation(redis, {
      status: String(payload.status || "review"),
      boothCode: String(payload.boothCode || ""),
      limit: Number(payload.limit || 100),
    });
    return json({ records, checkedAt: now() });
  }
  if (request.method !== "POST") return json({ error: "Metode rekonsiliasi finance tidak didukung" }, 405);
  try {
    const result = await reviewLatePayment(redis, {
      paymentId: payload.paymentId,
      decision: payload.decision,
      note: payload.note,
      reviewerId: auth.userId,
    });
    await Promise.all([
      writePostgresPaymentIntent(result.payment),
      writePostgresReconciliationJob(result.reconciliation),
      writePostgresShadowEvent({
        entityType: "payment_reconciliation",
        legacyKey: `${result.payment.boothCode}:${result.payment.id}`,
        operation: "upsert",
        idempotencyKey: `payment-review:${result.payment.id}:${result.payment.reviewStatus}`,
        correlationId: correlationId || randomId("corr"),
        payload: result.reconciliation,
      }),
      appendAudit(redis, auth, result.payment.boothCode, "payment.late_reviewed", result.payment.id, {
        decision: result.payment.reviewStatus,
        note: result.payment.reviewNote || null,
        reused: result.reused,
      }, correlationId),
    ]);
    return json({ payment: safePayment(result.payment), reconciliation: result.reconciliation, reused: result.reused });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Review pembayaran gagal" }, Number(error?.status || 400));
  }
}

export async function financeRefundControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.finance.write")) return json({ error: "Akses refund finance ditolak" }, 403);
  if (request.method !== "POST") return json({ error: "Metode refund finance tidak didukung" }, 405);
  try {
    const payment = await getPayment(redis, payload.paymentId) || await readPostgresPaymentById(payload.paymentId);
    if (!payment) return json({ error: "Pembayaran refund tidak ditemukan" }, 404);
    const booth = await resolveBooth(redis, payment.boothCode);
    if (!booth) return json({ error: "Photobox pembayaran tidak ditemukan" }, 404);
    const runtime = payment.providerConnectionRef
      ? await resolveProviderRuntimeReference(redis, payment.providerConnectionRef, providerContextForBooth(booth))
      : await resolveProviderRuntime(redis, payment.provider, providerContextForBooth(booth));
    if (!runtime?.environment) return json({ error: "Runtime provider refund tidak tersedia" }, 409);
    const result = await createXenditRefund(redis, {
      paymentId: payment.id,
      amount: payment.amount,
      reason: payload.reason,
      requestedBy: auth.userId,
    }, {
      environment: runtime.environment,
      paymentResolver: paymentId => readPostgresPaymentById(paymentId),
    });
    await Promise.all([
      writePostgresRefund(result.record),
      appendAudit(redis, auth, payment.boothCode, result.reused ? "payment.refund_reused" : "payment.refund_requested", result.record.id, {
        paymentId: payment.id,
        providerRefundId: result.record.providerRefundId,
        amount: result.record.amount,
        reason: result.record.reason,
      }, correlationId),
    ]);
    return json({ refund: result.refund, payment: safePayment(result.payment), reused: result.reused }, result.reused ? 200 : 202);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Refund gagal dibuat" }, Number(error?.status || 400));
  }
}

export async function financeChargebackControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.finance.write")) return json({ error: "Akses chargeback finance ditolak" }, 403);
  if (request.method !== "POST") return json({ error: "Metode chargeback finance tidak didukung" }, 405);
  try {
    const result = await recordManualChargeback(redis, {
      paymentId: payload.paymentId,
      providerChargebackId: payload.providerChargebackId,
      reason: payload.reason,
      disputedAt: payload.disputedAt,
      recordedBy: auth.userId,
    }, {
      paymentResolver: paymentId => readPostgresPaymentById(paymentId),
      chargebackResolver: paymentId => readPostgresChargebackByPaymentId(paymentId),
    });
    await Promise.all([
      writePostgresPaymentIntent(result.payment),
      writePostgresChargeback(result.record),
      result.ledger ? appendPostgresLedgerEntry(result.ledger) : Promise.resolve(),
      appendAudit(redis, auth, result.payment.boothCode, result.reused ? "payment.chargeback_reused" : "payment.chargeback_recorded", result.record.id, {
        paymentId: result.payment.id,
        providerChargebackId: result.record.providerChargebackId,
        amount: result.record.amount,
        disputedAt: result.record.disputedAt,
      }, correlationId),
    ]);
    return json({ chargeback: result.chargeback, payment: safePayment(result.payment), reused: result.reused }, result.reused ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Chargeback gagal dicatat" }, Number(error?.status || 400));
  }
}

export async function financeAdjustmentControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.finance.write")) return json({ error: "Akses koreksi ledger ditolak" }, 403);
  if (request.method !== "POST") return json({ error: "Metode koreksi ledger tidak didukung" }, 405);
  try {
    const result = await createLedgerAdjustment(redis, {
      paymentId: payload.paymentId,
      amount: payload.amount,
      reference: payload.reference,
      reason: payload.reason,
      createdBy: auth.userId,
    }, { paymentResolver: paymentId => readPostgresPaymentById(paymentId) });
    await Promise.all([
      appendPostgresLedgerEntry(result.ledger),
      appendAudit(redis, auth, result.payment.boothCode, result.reused ? "ledger.adjustment_reused" : "ledger.adjustment_created", result.ledger.id, {
        paymentId: result.payment.id,
        amount: result.ledger.boothEarning,
        reference: result.ledger.adjustmentReference,
        reason: result.ledger.adjustmentReason,
      }, correlationId),
    ]);
    return json({ ledger: result.ledger, payment: safePayment(result.payment), reused: result.reused }, result.reused ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Koreksi ledger gagal dibuat" }, Number(error?.status || 400));
  }
}

export async function financeProviderFeeControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.finance.write")) return json({ error: "Akses biaya provider ditolak" }, 403);
  if (request.method !== "POST") return json({ error: "Metode biaya provider tidak didukung" }, 405);
  try {
    const result = await recordProviderFee(redis, {
      paymentId: payload.paymentId,
      amount: payload.amount,
      reference: payload.reference,
      recordedBy: auth.userId,
    }, { paymentResolver: paymentId => readPostgresPaymentById(paymentId) });
    await Promise.all([
      appendPostgresLedgerEntry(result.ledger),
      appendAudit(redis, auth, result.payment.boothCode, result.reused ? "ledger.provider_fee_reused" : "ledger.provider_fee_finalized", result.ledger.id, {
        paymentId: result.payment.id,
        amount: result.ledger.providerFee,
        reference: result.ledger.providerFeeReference,
      }, correlationId),
    ]);
    return json({ ledger: result.ledger, payment: safePayment(result.payment), reused: result.reused }, result.reused ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Biaya provider gagal difinalisasi" }, Number(error?.status || 400));
  }
}

export async function financeBalancesControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.finance.read")) return json({ error: "Akses saldo finance ditolak" }, 403);
  if (request.method !== "GET") return json({ error: "Metode saldo finance tidak didukung" }, 405);
  const requestedBooth = String(payload.boothCode || "").trim();
  const machines = (await rawMachines(redis)).filter(machine => !requestedBooth || machine.boothCode === requestedBooth);
  if (requestedBooth && !machines.length) return json({ error: "Photobox saldo tidak ditemukan" }, 404);
  const boothCodes = machines.map(machine => machine.boothCode);
  const durableEntries = await readPostgresLedgerEntries(boothCodes, { limit: Number(payload.limit || 1_000) });
  const durableByBooth = new Map();
  for (const entry of durableEntries) {
    const entries = durableByBooth.get(entry.boothCode) || [];
    entries.push(entry);
    durableByBooth.set(entry.boothCode, entries);
  }
  const records = await Promise.all(machines.map(async machine => {
    const cachedEntries = await listPaymentLedger(redis, machine.boothCode, Number(payload.limit || 500));
    const entries = [...cachedEntries, ...(durableByBooth.get(machine.boothCode) || [])];
    return {
      boothCode: machine.boothCode,
      name: machine.name || machine.boothCode,
      ...summarizeLedgerBalance(entries),
    };
  }));
  const totals = records.reduce((summary, record) => ({
    currency: "IDR",
    pendingBalance: summary.pendingBalance + record.pendingBalance,
    availableBalance: summary.availableBalance + record.availableBalance,
    totalBalance: summary.totalBalance + record.totalBalance,
    entryCount: summary.entryCount + record.entryCount,
    provisionalEntryCount: summary.provisionalEntryCount + record.provisionalEntryCount,
  }), { currency: "IDR", pendingBalance: 0, availableBalance: 0, totalBalance: 0, entryCount: 0, provisionalEntryCount: 0 });
  return json({ records, totals, checkedAt: now() });
}

export async function financeLedgerReconciliationControl(redis, request, payload = {}, correlationId = "") {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.finance.read" : "platform.finance.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses rekonsiliasi ledger ditolak" }, 403);
  if (request.method === "GET") {
    return json({
      runs: await listLedgerReconciliationRuns(redis, { boothCode: payload.boothCode, limit: payload.limit }),
      checkedAt: now(),
    });
  }
  if (request.method !== "POST") return json({ error: "Metode rekonsiliasi ledger tidak didukung" }, 405);
  try {
    const boothCode = String(payload.boothCode || "").trim();
    const machine = (await rawMachines(redis)).find(record => record.boothCode === boothCode);
    if (!machine) return json({ error: "Photobox rekonsiliasi tidak ditemukan" }, 404);
    const [durableEntries, cachedEntries] = await Promise.all([
      readPostgresLedgerEntries([boothCode], { limit: 5_000 }),
      listPaymentLedger(redis, boothCode, 500),
    ]);
    const result = await createLedgerReconciliationRun(redis, {
      boothCode,
      provider: payload.provider,
      reference: payload.reference,
      providerRows: payload.providerRows,
      ledgerRecords: [...durableEntries, ...cachedEntries],
      createdBy: auth.userId,
    });
    await appendAudit(redis, auth, boothCode, result.reused ? "ledger.reconciliation_reused" : "ledger.reconciliation_created", result.run.id, {
      reference: result.run.reference,
      provider: result.run.provider,
      zeroDifference: result.run.zeroDifference,
      mismatchCount: result.run.mismatchCount,
      grossDifference: result.run.grossDifference,
      providerFeeDifference: result.run.providerFeeDifference,
    }, correlationId);
    return json({ run: result.run, reused: result.reused }, result.reused ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Rekonsiliasi ledger gagal" }, Number(error?.status || 400));
  }
}

export async function remoteJobsControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.remote_jobs.read" : "platform.remote_jobs.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses antrean remote ditolak" }, 403);
  const machines = await rawMachines(redis);
  if (request.method === "GET") {
    const jobs = await listRemoteJobs(redis, machines, 100);
    const summary = { total: jobs.length, queued: 0, active: 0, completed: 0, failed: 0 };
    for (const job of jobs) {
      if (job.status === "queued") summary.queued += 1;
      else if (["claimed", "running"].includes(job.status)) summary.active += 1;
      else if (job.status === "completed") summary.completed += 1;
      else if (["failed", "expired"].includes(job.status)) summary.failed += 1;
    }
    return json({ jobs, summary, checkedAt: now() });
  }
  if (request.method === "POST") {
    if (payload.operation === "create") {
      const machine = machines.find(item => item.id === String(payload.machineId || ""));
      if (!machine) return json({ error: "Mesin tidak ditemukan" }, 404);
      try {
        const result = await enqueueRemoteJob(redis, machine, {
          type: String(payload.type || ""), payload: {}, ttlSeconds: 600,
          idempotencyKey: String(payload.idempotencyKey || ""),
        }, SUPERADMIN_REMOTE_JOB_TYPES);
        if (!result.reused) await appendAudit(redis, auth, machine.boothCode || "platform", "hardware_job.created", result.job.id, { machineId: machine.id, type: result.job.type });
        return json({ job: { id: result.job.id, machineId: result.job.machineId, type: result.job.type, status: result.job.status, expiresAt: result.job.expiresAt }, reused: result.reused }, result.reused ? 200 : 201);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Perintah remote gagal dibuat" }, 409);
      }
    }
    const source = await redis.get(jobKey(String(payload.jobId || "")));
    if (!source) return json({ error: "Job tidak ditemukan" }, 404);
    const machine = machines.find(item => item.id === source.machineId);
    try {
      const result = await retryRemoteJob(redis, source, machine);
      if (!result.reused) await appendAudit(redis, auth, machine?.boothCode || "platform", "hardware_job.retried", result.job.id, { retryOf: source.id, machineId: source.machineId, type: source.type });
      return json({ job: { id: result.job.id, status: result.job.status, retryOf: result.job.retryOf }, reused: result.reused }, result.reused ? 200 : 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Retry job gagal" }, 409);
    }
  }
  return json({ error: "Metode antrean remote tidak didukung" }, 405);
}

export async function agentConnectionControl(redis, request, payload = {}, correlationId = "") {
  if (request.method !== "POST") return json({ error: "Metode kontrol Agent tidak didukung" }, 405);
  const access = await requireBoothAdmin(redis, request, payload.booth);
  if (!access || !["owner", "admin"].includes(access.auth.role)) return json({ error: "Hanya owner atau admin yang dapat mengubah koneksi Agent" }, 403);
  const desiredState = payload.paused === true ? "paused" : "running";
  const machine = await redis.get(machineKey(access.booth.machineId));
  if (!machine) return json({ error: "Mesin photobox tidak ditemukan" }, 404);
  machine.desiredState = desiredState;
  machine.updatedAt = now();
  await Promise.all([
    redis.set(machineKey(machine.id), machine),
    appendAudit(redis, access.auth, access.booth.boothCode, `agent.connection_${desiredState}`, machine.id, { desiredState }, correlationId),
  ]);
  return json({ desiredState, agentState: machine.agentState || "unknown", applied: machine.agentState === desiredState });
}

function voucherCode(value = "") {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

function voucherSnapshotLoader(boothCode) {
  let pending = null;
  return () => {
    pending ||= readPostgresVoucherSnapshot(boothCode);
    return pending;
  };
}

async function voucherRecords(redis, boothCode, loadSnapshot = null) {
  if (postgresVoucherStatus().primary) return (await (loadSnapshot?.() || readPostgresVoucherSnapshot(boothCode)))?.vouchers || [];
  const codes = await redis.smembers(voucherIndexKey(boothCode));
  if (!codes.length) {
    return [];
  }
  const keys = codes.map(code => voucherKey(boothCode, code));
  const records = typeof redis.mget === "function"
    ? await redis.mget(...keys)
    : await Promise.all(keys.map(key => redis.get(key)));
  return records.filter(Boolean);
}

async function voucherEvents(redis, boothCode, loadSnapshot = null) {
  if (postgresVoucherStatus().primary) return (await (loadSnapshot?.() || readPostgresVoucherSnapshot(boothCode)))?.events || [];
  const ids = await redis.smembers(voucherEventIndexKey(boothCode));
  if (!ids.length) {
    return [];
  }
  const keys = ids.map(id => voucherEventKey(boothCode, id));
  const events = typeof redis.mget === "function"
    ? await redis.mget(...keys)
    : await Promise.all(keys.map(key => redis.get(key)));
  return events.filter(Boolean);
}

function publicAssetProjection(record) {
  if (!record) return null;
  const {
    data: _data,
    objectKey: _objectKey,
    storageProvider: _storageProvider,
    etag: _etag,
    deletionRequested: _deletionRequested,
    deletionRequestedAt: _deletionRequestedAt,
    ...safe
  } = record;
  return safe;
}

async function cacheAssetRecord(redis, record) {
  if (!record?.id || !ASSET_KINDS.includes(record.kind)) return;
  await redis.set(assetKey(record.boothCode, record.id), record);
  await redis.sadd(assetIndexKey(record.boothCode, record.kind), record.id);
}

async function assetRecords(redis, boothCode) {
  const cached = [];
  await Promise.all(ASSET_KINDS.map(async kind => {
    const ids = await redis.smembers(assetIndexKey(boothCode, kind));
    const records = (await Promise.all(ids.map(id => redis.get(assetKey(boothCode, id))))).filter(Boolean);
    cached.push(...records);
  }));
  if (!postgresAssetStatus().primary) return cached;
  const durable = await readPostgresAssets(boothCode);
  if (!durable) return cached;
  await Promise.all(durable.map(record => cacheAssetRecord(redis, record)));
  const merged = new Map(cached.map(record => [record.id, record]));
  durable.forEach(record => merged.set(record.id, record));
  return [...merged.values()];
}

export async function cloudAssets(redis, boothCode) {
  const result = Object.fromEntries(ASSET_KINDS.map(kind => [kind, []]));
  const records = await assetRecords(redis, boothCode);
  ASSET_KINDS.forEach(kind => {
    result[kind] = records.filter(record => record.kind === kind && !record.deletionRequested)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(publicAssetProjection);
  });
  return result;
}

async function platformFrameRecords(redis) {
  const ids = await redis.smembers(platformFrameIndexKey);
  if (!ids.length) return [];
  const records = typeof redis.mget === "function"
    ? await redis.mget(...ids.map(platformFrameKey))
    : await Promise.all(ids.map(id => redis.get(platformFrameKey(id))));
  return records.filter(Boolean).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function safePlatformFrame(record) {
  return {
    id: String(record.id || ""),
    name: String(record.name || "frame"),
    contentType: String(record.contentType || "application/octet-stream"),
    size: Number(record.size || 0),
    checksumSha256: String(record.checksumSha256 || ""),
    createdAt: record.createdAt || null,
    createdBy: String(record.createdBy || ""),
    previewUrl: `/api/platform?action=platform_frame_download&id=${encodeURIComponent(record.id)}`,
    downloadUrl: `/api/platform?action=platform_frame_download&id=${encodeURIComponent(record.id)}&download=1`,
  };
}

function eventExpired(event) {
  return Boolean(event?.expiresAt && Date.parse(event.expiresAt) <= Date.now());
}

async function voucherPayload(redis, boothCode) {
  const loadSnapshot = voucherSnapshotLoader(boothCode);
  const [records, events] = await Promise.all([voucherRecords(redis, boothCode, loadSnapshot), voucherEvents(redis, boothCode, loadSnapshot)]);
  const eventMap = new Map(events.map(event => [event.id, event]));
  const active = records.filter(record => !record.redeemedAt && !eventExpired(eventMap.get(record.eventId)));
  const renderedEvents = events.map(event => {
    const members = records.filter(record => record.eventId === event.id);
    return { ...event, status: eventExpired(event) ? "expired" : "active", active: members.filter(record => !record.redeemedAt && !eventExpired(event)).length, used: members.filter(record => record.redeemedAt).length, total: members.length };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    vouchers: active.slice(0, 100).map(record => ({ ...record, eventName: eventMap.get(record.eventId)?.name || "" })),
    summary: { generalActive: active.filter(record => !record.eventId).length, eventActive: active.filter(record => record.eventId).length, used: records.filter(record => record.redeemedAt).length },
    events: renderedEvents,
  };
}

async function createCloudVoucher(redis, boothCode, payload, options = {}) {
  const code = voucherCode(payload.code) || `${pairingVoucherPart()}-${pairingVoucherPart()}`;
  if (code.length < 4) return json({ error: "Kode voucher minimal 4 karakter" }, 400);
  const voucherStatus = postgresVoucherStatus();
  let existing = voucherStatus.primary
    ? (await voucherRecords(redis, boothCode)).find(record => record.code === code) || null
    : await redisBestEffort(() => redis.get(voucherKey(boothCode, code)));
  if (existing) return json({ error: "Kode voucher sudah digunakan" }, 409);
  let event = payload.eventId && !voucherStatus.primary ? await redisBestEffort(() => redis.get(voucherEventKey(boothCode, String(payload.eventId)))) : null;
  if (!event && payload.eventId && voucherStatus.primary) {
    event = (await voucherEvents(redis, boothCode)).find(record => record.id === String(payload.eventId)) || null;
  }
  if (payload.eventId && (!event || eventExpired(event))) return json({ error: "Event tidak ditemukan atau sudah berakhir" }, 404);
  const record = { code, boothCode, eventId: event?.id || null, includesPrint: event ? Boolean(event.includesPrint) : true, createdAt: now(), redeemedAt: null };
  try {
    await persistVoucherBatch(redis, boothCode, [record], options);
  } catch (error) {
    return json({
      error: "Voucher belum dapat disimpan. Data belum dibuat; coba lagi setelah koneksi cloud pulih.",
      retryable: true,
      correlationId: String(options.correlationId || ""),
    }, Number(error?.status || 503));
  }
  return json({ voucher: record }, 201);
}

function pairingVoucherPart() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join("");
}

export async function persistVoucherBatch(redis, boothCode, vouchers, options = {}) {
  // Upstash exposes MULTI as a pipeline-compatible command builder. Prefer it
  // so records, the active index, and the version advance atomically. The
  // pipeline fallback keeps local/test adapters backward compatible.
  const postgresStatus = postgresVoucherStatus(options.environment || process.env);
  let postgresResult = null;
  if (postgresStatus.primary) {
    postgresResult = await persistPostgresVoucherBatch({ boothCode, vouchers, correlationId: options.correlationId }, options);
    if (!postgresResult.ok) throw Object.assign(new Error(postgresResult.reason || "Penyimpanan voucher PostgreSQL gagal"), { status: 503 });
  }
  let results = [];
  try {
    const transaction = typeof redis.multi === "function" ? redis.multi() : redis.pipeline();
    for (const record of vouchers) transaction.set(voucherKey(boothCode, record.code), record);
    if (vouchers.length) transaction.sadd(voucherIndexKey(boothCode), ...vouchers.map(record => record.code));
    if (postgresStatus.primary) transaction.set(voucherVersionKey(boothCode), postgresResult.version);
    else transaction.incr(voucherVersionKey(boothCode));
    results = await transaction.exec();
  } catch (error) {
    if (!postgresStatus.primary) throw error;
  }
  const versionResult = results.at(-1);
  const version = postgresStatus.primary
    ? postgresResult.version
    : Number(versionResult?.result ?? versionResult ?? 0);
  if (!Number.isFinite(version) || version < 1) throw new Error("Versi voucher tidak dapat diperbarui");
  if (postgresStatus.mode === "dual") {
    // Dual mode is intentionally best-effort: Redis remains authoritative
    // until the migration report and live acceptance have passed.
    await persistPostgresVoucherBatch({ boothCode, vouchers, correlationId: options.correlationId }, options);
  }
  return version;
}

async function hydratePostgresBoothDirectory(redis, code) {
  if (!postgresDirectoryStatus().primary) return null;
  const directory = await readPostgresBoothDirectory(code);
  if (!directory) return null;
  const cached = await redisBestEffort(() => redis.get(machineKey(directory.machineId)), {}) || {};
  const machine = {
    ...cached,
    id: directory.machineId,
    boothCode: directory.boothCode,
    organizationId: directory.organizationLegacyId,
    name: directory.name,
    location: directory.location,
    accessEnabled: directory.accessEnabled,
    paired: true,
    status: cached.status || "offline",
    agentState: cached.agentState || "unknown",
    controllerState: cached.controllerState || "unknown",
    updatedAt: directory.updatedAt || cached.updatedAt || now(),
  };
  await redisBestEffort(async () => {
    const transaction = typeof redis.multi === "function" ? redis.multi() : redis.pipeline();
    transaction.set(machineKey(machine.id), machine);
    transaction.set(boothKey(directory.boothCode), machine.id);
    transaction.sadd("photoslive:machines", machine.id);
    return transaction.exec();
  });
  return machine;
}

async function readSetupMachine(redis, code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return { machineId: null, machine: null, source: "" };
  const postgresStatus = postgresMachineStatus();
  if (postgresStatus.primary) {
    const machine = await readPostgresPairing(normalized);
    if (machine) return { machineId: machine.id, machine, source: "postgres" };
  }
  try {
    const machineId = await redis.get(`photoslive:pairing:${normalized}`);
    const machine = machineId ? await redis.get(machineKey(machineId)) : null;
    if (machine) return { machineId, machine, source: "redis" };
  } catch (error) {
    if (!isUpstashMaxRequestsError(error)) throw error;
  }
  if (postgresStatus.enabled && !postgresStatus.primary) {
    const machine = await readPostgresPairing(normalized);
    if (machine) return { machineId: machine.id, machine, source: "postgres" };
  }
  return { machineId: null, machine: null, source: "" };
}

async function redisBestEffort(operation, fallback = null) {
  try {
    return await operation();
  } catch (error) {
    if (!isUpstashMaxRequestsError(error)) throw error;
    return fallback;
  }
}

async function readAdminUserByEmail(redis, email) {
  const normalized = normalizeEmail(email);
  const postgresStatus = postgresUsersStatus();
  if (postgresStatus.primary) return readPostgresAdminUserByEmail(normalized);
  try {
    const userId = await redis.get(`photoslive:email:${normalized}`);
    const user = userId ? await redis.get(userKey(userId)) : null;
    if (user) return user;
  } catch (error) {
    if (!isUpstashMaxRequestsError(error)) throw error;
  }
  return postgresStatus.enabled ? readPostgresAdminUserByEmail(normalized) : null;
}

async function readAdminUserById(redis, userId) {
  const postgresStatus = postgresUsersStatus();
  if (postgresStatus.primary) return readPostgresAdminUserById(userId);
  try {
    const user = await redis.get(userKey(userId));
    if (user) return user;
  } catch (error) {
    if (!isUpstashMaxRequestsError(error)) throw error;
  }
  return postgresStatus.enabled ? readPostgresAdminUserById(userId) : null;
}

async function listAdminUsers(redis, boothCode) {
  const postgresStatus = postgresUsersStatus();
  if (postgresStatus.primary) return listPostgresAdminUsers(boothCode);
  try {
    const ids = await redis.smembers(`photoslive:booth:${boothCode}:users`);
    const users = [];
    for (const id of ids) {
      const user = await redis.get(userKey(id));
      if (user) users.push(user);
    }
    if (users.length) return users;
  } catch (error) {
    if (!isUpstashMaxRequestsError(error)) throw error;
  }
  return postgresStatus.enabled ? listPostgresAdminUsers(boothCode) : [];
}

async function persistAdminUser(redis, user) {
  const postgresStatus = postgresUsersStatus();
  if (postgresStatus.primary) {
    const persisted = await persistPostgresAdminUser(user);
    if (!persisted.ok) return persisted;
  }
  await redisBestEffort(() => redis.set(userKey(user.id), user));
  await redisBestEffort(() => redis.set(`photoslive:email:${user.email}`, user.id));
  await redisBestEffort(() => redis.sadd(`photoslive:booth:${user.boothCode}:users`, user.id));
  if (postgresStatus.mode === "dual") await persistPostgresAdminUser(user).catch(() => null);
  return { ok: true, user };
}

export async function resolveBooth(redis, code) {
  const lookupCode = normalizeCode(code);
  let machineId = await redisBestEffort(() => redis.get(boothKey(lookupCode)));
  if (!machineId) machineId = (await hydratePostgresBoothDirectory(redis, lookupCode))?.id || null;
  if (!machineId) return null;
  let machine = await redisBestEffort(() => redis.get(machineKey(machineId)));
  if (!machine) machine = await hydratePostgresBoothDirectory(redis, lookupCode);
  if (!machine) return null;
  const boothCode = normalizeCode(machine.boothCode || lookupCode);
  const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0;
  const health = machineHealth(machine);
  const telemetry = machine.telemetry && typeof machine.telemetry === "object" ? machine.telemetry : {};
  return {
    boothCode, machineId, organizationId: machine.organizationId || "", name: machine.name,
    location: machine.location || "", enabled: machine.accessEnabled !== false,
    online: Boolean(lastSeen && Date.now() - lastSeen < 90_000), health,
    lastSeenAt: machine.lastSeenAt || null, agentVersion: machine.agentVersion,
    agentState: machine.agentState || "unknown", controllerState: machine.controllerState || "unknown",
    platform: machine.platform || "",
    update: machine.update && typeof machine.update === "object" ? {
      state: String(machine.update.state || machine.update.status || "unknown").slice(0, 40),
      currentVersion: String(machine.update.currentVersion || machine.agentVersion || "").slice(0, 40),
      availableVersion: String(machine.update.availableVersion || "").slice(0, 40),
      message: String(machine.update.message || "").slice(0, 240),
      verified: machine.update.verified === true,
      rollbackAvailable: machine.update.rollbackAvailable === true,
    } : null,
    telemetry: {
      hostname: String(telemetry.hostname || "").slice(0, 160),
      disk: telemetry.disk && typeof telemetry.disk === "object" ? {
        totalBytes: Number(telemetry.disk.totalBytes || 0), freeBytes: Number(telemetry.disk.freeBytes || 0),
      } : null,
      memory: telemetry.memory && typeof telemetry.memory === "object" ? {
        totalBytes: Number(telemetry.memory.totalBytes || 0), availableBytes: Number(telemetry.memory.availableBytes || 0),
      } : null,
      backup: safeBackupTelemetry(telemetry.backup),
    },
  };
}

export function safeBackupTelemetry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowedStatus = new Set(["ready", "missing", "unavailable"]);
  const allowedRestoreStatus = new Set(["never", "completed", "failed", "unknown"]);
  return {
    status: allowedStatus.has(value.status) ? value.status : "unavailable",
    count: Math.max(0, Math.min(999, Number(value.count || 0))),
    latestAt: typeof value.latestAt === "string" ? value.latestAt.slice(0, 64) : null,
    latestReason: typeof value.latestReason === "string" ? value.latestReason.slice(0, 32) : null,
    latestSchemaVersion: Math.max(0, Number(value.latestSchemaVersion || 0)),
    latestSizeBytes: Math.max(0, Number(value.latestSizeBytes || 0)),
    databaseStatus: typeof value.databaseStatus === "string" ? value.databaseStatus.slice(0, 40) : "unknown",
    restoreStatus: allowedRestoreStatus.has(value.restoreStatus) ? value.restoreStatus : "unknown",
    restoreAt: typeof value.restoreAt === "string" ? value.restoreAt.slice(0, 64) : null,
  };
}

export async function validateSetupCode(redis, payload) {
  const code = String(payload.pairingCode || "").trim().toUpperCase();
  if (!code) return json({ error: "Masukkan kode setup dari Photoslive Agent" }, 400);
  const { machineId, machine } = await readSetupMachine(redis, code);
  if (!machineId) return json({ error: "Kode setup tidak ditemukan atau sudah kedaluwarsa. Buat kode baru dari Agent." }, 404);
  if (!machine) return json({ error: "Mesin tidak ditemukan" }, 404);
  if (machine.pairingCode !== code) return json({ error: "Kode setup bukan kode terbaru untuk mesin ini" }, 409);
  if (machine.paired) return json({ error: "Mesin sudah memiliki pemilik. Gunakan halaman masuk." }, 409);
  const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0;
  return json({
    valid: true,
    machine: {
      id: machine.id,
      name: machine.name || "Photoslive Booth",
      location: machine.location || "",
      platform: machine.platform || "Unknown",
      agentVersion: machine.agentVersion || "",
      online: Boolean(lastSeen && Date.now() - lastSeen < 90_000),
      devices: Array.isArray(machine.devices) ? machine.devices : [],
    },
  });
}

export async function setupBooth(redis, payload) {
  const code = String(payload.pairingCode || "").trim().toUpperCase();
  const email = normalizeEmail(payload.email);
  if (!code || !email) return json({ error: "Kode setup dan email wajib diisi" }, 400);
  if (!/^\d{6}$/.test(String(payload.pin || "")) || payload.pin !== payload.confirmPin) return json({ error: "PIN harus 6 angka dan konfirmasinya harus sama" }, 400);
  const setupMachine = await readSetupMachine(redis, code);
  const machineId = setupMachine.machineId;
  if (!machineId) return json({ error: "Kode setup tidak ditemukan atau sudah kedaluwarsa. Jalankan Agent dengan --setup-code." }, 404);
  const machine = setupMachine.machine;
  if (!machine) return json({ error: "Mesin tidak ditemukan" }, 404);
  if (machine.pairingCode !== code) return json({ error: "Kode setup bukan kode terbaru untuk mesin ini" }, 409);
  if (machine.paired) return json({ error: "Mesin sudah memiliki pemilik. Masuk dengan akun yang ada atau minta pemilik menambahkan pengguna." }, 409);
  const claimId = randomId("setup_claim");
  const claimKey = `photoslive:pairing-claim:${code}`;
  const claimed = await redisBestEffort(() => redis.set(claimKey, claimId, { nx: true, ex: 120 }), "OK");
  if (!claimed) return json({ error: "Kode setup sedang diproses. Tunggu sebentar lalu periksa status mesin." }, 409);
  try {
    const activeMachineId = setupMachine.source === "postgres"
      ? (await readPostgresPairing(code))?.id
      : await redisBestEffort(() => redis.get(`photoslive:pairing:${code}`));
    if (activeMachineId !== machineId) return json({ error: "Kode setup sudah digunakan atau diganti" }, 409);
  const boothCode = normalizeCode(machine.boothCode || code);
  const existingEmail = await readAdminUserByEmail(redis, email);
  if (existingEmail) return json({ error: "Email sudah digunakan" }, 409);
  const directoryStatus = postgresDirectoryStatus();
  const directoryInput = {
    boothCode,
    machineId,
    organizationLegacyId: String(machine.organizationId || `organization-${boothCode}`).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120),
    organizationName: String(payload.organizationName || payload.name || machine.name || "Photoslive").slice(0, 120),
    name: String(payload.name || machine.name || "Photoslive Booth").slice(0, 120),
    location: String(payload.location || "").slice(0, 120),
    accessEnabled: true,
  };
  if (directoryStatus.primary) {
    const persisted = await persistPostgresBoothDirectory(directoryInput);
    if (!persisted.ok) return json({
      error: "Photobox belum dapat disimpan ke database. Setup belum diterapkan; coba lagi setelah koneksi cloud pulih.",
      retryable: true,
    }, 503);
  }
  machine.paired = true;
  machine.status = "offline";
  machine.name = String(payload.name || machine.name || "Photoslive Booth").slice(0, 80);
  machine.location = String(payload.location || "").slice(0, 120);
  machine.boothCode = boothCode;
  machine.accessEnabled = true;
  machine.pairedAt ||= now();
  machine.setupAt = now();
  delete machine.pairingCode;
  const user = { id: randomId("user"), boothCode, machineId, email, name: "Pemilik", role: "owner", passwordHash: payload.password ? await hashCredential(payload.password) : "", pinHash: await hashCredential(payload.pin), createdAt: now(), active: true };
  const postgresMachine = postgresMachineStatus();
  if (postgresMachine.primary) await markPostgresMachinePaired(code, machine, boothCode);
  await redisBestEffort(() => redis.set(machineKey(machineId), machine));
  await redisBestEffort(() => redis.set(boothKey(boothCode), machineId));
  // A setup code is also a permanent login alias. Users commonly keep the
  // code shown by Agent, while the canonical booth URL may predate onboarding.
  await redisBestEffort(() => redis.set(boothKey(code), machineId));
  const persistedUser = await persistAdminUser(redis, user);
  if (!persistedUser.ok) return json({
    error: "Akun owner belum dapat disimpan ke database. Setup belum diterapkan; coba lagi setelah koneksi cloud pulih.",
    retryable: true,
  }, 503);
  await redisBestEffort(() => redis.sadd("photoslive:machines", machineId));
  await redisBestEffort(() => redis.del(`photoslive:pairing:${code}`));
  if (postgresMachine.mode === "dual") await markPostgresMachinePaired(code, machine, boothCode);
  if (directoryStatus.mode === "dual") await persistPostgresBoothDirectory(directoryInput);
  const token = await createSession(redis, { userId: user.id, boothCode, machineId, role: user.role });
  return json({ booth: await resolveBooth(redis, boothCode), user: { id: user.id, email, name: user.name, role: user.role } }, 201, { "set-cookie": sessionCookie(token) });
  } finally {
    if (await redisBestEffort(() => redis.get(claimKey)) === claimId) await redisBestEffort(() => redis.del(claimKey));
  }
}

export async function login(redis, payload) {
  const lookupCode = normalizeCode(payload.boothCode);
  const pinLogin = Boolean(payload.pin);
  if (pinLogin && !payload.localAssertion) return json({ error: "PIN hanya tersedia pada komputer photobox. Gunakan email dan password untuk masuk jarak jauh." }, 403);
  let booth = await resolveBooth(redis, lookupCode);
  if (!booth) {
    const recoveryEmail = normalizeEmail(payload.email);
    if (!recoveryEmail || !payload.pin) return json({ error: "Kode photobox belum tertaut. Masukkan email pemilik untuk memulihkannya.", recoveryRequired: true }, 404);
    const recoveryUser = await readAdminUserByEmail(redis, recoveryEmail);
    if (!recoveryUser?.active || !await verifyCredential(payload.pin, recoveryUser.pinHash)) return json({ error: "Email pemilik atau PIN tidak benar", recoveryRequired: true }, 401);
    booth = await resolveBooth(redis, recoveryUser.boothCode);
    if (!booth || !booth.enabled) return json({ error: "Akses photobox dinonaktifkan" }, 403);
    const localProof = await verifyLocalLoginAssertion(redis, payload.localAssertion, booth);
    if (!localProof.valid) return json({ error: localProof.error }, 403);
    const existingAlias = await redisBestEffort(() => redis.get(boothKey(lookupCode)));
    if (!existingAlias || existingAlias === booth.machineId) await redisBestEffort(() => redis.set(boothKey(lookupCode), booth.machineId));
    const token = await createSession(redis, { userId: recoveryUser.id, boothCode: booth.boothCode, machineId: booth.machineId, role: recoveryUser.role });
    return json({ booth, user: { id: recoveryUser.id, email: recoveryUser.email, name: recoveryUser.name, role: recoveryUser.role }, aliasRepaired: true }, 200, { "set-cookie": sessionCookie(token) });
  }
  if (!booth.enabled) return json({ error: "Akses photobox dinonaktifkan" }, 403);
  if (pinLogin) {
    const localProof = await verifyLocalLoginAssertion(redis, payload.localAssertion, booth);
    if (!localProof.valid) return json({ error: localProof.error }, 403);
  }
  const boothCode = booth.boothCode;
  const users = await listAdminUsers(redis, boothCode);
  let matched = null;
  for (const user of users) {
    if (!user?.active) continue;
    if (payload.pin && await verifyCredential(payload.pin, user.pinHash)) { matched = user; break; }
    if (normalizeEmail(payload.email) === user.email && await verifyCredential(payload.password, user.passwordHash)) { matched = user; break; }
  }
  if (!matched) return json({ error: "Email/password atau PIN tidak benar" }, 401);
  const aliasCode = normalizeCode(payload.aliasCode);
  if (aliasCode && aliasCode !== boothCode) {
    const existingAlias = await redisBestEffort(() => redis.get(boothKey(aliasCode)));
    if (!existingAlias || existingAlias === booth.machineId) await redisBestEffort(() => redis.set(boothKey(aliasCode), booth.machineId));
  }
  const token = await createSession(redis, { userId: matched.id, boothCode, machineId: booth.machineId, role: matched.role });
  return json({ booth, user: { id: matched.id, email: matched.email, name: matched.name, role: matched.role } }, 200, { "set-cookie": sessionCookie(token) });
}

export async function superadminLogin(redis, payload) {
  const email = normalizeEmail(payload.email);
  const expectedEmail = normalizeEmail(process.env.SUPERADMIN_EMAIL);
  const passwordHash = process.env.SUPERADMIN_PASSWORD_HASH || "";
  let session;
  if (expectedEmail && email === expectedEmail && await verifyCredential(payload.password, passwordHash)) {
    session = { userId: "superadmin", role: "superadmin", platformRole: normalizePlatformRole(process.env.SUPERADMIN_ROLE) };
  } else {
    const staffId = await redis.get(platformStaffEmailKey(email));
    const staff = staffId ? await redis.get(platformStaffKey(staffId)) : null;
    if (!staff || staff.status !== "active" || !await verifyCredential(payload.password, staff.passwordHash)) return json({ error: "Kredensial superadmin tidak benar" }, 401);
    staff.lastLoginAt = now();
    staff.updatedAt = staff.lastLoginAt;
    await redis.set(platformStaffKey(staff.id), staff);
    session = { userId: staff.id, role: "superadmin", platformRole: normalizePlatformRole(staff.platformRole) };
  }
  const token = await createSession(redis, session);
  await appendAudit(redis, session, "platform", "platform_staff.login", session.userId);
  return json({ user: safePlatformIdentity(session, email) }, 200, { "set-cookie": sessionCookie(token) });
}

async function superadminSession(redis, request) {
  const auth = await authenticate(redis, request);
  const staff = await platformStaffForAuth(redis, auth);
  if (staff && staff.status !== "active") return json({ authenticated: false, user: null }, 401);
  return json({ authenticated: auth?.role === "superadmin", user: safePlatformIdentity(auth, await platformIdentityEmail(redis, auth)) });
}

export async function currentUser(redis, request) {
  const auth = await authenticate(redis, request);
  if (!auth) return json({ user: null }, 401);
  if (auth.role === "superadmin") return json({ user: safePlatformIdentity(auth, await platformIdentityEmail(redis, auth)) });
  const user = await readAdminUserById(redis, auth.userId);
  return json({ user: user ? { id: user.id, email: user.email, name: user.name, role: user.role, boothCode: user.boothCode, hasRemotePassword: Boolean(user.passwordHash) } : null, booth: await resolveBooth(redis, auth.boothCode) });
}

async function listUsers(redis, request) {
  const auth = await authenticate(redis, request);
  if (!auth?.boothCode) return json({ error: "Login admin diperlukan" }, 401);
  const records = await listAdminUsers(redis, auth.boothCode);
  const users = [];
  for (const user of records) {
    if (!user) continue;
    users.push({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active: user.active,
      createdAt: user.createdAt,
      activeSessions: (await activeUserSessionIds(redis, user.id)).length,
      current: user.id === auth.userId,
      hasRemotePassword: Boolean(user.passwordHash),
    });
  }
  return json({ users });
}

export async function revokeUserSessions(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  if (!auth?.boothCode || !auth.userId) return json({ error: "Login admin diperlukan" }, 401);
  const targetUserId = String(payload.userId || auth.userId);
  const target = await redis.get(userKey(targetUserId));
  if (!target || target.boothCode !== auth.boothCode) return json({ error: "Pengguna tidak ditemukan pada photobox ini" }, 404);
  const revokingSelf = targetUserId === auth.userId;
  if (!revokingSelf && !["owner", "admin"].includes(auth.role)) return json({ error: "Akses pemilik/admin diperlukan" }, 403);
  if (!revokingSelf && target.role === "owner" && auth.role !== "owner") return json({ error: "Hanya pemilik yang dapat mencabut sesi pemilik" }, 403);

  const sessionIds = await activeUserSessionIds(redis, targetUserId);
  for (const id of sessionIds) await redis.del(sessionKey(id));
  if (sessionIds.length) await redis.srem(userSessionIndexKey(targetUserId), ...sessionIds);
  await appendAudit(redis, auth, auth.boothCode, "user.sessions_revoked", targetUserId, { count: sessionIds.length, self: revokingSelf });
  return json(
    { revoked: sessionIds.length, currentRevoked: revokingSelf && sessionIds.includes(auth.id) },
    200,
    revokingSelf ? { "set-cookie": clearCookie } : {},
  );
}

async function addUser(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (!auth?.boothCode || !["owner", "admin"].includes(auth.role)) return json({ error: "Akses pemilik/admin diperlukan" }, 403);
  const email = normalizeEmail(payload.email);
  if (!email || String(payload.password || "").length < 8 || !/^\d{6}$/.test(String(payload.pin || ""))) return json({ error: "Email, password minimal 8 karakter, dan PIN 6 angka wajib diisi" }, 400);
  if (await readAdminUserByEmail(redis, email)) return json({ error: "Email sudah digunakan" }, 409);
  const user = { id: randomId("user"), boothCode: auth.boothCode, machineId: auth.machineId, email, name: String(payload.name || "Operator").slice(0, 80), role: payload.role === "admin" ? "admin" : "operator", passwordHash: await hashCredential(payload.password), pinHash: await hashCredential(payload.pin), createdAt: now(), active: true };
  const persisted = await persistAdminUser(redis, user);
  if (!persisted.ok) return json({ error: "Pengguna belum dapat disimpan ke database", retryable: true }, 503);
  await appendAudit(redis, auth, auth.boothCode, "user.created", user.id, { role: user.role, email: user.email });
  return json({ user: { id: user.id, email, name: user.name, role: user.role, active: true } }, 201);
}

export async function updateProfile(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (!auth?.userId || auth.role === "superadmin") return json({ error: "Login pengguna diperlukan" }, 401);
  const user = await readAdminUserById(redis, auth.userId);
  if (!user) return json({ error: "Pengguna tidak ditemukan" }, 404);
  const changed = [];
  if (payload.email && normalizeEmail(payload.email) !== user.email) {
    const email = normalizeEmail(payload.email); if (await readAdminUserByEmail(redis, email)) return json({ error: "Email sudah digunakan" }, 409);
    await redisBestEffort(() => redis.del(`photoslive:email:${user.email}`)); await redisBestEffort(() => redis.set(`photoslive:email:${email}`, user.id)); user.email = email;
    changed.push("email");
  }
  if (payload.password) { if (String(payload.password).length < 8) return json({ error: "Password minimal 8 karakter" }, 400); user.passwordHash = await hashCredential(payload.password); changed.push("remote_password"); }
  if (payload.pin) { if (!/^\d{6}$/.test(String(payload.pin))) return json({ error: "PIN harus 6 angka" }, 400); user.pinHash = await hashCredential(payload.pin); }
  if (payload.pin) changed.push("local_pin");
  if (payload.name) { user.name = String(payload.name).slice(0, 80); changed.push("name"); }
  user.updatedAt = now(); await persistAdminUser(redis, user);
  await appendAudit(redis, auth, user.boothCode, "profile.updated", user.id, { changed: [...new Set(changed)] });
  return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, hasRemotePassword: Boolean(user.passwordHash) } });
}

export async function forgotPassword(redis, payload) {
  const email = normalizeEmail(payload.email);
  const user = await readAdminUserByEmail(redis, email);
  if (!user) return json({ error: "Email tidak terdaftar, permintaan ditolak" }, 404);
  const request = { id: randomId("reset"), userId: user.id, email, boothCode: user.boothCode, status: "pending", message: String(payload.message || "").slice(0, 500), createdAt: now() };
  await redis.set(`photoslive:reset:${request.id}`, request);
  await redis.sadd("photoslive:reset-requests", request.id);
  return json({ request: { id: request.id, status: request.status } }, 201);
}

async function indexedMachineIds(redis) {
  const ids = new Set(await redis.smembers("photoslive:machines"));
  let cursor = "0";
  let rounds = 0;
  // Backfill machines created by Agent versions that predate the global set.
  // SCAN is cursor-based and bounded so the superadmin page remains lightweight.
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: "photoslive:machine:machine_*", count: 100 });
    for (const key of keys) {
      const match = String(key).match(/^photoslive:machine:(machine_[^:]+)$/);
      if (match) ids.add(match[1]);
    }
    cursor = String(nextCursor);
    rounds += 1;
  } while (cursor !== "0" && rounds < 100);
  if (ids.size) await redis.sadd("photoslive:machines", ...ids);
  return [...ids];
}

export async function safeBoothMembers(redis, boothCode) {
  const ids = await redis.smembers(`photoslive:booth:${normalizeCode(boothCode)}:users`);
  const users = (await Promise.all(ids.slice(0, 500).map(id => redis.get(userKey(id))))).filter(Boolean);
  return users.map(user => ({
    id: String(user.id || ""),
    name: String(user.name || "").slice(0, 80),
    email: normalizeEmail(user.email),
    role: ["owner", "admin", "operator"].includes(user.role) ? user.role : "operator",
    active: user.active !== false,
    createdAt: user.createdAt || null,
  })).sort((a, b) => {
    const priority = { owner: 0, admin: 1, operator: 2 };
    return (priority[a.role] ?? 3) - (priority[b.role] ?? 3) || a.email.localeCompare(b.email);
  });
}

const TRANSFER_BOOTH_OWNERSHIP_SCRIPT = `
local currentRaw = redis.call("GET", KEYS[1])
local targetRaw = redis.call("GET", KEYS[2])
if not currentRaw or not targetRaw then return {err="MEMBER_MISSING"} end
local current = cjson.decode(currentRaw)
local target = cjson.decode(targetRaw)
if current.boothCode ~= ARGV[1] or target.boothCode ~= ARGV[1] then return {err="TENANT_MISMATCH"} end
if current.id ~= ARGV[2] or current.role ~= "owner" or current.active == false then return {err="OWNER_CHANGED"} end
if target.id ~= ARGV[3] or target.role == "owner" or target.active == false then return {err="TARGET_INVALID"} end
current.role = "admin"
current.updatedAt = ARGV[4]
target.role = "owner"
target.updatedAt = ARGV[4]
redis.call("SET", KEYS[1], cjson.encode(current))
redis.call("SET", KEYS[2], cjson.encode(target))
return {cjson.encode(current), cjson.encode(target)}
`;

async function revokeIndexedSessions(redis, userId) {
  const sessions = await activeUserSessionIds(redis, userId);
  for (const id of sessions) await redis.del(sessionKey(id));
  if (sessions.length) await redis.srem(userSessionIndexKey(userId), ...sessions);
  return sessions.length;
}

export async function transferBoothOwnership(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.ownership.write")) return json({ error: "Hanya Platform Owner yang dapat mentransfer kepemilikan" }, 403);
  if (request.method !== "POST") return json({ error: "Metode transfer kepemilikan tidak didukung" }, 405);
  if (!await verifyPlatformReauthentication(redis, auth, payload.reauthPassword)) return json({ error: "Konfirmasi password Anda tidak valid" }, 401);
  const boothCode = normalizeCode(payload.boothCode);
  const targetUserId = String(payload.targetUserId || "").trim();
  if (!boothCode || !targetUserId) return json({ error: "Photobox dan pemilik baru wajib dipilih" }, 400);
  if (String(payload.confirmation || "").trim().toLowerCase() !== boothCode) return json({ error: `Ketik ${boothCode} untuk mengonfirmasi transfer` }, 400);
  const booth = await resolveBooth(redis, boothCode);
  if (!booth) return json({ error: "Photobox tidak ditemukan" }, 404);
  const members = await safeBoothMembers(redis, boothCode);
  const owners = members.filter(member => member.role === "owner" && member.active);
  if (owners.length !== 1) return json({ error: "Transfer dihentikan karena photobox tidak memiliki tepat satu owner aktif" }, 409);
  const currentOwner = owners[0];
  const target = members.find(member => member.id === targetUserId);
  if (!target || !target.active || target.role === "owner") return json({ error: "Pemilik baru harus merupakan pengguna aktif pada photobox ini" }, 409);

  const timestamp = now();
  let swapped;
  try {
    swapped = await redis.eval(
      TRANSFER_BOOTH_OWNERSHIP_SCRIPT,
      [userKey(currentOwner.id), userKey(target.id)],
      [boothCode, currentOwner.id, target.id, timestamp],
    );
  } catch (error) {
    const code = String(error?.message || error);
    if (/OWNER_CHANGED|TARGET_INVALID|MEMBER_MISSING|TENANT_MISMATCH/.test(code)) return json({ error: "Membership berubah saat transfer. Perbarui halaman lalu coba lagi." }, 409);
    throw error;
  }
  if (!Array.isArray(swapped) || swapped.length !== 2) throw new Error("Transaksi transfer kepemilikan tidak mengembalikan hasil yang valid");
  const previousRecord = typeof swapped[0] === "string" ? JSON.parse(swapped[0]) : swapped[0];
  const nextRecord = typeof swapped[1] === "string" ? JSON.parse(swapped[1]) : swapped[1];
  const [previousSessionsRevoked, newOwnerSessionsRevoked] = await Promise.all([
    revokeIndexedSessions(redis, currentOwner.id),
    revokeIndexedSessions(redis, target.id),
  ]);
  await appendAudit(redis, auth, boothCode, "booth.ownership_transferred", target.id, {
    previousOwnerId: currentOwner.id,
    newOwnerId: target.id,
    previousSessionsRevoked,
    newOwnerSessionsRevoked,
  });
  const notifications = await Promise.allSettled([
    enqueueEmail(redis, {
      template: "system_alert", to: previousRecord.email, boothCode,
      businessKey: `ownership:${boothCode}:${timestamp}:previous`,
      data: { boothName: booth.name, title: "Kepemilikan photobox dipindahkan", message: `${nextRecord.name || nextRecord.email} sekarang menjadi owner. Akun Anda berubah menjadi Admin dan seluruh sesi lama telah dihentikan.` },
    }),
    enqueueEmail(redis, {
      template: "system_alert", to: nextRecord.email, boothCode,
      businessKey: `ownership:${boothCode}:${timestamp}:new`,
      data: { boothName: booth.name, title: "Anda sekarang menjadi owner", message: `Kepemilikan ${booth.name} telah dipindahkan kepada Anda. Masuk kembali untuk memuat izin terbaru.` },
    }),
  ]);
  return json({
    previousOwner: { id: previousRecord.id, name: previousRecord.name, email: previousRecord.email, role: previousRecord.role },
    newOwner: { id: nextRecord.id, name: nextRecord.name, email: nextRecord.email, role: nextRecord.role },
    sessionsRevoked: previousSessionsRevoked + newOwnerSessionsRevoked,
    notificationsQueued: notifications.filter(result => result.status === "fulfilled").length,
  });
}

async function listPlatformStaff(redis) {
  const ids = (await redis.smembers(platformStaffIndexKey)).slice(0, 250);
  const records = (await Promise.all(ids.map(id => redis.get(platformStaffKey(id))))).filter(Boolean);
  return records.map(safePlatformStaff).sort((a, b) => a.email.localeCompare(b.email));
}

export async function activatePlatformStaff(redis, payload = {}) {
  const email = normalizeEmail(payload.email);
  const token = String(payload.token || "").trim();
  const password = String(payload.password || "");
  if (!email || token.length < 48) return json({ error: "Tautan undangan tidak valid" }, 400);
  if (password.length < 12 || password.length > 200) return json({ error: "Password harus 12–200 karakter" }, 400);
  const staffId = await redis.get(platformStaffEmailKey(email));
  const staff = staffId ? await redis.get(platformStaffKey(staffId)) : null;
  if (!staff || staff.status !== "invited" || !staff.inviteHash || Date.parse(staff.inviteExpiresAt || 0) <= Date.now()) return json({ error: "Undangan tidak ditemukan atau sudah kedaluwarsa" }, 410);
  if (await sha256(token) !== staff.inviteHash) return json({ error: "Tautan undangan tidak valid" }, 401);
  staff.passwordHash = await hashCredential(password);
  staff.status = "active";
  staff.activatedAt = now();
  staff.updatedAt = staff.activatedAt;
  delete staff.inviteHash;
  await redis.set(platformStaffKey(staff.id), staff);
  await appendAudit(redis, { userId: staff.id, role: "superadmin", platformRole: staff.platformRole }, "platform", "platform_staff.activated", staff.id);
  return json({ user: safePlatformStaff(staff) });
}

export async function platformStaffControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.staff.read" : "platform.staff.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses tim platform ditolak" }, 403);
  if (request.method === "GET") return json({ staff: await listPlatformStaff(redis), permissions: { canManage: hasPlatformPermission(auth, "platform.staff.write") } });
  if (request.method !== "POST") return json({ error: "Metode tim platform tidak didukung" }, 405);
  if (!await verifyPlatformReauthentication(redis, auth, payload.reauthPassword)) return json({ error: "Konfirmasi password Anda tidak valid" }, 401);
  const operation = String(payload.operation || "").toLowerCase();
  if (operation === "invite") {
    const email = normalizeEmail(payload.email);
    const name = String(payload.name || "").trim().slice(0, 80);
    const platformRole = String(payload.platformRole || "").trim().toLowerCase();
    if (!email || !name) return json({ error: "Nama dan email wajib diisi" }, 400);
    if (!PLATFORM_ROLES.includes(platformRole)) return json({ error: "Role tim platform tidak valid" }, 400);
    const existingId = await redis.get(platformStaffEmailKey(email));
    if (existingId) return json({ error: "Email sudah menjadi anggota tim platform" }, 409);
    const id = randomId("staff");
    const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const record = { id, name, email, platformRole, status: "invited", inviteHash: await sha256(token), invitedAt: now(), inviteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), invitedBy: auth.userId, updatedAt: now() };
    const pipeline = redis.pipeline();
    pipeline.set(platformStaffKey(id), record);
    pipeline.set(platformStaffEmailKey(email), id);
    pipeline.sadd(platformStaffIndexKey, id);
    await pipeline.exec();
    await appendAudit(redis, auth, "platform", "platform_staff.invited", id, { email, platformRole });
    const origin = new URL(request.url).origin;
    const activationUrl = `${origin}/superadmin?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    let invitationEmail = null;
    try {
      invitationEmail = await enqueueEmail(redis, {
        template: "platform_invitation", to: email, businessKey: `platform-invite:${id}:${record.invitedAt}`,
        data: { recipientName: name, inviteExpiresAt: record.inviteExpiresAt }, sensitiveData: { activationUrl },
      });
    } catch (error) {
      await appendAudit(redis, auth, "platform", "platform_staff.invitation_email_failed", id, { reason: String(error?.message || error).slice(0, 240) });
    }
    return json({ user: safePlatformStaff(record), activationUrl, invitationEmailQueued: Boolean(invitationEmail), invitationEmail: invitationEmail || null }, 201);
  }
  const staffId = String(payload.staffId || "").trim();
  const staff = staffId ? await redis.get(platformStaffKey(staffId)) : null;
  if (!staff) return json({ error: "Anggota tim platform tidak ditemukan" }, 404);
  if (staff.id === auth.userId && ["suspend", "revoke"].includes(operation)) return json({ error: "Anda tidak dapat menonaktifkan akun yang sedang digunakan" }, 409);
  if (operation === "set_role") {
    const platformRole = String(payload.platformRole || "").trim().toLowerCase();
    if (!PLATFORM_ROLES.includes(platformRole)) return json({ error: "Role tim platform tidak valid" }, 400);
    staff.platformRole = platformRole;
    staff.updatedAt = now();
    await redis.set(platformStaffKey(staff.id), staff);
    const sessions = await activeUserSessionIds(redis, staff.id);
    for (const id of sessions) await redis.del(sessionKey(id));
    if (sessions.length) await redis.srem(userSessionIndexKey(staff.id), ...sessions);
    await appendAudit(redis, auth, "platform", "platform_staff.role_updated", staff.id, { platformRole: staff.platformRole, sessionsRevoked: sessions.length });
    return json({ user: safePlatformStaff(staff), sessionsRevoked: sessions.length });
  }
  if (["suspend", "activate"].includes(operation)) {
    if (operation === "activate" && !staff.passwordHash) return json({ error: "Akun undangan harus diaktivasi melalui tautan terlebih dahulu" }, 409);
    staff.status = operation === "suspend" ? "suspended" : "active";
    staff.updatedAt = now();
    await redis.set(platformStaffKey(staff.id), staff);
    let revoked = 0;
    if (operation === "suspend") {
      const sessions = await activeUserSessionIds(redis, staff.id); revoked = sessions.length;
      for (const id of sessions) await redis.del(sessionKey(id));
      if (sessions.length) await redis.srem(userSessionIndexKey(staff.id), ...sessions);
    }
    await appendAudit(redis, auth, "platform", `platform_staff.${staff.status}`, staff.id, { sessionsRevoked: revoked });
    return json({ user: safePlatformStaff(staff), sessionsRevoked: revoked });
  }
  if (operation === "revoke_sessions") {
    const sessions = await activeUserSessionIds(redis, staff.id);
    for (const id of sessions) await redis.del(sessionKey(id));
    if (sessions.length) await redis.srem(userSessionIndexKey(staff.id), ...sessions);
    await appendAudit(redis, auth, "platform", "platform_staff.sessions_revoked", staff.id, { count: sessions.length });
    return json({ user: safePlatformStaff(staff), sessionsRevoked: sessions.length });
  }
  if (operation === "revoke") {
    const sessions = await activeUserSessionIds(redis, staff.id);
    for (const id of sessions) await redis.del(sessionKey(id));
    if (sessions.length) await redis.srem(userSessionIndexKey(staff.id), ...sessions);
    staff.status = "revoked"; staff.updatedAt = now(); delete staff.passwordHash; delete staff.inviteHash;
    await redis.set(platformStaffKey(staff.id), staff);
    await redis.del(platformStaffEmailKey(staff.email));
    await appendAudit(redis, auth, "platform", "platform_staff.revoked", staff.id, { sessionsRevoked: sessions.length });
    return json({ user: safePlatformStaff(staff), sessionsRevoked: sessions.length });
  }
  return json({ error: "Operasi tim platform tidak dikenal" }, 400);
}

async function superadminOverview(redis, request) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.overview.read")) return json({ error: "Akses superadmin diperlukan" }, 403);
  const machineIds = await indexedMachineIds(redis);
  const machines = [];
  for (const id of machineIds) {
    const machine = await redis.get(machineKey(id));
    if (!machine) continue;
    const boothCode = normalizeCode(machine.boothCode || `pl-${id.replace(/^machine_/, "").slice(0, 8)}`);
    if (machine.boothCode !== boothCode) { machine.boothCode = boothCode; await redis.set(machineKey(id), machine); await redis.set(boothKey(boothCode), id); }
    machines.push({ ...(await resolveBooth(redis, boothCode)), members: await safeBoothMembers(redis, boothCode) });
  }
  const requestIds = await redis.smembers("photoslive:reset-requests");
  const resets = (await Promise.all(requestIds.map(id => redis.get(`photoslive:reset:${id}`)))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ machines, resetRequests: resets });
}

export async function platformFrameLibraryControl(redis, request, payload, correlationId = "") {
  const auth = await authenticate(redis, request);
  const isPlatformReader = hasPlatformPermission(auth, "platform.integrations.read");
  const isBoothAdmin = Boolean(auth?.boothCode && ["owner", "admin", "operator"].includes(String(auth.role || "").toLowerCase()));
  if (!isPlatformReader && !isBoothAdmin) return json({ error: "Login admin diperlukan untuk membuka perpustakaan frame" }, 403);

  if (request.method === "GET") {
    return json({ frames: (await platformFrameRecords(redis)).map(safePlatformFrame), canUpload: hasPlatformPermission(auth, "platform.integrations.write") });
  }
  if (!hasPlatformPermission(auth, "platform.integrations.write")) return json({ error: "Hanya superadmin integrasi yang dapat mengubah perpustakaan frame" }, 403);

  const operation = String(payload.operation || "").toLowerCase();
  if (request.method === "POST" && operation === "prepare") {
    const filename = String(payload.filename || "frame.webp").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
    const contentType = String(payload.contentType || "application/octet-stream").toLowerCase().slice(0, 100);
    const size = Number(payload.size || 0);
    const checksumSha256 = String(payload.checksumSha256 || "").toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(contentType)) return json({ error: "Frame harus berformat JPEG, PNG, atau WebP" }, 415);
    if (!Number.isSafeInteger(size) || size < 1 || size > 25_000_000) return json({ error: "Ukuran frame maksimal 25 MB" }, 413);
    if (!/^[a-f0-9]{64}$/.test(checksumSha256)) return json({ error: "Checksum SHA-256 frame tidak valid" }, 400);
    const runtime = await resolveProviderRuntimeForCapability(redis, "cloudStorage", {});
    if (!runtime) return json({ error: "Object storage global belum dikonfigurasi. Hubungkan R2 atau S3-compatible di Koneksi provider." }, 409);
    const id = randomId("platform-frame");
    const uploadId = randomId("platform-frame-upload");
    const objectKey = `platform/frame-library/${id}-${filename}`;
    const upload = await presignObjectRequest({ method: "PUT", objectKey, contentType, checksumSha256, expiresIn: 600, environment: runtime.environment });
    if (!upload) return json({ error: "Object storage global tidak tersedia" }, 409);
    await redis.set(platformFrameUploadIntentKey(uploadId), { id, uploadId, filename, contentType, size, checksumSha256, objectKey, provider: upload.provider, actorId: auth.userId, createdAt: now() }, { ex: 900 });
    return json({ uploadId, upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt }, maxFileBytes: 25_000_000 }, 201);
  }

  if (request.method === "POST" && operation === "finalize") {
    const uploadId = String(payload.uploadId || "");
    const intent = uploadId ? await redis.get(platformFrameUploadIntentKey(uploadId)) : null;
    if (!intent) return json({ error: "Upload frame sudah kedaluwarsa atau tidak ditemukan" }, 404);
    if (intent.actorId !== auth.userId) return json({ error: "Upload frame dimiliki sesi superadmin lain" }, 403);
    const runtime = await resolveProviderRuntime(redis, intent.provider, {});
    if (!runtime) return json({ error: "Provider penyimpanan upload tidak lagi tersedia" }, 409);
    const object = await inspectObject({ objectKey: intent.objectKey, environment: runtime.environment });
    if (!object || object.size !== intent.size || String(object.checksumSha256 || "").toLowerCase() !== intent.checksumSha256) {
      await deleteObject({ objectKey: intent.objectKey, environment: runtime.environment }).catch(() => false);
      await redis.del(platformFrameUploadIntentKey(uploadId));
      return json({ error: object?.size !== intent.size ? "Ukuran frame hasil upload tidak cocok" : "Checksum frame hasil upload tidak cocok" }, 422);
    }
    const record = { id: intent.id, name: intent.filename, contentType: intent.contentType, size: intent.size, checksumSha256: intent.checksumSha256, objectKey: intent.objectKey, storageProvider: object.provider, etag: object.etag, createdAt: now(), createdBy: auth.userId };
    await redis.set(platformFrameKey(record.id), record);
    await redis.sadd(platformFrameIndexKey, record.id);
    await redis.del(platformFrameUploadIntentKey(uploadId));
    await Promise.all([
      writePostgresShadowEvent({ entityType: "asset", legacyKey: `platform:frame:${record.id}`, operation: "upsert", idempotencyKey: `platform-frame:${record.id}:created`, correlationId: correlationId || randomId("corr"), payload: { ...record, objectKey: record.objectKey } }),
      appendAudit(redis, auth, "platform", "platform_frame.created", record.id, { filename: record.name, size: record.size }, correlationId),
    ]);
    return json({ frame: safePlatformFrame(record) }, 201);
  }

  if (request.method === "DELETE") {
    const id = String(payload.id || "");
    const record = id ? await redis.get(platformFrameKey(id)) : null;
    if (!record) return json({ error: "Frame global tidak ditemukan" }, 404);
    const runtime = await resolveProviderRuntime(redis, record.storageProvider, {});
    if (runtime && record.objectKey) await deleteObject({ objectKey: record.objectKey, environment: runtime.environment });
    await redis.del(platformFrameKey(id));
    await redis.srem(platformFrameIndexKey, id);
    await Promise.all([
      writePostgresShadowEvent({ entityType: "asset", legacyKey: `platform:frame:${id}`, operation: "delete", idempotencyKey: `platform-frame:${id}:deleted`, correlationId: correlationId || randomId("corr"), payload: { id, kind: "frame", scope: "platform" } }),
      appendAudit(redis, auth, "platform", "platform_frame.deleted", id, { filename: record.name }, correlationId),
    ]);
    return json({ deleted: true });
  }
  return json({ error: "Operasi perpustakaan frame tidak dikenal" }, 400);
}

export async function platformFrameDownload(redis, request, payload) {
  const auth = await authenticate(redis, request);
  const allowed = hasPlatformPermission(auth, "platform.integrations.read") || Boolean(auth?.boothCode && ["owner", "admin", "operator"].includes(String(auth.role || "").toLowerCase()));
  if (!allowed) return json({ error: "Login admin diperlukan untuk mengunduh frame" }, 403);
  const record = await redis.get(platformFrameKey(String(payload.id || "")));
  if (!record?.objectKey) return json({ error: "Frame global tidak ditemukan" }, 404);
  const runtime = await resolveProviderRuntime(redis, record.storageProvider, {});
  if (!runtime) return json({ error: "Provider penyimpanan frame tidak tersedia" }, 503);
  const filename = String(record.name || "frame").replace(/[^a-zA-Z0-9._-]/g, "-");
  const queryParameters = payload.download === "1" ? { "response-content-disposition": `attachment; filename=\"${filename}\"` } : {};
  const signed = await presignObjectRequest({ method: "GET", objectKey: record.objectKey, queryParameters, expiresIn: 300, environment: runtime.environment });
  if (!signed) return json({ error: "Frame belum dapat diunduh" }, 503);
  if (payload.download === "1") await appendAudit(redis, auth, auth.boothCode || "platform", "platform_frame.downloaded", record.id, { filename: record.name }, "");
  return new Response(null, { status: 302, headers: { location: signed.url, "cache-control": "private, no-store" } });
}

async function rawMachines(redis) {
  const machineIds = await indexedMachineIds(redis);
  return (await Promise.all(machineIds.map(id => redis.get(machineKey(id))))).filter(Boolean);
}

export async function fleetHealthControl(redis, request, payload) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.fleet.read" : "platform.fleet.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses superadmin fleet ditolak" }, 403);
  if (request.method === "GET") return json(await evaluateFleetHealth(redis, await rawMachines(redis)));
  if (request.method === "POST") {
    const result = await acknowledgeFleetIncident(redis, payload.incidentId, auth.userId);
    if (!result) return json({ error: "Insiden tidak ditemukan" }, 404);
    const { incident, changed } = result;
    if (changed) await appendAudit(redis, auth, incident.boothCode || "platform", "fleet.incident_acknowledged", incident.id, { machineId: incident.machineId, type: incident.type });
    return json({ incident });
  }
  return json({ error: "Metode fleet health tidak didukung" }, 405);
}

export async function alertRoutingControl(redis, request, payload) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.fleet.read" : "platform.fleet.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses routing alert ditolak" }, 403);
  if (request.method === "GET") {
    const deliveries = await listAlertDeliveries(redis, payload.limit || 100);
    return json({ checkedAt: now(), summary: {
      queued: deliveries.filter(item => ["queued", "retry", "waiting_configuration"].includes(item.status)).length,
      delivered: deliveries.filter(item => item.status === "delivered").length,
      failed: deliveries.filter(item => item.status === "failed").length,
    }, deliveries });
  }
  if (request.method === "POST") {
    const operation = String(payload.operation || "process");
    if (operation === "process") {
      const result = await processAlertDeliveries(redis, { limit: payload.limit || 10 });
      if (result.processed) await appendAudit(redis, auth, "platform", "alert_delivery.processed", "alert-routing", result);
      return json({ result, deliveries: await listAlertDeliveries(redis, 100) });
    }
    if (operation === "retry") {
      const delivery = await retryAlertDelivery(redis, payload.deliveryId, auth.userId);
      if (!delivery) return json({ error: "Delivery alert tidak ditemukan" }, 404);
      await appendAudit(redis, auth, delivery.boothCode || "platform", "alert_delivery.retry_requested", delivery.id, { incidentId: delivery.incidentId, eventType: delivery.eventType });
      return json({ delivery });
    }
    return json({ error: "Operasi routing alert tidak dikenal" }, 400);
  }
  return json({ error: "Metode routing alert tidak didukung" }, 405);
}

export async function telemetryHistoryControl(redis, request, payload = {}) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.fleet.read")) return json({ error: "Akses histori telemetry ditolak" }, 403);
  if (request.method !== "GET") return json({ error: "Histori telemetry hanya dapat dibaca" }, 405);
  const machineId = String(payload.machineId || "").trim().slice(0, 160);
  if (!machineId) return json({ error: "Pilih photobox terlebih dahulu" }, 400);
  if (!/^[a-zA-Z0-9_-]+$/.test(machineId)) return json({ error: "ID photobox tidak valid" }, 400);
  const machine = await redis.get(machineKey(machineId));
  if (!machine) return json({ error: "Photobox tidak ditemukan" }, 404);
  const result = await listTelemetryHistory(redis, machineId, { hours: payload.hours, limit: payload.limit });
  return json({ ...result, machine: { machineId, boothCode: machine.boothCode || "", name: machine.name || "Photoslive Booth" } });
}

async function featureFlagTargetExists(redis, scope, targetId) {
  if (scope === "global") return true;
  if (scope === "booth") return Boolean(await resolveBooth(redis, targetId));
  const machineIds = await indexedMachineIds(redis);
  for (const id of machineIds) {
    const machine = await redis.get(machineKey(id));
    if (String(machine?.organizationId || "").toLowerCase() === String(targetId || "").toLowerCase()) return true;
  }
  return false;
}

async function featureFlagsControl(redis, request, payload) {
  const auth = await authenticate(redis, request);
  const permission = request.method === "GET" ? "platform.flags.read" : "platform.flags.write";
  if (!hasPlatformPermission(auth, permission)) return json({ error: "Akses feature flag ditolak" }, 403);
  if (request.method === "GET") {
    const booth = payload.boothCode ? await resolveBooth(redis, payload.boothCode) : null;
    const [overrides, effective] = await Promise.all([
      listFeatureFlagOverrides(redis),
      resolveFeatureFlags(redis, { boothCode: booth?.boothCode || "", organizationId: payload.organizationId || booth?.organizationId || "" }),
    ]);
    return json({ definitions: FEATURE_FLAG_DEFINITIONS, overrides, effective });
  }
  const scope = String(payload.scope || "").toLowerCase();
  const targetId = scope === "global" ? "" : String(payload.targetId || "").toLowerCase();
  if (!await featureFlagTargetExists(redis, scope, targetId)) return json({ error: "Target feature flag tidak ditemukan" }, 404);
  try {
    if (request.method === "POST") {
      const record = await setFeatureFlagOverride(redis, { key: payload.key, scope, targetId, enabled: payload.enabled, config: payload.config }, auth.userId);
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", "feature_flag.updated", record.id, { key: record.key, scope: record.scope, targetId: record.targetId, enabled: record.enabled });
      return json({ record }, 201);
    }
    if (request.method === "DELETE") {
      const record = await deleteFeatureFlagOverride(redis, { key: payload.key, scope, targetId });
      if (!record) return json({ error: "Override feature flag tidak ditemukan" }, 404);
      await appendAudit(redis, auth, scope === "booth" ? targetId : "platform", "feature_flag.deleted", record.id, { key: record.key, scope: record.scope, targetId: record.targetId });
      return json({ deleted: true });
    }
  } catch (error) {
    return json({ error: error.message }, 400);
  }
  return json({ error: "Metode feature flag tidak didukung" }, 405);
}

export async function toggleMachine(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.access.write")) return json({ error: "Akses superadmin untuk perubahan photobox ditolak" }, 403);
  const machine = await redis.get(machineKey(String(payload.machineId || "")));
  if (!machine) return json({ error: "Mesin tidak ditemukan" }, 404);
  const enabled = Boolean(payload.enabled);
  const directoryStatus = postgresDirectoryStatus();
  if (directoryStatus.primary) {
    const persisted = await updatePostgresBoothAccess(machine.boothCode, enabled);
    if (!persisted.ok) return json({
      error: "Status akses belum dapat disimpan ke database. Tidak ada perubahan yang diterapkan; coba lagi.",
      retryable: true,
    }, 503);
  }
  machine.accessEnabled = enabled;
  machine.updatedAt = now();
  await redis.set(machineKey(machine.id), machine);
  if (directoryStatus.mode === "dual") await updatePostgresBoothAccess(machine.boothCode, enabled);
  await appendAudit(redis, auth, machine.boothCode, machine.accessEnabled ? "booth.enabled" : "booth.disabled", machine.id);
  return json({ booth: await resolveBooth(redis, machine.boothCode) });
}

export async function resolveResetRequest(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (!hasPlatformPermission(auth, "platform.recovery.write")) return json({ error: "Akses pemulihan ditolak" }, 403);
  const key = `photoslive:reset:${String(payload.requestId || "")}`;
  const reset = await redis.get(key);
  if (!reset) return json({ error: "Permintaan tidak ditemukan" }, 404);
  reset.status = "email_sent";
  reset.resolvedAt = now();
  reset.note = String(payload.note || "Email pemulihan dikirim manual").slice(0, 500);
  await redis.set(key, reset);
  await appendAudit(redis, auth, reset.boothCode, "password_recovery.resolved", reset.id);
  return json({ request: reset });
}

async function registerPhotoSession(redis, request, payload) {
  if (!await scopedBoothAccess(request, payload, "booth.hardware")) return json({ error: "Token sesi photobox tidak valid atau sudah kedaluwarsa" }, 401);
  const booth = await resolveBooth(redis, payload.boothCode);
  if (!booth || booth.machineId !== payload.machineId || !booth.enabled) return json({ error: "Photobox tidak valid" }, 403);
  const shareCode = normalizePublicSessionCode(payload.shareCode);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const previous = await redis.get(publicSessionKey(booth.boothCode, shareCode));
  const allowedStatuses = new Set(["active", "completed", "cancelled", "sync_pending"]);
  const requestedStatus = String(payload.status || previous?.status || "active");
  const status = allowedStatuses.has(requestedStatus) ? requestedStatus : "active";
  const record = { ...previous, boothCode: booth.boothCode, machineId: booth.machineId, shareCode, localSessionId: String(payload.localSessionId || previous?.localSessionId || "").slice(0, 160), status, frameId: String(payload.frameId || previous?.frameId || "").slice(0, 160), photoSlots: Math.max(1, Math.min(8, Number(payload.photoSlots || previous?.photoSlots || 1))), files: Array.isArray(previous?.files) ? previous.files : [], createdAt: payload.createdAt || previous?.createdAt || now(), completedAt: status === "completed" ? payload.completedAt || previous?.completedAt || now() : previous?.completedAt || null, expiresAt: previous?.expiresAt || new Date(Date.now() + PUBLIC_SESSION_TTL_SECONDS * 1000).toISOString(), updatedAt: now() };
  const ttl = publicSessionRemainingTtl(record);
  if (!ttl) return json({ error: "Sesi sudah kedaluwarsa" }, 404);
  const postgresStatus = postgresSessionStatus();
  if (postgresStatus.primary) {
    const persisted = await persistPostgresSession(record);
    if (!persisted.ok) return json({ error: "Metadata sesi belum dapat disimpan ke cloud. Foto lokal tetap aman dan sinkronisasi dapat dicoba lagi.", retryable: true }, 503);
  }
  await redis.set(publicSessionKey(booth.boothCode, shareCode), record, { ex: ttl });
  await trackPublicSessionRetention(redis, record);
  if (postgresStatus.mode === "dual") await persistPostgresSession(record);
  return json({ session: publicSessionProjection(record), url: `/${booth.boothCode}/sesi/${shareCode}` }, 201);
}

async function uploadPhotoSessionFile(redis, request, payload) {
  if (!await scopedBoothAccess(request, payload, "booth.hardware")) return json({ error: "Token sesi photobox tidak valid atau sudah kedaluwarsa" }, 401);
  const boothCode = normalizeCode(payload.boothCode);
  const shareCode = normalizePublicSessionCode(payload.shareCode);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const fileKind = new Set(["capture", "composite", "gif"]).has(String(payload.fileKind || "capture")) ? String(payload.fileKind || "capture") : "capture";
  const slotIndex = fileKind === "capture" ? Math.max(1, Math.min(8, Number(payload.slotIndex || 1))) : 0;
  const fileId = String(payload.fileId || `${fileKind}-${slotIndex}`).replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160);
  if (!fileId) return json({ error: "ID file sesi tidak valid" }, 400);
  const record = await redis.get(publicSessionKey(boothCode, shareCode));
  if (!record || Date.parse(record.expiresAt) <= Date.now()) return json({ error: "Sesi tidak ditemukan atau sudah kedaluwarsa" }, 404);
  if (!payload.machineId || payload.machineId !== record.machineId) return json({ error: "Mesin pengunggah tidak sesuai dengan sesi" }, 403);
  const contentType = String(payload.contentType || "image/jpeg").toLowerCase();
  if (!new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]).has(contentType)) return json({ error: "Format foto tidak didukung" }, 415);
  const bodyBase64 = String(payload.bodyBase64 || "");
  let bytes;
  try { bytes = Uint8Array.from(atob(bodyBase64), character => character.charCodeAt(0)); } catch { return json({ error: "File sesi bukan Base64 yang valid" }, 400); }
  // Endpoint kompatibilitas ini masih membawa Base64 melalui Vercel. Upload
  // Agent production memakai prepare -> presigned PUT -> finalize di bridge.
  const maxFileBytes = 1_800_000;
  if (!bytes.byteLength || bytes.byteLength > maxFileBytes) return json({ error: `Foto cloud maksimal ${Math.round(maxFileBytes / 1_000_000)} MB` }, 413);
  const checksumSha256 = await sha256Bytes(bytes);
  if (payload.checksumSha256 && String(payload.checksumSha256).toLowerCase() !== checksumSha256) return json({ error: "Checksum foto tidak cocok" }, 422);
  const file = { id: fileId, kind: fileKind, slotIndex, contentType, size: bytes.byteLength, checksumSha256, url: `/api/platform?action=public_session_file&booth=${encodeURIComponent(boothCode)}&session=${encodeURIComponent(shareCode)}&file=${encodeURIComponent(fileId)}`, uploadedAt: now() };
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[contentType] || "bin";
  const objectKey = `sessions/${boothCode}/${shareCode}/${fileId}.${extension}`;
  const booth = await resolveBooth(redis, boothCode);
  const runtime = await storageRuntime(redis, booth || { boothCode });
  const stored = await putObject({ objectKey, bytes, contentType, checksumSha256, environment: runtime?.environment || process.env });
  const ttl = publicSessionRemainingTtl(record);
  if (!ttl) return json({ error: "Sesi tidak ditemukan atau sudah kedaluwarsa" }, 404);
  const storedRecord = stored ? { ...file, storageMode: "object-storage", storageProvider: stored.provider, objectKey, etag: stored.etag } : { ...file, storageMode: "legacy-redis", bodyBase64 };
  await redis.set(publicSessionFileKey(boothCode, shareCode, fileId), storedRecord, { ex: ttl });
  record.files = [...(record.files || []).filter(item => item.id !== fileId && !(fileKind === "capture" && (item.kind || "capture") === "capture" && Number(item.slotIndex) === slotIndex)), file]
    .sort((a, b) => Number(a.slotIndex || 0) - Number(b.slotIndex || 0));
  record.fileManifests = (record.fileManifests || []).filter(item => item.id !== fileId);
  if (stored?.objectKey) {
    record.fileManifests.push({ id: fileId, storageMode: "object-storage", storageProvider: stored.provider, objectKey: stored.objectKey, etag: stored.etag || "" });
  }
  const requestedStatus = String(payload.status || record.status || "completed");
  record.status = new Set(["active", "completed", "cancelled", "sync_pending"]).has(requestedStatus)
    ? requestedStatus
    : "completed";
  if (record.status === "completed") record.completedAt ||= now();
  record.updatedAt = now();
  await redis.set(publicSessionKey(boothCode, shareCode), record, { ex: ttl });
  await trackPublicSessionFileRetention(redis, record, storedRecord);
  const postgresStatus = postgresSessionStatus();
  if (postgresStatus.enabled) {
    const persisted = await persistPostgresSession(record);
    if (postgresStatus.primary && !persisted.ok) return json({ error: "Foto tersimpan, tetapi metadata cloud belum tersinkron. Coba sinkronisasi lagi.", retryable: true, stored: true, file }, 503);
  }
  return json({ file }, 201);
}

export async function deletePublicPhotoSession(redis, payload) {
  const boothCode = normalizeCode(payload.booth);
  const shareCode = normalizePublicSessionCode(payload.session);
  if (!boothCode || !shareCode) return json({ error: "Link sesi tidak valid" }, 404);
  if (String(payload.confirm || "").toLowerCase() !== "hapus") return json({ error: "Konfirmasi penghapusan tidak valid" }, 400);
  const record = await recoverPublicSession(redis, boothCode, shareCode);
  if (!record || record.boothCode !== boothCode) return json({ deleted: true, alreadyDeleted: true });
  try {
    const postgresStatus = postgresSessionStatus();
    if (postgresStatus.enabled) {
      const requested = await requestPostgresSessionDeletion(boothCode, shareCode);
      if (postgresStatus.primary && !requested.ok) return json({ error: "Permintaan hapus belum dapat dicatat ke cloud. Tidak ada foto yang dihapus; coba lagi.", retryable: true }, 503);
    }
    record.deletionRequested = true;
    record.deletionRequestedAt ||= now();
    await redis.set(publicSessionKey(boothCode, shareCode), record, { ex: publicSessionRemainingTtl(record) });
    let localDeletion = { status: "unavailable", jobId: null };
    const machine = record.machineId ? await redis.get(machineKey(record.machineId)) : null;
    if (machine?.paired) {
      const queued = await enqueueRemoteJob(redis, machine, {
        type: "privacy.delete_session",
        ttlSeconds: 7 * 86_400,
        idempotencyKey: `privacy-delete-${shareCode}`,
        payload: { shareCode },
      }, new Set(["privacy.delete_session"]), { allowDisabled: true, maxTtlSeconds: 7 * 86_400 });
      localDeletion = { status: "queued", jobId: queued.job.id };
    }
    const booth = await resolveBooth(redis, boothCode);
    const result = await deletePublicSessionArtifacts(redis, boothCode, shareCode, {
      deleteObjectImpl: async ({ objectKey, storageProvider }) => {
        const runtime = await storageRuntime(redis, booth || { boothCode }, storageProvider);
        return deleteObject({ objectKey, environment: runtime?.environment || process.env });
      },
    });
    if (postgresStatus.enabled) {
      const expired = await expirePostgresSession(boothCode, shareCode);
      if (postgresStatus.primary && !expired.ok) return json({ error: "Foto sudah dihapus, tetapi status cloud belum selesai. Coba lagi untuk menutup sesi.", retryable: true, deleted: true }, 503);
    }
    await appendAudit(redis, { userId: "customer-link", role: "customer" }, boothCode, "photo_session.deleted_by_customer", shareCode.slice(0, 8), {
      filesDeleted: result.filesDeleted,
      objectsDeleted: result.objectsDeleted,
      localDeletion,
    });
    return json({ ...result, localDeletion });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Foto belum dapat dihapus. Coba lagi." }, 503);
  }
}

export async function publicPhotoSessionFile(redis, payload) {
  const boothCode = normalizeCode(payload.booth);
  const shareCode = normalizePublicSessionCode(payload.session);
  if (!boothCode || !shareCode) return json({ error: "Link sesi tidak valid" }, 404);
  const session = await recoverPublicSession(redis, boothCode, shareCode);
  if (!session || session.boothCode !== boothCode || session.deletionRequested || session.deleted || publicSessionRemainingTtl(session) <= 0) {
    return json({ error: "Sesi tidak ditemukan atau sudah kedaluwarsa" }, 404);
  }
  const requestedFile = String(payload.file || "").replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160);
  const legacySlot = Math.max(1, Math.min(8, Number(payload.slot || 1)));
  const allowedFileIds = new Set((session.files || []).map(file => String(file.id || "")));
  if (requestedFile && !allowedFileIds.has(requestedFile)) return json({ error: "Foto belum tersedia" }, 404);
  let record = await redis.get(publicSessionFileKey(boothCode, shareCode, requestedFile || legacySlot));
  if (!record && requestedFile) record = await redis.get(publicSessionFileKey(boothCode, shareCode, legacySlot));
  if (!record && requestedFile) {
    const publicFile = (session.files || []).find(file => String(file.id || "") === requestedFile);
    const manifest = (session.fileManifests || []).find(item => String(item.id || "") === requestedFile);
    if (publicFile && manifest) record = { ...publicFile, ...manifest };
  }
  if (record?.objectKey) {
    const booth = await resolveBooth(redis, boothCode);
    const runtime = await storageRuntime(redis, booth || { boothCode }, record.storageProvider);
    const download = await presignObjectRequest({ method: "GET", objectKey: record.objectKey, expiresIn: 300, environment: runtime?.environment || process.env });
    if (!download) return json({ error: "Object storage tidak tersedia" }, 503);
    return new Response(null, { status: 302, headers: { location: download.url, "cache-control": "private, no-store" } });
  }
  if (!record?.bodyBase64) return json({ error: "Foto belum tersedia" }, 404);
  const bytes = Uint8Array.from(atob(record.bodyBase64), character => character.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": record.contentType, "content-length": String(bytes.byteLength), "cache-control": "private, max-age=3600" } });
}

export async function publicPhotoSession(redis, payload) {
  const boothCode = normalizeCode(payload.booth);
  const shareCode = normalizePublicSessionCode(payload.session);
  if (!boothCode || !shareCode) return json({ error: "Link sesi tidak valid" }, 404);
  const record = await recoverPublicSession(redis, boothCode, shareCode);
  if (!record || record.boothCode !== boothCode || record.deletionRequested || record.deleted || publicSessionRemainingTtl(record) <= 0) return json({ error: "Sesi tidak ditemukan atau sudah kedaluwarsa" }, 404);
  return json({ session: publicSessionProjection(record), booth: publicBoothProjection(await resolveBooth(redis, boothCode)) });
}

export async function withCloudIdempotency(redis, request, payload, operation) {
  const suppliedKey = String(request.headers.get("idempotency-key") || "").trim();
  if (!suppliedKey) return operation();
  const idempotencyKey = suppliedKey.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 160);
  if (idempotencyKey.length < 12) return json({ error: "Idempotency-Key tidak valid" }, 400);
  const boothCode = normalizeCode(payload.booth);
  const fingerprint = await sha256(JSON.stringify({ method: request.method, boothCode, path: payload.path || "", data: payload.data || null }));
  const cacheKey = `photoslive:idempotency:${boothCode}:${idempotencyKey}`;
  const lockKey = `${cacheKey}:lock`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    if (cached.fingerprint !== fingerprint) return json({ error: "Idempotency-Key sudah dipakai untuk request berbeda" }, 409);
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        "content-type": cached.contentType || "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-idempotency-replayed": "true",
      },
    });
  }
  const locked = await redis.set(lockKey, fingerprint, { nx: true, ex: 20 });
  if (!locked) return json({ error: "Request yang sama masih diproses" }, 409, { "retry-after": "1" });
  try {
    const response = await operation();
    if (response.ok) {
      await redis.set(cacheKey, {
        fingerprint,
        status: response.status,
        contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
        body: await response.clone().text(),
        createdAt: now(),
      }, { ex: 86_400 });
    }
    return response;
  } finally {
    await redis.del(lockKey);
  }
}

export async function xenditWebhookControl(redis, request, payload, correlationId = "") {
  if (request.method !== "POST") return json({ error: "Method tidak didukung" }, 405);
  const startedAt = performance.now();
  const providerEventId = request.headers.get("webhook-id") || "";
  const eventType = String(payload?.event || "unknown").slice(0, 100);
  try {
    const result = await processXenditWebhook(redis, request, payload, {
      paymentResolver: providerPaymentId => readPostgresPaymentByProviderId(providerPaymentId),
      runtimeResolver: async ({ boothCode, providerId, providerConnectionRef }) => {
        const booth = await resolveBooth(redis, boothCode);
        if (!booth) throw new Error("Photobox pembayaran tidak ditemukan");
        return providerConnectionRef
          ? resolveProviderRuntimeReference(redis, providerConnectionRef, providerContextForBooth(booth))
          : resolveProviderRuntime(redis, providerId, providerContextForBooth(booth));
      },
    });
    if (!result.duplicate) {
      const reconciliation = await getPaymentReconciliation(redis, result.payment.id);
      await Promise.all([
        writePostgresPaymentIntent(result.record),
        reconciliation ? writePostgresReconciliationJob(reconciliation) : Promise.resolve(),
        result.ledger ? appendPostgresLedgerEntry(result.ledger) : Promise.resolve(),
        result.refundRecord ? writePostgresRefund(result.refundRecord) : Promise.resolve(),
        writePostgresShadowEvent({
          entityType: "payment",
          legacyKey: `${result.payment.boothCode}:${result.payment.id}`,
          operation: "upsert",
          idempotencyKey: `payment:${result.payment.id}:${result.payment.status}:${result.payment.updatedAt}`,
          correlationId: correlationId || randomId("corr"),
          payload: result.payment,
        }),
        result.ledger ? writePostgresShadowEvent({
          entityType: "ledger",
          legacyKey: `${result.ledger.boothCode}:${result.ledger.id}`,
          operation: "upsert",
          idempotencyKey: `ledger:${result.ledger.id}`,
          correlationId: correlationId || randomId("corr"),
          payload: result.ledger,
        }) : Promise.resolve(),
        appendAudit(redis, { userId: "xendit-webhook", role: "system" }, result.payment.boothCode, "payment.status_updated", result.payment.id, {
          previousStatus: result.previousStatus,
          status: result.payment.status,
          provider: result.payment.provider,
          purpose: result.payment.purpose,
        }, correlationId),
      ]);
    }
    await appendWebhookEvent(redis, {
      provider: "xendit", providerEventId, eventType, boothCode: result.payment.boothCode,
      paymentId: result.payment.id, state: result.duplicate ? "duplicate" : "succeeded",
      duplicate: result.duplicate, httpStatus: 200, latencyMs: performance.now() - startedAt, correlationId,
    });
    return json({ received: true, duplicate: result.duplicate });
  } catch (error) {
    const httpStatus = Number(error?.status || 500);
    await appendWebhookEvent(redis, {
      provider: "xendit", providerEventId, eventType, state: "failed", httpStatus,
      latencyMs: performance.now() - startedAt, correlationId,
      error: error instanceof Error ? error.message : "Webhook pembayaran gagal",
    }).catch(() => {});
    return json({ error: error instanceof Error ? error.message : "Webhook pembayaran gagal" }, httpStatus);
  }
}

async function cloudData(redis, request, payload, correlationId = "") {
  const target = new URL(String(payload.path || "/"), "https://photoslive.local");
  const path = target.pathname;
  const booth = await resolveBooth(redis, payload.booth);
  if (!booth || !booth.enabled) return json({ error: "Photobox tidak ditemukan atau aksesnya dinonaktifkan" }, 404);

  if (request.method === "GET" && path === "/api/booth/config") {
    const [settings, assets, featureFlags] = await Promise.all([cloudSettings(redis, booth), cloudAssets(redis, booth.boothCode), resolveFeatureFlags(redis, booth)]);
    const capabilities = await deploymentCapabilitiesForBooth(redis, booth);
    return json({
      booth: settings.booth,
      appearance: settings.appearance,
      payment: { ...settings.payment, qrisEnabled: capabilities.qris.available && settings.payment.qrisEnabled, paidPrintEnabled: capabilities.qris.available && settings.payment.paidPrintEnabled },
      devices: settings.devices,
      storage: { ...settings.storage, cloudEnabled: capabilities.cloudStorage.available && settings.storage.cloudEnabled },
      assets,
      capabilities,
      featureFlags,
      bridgeToken: await signScopedToken({ scope: "booth.hardware", boothCode: booth.boothCode, machineId: booth.machineId, exp: Date.now() + 30 * 60_000 }),
    });
  }

  if (request.method === "POST" && path === "/api/vouchers/redeem") {
    const code = voucherCode(payload.data?.code);
    if (!code) return json({ error: "Masukkan kode voucher" }, 400);
    const postgresStatus = postgresVoucherStatus();
    const lockKey = `photoslive:booth:${booth.boothCode}:voucher-lock:${code}`;
    const locked = postgresStatus.primary ? true : await redis.set(lockKey, "1", { nx: true, ex: 8 });
    if (!locked) return json({ error: "Voucher sedang diperiksa. Coba sekali lagi." }, 409);
    try {
      let record = postgresStatus.primary ? null : await redis.get(voucherKey(booth.boothCode, code));
      if (!record && postgresStatus.primary) record = (await voucherRecords(redis, booth.boothCode)).find(item => item.code === code) || null;
      if (!record || record.redeemedAt) return json({ error: "Voucher tidak ditemukan atau sudah dipakai" }, 404);
      let event = !postgresStatus.primary && record.eventId ? await redis.get(voucherEventKey(booth.boothCode, record.eventId)) : null;
      if (!event && record.eventId && postgresStatus.primary) event = (await voucherEvents(redis, booth.boothCode)).find(item => item.id === record.eventId) || null;
      if (eventExpired(event)) return json({ error: "Voucher event sudah kedaluwarsa" }, 410);
      record.redeemedAt = now();
      let postgresResult = null;
      if (postgresStatus.primary) {
        postgresResult = await redeemPostgresVoucher({ boothCode: booth.boothCode, code, redeemedAt: record.redeemedAt });
        if (!postgresResult.ok) return json({ error: postgresResult.reason || "Voucher belum dapat dipakai" }, Number(postgresResult.status || 503));
      }
      if (postgresStatus.primary) {
        try {
          await redis.set(voucherKey(booth.boothCode, code), record);
          await redis.set(voucherVersionKey(booth.boothCode), postgresResult.version);
        } catch {
          // Redis cache only. PostgreSQL already completed the redemption.
        }
      } else {
        await redis.set(voucherKey(booth.boothCode, code), record);
        await redis.incr(voucherVersionKey(booth.boothCode));
        if (postgresStatus.mode === "dual") await redeemPostgresVoucher({ boothCode: booth.boothCode, code, redeemedAt: record.redeemedAt });
      }
      return json({ voucher: record });
    } finally {
      if (!postgresStatus.primary) await redis.del(lockKey);
    }
  }

  if (request.method === "POST" && path === "/api/booth/client") {
    const id = String(payload.clientId || randomId("client")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
    const record = { id, boothCode: booth.boothCode, ...payload.data, updatedAt: now() };
    await redis.set(`photoslive:booth:${booth.boothCode}:client:${id}`, record, { ex: 180 });
    await redis.sadd(`photoslive:booth:${booth.boothCode}:clients`, id);
    return json({ client: record }, 201);
  }

  if (request.method === "POST" && path === "/api/booth/qris") {
    const settings = await cloudSettings(redis, booth);
    const purpose = String(payload.data?.purpose || "session").toLowerCase();
    const enabled = purpose === "print" ? settings.payment.paidPrintEnabled : settings.payment.qrisEnabled;
    if (!enabled) return json({ error: purpose === "print" ? "Print berbayar sedang dinonaktifkan" : "Pembayaran QRIS sedang dinonaktifkan" }, 409);
    const paymentRate = await consumeRateLimit(redis, request, "qris_create", PLATFORM_RATE_LIMITS.qris_create, `${booth.boothCode}:${payload.clientId || "anonymous"}`);
    if (!paymentRate.allowed) return json(
      { error: `Terlalu banyak permintaan QRIS. Coba lagi dalam ${paymentRate.retryAfter} detik.`, retryAfter: paymentRate.retryAfter },
      429,
      { "retry-after": String(paymentRate.retryAfter), "x-ratelimit-limit": String(paymentRate.limit), "x-ratelimit-remaining": "0" },
    );
    const runtime = await resolveProviderRuntimeForCapability(redis, "qris", providerContextForBooth(booth));
    if (!runtime) return json({ error: "Xendit QRIS belum dikonfigurasi", capability: "qris" }, 409);
    const suppliedSessionId = String(payload.data?.sessionId || "");
    const clientId = String(payload.clientId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
    const sessionId = purpose === "session" && suppliedSessionId === "access"
      ? `access-${clientId || "booth"}`
      : suppliedSessionId;
    try {
      const feePolicy = await resolvePlatformFeePolicy(redis, booth.boothCode);
      const result = await createQrisPayment(redis, {
        boothCode: booth.boothCode,
        sessionId,
        purpose,
        amount: purpose === "print" ? Number(settings.payment.printPrice) : Number(settings.payment.price),
        currency: settings.payment.currency,
        platformFeeBps: feePolicy.platformFeeBps,
        providerConnectionRef: runtime.reference,
        idempotencyKey: request.headers.get("idempotency-key") || "",
      }, { environment: runtime.environment });
      if (!result.reused) {
        const reconciliation = await getPaymentReconciliation(redis, result.payment.id);
        await Promise.all([
          writePostgresPaymentIntent(result.record),
          reconciliation ? writePostgresReconciliationJob(reconciliation) : Promise.resolve(),
          writePostgresShadowEvent({
            entityType: "payment",
            legacyKey: `${booth.boothCode}:${result.payment.id}`,
            operation: "upsert",
            idempotencyKey: `payment:${result.payment.id}:created`,
            correlationId: correlationId || randomId("corr"),
            payload: result.payment,
          }),
          appendAudit(redis, { userId: "booth-customer", role: "customer" }, booth.boothCode, "payment.created", result.payment.id, {
            purpose: result.payment.purpose,
            amount: result.payment.amount,
            currency: result.payment.currency,
            provider: result.payment.provider,
          }, correlationId),
        ]);
      }
      return json({ payment: result.payment }, result.reused ? 200 : 201);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Pembayaran QRIS gagal" }, Number(error?.status || 502));
    }
  }

  const paymentStatusMatch = path.match(/^\/api\/booth\/payments\/([^/]+)$/);
  if (request.method === "GET" && paymentStatusMatch) {
    const payment = await getPayment(redis, paymentStatusMatch[1]);
    if (!payment || payment.boothCode !== booth.boothCode) return json({ error: "Pembayaran tidak ditemukan" }, 404);
    if (payment.status !== "pending") return json({ payment: safePayment(payment) });
    try {
      const runtime = payment.providerConnectionRef
        ? await resolveProviderRuntimeReference(redis, payment.providerConnectionRef, providerContextForBooth(booth))
        : await resolveProviderRuntimeForCapability(redis, "qris", providerContextForBooth(booth));
      if (!runtime) return json({ payment: safePayment(payment), providerState: "unavailable" });
      const refreshed = await refreshQrisPayment(redis, payment.id, { environment: runtime.environment });
      if (refreshed.status !== payment.status) {
        const ledger = refreshed.settlementLedgerId ? await getPaymentLedgerEntry(redis, refreshed.settlementLedgerId) : null;
        const reconciliation = await getPaymentReconciliation(redis, refreshed.id);
        await Promise.all([
          writePostgresPaymentIntent(refreshed),
          reconciliation ? writePostgresReconciliationJob(reconciliation) : Promise.resolve(),
          ledger ? appendPostgresLedgerEntry(ledger) : Promise.resolve(),
          writePostgresShadowEvent({
            entityType: "payment",
            legacyKey: `${refreshed.boothCode}:${refreshed.id}`,
            operation: "upsert",
            idempotencyKey: `payment:${refreshed.id}:${refreshed.status}:${refreshed.updatedAt}`,
            correlationId: correlationId || randomId("corr"),
            payload: safePayment(refreshed),
          }),
          ledger ? writePostgresShadowEvent({
            entityType: "ledger",
            legacyKey: `${ledger.boothCode}:${ledger.id}`,
            operation: "upsert",
            idempotencyKey: `ledger:${ledger.id}`,
            correlationId: correlationId || randomId("corr"),
            payload: ledger,
          }) : Promise.resolve(),
          appendAudit(redis, { userId: "xendit-status-poll", role: "system" }, refreshed.boothCode, "payment.status_updated", refreshed.id, {
            previousStatus: payment.status,
            status: refreshed.status,
            provider: refreshed.provider,
            purpose: refreshed.purpose,
          }, correlationId),
        ]);
      }
      return json({ payment: safePayment(refreshed) });
    } catch (error) {
      return json({ payment: safePayment(payment), providerState: "delayed", warning: "Status pembayaran belum dapat diperbarui. Sistem akan mencoba lagi." });
    }
  }

  const access = await requireBoothAdmin(redis, request, booth.boothCode);
  if (!access) return json({ error: "Login admin photobox diperlukan" }, 401);
  if (request.method !== "GET" && access.auth.role === "operator" && (path.startsWith("/api/settings/payment") || path.startsWith("/api/vouchers") || path.startsWith("/api/voucher-events"))) return json({ error: "Peran Operator tidak dapat mengubah pembayaran atau voucher" }, 403);

  if (request.method === "GET" && path === "/api/settings") {
    const [settings, featureFlags] = await Promise.all([cloudSettings(redis, booth), resolveFeatureFlags(redis, booth)]);
    return json({ ...settings, capabilities: await deploymentCapabilitiesForBooth(redis, booth), featureFlags });
  }
  if (request.method === "PATCH" && (path === "/api/settings" || path.startsWith("/api/settings/"))) {
    const section = path === "/api/settings" ? "" : path.slice("/api/settings/".length);
    const current = await cloudSettings(redis, booth);
    if (section && !(section in DEFAULT_CLOUD_SETTINGS)) return json({ error: "Bagian pengaturan tidak dikenal" }, 404);
    const incoming = payload.data;
    const next = section ? { ...current, [section]: mergeObjects(current[section], incoming) } : mergeObjects(current, incoming);
    const capabilities = await deploymentCapabilitiesForBooth(redis, booth);
    if ((section === "payment" || (!section && incoming?.payment)) && (next.payment.qrisEnabled || next.payment.paidPrintEnabled) && !capabilities.qris.available) return json({ error: capabilities.qris.reason, capability: "qris" }, 409);
    if ((section === "storage" || (!section && incoming?.storage)) && next.storage.cloudEnabled && !capabilities.cloudStorage.available) return json({ error: capabilities.cloudStorage.reason, capability: "cloudStorage" }, 409);
    if (JSON.stringify(next).length > 500_000) return json({ error: "Pengaturan terlalu besar" }, 413);
    next.booth.name = String(next.booth.name || booth.name).slice(0, 80);
    next.booth.location = String(next.booth.location || "").slice(0, 120);
    let settingsVersion;
    try {
      settingsVersion = await persistSettingsSnapshot(redis, booth.boothCode, next, { correlationId });
    } catch (error) {
      return json({
        error: "Pengaturan belum dapat disimpan. Perubahan lokal tetap dipertahankan agar dapat dicoba lagi.",
        retryable: true,
        correlationId,
      }, Number(error?.status || 503));
    }
    const machine = await redis.get(machineKey(booth.machineId));
    if (machine) {
      machine.name = next.booth.name;
      machine.location = next.booth.location;
      machine.updatedAt = now();
      await redis.set(machineKey(machine.id), machine);
    }
    await Promise.all([
      writePostgresShadowEvent({
        entityType: "config",
        legacyKey: booth.boothCode,
        operation: "upsert",
        idempotencyKey: `config:${booth.boothCode}:${settingsVersion}`,
        correlationId: correlationId || randomId("corr"),
        payload: { boothCode: booth.boothCode, version: settingsVersion, config: next },
      }),
      appendAudit(redis, access.auth, booth.boothCode, "settings.updated", section || "all", { section: section || "all", version: settingsVersion }, correlationId),
    ]);
    return json(next);
  }

  if (request.method === "GET" && path === "/api/vouchers") return json(await voucherPayload(redis, booth.boothCode));
  if (request.method === "GET" && path === "/api/vouchers/print") {
    const eventId = target.searchParams.get("eventId") || "";
    const records = await voucherRecords(redis, booth.boothCode);
    const selected = records.filter(record => !record.redeemedAt && (eventId ? record.eventId === eventId : !record.eventId));
    return json({ codes: selected.map(record => record.code), eventId });
  }
  if (request.method === "GET" && path === "/api/assets") return json(await cloudAssets(redis, booth.boothCode));
  if (request.method === "POST" && path.match(/^\/api\/assets\/[^/]+\/prepare$/)) {
    const kind = path.split("/")[3];
    if (!ASSET_KINDS.includes(kind)) return json({ error: "Jenis aset tidak dikenal" }, 404);
    const runtime = await storageRuntime(redis, booth);
    const capabilities = deploymentCapabilities(runtime?.environment || process.env);
    if (!capabilities.cloudStorage.available) return json({ error: capabilities.cloudStorage.reason, capability: "cloudStorage" }, 409);
    const featureFlags = await resolveFeatureFlags(redis, booth);
    if (!featureFlags.direct_object_upload.enabled) return json({ error: "Upload langsung sedang dinonaktifkan. Gunakan upload kompatibilitas maksimal 2 MB.", featureFlag: "direct_object_upload" }, 409);
    const filename = String(payload.data?.filename || `${kind}.webp`).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
    const contentType = String(payload.data?.contentType || "application/octet-stream").toLowerCase().slice(0, 100);
    const size = Number(payload.data?.size || 0);
    const checksumSha256 = String(payload.data?.checksumSha256 || "").toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(contentType)) return json({ error: "Format aset harus JPEG, PNG, WebP, atau GIF" }, 415);
    if (!Number.isSafeInteger(size) || size < 1 || size > 25_000_000) return json({ error: "Ukuran aset maksimal 25 MB" }, 413);
    if (!/^[a-f0-9]{64}$/.test(checksumSha256)) return json({ error: "Checksum SHA-256 aset tidak valid" }, 400);
    const id = randomId("asset");
    const uploadId = randomId("asset-upload");
    const objectKey = `assets/${booth.boothCode}/${kind}/${id}-${filename}`;
    const upload = await presignObjectRequest({ method: "PUT", objectKey, contentType, checksumSha256, expiresIn: 600, environment: runtime?.environment || process.env });
    if (!upload) return json({ error: "Object storage belum tersedia", capability: "cloudStorage" }, 409);
    await redis.set(assetUploadIntentKey(booth.boothCode, uploadId), { id, uploadId, boothCode: booth.boothCode, kind, filename, contentType, size, checksumSha256, objectKey, provider: upload.provider, actorId: access.auth.userId, createdAt: now() }, { ex: 900 });
    return json({ uploadId, upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt }, maxFileBytes: 25_000_000 }, 201);
  }
  if (request.method === "POST" && path.match(/^\/api\/assets\/[^/]+\/finalize$/)) {
    const kind = path.split("/")[3];
    const uploadId = String(payload.data?.uploadId || "");
    if (!ASSET_KINDS.includes(kind) || !uploadId) return json({ error: "Upload aset tidak valid" }, 400);
    const intent = await redis.get(assetUploadIntentKey(booth.boothCode, uploadId));
    if (!intent || intent.kind !== kind || intent.boothCode !== booth.boothCode) return json({ error: "Upload aset sudah kedaluwarsa atau tidak ditemukan" }, 404);
    if (intent.actorId && intent.actorId !== access.auth.userId) return json({ error: "Upload aset dimiliki sesi admin lain" }, 403);
    const runtime = await storageRuntime(redis, booth, intent.provider);
    const environment = runtime?.environment || process.env;
    const object = await inspectObject({ objectKey: intent.objectKey, environment });
    if (!object || object.size !== intent.size || !object.checksumSha256 || object.checksumSha256.toLowerCase() !== intent.checksumSha256) {
      await deleteObject({ objectKey: intent.objectKey, environment }).catch(() => false);
      await redis.del(assetUploadIntentKey(booth.boothCode, uploadId));
      return json({ error: object?.size !== intent.size ? "Ukuran object hasil upload tidak cocok" : "Checksum object hasil upload tidak cocok" }, 422);
    }
    const record = { id: intent.id, boothCode: booth.boothCode, kind, name: intent.filename, contentType: intent.contentType, size: intent.size, checksumSha256: intent.checksumSha256, createdAt: now(), url: `/api/platform?action=cloud_asset&booth=${encodeURIComponent(booth.boothCode)}&id=${encodeURIComponent(intent.id)}`, storageMode: "object-storage", storageProvider: object.provider, objectKey: intent.objectKey, etag: object.etag };
    const postgresStatus = postgresAssetStatus();
    if (postgresStatus.primary) {
      const persisted = await persistPostgresAsset(record);
      if (!persisted.ok) return json({ error: persisted.reason || "Metadata aset belum dapat disimpan", retryable: true }, Number(persisted.status || 503));
    }
    await cacheAssetRecord(redis, record);
    await redis.del(assetUploadIntentKey(booth.boothCode, uploadId));
    if (postgresStatus.mode === "dual") await persistPostgresAsset(record);
    await Promise.all([
      writePostgresShadowEvent({ entityType: "asset", legacyKey: `${booth.boothCode}:${intent.id}`, operation: "upsert", idempotencyKey: `asset:${booth.boothCode}:${intent.id}:created`, correlationId: correlationId || randomId("corr"), payload: record }),
      appendAudit(redis, access.auth, booth.boothCode, "asset.created", intent.id, { kind, filename: intent.filename, size: intent.size, storageMode: "object-storage" }, correlationId),
    ]);
    return json({ asset: publicAssetProjection(record) }, 201);
  }
  if (request.method === "PUT" && path.startsWith("/api/assets/")) {
    const kind = path.slice("/api/assets/".length);
    if (!ASSET_KINDS.includes(kind)) return json({ error: "Jenis aset tidak dikenal" }, 404);
    const bodyBase64 = String(payload.data?.bodyBase64 || "");
    let bytes;
    try { bytes = Uint8Array.from(atob(bodyBase64), character => character.charCodeAt(0)); } catch { return json({ error: "Aset bukan Base64 yang valid" }, 400); }
    // Upload aset admin masih melewati body API. Jangan mengiklankan batas
    // object storage yang lebih besar sebelum direct browser upload tersedia.
    const maxAssetBytes = 2_000_000;
    const byteLength = bytes.byteLength;
    if (!byteLength || byteLength > maxAssetBytes) return json({ error: `Ukuran aset cloud maksimal ${Math.round(maxAssetBytes / 1_000_000)} MB` }, 413);
    const id = randomId("asset");
    const filename = String(payload.data?.filename || `${kind}.webp`).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
    const contentType = String(payload.data?.contentType || "application/octet-stream").slice(0, 100);
    const checksumSha256 = await sha256Bytes(bytes);
    const objectKey = `assets/${booth.boothCode}/${kind}/${id}-${filename}`;
    const runtime = await storageRuntime(redis, booth);
    const stored = await putObject({ objectKey, bytes, contentType, checksumSha256, environment: runtime?.environment || process.env });
    const postgresStatus = postgresAssetStatus();
    if (postgresStatus.primary && !stored) return json({ error: "Object storage wajib tersedia saat PostgreSQL aset menjadi sumber utama", retryable: true }, 503);
    const record = { id, boothCode: booth.boothCode, kind, name: filename, contentType, size: byteLength, checksumSha256, createdAt: now(), url: `/api/platform?action=cloud_asset&booth=${encodeURIComponent(booth.boothCode)}&id=${encodeURIComponent(id)}`, ...(stored ? { storageMode: "object-storage", storageProvider: stored.provider, objectKey, etag: stored.etag } : { storageMode: "legacy-redis", data: bodyBase64 }) };
    if (postgresStatus.primary) {
      const persisted = await persistPostgresAsset(record);
      if (!persisted.ok) return json({ error: persisted.reason || "Metadata aset belum dapat disimpan", retryable: true }, Number(persisted.status || 503));
    }
    await cacheAssetRecord(redis, record);
    if (postgresStatus.mode === "dual" && stored) await persistPostgresAsset(record);
    const asset = publicAssetProjection(record);
    await Promise.all([
      writePostgresShadowEvent({
        entityType: "asset",
        legacyKey: `${booth.boothCode}:${id}`,
        operation: "upsert",
        idempotencyKey: `asset:${booth.boothCode}:${id}:created`,
        correlationId: correlationId || randomId("corr"),
        payload: asset,
      }),
      appendAudit(redis, access.auth, booth.boothCode, "asset.created", id, { kind, filename, size: byteLength }, correlationId),
    ]);
    return json({ asset }, 201);
  }
  if (request.method === "DELETE" && path.startsWith("/api/assets/")) {
    const parts = path.split("/").filter(Boolean);
    const kind = parts[2];
    const idOrName = decodeURIComponent(parts.slice(3).join("/"));
    if (!ASSET_KINDS.includes(kind) || !idOrName) return json({ error: "Aset tidak valid" }, 400);
    const records = await assetRecords(redis, booth.boothCode);
    const candidates = records.filter(item => item.kind === kind && !item.deletionRequested);
    let id = idOrName;
    let record = await redis.get(assetKey(booth.boothCode, id));
    if (!record || record.deletionRequested) {
      record = null;
      for (const item of candidates) {
        if (item.id === idOrName || item.name === idOrName || item.url === idOrName) { id = item.id; record = item; break; }
      }
    }
    if (!record) return json({ error: "Aset tidak ditemukan" }, 404);
    const postgresStatus = postgresAssetStatus();
    if (postgresStatus.primary) {
      const requested = await requestPostgresAssetDeletion(booth.boothCode, id);
      if (!requested.ok) return json({ error: requested.reason || "Permintaan hapus aset belum dapat disimpan", retryable: true }, Number(requested.status || 503));
      record = requested.asset;
      await cacheAssetRecord(redis, record);
    }
    if (record.objectKey) {
      const runtime = await storageRuntime(redis, booth, record.storageProvider);
      const deletedObject = await deleteObject({ objectKey: record.objectKey, environment: runtime?.environment || process.env });
      if (!deletedObject) return json({ error: "File aset belum dapat dihapus. Permintaan tersimpan dan aman untuk dicoba lagi.", retryable: true }, 503);
    }
    if (postgresStatus.primary) {
      const deleted = await deletePostgresAsset(booth.boothCode, id);
      if (!deleted.ok || deleted.payload !== true) return json({ error: deleted.reason || "Metadata aset belum dapat dihapus", retryable: true }, Number(deleted.status || 503));
    }
    await redis.del(assetKey(booth.boothCode, id));
    await redis.srem(assetIndexKey(booth.boothCode, kind), id);
    if (postgresStatus.mode === "dual" && record.objectKey) {
      const requested = await requestPostgresAssetDeletion(booth.boothCode, id);
      if (requested.ok && !requested.skipped) await deletePostgresAsset(booth.boothCode, id);
    }
    await Promise.all([
      writePostgresShadowEvent({
        entityType: "asset",
        legacyKey: `${booth.boothCode}:${id}`,
        operation: "delete",
        idempotencyKey: `asset:${booth.boothCode}:${id}:deleted`,
        correlationId: correlationId || randomId("corr"),
        payload: { boothCode: booth.boothCode, id, kind },
      }),
      appendAudit(redis, access.auth, booth.boothCode, "asset.deleted", id, { kind }, correlationId),
    ]);
    return json({ deleted: true });
  }
  if (request.method === "POST" && path === "/api/vouchers") {
    const response = await createCloudVoucher(redis, booth.boothCode, payload.data || {}, { correlationId });
    if (response.ok) {
      const body = await response.clone().json().catch(() => ({}));
      const voucher = body.voucher || {};
      await Promise.all([
        writePostgresShadowEvent({
          entityType: "voucher",
          legacyKey: `${booth.boothCode}:${voucher.code || "unknown"}`,
          operation: "upsert",
          idempotencyKey: `voucher:${booth.boothCode}:${voucher.code || randomId("unknown")}:created`,
          correlationId: correlationId || randomId("corr"),
          payload: voucher,
        }),
        appendAudit(redis, access.auth, booth.boothCode, "voucher.created", voucher.code || "", {}, correlationId),
      ]);
    }
    return response;
  }
  if (request.method === "POST" && path === "/api/vouchers/generate") {
    const count = Math.max(1, Math.min(100, Number(payload.data?.count || 100)));
    let event = payload.data?.eventId ? await redis.get(voucherEventKey(booth.boothCode, String(payload.data.eventId))) : null;
    if (!event && payload.data?.eventId && postgresVoucherStatus().primary) {
      event = (await voucherEvents(redis, booth.boothCode)).find(record => record.id === String(payload.data.eventId)) || null;
    }
    if (payload.data?.eventId && (!event || eventExpired(event))) return json({ error: "Event tidak ditemukan atau sudah berakhir" }, 404);
    const existing = new Set(await redis.smembers(voucherIndexKey(booth.boothCode)));
    const vouchers = [];
    for (let attempt = 0; vouchers.length < count && attempt < count * 3; attempt += 1) {
      const code = `${pairingVoucherPart()}-${pairingVoucherPart()}`;
      if (existing.has(code)) continue;
      existing.add(code);
      const record = { code, boothCode: booth.boothCode, eventId: event?.id || null, includesPrint: event ? Boolean(event.includesPrint) : true, createdAt: now(), redeemedAt: null };
      vouchers.push(record);
    }
    let voucherVersion;
    try {
      voucherVersion = await persistVoucherBatch(redis, booth.boothCode, vouchers, { correlationId });
    } catch (error) {
      return json({
        error: "Voucher belum dapat dibuat. Tidak ada voucher parsial; silakan coba lagi.",
        retryable: true,
        correlationId,
      }, Number(error?.status || 503));
    }
    await Promise.all([
      writePostgresShadowEvent({
        entityType: "voucher",
        legacyKey: `${booth.boothCode}:batch:${voucherVersion}`,
        operation: "upsert",
        idempotencyKey: `voucher-batch:${booth.boothCode}:${voucherVersion}`,
        correlationId: correlationId || randomId("corr"),
        payload: { boothCode: booth.boothCode, version: voucherVersion, vouchers },
      }),
      appendAudit(redis, access.auth, booth.boothCode, "voucher.generated", event?.id || "general", { count: vouchers.length, version: voucherVersion }, correlationId),
    ]);
    return json({ created: vouchers.length, ...(await voucherPayload(redis, booth.boothCode)) }, 201);
  }
  if (request.method === "DELETE" && path.startsWith("/api/vouchers/")) {
    const code = voucherCode(decodeURIComponent(path.slice("/api/vouchers/".length)));
    let record = code ? await redis.get(voucherKey(booth.boothCode, code)) : null;
    if (!record && code && postgresVoucherStatus().primary) record = (await voucherRecords(redis, booth.boothCode)).find(item => item.code === code) || null;
    if (!record || record.redeemedAt) return json({ error: "Voucher tidak ditemukan atau sudah dipakai" }, 404);
    const postgresStatus = postgresVoucherStatus();
    let postgresResult = null;
    if (postgresStatus.primary) {
      postgresResult = await deletePostgresVoucher({ boothCode: booth.boothCode, code });
      if (!postgresResult.ok) return json({ error: postgresResult.reason || "Voucher belum dapat dihapus" }, Number(postgresResult.status || 503));
    }
    if (postgresStatus.primary) {
      try {
        await redis.del(voucherKey(booth.boothCode, code));
        await redis.srem(voucherIndexKey(booth.boothCode), code);
      } catch {
        // Redis cache only. PostgreSQL is authoritative.
      }
    } else {
      await redis.del(voucherKey(booth.boothCode, code));
      await redis.srem(voucherIndexKey(booth.boothCode), code);
    }
    const voucherVersion = postgresStatus.primary ? postgresResult.version : await redis.incr(voucherVersionKey(booth.boothCode));
    if (postgresStatus.primary) {
      try { await redis.set(voucherVersionKey(booth.boothCode), voucherVersion); } catch {}
    }
    else if (postgresStatus.mode === "dual") await deletePostgresVoucher({ boothCode: booth.boothCode, code });
    await Promise.all([
      writePostgresShadowEvent({
        entityType: "voucher",
        legacyKey: `${booth.boothCode}:${code}`,
        operation: "delete",
        idempotencyKey: `voucher:${booth.boothCode}:${code}:deleted:${voucherVersion}`,
        correlationId: correlationId || randomId("corr"),
        payload: { boothCode: booth.boothCode, code, version: voucherVersion },
      }),
      appendAudit(redis, access.auth, booth.boothCode, "voucher.deleted", code, { version: voucherVersion }, correlationId),
    ]);
    return json({ deleted: true });
  }
  if (request.method === "GET" && path === "/api/voucher-events") return json({ events: (await voucherPayload(redis, booth.boothCode)).events });
  if (request.method === "POST" && path === "/api/voucher-events") {
    const name = String(payload.data?.name || "").trim().slice(0, 100);
    const expiresAt = new Date(payload.data?.expiresAt || "");
    if (!name || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return json({ error: "Nama dan waktu berakhir event wajib diisi" }, 400);
    const event = { id: randomId("event"), boothCode: booth.boothCode, name, expiresAt: expiresAt.toISOString(), includesPrint: Boolean(payload.data?.includesPrint), createdAt: now() };
    const postgresStatus = postgresVoucherStatus();
    let postgresResult = null;
    if (postgresStatus.primary) {
      postgresResult = await persistPostgresVoucherEvent({ boothCode: booth.boothCode, event });
      if (!postgresResult.ok) return json({ error: postgresResult.reason || "Event belum dapat disimpan" }, 503);
    }
    if (postgresStatus.primary) {
      try {
        await redis.set(voucherEventKey(booth.boothCode, event.id), event);
        await redis.sadd(voucherEventIndexKey(booth.boothCode), event.id);
      } catch {
        // Redis cache only. PostgreSQL is authoritative.
      }
    } else {
      await redis.set(voucherEventKey(booth.boothCode, event.id), event);
      await redis.sadd(voucherEventIndexKey(booth.boothCode), event.id);
    }
    const voucherVersion = postgresStatus.primary ? postgresResult.version : await redis.incr(voucherVersionKey(booth.boothCode));
    if (postgresStatus.primary) {
      try { await redis.set(voucherVersionKey(booth.boothCode), voucherVersion); } catch {}
    }
    else if (postgresStatus.mode === "dual") await persistPostgresVoucherEvent({ boothCode: booth.boothCode, event });
    await Promise.all([
      writePostgresShadowEvent({
        entityType: "voucher_event",
        legacyKey: `${booth.boothCode}:${event.id}`,
        operation: "upsert",
        idempotencyKey: `voucher-event:${booth.boothCode}:${event.id}:created`,
        correlationId: correlationId || randomId("corr"),
        payload: { ...event, version: voucherVersion },
      }),
      appendAudit(redis, access.auth, booth.boothCode, "voucher_event.created", event.id, { name: event.name, expiresAt: event.expiresAt, version: voucherVersion }, correlationId),
    ]);
    return json({ event }, 201);
  }
  return json({ error: "Endpoint cloud data tidak ditemukan" }, 404);
}

export async function cloudAsset(redis, payload) {
  const booth = await resolveBooth(redis, payload.booth);
  if (!booth || !booth.enabled) return json({ error: "Photobox tidak ditemukan" }, 404);
  const id = String(payload.id || "");
  let record = await redis.get(assetKey(booth.boothCode, id));
  if ((!record || record.deletionRequested) && postgresAssetStatus().primary) {
    const durable = await readPostgresAssets(booth.boothCode);
    record = durable?.find(item => item.id === id) || null;
    if (record) await cacheAssetRecord(redis, record);
  }
  if (record?.deletionRequested) return json({ error: "Aset tidak ditemukan" }, 404);
  if (record?.objectKey) {
    const runtime = await storageRuntime(redis, booth, record.storageProvider);
    const download = await presignObjectRequest({ method: "GET", objectKey: record.objectKey, expiresIn: 3600, environment: runtime?.environment || process.env });
    if (!download) return json({ error: "Object storage tidak tersedia" }, 503);
    return new Response(null, { status: 302, headers: { location: download.url, "cache-control": "public, max-age=300" } });
  }
  if (!record?.data) return json({ error: "Aset tidak ditemukan" }, 404);
  const bytes = Uint8Array.from(atob(record.data), character => character.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": record.contentType || "application/octet-stream", "content-length": String(bytes.byteLength), "cache-control": "public, max-age=31536000, immutable" } });
}

async function dispatch(request, context) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "health";
    if (action === "resend_webhook") {
      const redis = getRedis();
      const result = await handleResendWebhook(redis, request);
      return json(result.body, result.status);
    }
    const csrf = validateMutationOrigin(request);
    if (!csrf.allowed) return json({ error: "Permintaan lintas situs ditolak" }, 403);
    const payload = { ...Object.fromEntries(url.searchParams), ...await requestBody(request) };
    if (action === "health") return json({ status: "ok", time: now() });
    const redis = getRedis();
    const rateRule = PLATFORM_RATE_LIMITS[action];
    if (rateRule && request.method === "POST") {
      const identity = payload.boothCode || payload.booth || payload.email || "";
      const rate = await consumeRateLimit(redis, request, action, rateRule, identity);
      if (!rate.allowed) return json(
        { error: `Terlalu banyak percobaan. Coba lagi dalam ${rate.retryAfter} detik.`, retryAfter: rate.retryAfter },
        429,
        { "retry-after": String(rate.retryAfter), "x-ratelimit-limit": String(rate.limit), "x-ratelimit-remaining": "0" },
      );
    }
    if (action === "public_status" && request.method === "GET") return json(await publicPlatformStatus(redis), 200, { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" });
    if (action === "xendit_webhook") return xenditWebhookControl(redis, request, payload, context?.id || "");
    if (action === "resolve_booth" && request.method === "GET") { const booth = await resolveBooth(redis, payload.booth); return booth ? json({ booth }) : json({ error: "Photobox tidak ditemukan" }, 404); }
    if (action === "validate_setup" && request.method === "POST") return validateSetupCode(redis, payload);
    if (action === "setup" && request.method === "POST") return setupBooth(redis, payload);
    if (action === "login" && request.method === "POST") return login(redis, payload);
    if (action === "superadmin_login" && request.method === "POST") return superadminLogin(redis, payload);
    if (action === "platform_staff_activate" && request.method === "POST") return activatePlatformStaff(redis, payload);
    if (action === "superadmin_session" && request.method === "GET") return superadminSession(redis, request);
    if (action === "me" && request.method === "GET") return currentUser(redis, request);
    if (action === "users" && request.method === "GET") return listUsers(redis, request);
    if (action === "users" && request.method === "POST") return addUser(redis, request, payload);
    if (action === "revoke_sessions" && request.method === "POST") return revokeUserSessions(redis, request, payload);
    if (action === "profile" && request.method === "POST") return updateProfile(redis, request, payload);
    if (action === "audit" && request.method === "GET") return auditLog(redis, request, payload);
    if (action === "backend_health" && request.method === "GET") return backendHealthControl(redis, request);
    if (action === "webhook_events") return webhookEventsControl(redis, request, payload);
    if (action === "provider_connections") return providerConnectionsControl(redis, request, payload);
    if (action === "provider_economics") return providerEconomicsControl(redis, request, payload);
    if (action === "provider_migrations") return providerMigrationsControl(redis, request, payload);
    if (action === "booth_integrations") return boothIntegrationsControl(redis, request, payload);
    if (action === "booth_finance") return boothFinanceControl(redis, request, payload);
    if (action === "email_deliveries") return emailDeliveriesControl(redis, request, payload, context?.id || "");
    if (action === "finance_policy") return financePolicyControl(redis, request, payload);
    if (action === "finance_payout") return financePayoutControl(redis, request, payload, context?.id || "");
    if (action === "finance_risk") return financeRiskControl(redis, request, payload, context?.id || "");
    if (action === "finance_reconciliation") return financeReconciliationControl(redis, request, payload, context?.id || "");
    if (action === "finance_refund") return financeRefundControl(redis, request, payload, context?.id || "");
    if (action === "finance_chargeback") return financeChargebackControl(redis, request, payload, context?.id || "");
    if (action === "finance_adjustment") return financeAdjustmentControl(redis, request, payload, context?.id || "");
    if (action === "finance_provider_fee") return financeProviderFeeControl(redis, request, payload, context?.id || "");
    if (action === "finance_ledger_reconciliation") return financeLedgerReconciliationControl(redis, request, payload, context?.id || "");
    if (action === "finance_balances") return financeBalancesControl(redis, request, payload);
    if (action === "remote_jobs") return remoteJobsControl(redis, request, payload);
    if (action === "agent_connection") return agentConnectionControl(redis, request, payload, context?.id || "");
    if (action === "logout" && request.method === "POST") return logout(redis, request);
    if (action === "forgot_password" && request.method === "POST") return forgotPassword(redis, payload);
    if (action === "superadmin_overview" && request.method === "GET") return superadminOverview(redis, request);
    if (action === "platform_frame_library") return platformFrameLibraryControl(redis, request, payload, context?.id || "");
    if (action === "platform_frame_download" && request.method === "GET") return platformFrameDownload(redis, request, payload);
    if (action === "platform_staff") return platformStaffControl(redis, request, payload);
    if (action === "booth_ownership") return transferBoothOwnership(redis, request, payload);
    if (action === "fleet_health") return fleetHealthControl(redis, request, payload);
    if (action === "alert_routing") return alertRoutingControl(redis, request, payload);
    if (action === "telemetry_history") return telemetryHistoryControl(redis, request, payload);
    if (action === "feature_flags") return featureFlagsControl(redis, request, payload);
    if (action === "toggle_machine" && request.method === "POST") return toggleMachine(redis, request, payload);
    if (action === "resolve_reset" && request.method === "POST") return resolveResetRequest(redis, request, payload);
    if (action === "register_session" && request.method === "POST") return registerPhotoSession(redis, request, payload);
    if (action === "upload_session_file" && request.method === "POST") return uploadPhotoSessionFile(redis, request, payload);
    if (action === "public_session" && request.method === "GET") return publicPhotoSession(redis, payload);
    if (action === "public_session_file" && request.method === "GET") return publicPhotoSessionFile(redis, payload);
    if (action === "delete_public_session" && request.method === "POST") return deletePublicPhotoSession(redis, payload);
    if (action === "cloud_data") {
      return request.method === "GET"
        ? cloudData(redis, request, payload, context?.id || "")
        : withCloudIdempotency(redis, request, payload, () => cloudData(redis, request, payload, context?.id || ""));
    }
    if (action === "cloud_asset" && request.method === "GET") return cloudAsset(redis, payload);
    return json({ error: "Endpoint tidak ditemukan" }, 404);
  } catch (error) {
    throw error;
  }
}

async function handler(request) {
  const context = requestContext(request, "platform");
  let action = "health";
  try {
    action = new URL(request.url).searchParams.get("action") || "health";
    return observedResponse(await dispatch(request, context), context, { action });
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
    if (isUpstashMaxRequestsError(error)) return observedResponse(json({
      error: "Cache Redis Upstash sedang mencapai batas gratis. Data utama tetap disimpan di Supabase jika mode PostgreSQL aktif.",
      code: "UPSTASH_MAX_REQUESTS_EXCEEDED",
      retryable: true,
      degraded: true,
      actionRequired: "Jangan install ulang Agent. Coba ulang nanti untuk status real-time, job remote, atau fitur legacy yang masih memakai Redis.",
      correlationId: context.id,
    }, 503, { "retry-after": "300" }), context, { action });
    return observedResponse(json({ error: error instanceof Error ? error.message : "Kesalahan server", correlationId: context.id }, 500), context, { action });
  }
}

export default { fetch: handler };
