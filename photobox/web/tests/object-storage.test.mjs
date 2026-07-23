import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  abortMultipartUpload,
  completeMultipartUpload,
  deleteObject,
  getObject,
  initiateMultipartUpload,
  inspectObject,
  objectStorageConfiguration,
  presignMultipartPart,
  presignObjectRequest,
  publicObjectStorageStatus,
  putObject,
} = await import("../api/_object_storage.mjs");

const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET: "photoslive-test",
};

test("R2 configuration stays server-only and uses the documented S3 endpoint", () => {
  const configuration = objectStorageConfiguration(R2_ENV);
  assert.equal(configuration.id, "cloudflare-r2");
  assert.equal(configuration.region, "auto");
  assert.equal(configuration.endpoint.host, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(configuration.virtualHosted, false);
  assert.deepEqual(publicObjectStorageStatus(R2_ENV), { available: true, provider: "cloudflare-r2" });
  assert.ok(!JSON.stringify(publicObjectStorageStatus(R2_ENV)).includes("test-secret-key"));
});

test("presigned R2 PUT is short-lived, object-scoped, and binds type plus checksum", async () => {
  const signed = await presignObjectRequest({
    method: "PUT",
    objectKey: "sessions/booth-a/session-a/capture-1.jpg",
    contentType: "image/jpeg",
    checksumSha256: "a".repeat(64),
    contentMd5: "CY9rzUYh03PK3k6DJie09g==",
    expiresIn: 600,
    environment: R2_ENV,
    date: new Date("2026-07-20T01:02:03.000Z"),
  });
  const url = new URL(signed.url);
  assert.equal(url.host, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(url.pathname, "/photoslive-test/sessions/booth-a/session-a/capture-1.jpg");
  assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(url.searchParams.get("X-Amz-Date"), "20260720T010203Z");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-md5;content-type;host;x-amz-meta-sha256");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);
  assert.equal(signed.headers["content-type"], "image/jpeg");
  assert.equal(signed.headers["content-md5"], "CY9rzUYh03PK3k6DJie09g==");
  assert.equal(signed.headers["x-amz-meta-sha256"], "a".repeat(64));
  assert.ok(!signed.url.includes("test-secret-key"));
});

test("S3-compatible storage defaults to path style and configurable region", async () => {
  const environment = { S3_ENDPOINT: "https://objects.example.test", S3_ACCESS_KEY_ID: "key", S3_SECRET_ACCESS_KEY: "secret", S3_BUCKET: "booth-files", S3_REGION: "ap-southeast-1" };
  const signed = await presignObjectRequest({ method: "GET", objectKey: "assets/booth/logo.webp", environment, date: new Date("2026-07-20T01:02:03Z") });
  const url = new URL(signed.url);
  assert.equal(url.host, "objects.example.test");
  assert.equal(url.pathname, "/booth-files/assets/booth/logo.webp");
  assert.match(decodeURIComponent(url.searchParams.get("X-Amz-Credential")), /\/20260720\/ap-southeast-1\/s3\/aws4_request$/);
});

test("server upload and HEAD verification use signed requests without returning credentials", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "4", "content-type": "image/png", "x-amz-meta-sha256": "b".repeat(64), etag: '"etag-1"' } });
    return new Response(null, { status: 200, headers: { etag: '"etag-1"' } });
  };
  const uploaded = await putObject({ objectKey: "assets/a.png", bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/png", checksumSha256: "b".repeat(64), environment: R2_ENV, fetchImpl });
  assert.equal(uploaded.provider, "cloudflare-r2");
  assert.equal(calls[0].options.method, "PUT");
  const inspected = await inspectObject({ objectKey: "assets/a.png", environment: R2_ENV, fetchImpl });
  assert.equal(inspected.size, 4);
  assert.equal(inspected.checksumSha256, "b".repeat(64));
  assert.equal(calls[1].options.method, "HEAD");
  assert.equal(await deleteObject({ objectKey: "assets/a.png", environment: R2_ENV, fetchImpl }), true);
  assert.equal(calls[2].options.method, "DELETE");
});

