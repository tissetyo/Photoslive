const $ = selector => document.querySelector(selector);
const parts = location.pathname.split("/").filter(Boolean);
const params = new URLSearchParams(location.search);
const boothCode = params.get("booth") || parts[0];
const sessionCode = params.get("session") || (parts[1] === "sesi" ? parts[2] : parts[1]);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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

async function renderComposite(urls) {
  const container = $("#composite-preview");
  container.innerHTML = urls.map((url, index) => `<img src="${url}" alt="Foto ${index + 1}">`).join("");
  $("#flipbook").innerHTML = urls.slice(0, 4).map((url, index) => `<img src="${url}" alt="Flipbook ${index + 1}">`).join("");
  $("#download-composite").onclick = async () => {
    const images = [...container.querySelectorAll("img")];
    await Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; image.onerror = resolve; })));
    const width = 1200;
    const padding = 90;
    const gap = 28;
    const slot = width - padding * 2;
    const height = padding + images.length * (slot + gap) + 180;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#f7f7f3";
    context.fillRect(0, 0, width, height);
    images.forEach((image, index) => context.drawImage(image, padding, padding + index * (slot + gap), slot, slot));
    context.fillStyle = "#181a20";
    context.font = "700 28px system-ui";
    context.textAlign = "center";
    context.fillText("PHOTOSLIVE", width / 2, height - 70);
    const link = document.createElement("a");
    link.download = `photoslive-${sessionCode}-kolase.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };
}

async function cloudSession() {
  return jsonApi(`/api/platform?action=public_session&booth=${encodeURIComponent(boothCode)}&session=${encodeURIComponent(sessionCode)}`);
}

async function resolvePhotoUrls(session, booth) {
  if (Array.isArray(session.files) && session.files.length) return session.files.sort((a, b) => a.slotIndex - b.slotIndex).map(file => file.url);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await wait(1500);
    const latest = await cloudSession();
    if (latest.session.files?.length) return latest.session.files.sort((a, b) => a.slotIndex - b.slotIndex).map(file => file.url);
  }
  if (!booth.online) throw new Error("Upload foto belum selesai. Buka lagi halaman ini saat mesin kembali online.");
  const local = await controllerRequest(session.machineId, `/api/sessions/${encodeURIComponent(session.shareCode)}`);
  const files = (local.session?.files || []).filter(file => file.kind === "capture" && file.selected);
  if (!files.length) throw new Error("Foto pilihan belum selesai diproses");
  const urls = [];
  for (const file of files) urls.push(binaryUrl(await controllerRequest(session.machineId, `/api/session-files/${encodeURIComponent(file.id)}`)));
  return urls;
}

async function init() {
  try {
    if (!boothCode || !sessionCode) throw new Error("Link sesi tidak valid");
    const { session, booth } = await cloudSession();
    const urls = await resolvePhotoUrls(session, booth);
    $("#raw-photos").innerHTML = urls.map((url, index) => `<article class="photo-item"><img src="${url}" alt="Foto ${index + 1}"><div class="photo-actions"><b>Foto ${index + 1}</b><a href="${url}" download="photoslive-${sessionCode}-foto-${index + 1}.jpg">Download</a></div></article>`).join("");
    await renderComposite(urls);
    $("#expiry-note").textContent = `Tersedia sampai ${new Date(session.expiresAt).toLocaleString("id-ID")}. Simpan semua file sebelum waktu tersebut.`;
    $("#session-loading").classList.add("hidden");
    $("#session-content").classList.remove("hidden");
  } catch (error) {
    $("#session-loading").classList.add("hidden");
    $("#session-error").textContent = error.message;
  }
}

init();
