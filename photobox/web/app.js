const state = { settings: null, status: null, assets: { background: [], frame: [], logo: [], sticker: [] }, assetPages: { background: 1 }, dirtySections: new Set(), cameraPreviewEnabled: false, cameraPreviewTimer: null, cameraPreviewUrl: null, storageLoadedAt: 0, storageLoading: false, pendingFrameUpload: null };
const adminBoothCode = new URLSearchParams(location.search).get("booth") || location.pathname.split("/").filter(Boolean)[0] || localStorage.getItem("photoslive.boothCode") || "";
const titles = {
  overview: ["Kondisi photobox", "Mesin / Ringkasan", "Lihat apakah mesin siap dipakai dan periksa jika ada masalah."],
  content: ["Tampilan photobox", "Pengaturan / Tampilan", "Atur logo, background, frame, teks, font, dan warna yang dilihat pelanggan."],
  access: ["Sesi & pembayaran", "Pengaturan / Sesi dan pembayaran", "Atur waktu sesi, harga, QRIS, dan voucher."],
  devices: ["Kamera & printer", "Mesin / Kamera dan printer", "Sambungkan, pilih, dan periksa perangkat yang akan digunakan."],
  agent: ["Photoslive Agent", "Mesin / Photoslive Agent", "Download, pasangkan, dan monitor controller hardware lokal."],
  storage: ["Penyimpanan foto", "Mesin / Penyimpanan", "Atur penghapusan foto lokal dan tujuan upload cloud."],
  system: ["Pengaturan mesin", "Mesin / Pengaturan", "Ubah identitas mesin atau unduh laporan untuk teknisi."],
  users: ["Pengguna admin", "Akun / Pengguna", "Kelola email, password, PIN, serta pengguna yang boleh mengakses mesin ini."],
};
const defaults = {
  background: [
    { name: "Midnight gradient", url: "default-gradient", builtin: true, style: "linear-gradient(145deg,#111522,#635bff 65%,#de79ab)" },
    { name: "Soft studio", url: "soft-studio", builtin: true, style: "linear-gradient(145deg,#f7e6da,#efae9e)" },
    { name: "Event blue", url: "event-blue", builtin: true, style: "linear-gradient(145deg,#07182d,#167e9d)" },
  ],
  frame: [
    { name: "Clean white", url: "clean-white", builtin: true, style: "linear-gradient(#eee,#ddd)" },
    { name: "Party night", url: "party-night", builtin: true, style: "linear-gradient(135deg,#171922,#b99bdb)" },
  ],
  logo: [
    { name: "Wordmark Photoslive", url: "text-logo", builtin: true },
  ],
};
const FONT_FAMILIES = {
  system: "Inter, ui-sans-serif, system-ui, sans-serif",
  arial: "Arial, Helvetica, sans-serif",
  helvetica: "Helvetica, Arial, sans-serif",
  verdana: "Verdana, Geneva, sans-serif",
  tahoma: "Tahoma, Geneva, sans-serif",
  trebuchet: "'Trebuchet MS', Arial, sans-serif",
  georgia: "Georgia, serif",
  times: "'Times New Roman', Times, serif",
  garamond: "Garamond, 'Times New Roman', serif",
  courier: "'Courier New', Courier, monospace",
};
const SCREEN_PRESETS = {
  "1920x1080": { width: 1920, height: 1080 },
  "1366x768": { width: 1366, height: 768 },
  "1024x768": { width: 1024, height: 768 },
  "1080x1920": { width: 1080, height: 1920 },
  "768x1024": { width: 768, height: 1024 },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const setText = (selector, value) => { const element = $(selector); if (element) element.textContent = value; };
const getPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const setPath = (object, path, value) => { const parts = path.split("."); const key = parts.pop(); const parent = parts.reduce((value, part) => value[part], object); parent[key] = value; };
const formatBytes = (value = 0) => { const units = ["B", "KB", "MB", "GB", "TB"]; let size = value; let index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; } return `${size.toFixed(index > 1 ? 1 : 0)} ${units[index]}`; };
const formatIDR = (value = 0) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value);
const formatUptime = (seconds = 0) => { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`; };
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

async function api(path, options = {}) {
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost" && !path.startsWith("/api/bridge")) {
    if (isCloudDataPath(path)) return cloudDataApi(path, options);
    return cloudControllerApi(path, options);
  }
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status})`);
  return payload;
}

function isCloudDataPath(path) {
  const pathname = String(path).split("?")[0];
  return pathname === "/api/settings" || pathname.startsWith("/api/settings/") || pathname === "/api/assets" || pathname.startsWith("/api/assets/") || pathname === "/api/vouchers" || pathname === "/api/vouchers/generate" || pathname.startsWith("/api/vouchers/") || pathname === "/api/voucher-events";
}

const isProductionHost = () => location.hostname !== "127.0.0.1" && location.hostname !== "localhost";
const assetUploadLimit = () => isProductionHost() ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
const assetUploadLimitLabel = () => isProductionHost() ? "2 MB" : "10 MB";
const isUploadedAssetUrl = url => String(url || "").startsWith("/uploads/") || String(url || "").includes("action=cloud_asset");

async function cloudDataApi(path, options = {}) {
  let data = {};
  if (typeof options.body === "string" && options.body) data = JSON.parse(options.body);
  else if (options.body instanceof Blob) {
    if (options.body.size > 2_000_000) throw new Error("Ukuran aset cloud maksimal 2 MB");
    data = {
      bodyBase64: await blobToBase64(options.body),
      contentType: options.body.type || "application/octet-stream",
      filename: Object.entries(options.headers || {}).find(([name]) => name.toLowerCase() === "x-filename")?.[1] || "asset.webp",
    };
  }
  const response = await fetch(`/api/platform?action=cloud_data&booth=${encodeURIComponent(adminBoothCode)}&path=${encodeURIComponent(path)}`, {
    method: String(options.method || "GET").toUpperCase(),
    headers: { "Content-Type": "application/json" },
    body: String(options.method || "GET").toUpperCase() === "GET" ? undefined : JSON.stringify({ data }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Cloud database gagal (${response.status})`);
  return payload;
}

async function directBridge(action, payload = {}, method = "POST") {
  const query = method === "GET" ? `&${new URLSearchParams(payload)}` : "";
  const response = await fetch(`/api/bridge?action=${encodeURIComponent(action)}${query}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Cloud bridge gagal (${response.status})`);
  return result;
}

async function cloudControllerApi(path, options = {}) {
  let machineId = localStorage.getItem("photoslive.machineId");
  // A browser can administer more than one booth. Always resolve the machine
  // from the booth in the current URL so an old localStorage value never sends
  // settings, uploads, or device commands to a different photobox.
  if (adminBoothCode) {
    const response = await fetch(`/api/platform?action=resolve_booth&booth=${encodeURIComponent(adminBoothCode)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Photobox tidak ditemukan");
    machineId = result.booth.machineId;
    localStorage.setItem("photoslive.machineId", machineId);
    localStorage.setItem("photoslive.boothCode", result.booth.boothCode);
  }
  if (!machineId) throw new Error("Mesin belum terhubung. Buka Photoslive Agent dan masukkan kode pairing.");
  let requestBody = null;
  let bodyBase64 = null;
  if (typeof options.body === "string" && options.body) {
    try { requestBody = JSON.parse(options.body); } catch { throw new Error("Format data tidak dapat dikirim melalui Agent"); }
  } else if (options.body instanceof Blob) {
    bodyBase64 = await blobToBase64(options.body);
  }
  const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([name]) => ["content-type", "x-slot-index", "x-filename", "x-client-id"].includes(name.toLowerCase())));
  const { job } = await directBridge("enqueue_job", { machineId, type: "controller.request", payload: { path, method: String(options.method || "GET").toUpperCase(), body: requestBody, bodyBase64, headers } });
  const deadline = Date.now() + Number(options.timeoutMs || 35000);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 600));
    const status = await directBridge("job_status", { machineId, jobId: job.id }, "GET");
    if (status.job.status === "completed") return status.job.result || {};
    if (status.job.status === "failed") throw new Error(status.job.error || "Perintah gagal dijalankan Agent");
  }
  throw new Error("Agent tidak merespons dalam 35 detik. Pastikan service Agent masih aktif.");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("File tidak dapat dibaca"));
    reader.readAsDataURL(blob);
  });
}

function cloudBinaryUrl(result) {
  if (!result?.bodyBase64) throw new Error("Agent tidak mengirim data file");
  const bytes = Uint8Array.from(atob(result.bodyBase64), character => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: result.contentType || "application/octet-stream" }));
}

function toast(message, kind = "default") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => notice.classList.remove("show"), 3200);
}

function showView(name) {
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `${name}-view`));
  $("#view-title").textContent = titles[name][0];
  $("#breadcrumbs").textContent = titles[name][1];
  $("#page-help").textContent = titles[name][2];
  $("#save-button").hidden = name === "overview";
  const currentUrl = new URL(window.location.href);
  currentUrl.searchParams.set("view", name);
  window.history.replaceState(null, "", currentUrl);
  if (name === "storage" && state.settings) loadStorageData(false);
  if (name === "agent") loadAgentStatus();
  if (name === "users") loadUsers();
}

async function platformApi(action, options = {}) {
  const response = await fetch(`/api/platform?action=${encodeURIComponent(action)}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request gagal (${response.status})`);
  return payload;
}

