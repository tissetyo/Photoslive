import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contract = JSON.parse(fs.readFileSync(path.join(root, "contracts/product-capabilities.json"), "utf8"));

function evidenceExists(relativePath) {
  return [path.join(root, relativePath), path.join(root, "web", relativePath)].some(candidate => fs.existsSync(candidate));
}

test("every product capability has an explicit maturity status, source, gate, and evidence", () => {
  assert.deepEqual(contract.statuses, ["real", "partial", "mockup", "broken", "unavailable"]);
  assert.ok(contract.capabilities.length >= 25);
  const ids = new Set();
  for (const capability of contract.capabilities) {
    assert.ok(capability.id && !ids.has(capability.id), `Capability ID tidak unik: ${capability.id}`);
    ids.add(capability.id);
    assert.ok(contract.statuses.includes(capability.status), `Status tidak valid: ${capability.id}`);
    assert.ok(capability.surface && capability.sourceOfTruth && capability.gate && capability.evidence, `Metadata capability tidak lengkap: ${capability.id}`);
    assert.ok(evidenceExists(capability.evidence), `File bukti tidak ditemukan: ${capability.evidence}`);
  }
});

test("unfinished capabilities are gated and no active mockup or known broken capability ships", () => {
  const unfinished = contract.capabilities.filter(item => ["partial", "unavailable"].includes(item.status));
  assert.ok(unfinished.every(item => item.gate !== "always" || item.status === "partial"));
  assert.deepEqual(contract.capabilities.filter(item => item.status === "mockup"), []);
  assert.deepEqual(contract.capabilities.filter(item => item.status === "broken"), []);
});
