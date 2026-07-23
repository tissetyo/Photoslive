const $ = selector => document.querySelector(selector);
const parts = location.pathname.split("/").filter(Boolean);
const params = new URLSearchParams(location.search);
const boothCode = params.get("booth") || parts[0];
const sessionCode = params.get("session") || (parts[1] === "sesi" ? parts[2] : parts[1]);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let downloadableFiles = [];
let zipWorker = null;

async function jsonApi(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 10_000));
  try {
    const response = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request gagal (${response.status})`);
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Cloud terlalu lama merespons");
    throw error;
  } finally { clearTimeout(timeout); }
}

async function controllerRequest(machineId, path) {
  const { job } = await jsonApi("/api/bridge?action=enqueue_job", {
    method: "POST",
    body: JSON.stringify({ machineId, type: "controller.request", ttlSeconds: 30, payload: { path, method: "GET" } }),
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await wait(600);
    const { job: state } = await jsonApi(`/api/bridge?action=job_status&machineId=${encodeURIComponent(machineId)}&jobId=${encodeURIComponent(job.id)}`);
    if (state.status === "completed") return state.result || {};
    if (state.status === "failed") throw new Error(state.error || "Agent gagal mengambil hasil");
  }
  throw new Error("Agent tidak merespons");
}

function binaryUrl(result) {
  const bytes = Uint8Array.from(atob(result.bodyBase64 || ""), character => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: result.contentType || "image/jpeg" }));
}

function normalizedFiles(files = []) {
  return files.map(file => ({
    ...file,
    id: String(file.id || ""),
    kind: String(file.kind || file.fileKind || "capture"),
    slotIndex: Number(file.slotIndex || 0),
  }));
}

function mergeFiles(current, incoming) {
  const merged = new Map(current.map(file => [file.id || `${file.kind}:${file.slotIndex}`, file]));
  for (const file of incoming) merged.set(file.id || `${file.kind}:${file.slotIndex}`, file);
  return [...merged.values()];
}

function renderResults(files) {
  const captures = files
    .filter(file => file.kind === "capture")
    .sort((a, b) => a.slotIndex - b.slotIndex);
  const composite = files.find(file => file.kind === "composite");
  const gif = files.find(file => file.kind === "gif");
  downloadableFiles = [
    ...captures.map((file, index) => ({ url: file.url, name: `foto-${index + 1}.${file.contentType === "image/png" ? "png" : file.contentType === "image/webp" ? "webp" : "jpg"}` })),
    ...(composite?.url ? [{ url: composite.url, name: `hasil-frame.${composite.contentType === "image/png" ? "png" : composite.contentType === "image/webp" ? "webp" : "jpg"}` }] : []),
    ...(gif?.url ? [{ url: gif.url, name: "flipbook.gif" }] : []),
  ];
  $("#download-all").disabled = downloadableFiles.length === 0;

  $("#raw-photos").innerHTML = captures.length
    ? captures.map((file, index) => `<article class="photo-item"><img src="${file.url}" alt="Foto ${index + 1}"><div class="photo-actions"><b>Foto ${index + 1}</b><a href="${file.url}" download="photoslive-${sessionCode}-foto-${index + 1}.jpg">Download</a></div></article>`).join("")
    : '<p class="result-empty">Foto satuan masih diproses. Muat ulang halaman ini beberapa saat lagi.</p>';

  const flipbook = $("#flipbook");
  const gifDownload = $("#download-gif");
  if (gif?.url) {
    flipbook.innerHTML = `<img class="rendered-gif" src="${gif.url}" alt="GIF flipbook hasil sesi">`;
    gifDownload.disabled = false;
    gifDownload.onclick = () => {
      const link = document.createElement("a");
      link.download = `photoslive-${sessionCode}-flipbook.gif`;
      link.href = gif.url;
      document.body.append(link);
      link.click();
      link.remove();
    };
  } else {
    flipbook.innerHTML = captures.slice(0, 4)
      .map((file, index) => `<img src="${file.url}" alt="Preview flipbook ${index + 1}">`).join("");
    gifDownload.disabled = true;
    gifDownload.onclick = null;
  }

  const container = $("#composite-preview");
  const download = $("#download-composite");
  if (!composite?.url) {
    container.innerHTML = '<p class="result-empty">Hasil frame belum selesai diunggah. Foto satuan tetap aman dan dapat diunduh.</p>';
    download.disabled = true;
    download.onclick = null;
    return;
  }
  container.innerHTML = `<img src="${composite.url}" alt="Hasil foto dengan frame">`;
  download.disabled = false;
  download.onclick = () => {
    const link = document.createElement("a");
    link.download = `photoslive-${sessionCode}-hasil-frame.jpg`;
    link.href = composite.url;
    document.body.append(link);
    link.click();
    link.remove();
  };
}

function stopZipWorker() {
  zipWorker?.terminate();
  zipWorker = null;
}

function downloadAllResults() {
  if (!downloadableFiles.length || zipWorker) return;
  const button = $("#download-all");
  const status = $("#download-all-status");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Menyiapkan ZIP…";
  status.textContent = "Mengambil file 0 dari " + downloadableFiles.length;
  zipWorker = new Worker("/session-zip-worker.js?v=1");
  zipWorker.onmessage = event => {
    const message = event.data || {};
    if (message.type === "progress") {
      status.textContent = `Mengambil file ${message.completed} dari ${message.total}`;
      return;
    }
    if (message.type === "done") {
      const url = URL.createObjectURL(new Blob([message.archive], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `photoslive-${sessionCode}-semua.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
      status.textContent = `${message.fileCount} file berhasil dimasukkan ke ZIP.`;
      stopZipWorker();
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Download semua (.zip)";
      return;
    }
    if (message.type === "error") {
      status.textContent = `${message.error} Tekan tombol untuk mencoba lagi.`;
      stopZipWorker();
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Coba download ZIP lagi";
    }
  };
  zipWorker.onerror = () => {
    status.textContent = "ZIP gagal dibuat di perangkat ini. Tekan tombol untuk mencoba lagi.";
    stopZipWorker();
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = "Coba download ZIP lagi";
  };
  zipWorker.postMessage({ files: downloadableFiles, maxBytes: 150_000_000 });
}