async function loadUsers() {
  try {
    const [{ users }, me] = await Promise.all([platformApi("users"), platformApi("me")]);
    setText("#user-count", users.length);
    $("#user-rows").innerHTML = users.map(user => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(user.email)}</td><td>${escapeHtml(user.role)}</td><td><span class="device-state ${user.active ? "connected" : "attention"}">${user.active ? "AKTIF" : "NONAKTIF"}</span></td></tr>`).join("") || '<tr><td colspan="4">Belum ada pengguna.</td></tr>';
    $("#profile-name").value = me.user?.name || ""; $("#profile-email").value = me.user?.email || "";
  } catch (error) { toast(error.message, "error"); }
}

const agentState = { machineId: localStorage.getItem("photoslive.machineId") || "", timer: null };

async function bridgeApi(action, options = {}) {
  const separator = options.query ? `&${new URLSearchParams(options.query)}` : "";
  return api(`/api/bridge?action=${encodeURIComponent(action)}${separator}`, options);
}

function renderAgentMachine(machine) {
  const empty = $("#agent-machine-empty"), content = $("#agent-machine-content");
  if (!machine) {
    empty.hidden = false; content.hidden = true;
    $("#agent-overall-state").textContent = agentState.machineId ? "TIDAK DITEMUKAN" : "BELUM TERHUBUNG";
    $("#agent-overall-state").className = "device-state attention";
    return;
  }
  empty.hidden = true; content.hidden = false;
  const online = Boolean(machine.online);
  $("#agent-overall-state").textContent = online ? "ONLINE" : "OFFLINE";
  $("#agent-overall-state").className = `device-state ${online ? "connected" : "attention"}`;
  setText("#agent-status-value", online ? "Online" : "Offline");
  setText("#agent-version-value", `Agent ${machine.agentVersion || "—"} · ${machine.name || "Mesin"}`);
  setText("#agent-last-seen", machine.lastSeenAt ? `TERAKHIR ${new Date(machine.lastSeenAt).toLocaleString("id-ID")}` : "BELUM ADA HEARTBEAT");
  setText("#agent-platform-value", machine.platform || "Platform belum dilaporkan");
  const devices = Array.isArray(machine.devices) ? machine.devices : [];
  const camera = devices.find(device => device.kind === "camera" && device.status === "connected");
  const printer = devices.find(device => device.kind === "printer" && device.status === "connected");
  setText("#agent-camera-value", camera ? "Tersambung" : "Terputus");
  setText("#agent-camera-detail", camera?.name || "Tidak ada kamera aktif");
  setText("#agent-printer-value", printer ? "Tersambung" : "Terputus");
  setText("#agent-printer-detail", printer?.name || "Tidak ada printer aktif");
  setText("#agent-disk-value", formatBytes(machine.telemetry?.disk?.freeBytes || 0));
  $("#agent-device-list").innerHTML = devices.length ? devices.map(device => `<article class="device-card"><span class="device-glyph"><img src="/icons/${device.kind === "printer" ? "printer" : "camera"}.svg" alt="" /></span><div><b>${escapeHtml(device.name)}</b><p>${escapeHtml(device.detail || device.id || "Perangkat lokal")}</p></div><span class="device-state ${device.status === "connected" ? "connected" : "attention"}">${escapeHtml(device.status || "unknown")}</span></article>`).join("") : '<p class="empty">Agent belum melaporkan kamera atau printer.</p>';
}

async function loadAgentStatus(showNotice = false) {
  clearTimeout(agentState.timer);
  if (!agentState.machineId) { renderAgentMachine(null); return; }
  try {
    const { machine } = await bridgeApi("machine_status", { query: { machineId: agentState.machineId } });
    renderAgentMachine(machine);
    if (showNotice) toast("Status Agent diperbarui");
  } catch (error) {
    renderAgentMachine(null);
    $("#agent-pair-message").textContent = `Cloud belum siap: ${error.message}`;
    if (showNotice) toast(error.message, "error");
  }
  if ($("#agent-view")?.classList.contains("active")) agentState.timer = setTimeout(loadAgentStatus, 15000);
}

async function claimAgent(event) {
  event.preventDefault();
  const button = $("#agent-pair-form button");
  button.disabled = true;
  $("#agent-pair-message").textContent = "Menghubungkan mesin…";
  try {
    const { machine } = await bridgeApi("claim_pairing", { method: "POST", body: JSON.stringify({ code: $("#agent-pair-code").value, name: $("#agent-machine-name").value, location: $("#agent-machine-location").value }) });
    agentState.machineId = machine.id;
    localStorage.setItem("photoslive.machineId", machine.id);
    $("#agent-pair-message").textContent = `Berhasil terhubung ke ${machine.name}. Agent akan online dalam beberapa detik.`;
    $("#agent-pair-code").value = "";
    renderAgentMachine(machine);
    await loadAgentStatus();
  } catch (error) {
    $("#agent-pair-message").textContent = error.message;
  } finally { button.disabled = false; }
}

async function queueAgentJob(type) {
  if (!agentState.machineId) return toast("Hubungkan mesin terlebih dahulu", "error");
  try {
    await bridgeApi("enqueue_job", { method: "POST", body: JSON.stringify({ machineId: agentState.machineId, type, payload: {} }) });
    toast("Perintah dikirim ke Agent");
    setTimeout(() => loadAgentStatus(), 2500);
  } catch (error) { toast(error.message, "error"); }
}

function hydrateSettings() {
  const appearance = state.settings.appearance;
  appearance.screenPreset ||= "1080x1920";
  appearance.screenSizeInches ||= 15.6;
  appearance.logoSizePercent ||= 28;
  appearance.headingFontSize ||= 48;
  appearance.helperFontSize ||= 18;
  appearance.buttonFontSize ||= 16;
  $$('[data-setting]').forEach(input => {
    const value = getPath(state.settings, input.dataset.setting);
    if (input.type === "checkbox") input.checked = Boolean(value); else input.value = value ?? "";
  });
  $$('[data-color-output]').forEach(output => { output.textContent = String(getPath(state.settings, output.dataset.colorOutput) || "#000000").toUpperCase(); });
  $$('[data-font-select]').forEach(select => { select.style.fontFamily = FONT_FAMILIES[select.value] || FONT_FAMILIES.system; });
  setText("#logo-size-value", `${appearance.logoSizePercent}%`);
  $("#machine-name").textContent = state.settings.booth.name;
  $("#node-location").textContent = state.settings.booth.location;
  syncActiveFrameCapacity();
  renderAssets();
  updatePreview();
  updateAdminSettingSummaries();
}

function markSetting(input) {
  let value = input.type === "checkbox" ? input.checked : input.value;
  if (input.type === "number" || input.type === "range") value = Number(value);
  setPath(state.settings, input.dataset.setting, value);
  const colorOutput = $(`[data-color-output="${input.dataset.setting}"]`);
  if (colorOutput) colorOutput.textContent = String(value).toUpperCase();
  if (input.matches("[data-font-select]")) input.style.fontFamily = FONT_FAMILIES[value] || FONT_FAMILIES.system;
  if (input.dataset.setting === "appearance.logoSizePercent") setText("#logo-size-value", `${value}%`);
  state.dirtySections.add(input.dataset.setting.split(".")[0]);
  if (input.dataset.setting === "booth.photoSlotsPerSession") {
    state.settings.appearance.framePhotoSlots ||= {};
    state.settings.appearance.framePhotoSlots[state.settings.appearance.activeFrame] = Number(value);
    state.dirtySections.add("appearance");
    if ($("#frame-photo-slots")) $("#frame-photo-slots").value = value;
  }
  updatePreview();
}

function syncActiveFrameCapacity(markDirty = false) {
  if (!state.settings) return;
  const appearance = state.settings.appearance;
  appearance.framePhotoSlots ||= {};
  appearance.framePhotoWidths ||= {};
  appearance.frameLayoutModes ||= {};
  appearance.frameSizePresets ||= {};
  appearance.frameCanvasSizes ||= {};
  appearance.frameOriginalCanvasSizes ||= {};
  const activeFrame = appearance.activeFrame;
  const slots = Number(appearance.framePhotoSlots[activeFrame] || state.settings.booth.photoSlotsPerSession || 1);
  appearance.framePhotoSlots[activeFrame] = slots;
  appearance.framePhotoWidths[activeFrame] ||= 86;
  appearance.frameLayoutModes[activeFrame] ||= "auto";
  appearance.frameSizePresets[activeFrame] ||= "auto";
  appearance.frameCanvasSizes[activeFrame] ||= { width: Number(appearance.frameCanvasWidth || 1200), height: Number(appearance.frameCanvasHeight || 1600) };
  appearance.frameOriginalCanvasSizes[activeFrame] ||= { ...appearance.frameCanvasSizes[activeFrame] };
  state.settings.booth.photoSlotsPerSession = slots;
  if ($("#frame-photo-slots")) $("#frame-photo-slots").value = slots;
  if ($("#frame-photo-width")) $("#frame-photo-width").value = appearance.framePhotoWidths[activeFrame];
  if ($("#frame-canvas-width")) $("#frame-canvas-width").value = appearance.frameCanvasSizes[activeFrame].width;
  if ($("#frame-canvas-height")) $("#frame-canvas-height").value = appearance.frameCanvasSizes[activeFrame].height;
  if ($("#frame-size-preset")) $("#frame-size-preset").value = appearance.frameSizePresets[activeFrame];
  $$('[data-setting="booth.photoSlotsPerSession"]').forEach(input => { input.value = slots; });
  if (markDirty) { state.dirtySections.add("appearance"); state.dirtySections.add("booth"); }
}

function frameCanvas() {
  const devices = state.settings.devices;
  const paperSizes = { "4x6": [1200, 1800], "5x7": [1500, 2100], "6x8": [1800, 2400], A4: [2480, 3508] };
  const [paperWidth, height] = paperSizes[devices.paperSize] || paperSizes["4x6"];
  const strips = devices.printLayout === "full-photo" ? 1 : Math.max(1, Math.min(4, Number(devices.stripsPerSheet || 2)));
  const width = Math.round(paperWidth / strips);
  const divisor = ((a, b) => { while (b) [a, b] = [b, a % b]; return a; })(Math.round(width), Math.round(height));
  return { width, height, ratio: `${Math.round(width / divisor)}:${Math.round(height / divisor)}` };
}

function getFramePresentation(frameUrl = state.settings?.appearance?.activeFrame) {
  const appearance = state.settings.appearance;
  const uploaded = state.assets.frame.map(item => {
    const transform = appearance.frameBackgroundTransforms?.[item.url] || { zoom: 100, x: 50, y: 50 };
    const size = Number(transform.zoom) === 100 ? "cover" : `${transform.zoom}% auto`;
    return { ...item, style: `url('${item.url}') ${transform.x}% ${transform.y}% / ${size} no-repeat` };
  });
  const asset = [...defaults.frame, ...uploaded].find(item => item.url === frameUrl) || defaults.frame[0];
  const configuredSlots = Math.max(1, Math.min(8, Number(appearance.framePhotoSlots?.[frameUrl] || state.settings.booth.photoSlotsPerSession || 1)));
  const mode = appearance.frameLayoutModes?.[frameUrl] || "auto";
  const slots = mode === "single" ? 1 : configuredSlots;
  const layout = mode === "single" || (mode === "auto" && slots === 1) ? "single" : "stacked";
  const slotTransforms = appearance.frameSlotTransforms?.[frameUrl] || defaultSlotTransforms(slots);
  const stickers = appearance.frameStickers?.[frameUrl] || [];
  return { asset, configuredSlots, slots, mode, layout, slotTransforms, stickers };
}

function defaultSlotTransforms(slots) {
  const count = Math.max(1, Math.min(8, Number(slots || 1)));
  const gap = 1.5;
  const slotHeight = Math.min(28, (84 - gap * (count - 1)) / count);
  const slotWidth = Math.min(88, slotHeight * 3);
  return Array.from({ length: count }, (_, index) => ({ x: 50, y: 3 + slotHeight / 2 + index * (slotHeight + gap), width: slotWidth, rotation: 0, opacity: 100, z: index + 1 }));
}

function slotTransformStyle(transform = {}) {
  return `left:${Number(transform.x ?? 50)}%;top:${Number(transform.y ?? 15)}%;width:${Number(transform.width || 84)}%;opacity:${Number(transform.opacity ?? 100) / 100};z-index:${Number(transform.z || 1)};transform:translate(-50%,-50%) rotate(${Number(transform.rotation || 0)}deg)`;
}

function frameTemplateMarkup(frameUrl, options = {}) {
  const frame = getFramePresentation(frameUrl);
  const canvas = frameCanvas(frameUrl);
  const photoWidth = Math.max(60, Math.min(96, Number(state.settings.appearance.framePhotoWidths?.[frameUrl] || 86)));
  const cells = Array.from({ length: frame.slots }, (_, index) => `<span style="${slotTransformStyle(frame.slotTransforms[index] || defaultSlotTransforms(frame.slots)[index])}"><b>${index + 1}</b><img src="/icons/image.svg" alt="Slot foto ${index + 1}" /></span>`).join("");
  const stickers = frame.stickers.map(item => `<img class="frame-sticker" src="${item.url}" alt="Dekorasi frame" style="left:${item.x}%;top:${item.y}%;width:${item.size || 30}%;opacity:${Number(item.opacity ?? 100) / 100};z-index:${Number(item.z || 10)};transform:translate(-50%,-50%) rotate(${item.rotation || 0}deg)" />`).join("");
  return `<div class="photo-strip frame-layout-${frame.layout}" style="--frame-art:${frame.asset.style};--frame-ratio:${canvas.width} / ${canvas.height};--photo-width:${photoWidth}%"><div class="photo-strip-slots" data-slots="${frame.slots}">${cells}</div>${stickers}</div>`;
}

async function saveSettings() {
  if (!state.dirtySections.size) return toast("Tidak ada perubahan yang perlu disimpan");
  const sections = [...state.dirtySections];
  try {
    for (const section of sections) {
      await api(`/api/settings/${section}`, { method: "PATCH", body: JSON.stringify(state.settings[section]) });
      if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
        // Keep the local controller in sync when it is online, but never make
        // cloud saving wait for Agent hardware polling.
        cloudControllerApi(`/api/settings/${section}`, { method: "PATCH", body: JSON.stringify(state.settings[section]), timeoutMs: 5000 }).catch(() => {});
      }
    }
    state.dirtySections.clear();
    toast("Pengaturan berhasil disimpan");
    updatePreview();
  } catch (error) { toast(`Gagal menyimpan: ${error.message}`, "error"); }
}

function updatePreview() {
  if (!state.settings) return;
  const appearance = state.settings.appearance;
  $("#preview-title").textContent = appearance.welcomeTitle;
  $("#preview-prompt").textContent = appearance.touchPrompt;
  $("#preview-start-button").textContent = appearance.startButtonLabel;
  const selected = [...defaults.background, ...state.assets.background].find(asset => asset.url === appearance.activeBackground);
  const style = selected?.style || (isUploadedAssetUrl(selected?.url) ? `center / cover url('${selected.url}')` : defaults.background[0].style);
  $("#booth-preview").style.background = style;
  $("#booth-preview").style.fontFamily = FONT_FAMILIES[appearance.fontFamily] || FONT_FAMILIES.system;
  const screen = SCREEN_PRESETS[appearance.screenPreset] || SCREEN_PRESETS["1080x1920"];
  const previewCard = $("#screen-preview-card");
  previewCard.style.setProperty("--screen-ratio", `${screen.width} / ${screen.height}`);
  const landscape = screen.width >= screen.height;
  previewCard.dataset.orientation = landscape ? "landscape" : "portrait";
  setText("#preview-resolution", `${screen.width} × ${screen.height} · ${Number(appearance.screenSizeInches || 15.6)}\u2033`);
  const headingSize = Math.max(20, Math.min(120, Number(appearance.headingFontSize || 48)));
  const helperSize = Math.max(10, Math.min(64, Number(appearance.helperFontSize || 18)));
  const buttonSize = Math.max(10, Math.min(48, Number(appearance.buttonFontSize || 16)));
  $("#preview-title").style.fontSize = `${(landscape ? 22 : 28) * headingSize / 48}px`;
  $("#preview-prompt").style.fontSize = `${(landscape ? 10 : 12) * helperSize / 18}px`;
  $("#preview-start-button").style.fontSize = `${(landscape ? 10 : 12) * buttonSize / 16}px`;
  $("#preview-title").style.color = appearance.headingTextColor;
  $("#preview-prompt").style.color = appearance.helperTextColor;
  $("#preview-start-button").style.backgroundColor = appearance.buttonBackgroundColor;
  $("#preview-start-button").style.color = appearance.buttonTextColor;
  const usesImageLogo = appearance.activeLogo && appearance.activeLogo !== "text-logo";
  const logoSize = Math.max(10, Math.min(60, Number(appearance.logoSizePercent || 28)));
  $(".preview-logo").style.width = `${logoSize}%`;
  $("#preview-logo-text").style.fontSize = `${Math.max(6, Math.min(22, 9 * logoSize / 28))}px`;
  $("#preview-logo-image").hidden = !usesImageLogo;
  $("#preview-logo-text").hidden = usesImageLogo;
  if (usesImageLogo) $("#preview-logo-image").src = appearance.activeLogo;
  updateDevicePreviews();
  updateStorageScenario();
  updateAdminSettingSummaries();
}

function updateAdminSettingSummaries() {
  if (!state.settings) return;
  const { booth, payment, appearance, devices } = state.settings;
  const activeCanvas = frameCanvas();
  setText("#content-background-count", String(defaults.background.length + state.assets.background.length));
  setText("#content-frame-count", String(defaults.frame.length + state.assets.frame.length));
  setText("#content-frame-format", activeCanvas.ratio);
  const outputCount = devices.printLayout === "full-photo" ? 1 : Number(devices.stripsPerSheet || 2);
  setText("#content-canvas-size", devices.paperSize);
  setText("#content-canvas-detail", `${outputCount} ${devices.printLayout === "full-photo" ? "foto" : "strip"} per lembar`);
  setText("#frame-printer-summary", `Kertas ${devices.paperSize} · ${outputCount} ${devices.printLayout === "full-photo" ? "foto" : "strip"} per lembar`);
  const photoSlots = Number(appearance.framePhotoSlots?.[appearance.activeFrame] || booth.photoSlotsPerSession || 1);
  const framePresentation = getFramePresentation();
  const retakeLimit = Number(booth.retakeLimit || 0);
  setText("#frame-slot-badge", `${framePresentation.slots} FOTO`);
  setText("#frame-slot-summary", `${framePresentation.slots === 1 ? "Satu foto besar" : `${framePresentation.slots} foto tersusun`} · bentuk ${activeCanvas.ratio}`);
  setText("#active-frame-ratio", activeCanvas.ratio);
  if ($("#frame-canvas-width")) $("#frame-canvas-width").value = activeCanvas.width;
  if ($("#frame-canvas-height")) $("#frame-canvas-height").value = activeCanvas.height;
  if ($("#frame-size-preset")) $("#frame-size-preset").value = appearance.frameSizePresets?.[appearance.activeFrame] || "auto";
  if ($("#frame-photo-width")) $("#frame-photo-width").value = appearance.framePhotoWidths?.[appearance.activeFrame] || 86;
  if ($("#frame-layout-mode")) $("#frame-layout-mode").value = framePresentation.mode;
  if ($("#active-frame-preview")) {
    $("#active-frame-preview").style.aspectRatio = `${activeCanvas.width} / ${activeCanvas.height}`;
    $("#active-frame-preview").innerHTML = frameTemplateMarkup(appearance.activeFrame);
  }
  setText("#session-flow-title", `1 sesi → ${photoSlots} slot foto → 1 photo strip`);
  const totalStrips = Number(booth.printsPerSession || 0) * Number(devices.stripsPerSheet || 1);
  const retakeDescription = booth.unlimitedRetakes
    ? "Retake tanpa batas selama waktu sesi masih tersedia."
    : `Setiap slot memiliki 1 foto awal dan maksimal ${retakeLimit} retake (${retakeLimit + 1} percobaan).`;
  setText("#session-flow-detail", `${retakeDescription} Setiap pengambilan memakai hitung mundur ${booth.countdownSeconds} detik. ${booth.printsPerSession} lembar × ${devices.stripsPerSheet || 1} strip = ${totalStrips} strip untuk pelanggan. Batas ${booth.sessionTimeoutSeconds} detik berlaku untuk seluruh sesi.`);
  setText("#access-daily-limit", String(booth.dailySessionLimit));
  const sessionMinutes = booth.sessionTimeoutSeconds >= 60 ? `${Math.floor(booth.sessionTimeoutSeconds / 60)} menit${booth.sessionTimeoutSeconds % 60 ? ` ${booth.sessionTimeoutSeconds % 60} detik` : ""}` : `${booth.sessionTimeoutSeconds} detik`;
  setText("#access-session-duration", sessionMinutes);
  setText("#access-session-price", formatIDR(payment.price));
  const methods = Number(payment.qrisEnabled) + Number(payment.voucherEnabled);
  setText("#access-method-count", `${methods} aktif`);
  setText("#access-method-detail", [payment.qrisEnabled ? "QRIS" : "", payment.voucherEnabled ? "Voucher" : ""].filter(Boolean).join(" + ") || "Semua metode dimatikan");
  setText("#device-layout-status", devices.printLayout === "full-photo" ? "Foto penuh" : "Photo strip");
  setText("#device-paper-status", `Kertas ${devices.paperSize}${devices.borderless ? " · sampai tepi" : ""}`);
}

function updateStorageScenario() {
  const scenario = $("#upload-scenario");
  if (!scenario || !state.settings?.storage) return;
  const finalOnly = state.settings.storage.uploadFinalOnly;
  scenario.classList.toggle("complete", !finalOnly);
  $("span", scenario).textContent = finalOnly ? "MODE HEMAT" : "BACKUP LENGKAP";
  $("#upload-scenario-title").textContent = finalOnly ? "Hanya foto final yang di-upload" : "Semua foto sesi ikut di-upload";
  $("#upload-scenario-detail").textContent = finalOnly
    ? "Foto asli dan retake tetap lokal selama masa simpan, lalu dihapus setelah hasil final aman di cloud. Pemakaian internet dan cloud lebih kecil."
    : "Foto asli, setiap retake, dan hasil final dikirim ke cloud. Riwayat sesi lebih lengkap, tetapi membutuhkan internet dan kapasitas cloud lebih besar.";
}

function updateDevicePreviews() {
  if (!state.settings?.devices) return;
  const devices = state.settings.devices;
  const appearance = state.settings.appearance;
  const framePresentation = getFramePresentation();
  const photoSlots = framePresentation.slots;
  const photoStrip = devices.printLayout !== "full-photo";
  $("#print-preview-sheet")?.classList.toggle("full-photo", !photoStrip);
  const stripsPerSheet = photoStrip ? Math.max(1, Math.min(4, Number(devices.stripsPerSheet || 2))) : 1;
  if ($("#print-sheet-strips")) {
    $("#print-sheet-strips").style.setProperty("--strip-count", stripsPerSheet);
    $("#print-sheet-strips").innerHTML = Array.from({ length: stripsPerSheet }, () => frameTemplateMarkup(appearance.activeFrame)).join("");
  }
  setText("#print-slot-count", `${photoSlots} foto`);
  setText("#print-strip-count", `${stripsPerSheet} strip`);
  if ($("#print-layout-summary")) $("#print-layout-summary").textContent = photoStrip ? "Photo strip vertikal" : "Foto penuh";
  if ($("#print-cut-guide")) {
    $("#print-cut-guide").hidden = stripsPerSheet <= 1;
    $("#print-cut-guide").textContent = stripsPerSheet === 2 ? "GARIS POTONG" : `${stripsPerSheet - 1} GARIS POTONG`;
  }
  setText("#print-preview-description", photoStrip
    ? `Setiap strip berisi foto slot 1–${photoSlots} dari atas ke bawah. ${stripsPerSheet} strip identik dicetak pada satu lembar dan dapat dipotong setelah keluar dari printer.`
    : "Satu foto memenuhi seluruh area kertas tanpa susunan photo strip.");
  if ($("#print-paper-summary")) $("#print-paper-summary").textContent = devices.paperSize;
  if ($("#print-border-summary")) $("#print-border-summary").textContent = devices.borderless ? "Sampai tepi" : "Dengan garis putih";
  const image = $("#camera-preview-image");
  if (image) image.style.transform = `rotate(${Number(devices.cameraRotation || 0)}deg) scaleX(${devices.cameraMirror ? -1 : 1})`;
}

function loadThumbnailSource(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Thumbnail frame tidak dapat dimuat"));
    image.src = url;
  });
}

async function renderFrameThumbnailImage(target, frameUrl) {
  const width = 160, height = 480;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  const frame = getFramePresentation(frameUrl);
  const transform = state.settings.appearance.frameBackgroundTransforms?.[frameUrl] || { zoom: 100, x: 50, y: 50 };
  if (isUploadedAssetUrl(frameUrl)) {
    const source = await loadThumbnailSource(frameUrl);
    const scale = Math.max(width / source.naturalWidth, height / source.naturalHeight) * (Number(transform.zoom || 100) / 100);
    const drawWidth = source.naturalWidth * scale, drawHeight = source.naturalHeight * scale;
    const x = (width - drawWidth) * (Number(transform.x ?? 50) / 100);
    const y = (height - drawHeight) * (Number(transform.y ?? 50) / 100);
    context.drawImage(source, x, y, drawWidth, drawHeight);
  } else {
    const gradient = context.createLinearGradient(0, 0, width, height);
    if (frameUrl === "party-night") { gradient.addColorStop(0, "#171922"); gradient.addColorStop(1, "#b99bdb"); }
    else { gradient.addColorStop(0, "#f5f5f5"); gradient.addColorStop(1, "#d8d8d8"); }
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  }
  const layers = [
    ...frame.slotTransforms.map((item, index) => ({ ...item, type: "slot", index, z: Number(item.z || index + 1) })),
    ...frame.stickers.map((item, index) => ({ ...item, type: "sticker", index, z: Number(item.z || 10 + index) })),
  ].sort((a, b) => a.z - b.z);
  for (const layer of layers) {
    context.save();
    context.globalAlpha = Number(layer.opacity ?? 100) / 100;
    context.translate(width * Number(layer.x ?? 50) / 100, height * Number(layer.y ?? 50) / 100);
    context.rotate(Number(layer.rotation || 0) * Math.PI / 180);
    if (layer.type === "slot") {
      const size = width * Number(layer.width || 84) / 100;
      const fill = context.createLinearGradient(-size / 2, -size / 2, size / 2, size / 2);
      fill.addColorStop(0, "#d9d6ff"); fill.addColorStop(.58, "#7770dc"); fill.addColorStop(1, "#333653");
      context.fillStyle = fill; context.fillRect(-size / 2, -size / 2, size, size);
      context.setLineDash([5, 4]); context.strokeStyle = "rgba(255,255,255,.94)"; context.lineWidth = 2; context.strokeRect(-size / 2 + 2, -size / 2 + 2, size - 4, size - 4);
      context.setLineDash([]); context.fillStyle = "#fff"; context.font = "700 10px system-ui"; context.fillText(String(layer.index + 1), -size / 2 + 8, -size / 2 + 16);
    } else {
      try { const sticker = await loadThumbnailSource(layer.url); const drawWidth = width * Number(layer.size || 30) / 100; const drawHeight = drawWidth * sticker.naturalHeight / sticker.naturalWidth; context.drawImage(sticker, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight); } catch (_) {}
    }
    context.restore();
  }
  if (target.isConnected) target.src = canvas.toDataURL("image/webp", .74);
}

function renderAssetPagination(kind, total, pageSize) {
  const container = $(`#${kind}-pagination`);
  if (!container) return;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(pages, Number(state.assetPages[kind] || 1)));
  state.assetPages[kind] = page;
  container.hidden = pages <= 1;
  container.innerHTML = pages <= 1 ? "" : `<span>${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} dari ${total}</span><div><button type="button" data-asset-page="${page - 1}" data-asset-kind="${kind}" ${page === 1 ? "disabled" : ""} aria-label="Halaman sebelumnya"><img src="/icons/chevron-left.svg" alt="" /></button><b>Halaman ${page} / ${pages}</b><button type="button" data-asset-page="${page + 1}" data-asset-kind="${kind}" ${page === pages ? "disabled" : ""} aria-label="Halaman berikutnya"><img src="/icons/chevron-right.svg" alt="" /></button></div>`;
}

