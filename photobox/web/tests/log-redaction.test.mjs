import assert from "node:assert/strict";
import test from "node:test";
import { observedError, redactLogValue, requestContext } from "../api/_observability.mjs";

test("structured cloud log redaction removes nested credentials and signed URL values", () => {
  const result = redactLogValue({
    authorization: "Bearer top-secret",
    nested: {
      password: "letmein",
      message: "upload failed https://bucket.test/x?X-Amz-Credential=abc&X-Amz-Signature=deadbeef",
    },
  });
  assert.equal(result.authorization, "[REDACTED]");
  assert.equal(result.nested.password, "[REDACTED]");
  assert.doesNotMatch(result.nested.message, /abc|deadbeef/);
  assert.match(result.nested.message, /\[REDACTED\]/);
});

test("observed cloud errors preserve diagnostics while redacting bearer and cookie secrets", () => {
  const original = console.error;
  const lines = [];
  console.error = value => lines.push(String(value));
  try {
    const context = requestContext(new Request("https://photoslive.test/api"), "test");
    observedError(new Error("Bearer super-secret __Host-photoslive_session=session.signature"), context, { action: "probe" });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /super-secret|session\.signature/);
  assert.match(lines[0], /\[REDACTED\]/);
  assert.match(lines[0], /"action":"probe"/);
});
