import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { expirePostgresSession, persistPostgresSession, postgresSessionStatus, readPostgresSession, requestPostgresSessionDeletion } from "../api/_postgres_sessions.mjs";
import { publicPhotoSession, publicPhotoSessionFile } from "../api/platform.mjs";
import { boothKey, machineKey } from "../api/_store.mjs";

const environment = {
  PHOTOSLIVE_POSTGRES_SESSIONS: "primary",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-only-session-secret",
  SESSION_SECRET: "postgres-session-test-secret-value-2026",
};
const storageEnvironment = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET: "photoslive-test",
};

const session = {
  boothCode: "booth-one", shareCode: "0123456789abcdef0123456789abcdef", status: "completed",
  machineId: "machine_one", localSessionId: "local_123", frameId: "frame_one", photoSlots: 3,
  files: [{ id: "capture-1", kind: "capture", slotIndex: 1, contentType: "image/jpeg", size: 1234, checksumSha256: "a".repeat(64), url: "/file/1", uploadedAt: "2026-07-22T10:00:00.000Z" }],
  fileManifests: [{ id: "capture-1", storageMode: "object-storage", storageProvider: "cloudflare-r2", objectKey: "sessions/booth-one/0123456789abcdef0123456789abcdef/capture-1.jpg", etag: "safe-etag" }],
  createdAt: "2026-07-22T10:00:00.000Z", completedAt: "2026-07-22T10:02:00.000Z",
  expiresAt: "2099-07-23T10:00:00.000Z", updatedAt: "2026-07-22T10:02:00.000Z",
};

class FakeRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async zadd() { return 1; }
}

test("session PostgreSQL mode is explicit and bounded", () => {
  assert.equal(postgresSessionStatus({}).enabled, false);
  assert.equal(postgresSessionStatus(environment).primary, true);
  assert.equal(postgresSessionStatus({ ...environment, PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "999999" }).timeoutMs, 5_000);
});

test("session persistence sends bounded metadata through one service-role RPC", async () => {
  let request;
  const result = await persistPostgresSession(session, {
    environment,
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return Response.json(session);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.shareCode, session.shareCode);
  assert.match(request.url, /photoslive_persist_photo_session$/);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(body.p_metadata).sort(), ["fileManifests", "files", "frameId", "localSessionId", "machineId", "photoSlots"]);
  assert.equal(body.p_metadata.fileManifests.length, 1);
  assert.equal(JSON.stringify(result).includes(environment.SUPABASE_SERVICE_ROLE_KEY), false);
});

test("snapshot and expiry use separate RPC contracts", async () => {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return url.endsWith("expire_photo_session") ? Response.json(true) : Response.json(session);
  };
  assert.equal((await readPostgresSession(session.boothCode, session.shareCode, { environment, fetchImplementation })).status, "completed");
  assert.equal((await expirePostgresSession(session.boothCode, session.shareCode, { environment, fetchImplementation })).ok, true);
  assert.match(calls[0].url, /photo_session_snapshot$/);
  assert.match(calls[1].url, /expire_photo_session$/);
});

