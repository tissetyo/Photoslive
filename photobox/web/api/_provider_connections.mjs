import { now } from "./_store.mjs";
import { providerDefinitions } from "./_providers.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INDEX_KEY = "photoslive:provider-connections";
const CONNECTION_VERSION_TTL_SECONDS = 8 * 24 * 60 * 60;
const VALID_SCOPES = new Set(["global", "organization", "booth"]);
const VALID_SOURCES = new Set(["platform-managed", "byo"]);
const ACTIVE_STATES = new Set(["active", "paused", "revoked"]);
const idPart = value => String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 100);
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
const fromBase64url = value => {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
};

function normalizedContext(input = {}) {
  const providerId = idPart(input.providerId);
  const scope = String(input.scope || "").trim().toLowerCase();
  const targetId = scope === "global" ? "" : idPart(input.targetId);
  if (!providerDefinitions()[providerId]) throw new Error("Provider tidak dikenal");
  if (!VALID_SCOPES.has(scope)) throw new Error("Scope provider tidak valid");
  if (scope !== "global" && !targetId) throw new Error("Target provider wajib diisi");
  return { providerId, scope, targetId };
}

export function providerConnectionId(input = {}) {
  const context = normalizedContext(input);
  return `${context.scope}:${context.targetId || "_"}:${context.providerId}`;
}

const connectionKey = id => `photoslive:provider-connection:${id}`;
const connectionVersionKey = (id, credentialVersion) => `photoslive:provider-connection-version:${id}:${credentialVersion}`;

async function archiveProviderConnectionVersion(redis, record) {
  if (!record?.id || !Number.isSafeInteger(Number(record.credentialVersion)) || Number(record.credentialVersion) < 1) return;
  await redis.set(connectionVersionKey(record.id, Number(record.credentialVersion)), record, { ex: CONNECTION_VERSION_TTL_SECONDS });
}

function decodeVaultKey(value) {
  try {
    const bytes = fromBase64url(value);
    return bytes.byteLength === 32 ? bytes : null;
  } catch { return null; }
}

export function providerVaultConfig(environment = process.env) {
  let entries = {};
  if (environment.PROVIDER_CREDENTIAL_KEYS) {
    try { entries = JSON.parse(environment.PROVIDER_CREDENTIAL_KEYS); }
    catch { throw new Error("PROVIDER_CREDENTIAL_KEYS bukan JSON yang valid"); }
  } else if (environment.PROVIDER_CREDENTIAL_MASTER_KEY) {
    entries = { v1: environment.PROVIDER_CREDENTIAL_MASTER_KEY };
  }
  const keys = new Map();
  for (const [version, value] of Object.entries(entries || {})) {
    const normalizedVersion = idPart(version);
    const bytes = decodeVaultKey(value);
    if (!normalizedVersion || !bytes) throw new Error("Setiap kunci vault provider harus base64 32 byte");
    keys.set(normalizedVersion, bytes);
  }
  const activeKeyVersion = idPart(environment.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION || [...keys.keys()][0]);
  return { available: keys.size > 0 && keys.has(activeKeyVersion), activeKeyVersion, keys };
}

function aadFor(context, credentialVersion) {
  return encoder.encode(`photoslive-provider-v1:${context.scope}:${context.targetId || "_"}:${context.providerId}:${credentialVersion}`);
}

export async function encryptProviderCredentials(credentials, contextInput, environment = process.env, credentialVersion = 1) {
  const context = normalizedContext(contextInput);
  const vault = providerVaultConfig(environment);
  if (!vault.available) throw new Error("Vault credential provider belum dikonfigurasi");
  const key = await crypto.subtle.importKey("raw", vault.keys.get(vault.activeKeyVersion), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadFor(context, credentialVersion) }, key, plaintext);
  return { format: "aes-256-gcm", keyVersion: vault.activeKeyVersion, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}

export async function decryptProviderCredentials(envelope, contextInput, environment = process.env, credentialVersion = 1) {
  const context = normalizedContext(contextInput);
  const vault = providerVaultConfig(environment);
  const keyBytes = vault.keys.get(idPart(envelope?.keyVersion));
  if (envelope?.format !== "aes-256-gcm" || !keyBytes) throw new Error("Versi kunci credential provider tidak tersedia");
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(envelope.iv), additionalData: aadFor(context, credentialVersion) }, key, fromBase64url(envelope.ciphertext));
    return JSON.parse(decoder.decode(plaintext));
  } catch { throw new Error("Credential provider tidak dapat didekripsi atau telah berubah"); }
}

