import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { listTelemetryHistory, recordTelemetrySnapshot, TELEMETRY_HISTORY_LIMITS, telemetrySnapshot } from "../api/_telemetry_history.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
  pipeline() {
    const operations = [];
    const chain = {
      lpush: (key, value) => { operations.push(() => { const list = this.lists.get(key) || []; list.unshift(structuredClone(value)); this.lists.set(key, list); return list.length; }); return chain; },
      ltrim: (key, start, stop) => { operations.push(() => { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }); return chain; },
      expire: () => { operations.push(() => 1); return chain; },
      exec: async () => operations.map(operation => operation()),
    };
    return chain;
  }
}

const machine = {
  id: "machine-history", paired: true, agentState: "running", controllerState: "online",
  telemetry: { disk: { totalBytes: 1_000, freeBytes: 400 }, memory: { totalBytes: 800, availableBytes: 200 } },
  devices: [{ kind: "camera" }, { type: "printer" }],
};

test("telemetry snapshot keeps only bounded operational metrics", () => {
  const snapshot = telemetrySnapshot({ ...machine, telemetry: { ...machine.telemetry, agentToken: "must-not-leak", hostname: "private-host" } }, "2026-07-21T00:00:00.000Z");
  assert.deepEqual(snapshot.disk, { totalBytes: 1_000, freeBytes: 400, freePercent: 40 });
  assert.deepEqual(snapshot.memory, { totalBytes: 800, freeBytes: 200, freePercent: 25 });
  assert.equal(snapshot.cameraCount, 1);
  assert.equal(snapshot.printerCount, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /agentToken|must-not-leak|private-host/);
});

test("heartbeat history records at most one sample per five-minute bucket", async () => {
  const redis = new MemoryRedis();
  const heartbeatMachine = structuredClone(machine);
  const start = Date.parse("2026-07-21T00:00:00.000Z");
  assert.equal((await recordTelemetrySnapshot(redis, heartbeatMachine, start)).recorded, true);
  const redisKeyCount = redis.values.size;
  assert.equal((await recordTelemetrySnapshot(redis, heartbeatMachine, start + 60_000)).reason, "bucket-exists");
  assert.equal(redis.values.size, redisKeyCount, "heartbeat dalam bucket sama tidak menulis Redis lagi");
  assert.equal((await recordTelemetrySnapshot(redis, { ...machine, telemetry: { ...machine.telemetry, disk: { totalBytes: 1_000, freeBytes: 300 } } }, start + 5 * 60_000)).recorded, true);
  const history = await listTelemetryHistory(redis, machine.id, { hours: 1, atMs: start + 6 * 60_000 });
  assert.equal(history.records.length, 2);
  assert.equal(history.records[0].disk.freePercent, 40);
  assert.equal(history.records[1].disk.freePercent, 30);
  assert.equal(history.summary.averageDiskFreePercent, 35);
  assert.deepEqual(TELEMETRY_HISTORY_LIMITS, { bucketMinutes: 5, retentionHours: 168, maxSnapshots: 2016 });
});

test("telemetry history control rejects unauthenticated access", async () => {
  const { telemetryHistoryControl } = await import("../api/platform.mjs");
  const response = await telemetryHistoryControl(new MemoryRedis(), new Request("https://photoslive.test/api/platform?action=telemetry_history"), { machineId: machine.id });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /histori telemetry/i);
});

test("superadmin telemetry history has real loading, empty, error, range, and retry wiring", () => {
  const html = fs.readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  const bridge = fs.readFileSync(new URL("../api/bridge.mjs", import.meta.url), "utf8");
  assert.match(html, /id="telemetry-machine"/);
  assert.match(html, /id="telemetry-range"/);
  assert.match(html, /id="telemetry-history-retry"/);
  assert.match(script, /function renderTelemetryHistoryError/);
  assert.match(script, /Belum ada snapshot/);
  assert.match(script, /telemetry_history&machineId=/);
  assert.match(script, /telemetry-history-retry"\)\.addEventListener/);
  assert.match(bridge, /recordTelemetrySnapshot\(redis, machine\)\.catch/);
});
