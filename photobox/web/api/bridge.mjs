import {
  getRedis,
  boothKey,
  jobKey,
  machineKey,
  now,
  pairingCode,
  queueKey,
  randomId,
  sha256,
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

function publicMachine(machine) {
  if (!machine) return null;
  const safe = { ...machine };
  delete safe.agentTokenHash;
  const lastSeen = safe.lastSeenAt ? Date.parse(safe.lastSeenAt) : 0;
  safe.online = Boolean(lastSeen && Date.now() - lastSeen < 90_000);
  return safe;
}

function persistentBoothCode(machine, preferred = "") {
  const clean = String(preferred || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  return clean || machine.boothCode || `pl-${String(machine.id).replace(/^machine_/, "").slice(0, 8)}`;
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
  };
  await redis.set(machineKey(machineId), machine);
  await redis.set(`photoslive:pairing:${code}`, machineId, { ex: 900 });
  return { machineId, agentToken, pairingCode: code, expiresInSeconds: 900 };
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
  machine.boothCode = persistentBoothCode(machine);
  await redis.set(machineKey(machine.id), machine);
  await redis.sadd("photoslive:machines", machine.id);
  if (machine.paired) await redis.set(boothKey(machine.boothCode), machine.id);
  return json({ ok: true, paired: machine.paired, boothCode: machine.boothCode, serverTime: now() });
}

async function enqueueJob(redis, payload) {
  const machineId = String(payload.machineId || "");
  const machine = await redis.get(machineKey(machineId));
  if (!machine?.paired) return json({ error: "Mesin belum dipasangkan" }, 409);
  if (machine.accessEnabled === false) return json({ error: "Akses photobox dinonaktifkan oleh superadmin" }, 403);
  const allowed = new Set(["devices.refresh", "camera.test", "camera.capture", "printer.test", "printer.print", "storage.cleanup", "service.restart", "controller.request"]);
  const type = String(payload.type || "");
  if (!allowed.has(type)) return json({ error: "Jenis job tidak didukung" }, 400);
  const id = randomId("job");
  const job = {
    id,
    machineId,
    type,
    payload: payload.payload && typeof payload.payload === "object" ? payload.payload : {},
    status: "queued",
    createdAt: now(),
    updatedAt: now(),
    attempts: 0,
  };
  await redis.set(jobKey(id), job, { ex: 86_400 });
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

async function jobStatus(redis, payload) {
  const machineId = String(payload.machineId || "");
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
    if (action === "machine_status" && request.method === "GET") return json({ machine: publicMachine(await redis.get(machineKey(String(payload.machineId || "")))) });
    if (action === "enqueue_job" && request.method === "POST") return enqueueJob(redis, payload);
    if (action === "claim_job" && request.method === "POST") return claimJob(redis, request, payload);
    if (action === "update_job" && request.method === "POST") return updateJob(redis, request, payload);
    if (action === "job_status" && request.method === "GET") return jobStatus(redis, payload);
    return json({ error: "Endpoint tidak ditemukan" }, 404);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Kesalahan server" }, 500);
  }
}

const bridgeFunction = { fetch: handler };
export default bridgeFunction;
