import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const photoboxRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rollback = fs.readFileSync(path.join(photoboxRoot, "docs/RELEASE-ROLLBACK.md"), "utf8");

test("release rollback procedure covers every stateful deployment surface", () => {
  for (const section of [
    "Manifest release",
    "Feature flag",
    "Web dan Cloud API",
    "PostgreSQL",
    "Object storage dan provider",
    "Controller dan Agent",
    "SQLite dan sesi lokal",
    "Verifikasi setelah rollback",
  ]) {
    assert.match(rollback, new RegExp(section));
  }
});

test("rollback explicitly preserves unsynced files and avoids destructive schema downgrade", () => {
  assert.match(rollback, /tidak boleh dibersihkan selama rollback/i);
  assert.match(rollback, /jangan menghapus tabel\/kolom/i);
  assert.match(rollback, /jangan menghapus object/i);
  assert.match(rollback, /regression\n\s*test/i);
});

