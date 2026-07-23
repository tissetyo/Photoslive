import assert from "node:assert/strict";
import test from "node:test";
import { validateMutationOrigin } from "../api/_csrf.mjs";

test("same-origin browser mutations and safe reads are accepted", () => {
  const mutation = new Request("https://photoslive.test/api/platform?action=profile", { method: "POST", headers: { origin: "https://photoslive.test", "sec-fetch-site": "same-origin" } });
  assert.deepEqual(validateMutationOrigin(mutation), { allowed: true, reason: "same-origin" });
  assert.equal(validateMutationOrigin(new Request("https://photoslive.test/api/platform", { method: "GET", headers: { origin: "https://evil.test" } })).allowed, true);
});

test("cross-site, mismatched, and opaque browser mutation origins are rejected", () => {
  const crossSite = new Request("https://photoslive.test/api/platform", { method: "POST", headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } });
  const mismatch = new Request("https://photoslive.test/api/platform", { method: "POST", headers: { origin: "https://evil.test" } });
  const opaque = new Request("https://photoslive.test/api/platform", { method: "POST", headers: { origin: "null" } });
  assert.equal(validateMutationOrigin(crossSite).allowed, false);
  assert.equal(validateMutationOrigin(mismatch).allowed, false);
  assert.equal(validateMutationOrigin(opaque).allowed, false);
});

test("non-browser Agent or technician requests without Origin remain supported", () => {
  const request = new Request("https://photoslive.test/api/platform?action=setup", { method: "POST", headers: { authorization: "Bearer local-token" } });
  assert.deepEqual(validateMutationOrigin(request), { allowed: true, reason: "non-browser-client" });
});
