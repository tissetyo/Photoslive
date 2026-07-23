import assert from "node:assert/strict";
import test from "node:test";
import { backendHealth } from "../api/_backend_health.mjs";

class MemoryRedis {
  constructor({ fail = false } = {}) { this.values = new Map(); this.fail = fail; }
  async set(key, value) { if (this.fail) throw new Error("cache unavailable"); this.values.set(key, value); return "OK"; }
  async get(key) { if (this.fail) throw new Error("cache unavailable"); return this.values.get(key) ?? null; }
  async del(key) { this.values.delete(key); return 1; }
}

const configuredEnvironment = {
  PHOTOSLIVE_POSTGRES_SHADOW: "true",
  PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "250",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "super-secret-service-key",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key-id",
  R2_SECRET_ACCESS_KEY: "secret-key",
  R2_BUCKET: "bucket",
};

test("backend health proves cache read/write and never exposes provider secrets", async () => {
  const health = await backendHealth(new MemoryRedis(), { environment: {} });
  assert.equal(health.cache.state, "ready");
  assert.equal(health.cache.readWrite, true);
  assert.equal(health.database.state, "disabled");
  assert.ok(health.providers.every(provider => Object.hasOwn(provider, "available")));
  assert.ok(!JSON.stringify(health).includes("SECRET_ACCESS_KEY"));
});

test("backend health performs a bounded authenticated PostgreSQL connectivity probe", async () => {
  let request;
  const health = await backendHealth(new MemoryRedis(), {
    environment: configuredEnvironment,
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    },
    providerFetchImplementation: async () => new Response(null, { status: 404 }),
  });
  assert.equal(health.database.state, "ready");
  assert.equal(health.providers.find(provider => provider.id === "cloudflare-r2").state, "ready");
  assert.match(request.url, /migration_shadow_events\?select=id&limit=1$/);
  assert.equal(request.options.headers.apikey, configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY);
  assert.ok(!JSON.stringify(health).includes(configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY));
});

test("backend health performs a live bounded storage probe and exposes no signed URL", async () => {
  let request;
  const health = await backendHealth(new MemoryRedis(), {
    environment: { R2_ACCOUNT_ID: "account", R2_ACCESS_KEY_ID: "key-id", R2_SECRET_ACCESS_KEY: "secret-key", R2_BUCKET: "bucket" },
    providerFetchImplementation: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 404 });
    },
  });
  const provider = health.providers.find(item => item.id === "cloudflare-r2");
  assert.equal(provider.state, "ready");
  assert.equal(request.options.method, "HEAD");
  assert.match(request.url, /X-Amz-Signature=/);
  assert.doesNotMatch(JSON.stringify(health), /X-Amz-Signature|secret-key|health-/);
});

test("backend health reports provider authentication failure without response body leakage", async () => {
  const health = await backendHealth(new MemoryRedis(), {
    environment: { R2_ACCOUNT_ID: "account", R2_ACCESS_KEY_ID: "wrong", R2_SECRET_ACCESS_KEY: "wrong-secret", R2_BUCKET: "bucket" },
    providerFetchImplementation: async () => new Response("credential rejected in private detail", { status: 403 }),
  });
  const provider = health.providers.find(item => item.id === "cloudflare-r2");
  assert.equal(provider.state, "error");
  assert.match(provider.message, /403/);
  assert.doesNotMatch(JSON.stringify(health), /credential rejected|wrong-secret/);
});

test("backend health actively probes configured Resend without leaking credentials", async () => {
  let request;
  const emailEnvironment = {
    RESEND_API_KEY: "re_health_test_key_123456",
    RESEND_FROM_EMAIL: "Photoslive <hello@example.test>",
    RESEND_WEBHOOK_SECRET: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==",
  };
  const health = await backendHealth(new MemoryRedis(), {
    environment: emailEnvironment,
    providerFetchImplementation: async (url, options) => {
      request = { url, options };
      return Response.json({ data: [] });
    },
  });
  const provider = health.providers.find(item => item.id === "resend");
  assert.equal(provider.state, "ready");
  assert.equal(request.url, "https://api.resend.com/domains");
  assert.equal(request.options.method, undefined);
  assert.doesNotMatch(JSON.stringify(health), /re_health_test|whsec_|hello@example\.test/);
});

test("backend health reports cache and database failure without throwing or leaking credentials", async () => {
  const health = await backendHealth(new MemoryRedis({ fail: true }), {
    environment: configuredEnvironment,
    fetchImplementation: async () => new Response("secret backend detail", { status: 503 }),
    providerFetchImplementation: async () => new Response("secret provider detail", { status: 503 }),
  });
  assert.equal(health.cache.state, "error");
  assert.equal(health.database.state, "error");
  assert.match(health.database.message, /503/);
  assert.ok(!JSON.stringify(health).includes("secret backend detail"));
  assert.ok(!JSON.stringify(health).includes("secret provider detail"));
  assert.ok(!JSON.stringify(health).includes(configuredEnvironment.SUPABASE_SERVICE_ROLE_KEY));
});
