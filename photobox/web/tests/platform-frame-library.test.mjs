import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { platformFrameLibraryControl } from "../api/platform.mjs";
import { sessionKey } from "../api/_store.mjs";

class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async sadd(key, ...values) { const target = this.sets.get(key) || new Set(); values.forEach(value => target.add(value)); this.sets.set(key, target); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
  async mget(...keys) { return Promise.all(keys.map(key => this.get(key))); }
}

const sessionSecret = "platform-frame-library-test-secret-2026";

async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const hex = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${hex}`)}`;
}

async function requestFor(redis, session, method = "GET") {
  await redis.set(sessionKey(session.id), session);
  return new Request("https://photoslive.example/api/platform?action=platform_frame_library", { method, headers: { cookie: await signedCookie(session.id), "content-type": "application/json" } });
}

async function seedFrame(redis) {
  const record = {
    id: "platform-frame_example",
    name: "Photo Strip Festival.webp",
    contentType: "image/webp",
    size: 204800,
    checksumSha256: "a".repeat(64),
    objectKey: "platform/frame-library/private-object.webp",
    storageProvider: "cloudflare-r2",
    createdBy: "platform-owner",
    createdAt: "2026-07-22T01:00:00.000Z",
  };
  await redis.set(`photoslive:platform:frame-library:${record.id}`, record);
  await redis.sadd("photoslive:platform:frame-library", record.id);
  return record;
}

test("booth admin can list and download-safe platform frames without storage internals", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = sessionSecret;
  try {
    const redis = new FakeRedis();
    await seedFrame(redis);
    const request = await requestFor(redis, { id: "booth-admin-session", userId: "booth-admin", role: "admin", boothCode: "booth-a" });
    const response = await platformFrameLibraryControl(redis, request, {});
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.canUpload, false);
    assert.equal(payload.frames.length, 1);
    assert.match(payload.frames[0].previewUrl, /platform_frame_download/);
    assert.match(payload.frames[0].downloadUrl, /download=1/);
    assert.equal("objectKey" in payload.frames[0], false);
    assert.equal("storageProvider" in payload.frames[0], false);
  } finally { process.env.SESSION_SECRET = previousSecret; }
});

test("booth admin cannot upload while platform owner receives upload capability", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = sessionSecret;
  try {
    const redis = new FakeRedis();
    const boothRequest = await requestFor(redis, { id: "booth-admin-write", userId: "booth-admin", role: "owner", boothCode: "booth-a" }, "POST");
    const denied = await platformFrameLibraryControl(redis, boothRequest, { operation: "prepare" });
    assert.equal(denied.status, 403);

    const ownerRequest = await requestFor(redis, { id: "platform-owner-session", userId: "superadmin", role: "superadmin", platformRole: "platform_owner" });
    const allowed = await platformFrameLibraryControl(redis, ownerRequest, {});
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).canUpload, true);
  } finally { process.env.SESSION_SECRET = previousSecret; }
});

test("platform frame UI provides real upload, retry, pagination, preview, and download flows", () => {
  const superadminHtml = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const superadminScript = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  const adminHtml = readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  const adminScript = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");

  assert.match(superadminHtml, /id="platform-frame-upload"/);
  assert.match(superadminScript, /operation: "prepare"/);
  assert.match(superadminScript, /operation: "finalize"/);
  assert.match(superadminScript, /fetch\(prepared\.upload\.url/);
  assert.match(adminHtml, /id="platform-frame-library-grid"/);
  assert.match(adminHtml, /id="platform-frame-library-pagination"/);
  assert.match(adminScript, /platformApi\("platform_frame_library"\)/);
  assert.match(adminScript, /frame\.downloadUrl/);
  assert.match(api, /platform\.integrations\.write/);
  assert.match(api, /platform_frame\.downloaded/);
});
