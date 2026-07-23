const HEADER_LIMIT = 128;
export const CLOUD_PROTOCOL_VERSION = "2";
const SENSITIVE_KEY = /authorization|cookie|token|secret|password|passphrase|pin(?:hash)?|api[-_]?key|credential|signature|access[-_]?key|command[-_]?key/i;
const TEXT_PATTERNS = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [/(__Host-photoslive_session=)[^;\s]+/gi, "$1[REDACTED]"],
  [/((?:token|secret|password|pin|api[-_]?key|signature|credential)\s*[=:]\s*)[^&,;\s]+/gi, "$1[REDACTED]"],
  [/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s]+/gi, "$1[REDACTED]"],
];

function redactText(value, limit = 1_000) {
  let text = String(value ?? "").slice(0, Math.max(0, limit));
  for (const [pattern, replacement] of TEXT_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function redactLogValue(value, depth = 0) {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactLogValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key.slice(0, 120), SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactLogValue(item, depth + 1)]));
  }
  return typeof value === "string" ? redactText(value) : value;
}

function safeCorrelationId(value) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, HEADER_LIMIT);
  return normalized || crypto.randomUUID();
}

export function requestContext(request, surface) {
  return {
    id: safeCorrelationId(request.headers.get("x-correlation-id") || request.headers.get("x-request-id")),
    surface,
    method: request.method,
    startedAt: performance.now(),
  };
}

export function observedResponse(response, context, details = {}) {
  const durationMs = Math.max(0, performance.now() - context.startedAt);
  const headers = new Headers(response.headers);
  headers.set("x-correlation-id", context.id);
  headers.set("server-timing", `app;dur=${durationMs.toFixed(1)}`);
  headers.set("x-photoslive-protocol-version", CLOUD_PROTOCOL_VERSION);
  console.log(JSON.stringify(redactLogValue({
    level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
    event: "http.request",
    correlationId: context.id,
    surface: context.surface,
    method: context.method,
    status: response.status,
    durationMs: Number(durationMs.toFixed(1)),
    ...details,
  })));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function observedError(error, context, details = {}) {
  console.error(JSON.stringify(redactLogValue({
    level: "error",
    event: "http.error",
    correlationId: context.id,
    surface: context.surface,
    method: context.method,
    error: error instanceof Error ? error.message : String(error),
    ...details,
  })));
}
