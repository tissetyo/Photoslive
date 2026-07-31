import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
const rewrite = source => vercel.rewrites.find(entry => entry.source === source);

test("account admin route resolves to the account-first surface", () => {
  assert.equal(rewrite("/admin")?.destination, "/account-admin.html");
  assert.equal(rewrite("/account-admin")?.destination, "/account-admin.html");
});

test("tenant admin keeps the machine dashboard separate from account admin", () => {
  assert.equal(rewrite("/:booth/admin")?.destination, "/admin.html?booth=:booth");
});

test("account admin has a real no-machine empty state", () => {
  const html = readFileSync(resolve(root, "account-admin.html"), "utf8");
  assert.match(html, /id="account-empty"/);
  assert.match(html, />Belum ada photobox<\/h2>/);
  assert.match(html, /mode=pairing/);
});

test("public landing actions point to supported routes", () => {
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  assert.match(html, /href="\/setup"[^>]*>Siapkan mesin baru<\/a>/);
  assert.match(html, /href="\/setup\?mode=login"[^>]*>Masuk ke admin<\/a>/);
  assert.match(html, /href="\/status"/);
  assert.match(html, /href="\/superadmin"/);
  assert.doesNotMatch(html, /href="\/(?:admin|setup|booth)\.html"/);
});

test("canonical account links avoid the legacy admin redirect", () => {
  const html = readFileSync(resolve(root, "account-admin.html"), "utf8");
  assert.match(html, /class="platform-brand" href="\/account-admin"/);
  assert.match(html, /class="active" href="\/account-admin"/);
  assert.doesNotMatch(html, /href="\/admin"/);
});

test("local controller reserves the account admin route from booth-code matching", () => {
  const server = readFileSync(resolve(root, "..", "server.py"), "utf8");
  assert.match(server, /\{"setup", "admin", "account-admin", "superadmin"/);
  assert.match(server, /elif path in \{"\/admin", "\/account-admin"\}:\s+self\.path = "\/account-admin\.html"/);
});

test("account admin explains the WhatsApp-style machine QR flow", () => {
  const html = readFileSync(resolve(root, "account-admin.html"), "utf8");
  assert.match(html, /id="pairing-guide-title"/);
  assert.match(html, /Scan QR mesin/);
  assert.match(html, /QR pairing tampil otomatis di komputer tersebut/);
  assert.match(html, /icons\/scan-line\.svg/);
});

test("account admin exposes persistent account settings without hiding booth users", () => {
  const [html, script, platform, auth] = [
    "account-admin.html",
    "account-admin.js",
    "api/platform.mjs",
    "api/_supabase_auth.mjs",
  ].map(file => readFileSync(resolve(root, file), "utf8"));
  assert.match(html, /id="open-account-settings"/);
  assert.match(html, /id="account-settings-dialog"/);
  assert.match(html, /id="account-settings-password"/);
  assert.match(html, /id="account-users-link"/);
  assert.match(script, /api\("profile"/);
  assert.match(script, /view=users/);
  assert.match(platform, /export async function updateProfile/);
  assert.match(platform, /updateSupabaseUser/);
  assert.match(auth, /export async function updateSupabaseUser/);
});

test("cloud setup keeps a reusable web pairing QR separate from Agent installation", () => {
  const [html, script, bridge] = [
    "setup.html",
    "setup.js",
    "api/bridge.mjs",
  ].map(file => readFileSync(resolve(root, file), "utf8"));
  assert.match(html, /id="local-qr-side"/);
  assert.match(html, /id="refresh-web-pairing"/);
  assert.match(html, /id="station-form"/);
  assert.match(html, /Gunakan versi web/);
  assert.match(html, /Install Photoslive Agent/);
  assert.match(html, /<details class="station-agent-install"/);
  assert.match(script, /create_web_pairing/);
  assert.match(script, /WEB_PAIRING_STORAGE_KEY/);
  assert.match(script, /setInterval\(inspectWebPairing, 10_000\)/);
  assert.match(bridge, /async function createWebPairing/);
});

test("local setup creates the first pairing QR automatically", () => {
  const js = readFileSync(resolve(root, "setup.js"), "utf8");
  assert.match(js, /const shouldCreate = !initialConfig\.paired/);
  assert.match(js, /if \(shouldCreate\)/);
  assert.match(js, /api\/local\/agent\/setup-code/);
});

test("only the installed controller port is local by default", () => {
  const js = readFileSync(resolve(root, "setup.js"), "utf8");
  assert.match(js, /SETUP_QUERY\.get\("local"\) === "1"/);
  assert.match(js, /location\.port === "8080"/);
  assert.match(js, /dev server on 8081\/8082 must stay in the cloud/);
});

test("local setup renders the machine QR in the left column", () => {
  const html = readFileSync(resolve(root, "setup.html"), "utf8");
  const css = readFileSync(resolve(root, "setup.css"), "utf8");
  const js = readFileSync(resolve(root, "setup.js"), "utf8");
  assert.match(html, /id="local-qr-side"/);
  assert.match(html, /id="local-pairing-qr-side"/);
  assert.match(css, /grid-template-areas: "qr card"/);
  assert.match(js, /local-pairing-qr-side/);
});
