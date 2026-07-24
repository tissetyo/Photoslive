import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { currentUser, login, setupBooth } from "../api/platform.mjs";
import { createPostgresSetupCode } from "../api/_postgres_machines.mjs";

process.env.SESSION_SECRET ||= "photoslive-test-session-secret-32-characters";

class QuotaRedis {
  #error() {
    return new Error("Command failed: ERR max requests limit exceeded. Limit: 500000, Usage: 500000.");
  }
  async get() { throw this.#error(); }
  async set() { throw this.#error(); }
  async del() { throw this.#error(); }
  async sadd() { throw this.#error(); }
  async smembers() { throw this.#error(); }
  async srem() { throw this.#error(); }
  multi() { return this.#transaction(); }
  pipeline() { return this.#transaction(); }
  #transaction() {
    return {
      set: () => this.#transaction(),
      sadd: () => this.#transaction(),
      exec: async () => { throw this.#error(); },
    };
  }
}

const environment = {
  PHOTOSLIVE_POSTGRES_DIRECTORY: "primary",
  PHOTOSLIVE_POSTGRES_MACHINES: "primary",
  PHOTOSLIVE_POSTGRES_USERS: "primary",
  PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "800",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-service-role-secret",
};

const machine = {
  id: "machine_quota_test",
  boothCode: "quota-booth",
  pairingCode: "QWER-2345",
  paired: false,
  name: "Quota Booth",
  location: "Lab",
  lastSeenAt: new Date().toISOString(),
};

const directory = {
  boothCode: "quota-booth",
  machineId: "machine_quota_test",
  organizationId: "6c0ee78a-42ce-4ca7-9bb5-af4783334d7d",
  organizationLegacyId: "organization-quota-booth",
  name: "Quota Booth",
  location: "Lab",
  accessEnabled: true,
  updatedAt: new Date().toISOString(),
};

let owner = null;

function responseForRpc(url, body) {
  if (url.endsWith("/photoslive_pairing_machine_snapshot")) return machine.pairingCode === body.p_pairing_code ? machine : null;
  if (url.endsWith("/photoslive_mark_agent_machine_paired")) {
    machine.paired = true;
    machine.pairingCode = undefined;
    return { ...machine, boothCode: body.p_booth_code };
  }
  if (url.endsWith("/photoslive_persist_booth_directory")) return directory;
  if (url.endsWith("/photoslive_booth_directory_snapshot")) return body.p_booth_code === directory.boothCode ? directory : null;
  if (url.endsWith("/photoslive_admin_user_by_email")) return owner?.email === body.p_email ? owner : null;
  if (url.endsWith("/photoslive_admin_user_by_id")) return owner?.id === body.p_user_id ? owner : null;
  if (url.endsWith("/photoslive_admin_users_for_booth")) return owner?.boothCode === body.p_booth_code ? [owner] : [];
  if (url.endsWith("/photoslive_persist_admin_user")) {
    owner = { ...body.p_user, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return owner;
  }
  throw new Error(`Unhandled RPC ${url}`);
}

test("setup and remote login survive exhausted Upstash when Supabase is primary", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment);
  owner = null;
  machine.paired = false;
  machine.pairingCode = "QWER-2345";
  globalThis.fetch = async (url, options) => {
    const payload = responseForRpc(String(url), JSON.parse(options.body));
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const redis = new QuotaRedis();
    const setupResponse = await setupBooth(redis, {
      pairingCode: "QWER-2345",
      email: "owner@photoslive.test",
      password: "correct-password",
      pin: "123456",
      confirmPin: "123456",
      name: "Quota Booth",
      location: "Lab",
    });
    assert.equal(setupResponse.status, 201);
    assert.match(setupResponse.headers.get("set-cookie"), /__Host-photoslive_session=st\./);

    const loginResponse = await login(redis, {
      boothCode: "quota-booth",
      email: "owner@photoslive.test",
      password: "correct-password",
    });
    assert.equal(loginResponse.status, 200);
    const cookie = loginResponse.headers.get("set-cookie");
    assert.match(cookie, /__Host-photoslive_session=st\./);

    const meResponse = await currentUser(redis, new Request("https://photoslive.test/api/platform?action=me", {
      headers: { cookie },
    }));
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.equal(me.user.email, "owner@photoslive.test");
    assert.equal(me.booth.boothCode, "quota-booth");
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("admin identity migration is private and service-role-only", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260724123000_booth_admin_identities.sql", import.meta.url), "utf8");
  assert.match(sql, /private\.booth_admin_identities/);
  assert.match(sql, /revoke all on table private\.booth_admin_identities from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.photoslive_persist_admin_user[\s\S]+authenticated/);
  assert.match(sql, /grant execute on function public\.photoslive_persist_admin_user[\s\S]+service_role/);
  assert.doesNotMatch(sql, /grant execute[\s\S]+photoslive_persist_admin_user[\s\S]+to authenticated/);
});

test("setup code creation upserts machine before issuing code", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url: String(url), payload });
    if (String(url).endsWith("/photoslive_persist_agent_machine")) {
      return new Response(JSON.stringify({
        id: payload.p_machine.id,
        boothCode: payload.p_machine.boothCode,
        paired: false,
        agentTokenHash: payload.p_machine.agentTokenHash,
        commandKey: payload.p_machine.commandKey,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/photoslive_create_agent_setup_code")) {
      return new Response(JSON.stringify({
        id: payload.p_machine_id,
        boothCode: payload.p_booth_code,
        pairingCode: payload.p_pairing_code,
        paired: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unhandled RPC ${url}`);
  };
  try {
    const result = await createPostgresSetupCode({
      id: "machine_existing_legacy",
      boothCode: "pl-legacy",
      commandKey: "command_legacy",
    }, "a".repeat(64), "ABCD-2345");
    assert.equal(result.ok, true);
    assert.equal(result.machine.pairingCode, "ABCD-2345");
    assert.match(calls[0].url, /photoslive_persist_agent_machine$/);
    assert.match(calls[1].url, /photoslive_create_agent_setup_code$/);
    assert.equal(calls[0].payload.p_machine.agentTokenHash, "a".repeat(64));
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
