import { redactLogValue } from "./_observability.mjs";

const MODES = new Set(["off", "dual", "primary"]);
const KINDS = new Set(["background", "frame", "logo", "sticker"]);
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value, 500).replace(/\/+$/g, "");
const boothPattern = /^[a-z0-9][a-z0-9-]{2,63}$/;
const assetPattern = /^[A-Za-z0-9_-]{3,160}$/;

export function postgresAssetStatus(environment = process.env) {
  const requested = clean(environment.PHOTOSLIVE_POSTGRES_ASSETS, 20).toLowerCase() || "off";
  const mode = MODES.has(requested) ? requested : "off";
  const configured = Boolean(baseUrl(environment.SUPABASE_URL) && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 8));
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || 1_500);
  return {
    mode, primary: mode === "primary", enabled: mode !== "off", configured,
    timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(5_000, Math.round(configuredTimeout))) : 1_500,
    reason: mode === "off" ? "PostgreSQL metadata aset belum diaktifkan" : configured ? "" : "Credential Supabase server belum lengkap",
  };
}

async function assetRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const status = postgresAssetStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, status: 503, reason: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await (options.fetchImplementation || fetch)(`${baseUrl(environment.SUPABASE_URL)}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: environment.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`PostgreSQL aset gagal (${response.status})`), { status: response.status });
    return { ok: true, skipped: false, payload: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `PostgreSQL aset timeout setelah ${status.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.asset.failed", operation: name, identity, reason })));
    return { ok: false, skipped: false, status: Number(error?.status || 503), reason };
  } finally { clearTimeout(timeout); }
}

function safeAsset(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const boothCode = clean(payload.boothCode, 64).toLowerCase();
  const id = clean(payload.id, 160);
  const kind = clean(payload.kind, 20);
  const objectKey = clean(payload.objectKey, 500);
  const createdAt = clean(payload.createdAt, 64);
  const requiredPrefix = `assets/${boothCode}/${kind}/`;
  if (!boothPattern.test(boothCode) || !assetPattern.test(id) || !KINDS.has(kind)
    || !objectKey.startsWith(requiredPrefix) || objectKey.includes("..")
    || !Number.isFinite(Date.parse(createdAt))) return null;
  const checksumSha256 = clean(payload.checksumSha256, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(checksumSha256)) return null;
  const size = Number(payload.size || 0);
  if (!Number.isSafeInteger(size) || size < 1 || size > 25_000_000) return null;
  const contentType = clean(payload.contentType, 100).toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(contentType)) return null;
  return {
    id, boothCode, kind, name: clean(payload.name || `${kind}.webp`, 120),
    contentType, size, checksumSha256,
    createdAt, url: `/api/platform?action=cloud_asset&booth=${encodeURIComponent(boothCode)}&id=${encodeURIComponent(id)}`,
    storageMode: "object-storage", storageProvider: clean(payload.storageProvider, 120).toLowerCase(),
    objectKey, etag: clean(payload.etag, 200),
    deletionRequested: payload.deletionRequested === true,
    deletionRequestedAt: clean(payload.deletionRequestedAt, 64) || null,
  };
}

export async function persistPostgresAsset(input = {}, options = {}) {
  const asset = safeAsset(input);
  if (!asset) throw new Error("Metadata aset PostgreSQL tidak valid");
  const result = await assetRpc("photoslive_persist_booth_asset", {
    p_booth_code: asset.boothCode, p_legacy_id: asset.id, p_kind: asset.kind,
    p_object_key: asset.objectKey, p_content_type: asset.contentType, p_byte_size: asset.size,
    p_checksum_sha256: asset.checksumSha256,
    p_metadata: { name: asset.name, storageProvider: asset.storageProvider, etag: asset.etag },
    p_created_at: asset.createdAt,
  }, `${asset.boothCode}:${asset.id}`, options);
  if (!result.ok || result.skipped) return result;
  const persisted = safeAsset(result.payload);
  return persisted ? { ...result, asset: persisted } : { ok: false, skipped: false, status: 503, reason: "Snapshot aset PostgreSQL tidak valid" };
}

export async function readPostgresAssets(boothCodeInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  if (!boothPattern.test(boothCode)) return null;
  const result = await assetRpc("photoslive_booth_assets_snapshot", { p_booth_code: boothCode }, boothCode, options);
  if (!result.ok || !Array.isArray(result.payload)) return null;
  return result.payload.map(safeAsset).filter(Boolean);
}

export async function requestPostgresAssetDeletion(boothCodeInput, assetIdInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  const id = clean(assetIdInput, 160);
  if (!boothPattern.test(boothCode) || !assetPattern.test(id)) throw new Error("Identitas aset PostgreSQL tidak valid");
  const result = await assetRpc("photoslive_request_booth_asset_deletion", { p_booth_code: boothCode, p_legacy_id: id }, `${boothCode}:${id}`, options);
  if (!result.ok || result.skipped) return result;
  const asset = safeAsset(result.payload);
  return asset ? { ...result, asset } : { ok: false, skipped: false, status: 404, reason: "Aset PostgreSQL tidak ditemukan" };
}

export async function deletePostgresAsset(boothCodeInput, assetIdInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  const id = clean(assetIdInput, 160);
  if (!boothPattern.test(boothCode) || !assetPattern.test(id)) throw new Error("Identitas aset PostgreSQL tidak valid");
  return assetRpc("photoslive_delete_booth_asset", { p_booth_code: boothCode, p_legacy_id: id }, `${boothCode}:${id}`, options);
}
