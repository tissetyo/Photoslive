import assert from "node:assert/strict";
import test from "node:test";

import {
  deleteFinancePolicy,
  listFinancePolicies,
  resolvePlatformFeePolicy,
  setFinancePolicy,
} from "../api/_finance_policy.mjs";

class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async sadd(key, value) { const values = this.sets.get(key) || new Set(); values.add(value); this.sets.set(key, values); return 1; }
  async srem(key, value) { return this.sets.get(key)?.delete(value) ? 1 : 0; }
  async smembers(key) { return [...(this.sets.get(key) || [])]; }
}

test("platform fee policy resolves booth, global, then environment without changing old snapshots", async () => {
  const redis = new FakeRedis();
  assert.deepEqual(await resolvePlatformFeePolicy(redis, "booth-a", { PHOTOSLIVE_PLATFORM_FEE_BPS: "250" }), {
    platformFeeBps: 250, scope: "environment", policyId: null,
  });
  const global = await setFinancePolicy(redis, { scope: "global", platformFeeBps: 500 }, "finance-1");
  assert.equal((await resolvePlatformFeePolicy(redis, "booth-a", {})).platformFeeBps, 500);
  const booth = await setFinancePolicy(redis, { scope: "booth", targetId: "BOOTH-A", platformFeeBps: 725 }, "finance-2");
  assert.equal((await resolvePlatformFeePolicy(redis, "booth-a", {})).platformFeeBps, 725);
  assert.equal(booth.targetId, "booth-a");
  assert.equal(global.updatedBy, "finance-1");

  assert.equal(await deleteFinancePolicy(redis, { scope: "booth", targetId: "booth-a" }), true);
  assert.equal((await resolvePlatformFeePolicy(redis, "booth-a", {})).platformFeeBps, 500);
  await assert.rejects(deleteFinancePolicy(redis, { scope: "global" }), /tidak dapat dihapus/);
});

test("finance policy validates fee bounds and lists an explicit environment default", async () => {
  const redis = new FakeRedis();
  await assert.rejects(setFinancePolicy(redis, { scope: "booth", targetId: "", platformFeeBps: 100 }), /wajib dipilih/);
  await assert.rejects(setFinancePolicy(redis, { scope: "global", platformFeeBps: 10_001 }), /antara 0 dan 10000/);
  await assert.rejects(setFinancePolicy(redis, { scope: "organization", targetId: "org-a", platformFeeBps: 100 }), /Scope/);
  const policies = await listFinancePolicies(redis, { PHOTOSLIVE_PLATFORM_FEE_BPS: "350" });
  assert.deepEqual(policies.map(item => ({ scope: item.scope, fee: item.platformFeeBps, actor: item.updatedBy })), [
    { scope: "global", fee: 350, actor: "environment-default" },
  ]);
});

test("finance policy endpoint and superadmin UI are permission guarded and fully wired", async () => {
  const { readFile } = await import("node:fs/promises");
  const platform = await readFile(new URL("../api/platform.mjs", import.meta.url), "utf8");
  const html = await readFile(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(platform, /platform\.finance\.read/);
  assert.match(platform, /platform\.finance\.write/);
  assert.match(platform, /finance\.policy_updated/);
  assert.match(platform, /finance\.policy_deleted/);
  assert.match(html, /id="finance-policy-form"/);
  assert.match(html, /id="finance-policy-retry"/);
  assert.match(script, /api\("finance_policy"/);
  assert.match(script, /data-finance-policy-delete/);
});
