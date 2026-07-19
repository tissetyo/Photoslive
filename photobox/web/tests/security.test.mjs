import assert from "node:assert/strict";
import test from "node:test";

process.env.SESSION_SECRET = "photoslive-test-secret-that-is-long-enough-2026";

const { signScopedToken, verifyScopedToken } = await import("../api/_store.mjs");
const { boothControllerPathAllowed } = await import("../api/bridge.mjs");
const { deploymentCapabilities } = await import("../api/platform.mjs");

test("scoped booth token is bound to machine, booth, and expiry", async () => {
  const token = await signScopedToken({ scope: "booth.hardware", machineId: "machine_a", boothCode: "booth-a", exp: Date.now() + 60_000 });
  const payload = await verifyScopedToken(token);
  assert.equal(payload.scope, "booth.hardware");
  assert.equal(payload.machineId, "machine_a");
  assert.equal(payload.boothCode, "booth-a");
});

test("scoped booth token rejects tampering and expiry", async () => {
  const token = await signScopedToken({ scope: "booth.hardware", machineId: "machine_a", boothCode: "booth-a", exp: Date.now() - 1 });
  assert.equal(await verifyScopedToken(token), null);

  const active = await signScopedToken({ scope: "booth.hardware", machineId: "machine_a", boothCode: "booth-a", exp: Date.now() + 60_000 });
  assert.equal(await verifyScopedToken(`${active.slice(0, -1)}x`), null);
});

test("public booth hardware scope only allows customer-flow controller routes", () => {
  assert.equal(boothControllerPathAllowed("/api/devices"), true);
  assert.equal(boothControllerPathAllowed("/api/sessions/local_123/capture"), true);
  assert.equal(boothControllerPathAllowed("/api/booth/print"), true);
  assert.equal(boothControllerPathAllowed("/api/settings"), false);
  assert.equal(boothControllerPathAllowed("/api/storage/cleanup"), false);
  assert.equal(boothControllerPathAllowed("/api/local/agent/restart"), false);
});

test("unfinished production integrations are exposed as unavailable capabilities", () => {
  const capabilities = deploymentCapabilities();
  assert.equal(capabilities.qris.available, false);
  assert.deepEqual(capabilities.qris.providers, []);
  assert.equal(capabilities.cloudStorage.available, false);
  assert.deepEqual(capabilities.cloudStorage.providers, []);
  assert.equal(capabilities.sessionDownloads.retentionHours, 24);
});