function renderAssets() {
  const renderKind = kind => {
    const grid = $(`#${kind}-grid`);
    const setting = kind === "frame" ? "activeFrame" : "activeBackground";
    const all = [...defaults[kind], ...state.assets[kind].map(asset => ({ ...asset, style: `center / cover no-repeat url('${asset.url}')` }))];
    const pageSize = kind === "background" ? 10 : all.length || 1;
    if (kind === "background") renderAssetPagination(kind, all.length, pageSize);
    const page = kind === "background" ? state.assetPages.background : 1;
    const visibleAssets = kind === "background" ? all.slice((page - 1) * pageSize, page * pageSize) : all;
    grid.innerHTML = visibleAssets.map(asset => {
      const preview = kind === "frame"
        ? `<span class="asset-preview frame-preview-card"><img class="frame-preview-image" data-frame-url="${asset.url}" alt="Preview desain ${asset.name}" /></span>`
        : `<span class="asset-preview" style="background:${asset.style}"></span>`;
      return `
      <div class="asset-card ${state.settings.appearance[setting] === asset.url ? "selected" : ""}" data-asset-kind="${kind}" data-asset-url="${asset.url}">
        <button class="asset-select" aria-label="Pilih ${asset.name}">
          ${preview}<b>${asset.name.replace(/^\d+-/, "")}</b><small>${asset.builtin ? "Bawaan" : "Unggahan"}</small>
        </button>
        ${kind === "frame" ? `<div class="asset-card-actions"><button class="asset-edit" title="Edit desain" aria-label="Edit desain ${asset.name}"><img src="/icons/pencil.svg" alt="" /><span>Edit desain</span></button>${asset.builtin ? "" : `<button class="asset-remove" title="Hapus desain" aria-label="Hapus ${asset.name}"><img src="/icons/trash-2.svg" alt="" /><span>Hapus desain</span></button>`}</div>` : asset.builtin ? "" : `<button class="asset-remove" aria-label="Hapus ${asset.name}"><img src="/icons/trash-2.svg" alt="" /></button>`}
      </div>`;
    }).join("");
    if (kind === "frame") $$(".frame-preview-image", grid).forEach(image => renderFrameThumbnailImage(image, image.dataset.frameUrl).catch(() => { image.alt = "Preview tidak tersedia"; }));
  };
  renderKind("background");
  renderKind("frame");
  const logoGrid = $("#logo-grid");
  const logos = [...defaults.logo, ...state.assets.logo];
  logoGrid.innerHTML = logos.map(asset => {
    const previewClass = asset.builtin ? "asset-preview wordmark" : "asset-preview";
    const previewStyle = asset.builtin ? "" : `style="background:center / contain no-repeat url('${asset.url}')"`;
    return `
      <div class="asset-card ${state.settings.appearance.activeLogo === asset.url ? "selected" : ""}" data-asset-kind="logo" data-asset-url="${asset.url}">
        <button class="asset-select" aria-label="Pilih ${asset.name}">
          <span class="${previewClass}" ${previewStyle}></span><b>${asset.name.replace(/^\d+-/, "")}</b><small>${asset.builtin ? "Bawaan" : "Unggahan"}</small>
        </button>
        ${asset.builtin ? "" : `<button class="asset-remove" aria-label="Hapus ${asset.name}"><img src="/icons/trash-2.svg" alt="" /></button>`}
      </div>`;
  }).join("");
  setText("#content-background-count", String(defaults.background.length + state.assets.background.length));
  setText("#content-frame-count", String(defaults.frame.length + state.assets.frame.length));
}

