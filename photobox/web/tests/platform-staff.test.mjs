import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { activatePlatformStaff, forgotPassword, platformStaffControl, resolveResetRequest, superadminLogin } from "../api/platform.mjs";
import { sessionKey, userKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
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
}

const secret = "photoslive-platform-staff-test-secret-2026";
const rootPassword = "root-control-plane-password";

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

async function ownerRequest(redis, method = "POST") {
  process.env.SESSION_SECRET = secret;
  process.env.SUPERADMIN_PASSWORD_HASH = await credentialHash(rootPassword);
  await redis.set(sessionKey("login_root"), { id: "login_root", userId: "superadmin", role: "superadmin", platformRole: "platform_owner", expiresAt: "2099-01-01T00:00:00.000Z" });
  return new Request("https://photoslive.test/api/platform?action=platform_staff", { method, headers: { cookie: await signedCookie("login_root") } });
}

test("platform owner can invite and activate staff without exposing credentials", async () => {
  const redis = new MemoryRedis();
  const request = await ownerRequest(redis);
  const invitedResponse = await platformStaffControl(redis, request, { operation: "invite", name: "Finance Person", email: "finance@example.test", platformRole: "finance_admin", reauthPassword: rootPassword });
  const invited = await invitedResponse.json();
  assert.equal(invitedResponse.status, 201);
  assert.match(invited.activationUrl, /\/superadmin\?invite=/);
  assert.equal(invited.invitationEmailQueued, true);
  assert.equal("inviteHash" in invited.user, false);
  assert.equal("passwordHash" in invited.user, false);
  const url = new URL(invited.activationUrl);
  const token = url.searchParams.get("invite");
  const stored = await redis.get(`photoslive:platform-staff:${invited.user.id}`);
  assert.match(stored.inviteHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(stored).includes(token), false);
  const invitationDelivery = [...redis.values.values()].find(value => value?.template === "platform_invitation");
  assert.ok(invitationDelivery?.secretEnvelope);
  assert.equal(JSON.stringify(invitationDelivery).includes(token), false);

  const activatedResponse = await activatePlatformStaff(redis, { email: invited.user.email, token, password: "new-finance-password-2026" });
  const activated = await activatedResponse.json();
  assert.equal(activatedResponse.status, 200);
  assert.equal(activated.user.status, "active");
  assert.equal("passwordHash" in activated.user, false);
  assert.equal((await activatePlatformStaff(redis, { email: invited.user.email, token, password: "new-finance-password-2026" })).status, 410);

  const listed = await (await platformStaffControl(redis, await ownerRequest(redis, "GET"))).json();
  assert.equal(listed.staff.length, 1);
  assert.equal(listed.staff[0].platformRole, "finance_admin");
  assert.equal("passwordHash" in listed.staff[0], false);
});

test("staff mutations validate roles, require reauthentication, revoke sessions, and audit", async () => {
  const redis = new MemoryRedis();
  const request = await ownerRequest(redis);
  const invited = await (await platformStaffControl(redis, request, { operation: "invite", name: "Support Person", email: "support@example.test", platformRole: "support", reauthPassword: rootPassword })).json();
  assert.equal((await platformStaffControl(redis, request, { operation: "set_role", staffId: invited.user.id, platformRole: "made_up_owner", reauthPassword: rootPassword })).status, 400);
  assert.equal((await platformStaffControl(redis, request, { operation: "suspend", staffId: invited.user.id, reauthPassword: "wrong" })).status, 401);

  const record = await redis.get(`photoslive:platform-staff:${invited.user.id}`);
  record.status = "active";
  record.passwordHash = await credentialHash("support-password-2026", "1234567890abcdef1234567890abcdef");
  delete record.inviteHash;
  await redis.set(`photoslive:platform-staff:${record.id}`, record);
  await redis.set(sessionKey("login_support"), { id: "login_support", userId: record.id, role: "superadmin", platformRole: "support", expiresAt: "2099-01-01T00:00:00.000Z" });
  await redis.sadd(`photoslive:user:${record.id}:sessions`, "login_support");

  const suspendedResponse = await platformStaffControl(redis, request, { operation: "suspend", staffId: record.id, reauthPassword: rootPassword });
  const suspended = await suspendedResponse.json();
  assert.equal(suspendedResponse.status, 200);
  assert.equal(suspended.user.status, "suspended");
  assert.equal(suspended.sessionsRevoked, 1);
  assert.equal(await redis.get(sessionKey("login_support")), null);
  const audit = (await redis.lrange("photoslive:booth:platform:audit", 0, 20)).map(JSON.parse);
  assert.ok(audit.some(item => item.action === "platform_staff.suspended" && item.target === record.id));
});

test("bootstrap emergency login and recovery resolution are audited", async () => {
  const redis = new MemoryRedis();
  process.env.SESSION_SECRET = secret;
  process.env.SUPERADMIN_EMAIL = "root@example.test";
  process.env.SUPERADMIN_PASSWORD_HASH = await credentialHash(rootPassword);
  process.env.SUPERADMIN_ROLE = "platform_owner";

  const loginResponse = await superadminLogin(redis, { email: "root@example.test", password: rootPassword });
  assert.equal(loginResponse.status, 200);
  assert.match(loginResponse.headers.get("set-cookie"), /__Host-photoslive_session=/);

  const user = { id: "user_recovery", boothCode: "booth-one", email: "owner@example.test", name: "Owner", role: "owner", active: true };
  await redis.set(userKey(user.id), user);
  await redis.set(`photoslive:email:${user.email}`, user.id);
  const resetResponse = await forgotPassword(redis, { email: user.email, message: "Need help" });
  const reset = await resetResponse.json();
  assert.equal(resetResponse.status, 201);

  const resolvedResponse = await resolveResetRequest(redis, await ownerRequest(redis), { requestId: reset.request.id, note: "Sent manually" });
  const resolved = await resolvedResponse.json();
  assert.equal(resolvedResponse.status, 200);
  assert.equal(resolved.request.status, "email_sent");
  const audit = (await redis.lrange("photoslive:audit:global", 0, 30)).map(JSON.parse);
  assert.ok(audit.some(item => item.action === "platform_staff.login" && item.target === "superadmin"));
  assert.ok(audit.some(item => item.action === "password_recovery.resolved" && item.target === reset.request.id));
});

test("superadmin UI wires invitation, activation, retries, sensitive actions, and safe states", () => {
  const html = fs.readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(html, /id="platform-activate"/);
  assert.match(html, /id="platform-staff-invite-form"/);
  assert.match(html, /id="platform-staff-retry"/);
  assert.match(html, /id="platform-staff-dialog"/);
  assert.match(js, /api\("platform_staff_activate"/);
  assert.match(js, /operation: "invite"/);
  assert.match(js, /data-staff-action="revoke_sessions"/);
  assert.match(js, /Konfirmasi password Anda/);
  assert.match(js, /Tim platform tidak dapat dimuat/);
  assert.match(js, /navigator\.clipboard\.writeText/);
});