async function cloudSession() {
  return jsonApi(`/api/platform?action=public_session&booth=${encodeURIComponent(boothCode)}&session=${encodeURIComponent(sessionCode)}`);
}

async function localSessionFiles(session) {
  const local = await controllerRequest(session.machineId, `/api/sessions/${encodeURIComponent(session.shareCode)}`);
  const records = normalizedFiles(local.session?.files || [])
    .filter(file => ["composite", "gif"].includes(file.kind) || (file.kind === "capture" && file.selected));
  const files = [];
  for (const file of records) {
    files.push({ ...file, url: binaryUrl(await controllerRequest(session.machineId, `/api/session-files/${encodeURIComponent(file.id)}`)) });
  }
  return files;
}

async function refreshGifInBackground(session, booth, currentFiles) {
  let files = currentFiles;
  for (let attempt = 0; attempt < 10 && !files.some(file => file.kind === "gif"); attempt += 1) {
    await wait(1500);
    try {
      const latest = await cloudSession();
      files = mergeFiles(files, normalizedFiles(latest.session.files || []));
      if (!files.some(file => file.kind === "gif") && attempt >= 2 && booth.online && session.machineId) {
        files = mergeFiles(files, await localSessionFiles(session));
      }
      renderResults(files);
    } catch { /* hasil utama tetap dapat dipakai; polling berikutnya mencoba lagi */ }
  }
}

async function resolveSessionFiles(session, booth) {
  let files = normalizedFiles(session.files || []);
  for (let attempt = 0; attempt < 5 && !files.some(file => file.kind === "composite"); attempt += 1) {
    await wait(1200);
    const latest = await cloudSession();
    files = mergeFiles(files, normalizedFiles(latest.session.files || []));
  }
  if (!files.some(file => file.kind === "composite") && booth.online && session.machineId) {
    try { files = mergeFiles(files, await localSessionFiles(session)); } catch { /* cloud files remain usable */ }
  }
  if (!files.length) {
    throw new Error(booth.online
      ? "Hasil foto belum selesai diproses. Coba muat ulang beberapa saat lagi."
      : "Upload foto belum selesai. Buka lagi halaman ini saat mesin kembali online.");
  }
  return files;
}

async function init() {
  try {
    if (!boothCode || !sessionCode) throw new Error("Link sesi tidak valid");
    const { session, booth } = await cloudSession();
    const files = await resolveSessionFiles(session, booth);
    renderResults(files);
    $("#expiry-note").textContent = `Tersedia sampai ${new Date(session.expiresAt).toLocaleString("id-ID")}. Simpan semua file sebelum waktu tersebut.`;
    $("#session-loading").classList.add("hidden");
    $("#session-content").classList.remove("hidden");
    void refreshGifInBackground(session, booth, files);
  } catch (error) {
    $("#session-loading").classList.add("hidden");
    $("#session-error").textContent = error.message;
  }
}

const deleteDialog = $("#delete-session-dialog");
const deleteButton = $("#delete-session");
const deleteConfirm = $("#delete-session-confirm");
const deleteCancel = $("#delete-session-cancel");

deleteButton.addEventListener("click", () => {
  $("#delete-session-status").textContent = "";
  deleteDialog.showModal();
});

deleteCancel.addEventListener("click", () => deleteDialog.close());
$("#download-all").addEventListener("click", downloadAllResults);
deleteConfirm.addEventListener("click", async () => {
  deleteConfirm.disabled = true;
  deleteCancel.disabled = true;
  deleteConfirm.textContent = "Menghapus…";
  $("#delete-session-status").textContent = "Menghapus file dari cloud. Jangan tutup halaman ini.";
  try {
    const result = await jsonApi("/api/platform?action=delete_public_session", {
      method: "POST",
      body: JSON.stringify({ booth: boothCode, session: sessionCode, confirm: "hapus" }),
      timeoutMs: 20_000,
    });
    deleteDialog.close();
    $("#session-content").classList.add("hidden");
    $("#session-error").textContent = result.localDeletion?.status === "queued"
      ? "Hasil online sudah dihapus. Penghapusan salinan lokal sedang dikirim ke mesin."
      : "Hasil online sudah dihapus. Salinan lokal akan mengikuti kebijakan retensi mesin.";
  } catch (error) {
    $("#delete-session-status").textContent = error.message;
  } finally {
    deleteConfirm.disabled = false;
    deleteCancel.disabled = false;
    deleteConfirm.textContent = "Hapus permanen";
  }
});

init();
