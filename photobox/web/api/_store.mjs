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
