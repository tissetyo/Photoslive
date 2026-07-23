import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [html, app, platform, bridge, guide] = await Promise.all([
  read("../admin.html"),
  read("../app.js"),
  read("../api/platform.mjs"),
  read("../api/bridge.mjs"),
  read("../../docs/ADMIN-CAPABILITIES.md"),
]);

const setting = path => new RegExp(`data-setting="${path.replaceAll(".", "\\.")}"`);

test("admin appearance, session, payment, device, storage and maintenance controls are real settings", () => {
  for (const path of [
    "appearance.screenPreset", "appearance.logoSizePercent", "appearance.headingFontSize",
    "appearance.helperFontSize", "appearance.buttonFontSize", "booth.photoSlotsPerSession",
    "booth.countdownSeconds", "booth.sessionTimeoutSeconds", "booth.unlimitedRetakes",
    "payment.qrisEnabled", "payment.voucherEnabled", "payment.paidPrintEnabled",
    "storage.localPhotoPath", "storage.cloudEnabled", "booth.cloudRetentionDays",
    "booth.maintenanceMode",
  ]) assert.match(html, setting(path), `${path} is missing from admin`);

  assert.match(app, /function markSetting\(input\)[\s\S]*?state\.dirtySections\.add/);
  assert.match(app, /async function saveSettings\(\)[\s\S]*?api\("\/api\/settings"/);
  assert.match(platform, /request\.method === "PATCH" && \(path === "\/api\/settings"/);
  assert.match(platform, /appendAudit\([\s\S]*?"settings\.updated"/);
});

test("admin libraries and frame editor use persistent asset APIs instead of decorative controls", () => {
  assert.match(html, /id="background-pagination"/);
  for (const id of [
    "frame-editor-dialog", "frame-upload-preview", "frame-element-rotation",
    "frame-element-size", "frame-element-opacity", "frame-layer-list",
    "add-frame-sticker", "save-frame-upload",
  ]) assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
  assert.match(app, /async function uploadAssetFile/);
  assert.match(app, /cloudDataApi\(`\/api\/assets\/\$\{kind\}\/prepare`/);
  assert.match(platform, /path\.match\(\/\^\\\/api\\\/assets\\\/\[\^\/\]\+\\\/finalize\$\//);
  assert.match(app, /state\.pendingFrameUpload\.stickers\.push/);
  assert.match(app, /item\.rotation/);
  assert.match(app, /item\.opacity/);
});

test("frame editor and printer preview render through the same canonical template", () => {
  assert.match(app, /function frameTemplateMarkup\(frameUrl, options = \{\}\)/);
  assert.match(app, /#active-frame-preview"\)\.innerHTML = frameTemplateMarkup\(appearance\.activeFrame\)/);
  assert.match(app, /#print-sheet-strips"\)\.innerHTML = Array\.from\([\s\S]*?frameTemplateMarkup\(appearance\.activeFrame\)/);
});

test("voucher, event, device test and user role actions have cloud or hardware operations", () => {
  for (const id of [
    "create-voucher", "generate-vouchers", "create-voucher-event", "camera-select",
    "printer-select", "test-camera", "test-printer", "add-user-form", "user-rows",
  ]) assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
  assert.match(app, /async function generateVouchers/);
  assert.match(app, /\/api\/vouchers\/generate/);
  assert.match(platform, /path === "\/api\/voucher-events"/);
  assert.match(app, /api\(`\/api\/devices\/\$\{kind\}\/test`/);
  assert.match(app, /\/api\/devices\/printer\/test-page/);
  assert.match(app, /platformApi\("users", \{ method: "POST"/);
  assert.match(platform, /Peran Operator tidak dapat mengubah pembayaran atau voucher/);
  assert.match(bridge, /HARDWARE_JOB_TYPES/);
});

test("admin dashboard exposes readiness, machine status and actionable repair links", () => {
  for (const id of ["health-banner", "device-summary", "agent-machine-panel", "notice-message", "notice-action"]) {
    assert.match(html, new RegExp(`(?:id|class)="[^"]*${id}`), `${id} is missing`);
  }
  assert.match(app, /function errorActionFor\(message\)/);
  for (const view of ["devices", "agent", "storage", "access", "users"]) {
    assert.match(app, new RegExp(`view: "${view}"`), `repair route ${view} is missing`);
  }
  assert.match(app, /resolvedAction \? 7000 : 3200/);
});

test("admin capability guide records every implemented booth-admin capability", () => {
  for (const item of ["Integrations", "Finance", "Agent connection switch", "Update/version/rollback", "Sync/upload queue", "Print queue", "Session recovery"]) {
    assert.match(guide, new RegExp(`\\| ${item.replaceAll("/", "\\/")} \\| Selesai \\|`));
  }
  assert.match(guide, /Pengaturan cloud tidak menunggu Agent/);
  assert.match(guide, /least privilege/i);
});
