const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function validateMutationOrigin(request) {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { allowed: true, reason: "safe-method" };
  const fetchSite = String(request.headers.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite === "cross-site") return { allowed: false, reason: "cross-site" };
  const origin = String(request.headers.get("origin") || "").trim();
  if (!origin) return { allowed: true, reason: "non-browser-client" };
  if (origin === "null") return { allowed: false, reason: "opaque-origin" };
  try {
    return origin === new URL(request.url).origin
      ? { allowed: true, reason: "same-origin" }
      : { allowed: false, reason: "origin-mismatch" };
  } catch {
    return { allowed: false, reason: "invalid-origin" };
  }
}
