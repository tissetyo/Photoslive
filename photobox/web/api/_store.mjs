import { Redis } from "@upstash/redis";

let redis;

export function getRedis() {
  if (redis) return redis;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Cloud storage belum terhubung. Hubungkan Upstash Redis pada project Vercel Photoslive.");
  }
  redis = new Redis({ url, token });
  return redis;
}

export function now() {
  return new Date().toISOString();
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function pairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const value = [...bytes].map(byte => alphabet[byte % alphabet.length]).join("");
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

const authEncoder = new TextEncoder();
const authBytesToHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");

function configuredSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET production belum dikonfigurasi");
  return secret;
}

async function hmacHex(value) {
  const key = await crypto.subtle.importKey("raw", authEncoder.encode(configuredSessionSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return authBytesToHex(await crypto.subtle.sign("HMAC", key, authEncoder.encode(String(value))));
}

export async function authenticateWebSession(redis, request) {
  const cookies = Object.fromEntries((request.headers.get("cookie") || "").split(";").map(value => value.trim()).filter(Boolean).map(value => {
    const index = value.indexOf("=");
    return [value.slice(0, index), decodeURIComponent(value.slice(index + 1))];
  }));
  const [id, supplied] = String(cookies.photoslive_session || "").split(".");
  if (!id || !supplied || supplied !== await hmacHex(id)) return null;
  const record = await redis.get(sessionKey(id));
  if (!record || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) return null;
  return record;
}

export async function signScopedToken(payload) {
  const encoded = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `${encoded}.${await hmacHex(`scope:${encoded}`)}`;
}

export async function verifyScopedToken(token) {
  const [encoded, supplied] = String(token || "").split(".");
  if (!encoded || !supplied || supplied !== await hmacHex(`scope:${encoded}`)) return null;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    if (!payload?.exp || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function machineKey(id) {
  return `photoslive:machine:${id}`;
}

export function boothKey(code) {
  return `photoslive:booth:${String(code || "").toLowerCase()}`;
}

export function userKey(id) {
  return `photoslive:user:${id}`;
}

export function sessionKey(id) {
  return `photoslive:session:${id}`;
}

export function jobKey(id) {
  return `photoslive:job:${id}`;
}

export function queueKey(machineId) {
  return `photoslive:machine:${machineId}:jobs`;
}
