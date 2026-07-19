import {
  authenticateWebSession,
  getRedis,
  boothKey,
  jobKey,
  machineKey,
  now,
  pairingCode,
  queueKey,
  randomId,
  sha256,
  verifyScopedToken,
} from "./_store.mjs";

const json = (response, status = 200) => new Response(JSON.stringify(response), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  },
});

async function body(request) {
  if (request.method === "GET") return {};
  return request.json().catch(() => ({}));
}

async function authenticateAgent(redis, request, machineId) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!machineId || !token) return null;
  const machine = await redis.get(machineKey(machineId));
  if (!machine || machine.agentTokenHash !== await sha256(token)) return null;
  return machine;
}

export const boothControllerPathAllowed = value => {
  const path = String(value || "").split("?")[0];
  return path === "/api/devices"
    || path === "/api/devices/camera/preview.jpg"
    || path === "/api/booth/sessions"
    || path === "/api/booth/qris"
    || path === "/api/booth/print"
    || /^\/api\/sessions\/[^/]+\/(capture|capture-upload|select|complete)$/.test(path);
};

async function authorizeOperator(redis, request, machineId, payload = null) {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const scoped = bearer ? await verifyScopedToken(bearer) : null;
  if (scoped?.scope === "booth.hardware" && scoped.machineId === machineId) {
    if (payload?.type && payload.type !== "controller.request") return null;
    if (payload?.type === "controller.request" && !boothControllerPathAllowed(payload.payload?.path)) return null;
    return { kind: "booth", ...scoped };
  }
  const session = await authenticateWebSession(redis, request);
  if (!session || (session.role !== "superadmin" && session.machineId !== machineId)) return null;
  return { kind: "admin", ...session };
}

function publicMachine(machine) {
  if (!machine) return null;
  const safe = { ...machine };
  delete safe.agentTokenHash;
  delete safe.commandKey;
  const lastSeen = safe.lastSeenAt ? Date.parse(safe.lastSeenAt) : 0;
  safe.online = Boolean(lastSeen && Date.now() - lastSeen < 90_000);
  safe.agentState = safe.online ? (safe.agentState || "running") : "offline";
  safe.controllerState = safe.online && safe.controller?.online ? "online" : "offline";
  safe.desiredState ||= "running";
  return safe;
}

