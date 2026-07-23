import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = file => fs.readFileSync(path.join(root, "docs", file), "utf8");

test("operator documentation covers install, setup, local manager, booth, admin and superadmin", () => {
  const install = read("INSTALLATION-SETUP-GUIDE.md");
  const manager = read("LOCAL-MANAGER-GUIDE.md");
  const surfaces = read("BOOTH-ADMIN-SUPERADMIN-GUIDE.md");
  assert.match(install, /Windows, macOS, atau Linux/);
  assert.match(install, /Tablet standalone/);
  assert.match(manager, /127\.0\.0\.1:8080\/local-agent/);
  assert.match(manager, /menutup browser tidak menghentikannya|GUI ditutup, service tetap berjalan/);
  assert.match(surfaces, /\/{boothCode}\/admin/);
  assert.match(surfaces, /\/superadmin/);
});

test("offline guide protects unsynced photos and separates Agent from cloud save", () => {
  const guide = read("OFFLINE-TROUBLESHOOTING.md");
  assert.match(guide, /Jangan menghapus foto unsynced/);
  assert.match(guide, /Agent\s+offline bukan alasan save cloud gagal/);
  assert.match(guide, /reserve 2 GB/);
});

test("API, integration, finance and privacy docs keep secrets server-only and gates honest", () => {
  const api = read("API-REFERENCE.md");
  const finance = read("INTEGRATIONS-FINANCE-GUIDE.md");
  const privacy = read("PRIVACY-TERMS.md");
  assert.match(api, /POST \/api\/local\/storage\/pick-folder/);
  assert.match(api, /save config\/voucher tidak\n?boleh memanggil Agent/);
  assert.match(finance, /tidak masuk browser bundle, Agent, atau log/);
  assert.match(finance, /Production\npayout dan KYC tetap dinonaktifkan/);
  assert.match(privacy, /maksimal 24 jam/);
  assert.match(privacy, /bukan pengganti terms\/legal review/);
});

test("documentation index and release notes link current operational evidence without claiming maturity", () => {
  const index = read("DOCUMENTATION-INDEX.md");
  const release = read("RELEASE-NOTES.md");
  for (const name of ["INSTALLATION-SETUP-GUIDE.md", "LOCAL-MANAGER-GUIDE.md", "API-REFERENCE.md", "PRIVACY-TERMS.md"]) assert.match(index, new RegExp(name.replaceAll(".", "\\.")));
  assert.match(release, /0\.3\.0/);
  assert.match(release, /belum mature production/);
  assert.match(release, /soak 72 jam masih menjadi release gate/);
});
