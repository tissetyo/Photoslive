import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { clearCookie, sessionCookie } from "../api/platform.mjs";

function attributes(value) {
  return value.split(";").map(part => part.trim());
}

test("admin session cookie uses host-only secure browser attributes", () => {
  const cookie = sessionCookie("login.signature");
  const parts = attributes(cookie);
  assert.equal(parts[0], "__Host-photoslive_session=login.signature");
  assert.ok(parts.includes("Path=/"));
  assert.ok(parts.includes("HttpOnly"));
  assert.ok(parts.includes("Secure"));
  assert.ok(parts.includes("SameSite=Lax"));
  assert.ok(parts.includes("Max-Age=604800"));
  assert.ok(!parts.some(part => /^Domain=/i.test(part)));
});

test("logout clears the same protected cookie and authentication reads no legacy cookie", () => {
  const parts = attributes(clearCookie);
  assert.equal(parts[0], "__Host-photoslive_session=");
  assert.ok(parts.includes("Path=/"));
  assert.ok(parts.includes("HttpOnly"));
  assert.ok(parts.includes("Secure"));
  assert.ok(parts.includes("SameSite=Lax"));
  assert.ok(parts.includes("Max-Age=0"));
  const source = fs.readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");
  const store = fs.readFileSync(new URL("../api/_store.mjs", import.meta.url), "utf8");
  assert.match(source, /cookieMap\(request\)\["__Host-photoslive_session"\]/);
  assert.doesNotMatch(source, /cookieMap\(request\)\.photoslive_session/);
  assert.match(store, /cookies\["__Host-photoslive_session"\]/);
  assert.doesNotMatch(store, /cookies\.photoslive_session/);
});
