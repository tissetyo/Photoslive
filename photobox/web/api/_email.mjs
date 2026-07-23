import { now, randomId } from "./_store.mjs";
import { resolveProviderRuntimeForCapability } from "./_provider_connections.mjs";
import nodemailer from "nodemailer";

const INDEX_KEY = "photoslive:email-deliveries";
const deliveryKey = id => `photoslive:email-delivery:${id}`;
const dedupeKey = value => `photoslive:email-dedupe:${value}`;
const providerMessageKey = id => `photoslive:email-provider:${id}`;
const webhookEventKey = id => `photoslive:email-webhook:${id}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 5_000;
const WEBHOOK_TOLERANCE_SECONDS = 300;
const EMAIL_STATUSES = ["queued", "retry", "waiting_configuration", "sent", "delivered", "bounced", "complained", "suppressed", "failed"];
const TERMINAL_WEBHOOK_STATUSES = new Set(["bounced", "complained", "suppressed"]);
const RETRYABLE_STATUSES = new Set(["failed", "retry", "waiting_configuration"]);

const safeText = (value, length = 500) => String(value || "").slice(0, length);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()) && String(value).length <= 254;
const dueAt = (attempts, atMs) => new Date(atMs + Math.min(3_600_000, 15_000 * (2 ** Math.max(0, attempts - 1)))).toISOString();

function sanitizeTemplateData(template, data = {}) {
  if (template === "platform_invitation") return {
    recipientName: safeText(data.recipientName, 120), inviteExpiresAt: safeText(data.inviteExpiresAt, 80),
  };
  if (template === "password_recovery") return {
    boothName: safeText(data.boothName, 120), recipientName: safeText(data.recipientName, 120),
    requestReference: safeText(data.requestReference, 120),
  };
  if (template === "payout_summary") return {
    boothName: safeText(data.boothName, 120), period: safeText(data.period, 80),
    amount: safeText(data.amount, 80), reference: safeText(data.reference, 120),
  };
  if (template === "system_alert") return {
    boothName: safeText(data.boothName, 120), title: safeText(data.title, 140), message: safeText(data.message, 1_000),
  };
  throw new Error("Template email tidak didukung");
}

const bytesToBase64 = bytes => btoa(String.fromCharCode(...bytes));
const base64ToBytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
async function emailEncryptionKeys(environment = process.env) {
  const configured = String(environment.EMAIL_PAYLOAD_ENCRYPTION_KEYS || environment.EMAIL_PAYLOAD_ENCRYPTION_KEY || environment.SESSION_SECRET || "")
    .split(",").map(value => value.trim()).filter(value => value.length >= 32);
  if (!configured.length) throw new Error("EMAIL_PAYLOAD_ENCRYPTION_KEY belum dikonfigurasi");
  const keys = [];
  for (const material of configured) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(material)));
    keys.push({ id: [...digest.slice(0, 6)].map(byte => byte.toString(16).padStart(2, "0")).join(""), key: await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]) });
  }
  return keys;
}

async function sealSensitiveEmailData(value, aad, environment = process.env) {
  const [{ id, key }] = await emailEncryptionKeys(environment);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, encoder.encode(JSON.stringify(value))));
  return `v1.${id}.${bytesToBase64(iv)}.${bytesToBase64(cipher)}`;
}

async function openSensitiveEmailData(envelope, aad, environment = process.env) {
  const [version, keyId, ivEncoded, cipherEncoded] = String(envelope || "").split(".");
  if (version !== "v1" || !keyId || !ivEncoded || !cipherEncoded) throw new Error("Payload email sensitif tidak valid");
  const entry = (await emailEncryptionKeys(environment)).find(item => item.id === keyId);
  if (!entry) throw new Error("Kunci payload email tidak tersedia");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(ivEncoded), additionalData: encoder.encode(aad) }, entry.key, base64ToBytes(cipherEncoded));
  return JSON.parse(decoder.decode(plain));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function maskEmail(value) {
  const [local = "", domain = ""] = String(value || "").split("@");
  if (!domain) return "—";
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, Math.min(8, local.length - 2)))}@${domain}`;
}

