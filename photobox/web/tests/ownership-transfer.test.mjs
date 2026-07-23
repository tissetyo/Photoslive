import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { transferBoothOwnership } from "../api/platform.mjs";
import { boothKey, machineKey, sessionKey, userKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); this.lists = new Map(); this.evalCalls = 0; }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value)); return "OK";
  }
  async del(...keys) { let removed = 0; keys.forEach(key => { if (this.values.delete(key)) removed += 1; }); return removed; }
  async sadd(key, ...values) { const set = this.sets.get(key) || new Set(); values.forEach(value => set.add(value)); this.sets.set(key, set); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
  async srem(key, ...values) { const set = this.sets.get(key) || new Set(); let removed = 0; values.forEach(value => { if (set.delete(value)) removed += 1; }); return removed; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
  pipeline() {
    const operations = [];
    const pipeline = {
      set: (...args) => { operations.push(() => this.set(...args)); return pipeline; },
      sadd: (...args) => { operations.push(() => this.sadd(...args)); return pipeline; },
      lpush: (...args) => { operations.push(() => this.lpush(...args)); return pipeline; },
      ltrim: (...args) => { operations.push(() => this.ltrim(...args)); return pipeline; },
      exec: async () => Promise.all(operations.map(operation => operation())),
    };
    return pipeline;
  }
  async eval(script, keys, args) {
    this.evalCalls += 1;
    assert.match(script, /current\.role = "admin"/);
    const [boothCode, expectedOwnerId, targetId, timestamp] = args;
    const current = await this.get(keys[0]);
    const target = await this.get(keys[1]);
    if (!current || !target) throw new Error("MEMBER_MISSING");
    if (current.boothCode !== boothCode || target.boothCode !== boothCode) throw new Error("TENANT_MISMATCH");
    if (current.id !== expectedOwnerId || current.role !== "owner" || current.active === false) throw new Error("OWNER_CHANGED");
    if (target.id !== targetId || target.role === "owner" || target.active === false) throw new Error("TARGET_INVALID");
    current.role = "admin"; current.updatedAt = timestamp;
    target.role = "owner"; target.updatedAt = timestamp;
    await this.set(keys[0], current); await this.set(keys[1], target);
    return [JSON.stringify(current), JSON.stringify(target)];
  }
}

const secret = "photoslive-ownership-transfer-test-secret";
const rootPassword = "root-ownership-password";

async function credentialHash(value, salt = "abcdef0123456789abcdef0123456789") {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(value), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 120_000, hash: "SHA-256" }, material, 256);
  return `${salt}:${[...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const signature = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${signature}`)}`;
}

async function platformRequest(redis, platformRole = "platform_owner") {
  process.env.SESSION_SECRET = secret;
  process.env.SUPERADMIN_PASSWORD_HASH = await credentialHash(rootPassword);
  await redis.set(sessionKey(`login_${platformRole}`), { id: `login_${platformRole}`, userId: "superadmin", role: "superadmin", platformRole, expiresAt: "2099-01-01T00:00:00.000Z" });
  return new Request("https://photoslive.test/api/platform?action=booth_ownership", { method: "POST", headers: { cookie: await signedCookie(`login_${platformRole}`) } });
}

async function seedBooth(redis) {
  const boothCode = "gallery-one";
  await redis.set(boothKey(boothCode), "machine_1");
  await redis.set(machineKey("machine_1"), { machineId: "machine_1", boothCode, name: "Gallery One", accessEnabled: true });
  const owner = { id: "user_owner", boothCode, name: "Owner Lama", email: "old@example.test", role: "owner", active: true };
  const target = { id: "user_admin", boothCode, name: "Owner Baru", email: "new@example.test", role: "admin", active: true };
  const foreign = { id: "user_foreign", boothCode: "other", name: "Foreign", email: "foreign@example.test", role: "admin", active: true };
  for (const user of [owner, target, foreign]) await redis.set(userKey(user.id), user);
  await redis.sadd(`photoslive:booth:${boothCode}:users`, owner.id, target.id);
  await redis.sadd("photoslive:booth:other:users", foreign.id);
  for (const [user, id] of [[owner, "login_old"], [target, "login_new"]]) {
    await redis.set(sessionKey(id), { id, userId: user.id, boothCode, role: user.role, expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.sadd(`photoslive:user:${user.id}:sessions`, id);
  }
  return { boothCode, owner, target, foreign };
}

test("platform owner transfers booth ownership atomically, revokes sessions, audits, and queues notifications", async () => {
  const redis = new MemoryRedis();
  const { boothCode, owner, target } = await seedBooth(redis);
  const response = await transferBoothOwnership(redis, await platformRequest(redis), { boothCode, targetUserId: target.id, confirmation: boothCode, reauthPassword: rootPassword });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(redis.evalCalls, 1);
  assert.equal((await redis.get(userKey(owner.id))).role, "admin");
  assert.equal((await redis.get(userKey(target.id))).role, "owner");
  assert.equal(await redis.get(sessionKey("login_old")), null);
  assert.equal(await redis.get(sessionKey("login_new")), null);
  assert.equal(result.sessionsRevoked, 2);
  assert.equal(result.notificationsQueued, 2);
  const audit = (await redis.lrange(`photoslive:booth:${boothCode}:audit`, 0, 20)).map(JSON.parse);
  assert.ok(audit.some(item => item.action === "booth.ownership_transferred" && item.detail.previousOwnerId === owner.id && item.detail.newOwnerId === target.id));
  assert.equal((await redis.lrange("photoslive:email-deliveries", 0, 20)).length, 2);
});

test("ownership transfer enforces platform owner permission, tenant membership, confirmation, and reauthentication", async () => {
  const redis = new MemoryRedis();
  const { boothCode, target, foreign } = await seedBooth(redis);
  assert.equal((await transferBoothOwnership(redis, await platformRequest(redis, "support"), { boothCode, targetUserId: target.id, confirmation: boothCode, reauthPassword: rootPassword })).status, 403);
  assert.equal((await transferBoothOwnership(redis, await platformRequest(redis), { boothCode, targetUserId: target.id, confirmation: boothCode, reauthPassword: "wrong" })).status, 401);
  assert.equal((await transferBoothOwnership(redis, await platformRequest(redis), { boothCode, targetUserId: target.id, confirmation: "wrong", reauthPassword: rootPassword })).status, 400);
  assert.equal((await transferBoothOwnership(redis, await platformRequest(redis), { boothCode, targetUserId: foreign.id, confirmation: boothCode, reauthPassword: rootPassword })).status, 409);
  assert.equal(redis.evalCalls, 0);
});

test("superadmin ownership UI exposes a guarded modal with real API persistence states", () => {
  const html = fs.readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(html, /id="ownership-dialog"/);
  assert.match(html, /id="ownership-confirmation"/);
  assert.match(html, /id="ownership-password"/);
  assert.match(js, /can\("platform\.ownership\.write"\)/);
  assert.match(js, /api\("booth_ownership"/);
  assert.match(js, /Memindahkan kepemilikan dan menghentikan sesi lama/);
  assert.match(js, /notificationsQueued/);
});