test("migration download hashes the actual bytes instead of trusting object metadata", async () => {
  const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-length": "4", "content-type": "image/png", "x-amz-meta-sha256": "f".repeat(64) } });
  const object = await getObject({ objectKey: "assets/a.png", environment: R2_ENV, fetchImpl });
  assert.equal(object.size, 4);
  assert.equal(object.metadataChecksumSha256, "f".repeat(64));
  assert.notEqual(object.checksumSha256, object.metadataChecksumSha256);
  assert.match(object.checksumSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(() => getObject({ objectKey: "assets/a.png", environment: R2_ENV, fetchImpl, maximumBytes: 3 }), /batas migrasi/);
});

test("multipart object storage creates, signs, completes, and aborts scoped uploads", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (options.method === "POST" && new URL(url).searchParams.has("uploads")) {
      return new Response("<InitiateMultipartUploadResult><UploadId>r2-upload-1</UploadId></InitiateMultipartUploadResult>", { status: 200 });
    }
    if (options.method === "POST") return new Response('<CompleteMultipartUploadResult><ETag>"whole-etag"</ETag></CompleteMultipartUploadResult>', { status: 200 });
    return new Response(null, { status: 204 });
  };
  const initiated = await initiateMultipartUpload({
    objectKey: "sessions/booth/session/large.gif",
    contentType: "image/gif",
    checksumSha256: "c".repeat(64),
    environment: R2_ENV,
    fetchImpl,
  });
  assert.equal(initiated.multipartUploadId, "r2-upload-1");
  assert.equal(calls[0].url.searchParams.get("uploads"), "");
  assert.equal(calls[0].options.headers["x-amz-meta-sha256"], "c".repeat(64));

  const part = await presignMultipartPart({
    objectKey: initiated.objectKey,
    multipartUploadId: initiated.multipartUploadId,
    partNumber: 2,
    environment: R2_ENV,
    date: new Date("2026-07-20T01:02:03Z"),
  });
  const partUrl = new URL(part.url);
  assert.equal(partUrl.searchParams.get("partNumber"), "2");
  assert.equal(partUrl.searchParams.get("uploadId"), "r2-upload-1");
  assert.match(partUrl.searchParams.get("X-Amz-Signature"), /^[a-f0-9]{64}$/);

  const completed = await completeMultipartUpload({
    objectKey: initiated.objectKey,
    multipartUploadId: initiated.multipartUploadId,
    parts: [{ partNumber: 2, etag: '"etag-2"' }, { partNumber: 1, etag: '"etag-1"' }],
    environment: R2_ENV,
    fetchImpl,
  });
  assert.equal(completed.etag, '"whole-etag"');
  assert.ok(calls[1].options.body.indexOf("<PartNumber>1</PartNumber>") < calls[1].options.body.indexOf("<PartNumber>2</PartNumber>"));
  assert.equal(await abortMultipartUpload({ objectKey: initiated.objectKey, multipartUploadId: initiated.multipartUploadId, environment: R2_ENV, fetchImpl }), true);
  assert.equal(calls[2].options.method, "DELETE");
});

test("object storage is explicit when no provider is configured", async () => {
  assert.equal(objectStorageConfiguration({}), null);
  assert.deepEqual(publicObjectStorageStatus({}), { available: false, provider: null });
  assert.equal(await presignObjectRequest({ method: "GET", objectKey: "a/b.jpg", environment: {} }), null);
});

test("bridge exposes the direct Agent upload contract and keeps legacy fallback explicit", async () => {
  const [bridge, agent, providers] = await Promise.all([
    readFile(new URL("../api/bridge.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../agent.py", import.meta.url), "utf8"),
    readFile(new URL("../api/_providers.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(bridge, /prepare_session_file/);
  assert.match(bridge, /finalize_session_file/);
  assert.match(bridge, /prepare_session_file_part/);
  assert.match(bridge, /complete_session_file_multipart/);
  assert.match(bridge, /legacy-redis/);
  assert.match(agent, /prepare_session_file/);
  assert.match(agent, /upload_presigned_file/);
  assert.match(agent, /finalize_session_file/);
  assert.match(agent, /multipart-object-storage/);
  assert.match(agent, /\/api\/local\/sync\/multipart/);
  assert.match(bridge, /direct-object-storage/);
  assert.match(bridge, /resolveProviderRuntimeForCapability/);
  assert.match(bridge, /storageRuntimeForMachine/);
  assert.match(bridge, /environment: runtime\?\.environment \|\| process\.env/);
  assert.match(providers, /cloudAssets:.*direct-object-storage/);
  assert.match(providers, /cloudAssets:.*25_000_000/);
});

test("admin and setup asset upload use prepare, direct PUT, and finalize", async () => {
  const [platform, admin, setup] = await Promise.all([
    readFile(new URL("../api/platform.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app.js", import.meta.url), "utf8"),
    readFile(new URL("../setup.js", import.meta.url), "utf8"),
  ]);
  for (const source of [admin, setup]) {
    assert.match(source, /\/prepare/);
    assert.match(source, /method:\s*"PUT"/);
    assert.match(source, /\/finalize/);
  }
  assert.match(platform, /assetUploadIntentKey/);
  assert.match(platform, /inspectObject/);
  assert.match(platform, /storageMode:\s*"object-storage"/);
  assert.match(platform, /featureFlags\.direct_object_upload\.enabled/);
  assert.match(platform, /deploymentCapabilitiesForBooth/);
  assert.match(platform, /storageRuntime\(redis, booth, intent\.provider\)/);
  assert.match(admin, /directObjectUploadEnabled/);
  assert.match(setup, /featureFlags\?\.direct_object_upload\?\.enabled !== false/);
  assert.match(admin, /2_000_000/);
  assert.match(setup, /dibatasi 2 MB/);
});
