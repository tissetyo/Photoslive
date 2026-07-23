import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteFeatureFlagOverride,
  listFeatureFlagOverrides,
  resolveFeatureFlags,
  setFeatureFlagOverride,
  validateFeatureFlagInput,
} from "../api/_feature_flags.mjs";

class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async sadd(key, ...values) { const target = this.sets.get(key) || new Set(); values.forEach(value => target.add(value)); this.sets.set(key, target); return values.length; }
  async srem(key, ...values) { const target = this.sets.get(key) || new Set(); values.forEach(value => target.delete(value)); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
}

test("feature flag precedence is default, global, organization, then booth", async () => {
  const redis = new FakeRedis();
  assert.equal((await resolveFeatureFlags(redis, { boothCode: "booth-a" })).direct_object_upload.enabled, true);
  await setFeatureFlagOverride(redis, { key: "direct_object_upload", scope: "global", enabled: false }, "superadmin");
  await setFeatureFlagOverride(redis, { key: "direct_object_upload", scope: "organization", targetId: "org-1", enabled: true }, "superadmin");
  await setFeatureFlagOverride(redis, { key: "direct_object_upload", scope: "booth", targetId: "booth-a", enabled: false }, "superadmin");
  const boothA = await resolveFeatureFlags(redis, { organizationId: "org-1", boothCode: "booth-a" });
  const boothB = await resolveFeatureFlags(redis, { organizationId: "org-1", boothCode: "booth-b" });
  const boothC = await resolveFeatureFlags(redis, { organizationId: "org-2", boothCode: "booth-c" });
  assert.deepEqual([boothA.direct_object_upload.enabled, boothA.direct_object_upload.sourceScope], [false, "booth"]);
  assert.deepEqual([boothB.direct_object_upload.enabled, boothB.direct_object_upload.sourceScope], [true, "organization"]);
  assert.deepEqual([boothC.direct_object_upload.enabled, boothC.direct_object_upload.sourceScope], [false, "global"]);
});

test("booth override never leaks into another tenant", async () => {
  const redis = new FakeRedis();
  await setFeatureFlagOverride(redis, { key: "tablet_pwa", scope: "booth", targetId: "booth-a", enabled: true }, "superadmin");
  assert.equal((await resolveFeatureFlags(redis, { boothCode: "booth-a" })).tablet_pwa.enabled, true);
  assert.equal((await resolveFeatureFlags(redis, { boothCode: "booth-b" })).tablet_pwa.enabled, false);
});

test("feature flag writes are allowlisted, bounded, listed, and removable", async () => {
  const redis = new FakeRedis();
  assert.throws(() => validateFeatureFlagInput({ key: "unknown", scope: "global", enabled: true }), /tidak dikenal/);
  assert.throws(() => validateFeatureFlagInput({ key: "tablet_pwa", scope: "booth", enabled: true }), /Target/);
  assert.throws(() => validateFeatureFlagInput({ key: "tablet_pwa", scope: "global", enabled: "true" }), /boolean/);
  assert.throws(() => validateFeatureFlagInput({ key: "tablet_pwa", scope: "global", enabled: true, config: { payload: "x".repeat(4_100) } }), /terlalu besar/);
  const record = await setFeatureFlagOverride(redis, { key: "tablet_pwa", scope: "global", enabled: true }, "superadmin");
  assert.equal((await listFeatureFlagOverrides(redis)).length, 1);
  assert.equal((await deleteFeatureFlagOverride(redis, record)).id, record.id);
  assert.equal((await listFeatureFlagOverrides(redis)).length, 0);
});
