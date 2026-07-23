import { deleteObject } from "./_object_storage.mjs";

export const PUBLIC_SESSION_RETENTION_INDEX = "photoslive:public-session-retention";
const RETENTION_GRACE_SECONDS = 7 * 86_400;

const sessionKey = (boothCode, shareCode) => `photoslive:public-session:${boothCode}:${shareCode}`;
const fileKey = (boothCode, shareCode, fileId) => `photoslive:public-session-file:${boothCode}:${shareCode}:${fileId}`;
const retentionKey = (boothCode, shareCode) => `photoslive:public-session-retention:${boothCode}:${shareCode}`;
const member = (boothCode, shareCode) => `${boothCode}|${shareCode}`;

function retentionTtl(expiresAt, currentTime = Date.now()) {
  const remaining = Math.ceil((Date.parse(expiresAt || "") - currentTime) / 1000);
  return Math.max(RETENTION_GRACE_SECONDS, remaining + RETENTION_GRACE_SECONDS);
}

export async function trackPublicSessionRetention(redis, session) {
  const boothCode = String(session?.boothCode || "");
  const shareCode = String(session?.shareCode || "");
  const expiresAt = String(session?.expiresAt || "");
  const expiry = Date.parse(expiresAt);
  if (!boothCode || !shareCode || !Number.isFinite(expiry)) throw new Error("Metadata retensi sesi tidak valid");
  const key = retentionKey(boothCode, shareCode);
  const previous = await redis.get(key);
  const record = {
    boothCode,
    shareCode,
    expiresAt,
    fileIds: [...new Set([...(previous?.fileIds || []), ...(session.files || []).map(file => String(file.id || "")).filter(Boolean)])],
    objectKeys: [...new Set(previous?.objectKeys || [])],
    objectRecords: Array.isArray(previous?.objectRecords) ? previous.objectRecords : [],
    updatedAt: new Date().toISOString(),
  };
  await redis.set(key, record, { ex: retentionTtl(expiresAt) });
  await redis.zadd(PUBLIC_SESSION_RETENTION_INDEX, { score: expiry, member: member(boothCode, shareCode) });
  return record;
}

export async function trackPublicSessionFileRetention(redis, session, fileRecord) {
  const record = await trackPublicSessionRetention(redis, session);
  const fileId = String(fileRecord?.id || "");
  const objectKey = String(fileRecord?.objectKey || "");
  if (fileId && !record.fileIds.includes(fileId)) record.fileIds.push(fileId);
  if (objectKey && !record.objectKeys.includes(objectKey)) record.objectKeys.push(objectKey);
  if (objectKey) {
    record.objectRecords = [
      ...(record.objectRecords || []).filter(item => item.objectKey !== objectKey),
      { objectKey, storageProvider: String(fileRecord?.storageProvider || "") },
    ];
  }
  record.updatedAt = new Date().toISOString();
  await redis.set(retentionKey(record.boothCode, record.shareCode), record, { ex: retentionTtl(record.expiresAt) });
  return record;
}

export async function deletePublicSessionArtifacts(redis, boothCode, shareCode, { deleteObjectImpl = deleteObject } = {}) {
  const metadata = await redis.get(sessionKey(boothCode, shareCode));
  const retention = await redis.get(retentionKey(boothCode, shareCode));
  const fileIds = [...new Set([
    ...(metadata?.files || []).map(file => String(file.id || "")).filter(Boolean),
    ...(retention?.fileIds || []),
  ])];
  const records = [];
  for (const fileId of fileIds) {
    const record = await redis.get(fileKey(boothCode, shareCode, fileId));
    if (record) records.push(record);
  }
  const objectKeys = [...new Set([
    ...(retention?.objectKeys || []),
    ...records.map(record => String(record.objectKey || "")).filter(Boolean),
  ])];

  // Metadata is deliberately retained until every remote object deletion has
  // succeeded, so a transient provider failure can be retried safely.
  const providerByObject = new Map([
    ...(retention?.objectRecords || []).map(item => [String(item.objectKey || ""), String(item.storageProvider || "")]),
    ...records.map(record => [String(record.objectKey || ""), String(record.storageProvider || "")]),
  ]);
  for (const objectKey of objectKeys) await deleteObjectImpl({ objectKey, storageProvider: providerByObject.get(objectKey) || "", boothCode, shareCode });
  for (const fileId of fileIds) await redis.del(fileKey(boothCode, shareCode, fileId));
  await redis.del(sessionKey(boothCode, shareCode));
  await redis.del(retentionKey(boothCode, shareCode));
  await redis.zrem(PUBLIC_SESSION_RETENTION_INDEX, member(boothCode, shareCode));
  return { deleted: true, filesDeleted: fileIds.length, objectsDeleted: objectKeys.length };
}

export async function cleanupExpiredPublicSessions(redis, { limit = 50, currentTime = Date.now(), deleteObjectImpl = deleteObject } = {}) {
  const boundedLimit = Math.max(1, Math.min(100, Number(limit || 50)));
  const due = await redis.zrange(PUBLIC_SESSION_RETENTION_INDEX, "-inf", currentTime, { byScore: true, offset: 0, count: boundedLimit });
  const results = [];
  for (const value of due) {
    const [boothCode, shareCode] = String(value).split("|");
    if (!boothCode || !shareCode) {
      await redis.zrem(PUBLIC_SESSION_RETENTION_INDEX, value);
      continue;
    }
    try {
      results.push({ boothCode, shareCode, ...await deletePublicSessionArtifacts(redis, boothCode, shareCode, { deleteObjectImpl }) });
    } catch (error) {
      results.push({ boothCode, shareCode, deleted: false, error: error instanceof Error ? error.message : "Cleanup gagal" });
    }
  }
  return {
    processed: results.length,
    deleted: results.filter(result => result.deleted).length,
    failed: results.filter(result => !result.deleted).length,
    results,
  };
}
