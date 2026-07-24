import { redactLogValue } from "./_observability.mjs";

const MODES = new Set(["off", "dual", "primary"]);
const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value, 500).replace(/\/+$/g, "");
const supabaseUrl = environment => baseUrl(environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL);

export function postgresMachineStatus(environment = process.env) {
  const requested = clean(environment.PHOTOSLIVE_POSTGRES_MACHINES, 20).toLowerCase() || "off";
  const mode = MODES.has(requested) ? requested : "off";
  const configured = Boolean(supabaseUrl(environment) && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 8));
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || 1_500);
  return {
    mode,
    primary: mode === "primary",
    enabled: mode !== "off",
    configured,
    timeoutMs: Number.isFinite(configuredTimeout) ? Math.max(100, Math.min(5_000, Math.round(configuredTimeout))) : 1_500,
    reason: mode === "off" ? "PostgreSQL machine registry belum diaktifkan" : configured ? "" : "Credential Supabase server belum lengkap",
  };
}

async function machineRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const status = postgresMachineStatus(environment);
  if (!status.enabled) return { ok: true, skipped: true, reason: status.reason };
  if (!status.configured) return { ok: false, skipped: true, status: 503, reason: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), status.timeoutMs);
  try {
    const response = await (options.fetchImplementation || fetch)(`${supabaseUrl(environment)}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: environment.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error(`PostgreSQL machine registry gagal (${response.status})`), { status: response.status });
    return { ok: true, skipped: false, payload: await response.json() };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `PostgreSQL machine registry timeout setelah ${status.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.machines.failed", operation: name, identity, reason })));
    return { ok: false, skipped: false, status: Number(error?.status || 503), reason };
  } finally {
    clearTimeout(timeout);
  }
}

function safeMachine(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const id = clean(payload.id, 160);
  const boothCode = clean(payload.boothCode, 64).toLowerCase();
  const agentTokenHash = clean(payload.agentTokenHash, 64).toLowerCase();
  if (!/^[A-Za-z0-9._:-]{3,160}$/.test(id) || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(boothCode)) return null;
  if (agentTokenHash && !/^[a-f0-9]{64}$/.test(agentTokenHash)) return null;
  return {
    ...payload,
    id,
    boothCode,
    ...(agentTokenHash ? { agentTokenHash } : {}),
    commandKey: clean(payload.commandKey, 160),
    pairingCode: clean(payload.pairingCode, 16).toUpperCase() || undefined,
    paired: payload.paired === true,
  };
}

function publicMachineInput(machine = {}) {
  return {
    ...machine,
    id: clean(machine.id, 160),
    boothCode: clean(machine.boothCode, 64).toLowerCase(),
    agentTokenHash: clean(machine.agentTokenHash, 64).toLowerCase(),
    commandKey: clean(machine.commandKey, 160),
    pairingCode: clean(machine.pairingCode, 16).toUpperCase(),
  };
}

export async function persistPostgresMachine(machine, options = {}) {
  const safe = publicMachineInput(machine);
  if (!safe.id || !safe.agentTokenHash || !safe.commandKey) throw new Error("Snapshot Agent PostgreSQL tidak valid");
  const result = await machineRpc("photoslive_persist_agent_machine", { p_machine: safe }, safe.id, options);
  if (!result.ok || result.skipped) return result;
  const stored = safeMachine(result.payload);
  return stored ? { ...result, machine: stored } : { ok: false, skipped: false, status: 503, reason: "Snapshot Agent PostgreSQL tidak valid" };
}

export async function readPostgresMachine(machineId, tokenHash, options = {}) {
  const result = await machineRpc("photoslive_agent_machine_snapshot", {
    p_machine_id: clean(machineId, 160),
    p_agent_token_hash: clean(tokenHash, 64).toLowerCase(),
  }, machineId, options);
  return result.ok ? safeMachine(result.payload) : null;
}

export async function createPostgresSetupCode(machine, tokenHash, pairingCode, options = {}) {
  const result = await machineRpc("photoslive_create_agent_setup_code", {
    p_machine_id: clean(machine.id, 160),
    p_agent_token_hash: clean(tokenHash || machine.agentTokenHash, 64).toLowerCase(),
    p_pairing_code: clean(pairingCode, 16).toUpperCase(),
    p_booth_code: clean(machine.boothCode, 64).toLowerCase(),
    p_snapshot: publicMachineInput({ ...machine, pairingCode }),
  }, machine.id, options);
  if (!result.ok || result.skipped) return result;
  const stored = safeMachine(result.payload);
  return stored ? { ...result, machine: stored } : { ok: false, skipped: false, status: 503, reason: "Setup code PostgreSQL tidak valid" };
}

export async function readPostgresPairing(code, options = {}) {
  const result = await machineRpc("photoslive_pairing_machine_snapshot", { p_pairing_code: clean(code, 16).toUpperCase() }, code, options);
  return result.ok ? safeMachine(result.payload) : null;
}

export async function markPostgresMachinePaired(code, machine, boothCode, options = {}) {
  const result = await machineRpc("photoslive_mark_agent_machine_paired", {
    p_pairing_code: clean(code, 16).toUpperCase(),
    p_booth_code: clean(boothCode, 64).toLowerCase(),
    p_snapshot: publicMachineInput({ ...machine, paired: true, boothCode, pairingCode: "" }),
  }, code, options);
  if (!result.ok || result.skipped) return result;
  const stored = safeMachine(result.payload);
  return stored ? { ...result, machine: stored } : { ok: false, skipped: false, status: 503, reason: "Pairing PostgreSQL tidak valid" };
}

export async function persistPostgresHeartbeat(machine, tokenHash, options = {}) {
  const result = await machineRpc("photoslive_update_agent_heartbeat", {
    p_machine_id: clean(machine.id, 160),
    p_agent_token_hash: clean(tokenHash || machine.agentTokenHash, 64).toLowerCase(),
    p_snapshot: publicMachineInput(machine),
  }, machine.id, options);
  if (!result.ok || result.skipped) return result;
  const stored = safeMachine(result.payload);
  return stored ? { ...result, machine: stored } : { ok: false, skipped: false, status: 503, reason: "Heartbeat PostgreSQL tidak valid" };
}
