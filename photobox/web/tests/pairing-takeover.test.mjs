import assert from "node:assert/strict";
import test from "node:test";

import { claimPairing, createSetupCode } from "../api/bridge.mjs";
import { setupBooth, validateSetupCode } from "../api/platform.mjs";
import { machineKey, sha256 } from "../api/_store.mjs";

process.env.SESSION_SECRET ||= "photoslive-test-session-secret-32-characters";

class MemoryRedis {
  constructor(entries = []) {
    this.values = new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
    this.sets = new Map();
  }

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async set(key, value, options = {}) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }

  async del(key) {
    return this.values.delete(key) ? 1 : 0;
  }

  async sadd(key, value) {
    const values = this.sets.get(key) || new Set();
    values.add(value);
    this.sets.set(key, values);
    return 1;
  }
}

const machine = (overrides = {}) => ({
  id: "machine_pairing_test",
  name: "Pairing test",
  platform: "test",
  pairingCode: "ABCD-2345",
  paired: false,
  boothCode: "test-booth",
  ...overrides,
});

const setupPayload = (overrides = {}) => ({
  pairingCode: "ABCD-2345",
  email: "owner@example.test",
  pin: "123456",
  confirmPin: "123456",
  name: "Test booth",
  location: "Test lab",
  ...overrides,
});

test("only the current unclaimed setup code can expose or create a booth", async () => {
  const stale = new MemoryRedis([
    ["photoslive:pairing:ABCD-2345", "machine_pairing_test"],
    [machineKey("machine_pairing_test"), machine({ pairingCode: "WXYZ-6789" })],
  ]);
  assert.equal((await validateSetupCode(stale, setupPayload())).status, 409);
  assert.equal((await setupBooth(stale, setupPayload())).status, 409);

  const configured = new MemoryRedis([
    ["photoslive:pairing:ABCD-2345", "machine_pairing_test"],
    [machineKey("machine_pairing_test"), machine({ paired: true })],
  ]);
  assert.equal((await validateSetupCode(configured, setupPayload())).status, 409);
  assert.equal((await setupBooth(configured, setupPayload())).status, 409);
});

test("a setup code is consumed atomically when concurrent owners submit it", async () => {
  const redis = new MemoryRedis([
    ["photoslive:pairing:ABCD-2345", "machine_pairing_test"],
    [machineKey("machine_pairing_test"), machine()],
  ]);
  const responses = await Promise.all([
    setupBooth(redis, setupPayload()),
    setupBooth(redis, setupPayload({ email: "second@example.test" })),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal(redis.sets.get("photoslive:booth:test-booth:users")?.size, 1);
  assert.equal(await redis.get("photoslive:pairing:ABCD-2345"), null);
});

test("legacy pairing claim requires an authenticated admin session", async () => {
  const response = await claimPairing(new MemoryRedis(), new Request("https://photoslive.test/api/bridge?action=claim_pairing", { method: "POST" }), { code: "ABCD-2345" });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Login admin/);
});

test("issuing a replacement setup code invalidates the previous code", async () => {
  const token = "agent-test-token";
  const record = machine({ agentTokenHash: await sha256(token), pairingCode: "ABCD-2345", paired: true });
  const redis = new MemoryRedis([
    [machineKey(record.id), record],
    ["photoslive:pairing:ABCD-2345", record.id],
  ]);
  const request = new Request("https://photoslive.test/api/bridge?action=create_setup_code", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const response = await createSetupCode(redis, request, { machineId: record.id });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.notEqual(result.pairingCode, "ABCD-2345");
  assert.equal(await redis.get("photoslive:pairing:ABCD-2345"), null);
  assert.equal(await redis.get(`photoslive:pairing:${result.pairingCode}`), record.id);
});
