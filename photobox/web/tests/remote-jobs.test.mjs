import assert from "node:assert/strict";
import test from "node:test";
import { enqueueRemoteJob, HARDWARE_JOB_TYPES, indexRemoteJob, listRemoteJobs, retryRemoteJob, SUPERADMIN_REMOTE_JOB_TYPES } from "../api/_remote_jobs.mjs";
import { jobKey, queueKey, signHardwareJob } from "../api/_store.mjs";

class MemoryRedis {
  constructor() {
    this.values = new Map();
    this.lists = new Map();
  }

  async get(key) { return structuredClone(this.values.get(key) ?? null); }

  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }

  async del(key) { return this.values.delete(key) ? 1 : 0; }

  async lpush(key, value) {
    const list = this.lists.get(key) || [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  async rpush(key, value) {
    const list = this.lists.get(key) || [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key, start, stop) {
    const list = this.lists.get(key) || [];
    this.lists.set(key, list.slice(start, stop + 1));
    return "OK";
  }

  async lrange(key, start, stop) {
    return structuredClone((this.lists.get(key) || []).slice(start, stop + 1));
  }
}

const machine = {
  id: "machine_1",
  name: "Booth Lobby",
  boothCode: "LOBBY-01",
  paired: true,
  accessEnabled: true,
  commandKey: "command-secret",
};

function sourceJob(overrides = {}) {
  return {
    id: "job_source",
    machineId: machine.id,
    type: "printer.test",
    payload: { copies: 1, sensitivePath: "/private/photos" },
    signature: "must-never-leak",
    status: "failed",
    attempts: 2,
    error: "printer offline",
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:01:00.000Z",
    expiresAt: "2026-07-20T00:10:00.000Z",
    ...overrides,
  };
}

test("remote job listing is bounded, labelled, and never exposes payload or signature", async () => {
  const redis = new MemoryRedis();
  const source = sourceJob({ error: "x".repeat(400) });
  await redis.set(jobKey(source.id), source);
  await indexRemoteJob(redis, source.id);

  const jobs = await listRemoteJobs(redis, [machine], 10);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].machineName, machine.name);
  assert.equal(jobs[0].boothCode, machine.boothCode);
  assert.equal(jobs[0].retryable, true);
  assert.equal(jobs[0].error.length, 240);
  assert.equal(Object.hasOwn(jobs[0], "payload"), false);
  assert.equal(Object.hasOwn(jobs[0], "signature"), false);
});

test("safe superadmin enqueue creates a signed, expiring, indexed command", async () => {
  const redis = new MemoryRedis();
  const result = await enqueueRemoteJob(redis, machine, {
    type: "devices.refresh",
    payload: {},
    ttlSeconds: 600,
    idempotencyKey: "superadmin.machine_1.refresh.request_1",
  }, SUPERADMIN_REMOTE_JOB_TYPES);

  assert.equal(result.reused, false);
  assert.equal(result.job.status, "queued");
  assert.equal(result.job.type, "devices.refresh");
  assert.equal(result.job.machineId, machine.id);
  assert.equal(result.job.signature, await signHardwareJob(machine.commandKey, result.job));
  assert.ok(Date.parse(result.job.expiresAt) > Date.now());
  assert.deepEqual(await redis.lrange(queueKey(machine.id), 0, 9), [result.job.id]);
  assert.deepEqual(await redis.lrange("photoslive:jobs", 0, 9), [result.job.id]);
});

test("superadmin update lifecycle commands are signed, expiring, and allowlisted", async () => {
  const redis = new MemoryRedis();
  for (const type of ["agent.update.check", "agent.update.apply", "agent.update.rollback"]) {
    const result = await enqueueRemoteJob(redis, machine, { type, payload: {}, idempotencyKey: `update-${type}` }, SUPERADMIN_REMOTE_JOB_TYPES);
    assert.equal(result.job.type, type);
    assert.equal(result.job.signature, await signHardwareJob(machine.commandKey, result.job));
    assert.ok(Date.parse(result.job.expiresAt) > Date.now());
  }
});

test("booth admin can queue a signed sync retry but connection state is not a one-way remote job", async () => {
  const redis = new MemoryRedis();
  const result = await enqueueRemoteJob(redis, machine, { type: "sync.retry", payload: {} }, HARDWARE_JOB_TYPES);
  assert.equal(result.job.type, "sync.retry");
  assert.equal(result.job.signature, await signHardwareJob(machine.commandKey, result.job));
  await assert.rejects(() => enqueueRemoteJob(redis, machine, { type: "agent.pause", payload: {} }, HARDWARE_JOB_TYPES), /tidak didukung/);
});

