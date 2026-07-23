import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inventory = fs.readFileSync(path.join(root, "docs/DATA-INVENTORY.md"), "utf8");
const controller = fs.readFileSync(path.join(root, "server.py"), "utf8");

test("data inventory covers every current SQLite table", () => {
  const tables = [...controller.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)].map(match => match[1]);
  assert.ok(tables.length >= 9);
  for (const table of tables) assert.ok(inventory.includes(`| \`${table}\` |`), `Tabel SQLite belum didokumentasikan: ${table}`);
});

test("data inventory documents cloud keys, local roots, and bounded Base64 fallback", () => {
  for (const contract of [
    "photoslive:machine:{machineId}",
    "photoslive:booth:{code}:settings",
    "photoslive:public-session-file:{code}:{shareCode}:{fileId}",
    "photoslive:feature-flag:{scope}:{target}:{key}",
    "${PHOTOSLIVE_DATA_ROOT}/photoslive.db",
    "photoslive.setupDraft.v2",
    "storageMode=legacy-redis",
    "maksimal 2 MB",
  ]) assert.ok(inventory.includes(contract), `Kontrak data belum didokumentasikan: ${contract}`);
  assert.match(inventory, /Foto yang belum memiliki `uploaded_at` tidak boleh/);
  assert.match(inventory, /tidak ada destructive\s+migration otomatis/);
});