export function renderEmailTemplate(template, data = {}) {
  const boothName = safeText(data.boothName || "Photoslive", 120);
  const recipientName = safeText(data.recipientName || "Operator", 120);
  if (template === "platform_invitation") {
    const activationUrl = String(data.activationUrl || "");
    if (!/^https:\/\//.test(activationUrl)) throw new Error("Tautan aktivasi undangan tidak valid");
    const inviteExpiresAt = safeText(data.inviteExpiresAt || "24 jam", 80);
    return {
      subject: "Undangan tim platform Photoslive",
      text: `Halo ${recipientName}, Anda diundang ke control plane Photoslive. Aktifkan akun sebelum ${inviteExpiresAt}: ${activationUrl}`,
      html: `<h1>Aktifkan akun Photoslive</h1><p>Halo ${escapeHtml(recipientName)},</p><p>Anda diundang ke control plane Photoslive.</p><p><a href="${escapeHtml(activationUrl)}">Aktifkan akun</a></p><p>Tautan berlaku sampai ${escapeHtml(inviteExpiresAt)} dan hanya dapat digunakan satu kali.</p>`,
    };
  }
  if (template === "password_recovery") {
    const requestReference = safeText(data.requestReference || "—", 120);
    return {
      subject: `Permintaan pemulihan akses ${boothName}`,
      text: `Halo ${recipientName}, permintaan pemulihan akses ${boothName} telah diterima. Referensi: ${requestReference}. Superadmin akan memverifikasi permintaan sebelum menghubungi Anda.`,
      html: `<h1>Permintaan pemulihan diterima</h1><p>Halo ${escapeHtml(recipientName)},</p><p>Permintaan pemulihan akses <strong>${escapeHtml(boothName)}</strong> telah diterima.</p><p>Referensi: <strong>${escapeHtml(requestReference)}</strong></p><p>Superadmin akan memverifikasi permintaan sebelum menghubungi Anda.</p>`,
    };
  }
  if (template === "payout_summary") {
    const period = safeText(data.period || "—", 80);
    const amount = safeText(data.amount || "Rp0", 80);
    const reference = safeText(data.reference || "—", 120);
    return {
      subject: `Ringkasan payout ${boothName} · ${period}`,
      text: `Ringkasan payout ${boothName}. Periode: ${period}. Nominal: ${amount}. Referensi: ${reference}.`,
      html: `<h1>Ringkasan payout</h1><p><strong>${escapeHtml(boothName)}</strong></p><p>Periode: ${escapeHtml(period)}</p><p>Nominal: <strong>${escapeHtml(amount)}</strong></p><p>Referensi: ${escapeHtml(reference)}</p>`,
    };
  }
  if (template === "system_alert") {
    const title = safeText(data.title || "Pemberitahuan Photoslive", 140);
    const message = safeText(data.message || "Periksa dashboard Photoslive untuk informasi terbaru.", 1_000);
    return {
      subject: `${title} · ${boothName}`,
      text: `${title}\n\n${message}\n\nPhotobox: ${boothName}`,
      html: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>Photobox: <strong>${escapeHtml(boothName)}</strong></p>`,
    };
  }
  throw new Error("Template email tidak didukung");
}

export function safeEmailDelivery(record) {
  if (!record) return null;
  return {
    id: safeText(record.id, 120), template: safeText(record.template, 80), recipient: maskEmail(record.to),
    boothCode: safeText(record.boothCode, 100), organizationId: safeText(record.organizationId, 100),
    status: EMAIL_STATUSES.includes(record.status) ? record.status : "failed",
    attempts: Math.max(0, Number(record.attempts || 0)), nextAttemptAt: record.nextAttemptAt || null,
    createdAt: record.createdAt || null, updatedAt: record.updatedAt || null, sentAt: record.sentAt || null,
    deliveredAt: record.deliveredAt || null, providerMessageId: safeText(record.providerMessageId, 160) || null,
    lastError: safeText(record.lastError, 300) || null,
  };
}

export async function enqueueEmail(redis, input = {}) {
  const to = String(input.to || "").trim().toLowerCase();
  if (!validEmail(to)) throw new Error("Alamat email penerima tidak valid");
  const templateData = sanitizeTemplateData(input.template, input.data);
  const businessKey = safeText(input.businessKey, 180);
  if (!businessKey) throw new Error("Business key email wajib diisi");
  const dedupeHash = await sha256(`${input.template}|${to}|${businessKey}`);
  const id = randomId("email");
  let secretEnvelope = null;
  if (input.template === "platform_invitation") {
    const activationUrl = String(input.sensitiveData?.activationUrl || "");
    renderEmailTemplate(input.template, { ...templateData, activationUrl });
    secretEnvelope = await sealSensitiveEmailData({ activationUrl }, `email:${id}:${to}`, input.environment || process.env);
  } else renderEmailTemplate(input.template, templateData);
  const acquired = await redis.set(dedupeKey(dedupeHash), id, { nx: true, ex: 60 * 60 * 24 * 30 });
  if (!acquired) {
    const existingId = await redis.get(dedupeKey(dedupeHash));
    return existingId ? safeEmailDelivery(await redis.get(deliveryKey(existingId))) : null;
  }
  const timestamp = now();
  const record = {
    id, template: input.template, to, data: templateData, secretEnvelope, businessKey,
    idempotencyKey: `photoslive-email-${dedupeHash}`.slice(0, 256), boothCode: safeText(input.boothCode, 100),
    organizationId: safeText(input.organizationId, 100), status: "queued", attempts: 0,
    nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp, sentAt: null,
    deliveredAt: null, providerMessageId: null, lastError: null,
  };
  await redis.set(deliveryKey(id), record);
  await redis.lpush(INDEX_KEY, id);
  await redis.ltrim(INDEX_KEY, 0, 999);
  return safeEmailDelivery(record);
}

export async function listEmailDeliveries(redis, limit = 100) {
  const bounded = Math.max(1, Math.min(200, Number(limit || 100)));
  const ids = await redis.lrange(INDEX_KEY, 0, bounded - 1);
  const records = (await Promise.all(ids.map(id => redis.get(deliveryKey(id))))).filter(Boolean);
  return records.map(safeEmailDelivery).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function resendConfiguration(environment = {}) {
  const apiKey = String(environment.RESEND_API_KEY || "");
  const from = String(environment.RESEND_FROM_EMAIL || "").trim();
  if (!apiKey.startsWith("re_") || apiKey.length < 10) throw new Error("API key Resend tidak valid");
  if (!validEmail(from.replace(/^.*<([^>]+)>$/, "$1"))) throw new Error("Email pengirim Resend tidak valid");
  return { apiKey, from };
}

function smtpConfiguration(environment = {}) {
  const host = String(environment.SMTP_HOST || "").trim();
  const port = Number(environment.SMTP_PORT);
  const secureValue = String(environment.SMTP_SECURE || "").trim().toLowerCase();
  const username = String(environment.SMTP_USERNAME || "").trim();
  const password = String(environment.SMTP_PASSWORD || "");
  const from = String(environment.SMTP_FROM_EMAIL || "").trim();
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/i.test(host)) throw new Error("Host SMTP tidak valid");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port SMTP tidak valid");
  if (!["true", "false", "1", "0", "yes", "no", "on", "off"].includes(secureValue)) throw new Error("SMTP_SECURE harus true atau false");
  if (!username || username.length > 512) throw new Error("Username SMTP tidak valid");
  if (!password || password.length > 4_096) throw new Error("Password SMTP tidak valid");
  if (!validEmail(from.replace(/^.*<([^>]+)>$/, "$1"))) throw new Error("Email pengirim SMTP tidak valid");
  return { host, port, secure: ["true", "1", "yes", "on"].includes(secureValue), username, password, from };
}

function smtpTransport(environment, transportFactory = nodemailer.createTransport) {
  const config = smtpConfiguration(environment);
  const transport = transportFactory({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    requireTLS: !config.secure,
    tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    connectionTimeout: DELIVERY_TIMEOUT_MS,
    greetingTimeout: DELIVERY_TIMEOUT_MS,
    socketTimeout: DELIVERY_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return { config, transport };
}

export async function probeResend({ environment = process.env, fetchImpl = fetch, timeoutMs = 3_000 } = {}) {
  const checkedAt = now();
  const startedAt = performance.now();
  const controller = new AbortController();
  let timer;
  try {
    const config = resendConfiguration(environment);
    timer = setTimeout(() => controller.abort(), Math.max(500, Math.min(10_000, Number(timeoutMs || 3_000))));
    const response = await fetchImpl("https://api.resend.com/domains", { headers: { authorization: `Bearer ${config.apiKey}`, "user-agent": "Photoslive-Email/1.0" }, signal: controller.signal });
    if (!response.ok) throw new Error(`Resend merespons HTTP ${response.status}`);
    return { provider: "resend", state: "ready", latencyMs: Math.round((performance.now() - startedAt) * 10) / 10, message: "API Resend dapat dijangkau", checkedAt };
  } catch (error) {
    const message = error?.name === "AbortError" ? "Resend timeout" : safeText(error.message || "Resend gagal");
    return { provider: "resend", state: "error", latencyMs: Math.round((performance.now() - startedAt) * 10) / 10, message, checkedAt };
  } finally { if (timer) clearTimeout(timer); }
}

export async function probeSmtp({ environment = process.env, transportFactory = nodemailer.createTransport, timeoutMs = 3_000 } = {}) {
  const checkedAt = now();
  const startedAt = performance.now();
  let transport;
  try {
    ({ transport } = smtpTransport(environment, transportFactory));
    await Promise.race([
      transport.verify(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SMTP timeout")), Math.max(500, Math.min(10_000, Number(timeoutMs || 3_000))))),
    ]);
    return { provider: "custom-smtp", state: "ready", latencyMs: Math.round((performance.now() - startedAt) * 10) / 10, message: "Server SMTP dapat dijangkau", checkedAt };
  } catch (error) {
    return { provider: "custom-smtp", state: "error", latencyMs: Math.round((performance.now() - startedAt) * 10) / 10, message: safeText(error.message || "SMTP gagal"), checkedAt };
  } finally { transport?.close?.(); }
}

export async function probeEmailProvider({ providerId, ...options } = {}) {
  return providerId === "custom-smtp" ? probeSmtp(options) : probeResend(options);
}

async function deliver(redis, record, { environment, fetchImpl, smtpTransportFactory, atMs }) {
  const timestamp = new Date(atMs).toISOString();
  const attempts = Number(record.attempts || 0) + 1;
  let runtime;
  try { runtime = await resolveProviderRuntimeForCapability(redis, "email", { boothCode: record.boothCode, organizationId: record.organizationId }, environment); }
  catch (error) { record.lastError = safeText(error.message || "Credential email tidak dapat dibuka"); }
  if (!runtime) {
    const updated = { ...record, status: "waiting_configuration", attempts, nextAttemptAt: new Date(atMs + 3_600_000).toISOString(), updatedAt: timestamp, lastError: record.lastError || "Provider email belum dikonfigurasi" };
    await redis.set(deliveryKey(record.id), updated);
    return updated;
  }
  const controller = new AbortController();
  let timer;
  try {
    const sensitiveData = record.secretEnvelope ? await openSensitiveEmailData(record.secretEnvelope, `email:${record.id}:${record.to}`, environment) : {};
    const rendered = renderEmailTemplate(record.template, { ...record.data, ...sensitiveData });
    let providerMessageId;
    if (runtime.providerId === "custom-smtp") {
      const { config, transport } = smtpTransport(runtime.environment, smtpTransportFactory || nodemailer.createTransport);
      try {
        const result = await transport.sendMail({
          from: config.from,
          to: record.to,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers: { "X-Photoslive-Idempotency-Key": record.idempotencyKey },
        });
        providerMessageId = safeText(result?.messageId, 160);
      } finally { transport.close?.(); }
      if (!providerMessageId) throw new Error("SMTP tidak mengembalikan message ID");
    } else {
      const config = resendConfiguration(runtime.environment);
      timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", "user-agent": "Photoslive-Email/1.0", "Idempotency-Key": record.idempotencyKey },
        body: JSON.stringify({ from: config.from, to: [record.to], subject: rendered.subject, html: rendered.html, text: rendered.text }),
      });
      if (!response.ok) throw new Error(`Resend merespons HTTP ${response.status}`);
      const responseBody = await response.json().catch(() => ({}));
      providerMessageId = safeText(responseBody.id, 160);
      if (!providerMessageId) throw new Error("Resend tidak mengembalikan ID email");
    }
    const updated = { ...record, status: "sent", attempts, nextAttemptAt: null, updatedAt: timestamp, sentAt: timestamp, providerMessageId, lastError: null };
    await redis.set(deliveryKey(record.id), updated);
    await redis.set(providerMessageKey(providerMessageId), record.id, { ex: 60 * 60 * 24 * 90 });
    return updated;
  } catch (error) {
    const final = attempts >= MAX_ATTEMPTS;
    const message = error?.name === "AbortError" ? "Resend timeout" : safeText(error.message || "Pengiriman email gagal");
    const updated = { ...record, status: final ? "failed" : "retry", attempts, nextAttemptAt: final ? null : dueAt(attempts, atMs), updatedAt: timestamp, lastError: message };
    await redis.set(deliveryKey(record.id), updated);
    return updated;
  } finally { if (timer) clearTimeout(timer); }
}

export async function processEmailDeliveries(redis, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit || 10)));
  const atMs = Number(options.atMs || Date.now());
  const records = await listEmailDeliveries(redis, 200);
  const due = records.filter(record => ["queued", "retry", "waiting_configuration"].includes(record.status) && (!record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= atMs)).slice(0, limit);
  const processed = [];
  for (const safeRecord of due) {
    const raw = await redis.get(deliveryKey(safeRecord.id));
    if (raw) processed.push(safeEmailDelivery(await deliver(redis, raw, { environment: options.environment || process.env, fetchImpl: options.fetchImpl || fetch, smtpTransportFactory: options.smtpTransportFactory, atMs })));
  }
  return { checkedAt: new Date(atMs).toISOString(), processed: processed.length,
    sent: processed.filter(item => item.status === "sent").length, failed: processed.filter(item => item.status === "failed").length,
    waiting: processed.filter(item => item.status === "waiting_configuration").length, retrying: processed.filter(item => item.status === "retry").length };
}

export async function processEmailDelivery(redis, id, options = {}) {
  const record = await redis.get(deliveryKey(String(id || "")));
  if (!record) return null;
  if (!["queued", "retry", "waiting_configuration"].includes(record.status)) return safeEmailDelivery(record);
  const atMs = Number(options.atMs || Date.now());
  return safeEmailDelivery(await deliver(redis, record, {
    environment: options.environment || process.env,
    fetchImpl: options.fetchImpl || fetch,
    smtpTransportFactory: options.smtpTransportFactory,
    atMs,
  }));
}

export async function retryEmailDelivery(redis, id, actorId = "superadmin") {
  const record = await redis.get(deliveryKey(String(id || "")));
  if (!record) return null;
  if (!RETRYABLE_STATUSES.has(record.status)) return safeEmailDelivery(record);
  const updated = { ...record, status: "queued", nextAttemptAt: now(), updatedAt: now(), lastError: null, retryRequestedBy: safeText(actorId, 120) };
  await redis.set(deliveryKey(record.id), updated);
  return safeEmailDelivery(updated);
}

function decodeBase64(value) {
  try { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }
  catch { return null; }
}

async function verifyWebhookSignature(rawBody, headers, secret, atMs = Date.now()) {
  const id = String(headers.get("svix-id") || "");
  const timestamp = String(headers.get("svix-timestamp") || "");
  const signatures = String(headers.get("svix-signature") || "").split(" ").map(item => item.split(",")).filter(parts => parts[0] === "v1" && parts[1]);
  const timestampSeconds = Number(timestamp);
  if (!id || !Number.isFinite(timestampSeconds) || Math.abs(Math.floor(atMs / 1000) - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS) return { valid: false, id };
  const keyBytes = decodeBase64(String(secret || "").replace(/^whsec_/, ""));
  if (!keyBytes?.length) return { valid: false, id };
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${id}.${timestamp}.${rawBody}`)));
  const valid = signatures.some(([, signature]) => {
    const supplied = decodeBase64(signature);
    if (!supplied || supplied.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) difference |= expected[index] ^ supplied[index];
    return difference === 0;
  });
  return { valid, id };
}

