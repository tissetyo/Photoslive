import assert from "node:assert/strict";
import test from "node:test";
import { toggleMachine } from "../api/platform.mjs";
import { boothKey, machineKey, sessionKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
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

async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const signature = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${signature}`)}`;
}

test("machine access control rejects non-superadmin sessions", async () => {
  process.env.SESSION_SECRET = secret;
  const response = await toggleMachine(
    new MemoryRedis(),
    new Request("https://photoslive.test/api/platform?action=toggle_machine", { method: "POST" }),
    { machineId: "machine_1", enabled: false },
  );
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /superadmin/);
});

test("superadmin access toggle persists, changes booth resolution, and appends audit", async () => {
  process.env.SESSION_SECRET = secret;
  const redis = new MemoryRedis();
  const sessionId = "login_superadmin";
  const machine = { id: "machine_1", boothCode: "lobby-01", name: "Lobby", paired: true, accessEnabled: true };
  await redis.set(sessionKey(sessionId), { id: sessionId, userId: "super_1", role: "superadmin", expiresAt: "2099-01-01T00:00:00.000Z" });
  await redis.set(machineKey(machine.id), machine);
  await redis.set(boothKey(machine.boothCode), machine.id);
  const request = new Request("https://photoslive.test/api/platform?action=toggle_machine", {
    method: "POST",
    headers: { cookie: await signedCookie(sessionId) },
  });

  const response = await toggleMachine(redis, request, { machineId: machine.id, enabled: false });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).booth.enabled, false);
  assert.equal((await redis.get(machineKey(machine.id))).accessEnabled, false);
  const [globalAudit] = await redis.lrange("photoslive:audit:global", 0, 9);
  const record = JSON.parse(globalAudit);
  assert.equal(record.action, "booth.disabled");
  assert.equal(record.actorId, "super_1");
  assert.equal(record.target, machine.id);
});
