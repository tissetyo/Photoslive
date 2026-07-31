import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("operator installer opens local setup while account pairing remains an explicit action", async () => {
  const [setup, bridge, agent] = await Promise.all([
    read("setup.js"),
    read("api/bridge.mjs"),
    read("../agent.py"),
  ]);
  assert.match(setup, /IS_LOCAL_SETUP/);
  assert.match(setup, /\/api\/local\/setup\/bootstrap/);
  assert.match(setup, /\/api\/local\/setup/);
  assert.match(setup, /if \(IS_LOCAL_SETUP\) await bootstrapLocalSetup\(\)/);
  assert.match(setup, /params\.get\("setup"\)/);
  assert.doesNotMatch(setup, /localStorage\.setItem\([^)]*setupToken/);
  assert.match(bridge, /export async function createSetupCode/);
  assert.match(bridge, /createPostgresSetupCode/);
  assert.match(agent, /\/setup\?local=1/);
  assert.match(agent, /def local_setup_page_ready\(/);
  assert.match(agent, /<title>Setup Photoslive<\/title>/);
  assert.match(agent, /if arguments\.setup_link:[\s\S]*local_setup_url\(config\)/);
  assert.match(agent, /if arguments\.setup_link:[\s\S]*local_setup_page_ready\(config\)/);
  assert.match(agent, /if arguments\.pairing_link:/);
  assert.match(agent, /request_machine_pairing\(config, force=True/);
  assert.doesNotMatch(agent, /--setup-code/);
  assert.doesNotMatch(agent, /request_setup_code/);
});

test("computer setup exposes every required real onboarding control", async () => {
  const [html, setup] = await Promise.all([read("setup.html"), read("setup.js")]);
  const requiredIds = [
    "setup-token", "booth-name", "booth-location", "owner-email", "owner-pin",
    "owner-pin-confirm", "setup-camera-select", "test-setup-camera",
    "setup-printer-select", "test-setup-printer", "pick-setup-storage-folder",
    "starter-frame-file", "ready-checklist", "finish-onboarding",
  ];
  requiredIds.forEach(id => assert.match(html, new RegExp(`id=["']${id}["']`), id));
  assert.match(setup, /controllerRequest\("\/api\/storage\/pick-folder"/);
  assert.match(setup, /\/api\/devices\/camera\/test/);
  assert.match(setup, /\/api\/devices\/printer\/test-page/);
  assert.match(setup, /setupUploadAsset\(onboarding\.frameFile, "frame"/);
  assert.match(setup, /location\.href = `\/\$\{code\}`/);
});

test("legacy setup detects the operating system and keeps secrets out of restart draft", async () => {
  const [html, setup] = await Promise.all([read("setup.html"), read("setup.js")]);
  assert.match(setup, /navigator\.userAgentData\?\.platform/);
  assert.match(setup, /function detectedOperatingSystem/);
  assert.match(html, /id="primary-agent-download"/);
  assert.match(html, /Download installer ringan/);
  assert.match(html, /Metode teknisi melalui Terminal/);
  assert.match(html, /Pakai sistem operasi lain/);
  assert.match(setup, /primary-agent-download/);
  assert.match(setup, /downloadUrl: '\/downloads\/install-windows\.ps1'/);
  assert.match(setup, /downloadUrl: '\/downloads\/install-macos\.sh'/);
  assert.match(setup, /downloadUrl: '\/downloads\/install-linux\.sh'/);
  assert.match(setup, /PIN and uploaded file contents are intentionally never persisted/);
  const persistedBlock = setup.slice(setup.indexOf("function persistSetupDraft"), setup.indexOf("function clearSetupDraft"));
  assert.doesNotMatch(persistedBlock, /owner-pin/);
  assert.match(setup, /Setup dilanjutkan dari langkah terakhir/);
});

test("optional hardware and frame steps are skippable with one primary action per step", async () => {
  const html = await read("setup.html");
  assert.equal((html.match(/data-setup-skip/g) || []).length, 2);
  assert.match(html, /data-setup-step="4"[\s\S]*?Lewati dulu[\s\S]*?id="save-device-onboarding"/);
  assert.match(html, /data-setup-step="5"[\s\S]*?Gunakan bawaan[\s\S]*?id="save-onboarding-frame"/);
  assert.match(html, /id="finish-onboarding">Mulai gunakan photobox/);
});

test("tablet setup uses real browser capabilities and keeps limitations explicit", async () => {
  const [html, setup, booth] = await Promise.all([read("setup.html"), read("setup.js"), read("booth.js")]);
  [
    "tablet-camera-facing", "tablet-camera-preview", "test-tablet-camera",
    "persist-tablet-storage", "install-tablet-pwa", "tablet-runtime-status",
    "tablet-print-status",
  ].forEach(id => assert.match(html, new RegExp(`id=["']${id}["']`), id));
  assert.match(setup, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(setup, /canvas\.toBlob\(resolve, "image\/jpeg"/);
  assert.match(setup, /navigator\.storage\.persist\(\)/);
  assert.match(setup, /beforeinstallprompt/);
  assert.match(setup, /AirPrint\/IPP tetap mengikuti dukungan browser dan printer/);
  assert.match(setup, /silent print, printer USB, dan antrean CUPS memerlukan komputer pendamping/);
  assert.match(html, /dapat menghentikan sinkronisasi ketika aplikasi berada di background/);
  assert.match(booth, /photoslive\.tabletCameraFacingMode/);
  assert.match(booth, /facingMode: \{ ideal: preferredFacingMode \}/);
});

test("setup and booth register an API-safe offline PWA shell", async () => {
  const [setupHtml, boothHtml, setup, booth, serviceWorker, manifestText] = await Promise.all([
    read("setup.html"), read("booth.html"), read("setup.js"), read("booth.js"), read("sw.js"), read("app.webmanifest"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/booth");
  assert.match(setupHtml, /rel="manifest" href="\/app\.webmanifest"/);
  assert.match(boothHtml, /rel="manifest" href="\/app\.webmanifest"/);
  assert.match(setup, /serviceWorker\.register\("\/sw\.js"/);
  assert.match(booth, /serviceWorker\.register\("\/sw\.js"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /pathname === "\/setup"/);
  assert.match(serviceWorker, /return "\/booth\.html"/);
});

test("Local Manager creates a pairing claim only after an explicit operator action", async () => {
  const [localManager, localManagerScript, controller] = await Promise.all([
    read("local-agent.html"),
    read("local-agent.js"),
    read("../server.py"),
  ]);
  assert.match(localManager, /<b>Hubungkan ke akun<\/b>/);
  assert.match(localManager, /id="create-machine-pairing"/);
  assert.match(localManager, /id="machine-pairing-qr"/);
  assert.match(localManager, /id="copy-machine-pairing"/);
  assert.match(localManagerScript, /\/api\/local\/agent\/setup-code/);
  assert.match(localManagerScript, /navigator\.clipboard\.writeText\(state\.machinePairingCode\)/);
  assert.match(controller, /"--pairing-link", "--json"/);
  assert.match(controller, /pairing_url = str\(payload\.get\("pairingUrl"\) or ""\)/);
});

test("setup UI hides internal registration details and avoids a one-option selector", async () => {
  const [html, css, setup] = await Promise.all([
    read("setup.html"),
    read("setup.css"),
    read("setup.js"),
  ]);
  assert.match(html, /id="setup-token" type="hidden"/);
  assert.doesNotMatch(html, />\s*(Kode setup|Masukkan pairing code)\s*</i);
  assert.match(html, /class="login-methods single-method"/);
  assert.match(html, /class="login-method-note"[^>]*>[\s\S]*Email &amp; password/);
  assert.match(css, /\.login-methods\.single-method \.method-switch \{ display: none; \}/);
  assert.match(css, /\.setup-icon\s*\{[\s\S]*mask: var\(--setup-icon\)/);
  assert.match(setup, /methods\.classList\.remove\("single-method"\)/);
  assert.match(setup, /if \(!capability\.available \|\| !capability\.boothCode\) return/);
});

test("cloud account registration is real and does not require an installer", async () => {
  const [html, setup, platform] = await Promise.all([
    read("setup.html"),
    read("setup.js"),
    read("api/platform.mjs"),
  ]);
  assert.match(html, /data-mode="register">Buat akun/);
  assert.match(html, /id="register-email"/);
  assert.match(html, /id="register-password"/);
  assert.match(html, /id="register-password-confirm"/);
  assert.match(html, /Mulai tanpa installer/);
  assert.match(setup, /api\("register"/);
  assert.match(setup, /const IS_LOOPBACK_HOST = \["127\.0\.0\.1", "localhost", "::1"\]/);
  assert.match(setup, /const CLOUD_PLATFORM_ORIGIN = "https:\/\/photoslive\.vercel\.app"/);
  assert.match(setup, /location\.replace\(cloudRegistrationUrl\(\)\)/);
  assert.match(setup, /requestedMode === "register" && continueRegistrationOnCloud\(\)/);
  assert.match(setup, /pairing: \["Hubungkan photobox", "Scan QR atau masukkan kode dari layar mesin photobox\."\]/);
  assert.match(platform, /export async function registerAccount/);
  assert.match(platform, /action === "register"/);
  assert.match(platform, /status: "not-installed"/);
});
