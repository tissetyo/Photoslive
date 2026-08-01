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
  assert.match(booth, /setWelcomeButtonState\("loading"\);[\s\S]*?readCachedBoothConfig\(\)/);
  assert.match(booth, /localStorage\.getItem\(boothConfigCacheKey\(\)\)/);
  assert.match(booth, /boothState\.config = cached;[\s\S]*?resetBooth\(\{ preserveRecovery: true \}\);[\s\S]*?setWelcomeButtonState/);
  const openGate = booth.slice(booth.indexOf("async function openAccessGate"), booth.indexOf("async function retryBoothConfig"));
  assert.doesNotMatch(openGate, /boothApi\("\/api\/booth\/config"/);
});

test("welcome visibility settings are applied without dead-ending the customer flow", async () => {
  const [html, booth] = await Promise.all([read("booth.html"), read("booth.js")]);
  for (const id of ["welcome-title", "welcome-prompt", "welcome-start"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(booth, /appearance\.showWelcomeTitle !== false/);
  assert.match(booth, /appearance\.showTouchPrompt !== false/);
  assert.match(booth, /appearance\.showStartButton !== false/);
  assert.match(booth, /welcome-screen"\)\.addEventListener\("click"[\s\S]*?openAccessGate\(\)/);
});

test("web-only booth sessions never wait for a Helper hardware job", async () => {
  const [booth, platform] = await Promise.all([read("booth.js"), read("api/platform.mjs")]);
  assert.match(booth, /if \(helperRuntimeActive\(\)\) return boothCloudControllerApi/);
  assert.match(booth, /return boothWebRuntimeApi\(path, options\)/);
  assert.match(booth, /async function boothWebRuntimeApi/);
  assert.match(booth, /pathname === "\/api\/booth\/sessions"/);
  assert.match(booth, /pathname === "\/api\/booth\/print"[\s\S]*?window\.print\(\)/);
  assert.match(platform, /mode: "browser"/);
  assert.match(platform, /const helperActive = helper\.desiredState === "enabled" && helper\.actualState === "online"/);
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

test("frame selection is a touch-first catalogue with mirrored live two-strip preview", async () => {
  const [html, css, booth] = await Promise.all([read("booth.html"), read("booth.css"), read("booth.js")]);
  assert.match(html, /class="frame-catalog"[\s\S]*?class="frame-selection-preview"/);
  assert.match(html, /id="selected-frame-preview-sheet"/);
  assert.match(html, /id="frame-mirror-toggle"[^>]+aria-pressed="false"/);
  assert.match(booth, /thumb\.append\(createFrameStrip\(frame\), createFrameStrip\(frame\)\)/);
  assert.match(booth, /sheet\.append\(createFrameStrip\(boothState\.selectedFrame, "selected-frame-strip"\), createFrameStrip\(boothState\.selectedFrame, "selected-frame-strip"\)\)/);
  assert.match(booth, /#frame-mirror-toggle"\)\.addEventListener\("click"[\s\S]*?applyCameraTransform\(\)/);
  assert.match(css, /\.frame-picker-panel \{[\s\S]*?grid-template-columns: minmax\(420px, 1\.08fr\) minmax\(360px, \.92fr\)/);
  assert.match(css, /\.frame-option \{[\s\S]*?touch-action: manipulation/);
  assert.match(css, /\.mirror-toggle \{[\s\S]*?min-height: 48px/);
});

test("session timer stays pending until a frame creates the real session", async () => {
  const [html, booth] = await Promise.all([read("booth.html"), read("booth.js")]);
  assert.match(html, /id="session-time-label">MULAI SETELAH FRAME/);
  assert.match(html, /id="session-countdown">--:--/);
  assert.match(booth, /function enterFrameSelection\(\) \{[\s\S]*?#session-countdown"\)\.textContent = "--:--"/);
  assert.match(booth, /function startSessionTimer\(\) \{[\s\S]*?#session-time-label"\)\.textContent = "WAKTU SESI"/);
  assert.match(booth, /async function createSession\(\)[\s\S]*?startSessionTimer\(\)/);
});

test("capture confirmation stays concise and admin access is welcome-only", async () => {
  const [html, css, booth] = await Promise.all([read("booth.html"), read("booth.css"), read("booth.js")]);
  assert.match(html, /id="capture-heading">Siap foto\?/);
  assert.match(html, /id="capture-ready-help">Pastikan semua terlihat\./);
  assert.match(html, /id="camera-start">Mulai foto/);
  assert.doesNotMatch(html, /LANGKAH 2 DARI 3|Setelah ditekan, hitung mundur/);
  assert.match(booth, /#booth-admin-entry"\)\.hidden = name !== "welcome"/);
  assert.match(css, /\.booth-app:not\(\[data-screen="welcome"\]\) \.booth-admin-entry\{display:none\}/);
});

test("voucher, confirmation, and a single accessible review modal are wired to the real flow", async () => {
  const [html, css, booth] = await Promise.all([read("booth.html"), read("booth.css"), read("booth.js")]);
  assert.match(html, /id="redeem-access-voucher"/);
  assert.match(booth, /async function redeemAccessVoucher\(\)[\s\S]*?\/api\/vouchers\/redeem[\s\S]*?enterFrameSelection\(\)/);
  assert.match(booth, /#redeem-access-voucher"\)\.addEventListener\("click", redeemAccessVoucher\)/);
  assert.match(booth, /#camera-start"\)\.addEventListener\("click", runShotCountdown\)/);
  assert.match(css, /\.capture-ready-overlay\{[\s\S]*?background:rgba\(8,10,15,\.28\);backdrop-filter:blur\(14px\)/);
  assert.match(html, /id="photo-review" role="dialog" aria-modal="true" aria-labelledby="review-title" hidden/);
  assert.match(html, /id="review-title">Pakai foto ini\?/);
  assert.match(html, /id="capture-hud"/);
  assert.doesNotMatch(html, /id="capture-instruction"|Mengambil foto|Tetap diam sebentar/);
  assert.doesNotMatch(booth, /capture-instruction|Mengambil foto|Tetap diam sebentar/);
  assert.match(booth, /function setPhotoReviewVisible\(visible\)[\s\S]*?#capture-hud"\)\.hidden = visible/);
  assert.match(booth, /setPhotoReviewVisible\(true\)/);
  assert.match(css, /\/\* Photo review is one focused, touch-first modal\.[\s\S]*?\.photo-review\{position:absolute;z-index:25;inset:0/);
  assert.match(css, /\.review-actions \.touch-button\{[\s\S]*?min-height:66px/);
  assert.doesNotMatch(html, /SIAPKAN GAYA TERBAIKMU/);
  assert.match(html, /class="shot-countdown-badge" id="countdown-overlay" aria-live="polite" hidden/);
  assert.doesNotMatch(html, /class="countdown-overlay"/);
  assert.match(css, /\.shot-countdown-badge\{position:absolute;z-index:20;top:108px;left:50%;[\s\S]*?pointer-events:none\}/);
  assert.match(booth, /async function runShotCountdown\(\)[\s\S]*?const overlay = \$\("#countdown-overlay"\); overlay\.hidden = false/);
  assert.match(booth, /if \(boothState\.currentSlot < boothState\.session\.rules\.photoSlots\)[\s\S]*?runShotCountdown\(\)/);
});

test("completed booth sessions display the Controller-rendered frame output", async () => {
  const [html, css, booth] = await Promise.all([read("booth.html"), read("booth.css"), read("booth.js")]);
  const acceptPhoto = booth.slice(
    booth.indexOf("async function acceptCurrentPhoto"),
    booth.indexOf("function enterFrameSelection"),
  );

  assert.match(acceptPhoto, /const completed = await boothApi\(`\/api\/sessions\/\$\{boothState\.session\.id\}\/complete`/);
  assert.match(acceptPhoto, /completed\.session\?\.outputs\?\.composite\?\.url/);
  assert.match(acceptPhoto, /compositeUrl = boothBinaryUrl\(await boothApi\(outputUrl\)\)/);
  assert.match(acceptPhoto, /showResult\(compositeUrl\)/);
  assert.match(acceptPhoto, /image\.className = "rendered-output"/);
  assert.match(html, /id="final-strip-pair" aria-label="Dua strip hasil cetak"/);
  assert.match(html, /id="final-frame"[\s\S]*?id="final-frame-copy"/);
  assert.match(acceptPhoto, /document\.querySelectorAll\("\.final-frame"\)/);
  assert.match(acceptPhoto, /document\.querySelectorAll\("\.final-slots"\)/);
  assert.match(acceptPhoto, /finalSlotGroups\.forEach\(\(slots, stripIndex\)/);
  assert.match(css, /\.final-frame\.has-rendered-output\{padding:0;border:0;background:none\}/);
  assert.match(css, /\.final-slots img\.rendered-output\{object-fit:contain;border:0\}/);
  assert.match(css, /\.final-strip-pair\{display:flex;align-items:center;justify-content:center/);
  assert.match(css, /\.final-strip-pair \.final-frame:nth-child\(2\)\{transform:rotate\(1deg\)\}/);
  assert.match(css, /@page \{ size: 6in 4in; margin: 0; \}/);
  assert.match(css, /@media print \{[\s\S]*?body \* \{ visibility: hidden !important; \}[\s\S]*?\.final-strip-pair,[\s\S]*?visibility: visible !important/);
  assert.match(css, /\.final-strip-pair \.final-frame \{[\s\S]*?width: 2in !important;[\s\S]*?height: 3\.84in !important/);
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
