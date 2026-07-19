const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const routeParts = location.pathname.split("/").filter(Boolean);
const routeBoothCode = new URLSearchParams(location.search).get("booth") || (routeParts[0] && !["booth","setup","superadmin"].includes(routeParts[0]) ? routeParts[0] : "");
const boothConfigCacheKey = () => `photoslive.boothConfig.${routeBoothCode || "local"}`;
const pendingSyncKey = () => `photoslive.pendingSessionSync.${routeBoothCode || "local"}`;

const boothState = {
  config: null,
  frames: [],
  selectedFrame: null,
  session: null,
  currentSlot: 1,
  currentPhoto: null,
  photos: {},
  previewTimer: null,
  previewUrl: null,
  cameraStream: null,
  cameraMode: null,
  cameraLabels: [],
  sessionTimer: null,
  goodbyeTimer: null,
  expired: false,
  framePage: 0,
  accessMethod: null,
  printIncluded: false,
  voucherCode: "",
};

const BUILTIN_BACKGROUNDS = {
  "default-gradient": "linear-gradient(145deg,#111522,#635bff 65%,#de79ab)",
  "soft-studio": "linear-gradient(145deg,#f7e6da,#efae9e)",
  "event-blue": "linear-gradient(145deg,#07182d,#167e9d)",
};
const BUILTIN_FRAMES = [
  { name: "Clean white", url: "clean-white", builtin: true, style: "linear-gradient(#f5f5f3,#dadbdc)" },
  { name: "Party night", url: "party-night", builtin: true, style: "linear-gradient(145deg,#171922,#9e83c4)" },
];
const FONT_FAMILIES = {
  system: "Inter,ui-sans-serif,system-ui,sans-serif", arial: "Arial,Helvetica,sans-serif",
  helvetica: "Helvetica,Arial,sans-serif", verdana: "Verdana,Geneva,sans-serif",
  tahoma: "Tahoma,Geneva,sans-serif", trebuchet: "'Trebuchet MS',Arial,sans-serif",
  georgia: "Georgia,serif", times: "'Times New Roman',Times,serif",
  garamond: "Garamond,'Times New Roman',serif", courier: "'Courier New',Courier,monospace",
};

async function boothApi(path, options = {}) {
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    if (isBoothCloudDataPath(path)) return boothCloudDataApi(path, options);
    return boothCloudControllerApi(path, options);
  }
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `Permintaan gagal (${response.status})`);
  return payload;
}

function isBoothCloudDataPath(path) {
  const pathname = String(path).split("?")[0];
  return pathname === "/api/booth/config" || pathname === "/api/booth/client" || pathname === "/api/vouchers/redeem";
}

