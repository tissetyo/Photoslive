import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("booth shell runs without loading the admin bundle", async () => {
  const html = await read("booth.html");
  assert.match(html, /src="\/booth\.js/);
  assert.match(html, /href="\/booth\.css/);
  assert.doesNotMatch(html, /(?:app\.js|admin\.html|superadmin\.js)/);
});

test("welcome waits for cached or fresh configuration before it becomes actionable", async () => {
  const [html, booth] = await Promise.all([read("booth.html"), read("booth.js")]);
  assert.match(html, /id="welcome-start" disabled aria-busy="true"/);
  assert.match(booth, /setWelcomeButtonState\("loading"\);[\s\S]*?localStorage\.getItem\(boothConfigCacheKey\(\)\)/);
  assert.match(booth, /boothState\.config = cached;[\s\S]*?resetBooth\(\{ preserveRecovery: true \}\);[\s\S]*?setWelcomeButtonState/);
  const openGate = booth.slice(booth.indexOf("async function openAccessGate"), booth.indexOf("async function retryBoothConfig"));
  assert.doesNotMatch(openGate, /boothApi\("\/api\/booth\/config"/);
});

test("customer continuation records versioned photo-processing consent", async () => {
  const [html, booth] = await Promise.all([read("booth.html"), read("booth.js")]);
  assert.match(html, /Dengan melanjutkan, kamu menyetujui foto diproses untuk sesi ini/);
  assert.match(booth, /boothState\.consent = \{ accepted: true, version: "2026-07-21", method: "welcome_continue" \}/);
  assert.match(booth, /frameId: boothState\.selectedFrame\.url, consent: boothState\.consent/);
  assert.match(booth, /boothState\.consent = null/);
});

test("offline QRIS never silently becomes a free session", async () => {
  const [html, booth] = await Promise.all([read("booth.html"), read("booth.js")]);
  assert.match(html, /id="access-offline-section" hidden/);
  assert.match(booth, /const qrisEnabled = qrisConfigured && boothState\.cloudOnline/);
  assert.match(booth, /#access-offline-section"\)\.hidden = qrisEnabled \|\| voucherEnabled \|\| !qrisConfigured/);
  assert.match(booth, /if \(!qrisConfigured && !voucherEnabled\) \{ enterFrameSelection\(\); return; \}/);
});

test("active customer flow keeps its configuration stable during background refresh", async () => {
  const booth = await read("booth.js");
  assert.match(booth, /dataset\.screen !== "welcome"\) boothState\.pendingConfig = freshConfig/);
  assert.match(booth, /if \(boothState\.pendingConfig\) \{[\s\S]*?applyConfiguration\(\)/);
});

test("booth markup has unique element ids", async () => {
  const html = await read("booth.html");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test("camera and goodbye flow reuse real handlers", async () => {
  const booth = await read("booth.js");
  assert.match(booth, /function enterFrameSelection\(\) \{[\s\S]*?startCameraPreview\(\)/);
  assert.match(booth, /if \(boothState\.cameraStream\) return startBrowserCamera\(\)/);
  assert.match(booth, /let remaining = 15/);
  assert.match(booth, /#skip-goodbye"\)\.addEventListener\("click", resetBooth\)/);
});

test("frame library supports search, pagination, and an accessible empty state", async () => {
  const [html, booth] = await Promise.all([read("booth.html"), read("booth.js")]);
  assert.match(html, /id="frame-search" type="search" placeholder="Cari frame"/);
  assert.match(html, /<span class="sr-only">Cari frame<\/span>/);
  assert.match(booth, /const filteredFrames = query[\s\S]*?\.filter\(frame => frameDisplayName\(frame\)/);
  assert.match(booth, /const pageCount = Math\.max\(1, Math\.ceil\(filteredFrames\.length \/ pageSize\)\)/);
  assert.match(booth, /empty\.className = "frame-empty"[\s\S]*?Frame tidak ditemukan/);
  assert.match(booth, /#frame-search"\)\.addEventListener\("input", event => \{ boothState\.frameQuery = event\.target\.value; boothState\.framePage = 0; renderFrames\(\); \}\)/);
});

test("voucher, confirmation, and compact retake controls are wired to the real flow", async () => {
  const [html, css, booth] = await Promise.all([read("booth.html"), read("booth.css"), read("booth.js")]);
  assert.match(html, /id="redeem-access-voucher"/);
  assert.match(booth, /async function redeemAccessVoucher\(\)[\s\S]*?\/api\/vouchers\/redeem[\s\S]*?enterFrameSelection\(\)/);
  assert.match(booth, /#redeem-access-voucher"\)\.addEventListener\("click", redeemAccessVoucher\)/);
  assert.match(booth, /#camera-start"\)\.addEventListener\("click", runShotCountdown\)/);
  assert.match(css, /\.capture-ready-overlay\{[\s\S]*?background:rgba\(8,10,15,\.28\);backdrop-filter:blur\(14px\)/);
  assert.match(css, /\/\* Keep the latest-photo decision compact in the lower-left corner\. \*\/[\s\S]*?\.photo-review\{inset:auto auto/);
});

test("completed booth sessions display the Controller-rendered frame output", async () => {
  const [css, booth] = await Promise.all([read("booth.css"), read("booth.js")]);
  const acceptPhoto = booth.slice(
    booth.indexOf("async function acceptCurrentPhoto"),
    booth.indexOf("function enterFrameSelection"),
  );

  assert.match(acceptPhoto, /const completed = await boothApi\(`\/api\/sessions\/\$\{boothState\.session\.id\}\/complete`/);
  assert.match(acceptPhoto, /completed\.session\?\.outputs\?\.composite\?\.url/);
  assert.match(acceptPhoto, /compositeUrl = boothBinaryUrl\(await boothApi\(outputUrl\)\)/);
  assert.match(acceptPhoto, /showResult\(compositeUrl\)/);
  assert.match(acceptPhoto, /image\.className = "rendered-output"/);
  assert.match(css, /\.final-frame\.has-rendered-output\{padding:0;border:0;background:none\}/);
  assert.match(css, /\.final-slots img\.rendered-output\{object-fit:contain;border:0\}/);
});

test("active and completed sessions recover after browser or Controller restart", async () => {
  const booth = await read("booth.js");
  assert.match(booth, /const boothSessionRecoveryKey = \(\) => `photoslive\.activeSession/);
  assert.match(booth, /function rememberSession\(session\)[\s\S]*?localStorage\.setItem\(boothSessionRecoveryKey\(\)/);
  assert.match(booth, /async function recoverPersistedSession\(\)[\s\S]*?boothApi\(`\/api\/sessions\/\$\{encodeURIComponent\(saved\.shareToken\)\}`\)/);
  assert.match(booth, /session\.status === "completed"[\s\S]*?showResult/);
  assert.match(booth, /const pending = \(session\.slots \|\| \[\]\)\.find\(slot => !slot\.selectedFileId\)/);
  assert.match(booth, /if \(!pending\) \{[\s\S]*?\/complete`/);
  assert.match(booth, /function resetBooth\(\{ preserveRecovery = false \} = \{\}\)[\s\S]*?localStorage\.removeItem\(boothSessionRecoveryKey\(\)\)/);
});

test("local booth discovers a remotely recovered session without exposing its capability to cloud", async () => {
  const booth = await read("booth.js");
  assert.match(booth, /const localControllerAvailable = \(\) => \["127\.0\.0\.1", "localhost"\]/);
  assert.match(booth, /boothApi\("\/api\/booth\/recovery", \{ timeoutMs: 2500 \}\)/);
  assert.match(booth, /rememberSession\(session\);[\s\S]*?recoverPersistedSession\(\)/);
  assert.match(booth, /setInterval\(\(\) => discoverLocalRecoverableSession\(\)/);
});
