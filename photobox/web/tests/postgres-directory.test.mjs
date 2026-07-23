import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { persistPostgresBoothDirectory, postgresDirectoryStatus, readPostgresBoothDirectory, updatePostgresBoothAccess } from "../api/_postgres_directory.mjs";
import { resolveBooth, setupBooth } from "../api/platform.mjs";
import { boothKey, machineKey } from "../api/_store.mjs";

const environment = {
  PHOTOSLIVE_POSTGRES_DIRECTORY: "primary",
  PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "800",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-service-role-secret",
};

const directory = {
  boothCode: "booth-one",
  machineId: "machine_one",
  organizationId: "6c0ee78a-42ce-4ca7-9bb5-af4783334d7d",
  organizationLegacyId: "organization-booth-one",
  name: "Booth One",
  location: "Main Hall",
  accessEnabled: true,
  updatedAt: "2026-07-22T04:00:00.000Z",
};

class FakeRedis {
  constructor() { this.values = new Map(); this.sets = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options?.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }
  async del(...keys) { keys.forEach(key => this.values.delete(key)); return keys.length; }
  async sadd(key, ...values) { const target = this.sets.get(key) || new Set(); values.forEach(value => target.add(value)); this.sets.set(key, target); return values.length; }
  async smembers(key) { return [...(this.sets.get(key) || new Set())]; }
  async srem(key, ...values) { const target = this.sets.get(key) || new Set(); values.forEach(value => target.delete(value)); return values.length; }
  multi() { return this.#transaction(); }
  pipeline() { return this.#transaction(); }
  #transaction() {
    const operations = [];
    const transaction = {
      set: (...args) => { operations.push(["set", args]); return transaction; },
      sadd: (...args) => { operations.push(["sadd", args]); return transaction; },
      exec: async () => Promise.all(operations.map(async ([name, args]) => ({ result: await this[name](...args) }))),
    };
    return transaction;
  }
}

test("PostgreSQL directory mode is explicit and bounded", () => {
  assert.equal(postgresDirectoryStatus({ ...environment, PHOTOSLIVE_POSTGRES_DIRECTORY: "off" }).enabled, false);
  assert.equal(postgresDirectoryStatus(environment).primary, true);
  assert.equal(postgresDirectoryStatus({ ...environment, PHOTOSLIVE_POSTGRES_DIRECTORY: "unknown" }).mode, "off");
  assert.equal(postgresDirectoryStatus({ ...environment, PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "999999" }).timeoutMs, 5_000);
});

test("directory persistence uses one service-role RPC and returns a safe projection", async () => {
  let request;
  const result = await persistPostgresBoothDirectory({
    boothCode: directory.boothCode,
    machineId: directory.machineId,
    organizationLegacyId: directory.organizationLegacyId,
    organizationName: "Photoslive Operator",
    name: directory.name,
    location: directory.location,
    accessEnabled: true,
  }, {
    environment,
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify(directory), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.directory, directory);
  assert.match(request.url, /rpc\/photoslive_persist_booth_directory$/);
  assert.equal(request.options.headers.authorization, `Bearer ${environment.SUPABASE_SERVICE_ROLE_KEY}`);
  const body = JSON.parse(request.options.body);
  assert.equal(body.p_machine_id, directory.machineId);
  assert.equal(JSON.stringify(result).includes(environment.SUPABASE_SERVICE_ROLE_KEY), false);
});

test("directory snapshot and access mutation use separate bounded RPCs", async () => {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ...directory, accessEnabled: calls.length === 2 ? false : true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const snapshot = await readPostgresBoothDirectory("booth-one", { environment, fetchImplementation });
  const updated = await updatePostgresBoothAccess("booth-one", false, { environment, fetchImplementation });
  assert.equal(snapshot.boothCode, "booth-one");
  assert.equal(updated.directory.accessEnabled, false);
  assert.match(calls[0].url, /photoslive_booth_directory_snapshot$/);
  assert.match(calls[1].url, /photoslive_set_booth_access$/);
  assert.deepEqual(calls[1].body, { p_booth_code: "booth-one", p_access_enabled: false });
});

test("primary directory restores a missing Redis booth cache", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment);
  globalThis.fetch = async () => new Response(JSON.stringify(directory), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const redis = new FakeRedis();
    const booth = await resolveBooth(redis, "booth-one");
    assert.equal(booth.boothCode, "booth-one");
    assert.equal(booth.machineId, "machine_one");
    assert.equal(booth.organizationId, directory.organizationLegacyId);
    assert.equal(await redis.get(boothKey("booth-one")), "machine_one");
    assert.equal((await redis.get(machineKey("machine_one"))).paired, true);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("primary setup fails closed before mutating Redis when directory is unavailable", async () => {
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, environment, { SESSION_SECRET: "postgres-directory-test-session-secret-2026" });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "database unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    const redis = new FakeRedis();
    await redis.set("photoslive:pairing:ABCD-1234", "machine_one");
    await redis.set(machineKey("machine_one"), { id: "machine_one", pairingCode: "ABCD-1234", paired: false, name: "Booth One" });
    const response = await setupBooth(redis, { pairingCode: "ABCD-1234", email: "owner@example.com", pin: "123456", confirmPin: "123456", name: "Booth One", location: "Main Hall" });
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.retryable, true);
    assert.equal((await redis.get(machineKey("machine_one"))).paired, false);
    assert.equal(await redis.get(boothKey("abcd-1234")), null);
    assert.equal(await redis.get("photoslive:email:owner@example.com"), null);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("directory migration keeps machine links private and RPCs service-role-only", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260722140000_booth_directory.sql", import.meta.url), "utf8");
  assert.match(sql, /private\.organization_directory_links/);
  assert.match(sql, /private\.booth_directory_links/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /for update/);
  assert.match(sql, /machine already belongs to another booth/);
  assert.match(sql, /booth already belongs to another machine/);
  assert.match(sql, /revoke all on function public\.photoslive_persist_booth_directory[\s\S]+authenticated/);
  assert.match(sql, /grant execute on function public\.photoslive_persist_booth_directory[\s\S]+service_role/);
  assert.doesNotMatch(sql, /grant execute[\s\S]+photoslive_persist_booth_directory[\s\S]+to authenticated/);
});