test("deletion request is durable and separate from final expiry", async () => {
  const calls = [];
  const requestedSession = { ...session, deletionRequested: true, deletionRequestedAt: "2026-07-22T10:05:00.000Z" };
  const result = await requestPostgresSessionDeletion(session.boothCode, session.shareCode, {
    environment,
    fetchImplementation: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return Response.json(requestedSession);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.deletionRequested, true);
  assert.match(calls[0].url, /request_photo_session_deletion$/);
});

test("primary public read recovers metadata but strips machine identity", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment, { PHOTOSLIVE_POSTGRES_DIRECTORY: "off" });
  globalThis.fetch = async () => Response.json(session);
  try {
    const redis = new FakeRedis();
    await redis.set(boothKey("booth-one"), "machine_one");
    await redis.set(machineKey("machine_one"), { id: "machine_one", boothCode: "booth-one", name: "Booth One", location: "Hall", paired: true, accessEnabled: true });
    const response = await publicPhotoSession(redis, { booth: session.boothCode, session: session.shareCode });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.session.shareCode, session.shareCode);
    assert.equal("machineId" in body.session, false);
    assert.equal("localSessionId" in body.session, false);
    assert.equal("fileManifests" in body.session, false);
    assert.equal("machineId" in body.booth, false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("invalid session metadata fails before any network request", async () => {
  let called = false;
  await assert.rejects(() => persistPostgresSession({ ...session, shareCode: "short" }, { environment, fetchImplementation: async () => { called = true; } }), /tidak valid/);
  assert.equal(called, false);
});

test("primary recovery rehydrates a private object manifest without exposing its key", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment, storageEnvironment, { PHOTOSLIVE_POSTGRES_DIRECTORY: "off" });
  globalThis.fetch = async () => Response.json(session);
  try {
    const redis = new FakeRedis();
    await redis.set(boothKey("booth-one"), "machine_one");
    await redis.set(machineKey("machine_one"), { id: "machine_one", boothCode: "booth-one", name: "Booth One", paired: true, accessEnabled: true });
    const metadata = await publicPhotoSession(redis, { booth: session.boothCode, session: session.shareCode });
    const metadataBody = await metadata.json();
    assert.equal(JSON.stringify(metadataBody).includes("objectKey"), false);
    assert.equal(JSON.stringify(metadataBody).includes("cloudflare-r2"), false);
    const download = await publicPhotoSessionFile(redis, { booth: session.boothCode, session: session.shareCode, file: "capture-1" });
    assert.equal(download.status, 302);
    const location = new URL(download.headers.get("location"));
    assert.equal(location.host, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    assert.equal(location.pathname, `/photoslive-test/${session.fileManifests[0].objectKey}`);
    const cached = await redis.get(`photoslive:public-session-file:${session.boothCode}:${session.shareCode}:capture-1`);
    assert.equal(cached.objectKey, session.fileManifests[0].objectKey);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("manifest validation rejects cross-session object keys", async () => {
  let request;
  const result = await persistPostgresSession({
    ...session,
    fileManifests: [...session.fileManifests, { ...session.fileManifests[0], id: "capture-1", objectKey: "sessions/another-booth/private/file.jpg" }],
  }, {
    environment,
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return Response.json(session);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(request.options.body).p_metadata.fileManifests.map(item => item.objectKey), [session.fileManifests[0].objectKey]);
});

test("session migration is service-role-only and prevents terminal regression", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260722150000_photo_session_metadata.sql", import.meta.url), "utf8");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /when public\.photo_sessions\.status = 'expired' then 'expired'/);
  assert.match(sql, /when public\.photo_sessions\.status = 'completed'/);
  assert.match(sql, /deletionRequested/);
  assert.match(sql, /revoke all on function public\.photoslive_persist_photo_session[\s\S]+authenticated/);
  assert.match(sql, /grant execute on function public\.photoslive_persist_photo_session[\s\S]+service_role/);
  assert.doesNotMatch(sql, /grant execute[\s\S]+photoslive_persist_photo_session[\s\S]+to authenticated/);
  const bridge = readFileSync(new URL("../api/bridge.mjs", import.meta.url), "utf8");
  const agent = readFileSync(new URL("../../agent.py", import.meta.url), "utf8");
  assert.match(bridge, /fileManifests/);
  assert.match(bridge, /persistPostgresSession\(record\)/);
  assert.ok((agent.match(/cloud_url\(config, "sync_session_metadata"\)/g) || []).length >= 2);
  const deletionSql = readFileSync(new URL("../../../supabase/migrations/20260722160000_photo_session_deletion_request.sql", import.meta.url), "utf8");
  assert.match(deletionSql, /pg_advisory_xact_lock/);
  assert.match(deletionSql, /deletionRequestedAt/);
  assert.match(deletionSql, /revoke all[\s\S]+authenticated/);
  assert.match(deletionSql, /grant execute[\s\S]+service_role/);
});
