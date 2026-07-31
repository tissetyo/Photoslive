import { redactLogValue } from "./_observability.mjs";

const clean = (value, maximum = 500) => String(value ?? "").trim().slice(0, maximum);
const baseUrl = value => clean(value).replace(/\/+$/g, "");

export function supabaseAuthStatus(environment = process.env) {
  const url = baseUrl(environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL);
  const publishableKey = clean(
    environment.SUPABASE_PUBLISHABLE_KEY
      || environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
      || environment.SUPABASE_ANON_KEY,
    1_000,
  );
  return {
    configured: Boolean(url && publishableKey),
    url,
    publishableKey,
    reason: url && publishableKey ? "" : "Supabase Auth belum dikonfigurasi",
  };
}

async function authRequest(path, {
  method = "POST",
  body,
  accessToken = "",
  environment = process.env,
  fetchImplementation = fetch,
  timeoutMs = 8_000,
} = {}) {
  const status = supabaseAuthStatus(environment);
  if (!status.configured) return { ok: false, status: 503, error: status.reason };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(`${status.url}/auth/v1/${path.replace(/^\/+/, "")}`, {
      method,
      headers: {
        apikey: status.publishableKey,
        authorization: `Bearer ${accessToken || status.publishableKey}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = clean(
        payload?.msg || payload?.message || payload?.error_description || payload?.error || "Supabase Auth gagal",
        300,
      );
      return { ok: false, status: response.status, error: message, code: clean(payload?.code, 80) };
    }
    return { ok: true, status: response.status, payload };
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Supabase Auth timeout. Periksa koneksi lalu coba lagi."
      : error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(redactLogValue({ level: "warn", event: "supabase.auth.failed", path, message })));
    return { ok: false, status: 503, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerSupabaseUser(email, password, options = {}) {
  return authRequest("signup", {
    ...options,
    body: {
      email: clean(email, 160).toLowerCase(),
      password: String(password || ""),
      data: { product: "photoslive" },
    },
  });
}

export async function loginSupabaseUser(email, password, options = {}) {
  return authRequest("token?grant_type=password", {
    ...options,
    body: { email: clean(email, 160).toLowerCase(), password: String(password || "") },
  });
}

export async function refreshSupabaseSession(refreshToken, options = {}) {
  return authRequest("token?grant_type=refresh_token", {
    ...options,
    body: { refresh_token: String(refreshToken || "") },
  });
}

export async function readSupabaseUser(accessToken, options = {}) {
  return authRequest("user", { ...options, method: "GET", accessToken });
}

export async function updateSupabaseUser(accessToken, updates, options = {}) {
  return authRequest("user", {
    ...options,
    method: "PUT",
    accessToken,
    body: updates,
  });
}

export async function logoutSupabaseUser(accessToken, options = {}) {
  return authRequest("logout", { ...options, accessToken, body: {} });
}
