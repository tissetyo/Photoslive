import { redactLogValue } from "./_observability.mjs";

const DEFAULT_TIMEOUT_MS = 1_500;
const MODES = new Set(["off", "dual", "primary"]);

const baseUrl = value => String(value || "").trim().replace(/\/+$/g, "");
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);

export function postgresVoucherStatus(environment = process.env) {
  const requestedMode = clean(environment.PHOTOSLIVE_POSTGRES_CLOUD_DATA, 20).toLowerCase() || "off";
  const mode = MODES.has(requestedMode) ? requestedMode : "off";
  const configured = Boolean(baseUrl(environment.SUPABASE_URL) && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 8));
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(100, Math.min(5_000, Math.round(configuredTimeout)))
    : DEFAULT_TIMEOUT_MS;
  return {
    mode,
    enabled: mode !== "off",
    primary: mode === "primary",
    configured,
    available: mode !== "off" && configured,
    timeoutMs,
    reason: mode === "off"
      ? "PostgreSQL cloud data belum diaktifkan"
      : configured ? "" : "SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY belum dikonfigurasi",
  };
}

function safeVoucher(record = {}) {
  return {
    code: clean(record.code, 40).toUpperCase(),
    boothCode: clean(record.boothCode, 64).toLowerCase() || null,
    eventId: clean(record.eventId, 140) || null,
    includesPrint: Boolean(record.includesPrint),
    createdAt: clean(record.createdAt, 40) || new Date().toISOString(),
    redeemedAt: clean(record.redeemedAt, 40) || null,
  };
}

export async function persistPostgresVoucherBatch(input = {}, options = {}) {
  const environment = options.environment || process.env;
  const fetchImplementation = options.fetchImplementation || fetch;
  const status = postgresVoucherStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, reason: status.reason };
  const boothCode = clean(input.boothCode, 64).toLowerCase();
  const vouchers = Array.isArray(input.vouchers) ? input.vouchers.slice(0, 100).map(safeVoucher) : [];
  if (!boothCode || !vouchers.length || vouchers.some(voucher => !/^[A-Z0-9-]{4,40}$/.test(voucher.code))) {
    throw new Error("Batch voucher PostgreSQL tidak valid");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await fetchImplementation(
      `${baseUrl(environment.SUPABASE_URL)}/rest/v1/rpc/photoslive_persist_voucher_batch`,
      {
        method: "POST",
        headers: {
          apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
          authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ p_booth_code: boothCode, p_vouchers: vouchers }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`PostgreSQL voucher batch gagal (${response.status})`);
    const payload = await response.json();
    const version = Number(payload?.version || 0);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("Versi voucher PostgreSQL tidak valid");
    return { ok: true, skipped: false, version, inserted: Number(payload?.inserted || 0) };
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? `PostgreSQL voucher batch timeout setelah ${status.timeoutMs} ms`
      : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({
      level: "warn", event: "postgres.voucher_batch.failed", boothCode,
      count: vouchers.length, correlationId: clean(input.correlationId, 128), reason,
    })));
    return { ok: false, skipped: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function invokeVoucherRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const fetchImplementation = options.fetchImplementation || fetch;
  const status = postgresVoucherStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, reason: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await fetchImplementation(`${baseUrl(environment.SUPABASE_URL)}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`PostgreSQL voucher operation gagal (${response.status})`), { status: response.status });
    return { ok: true, skipped: false, payload: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? `PostgreSQL voucher operation timeout setelah ${status.timeoutMs} ms`
      : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.voucher_operation.failed", operation: name, identity, reason })));
    return { ok: false, skipped: false, reason, status: Number(error?.status || 503) };
  } finally {
    clearTimeout(timeout);
  }
}

function versionedResult(result) {
  if (!result.ok) return result;
  const version = Number(result.payload?.version || 0);
  if (!Number.isSafeInteger(version) || version < 1) {
    return { ok: false, skipped: false, status: 503, reason: "Versi voucher PostgreSQL tidak valid" };
  }
  return { ...result, version };
}

export async function persistPostgresVoucherEvent(input = {}, options = {}) {
  const boothCode = clean(input.boothCode, 64).toLowerCase();
  const event = {
    id: clean(input.event?.id, 140),
    name: clean(input.event?.name, 120),
    expiresAt: clean(input.event?.expiresAt, 40),
    includesPrint: Boolean(input.event?.includesPrint),
    createdAt: clean(input.event?.createdAt, 40),
  };
  if (!boothCode || !event.id || !event.name || !event.expiresAt) throw new Error("Voucher event PostgreSQL tidak valid");
  const result = await invokeVoucherRpc("photoslive_persist_voucher_event", { p_booth_code: boothCode, p_event: event }, event.id, options);
  return versionedResult(result);
}

export async function deletePostgresVoucher(input = {}, options = {}) {
  const boothCode = clean(input.boothCode, 64).toLowerCase();
  const code = clean(input.code, 40).toUpperCase();
  if (!boothCode || !/^[A-Z0-9-]{4,40}$/.test(code)) throw new Error("Voucher PostgreSQL tidak valid");
  const result = await invokeVoucherRpc("photoslive_delete_voucher", { p_booth_code: boothCode, p_code: code }, code, options);
  return versionedResult(result);
}

export async function redeemPostgresVoucher(input = {}, options = {}) {
  const boothCode = clean(input.boothCode, 64).toLowerCase();
  const code = clean(input.code, 40).toUpperCase();
  const redeemedAt = clean(input.redeemedAt, 40) || new Date().toISOString();
  if (!boothCode || !/^[A-Z0-9-]{4,40}$/.test(code)) throw new Error("Voucher PostgreSQL tidak valid");
  const result = await invokeVoucherRpc("photoslive_redeem_voucher", { p_booth_code: boothCode, p_code: code, p_redeemed_at: redeemedAt }, code, options);
  return versionedResult(result);
}

export async function readPostgresVoucherSnapshot(boothCodeInput, options = {}) {
  const boothCode = clean(boothCodeInput, 64).toLowerCase();
  if (!boothCode) return null;
  const result = await invokeVoucherRpc("photoslive_voucher_snapshot", { p_booth_code: boothCode }, boothCode, options);
  if (!result.ok || !result.payload || typeof result.payload !== "object") return null;
  return {
    version: Number(result.payload.version || 0),
    vouchers: Array.isArray(result.payload.vouchers) ? result.payload.vouchers.slice(0, 5_000).map(safeVoucher) : [],
    events: Array.isArray(result.payload.events) ? result.payload.events.slice(0, 500).map(event => ({
      id: clean(event.id, 140), boothCode, name: clean(event.name, 120),
      expiresAt: clean(event.expiresAt, 40), includesPrint: Boolean(event.includesPrint), createdAt: clean(event.createdAt, 40),
    })) : [],
  };
}
