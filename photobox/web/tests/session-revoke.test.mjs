import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { clearCookie, currentUser, logout, revokeUserSessions, updateProfile } from "../api/platform.mjs";
import { boothKey, machineKey, sessionKey, userKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async del(...keys) { keys.forEach(key => this.values.delete(key)); return keys.length; }
  async sadd(key, ...values) { const set = this.sets.get(key) || new Set(); values.forEach(value => set.add(value)); this.sets.set(key, set); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
  async srem(key, ...values) { const set = this.sets.get(key) || new Set(); let removed = 0; values.forEach(value => { if (set.delete(value)) removed += 1; }); return removed; }
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

const secret = "photoslive-test-secret-that-is-long-enough-2026";
const indexKey = userId => `photoslive:user:${userId}:sessions`;

async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const signature = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${signature}`)}`;
}

async function seedSession(redis, id, userId, role, boothCode = "lobby-01") {
  const session = { id, userId, role, boothCode, expiresAt: "2099-01-01T00:00:00.000Z" };
  await redis.set(sessionKey(id), session);
  await redis.sadd(indexKey(userId), id);
  return session;
}

test("owner can provision a remote password without exposing its hash", async () => {
  process.env.SESSION_SECRET = secret;
  const redis = new MemoryRedis();
  const owner = { id: "user_owner", boothCode: "lobby-01", machineId: "machine_1", role: "owner", name: "Owner", email: "owner@example.test", active: true, passwordHash: "" };
  await redis.set(userKey(owner.id), owner);
  await redis.set(machineKey(owner.machineId), { id: owner.machineId, boothCode: owner.boothCode, accessEnabled: true, paired: true });
  await redis.set(boothKey(owner.boothCode), owner.machineId);
  await seedSession(redis, "login_owner", owner.id, owner.role);
  const request = new Request("https://photoslive.test/api/platform?action=profile", { method: "POST", headers: { cookie: await signedCookie("login_owner") } });

  const before = await (await currentUser(redis, request)).json();
  assert.equal(before.user.hasRemotePassword, false);
  assert.equal("passwordHash" in before.user, false);

  const response = await updateProfile(redis, request, { password: "remote-password-2026" });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.user.hasRemotePassword, true);
  assert.equal("passwordHash" in payload.user, false);
  const stored = await redis.get(userKey(owner.id));
  assert.notEqual(stored.passwordHash, "remote-password-2026");
  assert.match(stored.passwordHash, /^[a-f0-9]+:[a-f0-9]{64}$/);
  const [rawAudit] = await redis.lrange("photoslive:booth:lobby-01:audit", 0, 0);
  assert.deepEqual(JSON.parse(rawAudit).detail.changed, ["remote_password"]);
});

test("owner can revoke another booth user's sessions and the action is audited", async () => {
  process.env.SESSION_SECRET = secret;
  const redis = new MemoryRedis();
  const owner = { id: "user_owner", boothCode: "lobby-01", role: "owner", name: "Owner" };
  const operator = { id: "user_operator", boothCode: "lobby-01", role: "operator", name: "Operator" };
  await redis.set(userKey(owner.id), owner);
  await redis.set(userKey(operator.id), operator);
  await seedSession(redis, "login_owner", owner.id, owner.role);
  await seedSession(redis, "login_operator_1", operator.id, operator.role);
  await seedSession(redis, "login_operator_2", operator.id, operator.role);

  const request = new Request("https://photoslive.test/api/platform?action=revoke_sessions", { method: "POST", headers: { cookie: await signedCookie("login_owner") } });
  const response = await revokeUserSessions(redis, request, { userId: operator.id });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { revoked: 2, currentRevoked: false });
  assert.equal(await redis.get(sessionKey("login_operator_1")), null);
  assert.equal(await redis.get(sessionKey("login_operator_2")), null);
  assert.ok(await redis.get(sessionKey("login_owner")));
  assert.deepEqual(await redis.smembers(indexKey(operator.id)), []);
  const [rawAudit] = await redis.lrange("photoslive:booth:lobby-01:audit", 0, 0);
  const audit = JSON.parse(rawAudit);
  assert.equal(audit.action, "user.sessions_revoked");
  assert.equal(audit.target, operator.id);
  assert.equal(audit.detail.count, 2);
});

test("admin cannot revoke an owner's sessions", async () => {
  process.env.SESSION_SECRET = secret;
  const redis = new MemoryRedis();
  const admin = { id: "user_admin", boothCode: "lobby-01", role: "admin" };
  const owner = { id: "user_owner", boothCode: "lobby-01", role: "owner" };
  await redis.set(userKey(admin.id), admin);
  await redis.set(userKey(owner.id), owner);
  await seedSession(redis, "login_admin", admin.id, admin.role);
  await seedSession(redis, "login_owner", owner.id, owner.role);
  const request = new Request("https://photoslive.test/api/platform?action=revoke_sessions", { method: "POST", headers: { cookie: await signedCookie("login_admin") } });

  const response = await revokeUserSessions(redis, request, { userId: owner.id });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /pemilik/i);
  assert.ok(await redis.get(sessionKey("login_owner")));
});

test("logout invalidates the server-side session and clears its protected cookie", async () => {
  process.env.SESSION_SECRET = secret;
  const redis = new MemoryRedis();
  await seedSession(redis, "login_current", "user_current", "owner");
  const request = new Request("https://photoslive.test/api/platform?action=logout", { method: "POST", headers: { cookie: await signedCookie("login_current") } });

  const response = await logout(redis, request);
  assert.equal(response.status, 200);
  assert.equal(await redis.get(sessionKey("login_current")), null);
  assert.deepEqual(await redis.smembers(indexKey("user_current")), []);
  assert.equal(response.headers.get("set-cookie"), clearCookie);
});

test("admin user list exposes a real revoke-session action with disabled, success, and error states", () => {
  const html = fs.readFileSync(new URL("../admin.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(html, /<th>SESI LOGIN<\/th><th>AKSI<\/th>/);
  assert.match(app, /class="button secondary compact revoke-user-sessions"/);
  assert.match(app, /user\.activeSessions \? "" : "disabled"/);
  assert.match(app, /platformApi\("revoke_sessions"/);
  assert.match(app, /button\.textContent = "Memproses…"/);
  assert.match(app, /toast\(error\.message, "error"\)/);
});
