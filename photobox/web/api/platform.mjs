import { boothKey, getRedis, machineKey, now, randomId, sessionKey, userKey } from "./_store.mjs";

const encoder = new TextEncoder();
const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

async function requestBody(request) {
  return request.method === "GET" ? {} : request.json().catch(() => ({}));
}

function cookieMap(request) {
  return Object.fromEntries((request.headers.get("cookie") || "").split(";").map(value => value.trim()).filter(Boolean).map(value => {
    const index = value.indexOf("="); return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
  }));
}

const bytesToHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");

async function hashCredential(value, salt = crypto.randomUUID().replaceAll("-", "")) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(String(value)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 120_000, hash: "SHA-256" }, material, 256);
  return `${salt}:${bytesToHex(bits)}`;
}

async function verifyCredential(value, stored = "") {
  const [salt] = String(stored).split(":");
  return Boolean(salt && await hashCredential(value, salt) === stored);
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET production belum dikonfigurasi");
  return secret;
}

async function signature(value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(sessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function createSession(redis, data) {
  const id = randomId("login");
  const record = { id, ...data, createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
  await redis.set(sessionKey(id), record, { ex: 7 * 86_400 });
  return `${id}.${await signature(id)}`;
}

async function authenticate(redis, request) {
  const token = cookieMap(request).photoslive_session || "";
  const [id, supplied] = token.split(".");
  if (!id || !supplied || supplied !== await signature(id)) return null;
  return redis.get(sessionKey(id));
}

const sessionCookie = token => `photoslive_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
const clearCookie = "photoslive_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
const normalizeCode = code => String(code || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
const normalizeEmail = email => String(email || "").trim().toLowerCase().slice(0, 160);
const cloudSettingsKey = boothCode => `photoslive:booth:${boothCode}:settings`;
const voucherIndexKey = boothCode => `photoslive:booth:${boothCode}:vouchers`;
const voucherKey = (boothCode, code) => `photoslive:booth:${boothCode}:voucher:${code}`;
const voucherEventIndexKey = boothCode => `photoslive:booth:${boothCode}:voucher-events`;
const voucherEventKey = (boothCode, id) => `photoslive:booth:${boothCode}:voucher-event:${id}`;
const assetIndexKey = (boothCode, kind) => `photoslive:booth:${boothCode}:assets:${kind}`;
const assetKey = (boothCode, id) => `photoslive:booth:${boothCode}:asset:${id}`;
const voucherVersionKey = boothCode => `photoslive:booth:${boothCode}:voucher-version`;
const settingsVersionKey = boothCode => `photoslive:booth:${boothCode}:settings-version`;
const publicSessionKey = (boothCode, shareCode) => `photoslive:public-session:${boothCode}:${shareCode}`;
const publicSessionFileKey = (boothCode, shareCode, slotIndex) => `photoslive:public-session-file:${boothCode}:${shareCode}:${slotIndex}`;
const auditKey = boothCode => `photoslive:booth:${boothCode}:audit`;
const ASSET_KINDS = ["background", "frame", "logo", "sticker"];

const DEFAULT_CLOUD_SETTINGS = {
  booth: { name: "Photoslive Booth", location: "", dailySessionLimit: 120, sessionTimeoutSeconds: 150, countdownSeconds: 15, retakeLimit: 1, unlimitedRetakes: true, photoSlotsPerSession: 3, printsPerSession: 1, localRetentionHours: 24, cloudRetentionDays: 7, maintenanceMode: false },
  payment: { qrisEnabled: false, voucherEnabled: false, price: 35000, currency: "IDR", provider: "Not configured", paidPrintEnabled: false, printPrice: 10000 },
  appearance: {
    activeBackground: "default-gradient", activeFrame: "party-night", activeLogo: "text-logo", welcomeTitle: "Abadikan momenmu", touchPrompt: "Sentuh layar untuk memulai", startButtonLabel: "Mulai foto", fontFamily: "system", screenPreset: "1080x1920", screenSizeInches: 15.6, logoSizePercent: 28, headingFontSize: 48, helperFontSize: 18, buttonFontSize: 16, accentColor: "#6d5dfc", headingTextColor: "#ffffff", helperTextColor: "#ffffff", buttonBackgroundColor: "#ffffff", buttonTextColor: "#7c3049", frameFormat: "photo-strip-vertical",
    framePhotoSlots: { "clean-white": 3, "party-night": 3 }, framePhotoWidths: { "clean-white": 86, "party-night": 86 }, frameBackgroundTransforms: {}, frameSlotTransforms: {}, frameStickers: {}, frameLayoutModes: { "clean-white": "auto", "party-night": "auto" }, frameSizePresets: { "clean-white": "custom", "party-night": "custom" }, frameCanvasSizes: { "clean-white": { width: 800, height: 1600 }, "party-night": { width: 800, height: 1600 } }, frameOriginalCanvasSizes: { "clean-white": { width: 1200, height: 1600 }, "party-night": { width: 1200, height: 1600 } }, frameAspectRatio: "3:4", frameCanvasWidth: 1200, frameCanvasHeight: 1600, frameBottomMarginPercent: 20,
  },
  storage: { cloudEnabled: false, provider: "Cloudflare R2", uploadFinalOnly: true, deleteOnlyAfterUpload: true },
  devices: { preferredCamera: "auto", preferredPrinter: "auto", paperSize: "4x6", printLayout: "photo-strip-vertical", stripsPerSheet: 2, borderless: true, cameraSource: "auto", browserCameraId: "", cameraMirror: false, cameraRotation: "0" },
};

const clone = value => structuredClone(value);
const isObject = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
function mergeObjects(base, incoming) {
  const result = clone(base);
  if (!isObject(incoming)) return result;
  for (const [key, value] of Object.entries(incoming)) result[key] = isObject(value) && isObject(result[key]) ? mergeObjects(result[key], value) : clone(value);
  return result;
}

async function cloudSettings(redis, booth) {
  const stored = await redis.get(cloudSettingsKey(booth.boothCode));
  const settings = mergeObjects(DEFAULT_CLOUD_SETTINGS, stored);
  settings.booth.name = stored?.booth?.name || booth.name || settings.booth.name;
  settings.booth.location = stored?.booth?.location ?? booth.location ?? settings.booth.location;
  return settings;
}

async function requireBoothAdmin(redis, request, requestedCode) {
  const auth = await authenticate(redis, request);
  const booth = await resolveBooth(redis, requestedCode || auth?.boothCode);
  if (!auth?.boothCode || !booth || auth.boothCode !== booth.boothCode) return null;
  return { auth, booth };
}

async function appendAudit(redis, auth, boothCode, action, target = "", detail = {}) {
  const record = {
    id: randomId("audit"),
    boothCode,
    actorId: auth?.userId || auth?.role || "system",
    actorRole: auth?.role || "system",
    action,
    target: String(target || "").slice(0, 160),
    detail,
    createdAt: now(),
  };
  const serialized = JSON.stringify(record);
  const pipeline = redis.pipeline();
  pipeline.lpush(auditKey(boothCode), serialized);
  pipeline.ltrim(auditKey(boothCode), 0, 499);
  pipeline.lpush("photoslive:audit:global", serialized);
  pipeline.ltrim("photoslive:audit:global", 0, 999);
  await pipeline.exec();
  return record;
}

async function auditLog(redis, request, payload) {
  const auth = await authenticate(redis, request);
  const boothCode = normalizeCode(payload.booth || auth?.boothCode);
  if (!auth || (auth.role !== "superadmin" && (!boothCode || auth.boothCode !== boothCode))) return json({ error: "Akses audit log ditolak" }, 403);
  const raw = await redis.lrange(auth.role === "superadmin" && !boothCode ? "photoslive:audit:global" : auditKey(boothCode), 0, 99);
  const records = raw.map(item => {
    if (typeof item !== "string") return item;
    try { return JSON.parse(item); } catch { return null; }
  }).filter(Boolean);
  return json({ records });
}

function voucherCode(value = "") {
  return String(value).trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
}

async function voucherRecords(redis, boothCode) {
  const codes = await redis.smembers(voucherIndexKey(boothCode));
  return (await Promise.all(codes.map(code => redis.get(voucherKey(boothCode, code))))).filter(Boolean);
}

async function voucherEvents(redis, boothCode) {
  const ids = await redis.smembers(voucherEventIndexKey(boothCode));
  return (await Promise.all(ids.map(id => redis.get(voucherEventKey(boothCode, id))))).filter(Boolean);
}

async function cloudAssets(redis, boothCode) {
  const result = Object.fromEntries(ASSET_KINDS.map(kind => [kind, []]));
  await Promise.all(ASSET_KINDS.map(async kind => {
    const ids = await redis.smembers(assetIndexKey(boothCode, kind));
    const records = (await Promise.all(ids.map(id => redis.get(assetKey(boothCode, id))))).filter(Boolean);
    result[kind] = records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(({ data, ...record }) => record);
  }));
  return result;
}

function eventExpired(event) {
  return Boolean(event?.expiresAt && Date.parse(event.expiresAt) <= Date.now());
}

async function voucherPayload(redis, boothCode) {
  const [records, events] = await Promise.all([voucherRecords(redis, boothCode), voucherEvents(redis, boothCode)]);
  const eventMap = new Map(events.map(event => [event.id, event]));
  const active = records.filter(record => !record.redeemedAt && !eventExpired(eventMap.get(record.eventId)));
  const renderedEvents = events.map(event => {
    const members = records.filter(record => record.eventId === event.id);
    return { ...event, status: eventExpired(event) ? "expired" : "active", active: members.filter(record => !record.redeemedAt && !eventExpired(event)).length, used: members.filter(record => record.redeemedAt).length, total: members.length };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return {
    vouchers: active.slice(0, 100).map(record => ({ ...record, eventName: eventMap.get(record.eventId)?.name || "" })),
    summary: { generalActive: active.filter(record => !record.eventId).length, eventActive: active.filter(record => record.eventId).length, used: records.filter(record => record.redeemedAt).length },
    events: renderedEvents,
  };
}

async function createCloudVoucher(redis, boothCode, payload) {
  const code = voucherCode(payload.code) || `${pairingVoucherPart()}-${pairingVoucherPart()}`;
  if (code.length < 4) return json({ error: "Kode voucher minimal 4 karakter" }, 400);
  if (await redis.get(voucherKey(boothCode, code))) return json({ error: "Kode voucher sudah digunakan" }, 409);
  const event = payload.eventId ? await redis.get(voucherEventKey(boothCode, String(payload.eventId))) : null;
  if (payload.eventId && (!event || eventExpired(event))) return json({ error: "Event tidak ditemukan atau sudah berakhir" }, 404);
  const record = { code, boothCode, eventId: event?.id || null, includesPrint: event ? Boolean(event.includesPrint) : true, createdAt: now(), redeemedAt: null };
  await redis.set(voucherKey(boothCode, code), record);
  await redis.sadd(voucherIndexKey(boothCode), code);
  await redis.incr(voucherVersionKey(boothCode));
  return json({ voucher: record }, 201);
}

function pairingVoucherPart() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map(byte => alphabet[byte % alphabet.length]).join("");
}

async function resolveBooth(redis, code) {
  const lookupCode = normalizeCode(code);
  const machineId = await redis.get(boothKey(lookupCode));
  if (!machineId) return null;
  const machine = await redis.get(machineKey(machineId));
  if (!machine) return null;
  const boothCode = normalizeCode(machine.boothCode || lookupCode);
  const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0;
  return { boothCode, machineId, name: machine.name, location: machine.location || "", enabled: machine.accessEnabled !== false, online: Boolean(lastSeen && Date.now() - lastSeen < 90_000), agentVersion: machine.agentVersion };
}

async function validateSetupCode(redis, payload) {
  const code = String(payload.pairingCode || "").trim().toUpperCase();
  if (!code) return json({ error: "Masukkan kode setup dari Photoslive Agent" }, 400);
  const machineId = await redis.get(`photoslive:pairing:${code}`);
  if (!machineId) return json({ error: "Kode setup tidak ditemukan atau sudah kedaluwarsa. Buat kode baru dari Agent." }, 404);
  const machine = await redis.get(machineKey(machineId));
  if (!machine) return json({ error: "Mesin tidak ditemukan" }, 404);
  const lastSeen = machine.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0;
  return json({
    valid: true,
    machine: {
      id: machine.id,
      name: machine.name || "Photoslive Booth",
      location: machine.location || "",
      platform: machine.platform || "Unknown",
      agentVersion: machine.agentVersion || "",
      online: Boolean(lastSeen && Date.now() - lastSeen < 90_000),
      devices: Array.isArray(machine.devices) ? machine.devices : [],
    },
  });
}

async function setupBooth(redis, payload) {
  const code = String(payload.pairingCode || "").trim().toUpperCase();
  const email = normalizeEmail(payload.email);
  if (!code || !email) return json({ error: "Kode setup dan email wajib diisi" }, 400);
  if (!/^\d{6}$/.test(String(payload.pin || "")) || payload.pin !== payload.confirmPin) return json({ error: "PIN harus 6 angka dan konfirmasinya harus sama" }, 400);
  const machineId = await redis.get(`photoslive:pairing:${code}`);
  if (!machineId) return json({ error: "Kode setup tidak ditemukan atau sudah kedaluwarsa. Jalankan Agent dengan --setup-code." }, 404);
  const machine = await redis.get(machineKey(machineId));
  if (!machine) return json({ error: "Mesin tidak ditemukan" }, 404);
  const boothCode = normalizeCode(machine.boothCode || code);
  const existingEmail = await redis.get(`photoslive:email:${email}`);
  if (existingEmail) return json({ error: "Email sudah digunakan" }, 409);
  machine.paired = true;
  machine.status = "offline";
  machine.name = String(payload.name || machine.name || "Photoslive Booth").slice(0, 80);
  machine.location = String(payload.location || "").slice(0, 120);
  machine.boothCode = boothCode;
  machine.accessEnabled = true;
  machine.pairedAt ||= now();
  machine.setupAt = now();
  delete machine.pairingCode;
  const user = { id: randomId("user"), boothCode, machineId, email, name: "Pemilik", role: "owner", passwordHash: payload.password ? await hashCredential(payload.password) : "", pinHash: await hashCredential(payload.pin), createdAt: now(), active: true };
  await redis.set(machineKey(machineId), machine);
  await redis.set(boothKey(boothCode), machineId);
  // A setup code is also a permanent login alias. Users commonly keep the
  // code shown by Agent, while the canonical booth URL may predate onboarding.
  await redis.set(boothKey(code), machineId);
  await redis.set(userKey(user.id), user);
  await redis.set(`photoslive:email:${email}`, user.id);
  await redis.sadd(`photoslive:booth:${boothCode}:users`, user.id);
  await redis.sadd("photoslive:machines", machineId);
  await redis.del(`photoslive:pairing:${code}`);
  const token = await createSession(redis, { userId: user.id, boothCode, machineId, role: user.role });
  return json({ booth: await resolveBooth(redis, boothCode), user: { id: user.id, email, name: user.name, role: user.role } }, 201, { "set-cookie": sessionCookie(token) });
}

async function login(redis, payload) {
  const lookupCode = normalizeCode(payload.boothCode);
  let booth = await resolveBooth(redis, lookupCode);
  if (!booth) {
    const recoveryEmail = normalizeEmail(payload.email);
    if (!recoveryEmail || !payload.pin) return json({ error: "Kode photobox belum tertaut. Masukkan email pemilik untuk memulihkannya.", recoveryRequired: true }, 404);
    const recoveryUserId = await redis.get(`photoslive:email:${recoveryEmail}`);
    const recoveryUser = recoveryUserId ? await redis.get(userKey(recoveryUserId)) : null;
    if (!recoveryUser?.active || !await verifyCredential(payload.pin, recoveryUser.pinHash)) return json({ error: "Email pemilik atau PIN tidak benar", recoveryRequired: true }, 401);
    booth = await resolveBooth(redis, recoveryUser.boothCode);
    if (!booth || !booth.enabled) return json({ error: "Akses photobox dinonaktifkan" }, 403);
    const existingAlias = await redis.get(boothKey(lookupCode));
    if (!existingAlias || existingAlias === booth.machineId) await redis.set(boothKey(lookupCode), booth.machineId);
    const token = await createSession(redis, { userId: recoveryUser.id, boothCode: booth.boothCode, machineId: booth.machineId, role: recoveryUser.role });
    return json({ booth, user: { id: recoveryUser.id, email: recoveryUser.email, name: recoveryUser.name, role: recoveryUser.role }, aliasRepaired: true }, 200, { "set-cookie": sessionCookie(token) });
  }
  if (!booth.enabled) return json({ error: "Akses photobox dinonaktifkan" }, 403);
  const boothCode = booth.boothCode;
  const ids = await redis.smembers(`photoslive:booth:${boothCode}:users`);
  let matched = null;
  for (const id of ids) {
    const user = await redis.get(userKey(id));
    if (!user?.active) continue;
    if (payload.pin && await verifyCredential(payload.pin, user.pinHash)) { matched = user; break; }
    if (normalizeEmail(payload.email) === user.email && await verifyCredential(payload.password, user.passwordHash)) { matched = user; break; }
  }
  if (!matched) return json({ error: "Email/password atau PIN tidak benar" }, 401);
  const aliasCode = normalizeCode(payload.aliasCode);
  if (aliasCode && aliasCode !== boothCode) {
    const existingAlias = await redis.get(boothKey(aliasCode));
    if (!existingAlias || existingAlias === booth.machineId) await redis.set(boothKey(aliasCode), booth.machineId);
  }
  const token = await createSession(redis, { userId: matched.id, boothCode, machineId: booth.machineId, role: matched.role });
  return json({ booth, user: { id: matched.id, email: matched.email, name: matched.name, role: matched.role } }, 200, { "set-cookie": sessionCookie(token) });
}

async function superadminLogin(redis, payload) {
  const email = normalizeEmail(payload.email);
  const expectedEmail = normalizeEmail(process.env.SUPERADMIN_EMAIL);
  const passwordHash = process.env.SUPERADMIN_PASSWORD_HASH || "";
  if (!expectedEmail || email !== expectedEmail || !await verifyCredential(payload.password, passwordHash)) return json({ error: "Kredensial superadmin tidak benar" }, 401);
  const token = await createSession(redis, { userId: "superadmin", role: "superadmin" });
  return json({ user: { email, role: "superadmin" } }, 200, { "set-cookie": sessionCookie(token) });
}

async function superadminSession(redis, request) {
  const auth = await readSession(redis, request);
  return json({ authenticated: auth?.role === "superadmin" });
}

async function currentUser(redis, request) {
  const auth = await authenticate(redis, request);
  if (!auth) return json({ user: null }, 401);
  if (auth.role === "superadmin") return json({ user: { id: "superadmin", role: "superadmin", email: process.env.SUPERADMIN_EMAIL } });
  const user = await redis.get(userKey(auth.userId));
  return json({ user: user ? { id: user.id, email: user.email, name: user.name, role: user.role, boothCode: user.boothCode } : null, booth: await resolveBooth(redis, auth.boothCode) });
}

async function listUsers(redis, request) {
  const auth = await authenticate(redis, request);
  if (!auth?.boothCode) return json({ error: "Login admin diperlukan" }, 401);
  const ids = await redis.smembers(`photoslive:booth:${auth.boothCode}:users`);
  const users = [];
  for (const id of ids) { const user = await redis.get(userKey(id)); if (user) users.push({ id: user.id, email: user.email, name: user.name, role: user.role, active: user.active, createdAt: user.createdAt }); }
  return json({ users });
}

async function addUser(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (!auth?.boothCode || !["owner", "admin"].includes(auth.role)) return json({ error: "Akses pemilik/admin diperlukan" }, 403);
  const email = normalizeEmail(payload.email);
  if (!email || String(payload.password || "").length < 8 || !/^\d{6}$/.test(String(payload.pin || ""))) return json({ error: "Email, password minimal 8 karakter, dan PIN 6 angka wajib diisi" }, 400);
  if (await redis.get(`photoslive:email:${email}`)) return json({ error: "Email sudah digunakan" }, 409);
  const user = { id: randomId("user"), boothCode: auth.boothCode, machineId: auth.machineId, email, name: String(payload.name || "Operator").slice(0, 80), role: payload.role === "admin" ? "admin" : "operator", passwordHash: await hashCredential(payload.password), pinHash: await hashCredential(payload.pin), createdAt: now(), active: true };
  await redis.set(userKey(user.id), user); await redis.set(`photoslive:email:${email}`, user.id); await redis.sadd(`photoslive:booth:${auth.boothCode}:users`, user.id);
  await appendAudit(redis, auth, auth.boothCode, "user.created", user.id, { role: user.role, email: user.email });
  return json({ user: { id: user.id, email, name: user.name, role: user.role, active: true } }, 201);
}

async function updateProfile(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (!auth?.userId || auth.role === "superadmin") return json({ error: "Login pengguna diperlukan" }, 401);
  const user = await redis.get(userKey(auth.userId));
  if (!user) return json({ error: "Pengguna tidak ditemukan" }, 404);
  if (payload.email && normalizeEmail(payload.email) !== user.email) {
    const email = normalizeEmail(payload.email); if (await redis.get(`photoslive:email:${email}`)) return json({ error: "Email sudah digunakan" }, 409);
    await redis.del(`photoslive:email:${user.email}`); await redis.set(`photoslive:email:${email}`, user.id); user.email = email;
  }
  if (payload.password) { if (String(payload.password).length < 8) return json({ error: "Password minimal 8 karakter" }, 400); user.passwordHash = await hashCredential(payload.password); }
  if (payload.pin) { if (!/^\d{6}$/.test(String(payload.pin))) return json({ error: "PIN harus 6 angka" }, 400); user.pinHash = await hashCredential(payload.pin); }
  if (payload.name) user.name = String(payload.name).slice(0, 80);
  user.updatedAt = now(); await redis.set(userKey(user.id), user);
  await appendAudit(redis, auth, user.boothCode, "profile.updated", user.id);
  return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}

async function forgotPassword(redis, payload) {
  const email = normalizeEmail(payload.email);
  const userId = await redis.get(`photoslive:email:${email}`);
  if (!userId) return json({ error: "Email tidak terdaftar, permintaan ditolak" }, 404);
  const user = await redis.get(userKey(userId));
  const request = { id: randomId("reset"), userId, email, boothCode: user.boothCode, status: "pending", message: String(payload.message || "").slice(0, 500), createdAt: now() };
  await redis.set(`photoslive:reset:${request.id}`, request);
  await redis.sadd("photoslive:reset-requests", request.id);
  return json({ request: { id: request.id, status: request.status } }, 201);
}

async function indexedMachineIds(redis) {
  const ids = new Set(await redis.smembers("photoslive:machines"));
  let cursor = "0";
  let rounds = 0;
  // Backfill machines created by Agent versions that predate the global set.
  // SCAN is cursor-based and bounded so the superadmin page remains lightweight.
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: "photoslive:machine:machine_*", count: 100 });
    for (const key of keys) {
      const match = String(key).match(/^photoslive:machine:(machine_[^:]+)$/);
      if (match) ids.add(match[1]);
    }
    cursor = String(nextCursor);
    rounds += 1;
  } while (cursor !== "0" && rounds < 100);
  if (ids.size) await redis.sadd("photoslive:machines", ...ids);
  return [...ids];
}

async function superadminOverview(redis, request) {
  const auth = await authenticate(redis, request);
  if (auth?.role !== "superadmin") return json({ error: "Akses superadmin diperlukan" }, 403);
  const machineIds = await indexedMachineIds(redis);
  const machines = [];
  for (const id of machineIds) {
    const machine = await redis.get(machineKey(id));
    if (!machine) continue;
    const boothCode = normalizeCode(machine.boothCode || `pl-${id.replace(/^machine_/, "").slice(0, 8)}`);
    if (machine.boothCode !== boothCode) { machine.boothCode = boothCode; await redis.set(machineKey(id), machine); await redis.set(boothKey(boothCode), id); }
    machines.push(await resolveBooth(redis, boothCode));
  }
  const requestIds = await redis.smembers("photoslive:reset-requests");
  const resets = (await Promise.all(requestIds.map(id => redis.get(`photoslive:reset:${id}`)))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return json({ machines, resetRequests: resets });
}

async function toggleMachine(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (auth?.role !== "superadmin") return json({ error: "Akses superadmin diperlukan" }, 403);
  const machine = await redis.get(machineKey(String(payload.machineId || "")));
  if (!machine) return json({ error: "Mesin tidak ditemukan" }, 404);
  machine.accessEnabled = Boolean(payload.enabled);
  machine.updatedAt = now();
  await redis.set(machineKey(machine.id), machine);
  await appendAudit(redis, auth, machine.boothCode, machine.accessEnabled ? "booth.enabled" : "booth.disabled", machine.id);
  return json({ booth: await resolveBooth(redis, machine.boothCode) });
}

async function resolveResetRequest(redis, request, payload) {
  const auth = await authenticate(redis, request);
  if (auth?.role !== "superadmin") return json({ error: "Akses superadmin diperlukan" }, 403);
  const key = `photoslive:reset:${String(payload.requestId || "")}`;
  const reset = await redis.get(key);
  if (!reset) return json({ error: "Permintaan tidak ditemukan" }, 404);
  reset.status = "email_sent";
  reset.resolvedAt = now();
  reset.note = String(payload.note || "Email pemulihan dikirim manual").slice(0, 500);
  await redis.set(key, reset);
  await appendAudit(redis, auth, reset.boothCode, "password_recovery.resolved", reset.id);
  return json({ request: reset });
}

async function registerPhotoSession(redis, payload) {
  const booth = await resolveBooth(redis, payload.boothCode);
  if (!booth || booth.machineId !== payload.machineId || !booth.enabled) return json({ error: "Photobox tidak valid" }, 403);
  const shareCode = String(payload.shareCode || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const previous = await redis.get(publicSessionKey(booth.boothCode, shareCode));
  const record = { ...previous, boothCode: booth.boothCode, machineId: booth.machineId, shareCode, localSessionId: String(payload.localSessionId || previous?.localSessionId || ""), status: String(payload.status || previous?.status || "active"), frameId: String(payload.frameId || previous?.frameId || ""), photoSlots: Number(payload.photoSlots || previous?.photoSlots || 1), files: Array.isArray(previous?.files) ? previous.files : [], createdAt: payload.createdAt || previous?.createdAt || now(), expiresAt: payload.expiresAt || previous?.expiresAt || new Date(Date.now() + 86_400_000).toISOString(), updatedAt: now() };
  await redis.set(publicSessionKey(booth.boothCode, shareCode), record, { ex: 86_400 });
  return json({ session: record, url: `/${booth.boothCode}/sesi/${shareCode}` }, 201);
}

async function uploadPhotoSessionFile(redis, payload) {
  const boothCode = normalizeCode(payload.boothCode);
  const shareCode = String(payload.shareCode || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  const slotIndex = Math.max(1, Math.min(8, Number(payload.slotIndex || 1)));
  const record = await redis.get(publicSessionKey(boothCode, shareCode));
  if (!record || Date.parse(record.expiresAt) <= Date.now()) return json({ error: "Sesi tidak ditemukan atau sudah kedaluwarsa" }, 404);
  if (!payload.machineId || payload.machineId !== record.machineId) return json({ error: "Mesin pengunggah tidak sesuai dengan sesi" }, 403);
  const contentType = String(payload.contentType || "image/jpeg").toLowerCase();
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) return json({ error: "Format foto tidak didukung" }, 415);
  const bodyBase64 = String(payload.bodyBase64 || "");
  const byteLength = Math.floor(bodyBase64.length * 0.75);
  if (!bodyBase64 || byteLength > 1_800_000) return json({ error: "Foto cloud maksimal 1,8 MB" }, 413);
  const file = { id: `slot-${slotIndex}`, slotIndex, contentType, size: byteLength, url: `/api/platform?action=public_session_file&booth=${encodeURIComponent(boothCode)}&session=${encodeURIComponent(shareCode)}&slot=${slotIndex}`, uploadedAt: now() };
  await redis.set(publicSessionFileKey(boothCode, shareCode, slotIndex), { ...file, bodyBase64 }, { ex: 86_400 });
  record.files = [...(record.files || []).filter(item => Number(item.slotIndex) !== slotIndex), file].sort((a, b) => a.slotIndex - b.slotIndex);
  record.status = String(payload.status || record.status || "completed");
  record.updatedAt = now();
  await redis.set(publicSessionKey(boothCode, shareCode), record, { ex: 86_400 });
  return json({ file }, 201);
}

async function publicPhotoSessionFile(redis, payload) {
  const boothCode = normalizeCode(payload.booth);
  const shareCode = String(payload.session || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const slotIndex = Math.max(1, Math.min(8, Number(payload.slot || 1)));
  const record = await redis.get(publicSessionFileKey(boothCode, shareCode, slotIndex));
  if (!record?.bodyBase64) return json({ error: "Foto belum tersedia" }, 404);
  const bytes = Uint8Array.from(atob(record.bodyBase64), character => character.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": record.contentType, "content-length": String(bytes.byteLength), "cache-control": "private, max-age=3600" } });
}

async function publicPhotoSession(redis, payload) {
  const boothCode = normalizeCode(payload.booth);
  const shareCode = String(payload.session || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const record = await redis.get(publicSessionKey(boothCode, shareCode));
  if (!record || Date.parse(record.expiresAt) <= Date.now()) return json({ error: "Sesi tidak ditemukan atau sudah kedaluwarsa" }, 404);
  return json({ session: record, booth: await resolveBooth(redis, boothCode) });
}

async function cloudData(redis, request, payload) {
  const target = new URL(String(payload.path || "/"), "https://photoslive.local");
  const path = target.pathname;
  const booth = await resolveBooth(redis, payload.booth);
  if (!booth || !booth.enabled) return json({ error: "Photobox tidak ditemukan atau aksesnya dinonaktifkan" }, 404);

  if (request.method === "GET" && path === "/api/booth/config") {
    const [settings, assets] = await Promise.all([cloudSettings(redis, booth), cloudAssets(redis, booth.boothCode)]);
    return json({
      booth: settings.booth,
      appearance: settings.appearance,
      payment: settings.payment,
      devices: settings.devices,
      assets,
    });
  }

  if (request.method === "POST" && path === "/api/vouchers/redeem") {
    const code = voucherCode(payload.data?.code);
    if (!code) return json({ error: "Masukkan kode voucher" }, 400);
    const lockKey = `photoslive:booth:${booth.boothCode}:voucher-lock:${code}`;
    const locked = await redis.set(lockKey, "1", { nx: true, ex: 8 });
    if (!locked) return json({ error: "Voucher sedang diperiksa. Coba sekali lagi." }, 409);
    try {
      const record = await redis.get(voucherKey(booth.boothCode, code));
      if (!record || record.redeemedAt) return json({ error: "Voucher tidak ditemukan atau sudah dipakai" }, 404);
      const event = record.eventId ? await redis.get(voucherEventKey(booth.boothCode, record.eventId)) : null;
      if (eventExpired(event)) return json({ error: "Voucher event sudah kedaluwarsa" }, 410);
      record.redeemedAt = now();
      await redis.set(voucherKey(booth.boothCode, code), record);
      await redis.incr(voucherVersionKey(booth.boothCode));
      return json({ voucher: record });
    } finally {
      await redis.del(lockKey);
    }
  }

  if (request.method === "POST" && path === "/api/booth/client") {
    const id = String(payload.clientId || randomId("client")).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
    const record = { id, boothCode: booth.boothCode, ...payload.data, updatedAt: now() };
    await redis.set(`photoslive:booth:${booth.boothCode}:client:${id}`, record, { ex: 180 });
    await redis.sadd(`photoslive:booth:${booth.boothCode}:clients`, id);
    return json({ client: record }, 201);
  }

  const access = await requireBoothAdmin(redis, request, booth.boothCode);
  if (!access) return json({ error: "Login admin photobox diperlukan" }, 401);
  if (request.method !== "GET" && access.auth.role === "operator" && (path.startsWith("/api/settings/payment") || path.startsWith("/api/vouchers") || path.startsWith("/api/voucher-events"))) return json({ error: "Peran Operator tidak dapat mengubah pembayaran atau voucher" }, 403);

  if (request.method === "GET" && path === "/api/settings") return json(await cloudSettings(redis, booth));
  if (request.method === "PATCH" && (path === "/api/settings" || path.startsWith("/api/settings/"))) {
    const section = path === "/api/settings" ? "" : path.slice("/api/settings/".length);
    const current = await cloudSettings(redis, booth);
    if (section && !(section in DEFAULT_CLOUD_SETTINGS)) return json({ error: "Bagian pengaturan tidak dikenal" }, 404);
    const incoming = payload.data;
    const next = section ? { ...current, [section]: mergeObjects(current[section], incoming) } : mergeObjects(current, incoming);
    if (JSON.stringify(next).length > 500_000) return json({ error: "Pengaturan terlalu besar" }, 413);
    next.booth.name = String(next.booth.name || booth.name).slice(0, 80);
    next.booth.location = String(next.booth.location || "").slice(0, 120);
    await redis.set(cloudSettingsKey(booth.boothCode), next);
    await redis.incr(settingsVersionKey(booth.boothCode));
    const machine = await redis.get(machineKey(booth.machineId));
    if (machine) {
      machine.name = next.booth.name;
      machine.location = next.booth.location;
      machine.updatedAt = now();
      await redis.set(machineKey(machine.id), machine);
    }
    await appendAudit(redis, access.auth, booth.boothCode, "settings.updated", section || "all", { section: section || "all" });
    return json(next);
  }

  if (request.method === "GET" && path === "/api/vouchers") return json(await voucherPayload(redis, booth.boothCode));
  if (request.method === "GET" && path === "/api/vouchers/print") {
    const eventId = target.searchParams.get("eventId") || "";
    const records = await voucherRecords(redis, booth.boothCode);
    const selected = records.filter(record => !record.redeemedAt && (eventId ? record.eventId === eventId : !record.eventId));
    return json({ codes: selected.map(record => record.code), eventId });
  }
  if (request.method === "GET" && path === "/api/assets") return json(await cloudAssets(redis, booth.boothCode));
  if (request.method === "PUT" && path.startsWith("/api/assets/")) {
    const kind = path.slice("/api/assets/".length);
    if (!ASSET_KINDS.includes(kind)) return json({ error: "Jenis aset tidak dikenal" }, 404);
    const bodyBase64 = String(payload.data?.bodyBase64 || "");
    const byteLength = Math.floor(bodyBase64.length * 0.75);
    if (!bodyBase64 || byteLength > 2_000_000) return json({ error: "Ukuran aset cloud maksimal 2 MB" }, 413);
    const id = randomId("asset");
    const filename = String(payload.data?.filename || `${kind}.webp`).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
    const record = { id, boothCode: booth.boothCode, kind, name: filename, contentType: String(payload.data?.contentType || "application/octet-stream").slice(0, 100), size: byteLength, createdAt: now(), url: `/api/platform?action=cloud_asset&booth=${encodeURIComponent(booth.boothCode)}&id=${encodeURIComponent(id)}`, data: bodyBase64 };
    await redis.set(assetKey(booth.boothCode, id), record);
    await redis.sadd(assetIndexKey(booth.boothCode, kind), id);
    await appendAudit(redis, access.auth, booth.boothCode, "asset.created", id, { kind, filename, size: byteLength });
    const { data, ...asset } = record;
    return json({ asset }, 201);
  }
  if (request.method === "DELETE" && path.startsWith("/api/assets/")) {
    const parts = path.split("/").filter(Boolean);
    const kind = parts[2];
    const idOrName = decodeURIComponent(parts.slice(3).join("/"));
    if (!ASSET_KINDS.includes(kind) || !idOrName) return json({ error: "Aset tidak valid" }, 400);
    const ids = await redis.smembers(assetIndexKey(booth.boothCode, kind));
    let id = idOrName;
    let record = await redis.get(assetKey(booth.boothCode, id));
    if (!record) {
      for (const candidate of ids) {
        const item = await redis.get(assetKey(booth.boothCode, candidate));
        if (item?.name === idOrName || item?.url === idOrName) { id = candidate; record = item; break; }
      }
    }
    if (!record) return json({ error: "Aset tidak ditemukan" }, 404);
    await redis.del(assetKey(booth.boothCode, id));
    await redis.srem(assetIndexKey(booth.boothCode, kind), id);
    await appendAudit(redis, access.auth, booth.boothCode, "asset.deleted", id, { kind });
    return json({ deleted: true });
  }
  if (request.method === "POST" && path === "/api/vouchers") {
    const response = await createCloudVoucher(redis, booth.boothCode, payload.data || {});
    if (response.ok) await appendAudit(redis, access.auth, booth.boothCode, "voucher.created");
    return response;
  }
  if (request.method === "POST" && path === "/api/vouchers/generate") {
    const count = Math.max(1, Math.min(100, Number(payload.data?.count || 100)));
    const event = payload.data?.eventId ? await redis.get(voucherEventKey(booth.boothCode, String(payload.data.eventId))) : null;
    if (payload.data?.eventId && (!event || eventExpired(event))) return json({ error: "Event tidak ditemukan atau sudah berakhir" }, 404);
    const existing = new Set(await redis.smembers(voucherIndexKey(booth.boothCode)));
    const vouchers = [];
    for (let attempt = 0; vouchers.length < count && attempt < count * 3; attempt += 1) {
      const code = `${pairingVoucherPart()}-${pairingVoucherPart()}`;
      if (existing.has(code)) continue;
      existing.add(code);
      const record = { code, boothCode: booth.boothCode, eventId: event?.id || null, includesPrint: event ? Boolean(event.includesPrint) : true, createdAt: now(), redeemedAt: null };
      vouchers.push(record);
    }
    const pipeline = redis.pipeline();
    for (const record of vouchers) pipeline.set(voucherKey(booth.boothCode, record.code), record);
    if (vouchers.length) pipeline.sadd(voucherIndexKey(booth.boothCode), ...vouchers.map(record => record.code));
    await pipeline.exec();
    await redis.incr(voucherVersionKey(booth.boothCode));
    await appendAudit(redis, access.auth, booth.boothCode, "voucher.generated", event?.id || "general", { count: vouchers.length });
    return json({ created: vouchers.length, vouchers }, 201);
  }
  if (request.method === "DELETE" && path.startsWith("/api/vouchers/")) {
    const code = voucherCode(decodeURIComponent(path.slice("/api/vouchers/".length)));
    const record = code ? await redis.get(voucherKey(booth.boothCode, code)) : null;
    if (!record || record.redeemedAt) return json({ error: "Voucher tidak ditemukan atau sudah dipakai" }, 404);
    await redis.del(voucherKey(booth.boothCode, code));
    await redis.srem(voucherIndexKey(booth.boothCode), code);
    await redis.incr(voucherVersionKey(booth.boothCode));
    await appendAudit(redis, access.auth, booth.boothCode, "voucher.deleted", code);
    return json({ deleted: true });
  }
  if (request.method === "GET" && path === "/api/voucher-events") return json({ events: (await voucherPayload(redis, booth.boothCode)).events });
  if (request.method === "POST" && path === "/api/voucher-events") {
    const name = String(payload.data?.name || "").trim().slice(0, 100);
    const expiresAt = new Date(payload.data?.expiresAt || "");
    if (!name || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) return json({ error: "Nama dan waktu berakhir event wajib diisi" }, 400);
    const event = { id: randomId("event"), boothCode: booth.boothCode, name, expiresAt: expiresAt.toISOString(), includesPrint: Boolean(payload.data?.includesPrint), createdAt: now() };
    await redis.set(voucherEventKey(booth.boothCode, event.id), event);
    await redis.sadd(voucherEventIndexKey(booth.boothCode), event.id);
    await redis.incr(voucherVersionKey(booth.boothCode));
    await appendAudit(redis, access.auth, booth.boothCode, "voucher_event.created", event.id, { name: event.name, expiresAt: event.expiresAt });
    return json({ event }, 201);
  }
  return json({ error: "Endpoint cloud data tidak ditemukan" }, 404);
}

async function cloudAsset(redis, payload) {
  const booth = await resolveBooth(redis, payload.booth);
  if (!booth || !booth.enabled) return json({ error: "Photobox tidak ditemukan" }, 404);
  const record = await redis.get(assetKey(booth.boothCode, String(payload.id || "")));
  if (!record?.data) return json({ error: "Aset tidak ditemukan" }, 404);
  const bytes = Uint8Array.from(atob(record.data), character => character.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": record.contentType || "application/octet-stream", "content-length": String(bytes.byteLength), "cache-control": "public, max-age=31536000, immutable" } });
}

async function handler(request) {
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "health";
    const payload = { ...Object.fromEntries(url.searchParams), ...await requestBody(request) };
    if (action === "health") return json({ status: "ok", time: now() });
    const redis = getRedis();
    if (action === "resolve_booth" && request.method === "GET") { const booth = await resolveBooth(redis, payload.booth); return booth ? json({ booth }) : json({ error: "Photobox tidak ditemukan" }, 404); }
    if (action === "validate_setup" && request.method === "POST") return validateSetupCode(redis, payload);
    if (action === "setup" && request.method === "POST") return setupBooth(redis, payload);
    if (action === "login" && request.method === "POST") return login(redis, payload);
    if (action === "superadmin_login" && request.method === "POST") return superadminLogin(redis, payload);
    if (action === "superadmin_session" && request.method === "GET") return superadminSession(redis, request);
    if (action === "me" && request.method === "GET") return currentUser(redis, request);
    if (action === "users" && request.method === "GET") return listUsers(redis, request);
    if (action === "users" && request.method === "POST") return addUser(redis, request, payload);
    if (action === "profile" && request.method === "POST") return updateProfile(redis, request, payload);
    if (action === "audit" && request.method === "GET") return auditLog(redis, request, payload);
    if (action === "logout" && request.method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie });
    if (action === "forgot_password" && request.method === "POST") return forgotPassword(redis, payload);
    if (action === "superadmin_overview" && request.method === "GET") return superadminOverview(redis, request);
    if (action === "toggle_machine" && request.method === "POST") return toggleMachine(redis, request, payload);
    if (action === "resolve_reset" && request.method === "POST") return resolveResetRequest(redis, request, payload);
    if (action === "register_session" && request.method === "POST") return registerPhotoSession(redis, payload);
    if (action === "upload_session_file" && request.method === "POST") return uploadPhotoSessionFile(redis, payload);
    if (action === "public_session" && request.method === "GET") return publicPhotoSession(redis, payload);
    if (action === "public_session_file" && request.method === "GET") return publicPhotoSessionFile(redis, payload);
    if (action === "cloud_data") return cloudData(redis, request, payload);
    if (action === "cloud_asset" && request.method === "GET") return cloudAsset(redis, payload);
    return json({ error: "Endpoint tidak ditemukan" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Kesalahan server" }, 500);
  }
}

export default { fetch: handler };