function maskCredential(value) {
  const text = String(value || "");
  if (!text) return "Belum diisi";
  if (text.includes("@")) {
    const [local, domain] = text.split("@");
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  return `••••${text.slice(-4)}`;
}

function validateCredentials(providerId, credentials = {}) {
  const definition = providerDefinitions()[providerId];
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) throw new Error("Credential provider harus object");
  const allowed = new Set(definition.requiredEnvironment);
  const unknown = Object.keys(credentials).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error("Field credential provider tidak dikenal");
  const normalized = {};
  for (const field of definition.requiredEnvironment) {
    const value = String(credentials[field] || "").trim();
    if (!value) throw new Error(`Credential ${field} wajib diisi`);
    if (value.length > 4_096) throw new Error(`Credential ${field} terlalu panjang`);
    normalized[field] = value;
  }
  return normalized;
}

export function safeProviderConnection(record) {
  if (!record) return null;
  const definition = providerDefinitions()[record.providerId] || {};
  return {
    id: record.id,
    providerId: record.providerId,
    label: definition.label || record.providerId,
    kind: definition.kind || "unknown",
    capability: definition.capability || "unknown",
    adapterImplemented: Boolean(definition.adapterImplemented),
    scope: record.scope,
    targetId: record.targetId || "",
    source: record.source,
    status: record.status,
    isDefault: Boolean(record.isDefault),
    credentialVersion: Number(record.credentialVersion || 0),
    keyVersion: record.sealed?.keyVersion || null,
    credentialFields: Array.isArray(record.credentialFields) ? record.credentialFields : [],
    expiresAt: record.expiresAt || null,
    lastCheck: record.lastCheck ? {
      state: ["ready", "error", "not_configured"].includes(record.lastCheck.state) ? record.lastCheck.state : "error",
      provider: idPart(record.lastCheck.provider),
      latencyMs: Number.isFinite(record.lastCheck.latencyMs) ? Math.max(0, Math.min(30_000, Number(record.lastCheck.latencyMs))) : null,
      message: String(record.lastCheck.message || "").slice(0, 240),
      checkedAt: record.lastCheck.checkedAt || null,
    } : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

export async function listProviderConnections(redis) {
  const ids = await redis.smembers(INDEX_KEY);
  const records = (ids.length ? (typeof redis.mget === "function" ? await redis.mget(...ids.map(connectionKey)) : await Promise.all(ids.map(id => redis.get(connectionKey(id))))) : []).filter(Boolean);
  return records.map(safeProviderConnection).sort((a, b) => `${a.providerId}:${a.scope}:${a.targetId}`.localeCompare(`${b.providerId}:${b.scope}:${b.targetId}`));
}

export async function saveProviderConnection(redis, input = {}, actorId = "system", environment = process.env) {
  const context = normalizedContext(input);
  const id = providerConnectionId(context);
  const previous = await redis.get(connectionKey(id));
  const source = String(input.source || "byo").trim().toLowerCase();
  if (!VALID_SOURCES.has(source)) throw new Error("Sumber credential provider tidak valid");
  const credentialVersion = Number(previous?.credentialVersion || 0) + 1;
  let sealed = null;
  let credentialFields = [];
  if (source === "byo") {
    const credentials = validateCredentials(context.providerId, input.credentials);
    sealed = await encryptProviderCredentials(credentials, context, environment, credentialVersion);
    credentialFields = Object.entries(credentials).map(([name, value]) => ({ name, masked: maskCredential(value) }));
  }
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("Tanggal kedaluwarsa credential tidak valid");
  const record = {
    id, ...context, source, sealed, credentialFields,
    status: "active",
    isDefault: Boolean(input.isDefault),
    credentialVersion,
    expiresAt: expiresAt?.toISOString() || null,
    createdAt: previous?.createdAt || now(),
    updatedAt: now(),
    updatedBy: String(actorId || "system").slice(0, 120),
  };
  if (previous) await archiveProviderConnectionVersion(redis, previous);
  await Promise.all([
    redis.set(connectionKey(id), record),
    archiveProviderConnectionVersion(redis, record),
  ]);
  await redis.sadd(INDEX_KEY, id);
  if (record.isDefault) {
    const definition = providerDefinitions()[record.providerId];
    const ids = await redis.smembers(INDEX_KEY);
    for (const candidateId of ids) {
      if (candidateId === id) continue;
      const candidate = await redis.get(connectionKey(candidateId));
      if (candidate?.scope === record.scope && (candidate.targetId || "") === record.targetId
        && providerDefinitions()[candidate.providerId]?.capability === definition.capability && candidate.isDefault) {
        candidate.isDefault = false;
        candidate.updatedAt = now();
        candidate.updatedBy = String(actorId || "system").slice(0, 120);
        await redis.set(connectionKey(candidateId), candidate);
      }
    }
  }
  return { record: safeProviderConnection(record), operation: previous ? "rotated" : "created" };
}

export async function setProviderConnectionState(redis, input = {}, actorId = "system") {
  const id = providerConnectionId(input);
  const record = await redis.get(connectionKey(id));
  if (!record) throw new Error("Koneksi provider tidak ditemukan");
  const status = String(input.status || "").toLowerCase();
  if (!ACTIVE_STATES.has(status)) throw new Error("Status koneksi provider tidak valid");
  if (record.status === "revoked" && status !== "revoked") throw new Error("Credential yang sudah dicabut harus diisi ulang");
  record.status = status;
  if (status === "revoked") {
    record.sealed = null;
    record.credentialFields = [];
  }
  record.updatedAt = now();
  record.updatedBy = String(actorId || "system").slice(0, 120);
  await redis.set(connectionKey(id), record);
  return safeProviderConnection(record);
}

export async function rewrapProviderConnection(redis, input = {}, actorId = "system", environment = process.env) {
  const context = normalizedContext(input);
  const id = providerConnectionId(context);
  const record = await redis.get(connectionKey(id));
  if (!record?.sealed || record.status === "revoked") throw new Error("Credential provider aktif tidak ditemukan");
  for (let version = 1; version < Number(record.credentialVersion); version += 1) {
    const archived = await redis.get(connectionVersionKey(id, version));
    if (!archived?.sealed) continue;
    const archivedCredentials = await decryptProviderCredentials(archived.sealed, archived, environment, version);
    archived.sealed = await encryptProviderCredentials(archivedCredentials, archived, environment, version);
    archived.updatedAt = now();
    archived.updatedBy = String(actorId || "system").slice(0, 120);
    await archiveProviderConnectionVersion(redis, archived);
  }
  const credentials = await decryptProviderCredentials(record.sealed, context, environment, record.credentialVersion);
  record.sealed = await encryptProviderCredentials(credentials, context, environment, record.credentialVersion);
  record.updatedAt = now();
  record.updatedBy = String(actorId || "system").slice(0, 120);
  await Promise.all([
    redis.set(connectionKey(id), record),
    archiveProviderConnectionVersion(redis, record),
  ]);
  return safeProviderConnection(record);
}

export async function recordProviderConnectionCheck(redis, input = {}, check = {}) {
  const id = providerConnectionId(input);
  const record = await redis.get(connectionKey(id));
  if (!record || record.status !== "active") throw new Error("Koneksi provider aktif tidak ditemukan");
  record.lastCheck = {
    state: ["ready", "error", "not_configured"].includes(check.state) ? check.state : "error",
    provider: idPart(check.provider || record.providerId),
    latencyMs: Number.isFinite(check.latencyMs) ? Math.max(0, Math.min(30_000, Number(check.latencyMs))) : null,
    message: String(check.message || "Tes koneksi selesai").slice(0, 240),
    checkedAt: check.checkedAt || now(),
  };
  await redis.set(connectionKey(id), record);
  return safeProviderConnection(record);
}

export async function resolveProviderConnection(redis, providerId, context = {}) {
  const normalizedProvider = idPart(providerId);
  const candidates = [
    { providerId: normalizedProvider, scope: "global", targetId: "" },
    ...(context.organizationId ? [{ providerId: normalizedProvider, scope: "organization", targetId: context.organizationId }] : []),
    ...(context.boothCode ? [{ providerId: normalizedProvider, scope: "booth", targetId: context.boothCode }] : []),
  ];
  let resolved = null;
  for (const candidate of candidates) {
    const record = await redis.get(connectionKey(providerConnectionId(candidate)));
    if (record?.status === "active" && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())) resolved = record;
  }
  return safeProviderConnection(resolved);
}

function activeRecord(record) {
  return Boolean(record?.status === "active" && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()));
}

