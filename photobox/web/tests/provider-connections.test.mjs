import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  decryptProviderCredentials,
  encryptProviderCredentials,
  listProviderConnections,
  providerVaultConfig,
  recordProviderConnectionCheck,
  resolveProviderConnection,
  resolveProviderRuntime,
  resolveProviderRuntimeForCapability,
  resolveProviderRuntimeReference,
  rewrapProviderConnection,
  saveProviderConnection,
  setProviderConnectionState,
} from "../api/_provider_connections.mjs";
import { objectStorageConfiguration } from "../api/_object_storage.mjs";
import { providerConnectionsControl } from "../api/platform.mjs";
import { sessionKey } from "../api/_store.mjs";

class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async sadd(key, ...values) { const target = this.sets.get(key) || new Set(); values.forEach(value => target.add(value)); this.sets.set(key, target); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
  async mget(...keys) { return Promise.all(keys.map(key => this.get(key))); }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
  pipeline() {
    const operations = [];
    return {
      lpush: (key, value) => operations.push(() => this.lpush(key, value)),
      ltrim: (key, start, stop) => operations.push(() => this.ltrim(key, start, stop)),
      exec: async () => Promise.all(operations.map(operation => operation())),
    };
  }
}

const key = fill => Buffer.alloc(32, fill).toString("base64url");
const envV1 = { PROVIDER_CREDENTIAL_KEYS: JSON.stringify({ v1: key(7) }), PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION: "v1" };
const context = { providerId: "cloudflare-r2", scope: "booth", targetId: "booth-a" };
const credentials = { R2_ACCOUNT_ID: "account-1234", R2_ACCESS_KEY_ID: "access-5678", R2_SECRET_ACCESS_KEY: "super-secret-9012", R2_BUCKET: "photos" };
const sessionSecret = "provider-connection-test-session-secret-2026";

async function signedCookie(id) {
  const keyBytes = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", keyBytes, new TextEncoder().encode(id));
  const hex = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${hex}`)}`;
}