async function loadAssets() {
  state.assets = await api("/api/assets");
  renderAssets();
}

function chooseAsset(kind) {
  const input = $("#asset-file");
  input.value = "";
  input.dataset.kind = kind;
  input.click();
}

function readImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("File gambar tidak dapat dibaca")); };
    image.src = url;
  });
}

function selectedFrameElements(pending = state.pendingFrameUpload) {
  if (!pending?.selected) return [];
  if (pending.selected.type === "all-slots") return pending.slotTransforms;
  if (pending.selected.type === "sticker") return [pending.stickers[pending.selected.index]].filter(Boolean);
  return [pending.slotTransforms[pending.selected.index]].filter(Boolean);
}

function frameLayers(pending = state.pendingFrameUpload) {
  if (!pending) return [];
  return [
    ...pending.slotTransforms.map((item, index) => ({ type: "slot", index, name: `Foto ${index + 1}`, z: Number(item.z || index + 1) })),
    ...pending.stickers.map((item, index) => ({ type: "sticker", index, name: `Logo / stiker ${index + 1}`, z: Number(item.z || 10 + index) })),
  ].sort((a, b) => b.z - a.z);
}

function setFrameEditorTab(name) {
  $$('[data-frame-editor-tab]').forEach(item => { const active = item.dataset.frameEditorTab === name; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
  $$('[data-frame-editor-panel]').forEach(panel => { panel.hidden = panel.dataset.frameEditorPanel !== name; });
}

function updateFrameUploadPreview() {
  if (!state.pendingFrameUpload) return;
  const pending = state.pendingFrameUpload;
  const canvas = frameCanvas();
  const preview = $("#frame-upload-preview");
  preview.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  const artworkStyle = `background:${pending.backgroundCss};transform:scale(${pending.zoom / 100});transform-origin:${pending.x}% ${pending.y}%`;
  const slots = pending.slotTransforms.map((transform, index) => `<span class="frame-editor-element ${(pending.selected?.type === "slot" && pending.selected.index === index) || pending.selected?.type === "all-slots" ? "selected" : ""}" data-editor-type="slot" data-editor-index="${index}" style="${slotTransformStyle(transform)}"><b>${index + 1}</b><img src="/icons/image.svg" alt="Slot foto ${index + 1}" /></span>`).join("");
  const stickers = pending.stickers.map((item, index) => `<span class="frame-editor-sticker frame-editor-element ${pending.selected?.type === "sticker" && pending.selected.index === index ? "selected" : ""}" data-editor-type="sticker" data-editor-index="${index}" style="left:${item.x}%;top:${item.y}%;width:${item.size || 30}%;opacity:${Number(item.opacity ?? 100) / 100};z-index:${Number(item.z || 10 + index)};transform:translate(-50%,-50%) rotate(${item.rotation || 0}deg)"><img src="${item.url}" alt="Logo atau stiker ${index + 1}" /></span>`).join("");
  preview.innerHTML = `<div class="frame-editor-artwork" style="${artworkStyle}"></div><div class="photo-strip-slots modal-frame-slots" data-slots="${pending.slots}">${slots}</div>${stickers}`;
  $("#frame-crop-stage").style.setProperty("--editor-stage-art", pending.backgroundCss);
  setText("#frame-upload-zoom-value", `${pending.zoom}%`);
  setText("#frame-upload-paper", `Hasil: ${state.settings.devices.paperSize} · ${state.settings.devices.printLayout === "full-photo" ? 1 : state.settings.devices.stripsPerSheet} strip`);
  const selectedElements = selectedFrameElements(pending);
  const selected = selectedElements[0];
  const isSticker = pending.selected?.type === "sticker";
  const isAllSlots = pending.selected?.type === "all-slots";
  setText("#frame-selected-label", isSticker ? `Logo / stiker ${pending.selected.index + 1} dipilih` : isAllSlots ? `Semua ${pending.slots} foto dipilih` : `Area foto ${(pending.selected?.index || 0) + 1} dipilih`);
  setText("#frame-selected-help", isAllSlots ? "Geser salah satu foto untuk memindahkan semuanya" : "Geser pada preview untuk mengubah posisi");
  $("#select-all-frame-slots").classList.toggle("active", isAllSlots);
  $("#frame-element-rotation").value = Number(selected?.rotation || 0);
  setText("#frame-element-rotation-value", `${Number(selected?.rotation || 0)}°`);
  $("#frame-element-size").value = isSticker ? Number(selected?.size || 30) : Math.round(Number(selected?.width || 84) / 0.84);
  setText("#frame-element-size-value", isSticker ? `${Number(selected?.size || 30)}%` : `${Math.round(Number(selected?.width || 84) / 0.84)}%`);
  $("#frame-element-opacity").value = Number(selected?.opacity ?? 100);
  setText("#frame-element-opacity-value", `${Number(selected?.opacity ?? 100)}%`);
  $("#remove-frame-element").hidden = !isSticker;
  const layers = frameLayers(pending);
  setText("#frame-layer-count", String(layers.length));
  $("#frame-layer-list").innerHTML = layers.map((layer, position) => `<div class="frame-layer-row ${pending.selected?.type === layer.type && pending.selected.index === layer.index ? "selected" : ""}" data-layer-type="${layer.type}" data-layer-index="${layer.index}"><button type="button" class="layer-select"><span><img src="/icons/${layer.type === "sticker" ? "image-plus" : "image"}.svg" alt="" /><b>${layer.name}</b></span><small>Layer ${layers.length - position}</small></button><div><button type="button" class="layer-up" aria-label="Naikkan ${layer.name}" ${position === 0 ? "disabled" : ""}><img src="/icons/chevron-up.svg" alt="" /></button><button type="button" class="layer-down" aria-label="Turunkan ${layer.name}" ${position === layers.length - 1 ? "disabled" : ""}><img src="/icons/chevron-down.svg" alt="" /></button></div></div>`).join("");
}

async function prepareFrameUpload(file) {
  if (!file) return;
  if (file.size > assetUploadLimit()) return toast(`Ukuran gambar maksimal ${assetUploadLimitLabel()}`, "error");
  try {
    await readImageDimensions(file);
    if (state.pendingFrameUpload?.previewUrl) URL.revokeObjectURL(state.pendingFrameUpload.previewUrl);
    const previewUrl = URL.createObjectURL(file);
    state.pendingFrameUpload = { mode: "new", file, previewUrl, frameUrl: null, backgroundCss: `center / cover no-repeat url('${previewUrl}')`, slots: 3, zoom: 100, x: 50, y: 50, slotTransforms: defaultSlotTransforms(3), stickers: [], selected: { type: "slot", index: 0 } };
    $("#frame-upload-slots").value = "3";
    $("#frame-upload-zoom").value = "100";
    setText("#frame-editor-eyebrow", "DESAIN FRAME BARU");
    setText("#frame-editor-title", "Atur desain");
    setFrameEditorTab("design");
    updateFrameUploadPreview();
    $("#frame-editor-dialog").showModal();
  } catch (error) { toast(`Gambar tidak dapat dibuka: ${error.message}`, "error"); }
}

function openFrameEditor(frameUrl) {
  const frame = getFramePresentation(frameUrl);
  const transform = state.settings.appearance.frameBackgroundTransforms?.[frameUrl] || { zoom: 100, x: 50, y: 50 };
  state.pendingFrameUpload = {
    mode: "edit", file: null, previewUrl: null, frameUrl, backgroundCss: isUploadedAssetUrl(frameUrl) ? `center / cover no-repeat url('${frameUrl}')` : frame.asset.style,
    slots: frame.slots, zoom: Number(transform.zoom || 100), x: Number(transform.x ?? 50), y: Number(transform.y ?? 50),
    slotTransforms: structuredClone(frame.slotTransforms.length === frame.slots ? frame.slotTransforms : defaultSlotTransforms(frame.slots)),
    stickers: structuredClone(frame.stickers), selected: { type: "slot", index: 0 },
  };
  $("#frame-upload-slots").value = String(frame.slots);
  $("#frame-upload-zoom").value = String(state.pendingFrameUpload.zoom);
  setText("#frame-editor-eyebrow", "EDIT DESAIN FRAME");
  setText("#frame-editor-title", frame.asset.name.replace(/^\d+-/, ""));
  setFrameEditorTab("design");
  updateFrameUploadPreview();
  $("#frame-editor-dialog").showModal();
}

async function uploadAsset(file, kind, frameOptions = {}) {
  if (!file) return;
  if (file.size > assetUploadLimit()) return toast(`Ukuran gambar maksimal ${assetUploadLimitLabel()}`, "error");
  try {
    const imageDimensions = kind === "frame" ? await readImageDimensions(file) : null;
    const result = await api(`/api/assets/${kind}`, { method: "PUT", headers: { "Content-Type": file.type, "X-Filename": file.name }, body: file });
    state.assets[kind].unshift(result.asset);
    if (kind === "background") state.assetPages.background = 1;
    const setting = kind === "frame" ? "activeFrame" : kind === "logo" ? "activeLogo" : "activeBackground";
    state.settings.appearance[setting] = result.asset.url;
    if (kind === "frame") {
      state.settings.appearance.framePhotoSlots ||= {};
      state.settings.appearance.framePhotoWidths ||= {};
      state.settings.appearance.frameLayoutModes ||= {};
      state.settings.appearance.frameSizePresets ||= {};
      state.settings.appearance.frameCanvasSizes ||= {};
      state.settings.appearance.frameOriginalCanvasSizes ||= {};
      state.settings.appearance.frameBackgroundTransforms ||= {};
      state.settings.appearance.frameSlotTransforms ||= {};
      state.settings.appearance.frameStickers ||= {};
      const initialSlots = Math.max(1, Math.min(8, Number(frameOptions.slots || 3)));
      state.settings.appearance.framePhotoSlots[result.asset.url] = initialSlots;
      state.settings.appearance.framePhotoWidths[result.asset.url] = 86;
      state.settings.appearance.frameLayoutModes[result.asset.url] = "auto";
      state.settings.appearance.frameSizePresets[result.asset.url] = "auto";
      state.settings.appearance.frameCanvasSizes[result.asset.url] = { width: imageDimensions.width, height: imageDimensions.height };
      state.settings.appearance.frameOriginalCanvasSizes[result.asset.url] = { width: imageDimensions.width, height: imageDimensions.height };
      state.settings.appearance.frameBackgroundTransforms[result.asset.url] = { zoom: Number(frameOptions.zoom || 100), x: Number(frameOptions.x ?? 50), y: Number(frameOptions.y ?? 50) };
      state.settings.appearance.frameSlotTransforms[result.asset.url] = structuredClone(frameOptions.slotTransforms || defaultSlotTransforms(initialSlots));
      state.settings.appearance.frameStickers[result.asset.url] = structuredClone(frameOptions.stickers || []);
      state.settings.booth.photoSlotsPerSession = initialSlots;
      state.dirtySections.add("booth");
      syncActiveFrameCapacity();
    }
    state.dirtySections.add("appearance");
    const label = kind === "frame" ? "Frame" : kind === "logo" ? "Logo" : "Background";
    renderAssets(); updatePreview(); toast(`${label} berhasil ditambahkan dan dipilih`);
  } catch (error) { toast(`Gagal mengunggah: ${error.message}`, "error"); }
}

async function uploadFrameSticker(file) {
  if (!file || !state.pendingFrameUpload) return;
  if (file.size > assetUploadLimit()) return toast(`Ukuran logo atau stiker maksimal ${assetUploadLimitLabel()}`, "error");
  try {
    await readImageDimensions(file);
    const asset = (await api("/api/assets/sticker", { method: "PUT", headers: { "Content-Type": file.type, "X-Filename": file.name }, body: file })).asset;
    state.assets.sticker ||= [];
    state.assets.sticker.unshift(asset);
    const topLayer = Math.max(0, ...frameLayers(state.pendingFrameUpload).map(layer => layer.z));
    state.pendingFrameUpload.stickers.push({ url: asset.url, x: 50, y: 88, size: 28, rotation: 0, opacity: 100, z: topLayer + 1 });
    state.pendingFrameUpload.selected = { type: "sticker", index: state.pendingFrameUpload.stickers.length - 1 };
    updateFrameUploadPreview();
    toast("Logo atau stiker ditambahkan. Geser untuk mengatur posisinya.");
  } catch (error) { toast(`Gagal menambahkan stiker: ${error.message}`, "error"); }
}

async function deleteAsset(kind, url) {
  const asset = state.assets[kind].find(item => item.url === url);
  const filename = asset?.id || asset?.name || url.split("/").pop();
  try {
    await api(`/api/assets/${kind}/${encodeURIComponent(filename)}`, { method: "DELETE" });
    state.assets[kind] = state.assets[kind].filter(asset => asset.url !== url);
    const setting = kind === "frame" ? "activeFrame" : kind === "logo" ? "activeLogo" : "activeBackground";
    if (kind === "frame" && state.settings.appearance.framePhotoSlots) delete state.settings.appearance.framePhotoSlots[url];
    if (kind === "frame" && state.settings.appearance.framePhotoWidths) delete state.settings.appearance.framePhotoWidths[url];
    if (kind === "frame" && state.settings.appearance.frameBackgroundTransforms) delete state.settings.appearance.frameBackgroundTransforms[url];
    if (kind === "frame" && state.settings.appearance.frameSlotTransforms) delete state.settings.appearance.frameSlotTransforms[url];
    if (kind === "frame" && state.settings.appearance.frameStickers) delete state.settings.appearance.frameStickers[url];
    if (kind === "frame" && state.settings.appearance.frameLayoutModes) delete state.settings.appearance.frameLayoutModes[url];
    if (kind === "frame" && state.settings.appearance.frameSizePresets) delete state.settings.appearance.frameSizePresets[url];
    if (kind === "frame" && state.settings.appearance.frameCanvasSizes) delete state.settings.appearance.frameCanvasSizes[url];
    if (kind === "frame" && state.settings.appearance.frameOriginalCanvasSizes) delete state.settings.appearance.frameOriginalCanvasSizes[url];
    if (state.settings.appearance[setting] === url) {
      state.settings.appearance[setting] = defaults[kind][0].url;
      if (kind === "frame") syncActiveFrameCapacity(true);
      state.dirtySections.add("appearance");
    }
    renderAssets(); updatePreview(); toast("Gambar berhasil dihapus");
  } catch (error) { toast(`Gagal menghapus: ${error.message}`, "error"); }
}

function deviceRow(device) {
  const icon = device.kind === "camera" ? "camera" : "printer";
  const status = device.status === "connected" ? "Tersambung" : device.status === "attention" ? "Perlu dicek" : "Terputus";
  return `<div class="device-row"><span class="device-glyph"><img src="/icons/${icon}.svg" alt="" /></span><b>${device.name}</b><span class="device-protocol">${device.detail}</span><span class="device-state ${device.status}">${status}</span></div>`;
}

function deviceCard(device) {
  const icon = device.kind === "camera" ? "camera" : "printer";
  const status = device.status === "connected" ? "Tersambung" : device.status === "attention" ? "Perlu dicek" : "Terputus";
  return `<article class="device-card"><span class="device-glyph"><img src="/icons/${icon}.svg" alt="" /></span><div><b>${device.name}</b><p>${device.detail}</p></div><span class="device-state ${device.status}">${status}</span></article>`;
}

function renderDevices(devices) {
  $("#device-summary").innerHTML = devices.map(deviceRow).join("");
  $("#device-detail-grid").innerHTML = devices.map(deviceCard).join("");
  const populate = (select, kind, selected) => {
    const connected = devices.filter(device => device.kind === kind && device.status === "connected");
    select.innerHTML = `<option value="auto">Pilih otomatis</option>` + connected.map(device => `<option value="${device.id}">${device.name}${kind === "camera" ? ` · ${device.id.startsWith("/dev/video") ? "Webcam USB" : "Kamera foto"}` : ""}</option>`).join("");
    select.value = connected.some(device => device.id === selected) ? selected : "auto";
  };
  populate($("#camera-select"), "camera", state.settings.devices.preferredCamera);
  populate($("#printer-select"), "printer", state.settings.devices.preferredPrinter);
  const camera = devices.find(device => device.kind === "camera" && device.status === "connected");
  const printer = devices.find(device => device.kind === "printer" && device.status === "connected");
  setText("#device-camera-status", camera ? "Tersambung" : "Terputus");
  setText("#device-camera-name", camera?.name || "Tidak ada kamera aktif");
  const selectedCamera = devices.find(device => device.kind === "camera" && device.status === "connected" && device.id === state.settings.devices.preferredCamera) || camera;
  setText("#camera-driver-detail", selectedCamera ? `${selectedCamera.id.startsWith("/dev/video") ? "Webcam USB" : "Kamera foto"} terdeteksi melalui ${selectedCamera.detail}.` : "Webcam USB memakai UVC/V4L2; DSLR atau mirrorless memakai gPhoto2/PTP.");
  setText("#device-printer-status", printer ? "Tersambung" : "Terputus");
  setText("#device-printer-name", printer?.name || "Tidak ada printer aktif");
  setText("#device-connected-count", `${Number(Boolean(camera)) + Number(Boolean(printer))} / 2`);
  if (state.cameraPreviewEnabled && !devices.some(device => device.kind === "camera" && device.status === "connected")) stopCameraPreview("Kamera terputus. Sambungkan kamera lalu nyalakan preview kembali.");
}

function renderBoothClients(clients = []) {
  setText("#booth-client-count", `${clients.length} AKTIF`);
  $("#booth-client-list").innerHTML = clients.length ? clients.map(client => {
    const screen = client.screen || {};
    const capabilities = [client.touch ? "Touchscreen" : "Non-touch", `${screen.width || 0}×${screen.height || 0}`, client.standalone ? "PWA" : "Browser", `${(client.cameras || []).length} kamera`].join(" · ");
    const cameraNames = (client.cameras || []).join(", ") || "Kamera belum diberi izin";
    return `<article class="device-card"><span class="device-glyph"><img src="/icons/monitor.svg" alt="" /></span><div><b>${escapeHtml(client.platform || "Perangkat pelanggan")}</b><p>${escapeHtml(capabilities)}<br>${escapeHtml(cameraNames)}</p></div><span class="device-state connected">Tersambung</span></article>`;
  }).join("") : '<p class="empty">Belum ada perangkat pelanggan yang membuka layar booth.</p>';
}

function renderActivity(events) {
  $("#activity-list").innerHTML = events.length ? events.map(event => `<div class="activity-item"><i></i><b>${event.type}</b><span>${event.message}</span><time>${new Date(event.createdAt).toLocaleString("id-ID")}</time></div>`).join("") : '<p class="empty">Belum ada aktivitas.</p>';
}

function renderStatus(status) {
  state.status = status;
  const issues = status.devices.filter(device => device.status !== "connected").length + Number(status.disk.usedPercent >= 90);
  const healthy = issues === 0;
  const banner = $("#health-banner");
  banner.classList.toggle("attention", !healthy);
  $(".readiness-mark img", banner).src = healthy ? "/icons/circle-check.svg" : "/icons/triangle-alert.svg";
  $("strong", banner).textContent = healthy ? "Photobox siap digunakan" : `${issues} hal perlu diperiksa`;
  $("p", banner).textContent = healthy ? "Kamera, printer, internet, dan penyimpanan dalam kondisi baik." : "Buka Kamera & printer atau Penyimpanan untuk melihat masalahnya.";
  $("#overall-status").textContent = healthy ? "SIAP DIGUNAKAN" : "PERLU DIPERIKSA";
  const sessionPercent = Math.min(100, Math.round((status.usage.sessions / Math.max(1, status.dailyLimit)) * 100));
  $("#sessions-value").textContent = status.usage.sessions; $("#session-limit").textContent = `${status.usage.sessions} dari ${status.dailyLimit}`; $("#sessions-caption").textContent = `${sessionPercent}% terpakai`; $("#sessions-progress").style.width = `${sessionPercent}%`;
  $("#photos-value").textContent = status.usage.photos; $("#prints-value").textContent = status.usage.prints; $("#revenue-value").textContent = formatIDR(status.usage.revenue);
  $("#storage-value").textContent = `${status.disk.usedPercent}%`; $("#storage-progress").style.width = `${status.disk.usedPercent}%`; $("#storage-caption").textContent = `${formatBytes(status.disk.freeBytes)} tersisa`;
  const ram = status.memory.available ? status.memory.usedPercent : 0; $("#ram-value").textContent = status.memory.available ? `${ram}%` : "Tidak tersedia"; $("#ram-progress").style.width = `${ram}%`;
  const signal = status.network.connected ? status.network.signalPercent : 0; $("#signal-value").textContent = status.network.connected ? `${signal}%` : "Tidak tersambung"; $("#signal-progress").style.width = `${signal}%`;
  $("#uptime-value").textContent = formatUptime(status.uptimeSeconds); $("#sidebar-uptime").textContent = formatUptime(status.uptimeSeconds);
  setText("#system-uptime-summary", formatUptime(status.uptimeSeconds));
  setText("#system-disk-summary", `${status.disk.usedPercent}%`);
  setText("#system-disk-detail", `${formatBytes(status.disk.freeBytes)} masih tersedia`);
  setText("#system-memory-summary", status.memory.available ? formatBytes(status.memory.totalBytes) : "Tidak tersedia");
  setText("#system-memory-detail", status.memory.available ? `${status.memory.usedPercent}% sedang digunakan` : "Metrik tidak didukung sistem");
  setText("#system-network-summary", status.network.connected ? `${status.network.signalPercent}%` : "Offline");
  setText("#system-network-detail", status.network.connected ? status.network.ssid : "Tidak ada koneksi aktif");
  $("#last-refresh").textContent = `Terakhir: ${new Date(status.timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  $("#pending-uploads").textContent = status.queue.pendingUploads; $("#failed-uploads").textContent = status.queue.failedUploads; $("#pending-prints").textContent = status.queue.pendingPrints;
  renderDevices(status.devices); renderBoothClients(status.boothClients); renderActivity(status.events);
}

async function refreshStatus(notify = false) {
  try { renderStatus(await api("/api/overview")); if ($("#storage-view")?.classList.contains("active")) await loadStorageData(notify); if (notify) toast("Data mesin berhasil diperbarui"); }
  catch (error) { toast(`Tidak dapat membaca kondisi mesin: ${error.message}`, "error"); }
}

function renderStorageData(overview, sessions) {
  const { disk, memory, library } = overview;
  setText("#storage-local-path-active", overview.localPath || "Folder bawaan Photoslive");
  setText("#storage-local-path-state", overview.localPath ? "DAPAT DITULIS" : "FOLDER BAWAAN");
  $("#storage-total-capacity").textContent = formatBytes(disk.totalBytes);
  $("#storage-disk-used").textContent = `${disk.usedPercent}% kapasitas terpakai`;
  $("#storage-used-capacity").textContent = formatBytes(disk.usedBytes);
  $("#storage-free-capacity").textContent = `${formatBytes(disk.freeBytes)} masih tersedia`;
  $("#storage-photo-size").textContent = formatBytes(library.totalBytes);
  $("#storage-photo-count").textContent = `${library.fileCount} file · ${library.sessionFolders} folder sesi`;
  $("#storage-memory-total").textContent = memory.available ? formatBytes(memory.totalBytes) : "Tidak tersedia";
  $("#storage-memory-used").textContent = memory.available ? `${formatBytes(memory.usedBytes)} sedang digunakan (${memory.usedPercent}%)` : "Metrik RAM tidak didukung sistem";
  $("#storage-disk-percent").textContent = `${disk.usedPercent}% · ${formatBytes(disk.freeBytes)} bebas`;
  $("#storage-disk-bar").style.width = `${Math.min(100, disk.usedPercent)}%`;
  const libraryPercent = disk.totalBytes ? Math.min(100, (library.totalBytes / disk.totalBytes) * 100) : 0;
  $("#storage-library-percent").textContent = `${formatBytes(library.totalBytes)} · ${library.fileCount} file`;
  $("#storage-library-bar").style.width = `${Math.max(library.fileCount ? 1 : 0, libraryPercent)}%`;
  const measured = new Date(overview.measuredAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#storage-measured-at").textContent = `Diukur pukul ${measured}${overview.cached ? ` · memakai cache ${overview.cacheAgeSeconds} detik` : " · pengukuran baru"}. Pemindaian otomatis dibatasi agar mesin tetap ringan.`;
  $("#storage-session-list").innerHTML = sessions.length ? sessions.map(session => {
    const status = session.uploadedAt ? "Sudah di-upload" : session.status === "active" ? "Tersimpan lokal" : session.status;
    const selected = Number(session.selectedPhotoCount || 0);
    const slots = Number(session.photoSlots || 1);
    return `<div class="session-row"><div class="session-id"><code>${session.id}</code><small>Berlaku sampai ${new Date(session.expiresAt).toLocaleString("id-ID")}</small></div><time>${new Date(session.createdAt).toLocaleString("id-ID")}</time><span>${selected}/${slots} final · ${session.photoCount} file</span><span>${formatBytes(session.totalBytes)}</span><span class="device-state ${session.uploadedAt ? "" : "attention"}">${status}</span><a class="session-link" href="${session.shareUrl}" target="_blank" rel="noopener"><img src="/icons/arrow-right.svg" alt="" />Buka sesi</a></div>`;
  }).join("") : '<p class="empty">Belum ada sesi foto dalam 24 jam terakhir. Sesi baru akan otomatis muncul dan memiliki link sendiri.</p>';
}

async function loadStorageData(force = false) {
  if (state.storageLoading) return;
  if (!force && state.storageLoadedAt && Date.now() - state.storageLoadedAt < 120000) return;
  state.storageLoading = true;
  try {
    const [overview, sessionPayload] = await Promise.all([
      api(`/api/storage/overview${force ? "?refresh=1" : ""}`),
      api("/api/storage/sessions?hours=24"),
    ]);
    state.storageLoadedAt = Date.now();
    renderStorageData(overview, sessionPayload.sessions);
    if (force) toast("Data penyimpanan berhasil diukur ulang");
  } catch (error) { toast(`Tidak dapat membaca penyimpanan: ${error.message}`, "error"); }
  finally { state.storageLoading = false; }
}

async function pickStorageFolder() {
  const button = $("#pick-storage-folder");
  button.disabled = true;
  toast("Dialog folder dibuka di komputer Agent…");
  try {
    const result = await api("/api/storage/pick-folder", { method: "POST", body: "{}", timeoutMs: 305_000 });
    const input = $("#storage-local-path");
    input.value = result.path || "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    toast(`Folder dipilih: ${result.path}`);
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

async function loadVouchers() {
  const { vouchers, summary, events } = await api("/api/vouchers");
  const activeVouchers = Number(summary.generalActive || 0) + Number(summary.eventActive || 0);
  const methods = Number(state.settings.payment.qrisEnabled) + Number(state.settings.payment.voucherEnabled);
  setText("#access-method-count", `${methods} aktif`);
  setText("#access-method-detail", `${activeVouchers} voucher siap dipakai`);
  setText("#voucher-general-active", String(summary.generalActive || 0));
  setText("#voucher-event-active", String(summary.eventActive || 0));
  setText("#voucher-used-total", String(summary.used || 0));
  $("#print-general-vouchers").disabled = !Number(summary.generalActive || 0);
  $("#voucher-list").innerHTML = vouchers.length ? vouchers.map(voucher => `<div class="voucher-row"><code>${escapeHtml(voucher.code)}</code><span>${voucher.eventId ? escapeHtml(voucher.eventName || "Event") : "Voucher umum"}</span><span class="voucher-benefit ${voucher.includesPrint ? "" : "digital"}">${voucher.includesPrint ? "Sesi + cetak" : "Sesi digital"}</span><time>${new Date(voucher.createdAt).toLocaleDateString("id-ID")}</time><button class="icon-button" aria-label="Hapus voucher ${escapeHtml(voucher.code)}" data-delete-voucher="${escapeHtml(voucher.code)}"><img src="/icons/trash-2.svg" alt="" /></button></div>`).join("") : '<p class="empty" style="padding:18px">Belum ada voucher aktif.</p>';
  $("#voucher-event-list").innerHTML = events.length ? events.map(event => `<article class="voucher-event-card ${event.status}"><div class="voucher-event-main"><span><img src="/icons/calendar-days.svg" alt="" /></span><div><div class="voucher-event-title"><b>${escapeHtml(event.name)}</b><em>${event.status === "expired" ? "Berakhir" : "Aktif"}</em></div><small>Berlaku sampai ${new Date(event.expiresAt).toLocaleString("id-ID")} · ${event.includesPrint ? "Termasuk cetak" : "Tanpa cetak"}</small></div></div><div class="voucher-event-stats"><span><b>${event.active}</b><small>Aktif</small></span><span><b>${event.used}</b><small>Dipakai</small></span><span><b>${event.total}</b><small>Total</small></span></div><div class="voucher-event-actions"><button class="button secondary" data-print-vouchers="${event.id}" ${event.active ? "" : "disabled"}><img src="/icons/printer.svg" alt="" />Cetak kode</button><button class="button primary" data-generate-event="${event.id}" ${event.status === "expired" ? "disabled" : ""}><img src="/icons/plus.svg" alt="" />Generate 100</button></div></article>`).join("") : '<p class="empty">Belum ada event. Buat event lalu generate 100 kode pertama.</p>';
}

async function createVoucher() {
  const body = { code: $("#voucher-code").value.trim() };
  try { const { voucher } = await api("/api/vouchers", { method: "POST", body: JSON.stringify(body) }); $("#voucher-dialog").close(); await loadVouchers(); toast(`Voucher ${voucher.code} berhasil dibuat`); }
  catch (error) { toast(`Gagal membuat voucher: ${error.message}`, "error"); }
}

async function generateVouchers(eventId = null) {
  try {
    const result = await api("/api/vouchers/generate", { method: "POST", body: JSON.stringify({ count: 100, eventId }) });
    await loadVouchers();
    toast(`${result.created} voucher baru ditambahkan${eventId ? " ke event" : ""}`);
  } catch (error) { toast(`Gagal membuat voucher: ${error.message}`, "error"); }
}

async function createVoucherEvent() {
  const body = { name: $("#voucher-event-name").value.trim(), expiresAt: $("#voucher-event-expiry").value, includesPrint: $("#voucher-event-print").checked };
  try {
    const { event } = await api("/api/voucher-events", { method: "POST", body: JSON.stringify(body) });
    $("#voucher-event-dialog").close();
    await loadVouchers();
    toast(`Event ${event.name} dibuat. Tekan Generate 100 untuk menambahkan kode.`);
  } catch (error) { toast(`Gagal membuat event: ${error.message}`, "error"); }
}

async function printVouchers(eventId = null) {
  const url = `/api/vouchers/print${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ""}`;
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") return window.open(url, "_blank", "noopener");
  const popup = window.open("", "_blank");
  try {
    if (!popup) throw new Error("Browser memblokir jendela cetak");
    popup.document.write("<p style='font:16px system-ui;padding:24px'>Menyiapkan voucher…</p>");
    const { codes } = await api(url);
    if (!codes?.length) throw new Error("Tidak ada voucher aktif untuk dicetak");
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><title>Voucher Photoslive</title><style>body{font:14px system-ui;margin:24px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.code{border:1px dashed #333;padding:16px;text-align:center;break-inside:avoid}.code b{display:block;font-size:18px;letter-spacing:1px}@media print{body{margin:8mm}}</style></head><body><div class="grid">${codes.map(code => `<div class="code"><small>PHOTOSLIVE</small><b>${escapeHtml(code)}</b><span>Sekali pakai</span></div>`).join("")}</div><script>window.print()<\/script></body></html>`);
    popup.document.close();
  } catch (error) { popup?.close(); toast(`Voucher tidak dapat dibuka: ${error.message}`, "error"); }
}

