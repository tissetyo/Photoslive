import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createProviderMigration, finalizeProviderMigration, listProviderMigrations, processProviderMigration, setProviderMigrationState,
} from "../api/_provider_migrations.mjs";
import { finalizeProviderMigrationCutover, processProviderMigrationBatch, processProviderMigrationQueue } from "../api/_provider_migration_worker.mjs";
import { boothKey, machineKey } from "../api/_store.mjs";

class FakeRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value)); return "OK";
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
}

const checksum = value => value.repeat(64);
const items = [1, 2, 3].map(number => ({ id: `asset-${number}`, objectKey: `assets/booth/frame-${number}.png`, checksumSha256: checksum(String(number)), contentType: "image/png", size: number * 10 }));

test("provider migration checkpoints each object and resumes after an interrupted worker", async () => {
  const redis = new FakeRedis();
  const created = await createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items }, "integration-admin");
  const copied = [];
  const worker = async ({ item }) => ({ checksumSha256: item.checksumSha256, size: item.size });
  const first = await processProviderMigration(redis, created.id, { limit: 1, copyObject: worker, onCopied: async ({ item }) => copied.push(item.id) });
  assert.equal(first.state, "queued");
  assert.equal(first.copied, 1);
  // A fresh worker call loads the durable checkpoint and skips copied data.
  const resumed = await processProviderMigration(redis, created.id, { limit: 5, copyObject: worker, onCopied: async ({ item }) => copied.push(item.id) });
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.copied, 3);
  assert.equal(resumed.cutoverReady, true);
  assert.deepEqual(copied, ["asset-1", "asset-2", "asset-3"]);
});

test("migration pause and resume are persistent and a paused job performs no copy", async () => {
  const redis = new FakeRedis();
  const created = await createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items }, "owner");
  assert.equal((await setProviderMigrationState(redis, created.id, "paused", "owner")).state, "paused");
  let calls = 0;
  const paused = await processProviderMigration(redis, created.id, { copyObject: async () => { calls += 1; } });
  assert.equal(paused.state, "paused");
  assert.equal(calls, 0);
  assert.equal((await setProviderMigrationState(redis, created.id, "queued", "owner")).state, "queued");
  assert.equal((await listProviderMigrations(redis))[0].id, created.id);
});

test("checksum mismatch is retained as retryable evidence and never permits cutover", async () => {
  const redis = new FakeRedis();
  const created = await createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items: [items[0]] }, "owner");
  const result = await processProviderMigration(redis, created.id, { copyObject: async ({ item }) => ({ checksumSha256: checksum("f"), size: item.size }) });
  assert.equal(result.copied, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.cutoverReady, false);
  assert.match(result.lastError, /Checksum tujuan tidak cocok/);
});

test("invalid or unsafe migration input is rejected", async () => {
  const redis = new FakeRedis();
  await assert.rejects(() => createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "cloudflare-r2", items }), /berbeda/);
  await assert.rejects(() => createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items: [{ ...items[0], checksumSha256: "secret" }] }), /Metadata object/);
});

test("failed objects stop retrying after the bounded attempt limit", async () => {
  const redis = new FakeRedis();
  const created = await createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items: [items[0]] }, "owner");
  let calls = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await processProviderMigration(redis, created.id, { copyObject: async () => { calls += 1; throw new Error("provider offline"); } });
  }
  assert.equal(calls, 8);
  assert.equal((await listProviderMigrations(redis))[0].state, "failed");
});