test("provider vault uses AES-GCM with tenant-bound additional data", async () => {
  assert.equal(providerVaultConfig(envV1).available, true);
  const sealed = await encryptProviderCredentials(credentials, context, envV1, 1);
  assert.equal(sealed.format, "aes-256-gcm");
  assert.deepEqual(await decryptProviderCredentials(sealed, context, envV1, 1), credentials);
  await assert.rejects(() => decryptProviderCredentials(sealed, { ...context, targetId: "booth-b" }, envV1, 1), /tidak dapat didekripsi/);
  await assert.rejects(() => decryptProviderCredentials({ ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}aa` }, context, envV1, 1), /tidak dapat didekripsi/);
});

test("BYO provider records are masked and never return ciphertext or raw secrets", async () => {
  const redis = new FakeRedis();
  const { record, operation } = await saveProviderConnection(redis, { ...context, source: "byo", credentials, isDefault: true }, "integration-admin", envV1);
  assert.equal(operation, "created");
  assert.equal(record.credentialFields.find(field => field.name === "R2_SECRET_ACCESS_KEY").masked, "••••9012");
  const listed = await listProviderConnections(redis);
  const serialized = JSON.stringify(listed);
  assert.equal(serialized.includes("super-secret-9012"), false);
  assert.equal(serialized.includes("ciphertext"), false);
  assert.equal(serialized.includes("sealed"), false);
  assert.equal((await resolveProviderConnection(redis, "cloudflare-r2", { boothCode: "booth-a" })).id, record.id);
  assert.equal(await resolveProviderConnection(redis, "cloudflare-r2", { boothCode: "booth-b" }), null);
});

test("provider scope precedence, pause, revoke, credential rotation, and key rewrap are deterministic", async () => {
  const redis = new FakeRedis();
  await saveProviderConnection(redis, { providerId: "cloudflare-r2", scope: "global", source: "platform-managed", isDefault: true }, "owner", {});
  await saveProviderConnection(redis, { ...context, source: "byo", credentials }, "owner", envV1);
  assert.equal((await resolveProviderConnection(redis, "cloudflare-r2", { boothCode: "booth-a" })).scope, "booth");
  await saveProviderConnection(redis, { providerId: "s3-compatible", scope: "global", source: "platform-managed", isDefault: true }, "owner", {});
  assert.equal((await listProviderConnections(redis)).find(item => item.providerId === "cloudflare-r2" && item.scope === "global").isDefault, false);
  await setProviderConnectionState(redis, { ...context, status: "paused" }, "owner");
  assert.equal((await resolveProviderConnection(redis, "cloudflare-r2", { boothCode: "booth-a" })).scope, "global");
  await setProviderConnectionState(redis, { ...context, status: "active" }, "owner");
  const rotated = await saveProviderConnection(redis, { ...context, source: "byo", credentials: { ...credentials, R2_SECRET_ACCESS_KEY: "new-secret-9999" } }, "owner", envV1);
  assert.equal(rotated.operation, "rotated");
  assert.equal(rotated.record.credentialVersion, 2);
  const envV2 = { PROVIDER_CREDENTIAL_KEYS: JSON.stringify({ v1: key(7), v2: key(8) }), PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION: "v2" };
  assert.equal((await rewrapProviderConnection(redis, context, "owner", envV2)).keyVersion, "v2");
  const revoked = await setProviderConnectionState(redis, { ...context, status: "revoked" }, "owner");
  assert.equal(revoked.credentialFields.length, 0);
  await assert.rejects(() => setProviderConnectionState(redis, { ...context, status: "active" }, "owner"), /diisi ulang/);
});

test("provider runtime decrypts BYO credentials only for the selected server adapter", async () => {
  const redis = new FakeRedis();
  await saveProviderConnection(redis, { ...context, source: "byo", credentials, isDefault: true }, "owner", envV1);
  const baseEnvironment = {
    ...envV1,
    S3_ENDPOINT: "https://s3.example.test",
    S3_ACCESS_KEY_ID: "competing-access",
    S3_SECRET_ACCESS_KEY: "competing-secret",
    S3_BUCKET: "competing-bucket",
  };
  const runtime = await resolveProviderRuntimeForCapability(redis, "cloudStorage", { boothCode: "booth-a" }, baseEnvironment);
  assert.equal(runtime.providerId, "cloudflare-r2");
  assert.equal(runtime.source, "byo");
  assert.equal(objectStorageConfiguration(runtime.environment).id, "cloudflare-r2");
  assert.equal(runtime.environment.R2_SECRET_ACCESS_KEY, credentials.R2_SECRET_ACCESS_KEY);
  assert.equal(runtime.environment.S3_SECRET_ACCESS_KEY, undefined);
  assert.doesNotMatch(JSON.stringify(runtime.connection), /super-secret-9012|ciphertext|sealed/);
});

test("transaction runtime reference stays on its original credential version across rotation", async () => {
  const redis = new FakeRedis();
  const paymentContext = { providerId: "xendit", scope: "booth", targetId: "booth-a" };
  const originalCredentials = { XENDIT_SECRET_KEY: "xnd_original_secret", XENDIT_WEBHOOK_TOKEN: "original-webhook" };
  await saveProviderConnection(redis, { ...paymentContext, source: "byo", credentials: originalCredentials, isDefault: true }, "finance-admin", envV1);
  const original = await resolveProviderRuntimeForCapability(redis, "qris", { boothCode: "booth-a" }, envV1);
  assert.equal(original.reference.providerId, "xendit");
  assert.equal(original.reference.source, "byo");
  assert.equal(original.reference.connectionId, "booth:booth-a:xendit");
  assert.equal(original.reference.credentialVersion, 1);
  assert.match(original.reference.credentialFingerprint, /^[a-f0-9]{64}$/);

  await saveProviderConnection(redis, {
    ...paymentContext,
    source: "byo",
    credentials: { XENDIT_SECRET_KEY: "xnd_rotated_secret", XENDIT_WEBHOOK_TOKEN: "rotated-webhook" },
    isDefault: true,
  }, "finance-admin", envV1);
  const current = await resolveProviderRuntimeForCapability(redis, "qris", { boothCode: "booth-a" }, envV1);
  const pinned = await resolveProviderRuntimeReference(redis, original.reference, { boothCode: "booth-a" }, envV1);
  assert.equal(current.environment.XENDIT_SECRET_KEY, "xnd_rotated_secret");
  assert.equal(current.reference.credentialVersion, 2);
  assert.equal(pinned.environment.XENDIT_SECRET_KEY, "xnd_original_secret");
  assert.equal(pinned.environment.XENDIT_WEBHOOK_TOKEN, "original-webhook");
  assert.equal(pinned.reference.credentialVersion, 1);

  const envV2 = { PROVIDER_CREDENTIAL_KEYS: JSON.stringify({ v1: key(7), v2: key(8) }), PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION: "v2" };
  await rewrapProviderConnection(redis, paymentContext, "finance-admin", envV2);
  const envV2Only = { PROVIDER_CREDENTIAL_KEYS: JSON.stringify({ v2: key(8) }), PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION: "v2" };
  assert.equal((await resolveProviderRuntimeReference(redis, original.reference, { boothCode: "booth-a" }, envV2Only)).environment.XENDIT_SECRET_KEY, "xnd_original_secret");

  await setProviderConnectionState(redis, { ...paymentContext, status: "revoked" }, "finance-admin");
  await assert.rejects(
    () => resolveProviderRuntimeReference(redis, original.reference, { boothCode: "booth-a" }, envV1),
    /telah dicabut/,
  );
});

test("provider runtime honors platform default, exact provider pinning, and environment fallback", async () => {
  const redis = new FakeRedis();
  const baseEnvironment = {
    R2_ACCOUNT_ID: "deployment-account",
    R2_ACCESS_KEY_ID: "deployment-r2-access",
    R2_SECRET_ACCESS_KEY: "deployment-r2-secret",
    R2_BUCKET: "deployment-r2-bucket",
    S3_ENDPOINT: "https://s3.example.test",
    S3_ACCESS_KEY_ID: "deployment-s3-access",
    S3_SECRET_ACCESS_KEY: "deployment-s3-secret",
    S3_BUCKET: "deployment-s3-bucket",
  };
  const fallback = await resolveProviderRuntimeForCapability(redis, "cloudStorage", {}, baseEnvironment);
  assert.equal(fallback.source, "deployment-environment");
  assert.match(fallback.reference.credentialFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(objectStorageConfiguration(fallback.environment).id, "cloudflare-r2");
  await assert.rejects(
    () => resolveProviderRuntimeReference(redis, fallback.reference, {}, { ...baseEnvironment, R2_SECRET_ACCESS_KEY: "rotated-deployment-secret" }),
    /telah berubah/,
  );
  await saveProviderConnection(redis, { providerId: "s3-compatible", scope: "global", source: "platform-managed", isDefault: true }, "owner", baseEnvironment);
  const selected = await resolveProviderRuntimeForCapability(redis, "cloudStorage", {}, baseEnvironment);
  assert.equal(selected.providerId, "s3-compatible");
  assert.equal(objectStorageConfiguration(selected.environment).id, "s3-compatible");
  assert.equal(selected.environment.R2_SECRET_ACCESS_KEY, undefined);
  const pinned = await resolveProviderRuntime(redis, "s3-compatible", {}, baseEnvironment);
  assert.equal(objectStorageConfiguration(pinned.environment).id, "s3-compatible");
  await setProviderConnectionState(redis, { providerId: "s3-compatible", scope: "global", status: "paused" }, "owner");
  const afterPause = await resolveProviderRuntimeForCapability(redis, "cloudStorage", {}, baseEnvironment);
  assert.equal(afterPause.providerId, "cloudflare-r2");
});

test("provider connection check state is bounded and persists in the safe projection", async () => {
  const redis = new FakeRedis();
  await saveProviderConnection(redis, { providerId: "cloudflare-r2", scope: "global", source: "platform-managed" }, "owner", {});
  const checkedAt = "2026-07-21T00:00:00.000Z";
  const record = await recordProviderConnectionCheck(redis, { providerId: "cloudflare-r2", scope: "global" }, {
    provider: "cloudflare-r2", state: "ready", latencyMs: 42.5, message: "Endpoint dapat dijangkau", checkedAt,
  });
  assert.deepEqual(record.lastCheck, { provider: "cloudflare-r2", state: "ready", latencyMs: 42.5, message: "Endpoint dapat dijangkau", checkedAt });
  assert.deepEqual((await listProviderConnections(redis))[0].lastCheck, record.lastCheck);
  assert.doesNotMatch(JSON.stringify(record.lastCheck), /credential|secret|signed/i);
});

test("provider connection UI and API expose only masked control-plane operations", () => {
  const html = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");
  assert.match(html, /id="provider-connections-card"/);
  assert.match(html, /API key sendiri \(BYO\)/);
  assert.match(script, /data-provider-state="revoked"/);
  assert.match(script, /data-provider-test/);
  assert.match(script, /Nilai lama tidak dapat dilihat kembali/);
  assert.match(api, /action === "provider_connections"/);
  assert.doesNotMatch(script, /connection\.sealed|connection\.ciphertext|PROVIDER_CREDENTIAL_KEYS/);
});

test("provider control plane enforces role permissions and writes secret-safe audit", async () => {
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousKeys = process.env.PROVIDER_CREDENTIAL_KEYS;
  const previousActive = process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.PROVIDER_CREDENTIAL_KEYS = envV1.PROVIDER_CREDENTIAL_KEYS;
  process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION = "v1";
  try {
    const redis = new FakeRedis();
    await redis.set(sessionKey("audit-session"), { id: "audit-session", userId: "auditor-1", role: "superadmin", platformRole: "auditor", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("integration-session"), { id: "integration-session", userId: "integration-1", role: "superadmin", platformRole: "integration_admin", expiresAt: "2099-01-01T00:00:00.000Z" });
    const auditorCookie = await signedCookie("audit-session");
    const integrationCookie = await signedCookie("integration-session");
    const read = await providerConnectionsControl(redis, new Request("https://photoslive.test/api/platform?action=provider_connections", { headers: { cookie: auditorCookie } }));
    assert.equal(read.status, 200);
    const denied = await providerConnectionsControl(redis, new Request("https://photoslive.test/api/platform?action=provider_connections", { method: "POST", headers: { cookie: auditorCookie } }), { operation: "save", providerId: "cloudflare-r2", scope: "global", source: "byo", credentials });
    assert.equal(denied.status, 403);
    const created = await providerConnectionsControl(redis, new Request("https://photoslive.test/api/platform?action=provider_connections", { method: "POST", headers: { cookie: integrationCookie } }), { operation: "save", providerId: "cloudflare-r2", scope: "global", source: "byo", credentials, isDefault: true });
    assert.equal(created.status, 201);
    const response = JSON.stringify(await created.json());
    assert.doesNotMatch(response, /super-secret-9012|ciphertext|sealed/);
    const audit = (await redis.lrange("photoslive:audit:global", 0, 9)).join("\n");
    assert.match(audit, /provider_connection\.created/);
    assert.doesNotMatch(audit, /super-secret-9012|access-5678|account-1234|ciphertext|sealed/);
  } finally {
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousKeys === undefined) delete process.env.PROVIDER_CREDENTIAL_KEYS; else process.env.PROVIDER_CREDENTIAL_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION; else process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION = previousActive;
  }
});

test("provider test connection probes the selected adapter without exposing credentials", async () => {
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousKeys = process.env.PROVIDER_CREDENTIAL_KEYS;
  const previousActive = process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION;
  const previousFetch = globalThis.fetch;
  process.env.SESSION_SECRET = sessionSecret;
  process.env.PROVIDER_CREDENTIAL_KEYS = envV1.PROVIDER_CREDENTIAL_KEYS;
  process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION = "v1";
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try {
    const redis = new FakeRedis();
    await redis.set(sessionKey("integration-test-session"), { id: "integration-test-session", userId: "integration-1", role: "superadmin", platformRole: "integration_admin", expiresAt: "2099-01-01T00:00:00.000Z" });
    await saveProviderConnection(redis, { providerId: "cloudflare-r2", scope: "global", source: "byo", credentials, isDefault: true }, "integration-1");
    const cookie = await signedCookie("integration-test-session");
    const response = await providerConnectionsControl(redis, new Request("https://photoslive.test/api/platform?action=provider_connections", { method: "POST", headers: { cookie } }), {
      operation: "test", providerId: "cloudflare-r2", scope: "global", targetId: "",
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.check.provider, "cloudflare-r2");
    assert.equal(payload.check.state, "ready");
    assert.equal(typeof payload.check.checkedAt, "string");
    assert.doesNotMatch(JSON.stringify(payload), /super-secret-9012|access-5678|account-1234|ciphertext|sealed/);
    assert.deepEqual((await listProviderConnections(redis))[0].lastCheck, payload.check);
    const audit = (await redis.lrange("photoslive:audit:global", 0, 9)).join("\n");
    assert.match(audit, /provider_connection\.tested/);
    assert.doesNotMatch(audit, /super-secret-9012|access-5678|account-1234|ciphertext|sealed/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousKeys === undefined) delete process.env.PROVIDER_CREDENTIAL_KEYS; else process.env.PROVIDER_CREDENTIAL_KEYS = previousKeys;
    if (previousActive === undefined) delete process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION; else process.env.PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION = previousActive;
  }
});
