const encoder = new TextEncoder();

const rfc3986 = value => encodeURIComponent(String(value)).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");

async function sha256(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value));
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key, value) {
  const imported = await crypto.subtle.importKey("raw", key instanceof Uint8Array ? key : encoder.encode(String(key)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(String(value))));
}

async function signingKey(secret, date, region) {
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function cleanEndpoint(value) {
  const endpoint = new URL(String(value));
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function objectStorageConfiguration(environment = process.env) {
  const r2Ready = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].every(key => Boolean(environment[key]));
  if (r2Ready) {
    return {
      id: "cloudflare-r2",
      endpoint: cleanEndpoint(`https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`),
      bucket: String(environment.R2_BUCKET),
      accessKeyId: String(environment.R2_ACCESS_KEY_ID),
      secretAccessKey: String(environment.R2_SECRET_ACCESS_KEY),
      sessionToken: String(environment.R2_SESSION_TOKEN || ""),
      region: "auto",
      // Endpoint S3 R2 resmi memakai /<bucket>/<object> pada host account.
      // Bucket-as-subdomain tidak kompatibel dengan endpoint ini.
      virtualHosted: false,
    };
  }
  const s3Ready = ["S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_BUCKET"].every(key => Boolean(environment[key]));
  if (s3Ready) {
    return {
      id: "s3-compatible",
      endpoint: cleanEndpoint(environment.S3_ENDPOINT),
      bucket: String(environment.S3_BUCKET),
      accessKeyId: String(environment.S3_ACCESS_KEY_ID),
      secretAccessKey: String(environment.S3_SECRET_ACCESS_KEY),
      sessionToken: String(environment.S3_SESSION_TOKEN || ""),
      region: String(environment.S3_REGION || "us-east-1"),
      virtualHosted: !truthy(environment.S3_FORCE_PATH_STYLE, true),
    };
  }
  return null;
}

function objectTarget(configuration, objectKey) {
  const safeKey = String(objectKey || "").split("/").filter(Boolean).map(rfc3986).join("/");
  if (!safeKey || safeKey.includes("..")) throw new Error("Object key tidak valid");
  const endpoint = new URL(configuration.endpoint);
  if (configuration.virtualHosted) {
    endpoint.hostname = `${configuration.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${safeKey}`;
  } else {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/${rfc3986(configuration.bucket)}/${safeKey}`;
  }
  return endpoint;
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function canonicalQuery(parameters) {
  return [...parameters.entries()]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export async function presignObjectRequest({ method, objectKey, contentType = "", checksumSha256 = "", contentMd5 = "", queryParameters = {}, expiresIn = 600, environment = process.env, date = new Date() } = {}) {
  const configuration = objectStorageConfiguration(environment);
  if (!configuration) return null;
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (!["GET", "PUT", "POST", "HEAD", "DELETE"].includes(normalizedMethod)) throw new Error("Operasi object storage tidak didukung");
  const boundedExpiry = Math.max(1, Math.min(3600, Number(expiresIn || 600)));
  const target = objectTarget(configuration, objectKey);
  const timestamp = amzTimestamp(date);
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${configuration.region}/s3/aws4_request`;
  const signedHeaderValues = { host: target.host };
  if (contentType) signedHeaderValues["content-type"] = String(contentType).trim().toLowerCase();
  if (contentMd5) signedHeaderValues["content-md5"] = String(contentMd5).trim();
  if (checksumSha256) signedHeaderValues["x-amz-meta-sha256"] = String(checksumSha256).trim().toLowerCase();
  if (configuration.sessionToken) signedHeaderValues["x-amz-security-token"] = configuration.sessionToken;
  const signedHeaders = Object.keys(signedHeaderValues).sort();
  const headers = Object.fromEntries(signedHeaders.filter(name => name !== "host").map(name => [name, signedHeaderValues[name]]));
  const parameters = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${configuration.accessKeyId}/${scope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(boundedExpiry),
    "X-Amz-SignedHeaders": signedHeaders.join(";"),
  });
  for (const [name, value] of Object.entries(queryParameters || {})) {
    if (value !== undefined && value !== null) parameters.append(String(name), String(value));
  }
  if (configuration.sessionToken) parameters.set("X-Amz-Security-Token", configuration.sessionToken);
  const query = canonicalQuery(parameters);
  const canonicalHeaders = `${signedHeaders.map(name => `${name}:${signedHeaderValues[name].replace(/\s+/g, " ")}`).join("\n")}\n`;
  const canonicalRequest = `${normalizedMethod}\n${target.pathname}\n${query}\n${canonicalHeaders}\n${signedHeaders.join(";")}\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await sha256(canonicalRequest)}`;
  const signature = hex(await hmac(await signingKey(configuration.secretAccessKey, day, configuration.region), stringToSign));
  target.search = `${query}&X-Amz-Signature=${signature}`;
  return { provider: configuration.id, objectKey: String(objectKey), url: target.toString(), method: normalizedMethod, headers, expiresAt: new Date(date.getTime() + boundedExpiry * 1000).toISOString() };
}

function xmlValue(xml, name) {
  const match = String(xml || "").match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match?.[1]?.trim() || "";
}

export async function initiateMultipartUpload({ objectKey, contentType, checksumSha256 = "", environment = process.env, fetchImpl = fetch } = {}) {
  const signed = await presignObjectRequest({
    method: "POST",
    objectKey,
    contentType,
    checksumSha256,
    queryParameters: { uploads: "" },
    environment,
    expiresIn: 60,
  });
  if (!signed) return null;
  const response = await fetchImpl(signed.url, { method: "POST", headers: signed.headers });
  const xml = await response.text();
  if (!response.ok) throw new Error(`Multipart initiate gagal (${response.status})`);
  const multipartUploadId = xmlValue(xml, "UploadId");
  if (!multipartUploadId) throw new Error("Object storage tidak mengembalikan multipart upload ID");
  return { provider: signed.provider, objectKey: signed.objectKey, multipartUploadId };
}

export async function presignMultipartPart({ objectKey, multipartUploadId, partNumber, environment = process.env, expiresIn = 600 } = {}) {
  const safePartNumber = Number(partNumber);
  if (!Number.isInteger(safePartNumber) || safePartNumber < 1 || safePartNumber > 10_000) throw new Error("Nomor part multipart tidak valid");
  if (!String(multipartUploadId || "").trim()) throw new Error("Multipart upload ID wajib diisi");
  return presignObjectRequest({
    method: "PUT",
    objectKey,
    queryParameters: { partNumber: safePartNumber, uploadId: multipartUploadId },
    environment,
    expiresIn,
  });
}

export async function completeMultipartUpload({ objectKey, multipartUploadId, parts, environment = process.env, fetchImpl = fetch } = {}) {
  const normalizedParts = (Array.isArray(parts) ? parts : [])
    .map(part => ({ partNumber: Number(part?.partNumber), etag: String(part?.etag || "").trim() }))
    .filter(part => Number.isInteger(part.partNumber) && part.partNumber > 0 && part.partNumber <= 10_000 && part.etag);
  if (!normalizedParts.length) throw new Error("Daftar part multipart kosong");
  const unique = new Set(normalizedParts.map(part => part.partNumber));
  if (unique.size !== normalizedParts.length) throw new Error("Nomor part multipart duplikat");
  normalizedParts.sort((left, right) => left.partNumber - right.partNumber);
  const signed = await presignObjectRequest({
    method: "POST",
    objectKey,
    queryParameters: { uploadId: multipartUploadId },
    environment,
    expiresIn: 60,
  });
  if (!signed) return null;
  const body = `<CompleteMultipartUpload>${normalizedParts.map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag.replace(/[<>&]/g, "")}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const response = await fetchImpl(signed.url, { method: "POST", headers: { ...signed.headers, "content-type": "application/xml" }, body });
  const xml = await response.text();
  if (!response.ok || /<Error>/i.test(xml)) throw new Error(`Multipart completion gagal (${response.status})`);
  return { provider: signed.provider, objectKey: signed.objectKey, etag: xmlValue(xml, "ETag") };
}

export async function abortMultipartUpload({ objectKey, multipartUploadId, environment = process.env, fetchImpl = fetch } = {}) {
  const signed = await presignObjectRequest({ method: "DELETE", objectKey, queryParameters: { uploadId: multipartUploadId }, environment, expiresIn: 60 });
  if (!signed) return false;
  const response = await fetchImpl(signed.url, { method: "DELETE", headers: signed.headers });
  if (!response.ok && response.status !== 404) throw new Error(`Multipart abort gagal (${response.status})`);
  return true;
}

export async function inspectObject({ objectKey, environment = process.env, fetchImpl = fetch } = {}) {
  const signed = await presignObjectRequest({ method: "HEAD", objectKey, environment, expiresIn: 60 });
  if (!signed) return null;
  const response = await fetchImpl(signed.url, { method: "HEAD", headers: signed.headers });
  if (!response.ok) throw new Error(`Object storage HEAD gagal (${response.status})`);
  return {
    provider: signed.provider,
    objectKey: signed.objectKey,
    size: Number(response.headers.get("content-length") || 0),
    contentType: response.headers.get("content-type") || "application/octet-stream",
    checksumSha256: response.headers.get("x-amz-meta-sha256") || "",
    etag: response.headers.get("etag") || "",
  };
}

export async function putObject({ objectKey, bytes, contentType, checksumSha256 = "", environment = process.env, fetchImpl = fetch } = {}) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const checksum = checksumSha256 || await sha256(body);
  const signed = await presignObjectRequest({ method: "PUT", objectKey, contentType, checksumSha256: checksum, environment, expiresIn: 300 });
  if (!signed) return null;
  const response = await fetchImpl(signed.url, { method: "PUT", headers: signed.headers, body });
  if (!response.ok) throw new Error(`Object storage PUT gagal (${response.status})`);
  return { provider: signed.provider, objectKey: signed.objectKey, checksumSha256: checksum, etag: response.headers.get("etag") || "" };
}

export async function getObject({ objectKey, environment = process.env, fetchImpl = fetch, maximumBytes = 25_000_000 } = {}) {
  const signed = await presignObjectRequest({ method: "GET", objectKey, environment, expiresIn: 300 });
  if (!signed) return null;
  const response = await fetchImpl(signed.url, { method: "GET", headers: signed.headers });
  if (!response.ok) throw new Error(`Object storage GET gagal (${response.status})`);
  const declared = Number(response.headers.get("content-length") || 0);
  const limit = Math.max(1, Math.min(100_000_000, Number(maximumBytes || 25_000_000)));
  if (declared > limit) throw new Error("Object storage melebihi batas migrasi");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error("Object storage melebihi batas migrasi");
  const checksumSha256 = await sha256(bytes);
  return {
    provider: signed.provider,
    objectKey: signed.objectKey,
    bytes,
    size: bytes.byteLength,
    contentType: response.headers.get("content-type") || "application/octet-stream",
    checksumSha256,
    metadataChecksumSha256: response.headers.get("x-amz-meta-sha256") || "",
    etag: response.headers.get("etag") || "",
  };
}

export async function deleteObject({ objectKey, environment = process.env, fetchImpl = fetch } = {}) {
  const signed = await presignObjectRequest({ method: "DELETE", objectKey, environment, expiresIn: 60 });
  if (!signed) return false;
  const response = await fetchImpl(signed.url, { method: "DELETE", headers: signed.headers });
  if (!response.ok && response.status !== 404) throw new Error(`Object storage DELETE gagal (${response.status})`);
  return true;
}

export function publicObjectStorageStatus(environment = process.env) {
  const configuration = objectStorageConfiguration(environment);
  return configuration ? { available: true, provider: configuration.id } : { available: false, provider: null };
}

export async function probeObjectStorage({ environment = process.env, fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const configuration = objectStorageConfiguration(environment);
  if (!configuration) return { provider: null, state: "not_configured", latencyMs: null, message: "Object storage belum dikonfigurasi" };
  const startedAt = performance.now();
  const boundedTimeout = Math.max(250, Math.min(5000, Number(timeoutMs || 3000)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), boundedTimeout);
  try {
    const signed = await presignObjectRequest({
      method: "HEAD",
      objectKey: `.photoslive/health-${crypto.randomUUID()}`,
      environment,
      expiresIn: 30,
    });
    const response = await fetchImpl(signed.url, { method: "HEAD", headers: signed.headers, signal: controller.signal });
    const latencyMs = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
    if (response.ok || response.status === 404) {
      return { provider: configuration.id, state: "ready", latencyMs, message: "Credential dan endpoint storage dapat dijangkau" };
    }
    return { provider: configuration.id, state: "error", latencyMs, message: `Probe storage gagal (${response.status})` };
  } catch (error) {
    const latencyMs = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
    const message = error?.name === "AbortError" ? `Probe storage timeout setelah ${boundedTimeout} ms` : "Endpoint storage tidak dapat dijangkau";
    return { provider: configuration.id, state: "error", latencyMs, message };
  } finally {
    clearTimeout(timeout);
  }
}
