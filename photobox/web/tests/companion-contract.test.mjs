import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(webRoot, "..");
const read = relative => fs.readFileSync(path.resolve(projectRoot, relative), "utf8");

const server = read("server.py");
const requirements = read("requirements-controller.txt");
const managerHtml = read("web/local-agent.html");
const managerJs = read("web/local-agent.js");
const companionHtml = read("web/companion.html");
const companionJs = read("web/companion.js");
const companionCss = read("web/companion.css");
const setupHtml = read("web/setup.html");
const setupJs = read("web/setup.js");

test("tablet companion uses an isolated LAN listener and expiring hashed secrets", () => {
  assert.match(server, /class CompanionApiHandler\(SimpleHTTPRequestHandler\)/);
  assert.match(server, /ThreadingHTTPServer\(\("0\.0\.0\.0", companion_port\(\)\), CompanionApiHandler\)/);
  assert.match(server, /#pairing=\{pairing_id\}&token=\{token\}/);
  assert.match(server, /"pairingTokenHash": companion_token_hash\(token\)/);
  assert.match(server, /"sessionTokenHash": companion_token_hash\(session_token\)/);
  assert.match(server, /expires_at = time\.time\(\) \+ 5 \* 60/);
  assert.match(server, /"sessionExpiresAt": now \+ 12 \* 60 \* 60/);
  assert.doesNotMatch(server.slice(server.indexOf("class CompanionApiHandler")), /Access-Control-Allow-Origin/);
  assert.match(requirements, /^qrcode==8\.2$/m);
});

test("companion surface exposes only pairing, status, tests, heartbeat and revoke", () => {
  const handler = server.slice(server.indexOf("class CompanionApiHandler"), server.indexOf("def main()"));
  for (const route of [
    "/api/companion/claim",
    "/api/companion/status",
    "/api/companion/heartbeat",
    "/api/companion/test/storage",
    "/api/companion/test/printer",
    "/api/companion/revoke",
  ]) assert.match(handler, new RegExp(route.replaceAll("/", "\\/")));
  assert.doesNotMatch(handler, /\/api\/settings/);
  assert.doesNotMatch(handler, /\/api\/local\/agent\/restart/);
  assert.match(handler, /"Route companion tidak ditemukan"/);
});

test("Local Manager creates, copies and revokes tablet companion pairing", () => {
  for (const id of ["companion-state", "create-companion-pairing", "copy-companion-link", "revoke-companion", "companion-qr"]) {
    assert.match(managerHtml, new RegExp(`id="${id}"`));
    assert.match(managerJs, new RegExp(id));
  }
  assert.match(managerJs, /\/api\/local\/companion\/pairing/);
  assert.match(managerJs, /\/api\/local\/companion\/revoke/);
  assert.match(managerJs, /navigator\.clipboard\.writeText/);
});

test("tablet companion has reconnect, capture fallback, storage and printer tests", () => {
  for (const id of ["camera-preview", "capture-fallback", "test-storage", "test-printer", "retry-connection", "standalone-fallback"]) {
    assert.match(companionHtml, new RegExp(`id="${id}"`));
  }
  assert.match(companionHtml, /capture="environment"/);
  assert.match(companionJs, /window\.isSecureContext/);
  assert.match(companionJs, /setTimeout\(connect, 3000\)/);
  assert.match(companionJs, /\/api\/companion\/test\/storage/);
  assert.match(companionJs, /\/api\/companion\/test\/printer/);
  assert.match(companionJs, /sessionStorage|localStorage/);
  assert.match(companionCss, /min-height:\s*48px/);
  assert.match(companionCss, /prefers-reduced-motion/);
});

test("setup explains the real computer-companion flow without replacing standalone mode", () => {
  assert.match(setupHtml, /id="companion-setup-help"/);
  assert.match(setupHtml, /Buat QR pairing/);
  assert.match(setupHtml, /standalone/);
  assert.match(setupJs, /companion-setup-help/);
  assert.doesNotMatch(setupJs, /use-companion-agent"\)\.addEventListener\("click", \(\) => agentPlatform\("computer"\)\)/);
});
