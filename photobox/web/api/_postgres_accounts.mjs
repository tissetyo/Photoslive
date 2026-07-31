import { redactLogValue } from "./_observability.mjs";

const clean = (value, maximum = 160) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value, 500).replace(/\/+$/g, "");
const supabaseUrl = environment => baseUrl(environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL);
const uuidOrNull = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean(value))
  ? clean(value).toLowerCase()
  : null;

export function postgresAccountsStatus(environment = process.env) {
  const configured = Boolean(
    supabaseUrl(environment)
      && clean(environment.SUPABASE_SERVICE_ROLE_KEY, 2_000),
  );
  const configuredTimeout = Number(environment.PHOTOSLIVE_POSTGRES_TIMEOUT_MS || 2_500);
  return {
    configured,
    primary: configured && String(environment.PHOTOSLIVE_POSTGRES_ACCOUNTS || "primary").toLowerCase() !== "off",
    timeoutMs: Number.isFinite(configuredTimeout)
      ? Math.max(250, Math.min(8_000, Math.round(configuredTimeout)))
      : 2_500,
    reason: configured ? "" : "Credential PostgreSQL/Supabase server belum lengkap",
  };
}

async function accountRpc(name, body, identity, options = {}) {
  const environment = options.environment || process.env;
  const status = postgresAccountsStatus(environment);
  if (!status.primary) return { ok: false, status: 503, reason: status.reason || "Account store dinonaktifkan" };
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
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = clean(payload?.message || payload?.error || "Operasi akun PostgreSQL gagal", 300);
      return { ok: false, status: response.status, reason: message, code: clean(payload?.code, 80) };
    }
    return { ok: true, status: response.status, payload };
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? `Account store timeout setelah ${status.timeoutMs} ms`
      : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "postgres.accounts.failed", operation: name, identity, reason })));
    return { ok: false, status: Number(error?.status || 503), reason };
  } finally {
    clearTimeout(timeout);
  }
}

function safeAccount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const userId = clean(value.userId || value.user_id);
  const organizationId = clean(value.organizationId || value.organization_id);
  if (!userId || !organizationId) return null;
  return {
    userId,
    email: clean(value.email, 160).toLowerCase(),
    displayName: clean(value.displayName || value.display_name || "Pemilik", 120),
    adminCode: clean(value.adminCode || value.admin_code, 20).toUpperCase(),
    organizationId,
    organizationCode: clean(value.organizationCode || value.organization_code, 20).toUpperCase(),
    organizationName: clean(value.organizationName || value.organization_name, 120),
    role: clean(value.role || "owner", 40).toLowerCase(),
    machines: Array.isArray(value.machines) ? value.machines : [],
    booths: Array.isArray(value.booths) ? value.booths : [],
  };
}

export async function bootstrapPostgresAccount(user, options = {}) {
  const userId = clean(user?.id);
  const email = clean(user?.email, 160).toLowerCase();
  if (!userId || !email) return { ok: false, status: 400, reason: "Identitas Supabase tidak valid" };
  const result = await accountRpc("photoslive_bootstrap_account", {
    p_user_id: userId,
    p_email: email,
    p_display_name: clean(user?.user_metadata?.display_name || user?.displayName || "Pemilik", 120),
    p_idempotency_key: clean(options.idempotencyKey || `account:${userId}`, 160),
  }, userId, options);
  const account = result.ok ? safeAccount(result.payload) : null;
  return account ? { ...result, account } : result.ok
    ? { ok: false, status: 503, reason: "Snapshot akun PostgreSQL tidak valid" }
    : result;
}

export async function readPostgresAccount(userId, options = {}) {
  const result = await accountRpc("photoslive_account_snapshot", { p_user_id: clean(userId) }, userId, options);
  return result.ok ? safeAccount(result.payload) : null;
}

export async function createPostgresMachineClaim(input = {}, options = {}) {
  return accountRpc("photoslive_create_machine_claim", {
    p_machine_id: clean(input.machineId),
    p_token_hash: clean(input.tokenHash, 64).toLowerCase(),
    p_code_hash: clean(input.codeHash, 64).toLowerCase(),
    p_expires_at: input.expiresAt,
    p_snapshot: input.snapshot && typeof input.snapshot === "object" ? input.snapshot : {},
    p_idempotency_key: clean(input.idempotencyKey, 160),
  }, input.machineId, options);
}

export async function registerPostgresBrowserInstallation(input = {}, options = {}) {
  return accountRpc("photoslive_register_browser_installation", {
    p_machine_id: clean(input.machineId),
    p_credential_hash: clean(input.credentialHash, 64).toLowerCase(),
    p_capability_snapshot: input.capabilities && typeof input.capabilities === "object"
      ? input.capabilities
      : {},
  }, input.machineId, options);
}

export async function bootstrapPostgresBrowserStation(input = {}, options = {}) {
  return accountRpc("photoslive_station_bootstrap", {
    p_machine_id: clean(input.machineId),
    p_credential_hash: clean(input.credentialHash, 64).toLowerCase(),
  }, input.machineId, options);
}

