import assert from "node:assert/strict";
import test from "node:test";
import { consumeRateLimit, PLATFORM_RATE_LIMITS } from "../api/_rate_limit.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.expiries = new Map(); }
  async incr(key) { const value = Number(this.values.get(key) || 0) + 1; this.values.set(key, value); return value; }
  async expire(key, seconds) { this.expiries.set(key, seconds); return 1; }
}

test("authentication limiter blocks attempts above the bounded window", async () => {
  const redis = new MemoryRedis();
  const request = new Request("https://photoslive.test/api/platform", { headers: { "x-forwarded-for": "203.0.113.7" } });
  const rule = { limit: 2, windowSeconds: 60 };
  assert.equal((await consumeRateLimit(redis, request, "login", rule, "booth-a")).allowed, true);
  assert.equal((await consumeRateLimit(redis, request, "login", rule, "booth-a")).allowed, true);
  const blocked = await consumeRateLimit(redis, request, "login", rule, "booth-a");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfter >= 1 && blocked.retryAfter <= 60);
});

test("rate-limit identity is tenant-scoped and stores no raw address or email", async () => {
  const redis = new MemoryRedis();
  const request = new Request("https://photoslive.test/api/platform", { headers: { "x-forwarded-for": "198.51.100.24" } });
  const rule = { limit: 1, windowSeconds: 60 };
  await consumeRateLimit(redis, request, "login", rule, "owner@example.test");
  const other = await consumeRateLimit(redis, request, "login", rule, "other@example.test");
  assert.equal(other.allowed, true);
  const keys = [...redis.values.keys()];
  assert.ok(keys.every(key => !key.includes("198.51.100.24") && !key.includes("example.test")));
  assert.deepEqual(Object.keys(PLATFORM_RATE_LIMITS).sort(), ["booth_ownership", "delete_public_session", "forgot_password", "login", "platform_staff_activate", "qris_create", "setup", "superadmin_login", "validate_setup"]);
});
