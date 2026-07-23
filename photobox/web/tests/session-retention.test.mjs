import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  cleanupExpiredPublicSessions,
  PUBLIC_SESSION_RETENTION_INDEX,
  trackPublicSessionFileRetention,
  trackPublicSessionRetention,
} from "../api/_session_retention.mjs";
import { deletePublicPhotoSession } from "../api/platform.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.sorted = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
  async del(...keys) { let removed = 0; keys.forEach(key => { if (this.values.delete(key)) removed += 1; }); return removed; }
  async zadd(key, ...entries) { const set = this.sorted.get(key) || new Map(); entries.forEach(entry => set.set(entry.member, Number(entry.score))); this.sorted.set(key, set); return entries.length; }
  async zrem(key, ...members) { const set = this.sorted.get(key) || new Map(); let removed = 0; members.forEach(value => { if (set.delete(value)) removed += 1; }); return removed; }
  async zrange(key, min, max, options = {}) {
    const lower = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
    return [...(this.sorted.get(key) || new Map()).entries()]
      .filter(([, score]) => score >= lower && score <= Number(max))
      .sort((left, right) => left[1] - right[1])
      .slice(options.offset || 0, (options.offset || 0) + (options.count || Number.MAX_SAFE_INTEGER))
      .map(([value]) => value);
  }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  pipeline() {
    const operations = [];
    return {
      lpush: (key, value) => operations.push(() => this.lpush(key, value)),
      ltrim: (key, start, stop) => operations.push(() => this.ltrim(key, start, stop)),
      exec: async () => Promise.all(operations.map(operation => operation())),
    };
  }
}

const boothCode = "lobby-01";
const shareCode = "0123456789abcdef0123456789abcdef";
const publicKey = `photoslive:public-session:${boothCode}:${shareCode}`;
const retentionKey = `photoslive:public-session-retention:${boothCode}:${shareCode}`;
const fileKey = `photoslive:public-session-file:${boothCode}:${shareCode}:capture-1`;

function session(expiresAt) {
  return { boothCode, shareCode, expiresAt, files: [{ id: "capture-1" }] };
}

test("retention cleanup physically deletes expired object storage files and metadata", async () => {
  const redis = new MemoryRedis();
  const expiresAt = new Date(Date.now() - 1_000).toISOString();
  await redis.set(publicKey, session(expiresAt));
  await redis.set(fileKey, { id: "capture-1", objectKey: "sessions/lobby-01/private.jpg", storageProvider: "s3-compatible" });
  await trackPublicSessionRetention(redis, session(expiresAt));
  await trackPublicSessionFileRetention(redis, session(expiresAt), { id: "capture-1", objectKey: "sessions/lobby-01/private.jpg", storageProvider: "s3-compatible" });
  const deletedObjects = [];
  const deletedProviders = [];

  const result = await cleanupExpiredPublicSessions(redis, {
    currentTime: Date.now(),
    deleteObjectImpl: async ({ objectKey, storageProvider }) => { deletedObjects.push(objectKey); deletedProviders.push(storageProvider); return true; },
  });

  assert.equal(result.deleted, 1);
  assert.deepEqual(deletedObjects, ["sessions/lobby-01/private.jpg"]);
  assert.deepEqual(deletedProviders, ["s3-compatible"]);
  assert.equal(await redis.get(publicKey), null);
  assert.equal(await redis.get(fileKey), null);
  assert.equal(await redis.get(retentionKey), null);
  assert.deepEqual(await redis.zrange(PUBLIC_SESSION_RETENTION_INDEX, "-inf", Date.now(), { byScore: true }), []);
});

test("retention cleanup preserves retry metadata when object provider deletion fails", async () => {
  const redis = new MemoryRedis();
  const expiresAt = new Date(Date.now() - 1_000).toISOString();
  await redis.set(publicKey, session(expiresAt));
  await trackPublicSessionFileRetention(redis, session(expiresAt), { id: "capture-1", objectKey: "sessions/lobby-01/private.jpg" });

  const result = await cleanupExpiredPublicSessions(redis, {
    currentTime: Date.now(),
    deleteObjectImpl: async () => { throw new Error("provider offline"); },
  });

  assert.equal(result.failed, 1);
  assert.ok(await redis.get(publicKey));
  assert.ok(await redis.get(retentionKey));
});

test("customer can permanently delete an active bearer-link session", async () => {
  const redis = new MemoryRedis();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await redis.set(publicKey, session(expiresAt));
  await redis.set(fileKey, { id: "capture-1", bodyBase64: "cGhvdG8=" });
  await trackPublicSessionRetention(redis, session(expiresAt));

  const response = await deletePublicPhotoSession(redis, { booth: boothCode, session: shareCode, confirm: "hapus" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).deleted, true);
  assert.equal(await redis.get(publicKey), null);
  assert.equal(await redis.get(fileKey), null);
  assert.ok((redis.lists.get(`photoslive:booth:${boothCode}:audit`) || []).some(value => value.includes("photo_session.deleted_by_customer")));
});

test("customer results UI requires explicit destructive confirmation and exposes retry state", () => {
  const html = fs.readFileSync(new URL("../session.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../session.js", import.meta.url), "utf8");
  assert.match(html, /id="delete-session"/);
  assert.match(html, /id="delete-session-dialog"/);
  assert.match(html, /Hapus permanen/);
  assert.match(script, /delete_public_session/);
  assert.match(script, /deleteConfirm\.disabled = true/);
  assert.match(script, /delete-session-status/);
  assert.match(script, /error\.message/);
});

test("production retention cron is authenticated and compatible with the zero-cost daily schedule", () => {
  const vercel = JSON.parse(fs.readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const handler = fs.readFileSync(new URL("../api/retention.mjs", import.meta.url), "utf8");
  assert.deepEqual(vercel.crons, [{ path: "/api/retention", schedule: "17 3 * * *" }]);
  assert.match(handler, /process\.env\.CRON_SECRET/);
  assert.match(handler, /supplied !== `Bearer \$\{secret\}`/);
  assert.match(handler, /cleanupExpiredPublicSessions/);
  assert.match(handler, /processAlertDeliveries/);
});