test("booth admin per-job retries are signed and preserve only the selected local job id", async () => {
  const redis = new MemoryRedis();
  for (const [index, type] of ["sync.retry_job", "print.retry_job"].entries()) {
    const payload = { jobId: `local_${index}` };
    const result = await enqueueRemoteJob(redis, machine, { type, payload }, HARDWARE_JOB_TYPES);
    assert.equal(result.job.type, type);
    assert.deepEqual(result.job.payload, payload);
    assert.equal(result.job.signature, await signHardwareJob(machine.commandKey, result.job));
  }
});

test("safe enqueue is idempotent and rejects arbitrary or disabled commands", async () => {
  const redis = new MemoryRedis();
  const command = { type: "service.restart", idempotencyKey: "restart-request-1" };
  const first = await enqueueRemoteJob(redis, machine, command, SUPERADMIN_REMOTE_JOB_TYPES);
  const second = await enqueueRemoteJob(redis, machine, command, SUPERADMIN_REMOTE_JOB_TYPES);
  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal((await redis.lrange(queueKey(machine.id), 0, 9)).length, 1);
  await assert.rejects(() => enqueueRemoteJob(redis, machine, { type: "printer.print" }, SUPERADMIN_REMOTE_JOB_TYPES), /tidak didukung/);
  await assert.rejects(() => enqueueRemoteJob(redis, { ...machine, accessEnabled: false }, { type: "devices.refresh" }, SUPERADMIN_REMOTE_JOB_TYPES), /dinonaktifkan/);
});

test("privacy deletion remains queued for seven days while an Agent is offline", async () => {
  const redis = new MemoryRedis();
  const result = await enqueueRemoteJob(redis, { ...machine, accessEnabled: false }, {
    type: "privacy.delete_session",
    payload: { shareCode: "a".repeat(32) },
    ttlSeconds: 7 * 86_400,
    idempotencyKey: "privacy-delete-session-1",
  }, new Set(["privacy.delete_session"]), { allowDisabled: true, maxTtlSeconds: 7 * 86_400 });

  assert.equal(result.job.type, "privacy.delete_session");
  assert.ok(Date.parse(result.job.expiresAt) - Date.now() > 6 * 86_400_000);
  assert.deepEqual(await redis.lrange(queueKey(machine.id), 0, 9), [result.job.id]);
});

test("retry creates a fresh signed queued job in machine and global indexes", async () => {
  const redis = new MemoryRedis();
  const source = sourceJob();
  const result = await retryRemoteJob(redis, source, machine);

  assert.equal(result.reused, false);
  assert.equal(result.job.status, "queued");
  assert.equal(result.job.retryOf, source.id);
  assert.deepEqual(result.job.payload, source.payload);
  assert.notEqual(result.job.payload, source.payload);
  assert.equal(result.job.signature, await signHardwareJob(machine.commandKey, result.job));
  assert.deepEqual(await redis.lrange(queueKey(machine.id), 0, 9), [result.job.id]);
  assert.deepEqual(await redis.lrange("photoslive:jobs", 0, 9), [result.job.id]);
  assert.deepEqual(await redis.get(jobKey(result.job.id)), result.job);
});

test("retry is idempotent for the same failed job", async () => {
  const redis = new MemoryRedis();
  const source = sourceJob();
  const first = await retryRemoteJob(redis, source, machine);
  const second = await retryRemoteJob(redis, source, machine);

  assert.equal(second.reused, true);
  assert.equal(second.job.id, first.job.id);
  assert.equal((await redis.lrange(queueKey(machine.id), 0, 9)).length, 1);
  assert.equal((await redis.lrange("photoslive:jobs", 0, 9)).length, 1);
});

test("retry rejects active jobs and machines that cannot accept work", async () => {
  const redis = new MemoryRedis();
  await assert.rejects(() => retryRemoteJob(redis, sourceJob({ status: "running" }), machine), /Hanya job gagal/);
  await assert.rejects(() => retryRemoteJob(redis, sourceJob(), { ...machine, paired: false }), /belum dipasangkan/);
  await assert.rejects(() => retryRemoteJob(redis, sourceJob(), { ...machine, accessEnabled: false }), /dinonaktifkan/);
});
