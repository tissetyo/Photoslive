import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { persistPostgresSettings, postgresSettingsStatus, readPostgresSettings } from "../api/_postgres_settings.mjs";
import { persistSettingsSnapshot } from "../api/platform.mjs";

const environment = {
  PHOTOSLIVE_POSTGRES_SETTINGS: "primary",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
};

function redisTransaction(log) {
  return { multi() { const commands = []; return {
    set(...args) { commands.push(["set", ...args]); return this; },
    incr(...args) { commands.push(["incr", ...args]); return this; },
    async exec() { log.push(...commands); return commands.map(() => "OK"); },
  }; } };
}

test("settings PostgreSQL mode is explicit", () => {
  assert.equal(postgresSettingsStatus({ ...environment, PHOTOSLIVE_POSTGRES_SETTINGS: "" }).mode, "off");
  assert.equal(postgresSettingsStatus(environment).primary, true);
});

test("primary settings writes database before refreshing Redis cache", async () => {
  const commands = [];
  const settings = { booth: { name: "Booth One", location: "Hall" } };
  const version = await persistSettingsSnapshot(redisTransaction(commands), "booth-one", settings, {
    environment,
    async fetchImplementation(url, options) {
      assert.equal(commands.length, 0);
      assert.match(url, /\/rpc\/photoslive_persist_booth_config$/);
      assert.doesNotMatch(options.body, /service-role-test-key/);
      return new Response(JSON.stringify({ version: 9 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(version, 9);
  assert.deepEqual(commands.map(command => command[0]), ["set"]);
  assert.equal(commands[0][2], 9);
});

test("primary settings succeeds even when Redis compatibility cache is unavailable", async () => {
  const version = await persistSettingsSnapshot({
    multi() {
      return {
        set() { return this; },
        async exec() { throw new Error("ERR max requests limit exceeded"); },
      };
    },
  }, "booth-one", { booth: { name: "Booth One" } }, {
    environment,
    async fetchImplementation() {
      return new Response(JSON.stringify({ version: 10 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(version, 10);
});

test("primary settings failure leaves Redis untouched", async () => {
  const commands = [];
  await assert.rejects(persistSettingsSnapshot(redisTransaction(commands), "booth-one", { booth: { name: "Booth One" } }, {
    environment,
    fetchImplementation: async () => new Response("unavailable", { status: 503 }),
  }), error => error.status === 503);
  assert.deepEqual(commands, []);
});

test("settings snapshot restores config and version", async () => {
  const snapshot = await readPostgresSettings("booth-one", {
    environment,
    async fetchImplementation(url) {
      assert.match(url, /\/rpc\/photoslive_booth_config_snapshot$/);
      return new Response(JSON.stringify({ version: 11, config: { booth: { name: "Recovered" } } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(snapshot, { version: 11, config: { booth: { name: "Recovered" } } });
});

test("settings migration is bounded and service-role-only", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260722123000_transactional_booth_settings.sql", import.meta.url), "utf8").toLowerCase();
  assert.match(sql, /for update/);
  assert.match(sql, /octet_length\(p_config::text\) > 500000/);
  assert.match(sql, /config_version = config_version \+ 1/);
  assert.match(sql, /on conflict \(booth_id\) do update/);
  assert.match(sql, /revoke all on function public\.photoslive_persist_booth_config\(text, jsonb\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.photoslive_booth_config_snapshot\(text\) to service_role/);
});

test("settings endpoint converts database failure into an actionable retry response", () => {
  const api = readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");
  assert.match(api, /Pengaturan belum dapat disimpan\. Perubahan lokal tetap dipertahankan agar dapat dicoba lagi\./);
  assert.match(api, /retryable: true,[\s\S]*correlationId,[\s\S]*Number\(error\?\.status \|\| 503\)/);
});