test("background queue copies in bounded batches, checkpoints metadata, and resumes", async () => {
  const redis = new FakeRedis();
  await redis.set(boothKey("booth-a"), "machine-a");
  await redis.set(machineKey("machine-a"), { organizationId: "org-a" });
  for (const item of items) await redis.set(`photoslive:booth:booth-a:asset:${item.id}`, { id: item.id, storageProvider: "cloudflare-r2", objectKey: item.objectKey });
  const created = await createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items }, "owner");
  const source = new Map(items.map(item => [item.objectKey, { bytes: new Uint8Array(item.size), checksumSha256: item.checksumSha256, size: item.size }]));
  const destination = new Map();
  const runtimeResolver = async (_redis, providerId) => ({ providerId, environment: { providerId }, connection: null });
  const getObjectImpl = async ({ objectKey, environment }) => (environment.providerId === "cloudflare-r2" ? source : destination).get(objectKey) || null;
  const putObjectImpl = async ({ objectKey, bytes, checksumSha256, environment }) => {
    destination.set(objectKey, { bytes, checksumSha256, size: bytes.byteLength, environment });
    return { ok: true };
  };
  const first = await processProviderMigrationQueue(redis, { limitMigrations: 1, limit: 2, runtimeResolver, getObjectImpl, putObjectImpl });
  assert.equal(first.processed, 1);
  assert.equal(first.results[0].migration.copied, 2);
  const second = await processProviderMigrationQueue(redis, { limitMigrations: 1, limit: 2, runtimeResolver, getObjectImpl, putObjectImpl });
  assert.equal(second.results[0].migration.state, "completed");
  assert.equal(destination.size, 3);
  const asset = await redis.get("photoslive:booth:booth-a:asset:asset-1");
  assert.equal(asset.storageProvider, "s3-compatible");
  assert.equal(asset.providerMigrationId, created.id);
});

test("migration worker lock prevents concurrent duplicate copying", async () => {
  const redis = new FakeRedis();
  const created = await createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items: [items[0]] }, "owner");
  await redis.set(`photoslive:provider-migration-lock:${created.id}`, "another-worker");
  const result = await processProviderMigrationBatch(redis, created.id, { runtimeResolver: async () => { throw new Error("must not run"); } });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "locked");
});

test("cutover cannot finalize early and pauses only a booth-scoped source after verification", async () => {
  const redis = new FakeRedis();
  await redis.set(boothKey("booth-a"), "machine-a");
  await redis.set(machineKey("machine-a"), { organizationId: "org-a" });
  const created = await createProviderMigration(redis, { boothCode: "booth-a", sourceProvider: "cloudflare-r2", destinationProvider: "s3-compatible", items: [items[0]] }, "owner");
  await assert.rejects(() => finalizeProviderMigration(redis, created.id, { verifyCutover: async () => {} }), /belum siap/);
  await redis.set("photoslive:booth:booth-a:asset:asset-1", { id: "asset-1", storageProvider: "cloudflare-r2", objectKey: items[0].objectKey });
  await processProviderMigration(redis, created.id, {
    copyObject: async ({ item }) => ({ checksumSha256: item.checksumSha256, size: item.size }),
    onCopied: async ({ migration, item }) => redis.set("photoslive:booth:booth-a:asset:asset-1", { id: item.id, storageProvider: migration.destinationProvider, providerMigrationId: migration.id }),
  });
  let paused = null;
  const finalized = await finalizeProviderMigrationCutover(redis, created.id, "integration-admin", {
    runtimeResolver: async () => ({ connection: { id: "booth:booth-a:cloudflare-r2", providerId: "cloudflare-r2", scope: "booth", targetId: "booth-a" } }),
    stateSetter: async (_redis, input) => { paused = input; },
  });
  assert.ok(finalized.finalizedAt);
  assert.equal(finalized.sourceRetirement.state, "paused");
  assert.equal(paused.status, "paused");
});

test("superadmin migration UI has real create, retry, pause, resume, process, and finalize handlers", async () => {
  const [html, script, platform] = await Promise.all([
    readFile(new URL("../superadmin.html", import.meta.url), "utf8"),
    readFile(new URL("../superadmin.js", import.meta.url), "utf8"),
    readFile(new URL("../api/platform.mjs", import.meta.url), "utf8"),
  ]);
  for (const id of ["provider-migrations-card", "provider-migration-form", "provider-migrations-retry", "provider-migration-rows", "provider-migrations-status"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /api\("provider_migrations"/);
  assert.match(script, /data-migration-operation/);
  assert.match(script, /operation:\s*"create"/);
  assert.match(script, /refreshProviderMigrations/);
  assert.match(platform, /providerMigrationsControl/);
  assert.match(platform, /provider_migration\.processed/);
  assert.match(script, /Finalisasi cutover/);
  assert.match(platform, /provider_migration\.finalized/);
});
