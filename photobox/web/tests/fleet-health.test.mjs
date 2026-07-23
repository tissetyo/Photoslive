import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeFleetIncident,
  evaluateFleetHealth,
  evaluateMachineHealth,
  listFleetIncidents,
  machineHealth,
  resolveMachineIncident,
} from "../api/_fleet_health.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, end) { const list = this.lists.get(key) || []; this.lists.set(key, list.slice(start, end + 1)); return "OK"; }
  async lrange(key, start, end) { return (this.lists.get(key) || []).slice(start, end + 1); }
}

const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
const machine = (lastSeenAt, id = "machine_a") => ({ id, boothCode: "booth-a", name: "Booth A", lastSeenAt, accessEnabled: true });

test("machine health distinguishes ready, delayed, and offline heartbeat windows", () => {
  assert.equal(machineHealth(machine("2026-07-21T11:59:30.000Z"), nowMs).state, "ready");
  assert.equal(machineHealth(machine("2026-07-21T11:58:00.000Z"), nowMs).state, "delayed");
  assert.equal(machineHealth(machine("2026-07-21T11:56:00.000Z"), nowMs).state, "offline");
  assert.equal(machineHealth(machine(null), nowMs).state, "offline");
});

test("repeated offline evaluation creates one persistent incident", async () => {
  const redis = new MemoryRedis();
  const target = machine("2026-07-21T11:56:00.000Z");
  await evaluateMachineHealth(redis, target, nowMs);
  await evaluateMachineHealth(redis, target, nowMs + 60_000);
  const incidents = await listFleetIncidents(redis);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].status, "open");
  assert.equal(incidents[0].machineId, target.id);
});

test("incident acknowledgement persists and recovery resolves the same incident", async () => {
  const redis = new MemoryRedis();
  const target = machine("2026-07-21T11:56:00.000Z");
  await evaluateMachineHealth(redis, target, nowMs);
  const [opened] = await listFleetIncidents(redis);
  const { incident: acknowledged, changed } = await acknowledgeFleetIncident(redis, opened.id, "superadmin_1", "2026-07-21T12:01:00.000Z");
  assert.equal(changed, true);
  assert.equal(acknowledged.status, "acknowledged");
  assert.equal(acknowledged.acknowledgedBy, "superadmin_1");
  const repeated = await acknowledgeFleetIncident(redis, opened.id, "superadmin_2", "2026-07-21T12:01:30.000Z");
  assert.equal(repeated.changed, false);
  assert.equal(repeated.incident.acknowledgedBy, "superadmin_1");
  const resolved = await resolveMachineIncident(redis, { ...target, lastSeenAt: "2026-07-21T12:02:00.000Z" }, "2026-07-21T12:02:00.000Z");
  assert.equal(resolved.id, opened.id);
  assert.equal(resolved.status, "resolved");
  assert.equal((await listFleetIncidents(redis))[0].resolvedAt, "2026-07-21T12:02:00.000Z");
});

test("fleet health control rejects requests without a superadmin session", async () => {
  process.env.SESSION_SECRET = "photoslive-test-secret-that-is-long-enough-2026";
  const { fleetHealthControl } = await import("../api/platform.mjs");
  const response = await fleetHealthControl(new MemoryRedis(), new Request("https://photoslive.test/api/platform?action=fleet_health"), {});
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /superadmin/);
});

test("fleet summary reports states, disabled access, and active incidents", async () => {
  const redis = new MemoryRedis();
  const result = await evaluateFleetHealth(redis, [
    machine("2026-07-21T11:59:30.000Z", "machine_ready"),
    machine("2026-07-21T11:58:00.000Z", "machine_delayed"),
    { ...machine("2026-07-21T11:56:00.000Z", "machine_offline"), accessEnabled: false },
  ], nowMs);
  assert.deepEqual(result.summary, { total: 3, ready: 1, delayed: 1, offline: 1, disabled: 1, activeIncidents: 1 });
  assert.equal(result.incidents.length, 1);
});