const WEBHOOK_STATUS = Object.freeze({ "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained", "email.suppressed": "suppressed" });

export async function handleResendWebhook(redis, request, environment = process.env, atMs = Date.now()) {
  const rawBody = await request.text();
  const verification = await verifyWebhookSignature(rawBody, request.headers, environment.RESEND_WEBHOOK_SECRET, atMs);
  if (!verification.valid) return { status: 401, body: { error: "Signature webhook Resend tidak valid" } };
  const acquired = await redis.set(webhookEventKey(verification.id), "processing", { nx: true, ex: 60 * 60 * 24 * 30 });
  if (!acquired) return { status: 200, body: { received: true, duplicate: true } };
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { await redis.del(webhookEventKey(verification.id)); return { status: 400, body: { error: "Payload webhook Resend tidak valid" } }; }
  const targetStatus = WEBHOOK_STATUS[payload.type];
  if (!targetStatus) { await redis.set(webhookEventKey(verification.id), "ignored", { ex: 60 * 60 * 24 * 30 }); return { status: 200, body: { received: true, ignored: true } }; }
  const providerMessageId = safeText(payload.data?.email_id || payload.data?.id, 160);
  const deliveryId = providerMessageId ? await redis.get(providerMessageKey(providerMessageId)) : null;
  if (!deliveryId) { await redis.set(webhookEventKey(verification.id), "unmatched", { ex: 60 * 60 * 24 * 30 }); return { status: 202, body: { received: true, matched: false } }; }
  const record = await redis.get(deliveryKey(deliveryId));
  if (!record) return { status: 202, body: { received: true, matched: false } };
  const shouldUpdate = TERMINAL_WEBHOOK_STATUSES.has(targetStatus) || !TERMINAL_WEBHOOK_STATUSES.has(record.status);
  if (shouldUpdate) {
    const timestamp = new Date(atMs).toISOString();
    await redis.set(deliveryKey(deliveryId), { ...record, status: targetStatus, updatedAt: timestamp, deliveredAt: targetStatus === "delivered" ? timestamp : record.deliveredAt, lastError: targetStatus === "delivered" ? null : `Resend melaporkan email ${targetStatus}` });
  }
  await redis.set(webhookEventKey(verification.id), "processed", { ex: 60 * 60 * 24 * 30 });
  return { status: 200, body: { received: true, matched: true } };
}