async function resolveRawProviderConnection(redis, providerId, context = {}) {
  const normalizedProvider = idPart(providerId);
  const candidates = [
    { providerId: normalizedProvider, scope: "global", targetId: "" },
    ...(context.organizationId ? [{ providerId: normalizedProvider, scope: "organization", targetId: context.organizationId }] : []),
    ...(context.boothCode ? [{ providerId: normalizedProvider, scope: "booth", targetId: context.boothCode }] : []),
  ];
  let resolved = null;
  for (const candidate of candidates) {
    const record = await redis.get(connectionKey(providerConnectionId(candidate)));
    if (activeRecord(record)) resolved = record;
  }
  return resolved;
}

async function resolveRawProviderForCapability(redis, capability, context = {}) {
  const providerIds = Object.entries(providerDefinitions())
    .filter(([, definition]) => definition.capability === capability && definition.adapterImplemented)
    .map(([providerId]) => providerId);
  const scopes = [
    ...(context.boothCode ? [{ scope: "booth", targetId: context.boothCode }] : []),
    ...(context.organizationId ? [{ scope: "organization", targetId: context.organizationId }] : []),
    { scope: "global", targetId: "" },
  ];
  for (const scope of scopes) {
    const records = (await Promise.all(providerIds.map(async providerId => {
      const id = providerConnectionId({ providerId, ...scope });
      return redis.get(connectionKey(id));
    }))).filter(activeRecord);
    if (records.length) return records.find(record => record.isDefault) || records[0];
  }
  return null;
}

