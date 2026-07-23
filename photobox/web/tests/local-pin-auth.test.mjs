import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { machineKey } from "../api/_store.mjs";
import { verifyLocalLoginAssertion } from "../api/platform.mjs";

class MemoryRedis {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }
}

const encoder = new TextEncoder();
const toHex = value => [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const toBase64Url = value => Buffer.from(JSON.stringify(value)).toString("base64url");

async function signedAssertion(payload, secret = "local-command-secret") {
  const encoded = toBase64Url(payload);
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`local-login:${encoded}`)));
  return `${encoded}.${signature}`;
}

test("local PIN proof is machine-bound, short-lived, and one-time", async () => {
  const redis = new MemoryRedis();
  const at = Date.now();
  const booth = { machineId: "machine_1", boothCode: "booth-1" };
  await redis.set(machineKey(booth.machineId), { id: booth.machineId, commandKey: "local-command-secret" });
  const payload = {
    v: 1,
    purpose: "admin-pin",
    machineId: booth.machineId,
    boothCode: booth.boothCode,
    nonce: "0123456789abcdef0123456789abcdef",
    iat: at,
    exp: at + 60_000,
  };
  const assertion = await signedAssertion(payload);

  assert.equal((await verifyLocalLoginAssertion(redis, assertion, booth, at + 1)).valid, true);
  assert.match((await verifyLocalLoginAssertion(redis, assertion, booth, at + 2)).error, /sudah digunakan/);

  const expired = await signedAssertion({ ...payload, nonce: "1123456789abcdef0123456789abcdef", iat: at - 120_000, exp: at - 60_000 });
  assert.match((await verifyLocalLoginAssertion(redis, expired, booth, at)).error, /kedaluwarsa/);

  const wrongMachine = await signedAssertion({ ...payload, nonce: "2123456789abcdef0123456789abcdef", machineId: "machine_2" });
  assert.equal((await verifyLocalLoginAssertion(redis, wrongMachine, booth, at)).valid, false);
});

test("remote setup defaults to password and only reveals PIN after local proof discovery", async () => {
  const root = new URL("../", import.meta.url);
  const [html, setupJs, serverPy, platform] = await Promise.all([
    readFile(new URL("setup.html", root), "utf8"),
    readFile(new URL("setup.js", root), "utf8"),
    readFile(new URL("../../server.py", import.meta.url), "utf8"),
    readFile(new URL("../api/platform.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="local-pin-method" class="hidden"/);
  assert.match(html, /class="active" data-login-method="password" aria-pressed="true"/);
  assert.match(setupJs, /\/api\/local\/auth\/capability/);
  assert.match(setupJs, /\/api\/local\/auth\/assertion/);
  assert.match(setupJs, /body\.localAssertion = proof\.assertion/);
  assert.match(serverPy, /Access-Control-Allow-Private-Network/);
  assert.match(serverPy, /def loopback_request/);
  assert.match(platform, /PIN hanya tersedia pada komputer photobox/);
  assert.match(platform, /verifyLocalLoginAssertion/);
});