function persistentBoothCode(machine, preferred = "") {
  const clean = String(preferred || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return clean || machine.boothCode || `pl-${String(machine.id).replace(/^machine_/, "").slice(0, 8)}`;
}

async function commandSignature(secret, job) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const value = JSON.stringify({ id: job.id, machineId: job.machineId, type: job.type, payload: job.payload, expiresAt: job.expiresAt });
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function createPairing(redis, payload) {
  const machineId = randomId("machine");
  const agentToken = payload.agentToken || randomId("agent");
  const code = pairingCode();
  const createdAt = now();
  const machine = {
    id: machineId,
    name: String(payload.name || "Photoslive Booth").slice(0, 80),
    platform: String(payload.platform || "Unknown").slice(0, 120),
    agentVersion: String(payload.agentVersion || "dev").slice(0, 40),
    status: "waiting_pairing",
    paired: false,
    pairingCode: code,
    boothCode: code.toLowerCase(),
    agentTokenHash: await sha256(agentToken),
    createdAt,
    lastSeenAt: null,
    telemetry: {},
    devices: [],
    agentState: "starting",
    controllerState: "offline",
    desiredState: "running",
    update: { status: "idle" },
    commandKey: randomId("command"),
  };
  await redis.set(machineKey(machineId), machine);
  await redis.set(`photoslive:pairing:${code}`, machineId, { ex: 900 });
  return { machineId, agentToken, commandKey: machine.commandKey, pairingCode: code, expiresInSeconds: 900 };
}

async function claimPairing(redis, payload) {
  const code = String(payload.code || "").trim().toUpperCase();
  const machineId = await redis.get(`photoslive:pairing:${code}`);
  if (!machineId) return json({ error: "Kode pairing tidak ditemukan atau sudah kedaluwarsa" }, 404);
  const machine = await redis.get(machineKey(machineId));
  if (!machine) return json({ error: "Data mesin tidak ditemukan" }, 404);
  machine.paired = true;
  machine.status = "offline";
  machine.name = String(payload.name || machine.name).slice(0, 80);
  machine.location = String(payload.location || "").slice(0, 120);
  machine.pairedAt = now();
  machine.boothCode = persistentBoothCode(machine, machine.boothCode || code);
  delete machine.pairingCode;
  await redis.set(machineKey(machineId), machine);
  await redis.set(boothKey(machine.boothCode), machineId);
  await redis.del(`photoslive:pairing:${code}`);
  return json({ machine: publicMachine(machine) });
}


async function createSetupCode(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const code = pairingCode();
  machine.pairingCode = code;
  machine.boothCode = persistentBoothCode(machine);
  await redis.set(machineKey(machine.id), machine);
  await redis.set(`photoslive:pairing:${code}`, machine.id, { ex: 900 });
  await redis.set(boothKey(machine.boothCode), machine.id);
  // Keep the short code useful after onboarding as an alias to the canonical
  // photobox. The expiring pairing key still controls whether setup is valid.
  await redis.set(boothKey(code), machine.id);
  return json({ pairingCode: code, boothCode: machine.boothCode, expiresInSeconds: 900 });
}

async function heartbeat(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  machine.lastSeenAt = now();
  machine.status = machine.paired ? "online" : "waiting_pairing";
  machine.agentVersion = String(payload.agentVersion || machine.agentVersion).slice(0, 40);
  machine.platform = String(payload.platform || machine.platform).slice(0, 120);
  machine.telemetry = payload.telemetry && typeof payload.telemetry === "object" ? payload.telemetry : {};
  machine.devices = Array.isArray(payload.devices) ? payload.devices.slice(0, 24) : [];
  machine.controller = payload.controller && typeof payload.controller === "object" ? payload.controller : {};
  machine.agentState = payload.agentState === "paused" ? "paused" : "running";
  machine.controllerState = machine.controller?.online ? "online" : "offline";
  machine.desiredState ||= "running";
  machine.update = payload.update && typeof payload.update === "object" ? payload.update : (machine.update || { status: "idle" });
  machine.commandKey ||= randomId("command");
  machine.boothCode = persistentBoothCode(machine);
  await redis.set(machineKey(machine.id), machine);
  await redis.sadd("photoslive:machines", machine.id);
  if (machine.paired) await redis.set(boothKey(machine.boothCode), machine.id);
  const voucherVersion = machine.paired ? Number(await redis.get(`photoslive:booth:${machine.boothCode}:voucher-version`) || 0) : 0;
  const settingsVersion = machine.paired ? Number(await redis.get(`photoslive:booth:${machine.boothCode}:settings-version`) || 0) : 0;
  return json({ ok: true, paired: machine.paired, boothCode: machine.boothCode, desiredState: machine.desiredState, commandKey: machine.commandKey, voucherVersion, settingsVersion, serverTime: now() });
}

async function settingsSnapshot(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  return json({
    boothCode,
    version: Number(await redis.get(`photoslive:booth:${boothCode}:settings-version`) || 0),
    settings: await redis.get(`photoslive:booth:${boothCode}:settings`) || null,
  });
}

async function voucherSnapshot(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  const codes = await redis.smembers(`photoslive:booth:${boothCode}:vouchers`);
  const eventIds = await redis.smembers(`photoslive:booth:${boothCode}:voucher-events`);
  const vouchers = (await Promise.all(codes.slice(0, 5000).map(code => redis.get(`photoslive:booth:${boothCode}:voucher:${code}`)))).filter(Boolean);
  const events = (await Promise.all(eventIds.slice(0, 500).map(id => redis.get(`photoslive:booth:${boothCode}:voucher-event:${id}`)))).filter(Boolean);
  return json({ boothCode, version: Number(await redis.get(`photoslive:booth:${boothCode}:voucher-version`) || 0), vouchers, events });
}

async function syncVoucherRedemptions(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine?.paired) return json({ error: "Credential Agent tidak valid" }, 401);
  const boothCode = persistentBoothCode(machine);
  let updated = 0;
  for (const item of (Array.isArray(payload.redemptions) ? payload.redemptions : []).slice(0, 500)) {
    const code = String(item.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
    const record = code ? await redis.get(`photoslive:booth:${boothCode}:voucher:${code}`) : null;
    if (!record || record.redeemedAt) continue;
    record.redeemedAt = item.redeemedAt || now();
    record.redeemedOffline = true;
    await redis.set(`photoslive:booth:${boothCode}:voucher:${code}`, record);
    updated += 1;
  }
  if (updated) await redis.incr(`photoslive:booth:${boothCode}:voucher-version`);
  return json({ updated });
}

async function enqueueJob(redis, request, payload) {
  const machineId = String(payload.machineId || "");
  if (!await authorizeOperator(redis, request, machineId, payload)) return json({ error: "Akses hardware photobox tidak valid" }, 401);
  const machine = await redis.get(machineKey(machineId));
  if (!machine?.paired) return json({ error: "Mesin belum dipasangkan" }, 409);
  if (machine.accessEnabled === false) return json({ error: "Akses photobox dinonaktifkan oleh superadmin" }, 403);
  const rateKey = `photoslive:machine:${machineId}:enqueue-rate:${Math.floor(Date.now() / 10_000)}`;
  const requestCount = Number(await redis.incr(rateKey));
  if (requestCount === 1) await redis.expire(rateKey, 15);
  if (requestCount > 40) return json({ error: "Terlalu banyak perintah. Tunggu beberapa detik." }, 429);
  const allowed = new Set(["devices.refresh", "camera.test", "camera.capture", "printer.test", "printer.print", "storage.cleanup", "service.restart", "controller.request"]);
  const type = String(payload.type || "");
  if (!allowed.has(type)) return json({ error: "Jenis job tidak didukung" }, 400);
  const idempotencyKey = String(payload.idempotencyKey || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 120);
  if (idempotencyKey) {
    const existingId = await redis.get(`photoslive:machine:${machineId}:job-idempotency:${idempotencyKey}`);
    const existing = existingId ? await redis.get(jobKey(existingId)) : null;
    if (existing) return json({ job: existing, reused: true });
  }
  const id = randomId("job");
  const ttlSeconds = Math.max(30, Math.min(900, Number(payload.ttlSeconds || 120)));
  const job = {
    id,
    machineId,
    type,
    payload: payload.payload && typeof payload.payload === "object" ? payload.payload : {},
    status: "queued",
    createdAt: now(),
    updatedAt: now(),
    attempts: 0,
    idempotencyKey: idempotencyKey || null,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
  job.signature = await commandSignature(machine.commandKey || "", job);
  await redis.set(jobKey(id), job, { ex: 86_400 });
  if (idempotencyKey) await redis.set(`photoslive:machine:${machineId}:job-idempotency:${idempotencyKey}`, id, { ex: ttlSeconds });
  await redis.rpush(queueKey(machineId), id);
  return json({ job }, 201);
}

async function claimJob(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const id = await redis.lpop(queueKey(machine.id));
  if (!id) return json({ job: null });
  const job = await redis.get(jobKey(id));
  if (!job) return json({ job: null });
  if (job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) {
    job.status = "expired";
    job.error = "Command kedaluwarsa sebelum dijalankan";
    job.updatedAt = now();
    await redis.set(jobKey(id), job, { ex: 86_400 });
    return claimJob(redis, request, payload);
  }
  job.status = "claimed";
  job.claimedAt = now();
  job.updatedAt = now();
  job.attempts = Number(job.attempts || 0) + 1;
  await redis.set(jobKey(id), job, { ex: 86_400 });
  return json({ job });
}

async function updateJob(redis, request, payload) {
  const machine = await authenticateAgent(redis, request, payload.machineId);
  if (!machine) return json({ error: "Credential Agent tidak valid" }, 401);
  const job = await redis.get(jobKey(String(payload.jobId || "")));
  if (!job || job.machineId !== machine.id) return json({ error: "Job tidak ditemukan" }, 404);
  const status = String(payload.status || "");
  if (!["running", "completed", "failed"].includes(status)) return json({ error: "Status job tidak valid" }, 400);
  job.status = status;
  job.updatedAt = now();
  job.result = payload.result && typeof payload.result === "object" ? payload.result : {};
  job.error = status === "failed" ? String(payload.error || "Job gagal").slice(0, 500) : null;
  await redis.set(jobKey(job.id), job, { ex: 86_400 });
  return json({ job });
}

async function jobStatus(redis, request, payload) {
  const machineId = String(payload.machineId || "");
  if (!await authorizeOperator(redis, request, machineId)) return json({ error: "Akses hardware photobox tidak valid" }, 401);
  const job = await redis.get(jobKey(String(payload.jobId || "")));
  if (!job || job.machineId !== machineId) return json({ error: "Job tidak ditemukan" }, 404);
  return json({ job });
}

async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS" } });
  try {
    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "health";
    const payload = { ...Object.fromEntries(url.searchParams), ...await body(request) };
    if (action === "health") return json({ status: "ok", storage: "upstash", time: now() });
    const redis = getRedis();
    if (action === "create_pairing" && request.method === "POST") return json(await createPairing(redis, payload), 201);
    if (action === "claim_pairing" && request.method === "POST") return claimPairing(redis, payload);
    if (action === "create_setup_code" && request.method === "POST") return createSetupCode(redis, request, payload);
    if (action === "heartbeat" && request.method === "POST") return heartbeat(redis, request, payload);
    if (action === "settings_snapshot" && request.method === "POST") return settingsSnapshot(redis, request, payload);
    if (action === "voucher_snapshot" && request.method === "POST") return voucherSnapshot(redis, request, payload);
    if (action === "sync_voucher_redemptions" && request.method === "POST") return syncVoucherRedemptions(redis, request, payload);
    if (action === "machine_status" && request.method === "GET") {
      const machineId = String(payload.machineId || "");
      if (!await authorizeOperator(redis, request, machineId)) return json({ error: "Login admin diperlukan" }, 401);
      return json({ machine: publicMachine(await redis.get(machineKey(machineId))) });
    }
    if (action === "enqueue_job" && request.method === "POST") return enqueueJob(redis, request, payload);
    if (action === "claim_job" && request.method === "POST") return claimJob(redis, request, payload);
    if (action === "update_job" && request.method === "POST") return updateJob(redis, request, payload);
    if (action === "job_status" && request.method === "GET") return jobStatus(redis, request, payload);
    return json({ error: "Endpoint tidak ditemukan" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Kesalahan server" }, 500);
  }
}

const bridgeFunction = { fetch: handler };
export default bridgeFunction;
