import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const vercel = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
const rewrite = source => vercel.rewrites.find(entry => entry.source === source);
const redirect = source => vercel.redirects.find(entry => entry.source === source);

test("account admin route resolves to the account-first surface", () => {
  assert.equal(redirect("/admin")?.destination, "/account-admin");
  assert.equal(redirect("/admin")?.permanent, false);
});

test("tenant admin keeps the machine dashboard separate from account admin", () => {
  assert.equal(rewrite("/:booth/admin")?.destination, "/admin?booth=:booth");
});

test("tenant admin accepts a booth from the Supabase account ownership list", () => {
  const [app, platform] = [
    readFileSync(resolve(root, "app.js"), "utf8"),
    readFileSync(resolve(root, "api/platform.mjs"), "utf8"),
  ];
  assert.match(app, /const ownedBooth = \(auth\.booths \|\| \[\]\)\.find\(booth => booth\.boothCode === adminBoothCode\)/);
  assert.match(app, /location\.replace\(auth\.user\s*\?\s*"\/account-admin"/);
  assert.match(platform, /account\?\.booths\?\.some\(item => item\.boothCode === booth\.boothCode\)/);
  assert.match(platform, /authProvider === "supabase"/);
});

test("clean URL rewrites never target an html extension", () => {
  assert.equal(vercel.cleanUrls, true);
  for (const entry of vercel.rewrites) {
    assert.doesNotMatch(entry.destination.split("?")[0], /\.html$/);
  }
  assert.equal(rewrite("/:booth")?.destination, "/booth?booth=:booth");
  assert.equal(rewrite("/:booth/sesi/:session")?.destination, "/session?booth=:booth&session=:session");
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

test("primary platform actions keep external SVG icons visible", () => {
  const [html, css] = [
    readFileSync(resolve(root, "account-admin.html"), "utf8"),
    readFileSync(resolve(root, "platform.css"), "utf8"),
  ];
  assert.match(html, /class="btn primary account-add-primary"[^>]*><img src="\/icons\/plus\.svg"/);
  assert.match(css, /\.btn\.primary img\s*\{[^}]*filter:\s*brightness\(0\) invert\(1\)/s);
});

test("every static icon reference resolves to a shipped asset", () => {
  const sourceFiles = readdirSync(root).filter(file => /\.(?:html|js)$/.test(file));
  const iconReferences = new Set(
    sourceFiles.flatMap(file => [
      ...readFileSync(resolve(root, file), "utf8").matchAll(/["'](\/icons\/[a-z0-9._-]+\.svg)["']/gi),
    ].map(match => match[1])),
  );
  assert.ok(iconReferences.size > 0);
  for (const iconPath of iconReferences) {
    assert.equal(existsSync(resolve(root, iconPath.slice(1))), true, `${iconPath} is missing`);
  }
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

test("cloud setup keeps a reusable web pairing QR separate from optional Helper installation", () => {
  const [html, script, bridge] = [
    "setup.html",
    "setup.js",
    "api/bridge.mjs",
  ].map(file => readFileSync(resolve(root, file), "utf8"));
  assert.match(html, /id="local-qr-side"/);
  assert.match(html, /id="refresh-web-pairing"/);
  assert.match(html, /id="station-form"/);
  assert.match(html, /Buka photobox/);
  assert.match(html, /Tambahkan ke desktop/);
  assert.match(html, /dapat diaktifkan nanti dari Admin melalui Photoslive Helper/);
  assert.doesNotMatch(html, /<details class="station-agent-install"/);
  assert.match(script, /create_web_pairing/);
  assert.match(script, /WEB_PAIRING_STORAGE_KEY/);
  assert.match(script, /setInterval\(inspectWebPairing, 30_000\)/);
  assert.match(bridge, /async function createWebPairing/);
  assert.match(bridge, /HttpOnly; SameSite=Lax/);
  assert.match(bridge, /const \{ _stationCredential, \.\.\.publicPairing \} = pairing/);
  assert.match(bridge, /"set-cookie": stationCookie/);
  assert.doesNotMatch(script, /stationCredential/);
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
