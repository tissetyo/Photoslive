import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [html, app, agent, bridge, platform] = await Promise.all([
  read("../admin.html"),
  read("../app.js"),
  read("../../agent.py"),
  read("../api/bridge.mjs"),
  read("../api/platform.mjs"),
]);

test("admin Agent operations expose real status and lifecycle controls", () => {
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
  assert.match(agent, /JOB_POLL_SECONDS = max\(10, int\(os\.environ\.get\("PHOTOSLIVE_JOB_POLL_SECONDS", "60"\)\)\)/);
  assert.match(agent, /class CloudRequestError/);
  assert.match(agent, /retry_after/);
  assert.match(platform, /isUpstashMaxRequestsError/);
  assert.match(platform, /UPSTASH_MAX_REQUESTS_EXCEEDED/);
  assert.match(platform, /http\.error\.log_failed/);
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

test("hardware actions expose pending state and become unavailable while Agent is offline", () => {
  assert.match(app, /\[data-agent-job\]:not\(#agent-connection-control\)/);
  assert.match(app, /button\.disabled = !online/);
  assert.match(app, /button\.dataset\.availability = online \? "ready" : "unavailable"/);
  assert.match(app, /button\.dataset\.jobState = "pending"/);
  assert.match(app, /button\.dataset\.jobState = String\(result\.job\.status/);
  assert.match(app, /Agent offline\. Simpan pengaturan cloud tetap tersedia/);
});
