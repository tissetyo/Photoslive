import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surfaces = [
  ["admin.html", "app.js"],
  ["booth.html", "booth.js"],
  ["setup.html", "setup.js"],
  ["local-agent.html", "local-agent.js"],
  ["superadmin.html", "superadmin.js"],
  ["session.html", "session.js"],
  ["status.html", "status.js"],
  ["companion.html", "companion.js"],
];

test("every explicit button is wired to its surface script", () => {
  const missing = [];
  for (const [htmlName, scriptName] of surfaces) {
    const html = fs.readFileSync(path.join(root, htmlName), "utf8");
    const script = fs.readFileSync(path.join(root, scriptName), "utf8");
    for (const match of html.matchAll(/<button[^>]*\bid="([^"]+)"[^>]*>/g)) {
      if (!script.includes(match[1])) missing.push(`${htmlName}#${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `Kontrol tanpa handler: ${missing.join(", ")}`);
});

test("interaction inventory has no active control with unknown wiring", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/audit-product.mjs"), "--summary"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.controls, 434);
  assert.equal(summary.unknownControls.length, 0);
  assert.equal(summary.classifications.unknown, 0);
  assert.equal(summary.classifications.wired + summary.classifications.unavailable, summary.controls);
});

test("navigation never uses inert hash links", () => {
  const offenders = surfaces.flatMap(([htmlName]) => {
    const html = fs.readFileSync(path.join(root, htmlName), "utf8");
    return html.includes('href="#"') ? [htmlName] : [];
  });
  assert.deepEqual(offenders, [], `Link tanpa tujuan: ${offenders.join(", ")}`);
});

test("platform hidden states cannot be overridden by button display styles", () => {
  const css = fs.readFileSync(path.join(root, "platform.css"), "utf8");
  assert.match(css, /\[hidden\]\{display:none!important\}/);
});

test("Local Manager keeps checkpoint progress visible beside sync errors", () => {
  const script = fs.readFileSync(path.join(root, "local-agent.js"), "utf8");
  assert.match(script, /const metadata = `<small>\$\{progress\}/);
  assert.match(script, /const detail = `\$\{metadata\}\$\{job\.lastError/);
  assert.match(script, /retry-sync-job/);
});

test("Local Manager print queue exposes real list and scoped retry operations", () => {
  const html = fs.readFileSync(path.join(root, "local-agent.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "local-agent.js"), "utf8");
  assert.match(html, /id="print-job-list"/);
  assert.match(html, /id="refresh-print-jobs"/);
  assert.match(script, /\/api\/local\/print\/jobs\?limit=50/);
  assert.match(script, /\/api\/local\/print\/retry-job/);
  assert.match(script, /retry-print-job/);
});

test("Local Manager exposes signed update and confirmed rollback lifecycle", () => {
  const html = fs.readFileSync(path.join(root, "local-agent.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "local-agent.js"), "utf8");
  const server = fs.readFileSync(path.resolve(root, "..", "server.py"), "utf8");
  const updater = fs.readFileSync(path.resolve(root, "..", "updater.py"), "utf8");
  assert.match(html, /id="check-update"/);
  assert.match(html, /id="install-update" disabled/);
  assert.match(html, /id="rollback-update" disabled/);
  assert.match(html, /id="rollback-confirmation"/);
  assert.match(script, /\/api\/local\/agent\/update\/check/);
  assert.match(script, /\/api\/local\/agent\/update\/apply/);
  assert.match(script, /\/api\/local\/agent\/update\/rollback/);
  assert.match(script, /event\.target\.value !== "ROLLBACK"/);
  assert.match(server, /if not self\.require_local_token\(\)/);
  assert.match(updater, /verify_manifest_signature/);
  assert.match(updater, /download_file/);
  assert.match(updater, /create_backup/);
  assert.match(updater, /health_check/);
  assert.match(updater, /restore_backup/);
});

test("Local Manager keeps Agent hard stop in Advanced with explicit confirmation", () => {
  const html = fs.readFileSync(path.join(root, "local-agent.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "local-agent.js"), "utf8");
  const server = fs.readFileSync(path.resolve(root, "..", "server.py"), "utf8");
  assert.match(html, /class="advanced-agent-controls"/);
  assert.match(html, /id="stop-agent"/);
  assert.match(html, /id="stop-agent-confirmation"/);
  assert.match(script, /event\.target\.value !== "STOP AGENT"/);
  assert.match(script, /\/api\/local\/agent\/stop/);
  assert.match(server, /def supervisor_stop_commands/);
  assert.match(server, /if path == "\/api\/local\/agent\/stop"/);
});

test("Local Manager renders bounded local request, queue, and hardware metrics", () => {
  const html = fs.readFileSync(path.join(root, "local-agent.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "local-agent.js"), "utf8");
  const server = fs.readFileSync(path.resolve(root, "..", "server.py"), "utf8");
  assert.match(html, /id="refresh-metrics"/);
  assert.match(html, /id="metrics-latency"/);
  assert.match(html, /id="metrics-failures"/);
  assert.match(script, /async function refreshMetrics/);
  assert.match(script, /\/api\/local\/metrics/);
  assert.match(script, /storageSafety\?\.state === "critical"/);
  assert.match(script, /Penyimpanan menipis/);
  assert.match(server, /REQUEST_METRIC_SAMPLES[^\n]+maxlen=512/);
  assert.match(server, /if path == "\/api\/local\/metrics":\s+if not self\.require_local_token\(\)/);
  assert.match(server, /increment_operation_failure\("camera"\)/);
  assert.match(server, /increment_operation_failure\("capture"\)/);
  assert.match(server, /increment_operation_failure\("printer"\)/);
  assert.match(server, /increment_operation_failure\("render"\)/);
});

test("customer download uses persisted compositor and background GIF outputs", () => {
  const session = fs.readFileSync(path.join(root, "session.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "session.html"), "utf8");
  assert.match(session, /file\.kind === "composite"/);
  assert.match(session, /hasil-frame\.jpg/);
  assert.match(session, /file\.kind === "gif"/);
  assert.match(session, /async function refreshGifInBackground/);
  assert.match(session, /flipbook\.gif/);
  assert.match(html, /id="download-gif" disabled/);
  assert.doesNotMatch(session, /canvas\.toDataURL|createElement\("canvas"\)/);
});

test("superadmin feature flags are guarded, audited, and fully wired", () => {
  const platform = fs.readFileSync(path.join(root, "api/platform.mjs"), "utf8");
  const html = fs.readFileSync(path.join(root, "superadmin.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "superadmin.js"), "utf8");
  assert.match(platform, /hasPlatformPermission\(auth, permission\)/);
  assert.match(platform, /platform\.flags\.write/);
  assert.match(platform, /feature_flag\.updated/);
  assert.match(platform, /feature_flag\.deleted/);
  assert.match(platform, /featureFlagTargetExists/);
  assert.match(html, /id="feature-flag-form"/);
  assert.match(html, /id="flags-retry"/);
  assert.match(script, /method: "DELETE"/);
  assert.match(script, /state\.overrides/);
});

test("superadmin fleet health has persistent incident, acknowledgement, retry, and recovery wiring", () => {
  const html = fs.readFileSync(path.join(root, "superadmin.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "superadmin.js"), "utf8");
  const platform = fs.readFileSync(path.join(root, "api/platform.mjs"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "api/bridge.mjs"), "utf8");
  assert.match(html, /id="fleet-health-card"/);
  assert.match(html, /id="health-retry"/);
  assert.match(html, /id="incident-rows"/);
  assert.match(script, /api\("fleet_health"\)/);
  assert.match(script, /data-incident/);
  assert.match(platform, /fleet\.incident_acknowledged/);
  assert.match(platform, /platform\.fleet\.write/);
  assert.match(bridge, /resolveMachineIncident\(redis, machine, machine\.lastSeenAt\)/);
});

test("superadmin operational detail and global audit log are wired to cloud data", () => {
  const html = fs.readFileSync(path.join(root, "superadmin.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "superadmin.js"), "utf8");
  const platform = fs.readFileSync(path.join(root, "api/platform.mjs"), "utf8");
  assert.match(html, /<th>CONTROLLER<\/th>/);
  assert.match(html, /id="audit-card"/);
  assert.match(html, /id="audit-retry"/);
  assert.match(html, /id="audit-rows"/);
  assert.match(script, /machine\.location/);
  assert.match(script, /machine\.controllerState/);
  assert.match(script, /machine\.telemetry\?\.memory/);
  assert.match(script, /machine\.telemetry\?\.disk/);
  assert.match(script, /api\("audit"\)/);
  assert.match(script, /function renderAudit/);
  assert.match(platform, /"photoslive:audit:global"/);
  assert.match(platform, /auth\.role === "superadmin"/);
  assert.match(platform, /hostname: String\(telemetry\.hostname/);
  assert.match(platform, /availableBytes: Number\(telemetry\.memory\.availableBytes/);
});

test("superadmin backend health has an authenticated real probe and complete UI states", () => {
  const html = fs.readFileSync(path.join(root, "superadmin.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "superadmin.js"), "utf8");
  const platform = fs.readFileSync(path.join(root, "api/platform.mjs"), "utf8");
  const helper = fs.readFileSync(path.join(root, "api/_backend_health.mjs"), "utf8");
  assert.match(html, /id="backend-health-card"/);
  assert.match(html, /id="backend-health-retry"/);
  assert.match(html, /id="backend-cache-state"/);
  assert.match(html, /id="backend-database-state"/);
  assert.match(html, /id="backend-provider-list"/);
  assert.match(script, /api\("backend_health"\)/);
  assert.match(script, /function renderBackendHealth/);
  assert.match(script, /function renderBackendHealthError/);
  assert.match(platform, /platform\.backend\.read/);
  assert.match(platform, /backendHealth\(redis\)/);
  assert.match(helper, /Read\/write cache berhasil/);
  assert.match(helper, /migration_shadow_events\?select=id&limit=1/);
});

test("superadmin remote job queue has safe monitoring, retry, audit, and indexing wiring", () => {
  const html = fs.readFileSync(path.join(root, "superadmin.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "superadmin.js"), "utf8");
  const platform = fs.readFileSync(path.join(root, "api/platform.mjs"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "api/bridge.mjs"), "utf8");
  const helper = fs.readFileSync(path.join(root, "api/_remote_jobs.mjs"), "utf8");
  assert.match(html, /id="remote-jobs-card"/);
  assert.match(html, /id="remote-jobs-retry"/);
  assert.match(html, /id="remote-job-form"/);
  assert.match(html, /id="remote-job-machine"/);
  assert.match(html, /id="remote-job-type"/);
  assert.match(html, /id="remote-job-send"/);
  assert.match(html, /id="remote-job-rows"/);
  assert.match(script, /api\("remote_jobs"\)/);
  assert.match(script, /data-retry-job/);
  assert.match(script, /operation: "create"/);
  assert.match(script, /crypto\.randomUUID\(\)/);
  assert.match(script, /confirm\("Restart Controller/);
  assert.match(script, /method: "POST"/);
  assert.match(platform, /hardware_job\.retried/);
  assert.match(platform, /hardware_job\.created/);
  assert.match(platform, /SUPERADMIN_REMOTE_JOB_TYPES/);
  assert.match(platform, /platform\.remote_jobs\.write/);
  assert.match(bridge, /enqueueRemoteJob\(redis, machine/);
  assert.match(helper, /indexRemoteJob\(redis, id\)/);
  assert.match(helper, /SUPERADMIN_REMOTE_JOB_TYPES = new Set\(\[[^\]]*"devices\.refresh"[^\]]*"service\.restart"[^\]]*"agent\.update\.check"[^\]]*"agent\.update\.apply"[^\]]*"agent\.update\.rollback"[^\]]*\]\)/);
  assert.match(helper, /retryable: RETRYABLE\.has\(job\.status\)/);
  assert.doesNotMatch(helper, /signature: job\.signature/);
  assert.doesNotMatch(helper, /payload: job\.payload/);
});

test("superadmin owner and membership inventory is tenant-scoped and credential-safe", () => {
  const html = fs.readFileSync(path.join(root, "superadmin.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "superadmin.js"), "utf8");
  const platform = fs.readFileSync(path.join(root, "api/platform.mjs"), "utf8");
  assert.match(html, /id="membership-card"/);
  assert.match(html, /id="member-rows"/);
  assert.match(script, /machine\.members/);
  assert.match(script, /member\.role/);
  assert.match(platform, /platform\.overview\.read/);
  assert.match(platform, /photoslive:booth:\$\{normalizeCode\(boothCode\)\}:users/);
  assert.match(platform, /members: await safeBoothMembers/);
  assert.doesNotMatch(platform.match(/export async function safeBoothMembers[\s\S]*?\n}/)?.[0] || "", /passwordHash|pinHash/);
});
