import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePublicSessionCode,
  publicPhotoSession,
  publicPhotoSessionFile,
} from "../api/platform.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value) { this.values.set(key, structuredClone(value)); return "OK"; }
}

const boothCode = "lobby-01";
const shareCode = "0123456789abcdef0123456789abcdef";
const sessionKey = `photoslive:public-session:${boothCode}:${shareCode}`;
const fileKey = fileId => `photoslive:public-session-file:${boothCode}:${shareCode}:${fileId}`;

function activeSession(files = [{ id: "capture-1" }]) {
  return {
    boothCode,
    shareCode,
    files,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

test("new customer download codes require at least 128 bits of URL-safe entropy", () => {
  assert.equal(normalizePublicSessionCode("0123456789abcdef"), "");
  assert.equal(normalizePublicSessionCode(shareCode), shareCode);
  assert.equal(normalizePublicSessionCode(`${shareCode}!`), "");
});

test("expired customer sessions deny both metadata and the underlying file", async () => {
  const redis = new MemoryRedis();
  await redis.set(sessionKey, {
    ...activeSession(),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  await redis.set(fileKey("capture-1"), {
    id: "capture-1",
    contentType: "image/jpeg",
    bodyBase64: Buffer.from("private-photo").toString("base64"),
  });

  const metadata = await publicPhotoSession(redis, { booth: boothCode, session: shareCode });
  const file = await publicPhotoSessionFile(redis, { booth: boothCode, session: shareCode, file: "capture-1" });
  assert.equal(metadata.status, 404);
  assert.equal(file.status, 404);
});

test("active customer session only serves files listed in its manifest", async () => {
  const redis = new MemoryRedis();
  await redis.set(sessionKey, activeSession());
  await redis.set(fileKey("capture-1"), {
    id: "capture-1",
    contentType: "image/jpeg",
    bodyBase64: Buffer.from("private-photo").toString("base64"),
  });
  await redis.set(fileKey("unlisted-file"), {
    id: "unlisted-file",
    contentType: "image/jpeg",
    bodyBase64: Buffer.from("must-not-leak").toString("base64"),
  });

  const allowed = await publicPhotoSessionFile(redis, { booth: boothCode, session: shareCode, file: "capture-1" });
  const denied = await publicPhotoSessionFile(redis, { booth: boothCode, session: shareCode, file: "unlisted-file" });
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), "private-photo");
  assert.equal(denied.status, 404);
});

test("a durable deletion request blocks metadata and files before provider cleanup finishes", async () => {
  const redis = new MemoryRedis();
  await redis.set(sessionKey, { ...activeSession(), deletionRequested: true, deletionRequestedAt: new Date().toISOString() });
  await redis.set(fileKey("capture-1"), {
    id: "capture-1",
    contentType: "image/jpeg",
    bodyBase64: Buffer.from("must-no-longer-be-public").toString("base64"),
  });
  assert.equal((await publicPhotoSession(redis, { booth: boothCode, session: shareCode })).status, 404);
  assert.equal((await publicPhotoSessionFile(redis, { booth: boothCode, session: shareCode, file: "capture-1" })).status, 404);
});
