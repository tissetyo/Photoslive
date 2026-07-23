const BUCKET_MS = 5 * 60 * 1_000;
const RETENTION_SECONDS = 8 * 24 * 60 * 60;
const MAX_SNAPSHOTS = 7 * 24 * 12;

const historyKey = machineId => `photoslive:machine:${machineId}:telemetry-history`;
const bucketKey = (machineId, bucket) => `photoslive:machine:${machineId}:telemetry-bucket:${bucket}`;

function boundedNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.min(maximum, number)) : 0;
}

function safeMetric(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const totalBytes = boundedNumber(value.totalBytes);
  const freeBytes = boundedNumber(value.freeBytes ?? value.availableBytes, totalBytes || Number.MAX_SAFE_INTEGER);
  return totalBytes ? { totalBytes, freeBytes, freePercent: Number(((freeBytes / totalBytes) * 100).toFixed(1)) } : null;
}

export function telemetrySnapshot(machine, recordedAt = new Date().toISOString()) {
  const telemetry = machine?.telemetry && typeof machine.telemetry === "object" ? machine.telemetry : {};
  return {
    recordedAt,
    disk: safeMetric(telemetry.disk),
    memory: safeMetric(telemetry.memory),
    agentState: ["running", "paused", "starting"].includes(machine?.agentState) ? machine.agentState : "unknown",
    controllerState: machine?.controllerState === "online" ? "online" : "offline",
    cameraCount: Math.min(24, Array.isArray(machine?.devices) ? machine.devices.filter(device => device?.kind === "camera" || device?.type === "camera").length : 0),
    printerCount: Math.min(24, Array.isArray(machine?.devices) ? machine.devices.filter(device => device?.kind === "printer" || device?.type === "printer").length : 0),
  };
}

export async function recordTelemetrySnapshot(redis, machine, atMs = Date.now()) {
  if (!machine?.id || !machine?.paired) return { recorded: false, reason: "not-paired" };
  const bucket = Math.floor(atMs / BUCKET_MS);
  // Heartbeat berjalan setiap 60 detik, tetapi histori hanya membutuhkan satu
  // titik per lima menit. Cache bucket terakhir pada record mesin agar empat
  // heartbeat berikutnya tidak menambah operasi Redis. SET NX tetap menjadi
  // pagar konkurensi ketika dua heartbeat masuk bersamaan.
  if (Number(machine.telemetryHistoryBucket) === bucket) return { recorded: false, reason: "bucket-exists" };
  const acquired = await redis.set(bucketKey(machine.id, bucket), "1", { nx: true, ex: RETENTION_SECONDS });
  machine.telemetryHistoryBucket = bucket;
  if (!acquired) return { recorded: false, reason: "bucket-exists" };
  const snapshot = telemetrySnapshot(machine, new Date(atMs).toISOString());
  const pipeline = redis.pipeline();
  pipeline.lpush(historyKey(machine.id), snapshot);
  pipeline.ltrim(historyKey(machine.id), 0, MAX_SNAPSHOTS - 1);
  pipeline.expire(historyKey(machine.id), RETENTION_SECONDS);
  await pipeline.exec();
  return { recorded: true, snapshot };
}

function average(records, metric) {
  const values = records.map(item => item[metric]?.freePercent).filter(Number.isFinite);
  return values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1)) : null;
}

export async function listTelemetryHistory(redis, machineId, { hours = 24, limit = 288, atMs = Date.now() } = {}) {
  const safeHours = Math.max(1, Math.min(168, Number(hours || 24)));
  const safeLimit = Math.max(1, Math.min(MAX_SNAPSHOTS, Number(limit || 288)));
  const cutoff = atMs - safeHours * 60 * 60 * 1_000;
  const raw = await redis.lrange(historyKey(String(machineId || "")), 0, MAX_SNAPSHOTS - 1);
  const records = raw.filter(item => item?.recordedAt && Date.parse(item.recordedAt) >= cutoff).slice(0, safeLimit).reverse();
  const latest = records.at(-1) || null;
  return {
    machineId: String(machineId || ""),
    rangeHours: safeHours,
    intervalMinutes: BUCKET_MS / 60_000,
    retentionHours: 7 * 24,
    records,
    summary: {
      samples: records.length,
      latestAt: latest?.recordedAt || null,
      latestDiskFreePercent: latest?.disk?.freePercent ?? null,
      latestMemoryAvailablePercent: latest?.memory?.freePercent ?? null,
      averageDiskFreePercent: average(records, "disk"),
      averageMemoryAvailablePercent: average(records, "memory"),
    },
  };
}

export const TELEMETRY_HISTORY_LIMITS = Object.freeze({ bucketMinutes: 5, retentionHours: 168, maxSnapshots: MAX_SNAPSHOTS });
