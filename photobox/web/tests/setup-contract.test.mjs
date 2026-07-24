import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("operator installer and setup share a prefilled 15 minute setup-code contract", async () => {
  const [setup, platform, bridge, agent] = await Promise.all([
    read("setup.js"),
    read("api/platform.mjs"),
    read("api/bridge.mjs"),
    read("../agent.py"),
  ]);
  assert.match(setup, /params\.get\("code"\)/);
  assert.match(setup, /restoreSetupDraft\(setupCodeFromUrl\)/);
  assert.match(platform, /photoslive:pairing:\$\{code\}/);
  assert.match(bridge, /\{ ex: 900 \}/);
  assert.match(agent, /urlencode\(\{"code": pairing_code\}\)/);
  assert.match(agent, /\/setup\?\{query\}/);
});

test("computer setup exposes every required real onboarding control", async () => {
  const [html, setup] = await Promise.all([read("setup.html"), read("setup.js")]);
  const requiredIds = [
    "pairing-code", "booth-name", "booth-location", "owner-email", "owner-pin",
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

test("setup detects the operating system and keeps secrets out of restart draft", async () => {
  const [html, setup] = await Promise.all([read("setup.html"), read("setup.js")]);
  assert.match(setup, /navigator\.userAgentData\?\.platform/);
  assert.match(setup, /function detectedOperatingSystem/);
  assert.match(html, /id="primary-agent-download"/);
  assert.match(html, /Download installer ringan/);
  assert.match(html, /GUI lokal tersedia di/);
  assert.match(html, /Pakai sistem operasi lain/);
  assert.match(html, /Metode teknisi melalui Terminal/);
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
