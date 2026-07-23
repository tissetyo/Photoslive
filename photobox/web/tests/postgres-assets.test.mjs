import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { deletePostgresAsset, persistPostgresAsset, postgresAssetStatus, readPostgresAssets, requestPostgresAssetDeletion } from "../api/_postgres_assets.mjs";
import { cloudAsset, cloudAssets } from "../api/platform.mjs";
import { boothKey, machineKey } from "../api/_store.mjs";

const environment = {
  PHOTOSLIVE_POSTGRES_ASSETS: "primary",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-only-asset-secret",
};
const storageEnvironment = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET: "photoslive-test",
};
const asset = {
  id: "asset_test_1", boothCode: "booth-one", kind: "frame", name: "party.webp",
  contentType: "image/webp", size: 1234, checksumSha256: "b".repeat(64),
  createdAt: "2026-07-22T10:00:00.000Z", storageMode: "object-storage",
  storageProvider: "cloudflare-r2", objectKey: "assets/booth-one/frame/asset_test_1-party.webp", etag: "etag-safe",
};

class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async sadd(key, ...members) { const values = this.sets.get(key) || new Set(); members.forEach(value => values.add(value)); this.sets.set(key, values); return members.length; }
  async smembers(key) { return [...(this.sets.get(key) || [])]; }
}

test("asset PostgreSQL mode is explicit and bounded", () => {
  assert.equal(postgresAssetStatus({}).enabled, false);
  assert.equal(postgresAssetStatus(environment).primary, true);
  assert.equal(postgresAssetStatus({ ...environment, PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "99999" }).timeoutMs, 5_000);
});

test("asset lifecycle uses service-role RPCs without sending credentials in payload", async () => {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith("booth_assets_snapshot")) return Response.json([asset]);
    if (url.endsWith("delete_booth_asset")) return Response.json(true);
    return Response.json(url.endsWith("request_booth_asset_deletion") ? { ...asset, deletionRequested: true, deletionRequestedAt: "2026-07-22T10:01:00.000Z" } : asset);
  };
  const saved = await persistPostgresAsset(asset, { environment, fetchImplementation });
  assert.equal(saved.asset.id, asset.id);
  assert.equal((await readPostgresAssets(asset.boothCode, { environment, fetchImplementation })).length, 1);
  assert.equal((await requestPostgresAssetDeletion(asset.boothCode, asset.id, { environment, fetchImplementation })).asset.deletionRequested, true);
  assert.equal((await deletePostgresAsset(asset.boothCode, asset.id, { environment, fetchImplementation })).payload, true);
  assert.match(calls[0].url, /photoslive_persist_booth_asset$/);
  assert.equal(JSON.stringify(calls).includes(environment.SUPABASE_SERVICE_ROLE_KEY), false);
});

test("asset validation rejects a cross-tenant object key before network access", async () => {
  let called = false;
  await assert.rejects(() => persistPostgresAsset({ ...asset, objectKey: "assets/another-booth/frame/private.webp" }, {
    environment, fetchImplementation: async () => { called = true; },
  }), /tidak valid/);
  assert.equal(called, false);
});

test("primary asset listing recovers Redis while redacting storage internals", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment);
  globalThis.fetch = async () => Response.json([asset]);
  try {
    const redis = new FakeRedis();
    const listing = await cloudAssets(redis, asset.boothCode);
    assert.equal(listing.frame[0].id, asset.id);
    assert.equal(JSON.stringify(listing).includes("objectKey"), false);
    assert.equal(JSON.stringify(listing).includes("cloudflare-r2"), false);
    const cached = await redis.get(`photoslive:booth:${asset.boothCode}:asset:${asset.id}`);
    assert.equal(cached.objectKey, asset.objectKey);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("primary asset download recovers metadata and signs the private object", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment, storageEnvironment, { PHOTOSLIVE_POSTGRES_DIRECTORY: "off" });
  globalThis.fetch = async () => Response.json([asset]);
  try {
    const redis = new FakeRedis();
    await redis.set(boothKey(asset.boothCode), "machine_one");
    await redis.set(machineKey("machine_one"), { id: "machine_one", boothCode: asset.boothCode, paired: true, accessEnabled: true });
    const response = await cloudAsset(redis, { booth: asset.boothCode, id: asset.id });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.pathname, `/photoslive-test/${asset.objectKey}`);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("asset deletion request immediately hides the asset", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment);
  globalThis.fetch = async url => Response.json(url.endsWith("booth_assets_snapshot") ? [{ ...asset, deletionRequested: true, deletionRequestedAt: "2026-07-22T10:01:00.000Z" }] : null);
  try {
    const listing = await cloudAssets(new FakeRedis(), asset.boothCode);
    assert.deepEqual(listing.frame, []);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("asset migration is bounded, tenant-scoped, locked, and service-role-only", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260722170000_booth_asset_metadata.sql", import.meta.url), "utf8").toLowerCase();
  assert.match(sql, /assets\/.*booth_code.*kind/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /p_byte_size > 25000000/);
  assert.match(sql, /deletion_requested_at/);
  assert.match(sql, /revoke all on function public\.photoslive_persist_booth_asset[\s\S]+authenticated/);
  assert.match(sql, /grant execute on function public\.photoslive_booth_assets_snapshot[\s\S]+service_role/);
  assert.doesNotMatch(sql, /grant execute[\s\S]+photoslive_persist_booth_asset[\s\S]+to authenticated/);
});