function configuredProviderForCapability(capability, environment) {
  return Object.entries(providerDefinitions()).find(([, definition]) => definition.capability === capability
    && definition.adapterImplemented
    && definition.requiredEnvironment.every(field => Boolean(environment[field])))?.[0] || null;
}

function scopedProviderEnvironment(providerId, credentials, baseEnvironment = process.env) {
  const definitions = providerDefinitions();
  const definition = definitions[providerId];
  const environment = { ...baseEnvironment };
  for (const candidate of Object.values(definitions)) {
    if (candidate.capability !== definition.capability) continue;
    for (const field of candidate.requiredEnvironment) delete environment[field];
  }
  Object.assign(environment, credentials);
  return environment;
}

async function providerCredentialFingerprint(definition, credentials) {
  const serialized = definition.requiredEnvironment
    .map(field => `${field}=${String(credentials[field] || "")}`)
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(serialized));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve credentials for server-side adapter use. The returned environment
 * must never be serialized to a response, audit log, or client bundle.
 */
export async function resolveProviderRuntime(redis, providerId, context = {}, baseEnvironment = process.env) {
  const normalizedProvider = idPart(providerId);
  const definition = providerDefinitions()[normalizedProvider];
  if (!definition?.adapterImplemented) throw new Error("Adapter provider belum tersedia");
  const record = await resolveRawProviderConnection(redis, normalizedProvider, context);
  if (!record) {
    const configured = definition.requiredEnvironment.every(field => Boolean(baseEnvironment[field]));
    if (!configured) return null;
    const credentials = Object.fromEntries(definition.requiredEnvironment.map(field => [field, baseEnvironment[field]]));
    const credentialFingerprint = await providerCredentialFingerprint(definition, credentials);
    return {
      providerId: normalizedProvider,
      source: "deployment-environment",
      connection: null,
      reference: { providerId: normalizedProvider, source: "deployment-environment", connectionId: null, credentialVersion: 0, credentialFingerprint },
      environment: scopedProviderEnvironment(normalizedProvider, credentials, baseEnvironment),
    };
  }
  const credentials = record.source === "byo"
    ? await decryptProviderCredentials(record.sealed, record, baseEnvironment, record.credentialVersion)
    : Object.fromEntries(definition.requiredEnvironment.map(field => [field, baseEnvironment[field]]));
  if (definition.requiredEnvironment.some(field => !credentials[field])) throw new Error(`Credential ${definition.label} belum lengkap`);
  const credentialFingerprint = await providerCredentialFingerprint(definition, credentials);
  return {
    providerId: normalizedProvider,
    source: record.source,
    connection: safeProviderConnection(record),
    reference: { providerId: normalizedProvider, source: record.source, connectionId: record.id, credentialVersion: Number(record.credentialVersion), credentialFingerprint },
    environment: scopedProviderEnvironment(normalizedProvider, credentials, baseEnvironment),
  };
}

