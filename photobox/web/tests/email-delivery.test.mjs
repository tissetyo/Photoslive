import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { enqueueEmail, handleResendWebhook, listEmailDeliveries, probeResend, probeSmtp, processEmailDeliveries, processEmailDelivery, renderEmailTemplate, retryEmailDelivery } from "../api/_email.mjs";
import { providerDefinitions } from "../api/_providers.mjs";
import { emailDeliveriesControl } from "../api/platform.mjs";
import { sessionKey } from "../api/_store.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) { if (options.nx && this.values.has(key)) return null; this.values.set(key, structuredClone(value)); return "OK"; }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, stop) { this.lists.set(key, (this.lists.get(key) || []).slice(start, stop + 1)); return "OK"; }
  async lrange(key, start, stop) { return structuredClone((this.lists.get(key) || []).slice(start, stop + 1)); }
  pipeline() {
    const operations = [];
    return {
      lpush: (key, value) => operations.push(() => this.lpush(key, value)),
      ltrim: (key, start, stop) => operations.push(() => this.ltrim(key, start, stop)),
      exec: async () => Promise.all(operations.map(operation => operation())),
    };
  }
}

const environment = {
  RESEND_API_KEY: "re_test_api_key_123456789",
  RESEND_FROM_EMAIL: "Photoslive <hello@photoslive.test>",
  RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("resend-webhook-test-secret-32bytes!").toString("base64")}`,
  EMAIL_PAYLOAD_ENCRYPTION_KEY: "email-sensitive-payload-test-key-2026",
};
const smtpEnvironment = {
  SMTP_HOST: "smtp.photoslive.test",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USERNAME: "mailer@photoslive.test",
  SMTP_PASSWORD: "smtp-provider-secret-for-tests",
  SMTP_FROM_EMAIL: "Photoslive <hello@photoslive.test>",
  EMAIL_PAYLOAD_ENCRYPTION_KEY: "email-sensitive-payload-test-key-2026",
};
const sessionSecret = "email-delivery-session-secret-for-tests-2026";

async function signedCookie(id) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
  const hex = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `__Host-photoslive_session=${encodeURIComponent(`${id}.${hex}`)}`;
}

async function signedWebhook(payload, id, timestampSeconds) {
  const body = JSON.stringify(payload);
  const key = Buffer.from(environment.RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(`${id}.${timestampSeconds}.${body}`));
  return new Request("https://photoslive.test/api/platform?action=resend_webhook", {
    method: "POST", body, headers: { "svix-id": id, "svix-timestamp": String(timestampSeconds), "svix-signature": `v1,${Buffer.from(signature).toString("base64")}` },
  });
}

test("Resend is a real provider and templates escape operator-controlled content", () => {
  assert.equal(providerDefinitions().resend.adapterImplemented, true);
  assert.deepEqual(providerDefinitions().resend.requiredEnvironment, ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_WEBHOOK_SECRET"]);
  const alert = renderEmailTemplate("system_alert", { boothName: "<Booth>", title: "<script>x</script>", message: "A & B" });
  assert.doesNotMatch(alert.html, /<script>/);
  assert.match(alert.html, /&lt;script&gt;/);
  assert.match(renderEmailTemplate("password_recovery", {}).subject, /pemulihan/i);
  assert.match(renderEmailTemplate("payout_summary", {}).subject, /payout/i);
  assert.match(renderEmailTemplate("platform_invitation", { activationUrl: "https://photoslive.test/superadmin?invite=token", recipientName: "Zoe" }).subject, /undangan/i);
});

test("Custom SMTP is a real provider with an explicit credential contract", () => {
  const smtp = providerDefinitions()["custom-smtp"];
  assert.equal(smtp.adapterImplemented, true);
  assert.equal(smtp.capability, "email");
  assert.deepEqual(smtp.requiredEnvironment, [
    "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM_EMAIL",
  ]);
});

test("platform invitation token is encrypted at rest and only decrypted while delivering", async () => {
  const redis = new MemoryRedis();
  const activationUrl = "https://photoslive.test/superadmin?invite=very-secret-one-time-token&email=zoe%40example.test";
  const queued = await enqueueEmail(redis, {
    template: "platform_invitation", to: "zoe@example.test", businessKey: "staff-invite-1",
    data: { recipientName: "Zoe", inviteExpiresAt: "2026-07-23T00:00:00.000Z" },
    sensitiveData: { activationUrl }, environment,
  });
  const raw = [...redis.values.values()].find(value => value?.id === queued.id);
  assert.match(raw.secretEnvelope, /^v1\.[a-f0-9]{12}\./);
  assert.doesNotMatch(JSON.stringify([...redis.values.values()]), /very-secret-one-time-token/);
  let body;
  const result = await processEmailDelivery(redis, queued.id, { environment, fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ id: "resend-invitation" });
  } });
  assert.equal(result.status, "sent");
  assert.match(body.html, /very-secret-one-time-token/);
  assert.equal(body.to[0], "zoe@example.test");
});

test("email enqueue is deterministic, persistent, and masks recipients", async () => {
  const redis = new MemoryRedis();
  const input = { template: "system_alert", to: "owner@example.test", businessKey: "incident-1", boothCode: "booth-a", data: { title: "Disk kritis" } };
  const first = await enqueueEmail(redis, input);
  const duplicate = await enqueueEmail(redis, input);
  assert.equal(first.id, duplicate.id);
  assert.equal((await listEmailDeliveries(redis)).length, 1);
  assert.equal(first.recipient, "ow***@example.test");
  assert.doesNotMatch(JSON.stringify(await listEmailDeliveries(redis)), /owner@example\.test|RESEND_API_KEY|re_test/);
  const raw = [...redis.values.values()].find(value => value?.id === first.id);
  assert.equal(raw.data.title, "Disk kritis");
  assert.equal(raw.data.unexpected, undefined);
});

test("stored template data is allow-listed and bounded before entering Redis", async () => {
  const redis = new MemoryRedis();
  const queued = await enqueueEmail(redis, {
    template: "system_alert", to: "owner@example.test", businessKey: "bounded-1",
    data: { boothName: "B".repeat(500), title: "T".repeat(500), message: "M".repeat(5_000), unexpected: "do-not-store" },
  });
  const raw = [...redis.values.values()].find(value => value?.id === queued.id);
  assert.equal(raw.data.boothName.length, 120);
  assert.equal(raw.data.title.length, 140);
  assert.equal(raw.data.message.length, 1_000);
  assert.equal(raw.data.unexpected, undefined);
});

test("missing configuration waits; retry keeps the original delivery identity", async () => {
  const redis = new MemoryRedis();
  await enqueueEmail(redis, { template: "system_alert", to: "owner@example.test", businessKey: "incident-2", data: {} });
  const result = await processEmailDeliveries(redis, { environment: {}, atMs: Date.now() + 1_000, fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.equal(result.waiting, 1);
  let [record] = await listEmailDeliveries(redis);
  assert.equal(record.status, "waiting_configuration");
  const retried = await retryEmailDelivery(redis, record.id, "integration-admin");
  assert.equal(retried.id, record.id);
  assert.equal(retried.status, "queued");
});

test("delivery uses server credentials and one deterministic Resend idempotency key", async () => {
  const redis = new MemoryRedis();
  const queued = await enqueueEmail(redis, { template: "system_alert", to: "owner@example.test", businessKey: "incident-3", data: { title: "Test" } });
  let captured;
  const result = await processEmailDeliveries(redis, { environment, atMs: Date.now() + 1_000, fetchImpl: async (url, options) => {
    captured = { url, options };
    return Response.json({ id: "resend-message-1" });
  } });
  assert.equal(result.sent, 1);
  assert.equal(captured.url, "https://api.resend.com/emails");
  assert.equal(captured.options.headers.authorization, `Bearer ${environment.RESEND_API_KEY}`);
  assert.match(captured.options.headers["Idempotency-Key"], /^photoslive-email-[a-f0-9]{64}$/);
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body.to, ["owner@example.test"]);
  const [sent] = await listEmailDeliveries(redis);
  assert.equal(sent.id, queued.id);
  assert.equal(sent.status, "sent");
  assert.equal(sent.providerMessageId, "resend-message-1");
  assert.doesNotMatch(JSON.stringify([...redis.values.values()]), /re_test_api_key_123456789/);
});

test("a manual email test processes its own record instead of an older queue item", async () => {
  const redis = new MemoryRedis();
  const older = await enqueueEmail(redis, { template: "system_alert", to: "old@example.test", businessKey: "old", data: {} });
  const current = await enqueueEmail(redis, { template: "system_alert", to: "new@example.test", businessKey: "new", data: {} });
  let recipient;
  const processed = await processEmailDelivery(redis, current.id, { environment, fetchImpl: async (_url, options) => {
    recipient = JSON.parse(options.body).to[0];
    return Response.json({ id: "resend-current" });
  } });
  assert.equal(processed.id, current.id);
  assert.equal(processed.status, "sent");
  assert.equal(recipient, "new@example.test");
  assert.equal((await listEmailDeliveries(redis)).find(item => item.id === older.id).status, "queued");
});

test("Resend connection probe is read-only and bounded", async () => {
  let captured;
  const check = await probeResend({ environment, fetchImpl: async (url, options) => { captured = { url, options }; return Response.json({ data: [] }); } });
  assert.equal(check.state, "ready");
  assert.equal(captured.url, "https://api.resend.com/domains");
  assert.equal(captured.options.method, undefined);
});

test("SMTP connection probe verifies TLS transport and always closes it", async () => {
  let options;
  let verified = 0;
  let closed = 0;
  const check = await probeSmtp({
    environment: smtpEnvironment,
    transportFactory: input => {
      options = input;
      return { verify: async () => { verified += 1; }, close: () => { closed += 1; } };
    },
  });
  assert.equal(check.state, "ready");
  assert.equal(check.provider, "custom-smtp");
  assert.equal(verified, 1);
  assert.equal(closed, 1);
  assert.equal(options.host, "smtp.photoslive.test");
  assert.equal(options.port, 465);
  assert.equal(options.secure, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.tls.minVersion, "TLSv1.2");
  assert.equal(options.disableFileAccess, true);
  assert.equal(options.disableUrlAccess, true);
});

test("SMTP delivery uses scoped server credentials, deterministic header, and no fetch", async () => {
  const redis = new MemoryRedis();
  const queued = await enqueueEmail(redis, {
    template: "system_alert", to: "owner@example.test", businessKey: "smtp-incident-1",
    data: { title: "Tes SMTP", message: "Koneksi SMTP aktif" },
  });
  let transportOptions;
  let message;
  let closed = 0;
  const result = await processEmailDelivery(redis, queued.id, {
    environment: smtpEnvironment,
    fetchImpl: async () => { throw new Error("SMTP delivery must not call fetch"); },
    smtpTransportFactory: input => {
      transportOptions = input;
      return {
        sendMail: async payload => { message = payload; return { messageId: "smtp-message-1" }; },
        close: () => { closed += 1; },
      };
    },
  });
  assert.equal(result.status, "sent");
  assert.equal(result.providerMessageId, "smtp-message-1");
  assert.equal(message.from, smtpEnvironment.SMTP_FROM_EMAIL);
  assert.equal(message.to, "owner@example.test");
  assert.match(message.subject, /Tes SMTP/);
  assert.match(message.headers["X-Photoslive-Idempotency-Key"], /^photoslive-email-[a-f0-9]{64}$/);
  assert.equal(transportOptions.auth.user, smtpEnvironment.SMTP_USERNAME);
  assert.equal(transportOptions.auth.pass, smtpEnvironment.SMTP_PASSWORD);
  assert.equal(closed, 1);
  assert.doesNotMatch(JSON.stringify(await listEmailDeliveries(redis)), /smtp-provider-secret|mailer@photoslive/);
  assert.doesNotMatch(JSON.stringify([...redis.values.values()]), /smtp-provider-secret-for-tests/);
});

test("signed webhook updates delivery once and terminal problem status cannot be downgraded", async () => {
  const redis = new MemoryRedis();
  await enqueueEmail(redis, { template: "system_alert", to: "owner@example.test", businessKey: "incident-4", data: {} });
  const atMs = Date.now();
  await processEmailDeliveries(redis, { environment, atMs, fetchImpl: async () => Response.json({ id: "resend-message-2" }) });
  const timestamp = Math.floor((atMs + 2_000) / 1000);
  const delivered = await handleResendWebhook(redis, await signedWebhook({ type: "email.delivered", data: { email_id: "resend-message-2" } }, "msg-delivered", timestamp), environment, atMs + 2_000);
  assert.equal(delivered.status, 200);
  assert.equal((await listEmailDeliveries(redis))[0].status, "delivered");
  const complained = await handleResendWebhook(redis, await signedWebhook({ type: "email.complained", data: { email_id: "resend-message-2" } }, "msg-complained", timestamp), environment, atMs + 2_000);
  assert.equal(complained.status, 200);
  assert.equal((await listEmailDeliveries(redis))[0].status, "complained");
  await handleResendWebhook(redis, await signedWebhook({ type: "email.delivered", data: { email_id: "resend-message-2" } }, "msg-late-delivered", timestamp), environment, atMs + 2_000);
  assert.equal((await listEmailDeliveries(redis))[0].status, "complained");
  const duplicate = await handleResendWebhook(redis, await signedWebhook({ type: "email.complained", data: { email_id: "resend-message-2" } }, "msg-complained", timestamp), environment, atMs + 2_000);
  assert.equal(duplicate.body.duplicate, true);
});

test("invalid or stale webhook signatures are rejected", async () => {
  const redis = new MemoryRedis();
  const nowMs = Date.now();
  const stale = await handleResendWebhook(redis, await signedWebhook({ type: "email.delivered", data: { email_id: "unknown" } }, "stale", Math.floor(nowMs / 1000) - 1_000), environment, nowMs);
  assert.equal(stale.status, 401);
  const invalid = new Request("https://photoslive.test/webhook", { method: "POST", body: "{}", headers: { "svix-id": "bad", "svix-timestamp": String(Math.floor(nowMs / 1000)), "svix-signature": "v1,bad" } });
  assert.equal((await handleResendWebhook(redis, invalid, environment, nowMs)).status, 401);
});

test("superadmin email operations expose real queue controls without client secrets", () => {
  const html = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
  const api = readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");
  assert.match(html, /id="email-delivery-card"/);
  assert.match(html, /id="email-delivery-process"/);
  assert.match(script, /data-retry-email/);
  assert.match(script, /operation: "test"/);
  assert.match(api, /action === "resend_webhook"/);
  assert.match(api, /action === "email_deliveries"/);
  assert.doesNotMatch(script, /re_[A-Za-z0-9]{12,}|whsec_[A-Za-z0-9+/=]{12,}/);
});

test("email control plane enforces read/write permissions and writes a secret-safe audit", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = sessionSecret;
  try {
    const redis = new MemoryRedis();
    await redis.set(sessionKey("email-auditor"), { id: "email-auditor", userId: "auditor-1", role: "superadmin", platformRole: "auditor", expiresAt: "2099-01-01T00:00:00.000Z" });
    await redis.set(sessionKey("email-integration"), { id: "email-integration", userId: "integration-1", role: "superadmin", platformRole: "integration_admin", expiresAt: "2099-01-01T00:00:00.000Z" });
    const auditorCookie = await signedCookie("email-auditor");
    const integrationCookie = await signedCookie("email-integration");
    const read = await emailDeliveriesControl(redis, new Request("https://photoslive.test/api/platform?action=email_deliveries", { headers: { cookie: auditorCookie } }));
    assert.equal(read.status, 200);
    const denied = await emailDeliveriesControl(redis, new Request("https://photoslive.test/api/platform?action=email_deliveries", { method: "POST", headers: { cookie: auditorCookie } }), { operation: "process" });
    assert.equal(denied.status, 403);
    const processed = await emailDeliveriesControl(redis, new Request("https://photoslive.test/api/platform?action=email_deliveries", { method: "POST", headers: { cookie: integrationCookie } }), { operation: "process" }, "corr-email-test");
    assert.equal(processed.status, 200);
    const audit = (await redis.lrange("photoslive:audit:global", 0, 10)).join("\n");
    assert.match(audit, /email\.queue_processed/);
    assert.doesNotMatch(audit, /RESEND_API_KEY|RESEND_WEBHOOK_SECRET|re_test|whsec_/);
  } finally {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
  }
});
