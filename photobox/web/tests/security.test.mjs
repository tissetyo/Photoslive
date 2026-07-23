import assert from "node:assert/strict";
import test from "node:test";

process.env.SESSION_SECRET = "photoslive-test-secret-that-is-long-enough-2026";

const { signScopedToken, verifyScopedToken } = await import("../api/_store.mjs");
const { boothControllerPathAllowed } = await import("../api/bridge.mjs");
const { deploymentCapabilities } = await import("../api/platform.mjs");
const { providerRegistry } = await import("../api/_providers.mjs");
const { observedResponse, requestContext } = await import("../api/_observability.mjs");

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

test("implemented payment and storage credentials enable their production adapters", () => {
  const environment = {
    XENDIT_SECRET_KEY: "secret",
    XENDIT_WEBHOOK_TOKEN: "webhook",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "photos",
    MONITORING_WEBHOOK_SECRET: "monitor-secret-value",
  };
  const providers = providerRegistry(environment);
  assert.equal(providers.find(provider => provider.id === "xendit").configured, true);
  assert.equal(providers.find(provider => provider.id === "xendit").available, true);
  assert.equal(providers.find(provider => provider.id === "cloudflare-r2").configured, true);
  assert.equal(providers.find(provider => provider.id === "cloudflare-r2").available, true);
  assert.equal(deploymentCapabilities(environment).qris.available, true);
  assert.deepEqual(deploymentCapabilities(environment).qris.providers, ["xendit"]);
  assert.equal(deploymentCapabilities(environment).cloudStorage.available, true);
  assert.equal(deploymentCapabilities(environment).sessionDownloads.mode, "direct-object-storage");
  assert.equal(deploymentCapabilities(environment).sessionDownloads.maxFileBytes, 25_000_000);
  assert.equal(deploymentCapabilities(environment).cloudAssets.mode, "direct-object-storage");
  assert.equal(deploymentCapabilities(environment).cloudAssets.maxFileBytes, 25_000_000);
  assert.ok(!JSON.stringify(providers).includes("XENDIT_SECRET_KEY"));
  assert.ok(!JSON.stringify(providers).includes("monitor-secret-value"));
});

test("observability returns correlation id and server timing without changing the body", async () => {
  const request = new Request("https://photoslive.test/api/platform?action=health", { headers: { "x-correlation-id": "test-request-1" } });
  const context = requestContext(request, "test");
  const response = observedResponse(new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } }), context, { action: "health" });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-correlation-id"), "test-request-1");
  assert.match(response.headers.get("server-timing"), /^app;dur=/);
  assert.deepEqual(await response.json(), { ok: true });
});
