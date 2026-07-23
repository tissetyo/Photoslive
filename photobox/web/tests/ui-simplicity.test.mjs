import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

test("admin exposes compact navigation and truthful capability states", () => {
  const html = read("admin.html");
  const script = read("app.js");
  const css = read("styles.css");

  assert.match(html, /class="section-jump"/);
  assert.match(html, />INTERNET</);
  assert.match(script, /function describePlatformError/);
  assert.match(script, /function setViewCapabilityState/);
  assert.match(script, /function simplifyAdminLayout/);
  assert.match(script, /data-feature-retry/);
  assert.match(script, /#integrations-view.*is-feature-unavailable/);
  assert.match(script, /#finance-view.*is-feature-unavailable/);
  assert.match(html, /id="finance-view"[\s\S]*class="feature-body finance-dashboard"/);
  assert.match(css, /is-feature-unavailable > \.feature-body \{ display: none; \}/);
  assert.match(script, /Finance belum diaktifkan/);
  assert.match(script, /steps: \["Hubungkan database cloud", "Pilih provider pembayaran", "Aktifkan payout photobox"\]/);
  assert.match(script, /actionView: "integrations"/);
  assert.match(script, /if \(!titles\[name\]\) name = "overview"/);
  assert.match(script, /Penyimpanan hampir penuh/);
  assert.match(script, /#test-camera", "#toggle-camera-preview/);
  assert.match(script, /#test-printer", "#print-test-page/);
  assert.match(css, /\.inline-status\.critical/);
  assert.match(css, /\.section-jump/);
});

test("superadmin groups controls by operational domain without duplicating pages", () => {
  const html = read("superadmin.html");
  const script = read("superadmin.js");
  const css = read("platform.css");

  for (const domain of ["overview", "fleet", "integrations", "finance", "access", "platform"]) {
    assert.match(html, new RegExp(`data-super-domain="${domain}"`));
  }
  assert.match(script, /const SUPERADMIN_DOMAINS/);
  assert.match(script, /function showSuperDomain/);
  assert.match(script, /super-domain-hidden/);
  assert.match(css, /\.super-domain-nav/);
  assert.match(css, /\.super-domain-hidden/);
});
