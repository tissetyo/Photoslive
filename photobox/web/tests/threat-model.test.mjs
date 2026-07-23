import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const model = JSON.parse(fs.readFileSync(path.join(root, "contracts/threat-model.json"), "utf8"));
const document = fs.readFileSync(path.join(root, "docs/THREAT-MODEL.md"), "utf8");

test("threat model covers every critical Photoslive trust boundary with actionable evidence", () => {
  assert.equal(model.schemaVersion, 1);
  assert.ok(model.assets.length >= 6);
  assert.ok(model.trustBoundaries.length >= 7);
  assert.ok(model.threats.length >= 15);

  const allowedStatuses = new Set(model.statuses);
  const ids = new Set();
  for (const threat of model.threats) {
    assert.match(threat.id, /^T\d{2}$/);
    assert.ok(!ids.has(threat.id), `Duplicate threat id: ${threat.id}`);
    ids.add(threat.id);
    assert.ok(allowedStatuses.has(threat.status), `Unknown status on ${threat.id}`);
    assert.ok(threat.category && threat.title && threat.owner);
    assert.ok(threat.controls.length > 0, `Missing controls on ${threat.id}`);
    assert.ok(threat.residualRisk, `Missing residual risk on ${threat.id}`);
    assert.ok(threat.verification.length > 0, `Missing verification on ${threat.id}`);
    for (const evidence of threat.verification) {
      assert.ok(fs.existsSync(path.join(root, evidence)), `Missing evidence ${evidence} for ${threat.id}`);
    }
  }

  const categories = new Set(model.threats.map(threat => threat.category));
  for (const required of [
    "pairing-takeover",
    "tenant-isolation",
    "remote-command",
    "local-api",
    "secret-exposure",
    "customer-photos",
    "offline-replay",
    "storage-safety",
    "payment-webhook",
    "payout-fraud",
    "supply-chain"
  ]) {
    assert.ok(categories.has(required), `Missing threat category: ${required}`);
  }
});

test("unimplemented high-risk capabilities remain blocked and are not claimed as production safe", () => {
  for (const category of ["payment-webhook", "payout-fraud", "supply-chain"]) {
    assert.equal(model.threats.find(threat => threat.category === category)?.status, "blocked");
  }
  assert.match(document, /penetration test/i);
  assert.match(document, /incident drill/i);
  assert.match(document, /privacy deletion drill/i);
  assert.match(document, /belum selesai|belum ada/i);
});