async function testDevice(kind) {
  try { const result = await api(`/api/devices/${kind}/test`, { method: "POST" }); toast(result.message || "Perangkat siap digunakan"); await refreshStatus(); }
  catch (error) { toast(`Perangkat belum siap: ${error.message}`, "error"); }
}

function setCameraPreviewMessage(title, detail) {
  const placeholder = $("#camera-preview-placeholder");
  placeholder.hidden = false;
  $("b", placeholder).textContent = title;
  $("p", placeholder).textContent = detail;
  $("#camera-preview-image").hidden = true;
}

async function loadCameraPreview() {
  if (!state.cameraPreviewEnabled) return;
  try {
    let url;
    if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
      url = cloudBinaryUrl(await cloudControllerApi(`/api/devices/camera/preview.jpg?t=${Date.now()}`));
    } else {
      const response = await fetch(`/api/devices/camera/preview.jpg?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || "Preview kamera tidak tersedia"); }
      url = URL.createObjectURL(await response.blob());
    }
    if (state.cameraPreviewUrl) URL.revokeObjectURL(state.cameraPreviewUrl);
    state.cameraPreviewUrl = url;
    const image = $("#camera-preview-image");
    image.src = url;
    image.hidden = false;
    $("#camera-preview-placeholder").hidden = true;
    const devices = state.status?.devices || [];
    const selected = devices.find(device => device.kind === "camera" && device.status === "connected" && device.id === state.settings.devices.preferredCamera) || devices.find(device => device.kind === "camera" && device.status === "connected");
    $("#camera-preview-status").textContent = `Preview aktif · ${selected?.id?.startsWith("/dev/video") ? "webcam UVC/V4L2" : "kamera gPhoto2/PTP"} · diperbarui setiap 2 detik`;
    updateDevicePreviews();
  } catch (error) {
    setCameraPreviewMessage("Preview belum tersedia", error.message);
    $("#camera-preview-status").textContent = `Preview aktif, menunggu kamera · ${error.message}`;
  }
}

function stopCameraPreview(message = "Preview mati — tidak memakai kamera atau CPU.") {
  state.cameraPreviewEnabled = false;
  clearInterval(state.cameraPreviewTimer);
  state.cameraPreviewTimer = null;
  if (state.cameraPreviewUrl) URL.revokeObjectURL(state.cameraPreviewUrl);
  state.cameraPreviewUrl = null;
  $("#toggle-camera-preview span").textContent = "Nyalakan preview";
  setCameraPreviewMessage("Preview belum dinyalakan", "Sambungkan webcam atau kamera foto, lalu tekan Nyalakan preview.");
  $("#camera-preview-status").textContent = message;
}

async function toggleCameraPreview() {
  if (state.cameraPreviewEnabled) return stopCameraPreview();
  state.cameraPreviewEnabled = true;
  $("#toggle-camera-preview span").textContent = "Matikan preview";
  $("#camera-preview-status").textContent = "Menghubungkan ke kamera…";
  await loadCameraPreview();
  state.cameraPreviewTimer = setInterval(loadCameraPreview, 2000);
}

async function printTestPage() {
  try {
    const result = await api("/api/devices/printer/test-page", { method: "POST" });
    toast(result.message || "Lembar tes dikirim ke printer");
    await refreshStatus();
  } catch (error) { toast(`Lembar tes tidak dapat dicetak: ${error.message}`, "error"); }
}

async function downloadDiagnostics() {
  try {
    const data = await api("/api/diagnostics");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    link.download = `photoslive-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    link.click(); URL.revokeObjectURL(link.href); toast("Laporan kondisi berhasil diunduh");
  } catch (error) { toast(`Gagal mengunduh laporan: ${error.message}`, "error"); }
}

function bindEvents() {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $$('[data-go]').forEach(button => button.addEventListener("click", () => showView(button.dataset.go)));
  document.addEventListener("input", event => { if (event.target.matches("[data-setting]")) markSetting(event.target); });
  document.addEventListener("change", event => { if (event.target.matches("[data-setting]")) markSetting(event.target); });
  $("#save-button").addEventListener("click", saveSettings);
  $("#pick-storage-folder").addEventListener("click", pickStorageFolder);
  $("#refresh-button").addEventListener("click", () => refreshStatus(true));
  $("#add-background").addEventListener("click", () => chooseAsset("background"));
  $("#add-frame").addEventListener("click", () => chooseAsset("frame"));
  $("#add-logo").addEventListener("click", () => chooseAsset("logo"));
  $("#frame-upload-slots").addEventListener("change", event => { if (state.pendingFrameUpload) { state.pendingFrameUpload.slots = Number(event.target.value); state.pendingFrameUpload.slotTransforms = defaultSlotTransforms(state.pendingFrameUpload.slots); state.pendingFrameUpload.selected = { type: "slot", index: 0 }; updateFrameUploadPreview(); } });
  $("#frame-upload-zoom").addEventListener("input", event => { if (state.pendingFrameUpload) { state.pendingFrameUpload.zoom = Number(event.target.value); updateFrameUploadPreview(); } });
  $("#frame-element-rotation").addEventListener("input", event => {
    if (!state.pendingFrameUpload?.selected) return;
    selectedFrameElements().forEach(item => { item.rotation = Number(event.target.value); });
    updateFrameUploadPreview();
  });
  $("#frame-element-size").addEventListener("input", event => {
    if (!state.pendingFrameUpload?.selected) return;
    const selected = state.pendingFrameUpload.selected;
    selectedFrameElements().forEach(item => { if (selected.type === "sticker") item.size = Number(event.target.value); else item.width = Number(event.target.value) * 0.84; });
    updateFrameUploadPreview();
  });
  $("#frame-element-opacity").addEventListener("input", event => { selectedFrameElements().forEach(item => { item.opacity = Number(event.target.value); }); updateFrameUploadPreview(); });
  $("#select-all-frame-slots").addEventListener("click", () => { if (state.pendingFrameUpload) { state.pendingFrameUpload.selected = { type: "all-slots", index: 0 }; updateFrameUploadPreview(); } });
  $$('[data-frame-editor-tab]').forEach(button => button.addEventListener("click", () => setFrameEditorTab(button.dataset.frameEditorTab)));
  $("#frame-layer-list").addEventListener("click", event => {
    if (!state.pendingFrameUpload) return;
    const row = event.target.closest(".frame-layer-row");
    if (!row) return;
    const type = row.dataset.layerType, index = Number(row.dataset.layerIndex);
    state.pendingFrameUpload.selected = { type, index };
    const layers = frameLayers();
    const position = layers.findIndex(layer => layer.type === type && layer.index === index);
    const direction = event.target.closest(".layer-up") ? -1 : event.target.closest(".layer-down") ? 1 : 0;
    if (direction && layers[position + direction]) {
      const current = type === "sticker" ? state.pendingFrameUpload.stickers[index] : state.pendingFrameUpload.slotTransforms[index];
      const adjacentLayer = layers[position + direction];
      const adjacent = adjacentLayer.type === "sticker" ? state.pendingFrameUpload.stickers[adjacentLayer.index] : state.pendingFrameUpload.slotTransforms[adjacentLayer.index];
      const currentZ = Number(current.z || 1); current.z = Number(adjacent.z || 1); adjacent.z = currentZ;
    }
    updateFrameUploadPreview();
  });
  $("#add-frame-sticker").addEventListener("click", () => { $("#sticker-file").value = ""; $("#sticker-file").click(); });
  $("#sticker-file").addEventListener("change", event => uploadFrameSticker(event.target.files[0]));
  $("#remove-frame-element").addEventListener("click", () => {
    if (state.pendingFrameUpload?.selected?.type !== "sticker") return;
    state.pendingFrameUpload.stickers.splice(state.pendingFrameUpload.selected.index, 1);
    state.pendingFrameUpload.selected = { type: "slot", index: 0 };
    updateFrameUploadPreview();
  });
  const cropPreview = $("#frame-upload-preview");
  let cropDrag = null;
  cropPreview.addEventListener("pointerdown", event => {
    if (!state.pendingFrameUpload) return;
    const element = event.target.closest(".frame-editor-element");
    if (element && !(state.pendingFrameUpload.selected?.type === "all-slots" && element.dataset.editorType === "slot")) state.pendingFrameUpload.selected = { type: element.dataset.editorType, index: Number(element.dataset.editorIndex) };
    const selected = state.pendingFrameUpload.selected;
    const target = element ? selectedFrameElements()[0] : state.pendingFrameUpload;
    cropDrag = { kind: element ? "element" : "artwork", clientX: event.clientX, clientY: event.clientY, x: target.x, y: target.y, group: selected.type === "all-slots" ? state.pendingFrameUpload.slotTransforms.map(item => ({ x: item.x, y: item.y })) : null };
    cropPreview.setPointerCapture(event.pointerId);
    cropPreview.classList.add("dragging");
    updateFrameUploadPreview();
  });
  cropPreview.addEventListener("pointermove", event => {
    if (!cropDrag || !state.pendingFrameUpload) return;
    const bounds = cropPreview.getBoundingClientRect();
    const direction = cropDrag.kind === "element" ? 1 : -1;
    const x = Math.max(0, Math.min(100, cropDrag.x + direction * ((event.clientX - cropDrag.clientX) / bounds.width) * 100));
    const y = Math.max(0, Math.min(100, cropDrag.y + direction * ((event.clientY - cropDrag.clientY) / bounds.height) * 100));
    if (cropDrag.kind === "element") {
      const selected = state.pendingFrameUpload.selected;
      if (selected.type === "all-slots") {
        const deltaX = x - cropDrag.x, deltaY = y - cropDrag.y;
        state.pendingFrameUpload.slotTransforms.forEach((item, index) => { item.x = Math.max(0, Math.min(100, cropDrag.group[index].x + deltaX)); item.y = Math.max(0, Math.min(100, cropDrag.group[index].y + deltaY)); });
      } else { const target = selectedFrameElements()[0]; target.x = x; target.y = y; }
    } else { state.pendingFrameUpload.x = x; state.pendingFrameUpload.y = y; }
    updateFrameUploadPreview();
  });
  const endCropDrag = event => {
    if (!cropDrag) return;
    cropDrag = null;
    cropPreview.classList.remove("dragging");
    if (cropPreview.hasPointerCapture(event.pointerId)) cropPreview.releasePointerCapture(event.pointerId);
  };
  cropPreview.addEventListener("pointerup", endCropDrag);
  cropPreview.addEventListener("pointercancel", endCropDrag);
  $("#save-frame-upload").addEventListener("click", async event => {
    event.preventDefault();
    if (!state.pendingFrameUpload) return;
    const pending = state.pendingFrameUpload;
    if (pending.mode === "new") await uploadAsset(pending.file, "frame", pending);
    else {
      const appearance = state.settings.appearance;
      appearance.framePhotoSlots ||= {}; appearance.frameBackgroundTransforms ||= {}; appearance.frameSlotTransforms ||= {}; appearance.frameStickers ||= {};
      appearance.framePhotoSlots[pending.frameUrl] = pending.slots;
      appearance.frameBackgroundTransforms[pending.frameUrl] = { zoom: pending.zoom, x: pending.x, y: pending.y };
      appearance.frameSlotTransforms[pending.frameUrl] = structuredClone(pending.slotTransforms);
      appearance.frameStickers[pending.frameUrl] = structuredClone(pending.stickers);
      if (appearance.activeFrame === pending.frameUrl) state.settings.booth.photoSlotsPerSession = pending.slots;
      state.dirtySections.add("appearance"); state.dirtySections.add("booth");
      renderAssets(); updatePreview(); toast("Perubahan desain disimpan");
    }
    if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
    state.pendingFrameUpload = null;
    $("#frame-editor-dialog").close();
  });
  $("#frame-editor-dialog").addEventListener("close", () => { if (state.pendingFrameUpload?.previewUrl) URL.revokeObjectURL(state.pendingFrameUpload.previewUrl); state.pendingFrameUpload = null; });
  $("#asset-file").addEventListener("change", event => event.target.dataset.kind === "frame" ? prepareFrameUpload(event.target.files[0]) : uploadAsset(event.target.files[0], event.target.dataset.kind));
  document.addEventListener("click", async event => {
    const pageButton = event.target.closest("[data-asset-page]");
    if (pageButton && !pageButton.disabled) { state.assetPages[pageButton.dataset.assetKind] = Number(pageButton.dataset.assetPage); renderAssets(); return; }
    const edit = event.target.closest(".asset-edit");
    if (edit) { event.stopPropagation(); openFrameEditor(edit.closest(".asset-card").dataset.assetUrl); return; }
    const select = event.target.closest(".asset-select");
    if (select) { const card = select.closest(".asset-card"); const key = card.dataset.assetKind === "frame" ? "activeFrame" : card.dataset.assetKind === "logo" ? "activeLogo" : "activeBackground"; state.settings.appearance[key] = card.dataset.assetUrl; state.dirtySections.add("appearance"); if (card.dataset.assetKind === "frame") syncActiveFrameCapacity(true); renderAssets(); updatePreview(); }
    const remove = event.target.closest(".asset-remove");
    if (remove) { event.stopPropagation(); const card = remove.closest(".asset-card"); await deleteAsset(card.dataset.assetKind, card.dataset.assetUrl); }
    const eventGenerate = event.target.closest("[data-generate-event]");
    if (eventGenerate) { await generateVouchers(eventGenerate.dataset.generateEvent); return; }
    const voucherPrint = event.target.closest("[data-print-vouchers]");
    if (voucherPrint) { printVouchers(voucherPrint.dataset.printVouchers); return; }
    const voucherDelete = event.target.closest("[data-delete-voucher]");
    if (voucherDelete) { try { await api(`/api/vouchers/${voucherDelete.dataset.deleteVoucher}`, { method: "DELETE" }); await loadVouchers(); toast("Voucher dihapus"); } catch (error) { toast(error.message, "error"); } }
  });
  $("#create-voucher").addEventListener("click", () => { $("#voucher-form").reset(); $("#voucher-dialog").showModal(); });
  $("#submit-voucher").addEventListener("click", event => { event.preventDefault(); createVoucher(); });
  $("#generate-vouchers").addEventListener("click", () => generateVouchers());
  $("#print-general-vouchers").addEventListener("click", () => printVouchers());
  $("#create-voucher-event").addEventListener("click", () => { $("#voucher-event-form").reset(); $("#voucher-event-print").checked = true; $("#voucher-event-dialog").showModal(); });
  $("#submit-voucher-event").addEventListener("click", event => { event.preventDefault(); createVoucherEvent(); });
  $("#agent-pair-form").addEventListener("submit", claimAgent);
  $("#refresh-agent").addEventListener("click", () => loadAgentStatus(true));
  $$('[data-agent-job]').forEach(button => button.addEventListener("click", () => queueAgentJob(button.dataset.agentJob)));
  $("#scan-devices").addEventListener("click", async () => { try { const result = await api("/api/devices/refresh", { method: "POST" }); renderDevices(result.devices); toast("Pencarian perangkat selesai"); } catch (error) { toast(error.message, "error"); } });
  $("#test-camera").addEventListener("click", () => testDevice("camera"));
  $("#test-printer").addEventListener("click", () => testDevice("printer"));
  $("#toggle-camera-preview").addEventListener("click", toggleCameraPreview);
  $("#print-test-page").addEventListener("click", printTestPage);
  $("#clear-failed").addEventListener("click", async () => { try { const result = await api("/api/jobs/clear-failed", { method: "POST" }); toast(`${result.deleted} pekerjaan gagal dibersihkan`); await refreshStatus(); } catch (error) { toast(error.message, "error"); } });
  $("#run-cleanup").addEventListener("click", async () => { try { const result = await api("/api/storage/cleanup", { method: "POST" }); toast(`${result.deletedFiles} foto dihapus · ruang bertambah ${formatBytes(result.reclaimedBytes)}`); state.storageLoadedAt = 0; await loadStorageData(true); await refreshStatus(); } catch (error) { toast(error.message, "error"); } });
  $("#refresh-storage").addEventListener("click", () => loadStorageData(true));
  $("#download-diagnostics").addEventListener("click", downloadDiagnostics);
  $("#restart-service").addEventListener("click", async () => { try { const result = await api("/api/system/restart", { method: "POST" }); toast(result.message); } catch (error) { toast(error.message, "error"); } });
  $("#profile-form").addEventListener("submit", async event => { event.preventDefault(); try { await platformApi("profile", { method: "POST", body: JSON.stringify({ name: $("#profile-name").value, email: $("#profile-email").value, password: $("#profile-password").value, pin: $("#profile-pin").value }) }); $("#profile-password").value = ""; $("#profile-pin").value = ""; toast("Profil berhasil diperbarui"); await loadUsers(); } catch (error) { toast(error.message, "error"); } });
  $("#add-user-form").addEventListener("submit", async event => { event.preventDefault(); try { await platformApi("users", { method: "POST", body: JSON.stringify({ name: $("#new-user-name").value, email: $("#new-user-email").value, password: $("#new-user-password").value, pin: $("#new-user-pin").value, role: $("#new-user-role").value }) }); event.target.reset(); toast("Pengguna berhasil ditambahkan"); await loadUsers(); } catch (error) { toast(error.message, "error"); } });
}

async function boot() {
  if (!adminBoothCode || ["setup","superadmin","booth"].includes(adminBoothCode)) { location.replace("/setup?mode=login"); return; }
  const authResponse = await fetch("/api/platform?action=me");
  const auth = await authResponse.json().catch(() => ({}));
  if (!authResponse.ok || (auth.user?.role !== "superadmin" && auth.user?.boothCode !== adminBoothCode)) { location.replace(`/setup?mode=login&booth=${encodeURIComponent(adminBoothCode)}`); return; }
  localStorage.setItem("photoslive.boothCode", adminBoothCode);
  if (auth.booth?.machineId) {
    agentState.machineId = auth.booth.machineId;
    localStorage.setItem("photoslive.machineId", auth.booth.machineId);
  }
  $("#customer-screen-link").href = `/${adminBoothCode}`;
  bindEvents();
  const requestedView = new URLSearchParams(window.location.search).get("view");
  if (requestedView && titles[requestedView]) showView(requestedView);
  try {
    state.settings = await api("/api/settings");
    hydrateSettings();
    await loadVouchers();
    // Hardware status and local assets are optional background data. They may
    // be offline without blocking cloud settings, vouchers, or navigation.
    api("/api/assets", { timeoutMs: 5000 }).then(assets => { state.assets = assets; renderAssets(); updatePreview(); }).catch(() => {});
    refreshStatus(false).catch(() => {});
    if ($("#storage-view").classList.contains("active")) loadStorageData(false).catch(() => {});
    setInterval(() => refreshStatus(false).catch(() => {}), 60000);
  } catch (error) { toast(`Data admin tidak dapat dimuat: ${error.message}`, "error"); }
}

window.addEventListener("beforeunload", event => { stopCameraPreview(); if (state.dirtySections.size) { event.preventDefault(); event.returnValue = ""; } });
boot();
