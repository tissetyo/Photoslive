import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const matrix = read("docs/TEST-MATRIX.md");

test("test matrix maps every completed software scenario to executable evidence", () => {
  for (const file of [
    "web/tests/cloud-idempotency.test.mjs",
    "web/tests/payments-ledger.test.mjs",
    "web/tests/payout-control.test.mjs",
    "web/tests/provider-connections.test.mjs",
    "tests/test_local_first.py",
    "web/tests/load-smoke.test.mjs",
    "web/tests/hardware-protocol.test.mjs",
    "web/tests/setup-contract.test.mjs",
    "tests/test_updater.py",
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `missing evidence: ${file}`);
    assert.match(matrix, new RegExp(file.replaceAll("/", "\\/")));
  }
});

test("test matrix records browser/load evidence without overclaiming hardware, live-provider, or soak acceptance", () => {
  for (const scope of [
    "Integration live PostgreSQL", "Webcam, gPhoto2",
    "Agent benar-benar dimatikan", "Soak test 72 jam",
  ]) assert.match(matrix, new RegExp(scope));
  assert.match(matrix, /Browser seluruh route/);
  assert.match(matrix, /Load smoke/);
  assert.match(matrix, /tetap terbuka/i);
  assert.match(matrix, /tidak boleh digunakan untuk mengklaim acceptance/i);
});
