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
  const booth = await resolveBooth(redis, lookupCode);
  if (!booth || !booth.enabled) return json({ error: "Photobox tidak ditemukan atau aksesnya dinonaktifkan" }, 404);
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
  return json({ request: reset });
}

async function registerPhotoSession(redis, payload) {
  const booth = await resolveBooth(redis, payload.boothCode);
  if (!booth || booth.machineId !== payload.machineId || !booth.enabled) return json({ error: "Photobox tidak valid" }, 403);
  const shareCode = String(payload.shareCode || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  if (!shareCode) return json({ error: "Kode sesi tidak valid" }, 400);
  const record = { boothCode: booth.boothCode, machineId: booth.machineId, shareCode, localSessionId: String(payload.localSessionId || ""), status: String(payload.status || "active"), frameId: String(payload.frameId || ""), photoSlots: Number(payload.photoSlots || 1), createdAt: payload.createdAt || now(), expiresAt: payload.expiresAt || new Date(Date.now() + 86_400_000).toISOString(), updatedAt: now() };
  await redis.set(`photoslive:public-session:${booth.boothCode}:${shareCode}`, record, { ex: 86_400 });
  return json({ session: record, url: `/${booth.boothCode}/${shareCode}` }, 201);
}

async function publicPhotoSession(redis, payload) {
  const boothCode = normalizeCode(payload.booth);
  const shareCode = String(payload.session || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const record = await redis.get(`photoslive:public-session:${boothCode}:${shareCode}`);
  if (!record || Date.parse(record.expiresAt) <= Date.now()) return json({ error: "Sesi tidak ditemukan atau sudah kedaluwarsa" }, 404);
  return json({ session: record, booth: await resolveBooth(redis, boothCode) });
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
    if (action === "me" && request.method === "GET") return currentUser(redis, request);
    if (action === "users" && request.method === "GET") return listUsers(redis, request);
    if (action === "users" && request.method === "POST") return addUser(redis, request, payload);
    if (action === "profile" && request.method === "POST") return updateProfile(redis, request, payload);
    if (action === "logout" && request.method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie });
    if (action === "forgot_password" && request.method === "POST") return forgotPassword(redis, payload);
    if (action === "superadmin_overview" && request.method === "GET") return superadminOverview(redis, request);
    if (action === "toggle_machine" && request.method === "POST") return toggleMachine(redis, request, payload);
    if (action === "resolve_reset" && request.method === "POST") return resolveResetRequest(redis, request, payload);
    if (action === "register_session" && request.method === "POST") return registerPhotoSession(redis, payload);
    if (action === "public_session" && request.method === "GET") return publicPhotoSession(redis, payload);
    return json({ error: "Endpoint tidak ditemukan" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Kesalahan server" }, 500);
  }
}

export default { fetch: handler };
