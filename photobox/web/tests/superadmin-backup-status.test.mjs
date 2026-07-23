import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { safeBackupTelemetry } from "../api/platform.mjs";

test("backup telemetry projection keeps bounded status and strips local secrets", () => {
  const projected = safeBackupTelemetry({
    status: "ready",
    count: 10_000,
    latestAt: "2026-07-21T00:00:00.000Z",
    latestReason: "daily",
    latestSchemaVersion: 4,
    latestSizeBytes: 4096,
    databaseStatus: "healthy",
    restoreStatus: "completed",
    restoreAt: "2026-07-21T01:00:00.000Z",
    name: "photoslive-secret.db",
    checksumSha256: "secret-checksum",
    path: "/private/photoslive.db",
    error: "sensitive failure",
  });

  assert.equal(projected.status, "ready");
  assert.equal(projected.count, 999);
  assert.equal(projected.restoreStatus, "completed");
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /photoslive-secret|secret-checksum|private|sensitive failure/);
});

test("superadmin renders actionable backup and restore fleet status", () => {
  const html = fs.readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  assert.match(html, /<th>BACKUP<\/th>/);
  assert.match(script, /BELUM ADA/);
  assert.match(script, /Restore selesai/);
  assert.match(script, /Restore gagal/);
});
