import assert from "node:assert/strict";
import test from "node:test";
import { safeBoothMembers } from "../api/platform.mjs";
import { userKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async sadd(key, ...values) { const set = this.sets.get(key) || new Set(); values.forEach(value => set.add(value)); this.sets.set(key, set); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
}

test("superadmin membership projection is tenant-scoped and strips credential hashes", async () => {
  const redis = new MemoryRedis();
  const owner = { id: "owner_1", name: "Zoe", email: "ZOE@EXAMPLE.COM", role: "owner", active: true, passwordHash: "secret-password-hash", pinHash: "secret-pin-hash", createdAt: "2026-07-21T00:00:00.000Z" };
  const operator = { id: "operator_1", name: "Operator", email: "operator@example.com", role: "operator", active: false, passwordHash: "another-secret", pinHash: "another-pin" };
  const foreign = { id: "foreign_1", email: "foreign@example.com", role: "owner", passwordHash: "foreign-secret" };
  for (const user of [owner, operator, foreign]) await redis.set(userKey(user.id), user);
  await redis.sadd("photoslive:booth:lobby-01:users", operator.id, owner.id);
  await redis.sadd("photoslive:booth:other-booth:users", foreign.id);

  const members = await safeBoothMembers(redis, "LOBBY-01");
  assert.deepEqual(members.map(member => member.id), [owner.id, operator.id]);
  assert.equal(members[0].email, "zoe@example.com");
  assert.equal(members[1].active, false);
  assert.ok(members.every(member => !Object.hasOwn(member, "passwordHash") && !Object.hasOwn(member, "pinHash")));
  assert.ok(!JSON.stringify(members).includes("secret"));
});