export async function updatePostgresBrowserCapabilities(input = {}, options = {}) {
  return accountRpc("photoslive_update_station_capabilities", {
    p_machine_id: clean(input.machineId),
    p_credential_hash: clean(input.credentialHash, 64).toLowerCase(),
    p_capability_snapshot: input.capabilities && typeof input.capabilities === "object"
      ? input.capabilities
      : {},
  }, input.machineId, options);
}

export async function readPostgresMachineRuntime(machineId, options = {}) {
  const result = await accountRpc("photoslive_machine_runtime", {
    p_machine_id: clean(machineId),
  }, machineId, options);
  return result.ok && result.payload && typeof result.payload === "object"
    ? result.payload
    : null;
}

export async function setPostgresHelperDesiredState(input = {}, options = {}) {
  const result = await accountRpc("photoslive_set_helper_desired_state", {
    p_machine_id: clean(input.machineId),
    p_organization_id: clean(input.organizationId),
    p_enabled: input.enabled === true,
  }, input.machineId, options);
  return result.ok && result.payload && typeof result.payload === "object"
    ? result.payload
    : null;
}

export async function createPostgresHelperBootstrap(input = {}, options = {}) {
  return accountRpc("photoslive_create_helper_bootstrap", {
    p_machine_id: clean(input.machineId),
    p_organization_id: clean(input.organizationId),
    p_token_hash: clean(input.tokenHash, 64).toLowerCase(),
    p_expires_at: input.expiresAt,
  }, input.machineId, options);
}

export async function activatePostgresHelper(input = {}, options = {}) {
  return accountRpc("photoslive_activate_helper", {
    p_token_hash: clean(input.tokenHash, 64).toLowerCase(),
    p_agent_token_hash: clean(input.agentTokenHash, 64).toLowerCase(),
    p_command_key: clean(input.commandKey, 160),
    p_platform: clean(input.platform, 240),
    p_agent_version: clean(input.agentVersion, 40),
  }, input.tokenHash, options);
}

export async function updatePostgresHelperRuntime(input = {}, options = {}) {
  const result = await accountRpc("photoslive_update_helper_runtime", {
    p_machine_id: clean(input.machineId),
    p_actual_state: clean(input.actualState || "online", 40),
    p_capability_snapshot: input.capabilities && typeof input.capabilities === "object"
      ? input.capabilities
      : {},
  }, input.machineId, options);
  return result.ok && result.payload && typeof result.payload === "object"
    ? result.payload
    : null;
}

export async function inspectPostgresMachineClaim(input = {}, options = {}) {
  const result = await accountRpc("photoslive_machine_claim_snapshot", {
    p_token_hash: clean(input.tokenHash, 64).toLowerCase() || null,
    p_code_hash: clean(input.codeHash, 64).toLowerCase() || null,
  }, input.tokenHash || input.codeHash, options);
  return result.ok ? result.payload : null;
}

export async function claimPostgresMachine(input = {}, options = {}) {
  return accountRpc("photoslive_claim_machine", {
    p_user_id: clean(input.userId),
    p_organization_id: clean(input.organizationId),
    p_token_hash: clean(input.tokenHash, 64).toLowerCase() || null,
    p_code_hash: clean(input.codeHash, 64).toLowerCase() || null,
    p_booth_name: clean(input.name || "Photoslive Booth", 120),
    p_location: clean(input.location, 120),
    p_idempotency_key: clean(input.idempotencyKey, 160),
    p_correlation_id: clean(input.correlationId || crypto.randomUUID(), 160),
  }, input.userId, options);
}

export async function revokePostgresMachine(input = {}, options = {}) {
  return accountRpc("photoslive_revoke_machine_pairing", {
    p_machine_id: clean(input.machineId),
    p_actor_id: uuidOrNull(input.actorId),
    p_reason: clean(input.reason || "revoked", 240),
    p_idempotency_key: clean(input.idempotencyKey, 160),
    p_correlation_id: clean(input.correlationId || crypto.randomUUID(), 160),
  }, input.machineId, options);
}

export async function reassignPostgresMachine(input = {}, options = {}) {
  return accountRpc("photoslive_reassign_machine", {
    p_machine_id: clean(input.machineId),
    p_target_organization_id: clean(input.targetOrganizationId),
    p_actor_id: uuidOrNull(input.actorId),
    p_reason: clean(input.reason || "reassigned", 240),
    p_idempotency_key: clean(input.idempotencyKey, 160),
    p_correlation_id: clean(input.correlationId || crypto.randomUUID(), 160),
  }, input.machineId, options);
}

export async function listPostgresFleet(options = {}) {
  const result = await accountRpc("photoslive_machine_fleet", {}, "fleet", options);
  if (options.detailed) return result;
  return result.ok && Array.isArray(result.payload) ? result.payload : [];
}

export async function listPostgresPairingHistory(limit = 100, options = {}) {
  const result = await accountRpc("photoslive_pairing_history", { p_limit: Math.max(1, Math.min(500, Number(limit) || 100)) }, "history", options);
  if (options.detailed) return result;
  return result.ok && Array.isArray(result.payload) ? result.payload : [];
}
