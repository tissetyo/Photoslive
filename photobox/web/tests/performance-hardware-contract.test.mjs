import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const compatibility = JSON.parse(fs.readFileSync(path.join(root, "contracts/hardware-compatibility.json"), "utf8"));
const baseline = fs.readFileSync(path.join(root, "docs/PERFORMANCE-HARDWARE-BASELINE.md"), "utf8");
const limitations = fs.readFileSync(path.join(root, "docs/KNOWN-LIMITATIONS.md"), "utf8");

test("hardware registry distinguishes computer support from limited tablet capability", () => {
  assert.equal(compatibility.schemaVersion, 2);
  assert.equal(compatibility.status, "baseline-not-certification");
  assert.equal(compatibility.minimumComputer.ramBytes, 4 * 1024 ** 3);
  assert.equal(compatibility.minimumComputer.storageBytes, 16 * 1024 ** 3);
  assert.equal(compatibility.minimumComputer.freeStorageBytes, 4 * 1024 ** 3);
  assert.deepEqual(compatibility.platforms.map(item => item.id), [
    "linux-computer",
    "windows-computer",
    "macos-computer",
    "ipad-standalone",
    "android-tablet-standalone",
    "tablet-companion"
  ]);
  assert.equal(compatibility.platforms.find(item => item.id === "windows-computer").minimum.storageBytes, 64 * 1024 ** 3);
  const tablets = compatibility.platforms.filter(item => item.id.includes("standalone"));
  assert.ok(tablets.every(item => item.capabilities.agent === "unavailable"));
  assert.ok(tablets.every(item => item.capabilities.silentPrint === "unavailable"));
  assert.ok(tablets.every(item => item.capabilities.usbPrinter === "unavailable"));
  const companion = compatibility.platforms.find(item => item.id === "tablet-companion");
  assert.equal(companion.releaseStatus, "partial-local-pairing");
  assert.equal(companion.capabilities.controller, "limited");
  assert.equal(companion.capabilities.offlineSession, "planned");
  assert.deepEqual(compatibility.testedDevices, []);
});

test("every hardware capability uses a bounded status and evidence remains explicit", () => {
  const statuses = new Set(compatibility.capabilityStatuses);
  const ids = new Set();
  for (const platform of compatibility.platforms) {
    assert.ok(!ids.has(platform.id), `Duplicate platform: ${platform.id}`);
    ids.add(platform.id);
    assert.ok(platform.label && platform.releaseStatus && platform.capabilities);
    for (const state of Object.values(platform.capabilities)) {
      assert.ok(statuses.has(state), `Unknown capability state ${state} on ${platform.id}`);
    }
  }
  assert.ok(compatibility.acceptanceRequired.includes("seventy-two-hour-soak"));
  for (const evidence of compatibility.evidence) {
    assert.ok(fs.existsSync(path.join(root, evidence)), `Missing evidence: ${evidence}`);
  }
});

test("benchmark and probe are explicit about synthetic versus production evidence", () => {
  assert.match(baseline, /temporary directory/i);
  assert.match(baseline, /bukan pengganti cloud p95, kamera nyata, printer fisik, atau soak/i);
  assert.match(baseline, /20 capture/i);
  assert.match(baseline, /20 print/i);
  assert.match(limitations, /Known limitations/i);
  assert.match(limitations, /QRIS \| Unavailable/);
});