async function boothCloudDataApi(path, options = {}) {
  let data = {};
  if (typeof options.body === "string" && options.body) data = JSON.parse(options.body);
  const method = String(options.method || "GET").toUpperCase();
  const clientId = Object.entries(options.headers || {}).find(([name]) => name.toLowerCase() === "x-client-id")?.[1] || "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 8000));
  let response;
  try {
    response = await fetch(`/api/platform?action=cloud_data&booth=${encodeURIComponent(routeBoothCode)}&path=${encodeURIComponent(path)}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify({ data, clientId }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Cloud terlalu lama merespons. Coba lagi atau gunakan voucher offline pada mesin lokal.");
    throw error;
  } finally { clearTimeout(timeout); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Cloud database gagal (${response.status})`);
  return payload;
}

async function boothBridge(action, payload = {}, method = "POST") {
  const query = method === "GET" ? `&${new URLSearchParams(payload)}` : "";
  const response = await fetch(`/api/bridge?action=${encodeURIComponent(action)}${query}`, { method, headers: { "Content-Type": "application/json", ...(boothState.config?.bridgeToken ? { Authorization: `Bearer ${boothState.config.bridgeToken}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Cloud bridge gagal (${response.status})`);
  return result;
}

async function boothCloudControllerApi(path, options = {}) {
  const routeMachineKey = `photoslive.machine.${routeBoothCode || "local"}`;
  let cachedMachine;
  try { cachedMachine = JSON.parse(localStorage.getItem(routeMachineKey) || "null"); } catch { cachedMachine = null; }
  let machineId = cachedMachine?.savedAt > Date.now() - 60_000 ? cachedMachine.id : null;
  // The route is authoritative. This prevents a tablet that previously opened
  // another booth from reusing that machine id for the current customer flow.
  if (routeBoothCode && !machineId) {
    const response = await fetch(`/api/platform?action=resolve_booth&booth=${encodeURIComponent(routeBoothCode)}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Photobox tidak ditemukan");
    if (!result.booth.enabled) throw new Error("Akses photobox sedang dinonaktifkan");
    machineId = result.booth.machineId;
    localStorage.setItem(routeMachineKey, JSON.stringify({ id: machineId, savedAt: Date.now() }));
    localStorage.setItem("photoslive.machineId", machineId);
    localStorage.setItem("photoslive.boothCode", result.booth.boothCode);
  }
  if (!machineId) throw new Error("Mesin photobox belum dipasangkan melalui halaman admin Photoslive Agent");
  let requestBody = null;
  let bodyBase64 = null;
  if (typeof options.body === "string" && options.body) requestBody = JSON.parse(options.body);
  else if (options.body instanceof Blob) bodyBase64 = await boothBlobToBase64(options.body);
  const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([name]) => ["content-type", "x-slot-index", "x-filename", "x-client-id"].includes(name.toLowerCase())));
  const { job } = await boothBridge("enqueue_job", { machineId, type: "controller.request", payload: { path, method: String(options.method || "GET").toUpperCase(), body: requestBody, bodyBase64, headers } });
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    await wait(600);
    const status = await boothBridge("job_status", { machineId, jobId: job.id }, "GET");
    if (status.job.status === "completed") return status.job.result || {};
    if (status.job.status === "failed") throw new Error(status.job.error || "Perintah gagal dijalankan Agent");
  }
  throw new Error("Agent tidak merespons dalam 35 detik");
}

function boothBlobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = reject; reader.readAsDataURL(blob);
  });
}

function boothBinaryUrl(result) {
  if (!result?.bodyBase64) throw new Error("Agent tidak mengirim preview kamera");
  const bytes = Uint8Array.from(atob(result.bodyBase64), character => character.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: result.contentType || "application/octet-stream" }));
}

function notice(message, kind = "default") {
  const element = $("#booth-notice");
  element.textContent = message;
  element.className = `booth-notice show ${kind}`;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { element.className = "booth-notice"; }, 3600);
}

function setScreen(name) {
  $("#booth-app").dataset.screen = name;
  $$('[data-booth-screen]').forEach(screen => screen.classList.toggle("is-active", screen.dataset.boothScreen === name));
  const hasSessionHeader = name !== "welcome";
  $("#session-bar").hidden = !hasSessionHeader;
  const labels = {
    frames: ["PERSIAPAN", "Pilih desain foto"], capture: ["SESI FOTO", "Ambil semua fotomu"], result: ["HASIL AKHIR", "Periksa dan cetak"],
  };
  if (labels[name]) { $("#session-step-label").textContent = labels[name][0]; $("#session-step-title").textContent = labels[name][1]; }
}

function formatMoney(value) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value || 0);
}

function applyConfiguration() {
  const { appearance } = boothState.config;
  const root = document.documentElement;
  root.style.setProperty("--accent", appearance.accentColor || "#6d5dfc");
  root.style.setProperty("--heading", appearance.headingTextColor || "#ffffff");
  root.style.setProperty("--helper", appearance.helperTextColor || "#ffffff");
  root.style.setProperty("--button-bg", appearance.buttonBackgroundColor || "#ffffff");
  root.style.setProperty("--button-text", appearance.buttonTextColor || "#7c3049");
  root.style.setProperty("--font", FONT_FAMILIES[appearance.fontFamily] || FONT_FAMILIES.system);
  root.style.setProperty("--heading-size", `${appearance.headingFontSize || 48}px`);
  root.style.setProperty("--helper-size", `${appearance.helperFontSize || 18}px`);
  root.style.setProperty("--button-size", `${appearance.buttonFontSize || 16}px`);
  root.style.setProperty("--logo-size", `${appearance.logoSizePercent || 28}%`);
  $("#welcome-title").textContent = appearance.welcomeTitle || "Abadikan momenmu";
  $("#welcome-prompt").textContent = appearance.touchPrompt || "Sentuh layar untuk memulai";
  $("#welcome-button-label").textContent = appearance.startButtonLabel || "Mulai foto";
  const background = BUILTIN_BACKGROUNDS[appearance.activeBackground];
  $("#welcome-background").style.backgroundImage = background || `url("${appearance.activeBackground}")`;
  applyLogo(appearance.activeLogo);
  boothState.frames = [...BUILTIN_FRAMES, ...(boothState.config.assets.frame || []).map(asset => ({ ...asset, builtin: false }))];
  boothState.selectedFrame = boothState.frames.find(frame => frame.url === appearance.activeFrame) || boothState.frames[0];
  boothState.framePage = Math.max(0, Math.floor(boothState.frames.indexOf(boothState.selectedFrame) / framePageSize()));
  renderFrames();
}

function applyLogo(logo) {
  const isImage = logo && logo !== "text-logo";
  [$("#customer-logo-image"), $("#session-logo-image")].forEach(image => { image.hidden = !isImage; if (isImage) image.src = logo; });
  $("#customer-logo-text").hidden = isImage;
  $("#session-brand-text").textContent = isImage ? boothState.config.booth.name : "PHOTOSLIVE";
}

function frameSlots(frameUrl) {
  const settings = boothState.config.appearance.framePhotoSlots || {};
  return Math.max(1, Math.min(8, Number(settings[frameUrl] || boothState.config.booth.photoSlotsPerSession || 1)));
}

function frameBackground(frame) {
  return frame.builtin ? frame.style : `url("${frame.url}")`;
}

function frameDisplayName(frame) {
  return frame.name.replace(/^\d+-/, "").replace(/\.(png|jpe?g|webp)$/i, "").replace(/[_-]+/g, " ").trim();
}

function framePageSize() {
  return window.matchMedia("(orientation: portrait)").matches ? 4 : 8;
}

function renderFrames() {
  const list = $("#frame-list");
  list.innerHTML = "";
  const pageSize = framePageSize();
  const pageCount = Math.max(1, Math.ceil(boothState.frames.length / pageSize));
  boothState.framePage = Math.max(0, Math.min(boothState.framePage, pageCount - 1));
  const visibleFrames = boothState.frames.slice(boothState.framePage * pageSize, (boothState.framePage + 1) * pageSize);
  list.style.setProperty("--frame-page-size", pageSize);
  visibleFrames.forEach(frame => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `frame-option ${frame.url === boothState.selectedFrame?.url ? "is-selected" : ""}`;
    button.dataset.frameUrl = frame.url;
    const thumb = document.createElement("span"); thumb.className = "frame-thumb"; thumb.style.backgroundImage = frameBackground(frame);
    const slots = document.createElement("span"); slots.className = "frame-thumb-slots"; slots.style.gridTemplateRows = `repeat(${frameSlots(frame.url)},1fr)`;
    for (let index = 0; index < frameSlots(frame.url); index += 1) slots.append(document.createElement("span"));
    const check = document.createElement("span"); check.className = "frame-check"; check.innerHTML = '<img src="/icons/circle-check.svg" alt="Dipilih" />';
    const title = document.createElement("strong"); title.textContent = frameDisplayName(frame);
    const meta = document.createElement("small"); meta.textContent = `${frameSlots(frame.url)} foto`;
    thumb.append(slots, check); button.append(thumb, title, meta); list.append(button);
  });
  $("#frame-page-count").textContent = `${boothState.framePage + 1} dari ${pageCount}`;
  $("#frame-page-prev").disabled = boothState.framePage === 0;
  $("#frame-page-next").disabled = boothState.framePage >= pageCount - 1;
  updateFrameSelection();
}

function updateFrameSelection() {
  $$(".frame-option").forEach(option => option.classList.toggle("is-selected", option.dataset.frameUrl === boothState.selectedFrame?.url));
  $("#frame-choice-label").textContent = boothState.selectedFrame ? `${frameDisplayName(boothState.selectedFrame)} · ${frameSlots(boothState.selectedFrame.url)} foto` : "Pilih satu frame";
  $("#frame-continue").disabled = !boothState.selectedFrame;
}

async function refreshCameraPreview() {
  try {
    let url;
    if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") url = boothBinaryUrl(await boothCloudControllerApi(`/api/devices/camera/preview.jpg?t=${Date.now()}`));
    else {
      const response = await fetch(`/api/devices/camera/preview.jpg?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || "Kamera belum tersedia"); }
      url = URL.createObjectURL(await response.blob());
    }
    [$("#frame-camera-image"), $("#capture-camera-image")].forEach(image => {
      image.src = url; image.classList.add("has-image");
      const rotation = Number(boothState.config.devices.cameraRotation || 0);
      const mirror = boothState.config.devices.cameraMirror ? -1 : 1;
      image.style.transform = `rotate(${rotation}deg) scaleX(${mirror})`;
    });
    $("#frame-camera-fallback").hidden = true; $("#capture-camera-fallback").hidden = true;
    $("#camera-live-pill").classList.remove("is-offline"); $("#camera-live-label").textContent = "KAMERA AKTIF";
    if (boothState.previewUrl) URL.revokeObjectURL(boothState.previewUrl);
    boothState.previewUrl = url;
    return true;
  } catch (error) {
    $("#frame-camera-fallback").hidden = false; $("#capture-camera-fallback").hidden = false;
    $("#frame-camera-status").textContent = error.message; $("#capture-camera-status").textContent = error.message;
    $("#camera-live-pill").classList.add("is-offline"); $("#camera-live-label").textContent = "KAMERA BELUM TERHUBUNG";
    return false;
  }
}

async function pollControllerPreview() {
  if (boothState.cameraMode !== "controller") return;
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    try {
      const inventory = await boothApi("/api/devices");
      const connected = (inventory.devices || []).some(device => device.kind === "camera" && device.status === "connected");
      if (!connected) {
        $("#frame-camera-fallback").hidden = false; $("#capture-camera-fallback").hidden = false;
        $("#frame-camera-status").textContent = "Kamera belum terhubung"; $("#capture-camera-status").textContent = "Kamera belum terhubung";
        $("#camera-live-pill").classList.add("is-offline"); $("#camera-live-label").textContent = "KAMERA BELUM TERHUBUNG";
        clearTimeout(boothState.previewTimer);
        boothState.previewTimer = setTimeout(pollControllerPreview, 15000);
        return;
      }
    } catch { /* Preview request below provides the actionable error state. */ }
  }
  const ready = await refreshCameraPreview();
  clearTimeout(boothState.previewTimer);
  // A healthy preview remains fluid. Missing/busy hardware is retried slowly
  // so a 4 GB kiosk does not flood logs and HTTP requests with 503 responses.
  boothState.previewTimer = setTimeout(pollControllerPreview, ready ? 1600 : 15000);
}

async function reportClientCapabilities(cameraLabels = []) {
  let clientId = localStorage.getItem("photoslive-client-id");
  if (!clientId) { clientId = `client-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`; localStorage.setItem("photoslive-client-id", clientId); }
  const payload = {
    platform: navigator.userAgentData?.platform || navigator.platform || "Unknown",
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height, pixelRatio: window.devicePixelRatio || 1 },
    touch: navigator.maxTouchPoints > 0,
    standalone: window.matchMedia("(display-mode: standalone)").matches,
    cameras: cameraLabels,
  };
  boothApi("/api/booth/client", { method: "POST", headers: { "X-Client-Id": clientId }, body: JSON.stringify(payload) }).catch(() => {});
}

async function startBrowserCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Browser ini tidak menyediakan akses kamera");
  if (!boothState.cameraStream) {
    const configuredId = boothState.config?.devices?.browserCameraId;
    const video = configuredId
      ? { deviceId: { exact: configuredId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1080 } };
    boothState.cameraStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  }
  const videos = [$("#frame-camera-video"), $("#capture-camera-video")];
  videos.forEach(video => { video.srcObject = boothState.cameraStream; video.classList.add("has-image"); });
  await Promise.all(videos.map(video => video.play().catch(() => {})));
  [$("#frame-camera-image"), $("#capture-camera-image")].forEach(image => image.classList.remove("has-image"));
  $("#frame-camera-fallback").hidden = true; $("#capture-camera-fallback").hidden = true;
  $("#camera-live-pill").classList.remove("is-offline"); $("#camera-live-label").textContent = "KAMERA PERANGKAT AKTIF";
  boothState.cameraMode = "browser";
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  boothState.cameraLabels = devices.filter(device => device.kind === "videoinput").map(device => device.label || "Kamera perangkat");
  reportClientCapabilities(boothState.cameraLabels);
}