/**
 * Resolve the exact non-secret connection version captured when a transaction
 * was created. Rotating or changing the default connection cannot move an
 * in-flight transaction to another merchant account. A deliberate revoke is
 * fail-closed and blocks archived credentials too.
 */
export async function resolveProviderRuntimeReference(redis, reference = {}, context = {}, baseEnvironment = process.env) {
  const providerId = idPart(reference.providerId);
  const definition = providerDefinitions()[providerId];
  if (!definition?.adapterImplemented) throw new Error("Referensi provider transaksi tidak valid");
  if (reference.source === "deployment-environment" || !reference.connectionId) {
    const credentials = Object.fromEntries(definition.requiredEnvironment.map(field => [field, baseEnvironment[field]]));
    if (definition.requiredEnvironment.some(field => !credentials[field])) throw new Error("Runtime deployment provider transaksi tidak lagi tersedia");
    const credentialFingerprint = await providerCredentialFingerprint(definition, credentials);
    if (reference.credentialFingerprint && reference.credentialFingerprint !== credentialFingerprint) throw new Error("Credential deployment provider transaksi telah berubah");
    return {
      providerId,
      source: "deployment-environment",
      connection: null,
      reference: { providerId, source: "deployment-environment", connectionId: null, credentialVersion: 0, credentialFingerprint },
      environment: scopedProviderEnvironment(providerId, credentials, baseEnvironment),
    };
  }
  const connectionId = String(reference.connectionId || "").trim().slice(0, 320);
  const credentialVersion = Number(reference.credentialVersion);
  if (!connectionId || !Number.isSafeInteger(credentialVersion) || credentialVersion < 1) throw new Error("Versi koneksi provider transaksi tidak valid");
  const current = await redis.get(connectionKey(connectionId));
  if (current?.status === "revoked") throw new Error("Credential provider transaksi telah dicabut");
  const record = await redis.get(connectionVersionKey(connectionId, credentialVersion))
    || (Number(current?.credentialVersion) === credentialVersion ? current : null);
  if (!record || record.id !== connectionId || record.providerId !== providerId || Number(record.credentialVersion) !== credentialVersion) {
    throw new Error("Versi koneksi provider transaksi tidak tersedia");
  }
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) throw new Error("Credential provider transaksi sudah kedaluwarsa");
  const credentials = record.source === "byo"
    ? await decryptProviderCredentials(record.sealed, record, baseEnvironment, record.credentialVersion)
    : Object.fromEntries(definition.requiredEnvironment.map(field => [field, baseEnvironment[field]]));
  if (definition.requiredEnvironment.some(field => !credentials[field])) throw new Error(`Credential ${definition.label} belum lengkap`);
  const credentialFingerprint = await providerCredentialFingerprint(definition, credentials);
  if (reference.credentialFingerprint && reference.credentialFingerprint !== credentialFingerprint) throw new Error("Credential provider transaksi tidak cocok dengan versi tersimpan");
  return {
    providerId,
    source: record.source,
    connection: safeProviderConnection(record),
    reference: { providerId, source: record.source, connectionId, credentialVersion, credentialFingerprint },
    environment: scopedProviderEnvironment(providerId, credentials, baseEnvironment),
  };
}

export async function resolveProviderRuntimeForCapability(redis, capability, context = {}, baseEnvironment = process.env) {
  const record = await resolveRawProviderForCapability(redis, capability, context);
  if (record) return resolveProviderRuntime(redis, record.providerId, context, baseEnvironment);
  const providerId = configuredProviderForCapability(capability, baseEnvironment);
  return providerId ? resolveProviderRuntime(redis, providerId, context, baseEnvironment) : null;
}

export async function resolveProviderForCapability(redis, capability, context = {}) {
  const definitions = providerDefinitions();
  const candidates = await Promise.all(Object.entries(definitions)
    .filter(([, definition]) => definition.capability === capability)
    .map(([providerId]) => resolveProviderConnection(redis, providerId, context)));
  const active = candidates.filter(Boolean);
  return active.find(connection => connection.isDefault) || active[0] || null;
}

export function providerConnectionDefinitions() {
  return Object.entries(providerDefinitions()).map(([id, definition]) => ({
    id,
    label: definition.label,
    kind: definition.kind,
    capability: definition.capability,
    adapterImplemented: Boolean(definition.adapterImplemented),
    credentialFields: [...definition.requiredEnvironment],
  }));
}

export const providerConnectionStorageKeys = Object.freeze({ connectionKey, connectionVersionKey });
