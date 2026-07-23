const encoder = new TextEncoder();

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function clientAddress(request) {
  return String(
    request.headers.get("x-vercel-forwarded-for")
      || request.headers.get("x-forwarded-for")
      || request.headers.get("x-real-ip")
      || "unknown",
  ).split(",")[0].trim().slice(0, 80);
}

export const PLATFORM_RATE_LIMITS = Object.freeze({
  login: { limit: 10, windowSeconds: 60 },
  superadmin_login: { limit: 5, windowSeconds: 60 },
  platform_staff_activate: { limit: 8, windowSeconds: 600 },
  booth_ownership: { limit: 5, windowSeconds: 600 },
  forgot_password: { limit: 5, windowSeconds: 600 },
  validate_setup: { limit: 20, windowSeconds: 300 },
  setup: { limit: 10, windowSeconds: 600 },
  delete_public_session: { limit: 5, windowSeconds: 600 },
  qris_create: { limit: 8, windowSeconds: 60 },
});

export async function consumeRateLimit(redis, request, scope, rule, identity = "") {
  if (!rule || !Number.isInteger(rule.limit) || !Number.isInteger(rule.windowSeconds)) return { allowed: true, remaining: null, retryAfter: 0 };
  const fingerprint = await digest(`${scope}|${clientAddress(request)}|${String(identity).trim().toLowerCase().slice(0, 160)}`);
  const bucket = Math.floor(Date.now() / (rule.windowSeconds * 1000));
  const key = `photoslive:rate-limit:${scope}:${bucket}:${fingerprint}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, rule.windowSeconds + 5);
  const retryAfter = Math.max(1, Math.ceil(((bucket + 1) * rule.windowSeconds * 1000 - Date.now()) / 1000));
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfter,
    limit: rule.limit,
  };
}