async function startCameraPreview() {
  clearInterval(boothState.previewTimer);
  if (boothState.cameraStream) return startBrowserCamera();
  try {
    await startBrowserCamera();
  } catch (browserError) {
    boothState.cameraMode = "controller";
    $("#frame-camera-status").textContent = `${browserError.message}. Mencoba kamera controller…`;
    await pollControllerPreview();
    reportClientCapabilities();
  }
}

function stopCameraPreview() {
  clearTimeout(boothState.previewTimer); boothState.previewTimer = null;
  if (boothState.cameraStream) boothState.cameraStream.getTracks().forEach(track => track.stop());
  boothState.cameraStream = null; boothState.cameraMode = null;
  [$("#frame-camera-video"), $("#capture-camera-video")].forEach(video => { video.srcObject = null; video.classList.remove("has-image"); });
}

async function captureBrowserFrame() {
  const video = $("#capture-camera-video");
  if (!boothState.cameraStream || !video.videoWidth || !video.videoHeight) throw new Error("Frame kamera perangkat belum siap");
  const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (boothState.config.devices.cameraMirror) { context.translate(canvas.width, 0); context.scale(-1, 1); }
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .92));
  if (!blob) throw new Error("Browser gagal membuat file foto");
  const payload = await boothApi(`/api/sessions/${boothState.session.id}/capture-upload`, { method: "POST", headers: { "Content-Type": "image/jpeg", "X-Slot-Index": String(boothState.currentSlot) }, body: blob });
  return payload.file;
}

