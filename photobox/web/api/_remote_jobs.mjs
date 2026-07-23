import { jobKey, now, queueKey, randomId, signHardwareJob } from "./_store.mjs";

const JOB_INDEX_KEY = "photoslive:jobs";
const RETRYABLE = new Set(["failed", "expired"]);
export const HARDWARE_JOB_TYPES = new Set(["devices.refresh", "camera.test", "camera.capture", "printer.test", "printer.print", "storage.cleanup", "service.restart", "controller.request", "privacy.delete_session", "agent.update.check", "agent.update.apply", "agent.update.rollback", "sync.retry", "sync.retry_job", "print.retry_job", "session.recover"]);
export const SUPERADMIN_REMOTE_JOB_TYPES = new Set(["devices.refresh", "service.restart", "agent.update.check", "agent.update.apply", "agent.update.rollback"]);

function cleanIdempotencyKey(value = "") {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120);
}

function safePayload(value) {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
  if (JSON.stringify(payload).length > 16_384) throw new Error("Payload job terlalu besar");
  return payload;
}

export async function indexRemoteJob(redis, jobId) {
  await redis.lpush(JOB_INDEX_KEY, jobId);
  await redis.ltrim(JOB_INDEX_KEY, 0, 499);
}

export async function enqueueRemoteJob(redis, machine, command = {}, allowedTypes = HARDWARE_JOB_TYPES, options = {}) {
  if (!machine?.paired) throw new Error("Mesin belum dipasangkan");
  if (machine.accessEnabled === false && !options.allowDisabled) throw new Error("Akses photobox sedang dinonaktifkan");
  const type = String(command.type || "");
  if (!allowedTypes.has(type)) throw new Error("Jenis job tidak didukung");
  const maxTtlSeconds = Math.max(900, Math.min(7 * 86_400, Number(options.maxTtlSeconds || 900)));
  const ttlSeconds = Math.max(30, Math.min(maxTtlSeconds, Number(command.ttlSeconds || 120)));
  const recordTtlSeconds = Math.max(86_400, ttlSeconds + 3_600);
  const idempotencyKey = cleanIdempotencyKey(command.idempotencyKey);
  const pointerKey = idempotencyKey ? `photoslive:machine:${machine.id}:job-idempotency:${idempotencyKey}` : "";
  if (pointerKey) {
    const existingId = await redis.get(pointerKey);
    const existing = existingId ? await redis.get(jobKey(existingId)) : null;
    if (existing) return { job: existing, reused: true };
  }
  const id = randomId("job");
  if (pointerKey) {
    const acquired = await redis.set(pointerKey, id, { ex: ttlSeconds, nx: true });
    if (!acquired) {
      const winnerId = await redis.get(pointerKey);
      const winner = winnerId ? await redis.get(jobKey(winnerId)) : null;
      if (winner) return { job: winner, reused: true };
      throw new Error("Perintah yang sama sedang diproses");
    }
  }
  try {
    const createdAt = now();
    const job = {
      id, machineId: machine.id, type, payload: safePayload(command.payload), status: "queued",
      createdAt, updatedAt: createdAt, attempts: 0, idempotencyKey: idempotencyKey || null,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
    job.signature = await signHardwareJob(machine.commandKey || "", job);
    await redis.set(jobKey(id), job, { ex: recordTtlSeconds });
    await redis.rpush(queueKey(machine.id), id);
    await indexRemoteJob(redis, id);
    return { job, reused: false };
  } catch (error) {
    if (pointerKey && await redis.get(pointerKey) === id) await redis.del(pointerKey).catch(() => {});
    throw error;
  }
}

export async function listRemoteJobs(redis, machines = [], limit = 100) {
  const ids = new Set(await redis.lrange(JOB_INDEX_KEY, 0, Math.max(0, Math.min(199, limit - 1))));
  for (const machine of machines) {
    const queued = await redis.lrange(queueKey(machine.id), 0, 99);
    for (const id of queued) ids.add(id);
  }
  const records = (await Promise.all([...ids].slice(0, 200).map(id => redis.get(jobKey(id))))).filter(Boolean);
  const machineMap = new Map(machines.map(machine => [machine.id, machine]));
  return records.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, limit).map(job => {
    const machine = machineMap.get(job.machineId) || {};
    return {
      id: job.id, machineId: job.machineId, machineName: machine.name || job.machineId,
      boothCode: machine.boothCode || "", type: job.type, status: job.status,
      attempts: Number(job.attempts || 0), createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null, expiresAt: job.expiresAt || null,
      retryOf: job.retryOf || null, error: job.error ? String(job.error).slice(0, 240) : null,
      retryable: RETRYABLE.has(job.status),
    };
  });
}

export async function retryRemoteJob(redis, source, machine) {
  if (!source || !RETRYABLE.has(source.status)) throw new Error("Hanya job gagal atau kedaluwarsa yang dapat dicoba ulang");
  if (!machine?.paired) throw new Error("Mesin belum dipasangkan");
  if (machine.accessEnabled === false) throw new Error("Akses photobox sedang dinonaktifkan");
  const pointerKey = `photoslive:job:${source.id}:retry`;
  const existingId = await redis.get(pointerKey);
  const existing = existingId ? await redis.get(jobKey(existingId)) : null;
  if (existing) return { job: existing, reused: true };
  const id = randomId("job");
  const acquired = await redis.set(pointerKey, id, { ex: 600, nx: true });
  if (!acquired) {
    const winnerId = await redis.get(pointerKey);
    const winner = winnerId ? await redis.get(jobKey(winnerId)) : null;
    if (winner) return { job: winner, reused: true };
    throw new Error("Retry job sedang diproses");
  }
  try {
    const job = {
      id, machineId: source.machineId, type: source.type,
      payload: source.payload && typeof source.payload === "object" ? structuredClone(source.payload) : {},
      status: "queued", createdAt: now(), updatedAt: now(), attempts: 0,
      retryOf: source.id, idempotencyKey: null,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    job.signature = await signHardwareJob(machine.commandKey || "", job);
    await redis.set(jobKey(id), job, { ex: 86_400 });
    await redis.rpush(queueKey(machine.id), id);
    await indexRemoteJob(redis, id);
    return { job, reused: false };
  } catch (error) {
    await redis.del(pointerKey).catch(() => {});
    throw error;
  }
}
