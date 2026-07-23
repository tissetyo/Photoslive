import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.SESSION_SECRET = "photoslive-test-secret-that-is-long-enough-2026";
const { persistVoucherBatch, withCloudIdempotency } = await import("../api/platform.mjs");

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) || null; }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
  async del(key) { this.values.delete(key); }
}

const request = body => new Request("https://photoslive.test/api/platform?action=cloud_data", {
  method: "POST",
  headers: { "idempotency-key": "request-settings-123" },
  body: JSON.stringify(body),
});

test("cloud mutation with the same key is executed once and replayed", async () => {
  const redis = new MemoryRedis();
  const payload = { booth: "booth-a", path: "/api/settings/booth", data: { name: "A" } };
  let calls = 0;
  const operation = async () => { calls += 1; return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } }); };
  const first = await withCloudIdempotency(redis, request(payload), payload, operation);
  const replay = await withCloudIdempotency(redis, request(payload), payload, operation);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("x-idempotency-replayed"), "true");
  assert.equal(calls, 1);
  assert.deepEqual(await replay.json(), { ok: true });
});

test("cloud idempotency key cannot be reused for a different mutation", async () => {
  const redis = new MemoryRedis();
  const firstPayload = { booth: "booth-a", path: "/api/vouchers/generate", data: { count: 100 } };
  const otherPayload = { booth: "booth-a", path: "/api/vouchers/generate", data: { count: 50 } };
  await withCloudIdempotency(redis, request(firstPayload), firstPayload, async () => new Response("{}", { status: 201 }));
  const conflict = await withCloudIdempotency(redis, request(otherPayload), otherPayload, async () => new Response("{}", { status: 201 }));
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /request berbeda/);
});

test("admin settings save batches dirty sections into one retry-safe cloud mutation", () => {
  const script = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const saveFunction = script.slice(script.indexOf("async function saveSettings()"), script.indexOf("\nfunction updatePreview()"));
  assert.match(saveFunction, /Object\.fromEntries\(sections\.map/);
  assert.match(saveFunction, /api\("\/api\/settings"/);
  assert.match(saveFunction, /idempotencyKey: state\.pendingSettingsSave\.idempotencyKey/);
  assert.match(saveFunction, /JSON\.stringify\(state\.settings\[section\]\) !== JSON\.stringify\(data\[section\]\)/);
  assert.doesNotMatch(saveFunction, /for \(const section of sections\)[\s\S]{0,180}await api/);
});

test("admin settings use an optimistic local preview while preserving unsaved state", () => {
  const script = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const markFunction = script.slice(script.indexOf("function markSetting(input)"), script.indexOf("\nfunction syncActiveFrameCapacity"));
  assert.match(markFunction, /setPath\(state\.settings, input\.dataset\.setting, value\)/);
  assert.match(markFunction, /state\.dirtySections\.add/);
  assert.match(markFunction, /updatePreview\(\)/);
  assert.match(script, /if \(JSON\.stringify\(state\.settings\[section\]\) !== JSON\.stringify\(data\[section\]\)\) continue/);
});

test("cloud admin mutations expose a bounded actionable timeout", () => {
  const script = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(script, /Math\.max\(1_000, Math\.min\(60_000/);
  assert.match(script, /Perubahan belum tersimpan; tekan Simpan untuk mencoba lagi/);
});

test("voucher batch persists records, index, and version in one Redis transaction", async () => {
  const commands = [];
  const redis = {
    multi() {
      return {
        set(key, value) { commands.push(["set", key, value]); return this; },
        sadd(key, ...values) { commands.push(["sadd", key, ...values]); return this; },
        incr(key) { commands.push(["incr", key]); return this; },
        async exec() { commands.push(["exec"]); return ["OK", "OK", 17]; },
      };
    },
  };
  const vouchers = [
    { code: "AAAA-BBBB", boothCode: "booth-a" },
    { code: "CCCC-DDDD", boothCode: "booth-a" },
  ];
  assert.equal(await persistVoucherBatch(redis, "booth-a", vouchers), 17);
  assert.deepEqual(commands.map(command => command[0]), ["set", "set", "sadd", "incr", "exec"]);
  assert.match(commands[2][1], /booth-a:vouchers$/);
  assert.match(commands[3][1], /booth-a:voucher-version$/);
});

test("voucher batch keeps a pipeline fallback for local adapters", async () => {
  let used = false;
  const redis = {
    pipeline() {
      used = true;
      return {
        set() { return this; }, sadd() { return this; }, incr() { return this; },
        async exec() { return ["OK", "OK", 1]; },
      };
    },
  };
  assert.equal(await persistVoucherBatch(redis, "local", [{ code: "LOCAL-ONE" }]), 1);
  assert.equal(used, true);
});

test("voucher generation reuses its idempotency key and renders the mutation response", () => {
  const script = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const generateFunction = script.slice(script.indexOf("async function generateVouchers"), script.indexOf("\nasync function createVoucherEvent"));
  assert.match(generateFunction, /state\.pendingVoucherGenerations\.has/);
  assert.match(generateFunction, /idempotencyKey: state\.pendingVoucherGenerations\.get/);
  assert.match(generateFunction, /renderVouchers\(result\)/);
  assert.match(generateFunction, /state\.pendingVoucherGenerations\.delete/);
  assert.doesNotMatch(generateFunction, /await loadVouchers\(\)/);
});
