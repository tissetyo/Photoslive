import { now, randomId } from "./_store.mjs";

const RISK_INDEX_KEY = "photoslive:finance-risk:index";
const RULES = new Set(["payout_account_changed", "high_value_payout", "duplicate_transfer_reference"]);
const SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const STATUSES = new Set(["open", "acknowledged", "resolved"]);

const clean = (value, maximum = 240) => String(value ?? "").trim().slice(0, maximum);
const safeId = (value, maximum = 120) => clean(value, maximum).toLowerCase().replace(/[^a-z0-9._:-]/g, "-");
const riskKey = id => `photoslive:finance-risk:${safeId(id)}`;
const fingerprintKey = fingerprint => `photoslive:finance-risk-fingerprint:${safeId(fingerprint, 300)}`;

function safeMetadata(value = {}) {
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value || {}).slice(0, 20)) {
    const key = safeId(rawKey, 60);
    if (!key) continue;
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) result[key] = rawValue;
    else if (typeof rawValue === "boolean") result[key] = rawValue;
    else if (rawValue != null) result[key] = clean(rawValue, 240);
  }
  return result;
}

function publicRisk(record) {
  if (!record) return null;
  return {
    id: record.id,
    rule: record.rule,
    severity: record.severity,
    status: record.status,
    boothCode: record.boothCode || null,
    entityType: record.entityType,
    entityId: record.entityId,
    title: record.title,
    description: record.description,
    metadata: safeMetadata(record.metadata),
    occurrenceCount: Number(record.occurrenceCount || 1),
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    acknowledgedAt: record.acknowledgedAt || null,
    acknowledgedBy: record.acknowledgedBy || null,
    resolvedAt: record.resolvedAt || null,
    resolvedBy: record.resolvedBy || null,
    reviewNote: record.reviewNote || null,
    history: Array.isArray(record.history) ? record.history.slice(-20).map(entry => ({
      operation: entry.operation,
      actorId: entry.actorId,
      note: entry.note,
      at: entry.at,
    })) : [],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function pushBounded(redis, key, value, limit = 2_000) {
  await redis.lpush(key, value);
  await redis.ltrim(key, 0, limit - 1);
}

export async function recordFinanceRisk(redis, input = {}, actorId = "system") {
  const rule = safeId(input.rule, 80);
  const severity = safeId(input.severity || "medium", 20);
  const boothCode = safeId(input.boothCode, 100);
  const entityType = safeId(input.entityType || "finance", 60);
  const entityId = safeId(input.entityId, 140);
  const fingerprint = safeId(input.fingerprint || `${rule}:${boothCode || "platform"}:${entityType}:${entityId}`, 300);
  if (!RULES.has(rule) || !SEVERITIES.has(severity) || !entityType || !entityId || !fingerprint) throw new Error("Sinyal risiko finance tidak valid");
  const markerKey = fingerprintKey(fingerprint);
  const existingId = await redis.get(markerKey);
  const existing = existingId ? await redis.get(riskKey(existingId)) : null;
  if (existing && existing.status !== "resolved") {
    existing.occurrenceCount = Number(existing.occurrenceCount || 1) + 1;
    existing.lastSeenAt = now();
    existing.updatedAt = existing.lastSeenAt;
    existing.metadata = { ...existing.metadata, ...safeMetadata(input.metadata) };
    await redis.set(riskKey(existing.id), existing);
    return { risk: publicRisk(existing), reused: true };
  }
  const id = randomId("finance-risk");
  const claimed = await redis.set(markerKey, id, { nx: true });
  if (!claimed && !existing) {
    const winnerId = await redis.get(markerKey);
    const winner = winnerId ? await redis.get(riskKey(winnerId)) : null;
    if (winner) return recordFinanceRisk(redis, input, actorId);
  }
  // A resolved case may recur. Repoint its fingerprint to a fresh case.
  if (existing?.status === "resolved") await redis.set(markerKey, id);
  const createdAt = now();
  const record = {
    id, rule, severity, status: "open", boothCode: boothCode || null, entityType, entityId, fingerprint,
    title: clean(input.title, 160) || "Risiko finance perlu diperiksa",
    description: clean(input.description, 500),
    metadata: safeMetadata(input.metadata), occurrenceCount: 1,
    firstSeenAt: createdAt, lastSeenAt: createdAt, acknowledgedAt: null, acknowledgedBy: null,
    resolvedAt: null, resolvedBy: null, reviewNote: null,
    history: [{ operation: "created", actorId: clean(actorId, 120) || "system", note: "Kasus dibuat oleh rule engine", at: createdAt }],
    createdAt, updatedAt: createdAt,
  };
  await redis.set(riskKey(id), record);
  await pushBounded(redis, RISK_INDEX_KEY, id);
  return { risk: publicRisk(record), reused: false };
}

export async function getFinanceRisk(redis, id) {
  return publicRisk(await redis.get(riskKey(id)));
}

export async function listFinanceRisks(redis, options = {}) {
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
  const boothCode = safeId(options.boothCode, 100);
  const status = safeId(options.status, 20);
  const severity = safeId(options.severity, 20);
  if (status && !STATUSES.has(status)) throw new Error("Filter status risiko tidak valid");
  if (severity && !SEVERITIES.has(severity)) throw new Error("Filter severity risiko tidak valid");
  const ids = await redis.lrange(RISK_INDEX_KEY, 0, Math.max(limit * 5, limit) - 1);
  const records = await Promise.all([...new Set(ids)].map(id => redis.get(riskKey(id))));
  return records.filter(record => record
    && (!boothCode || record.boothCode === boothCode)
    && (!status || record.status === status)
    && (!severity || record.severity === severity))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit)
    .map(publicRisk);
}

export function summarizeFinanceRisks(records = []) {
  return records.reduce((summary, record) => {
    summary.total += 1;
    summary[record.status] = Number(summary[record.status] || 0) + 1;
    summary[record.severity] = Number(summary[record.severity] || 0) + 1;
    return summary;
  }, { total: 0, open: 0, acknowledged: 0, resolved: 0, low: 0, medium: 0, high: 0, critical: 0 });
}

export async function reviewFinanceRisk(redis, input = {}, actorId = "system") {
  const id = safeId(input.id, 140);
  const operation = safeId(input.operation, 30);
  const note = clean(input.note, 500);
  if (!id || !new Set(["acknowledge", "resolve"]).has(operation) || note.length < 3) throw new Error("Tindakan dan catatan review risiko wajib diisi");
  const record = await redis.get(riskKey(id));
  if (!record) throw Object.assign(new Error("Kasus risiko finance tidak ditemukan"), { status: 404 });
  if (record.status === "resolved") return { risk: publicRisk(record), reused: true };
  const reviewedAt = now();
  const reviewer = clean(actorId, 120) || "system";
  if (operation === "acknowledge") {
    record.status = "acknowledged";
    record.acknowledgedAt = reviewedAt;
    record.acknowledgedBy = reviewer;
  } else {
    record.status = "resolved";
    record.resolvedAt = reviewedAt;
    record.resolvedBy = reviewer;
  }
  record.reviewNote = note;
  record.updatedAt = reviewedAt;
  record.history = [...(Array.isArray(record.history) ? record.history : []), { operation, actorId: reviewer, note, at: reviewedAt }].slice(-20);
  await redis.set(riskKey(id), record);
  return { risk: publicRisk(record), reused: false };
}

export const financeRiskStorageKeys = Object.freeze({ RISK_INDEX_KEY, riskKey, fingerprintKey });
