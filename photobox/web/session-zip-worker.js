/* Creates an uncompressed ZIP off the main thread. Customer result files are
   already compressed images, so DEFLATE would add CPU cost without useful gain. */
const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeName(value, index) {
  const cleaned = String(value || `file-${index + 1}`).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 100);
  return cleaned || `file-${index + 1}`;
}

function localHeader(name, size, checksum) {
  const bytes = encoder.encode(name);
  const output = new Uint8Array(30 + bytes.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, bytes.length, true);
  output.set(bytes, 30);
  return output;
}

function centralHeader(name, size, checksum, offset) {
  const bytes = encoder.encode(name);
  const output = new Uint8Array(46 + bytes.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, bytes.length, true);
  view.setUint32(42, offset, true);
  output.set(bytes, 46);
  return output;
}

function endRecord(count, centralSize, centralOffset) {
  const output = new Uint8Array(22);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return output;
}

function concatenate(parts, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

self.onmessage = async event => {
  try {
    const files = Array.isArray(event.data?.files) ? event.data.files.slice(0, 32) : [];
    const maxBytes = Math.min(250_000_000, Math.max(1_000_000, Number(event.data?.maxBytes || 150_000_000)));
    if (!files.length) throw new Error("Tidak ada file yang dapat dimasukkan ke ZIP.");
    const locals = [];
    const centrals = [];
    let localSize = 0;
    let payloadSize = 0;
    for (let index = 0; index < files.length; index += 1) {
      const response = await fetch(String(files[index].url || ""), { credentials: "same-origin" });
      if (!response.ok) throw new Error(`File ${index + 1} gagal diambil (${response.status}).`);
      const declared = Number(response.headers.get("content-length") || 0);
      if (declared && payloadSize + declared > maxBytes) throw new Error("Total file terlalu besar untuk ZIP di perangkat ini.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      payloadSize += bytes.byteLength;
      if (payloadSize > maxBytes) throw new Error("Total file terlalu besar untuk ZIP di perangkat ini.");
      const name = safeName(files[index].name, index);
      const checksum = crc32(bytes);
      const header = localHeader(name, bytes.byteLength, checksum);
      locals.push(header, bytes);
      centrals.push(centralHeader(name, bytes.byteLength, checksum, localSize));
      localSize += header.byteLength + bytes.byteLength;
      self.postMessage({ type: "progress", completed: index + 1, total: files.length });
    }
    const centralSize = centrals.reduce((sum, item) => sum + item.byteLength, 0);
    const end = endRecord(files.length, centralSize, localSize);
    const archive = concatenate([...locals, ...centrals, end], localSize + centralSize + end.byteLength);
    self.postMessage({ type: "done", archive: archive.buffer, fileCount: files.length }, [archive.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", error: String(error?.message || "ZIP gagal dibuat.") });
  }
};
