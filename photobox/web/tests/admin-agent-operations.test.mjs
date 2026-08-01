import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [html, app, styles, agent, bridge, platform] = await Promise.all([
  read("../admin.html"),
  read("../app.js"),
  read("../styles.css"),
  read("../../agent.py"),
  read("../api/bridge.mjs"),
  read("../api/platform.mjs"),
]);

test("admin machine controls expose real status and lifecycle operations", () => {
  for (const id of [
    "agent-connection-control", "agent-sync-value", "agent-print-queue-value",
    "agent-update-value", "agent-install-update", "agent-rollback-update", "agent-operation-status",
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(app, /async function setAgentConnection\(\)/);
  assert.match(app, /platformApi\("agent_connection"/);
  assert.match(app, /directBridge\("job_status"/);
  assert.match(app, /result\.job\.status === "completed"/);
  assert.match(app, /\["failed", "expired"\]\.includes/);
});

test("connection desired state travels through audited cloud state and heartbeat", () => {
  assert.match(platform, /export async function agentConnectionControl/);
  assert.match(platform, /agent\.connection_\$\{desiredState\}/);
  assert.match(platform, /machine\.desiredState = desiredState/);
  assert.match(bridge, /desiredState: machine\.desiredState/);
  assert.match(agent, /heartbeat\.get\("desiredState"\)/);
  assert.match(agent, /CONTROL_PATH\.write_text/);
});

test("heartbeat is throttled and Redis quota exhaustion is surfaced as actionable cloud state", () => {
  assert.match(bridge, /HEARTBEAT_MIN_INTERVAL_MS/);
  assert.match(bridge, /cachedHeartbeatResponse/);
  assert.match(bridge, /storeHeartbeatResponse/);
  assert.match(bridge, /minimumHeartbeatSeconds/);
  assert.match(bridge, /UPSTASH_MAX_REQUESTS_EXCEEDED/);
  assert.match(bridge, /REDIS_QUOTA_RETRY_AFTER_SECONDS/);
  assert.match(bridge, /retry-after/);
  assert.match(bridge, /http\.error\.log_failed/);
  assert.match(agent, /HEARTBEAT_SECONDS = max\(60, int\(os\.environ\.get\("PHOTOSLIVE_HEARTBEAT_SECONDS", "300"\)\)\)/);
  assert.match(agent, /JOB_POLL_SECONDS = max\(300, int\(os\.environ\.get\("PHOTOSLIVE_JOB_POLL_SECONDS", "900"\)\)\)/);
  assert.match(agent, /OUTBOX_CHECK_SECONDS = max\(2, int\(os\.environ\.get\("PHOTOSLIVE_OUTBOX_CHECK_SECONDS", "5"\)\)\)/);
  assert.match(agent, /class CloudRequestError/);
  assert.match(agent, /retry_after/);
  assert.match(platform, /isUpstashMaxRequestsError/);
  assert.match(platform, /UPSTASH_MAX_REQUESTS_EXCEEDED/);
  assert.match(platform, /http\.error\.log_failed/);
});

test("Agent bridge keeps primary cloud data out of Redis hot paths and backs off idle polling", () => {
  assert.match(bridge, /readPostgresSettings/);
  assert.match(bridge, /readPostgresVoucherSnapshot/);
  assert.match(bridge, /redeemPostgresVoucher/);
  assert.match(bridge, /source: "postgres"/);
  assert.match(bridge, /source: "redis"/);
  assert.match(bridge, /IDLE_JOB_POLL_SECONDS/);
  assert.match(bridge, /nextPollSeconds: IDLE_JOB_POLL_SECONDS/);
  assert.match(agent, /response\.get\("nextPollSeconds"\)/);
  assert.match(agent, /config\["jobPollSeconds"\]/);
  assert.match(agent, /max\(JOB_POLL_SECONDS, min\(3600, int\(next_poll_seconds\)\)\)/);
  assert.match(platform, /readPostgresSettings\(booth\.boothCode\)/);
  assert.match(platform, /if \(!postgresStatus\.primary\) transaction\.set\(cloudSettingsKey\(boothCode\), settings\)/);
  assert.match(platform, /if \(postgresVoucherStatus\(\)\.primary\) return/);
  assert.match(platform, /Compatibility cache only\. PostgreSQL remains authoritative/);
  assert.match(platform, /Redis cache only\. PostgreSQL already completed the redemption/);
  assert.match(platform, /Redis is the short ring-buffer for browsing audit logs/);
});

test("Admin Helper status reads PostgreSQL before the optional Redis cache", () => {
  assert.match(bridge, /readPostgresMachineStatus/);
  assert.match(bridge, /action === "machine_status"[\s\S]{0,900}postgresStatus\.primary/);
  assert.match(bridge, /source: "postgres"/);
  assert.match(bridge, /bestEffortRedis\(\(\) => redis\.get\(machineKey\(machineId\)\), null\)/);
  const statusBranch = bridge.slice(bridge.indexOf('if (action === "machine_status"'), bridge.indexOf("const redis = getRedis();", bridge.indexOf('if (action === "machine_status"')));
  assert.doesNotMatch(statusBranch, /await redis\.get/);
});

test("heartbeat carries bounded operational summaries instead of remote file payloads", () => {
  assert.match(agent, /"sync": local_status\.get\("sync"\)/);
  assert.match(agent, /"queue": local_status\.get\("queue"\)/);
  assert.match(bridge, /machine\.sync = payload\.sync/);
  assert.match(bridge, /machine\.queue = payload\.queue/);
  assert.doesNotMatch(agent, /"photoBytes"/);
});

test("admin exposes bounded upload and print queues with real per-job retries", () => {
  for (const id of ["refresh-agent-queues", "admin-sync-job-list", "admin-print-job-list"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(agent, /"syncJobs": sync_jobs\[:10\]/);
  assert.match(agent, /"printJobs": print_jobs\[:10\]/);
  assert.match(bridge, /payload\.syncJobs\.slice\(0, 10\)/);
  assert.match(bridge, /payload\.printJobs\.slice\(0, 10\)/);
  assert.match(app, /function renderAdminAgentQueues/);
  assert.match(app, /queueAgentJob\("sync\.retry_job", \{ jobId:/);
  assert.match(app, /queueAgentJob\("print\.retry_job", \{ jobId:/);
  assert.match(agent, /"sync\.retry_job": \("\/api\/local\/sync\/retry-job", "POST", True\)/);
  assert.match(agent, /"print\.retry_job": \("\/api\/local\/print\/retry-job", "POST", True\)/);
});

test("admin session recovery uses a bounded secret-free heartbeat projection and signed local job", () => {
  for (const id of ["refresh-session-recovery", "admin-session-recovery-list"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(agent, /"sessionRecovery": \{"sessions": list\(recovery\.get\("sessions"\) or \[\]\)\[:10\]/);
  assert.match(agent, /"session\.recover": \("\/api\/local\/session-recovery\/recover", "POST", True\)/);
  assert.match(bridge, /machine\.sessionRecovery = payload\.sessionRecovery/);
  assert.match(bridge, /payload\.sessionRecovery\.sessions\.slice\(0, 10\)/);
  assert.doesNotMatch(bridge, /sessionRecovery[\s\S]{0,600}shareToken/);
  assert.match(app, /function renderSessionRecovery\(machine\)/);
  assert.match(app, /queueAgentJob\("session\.recover", \{ sessionId:/);
});

test("hardware actions stay actionable and enter the durable queue while the machine is offline", () => {
  assert.match(app, /\[data-agent-job\]:not\(#agent-connection-control\)/);
  assert.doesNotMatch(app, /button\.disabled = !online/);
  assert.match(app, /button\.dataset\.availability = online \? "ready" : "queued"/);
  assert.match(app, /Perintah sudah masuk antrean\. Photoslive Helper akan menjalankannya saat mesin tersambung/);
  assert.match(app, /button\.dataset\.jobState = "pending"/);
  assert.match(app, /button\.dataset\.jobState = String\(result\.job\.status/);
  assert.match(app, /Mesin offline\. Pengaturan cloud tetap dapat disimpan/);
});

test("admin presents browser-first operation while preserving optional Helper controls", () => {
  assert.match(html, /data-view="agent"[\s\S]{0,160}Photoslive Helper/);
  assert.match(html, /id="helper-enabled-toggle"/);
  assert.match(html, /data-helper-installer="windows"/);
  assert.match(html, /class="agent-technician-command"/);
  assert.match(html, />Pasang lewat Terminal</);
  for (const os of ["windows", "macos", "linux"]) {
    assert.match(html, new RegExp(`data-helper-terminal="${os}"`));
  }
  assert.match(html, /id="copy-helper-terminal"[^>]*disabled/);
  assert.match(html, />Sinkronkan sekarang</);
  assert.match(html, /Kondisi mesin diperiksa otomatis setiap 60 detik/);
  assert.doesNotMatch(html, /Kondisi mesin diperiksa otomatis setiap 30 detik/);
  assert.doesNotMatch(html, />Photoslive Agent</);
  assert.match(app, /create_helper_bootstrap/);
  assert.match(app, /function helperTerminalCommandSource/);
  assert.match(app, /PHOTOSLIVE_HELPER_BOOTSTRAP/);
  assert.match(app, /navigator\.clipboard\?\.writeText/);
  assert.match(app, /setTimeout\(loadAgentStatus, 60000\)/);
});

test("Helper page keeps heading actions separated and Terminal controls responsive", () => {
  assert.match(styles, /\.page-heading \{[^}]*margin-bottom: var\(--space-5\)/);
  assert.match(styles, /#agent-view > \.panel \+ \.panel \{[^}]*margin-top: var\(--space-5\)/);
  assert.match(styles, /\.agent-technician-command > summary \{[^}]*min-height: 48px/);
  assert.match(styles, /\.helper-terminal-os \{[^}]*grid-template-columns: repeat\(3/);
  assert.match(styles, /@media \(max-width: 800px\)[\s\S]*\.helper-terminal-os \{ grid-template-columns: 1fr; \}/);
  assert.match(styles, /\.page-heading \.top-actions \{ width: min\(100%, 220px\); \}/);
  assert.match(styles, /\.page-heading \.top-actions \.button \{ width: 100%; \}/);
  assert.match(styles, /\.agent-command code \{[^}]*overflow-wrap: anywhere/);
});

test("web-only photobox avoids automatic Helper polling while keeping browser and queued actions available", () => {
  assert.match(app, /state\.runtimeMode = "browser"/);
  assert.match(app, /const isHelperActive = \(\) => state\.runtime\?\.capabilities\?\.helper\?\.active === true/);
  assert.match(app, /if \(!isHelperActive\(\)\) \{[\s\S]{0,180}Photoslive Helper aktif/);
  assert.match(app, /if \(!isWebRuntime\(\)\) setInterval\(\(\) => refreshStatus/);
  assert.match(app, /if \(name === "agent"\) loadAgentStatus\(\)/);
  assert.doesNotMatch(app, /if \(name === "agent"\) \{\s*if \(isWebRuntime\(\)\) renderWebRuntimeStatus\(\)/);
  assert.match(app, /Web\/PWA aktif\. Tidak ada polling perangkat sampai Photoslive Helper diaktifkan\./);
  assert.match(app, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(app, /navigator\.mediaDevices\.enumerateDevices/);
  assert.match(app, /function printBrowserTest\(\)/);
  assert.match(app, /button\.dataset\.availability = "browser-or-queued"/);
  assert.doesNotMatch(app, /\$\$\('\[data-agent-job\]'\)\.forEach\(button => \{ button\.disabled = true; \}\)/);
});