function formatTimer(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function startSessionTimer() {
  clearInterval(boothState.sessionTimer);
  const tick = () => {
    if (!boothState.session || boothState.expired) return;
    const remaining = (new Date(boothState.session.deadlineAt).getTime() - Date.now()) / 1000;
    $("#session-countdown").textContent = formatTimer(remaining);
    $("#session-time").classList.toggle("urgent", remaining <= 30);
    if (remaining <= 0) expireSession();
  };
  tick(); boothState.sessionTimer = setInterval(tick, 250);
}

function renderSlotStrip() {
  const total = Number(boothState.session?.rules.photoSlots || frameSlots(boothState.selectedFrame.url));
  const strip = $("#slot-strip"); strip.style.setProperty("--slots", total); strip.innerHTML = "";
  for (let index = 1; index <= total; index += 1) {
    const cell = document.createElement("span");
    cell.className = `slot-cell ${index === boothState.currentSlot ? "is-current" : ""} ${boothState.photos[index] ? "is-filled" : ""}`;
    if (boothState.photos[index]) { const image = document.createElement("img"); image.src = boothState.photos[index].url; image.alt = `Foto ${index}`; cell.append(image); }
    else cell.textContent = index;
    strip.append(cell);
  }
  $("#capture-progress-label").textContent = `Foto ${Math.min(boothState.currentSlot, total)} dari ${total}`;
}

async function createSession() {
  try {
    $("#frame-continue").disabled = true;
    const { session } = await boothApi("/api/booth/sessions", { method: "POST", body: JSON.stringify({ frameId: boothState.selectedFrame.url }) });
    boothState.session = session; boothState.currentSlot = 1; boothState.photos = {}; boothState.expired = false;
    const boothCode = routeBoothCode || localStorage.getItem("photoslive.boothCode");
    if (boothCode && session.shareToken) {
      fetch("/api/platform?action=register_session", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${boothState.config?.bridgeToken || ""}` }, body: JSON.stringify({ boothCode, machineId: localStorage.getItem("photoslive.machineId"), shareCode: session.shareToken, localSessionId: session.id, status: session.status, frameId: session.frameId, photoSlots: session.rules.photoSlots, createdAt: session.createdAt, expiresAt: session.expiresAt }) }).catch(() => {});
      history.replaceState(null, "", `/${boothCode}/sesi/${session.shareToken}`);
    }
    setScreen("capture"); $(".capture-screen").classList.add("is-waiting"); $("#capture-ready-overlay").hidden = false;
    $("#camera-start").firstChild.textContent = "Ketuk untuk mulai ";
    renderSlotStrip(); startSessionTimer(); startCameraPreview();
  } catch (error) { notice(error.message, "error"); $("#frame-continue").disabled = false; }
}

async function runShotCountdown() {
  if (!boothState.session || boothState.expired) return;
  $("#capture-ready-overlay").hidden = true; $(".capture-screen").classList.remove("is-waiting"); $("#photo-review").hidden = true;
  const overlay = $("#countdown-overlay"); overlay.hidden = false;
  const total = boothState.session.rules.photoSlots;
  $("#countdown-slot-label").textContent = `Foto ${boothState.currentSlot} dari ${total}`;
  const countdown = Math.max(1, Number(boothState.session.rules.countdownSeconds || 3));
  for (let value = countdown; value > 0; value -= 1) {
    if (boothState.expired) return;
    const number = $("#shot-countdown"); number.textContent = value; number.style.animation = "none"; void number.offsetWidth; number.style.animation = "countPulse .8s ease";
    await wait(1000);
  }
  overlay.hidden = true; await captureCurrentSlot();
}

async function captureCurrentSlot() {
  $("#capture-instruction b").textContent = "Mengambil foto…"; $("#capture-instruction small").textContent = "Tetap diam sebentar.";
  try {
    const file = boothState.cameraMode === "browser"
      ? await captureBrowserFrame()
      : (await boothApi(`/api/sessions/${boothState.session.id}/capture`, { method: "POST", body: JSON.stringify({ slotIndex: boothState.currentSlot }) })).file;
    boothState.currentPhoto = file; boothState.photos[boothState.currentSlot] = file; renderSlotStrip();
    $("#review-photo-image").src = file.url; $("#review-slot-number").textContent = boothState.currentSlot;
    if (boothState.session.rules.unlimitedRetakes) {
      $("#review-attempt-detail").textContent = "Retake tanpa batas selama waktu sesi masih tersedia.";
      $("#retake-photo").hidden = false;
    } else {
      const remainingRetakes = Number(boothState.session.rules.maxAttemptsPerSlot || 1) - file.attemptNumber;
      $("#review-attempt-detail").textContent = remainingRetakes > 0 ? `Kamu masih punya ${remainingRetakes} kesempatan retake untuk foto ini.` : "Batas retake sudah tercapai. Gunakan foto ini untuk melanjutkan.";
      $("#retake-photo").hidden = remainingRetakes <= 0;
    }
    $("#photo-review").hidden = false;
  } catch (error) {
    notice(error.message, "error");
    $("#capture-heading").textContent = "Kamera belum siap"; $(".ready-card>p:not(.eyebrow)").textContent = error.message;
    $("#camera-start").firstChild.textContent = "Coba lagi "; $("#capture-ready-overlay").hidden = false; $(".capture-screen").classList.add("is-waiting");
  }
}

async function acceptCurrentPhoto() {
  if (!boothState.currentPhoto) return;
  try {
    await boothApi(`/api/sessions/${boothState.session.id}/select`, { method: "POST", body: JSON.stringify({ fileId: boothState.currentPhoto.id }) });
    $("#photo-review").hidden = true;
    if (boothState.currentSlot < boothState.session.rules.photoSlots) {
      boothState.currentSlot += 1; boothState.currentPhoto = null; renderSlotStrip();
      $("#capture-instruction b").textContent = `Bersiap untuk foto ${boothState.currentSlot}`; $("#capture-instruction small").textContent = "Hitung mundur berikutnya akan dimulai.";
      await wait(450); runShotCountdown();
    } else {
      await boothApi(`/api/sessions/${boothState.session.id}/complete`, { method: "POST", body: "{}" });
      showResult();
      syncCompletedSession().catch(error => notice(`Foto aman di mesin, tetapi upload cloud tertunda: ${error.message}`, "error"));
    }
  } catch (error) { notice(error.message, "error"); }
}

async function sessionPhotoBlob(file) {
  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    const response = await fetch(file.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Foto ${file.slotIndex || ""} tidak dapat dibaca`);
    return response.blob();
  }
  const result = await boothCloudControllerApi(file.url, { timeoutMs: 12_000 });
  if (!result?.bodyBase64) throw new Error("Agent tidak mengirim file foto");
  const bytes = Uint8Array.from(atob(result.bodyBase64), character => character.charCodeAt(0));
  return new Blob([bytes], { type: result.contentType || "image/jpeg" });
}

async function syncCompletedSession() {
  const boothCode = routeBoothCode || localStorage.getItem("photoslive.boothCode");
  if (!boothCode || !boothState.session?.shareToken) return;
  const record = {
    boothCode,
    machineId: localStorage.getItem("photoslive.machineId"),
    session: boothState.session,
    files: Object.entries(boothState.photos).map(([slotIndex, file]) => ({ ...file, slotIndex: Number(slotIndex) })),
  };
  const pending = JSON.parse(localStorage.getItem(pendingSyncKey()) || "[]").filter(item => item.session?.shareToken !== record.session.shareToken);
  pending.push(record);
  localStorage.setItem(pendingSyncKey(), JSON.stringify(pending.slice(-20)));
  await syncSessionRecord(record);
  localStorage.setItem(pendingSyncKey(), JSON.stringify(pending.filter(item => item.session?.shareToken !== record.session.shareToken)));
}

async function syncSessionRecord(record) {
  const { boothCode, machineId, session, files } = record;
  const metadataResponse = await fetch("/api/platform?action=register_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${boothState.config?.bridgeToken || ""}` },
    body: JSON.stringify({ boothCode, machineId, shareCode: session.shareToken, localSessionId: session.id, status: "completed", frameId: session.frameId, photoSlots: session.rules.photoSlots, createdAt: session.createdAt, expiresAt: session.expiresAt }),
  });
  if (!metadataResponse.ok) throw new Error((await metadataResponse.json().catch(() => ({}))).error || "Metadata sesi gagal disimpan");
  for (const file of files.sort((a, b) => a.slotIndex - b.slotIndex)) {
    const blob = await sessionPhotoBlob(file);
    if (blob.size > 1_800_000) throw new Error(`Foto ${file.slotIndex} terlalu besar untuk upload cloud`);
    const response = await fetch("/api/platform?action=upload_session_file", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${boothState.config?.bridgeToken || ""}` },
      body: JSON.stringify({ boothCode, machineId, shareCode: session.shareToken, slotIndex: Number(file.slotIndex), contentType: blob.type || "image/jpeg", bodyBase64: await boothBlobToBase64(blob), status: "completed" }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Upload foto ${file.slotIndex} gagal`);
  }
}

async function flushPendingSessionSync() {
  const pending = JSON.parse(localStorage.getItem(pendingSyncKey()) || "[]");
  if (!pending.length) return;
  const remaining = [];
  for (const record of pending) {
    try { await syncSessionRecord(record); }
    catch { remaining.push(record); }
  }
  localStorage.setItem(pendingSyncKey(), JSON.stringify(remaining.slice(-20)));
}

function showResult() {
  stopCameraPreview(); setScreen("result");
  const frame = boothState.selectedFrame; const finalFrame = $("#final-frame"); finalFrame.style.backgroundImage = frameBackground(frame);
  const slots = $("#final-slots"); slots.innerHTML = ""; slots.style.gridTemplateRows = `repeat(${boothState.session.rules.photoSlots},1fr)`;
  Object.keys(boothState.photos).sort((a,b) => a-b).forEach(index => { const image = document.createElement("img"); image.src = boothState.photos[index].url; image.alt = `Foto final ${index}`; slots.append(image); });
  $("#result-frame-name").textContent = frame.name.replace(/^\d+-/, "");
  $("#print-result").hidden = Number(boothState.config.booth.printsPerSession || 0) < 1;
}

function enterFrameSelection() {
  setScreen("frames");
  $("#session-countdown").textContent = formatTimer(boothState.config.booth.sessionTimeoutSeconds);
  startCameraPreview();
}

async function loadAccessQris() {
  $("#access-payment-loading").hidden = false; $("#access-payment-error").hidden = true; $("#access-payment-qr").hidden = true;
  try {
    const { payment } = await boothApi("/api/booth/qris", { method: "POST", body: JSON.stringify({ sessionId: "access", purpose: "session" }) });
    if (payment.qrImageUrl) {
      $("#access-payment-loading").hidden = true; $("#access-payment-qr").hidden = false;
      $("#access-payment-qr-image").src = payment.qrImageUrl; $("#access-payment-amount").textContent = formatMoney(boothState.config.payment.price);
    } else if (payment.status === "paid") {
      boothState.accessMethod = "qris"; $("#access-dialog").close(); enterFrameSelection();
    } else {
      throw new Error("QRIS belum mengembalikan kode pembayaran. Hubungi operator.");
    }
  } catch (error) {
    $("#access-payment-loading").hidden = true; $("#access-payment-error").hidden = false; $("#access-payment-error-message").textContent = error.message;
  }
}

async function openAccessGate() {
  const startButton = $("#welcome-start");
  if (!boothState.config) {
    startButton.disabled = true;
    $("#welcome-button-label").textContent = "Menyiapkan sesi…";
    try {
      boothState.config = await boothApi("/api/booth/config");
      localStorage.setItem(boothConfigCacheKey(), JSON.stringify({ value: boothState.config, savedAt: Date.now() }));
      applyConfiguration();
    } catch (error) {
      notice(`Belum dapat memulai: ${error.message}`, "error");
      return;
    } finally {
      startButton.disabled = false;
      $("#welcome-button-label").textContent = boothState.config?.appearance?.startButtonLabel || "Mulai foto";
    }
  }
  const qrisEnabled = Boolean(boothState.config.payment.qrisEnabled);
  const voucherEnabled = Boolean(boothState.config.payment.voucherEnabled);
  if (!qrisEnabled && !voucherEnabled) { enterFrameSelection(); return; }
  $("#access-qris-section").hidden = !qrisEnabled; $("#access-voucher-section").hidden = !voucherEnabled;
  $("#access-voucher-code").value = ""; $("#access-voucher-status").textContent = "";
  if (!$("#access-dialog").open) $("#access-dialog").showModal();
  if (qrisEnabled) loadAccessQris();
  else setTimeout(() => $("#access-voucher-code").focus(), 80);
}

async function redeemAccessVoucher() {
  const code = $("#access-voucher-code").value.trim().toUpperCase();
  if (!code) { $("#access-voucher-status").textContent = "Masukkan kode voucher terlebih dahulu."; return; }
  const button = $("#redeem-access-voucher"); button.disabled = true; $("#access-voucher-status").textContent = "Memeriksa voucher…";
  try {
    const { voucher } = await boothApi("/api/vouchers/redeem", { method: "POST", body: JSON.stringify({ code }) });
    boothState.accessMethod = "voucher"; boothState.printIncluded = Boolean(voucher.includesPrint); boothState.voucherCode = voucher.code;
    $("#access-voucher-status").textContent = "Voucher diterima. Membuka pilihan frame…";
    await wait(450); $("#access-dialog").close(); enterFrameSelection();
  } catch (error) { $("#access-voucher-status").textContent = error.message; }
  finally { button.disabled = false; }
}

async function openPrintDialog() {
  if (!boothState.config.payment.paidPrintEnabled || boothState.printIncluded) { await queuePrint(); return; }
  const dialog = $("#print-dialog"); dialog.showModal(); $("#payment-loading").hidden = false; $("#payment-error").hidden = true; $("#payment-qr").hidden = true; $("#confirm-direct-print").hidden = true;
  $("#print-dialog-title").textContent = "Bayar untuk mencetak"; $("#print-dialog-copy").textContent = "Pindai QRIS dan selesaikan pembayaran sebelum timer berakhir.";
  try {
    const { payment } = await boothApi("/api/booth/qris", { method: "POST", body: JSON.stringify({ sessionId: boothState.session.id, purpose: "print" }) });
    if (payment.qrImageUrl) { $("#payment-loading").hidden = true; $("#payment-qr").hidden = false; $("#payment-qr-image").src = payment.qrImageUrl; $("#payment-amount").textContent = formatMoney(boothState.config.payment.printPrice); }
  } catch (error) {
    $("#payment-loading").hidden = true; $("#payment-error").hidden = false; $("#payment-error-message").textContent = error.message;
  }
}

async function queuePrint() {
  try {
    await boothApi("/api/booth/print", { method: "POST", body: JSON.stringify({ sessionId: boothState.session.id, voucherCode: boothState.voucherCode }) });
    if ($("#print-dialog").open) $("#print-dialog").close(); startGoodbye("Cetakanmu sedang disiapkan", "Tunggu hasil keluar dari printer sebelum meninggalkan photobox.");
  } catch (error) { notice(error.message, "error"); }
}

function startGoodbye(title = "Sampai jumpa lagi!", copy = "Terima kasih sudah membuat momen bersama Photoslive.") {
  clearInterval(boothState.sessionTimer); $("#goodbye-title").textContent = title; $("#goodbye-copy").textContent = copy;
  if (!$("#goodbye-dialog").open) $("#goodbye-dialog").showModal();
  let remaining = 15; $("#goodbye-countdown").textContent = remaining; clearInterval(boothState.goodbyeTimer);
  boothState.goodbyeTimer = setInterval(() => { remaining -= 1; $("#goodbye-countdown").textContent = Math.max(0, remaining); if (remaining <= 0) resetBooth(); }, 1000);
}

function expireSession() {
  boothState.expired = true; clearInterval(boothState.sessionTimer); stopCameraPreview();
  startGoodbye("Waktu sesi telah selesai", "Foto yang sudah tersimpan tetap aman. Layar akan disiapkan untuk pelanggan berikutnya.");
}

function resetBooth() {
  clearInterval(boothState.goodbyeTimer); clearInterval(boothState.sessionTimer); stopCameraPreview();
  if ($("#goodbye-dialog").open) $("#goodbye-dialog").close(); if ($("#print-dialog").open) $("#print-dialog").close(); if ($("#access-dialog").open) $("#access-dialog").close();
  boothState.session = null; boothState.currentSlot = 1; boothState.currentPhoto = null; boothState.photos = {}; boothState.expired = false; boothState.accessMethod = null; boothState.printIncluded = false; boothState.voucherCode = "";
  $("#capture-heading").textContent = "Sudah siap?"; $(".ready-card>p:not(.eyebrow)").textContent = "Pastikan semua orang terlihat. Setelah ditekan, hitung mundur akan langsung dimulai."; $("#camera-start").firstChild.textContent = "Ketuk untuk mulai ";
  $("#session-countdown").textContent = formatTimer(boothState.config.booth.sessionTimeoutSeconds); $("#session-time").classList.remove("urgent");
  $("#photo-review").hidden = true; $("#countdown-overlay").hidden = true; $("#capture-ready-overlay").hidden = false; $(".capture-screen").classList.remove("is-waiting");
  updateFrameSelection(); setScreen("welcome");
  if (routeBoothCode) history.replaceState(null, "", `/${routeBoothCode}`);
}

function bindEvents() {
  $("#welcome-start").addEventListener("click", openAccessGate);
  $("#frame-list").addEventListener("click", event => { const option = event.target.closest(".frame-option"); if (!option) return; boothState.selectedFrame = boothState.frames.find(frame => frame.url === option.dataset.frameUrl); updateFrameSelection(); });
  $("#frame-page-prev").addEventListener("click", () => { boothState.framePage -= 1; renderFrames(); });
  $("#frame-page-next").addEventListener("click", () => { boothState.framePage += 1; renderFrames(); });
  $("#frame-continue").addEventListener("click", createSession);
  $("#camera-start").addEventListener("click", runShotCountdown);
  $("#retake-photo").addEventListener("click", () => { $("#photo-review").hidden = true; runShotCountdown(); });
  $("#accept-photo").addEventListener("click", acceptCurrentPhoto);
  $("#print-result").addEventListener("click", openPrintDialog);
  $("#finish-session").addEventListener("click", () => startGoodbye());
  $("#close-print-dialog").addEventListener("click", () => $("#print-dialog").close());
  $("#confirm-direct-print").addEventListener("click", queuePrint);
  $("#close-access-dialog").addEventListener("click", () => $("#access-dialog").close());
  $("#redeem-access-voucher").addEventListener("click", redeemAccessVoucher);
  $("#access-voucher-code").addEventListener("keydown", event => { if (event.key === "Enter") redeemAccessVoucher(); });
  $("#skip-goodbye").addEventListener("click", resetBooth);
}

async function initBooth() {
  if (routeBoothCode) {
    localStorage.setItem("photoslive.boothCode", routeBoothCode);
    $("#booth-admin-entry").href = `/setup?mode=login&booth=${encodeURIComponent(routeBoothCode)}`;
  }
  bindEvents();
  let startedFromCache = false;
  try {
    const cachedRecord = JSON.parse(localStorage.getItem(boothConfigCacheKey()) || "null");
    const cached = cachedRecord?.value || cachedRecord;
    if (cached?.appearance && cached?.booth && cached?.payment) {
      boothState.config = cached;
      applyConfiguration();
      resetBooth();
      startedFromCache = true;
    }
  } catch { localStorage.removeItem(boothConfigCacheKey()); }
  try {
    const freshConfig = await boothApi("/api/booth/config", { timeoutMs: startedFromCache ? 5000 : 8000 });
    boothState.config = freshConfig;
    localStorage.setItem(boothConfigCacheKey(), JSON.stringify({ value: freshConfig, savedAt: Date.now() }));
    applyConfiguration();
    if (!startedFromCache) resetBooth();
    reportClientCapabilities();
    flushPendingSessionSync().catch(() => {});
    setInterval(() => reportClientCapabilities(boothState.cameraLabels), 30000);
    if (boothState.config.booth.maintenanceMode) { $("#welcome-start").disabled = true; $("#welcome-button-label").textContent = "Sedang dalam perawatan"; }
  } catch (error) {
    if (startedFromCache) {
      notice(`Mode lokal: konfigurasi tersimpan digunakan. ${error.message}`, "error");
      return;
    }
    notice(`Mesin belum siap. Tekan Mulai foto untuk mencoba lagi. ${error.message}`, "error");
  }
}

initBooth();
