import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publicPlatformStatus, publicStatusProjection } from "../api/_public_status.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public status exposes only bounded component states without backend details or secrets", async () => {
  const secret = "do-not-expose-this-provider-secret";
  const result = await publicPlatformStatus({}, {
    backendHealthImplementation: async () => ({
      checkedAt: "2026-07-21T00:00:00.000Z",
      cache: { state: "ready", message: `cache ${secret}`, latencyMs: 9 },
      database: { state: "error", message: `database ${secret}` },
      providers: [{ id: "private-provider-id", kind: "storage", label: "Private provider", state: "error", message: secret, configured: true }],
    }),
  });
  assert.equal(result.overall, "outage");
  assert.deepEqual(result.components.map(component => component.id), ["cloud-api", "configuration", "customer-assets"]);
  assert.doesNotMatch(JSON.stringify(result), /private-provider|do-not-expose|latencyMs|database/);
});

test("public status UI has real loading, success, error, timeout, disabled, and retry behavior", () => {
  const html = fs.readFileSync(path.join(root, "status.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "status.js"), "utf8");
  const projected = publicStatusProjection({ cache: { state: "ready" }, providers: [] }, "2026-07-21T00:00:00.000Z");
  assert.equal(projected.overall, "degraded");
  assert.match(html, /id="refresh-public-status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(script, /button\.disabled = true/);
  assert.match(script, /AbortController/);
  assert.match(script, /setTimeout\(\(\) => controller\.abort\(\), 8000\)/);
  assert.match(script, /renderError/);
  assert.match(script, /button\.addEventListener\("click", refresh\)/);
});
