import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("customer result page exposes 24-hour expiry, individual originals, and retryable ZIP UI", async () => {
  const [html, script, platform] = await Promise.all([read("session.html"), read("session.js"), read("api/platform.mjs")]);
  assert.match(platform, /PUBLIC_SESSION_TTL_SECONDS = 86_400/);
  assert.match(platform, /publicSessionRemainingTtl\(record\)/);
  assert.match(script, /file\.kind === "capture"/);
  assert.match(script, /download="photoslive-\$\{sessionCode\}-foto-\$\{index \+ 1\}\.jpg"/);
  assert.match(html, /id="download-all" disabled/);
  assert.match(html, /id="download-all-status" role="status" aria-live="polite"/);
  assert.match(script, /new Worker\("\/session-zip-worker\.js\?v=1"\)/);
  assert.match(script, /Coba download ZIP lagi/);
});

test("ZIP worker builds a valid archive off the main thread with bounded input", async () => {
  const source = await read("session-zip-worker.js");
  const messages = [];
  const context = {
    ArrayBuffer,
    DataView,
    TextEncoder,
    Uint8Array,
    self: { postMessage(message) { messages.push(message); } },
    fetch: async url => {
      const body = new TextEncoder().encode(url.endsWith("/one") ? "first-photo" : "second-photo");
      return new Response(body, { status: 200, headers: { "content-length": String(body.byteLength) } });
    },
    Response,
  };
  vm.runInNewContext(source, context, { filename: "session-zip-worker.js" });
  await context.self.onmessage({ data: { files: [{ url: "/one", name: "foto 1.jpg" }, { url: "/two", name: "hasil-frame.jpg" }], maxBytes: 1_000_000 } });
  const done = messages.find(message => message.type === "done");
  assert.ok(done);
  assert.equal(done.fileCount, 2);
  assert.deepEqual(messages.filter(message => message.type === "progress").map(message => message.completed), [1, 2]);
  const archive = new Uint8Array(done.archive);
  const view = new DataView(archive.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(archive.byteLength - 22, true), 0x06054b50);
  assert.equal(view.getUint16(archive.byteLength - 12, true), 2);
  assert.match(new TextDecoder().decode(archive), /foto-1\.jpg/);
  assert.match(new TextDecoder().decode(archive), /hasil-frame\.jpg/);
});

test("ZIP worker reports an actionable size error without producing a partial archive", async () => {
  const source = await read("session-zip-worker.js");
  const messages = [];
  const context = {
    ArrayBuffer,
    DataView,
    TextEncoder,
    Uint8Array,
    self: { postMessage(message) { messages.push(message); } },
    fetch: async () => new Response(new Uint8Array(1_100_000), { status: 200, headers: { "content-length": "1100000" } }),
    Response,
  };
  vm.runInNewContext(source, context, { filename: "session-zip-worker.js" });
  await context.self.onmessage({ data: { files: [{ url: "/large", name: "large.jpg" }], maxBytes: 1_000_000 } });
  assert.equal(messages.at(-1).type, "error");
  assert.match(messages.at(-1).error, /terlalu besar/);
  assert.equal(messages.some(message => message.type === "done"), false);
});
