const $ = selector => document.querySelector(selector);

const onboarding = {
  step: 1,
  machine: null,
  booth: null,
  devices: [],
  browserCameraStream: null,
  selectedFrame: "clean-white",
  frameFile: null,
  framePreviewUrl: null,
  frameDesign: null,
  frameEditor: null,
};

const setupSteps = [
  ["Hubungkan mesin", "Masukkan kode Agent."],
  ["Identitas mesin", "Nama dan lokasi."],
  ["Akses admin", "Email dan PIN."],
  ["Perangkat", "Pilih dan tes."],
  ["Frame awal", "Pilih satu desain."],
  ["Siap", "Setup selesai."],
];

const api = async (action, options = {}) => {
  const response = await fetch(`/api/platform?action=${action}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request gagal (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
};

async function bridgeApi(action, payload = {}, method = "POST") {
  const query = method === "GET" ? `&${new URLSearchParams(payload)}` : "";
  const response = await fetch(`/api/bridge?action=${encodeURIComponent(action)}${query}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Agent tidak merespons (${response.status})`);
  return result;
}

async function controllerRequest(path, method = "GET", body = null, options = {}) {
  if (!onboarding.machine?.id) throw new Error("Mesin belum terhubung");
  const { job } = await bridgeApi("enqueue_job", {
    machineId: onboarding.machine.id,
    type: "controller.request",
    payload: { path, method, body, bodyBase64: options.bodyBase64 || null, headers: options.headers || {} },
  });
  const deadline = Date.now() + Number(options.timeoutMs || 35_000);
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 650));
    const current = await bridgeApi("job_status", { machineId: onboarding.machine.id, jobId: job.id }, "GET");
    if (current.job.status === "completed") return current.job.result || {};
    if (current.job.status === "failed") throw new Error(current.job.error || "Perintah Agent gagal");
  }
  throw new Error("Agent belum merespons. Anda dapat melewati langkah ini.");
}

const status = (message, success = false) => {
  $("#setup-status").textContent = message;
  $("#setup-status").classList.toggle("success", success);
};

function syncUrl(name) {
  const booth = $("#login-booth").value.trim();
  const query = new URLSearchParams();
  if (name !== "setup") query.set("mode", name);
  if (name === "setup" && onboarding.step > 1) query.set("step", String(onboarding.step));
  if (booth && name !== "setup") query.set("booth", booth);
  history.replaceState(null, "", query.size ? `/setup?${query}` : "/setup");
}

function updateRecoveryVisibility(activeMode) {
  const show = activeMode === "login" || (activeMode === "setup" && onboarding.step === 1);
  $("#agent-recovery").classList.toggle("hidden", !show);
}

function setSetupStep(step) {
  if (onboarding.step === 4 && Number(step) !== 4) stopSetupCameraPreview();
  onboarding.step = Math.max(1, Math.min(6, Number(step) || 1));
  document.querySelectorAll("[data-setup-step]").forEach(panel => panel.classList.toggle("hidden", Number(panel.dataset.setupStep) !== onboarding.step));
  const [name, help] = setupSteps[onboarding.step - 1];
  $("#wizard-step-label").textContent = `Langkah ${onboarding.step} dari 6`;
  $("#wizard-step-name").textContent = name;
  $("#wizard-progress-bar").style.width = `${(onboarding.step / 6) * 100}%`;
  $(".auth-card").style.setProperty("--progress-angle", `${(onboarding.step / 6) * 360}deg`);
  $("#setup-title").textContent = name;
  $("#setup-copy").textContent = help;
  $("#setup-modes").classList.toggle("hidden", onboarding.step > 1);
  $(".auth-layout").dataset.step = String(onboarding.step);
  updateRecoveryVisibility("setup");
  syncUrl("setup");
  status("");
  if (onboarding.step === 6) renderReadyChecklist();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function mode(name) {
  document.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === name));
  ["setup", "login", "forgot"].forEach(value => $(`#${value}-form`).classList.toggle("hidden", value !== name));
  $("#wizard-progress").classList.toggle("hidden", name !== "setup");
  $("#setup-modes").classList.toggle("hidden", name === "forgot" || (name === "setup" && onboarding.step > 1));
  $(".auth-layout").dataset.mode = name;
  const labels = {
    setup: setupSteps[onboarding.step - 1],
    login: ["Masuk", "Pilih cara masuk ke admin photobox."],
    forgot: ["Bantuan password", "Kirim permintaan kepada superadmin."],
  };
  $("#setup-title").textContent = labels[name][0];
  $("#setup-copy").textContent = labels[name][1];
  updateRecoveryVisibility(name);
  syncUrl(name);
  status("");
}

function loginMethod(name) {
  document.querySelectorAll("[data-login-method]").forEach(button => {
    const selected = button.dataset.loginMethod === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-method-panel]").forEach(panel => panel.classList.toggle("hidden", panel.dataset.methodPanel !== name));
  $("#login-form").classList.toggle("password-login", name === "password");
  $("#login-pin").required = name === "pin";
  $("#login-email").required = name === "password";
  $("#login-password").required = name === "password";
  if (name === "pin") {
    $("#login-email").value = "";
    $("#login-password").value = "";
  } else {
    $("#login-pin").value = "";
    $("#login-pin-email").value = "";
    $("#login-pin-email").required = false;
    $("#login-recovery-email-field").classList.add("hidden");
  }
}

function deviceKind(device) {
  const value = `${device?.kind || ""} ${device?.type || ""} ${device?.name || ""}`.toLowerCase();
  if (/camera|webcam|video|gphoto/.test(value)) return "camera";
  if (/printer|cups|print/.test(value)) return "printer";
  return "other";
}

function connectedDevices(kind) {
  return onboarding.devices.filter(device => (
    deviceKind(device) === kind
    && device?.status === "connected"
    && !String(device?.id || "").endsWith("-none")
  ));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function renderMachineSummary(machine, storage = null) {
  const telemetry = machine?.telemetry || {};
  const memory = storage?.memory || telemetry.memory || {};
  const disk = storage?.disk || telemetry.disk || {};
  $("#setup-machine-summary").hidden = !machine;
  $("#setup-machine-name").textContent = telemetry.hostname || machine?.name || "Komputer Agent";
  $("#setup-machine-platform").textContent = machine?.platform || "Sistem belum dilaporkan";
  $("#setup-machine-memory").textContent = memory.totalBytes ? formatBytes(memory.totalBytes) : "Belum tersedia";
  $("#setup-machine-memory-detail").textContent = memory.usedBytes != null ? `${formatBytes(memory.usedBytes)} digunakan` : "Menunggu Agent";
  $("#setup-machine-disk").textContent = disk.freeBytes ? `${formatBytes(disk.freeBytes)} bebas` : "Belum tersedia";
  $("#setup-machine-disk-detail").textContent = disk.totalBytes ? `dari ${formatBytes(disk.totalBytes)}` : "Menunggu Agent";
  if (storage?.localPath && !$("#setup-storage-path").value) $("#setup-storage-path").value = storage.localPath;
}

async function browserCameras(requestPermission = false) {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let temporaryStream = null;
  try {
    if (requestPermission) temporaryStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === "videoinput").map((device, index) => ({
      id: `browser:${device.deviceId || index}`,
      name: device.label || `Webcam browser ${index + 1}`,
      kind: "camera",
      status: "connected",
      detail: "Kamera browser",
    }));
  } finally {
    temporaryStream?.getTracks().forEach(track => track.stop());
  }
}

function stopSetupCameraPreview() {
  onboarding.browserCameraStream?.getTracks().forEach(track => track.stop());
  onboarding.browserCameraStream = null;
  const video = $("#setup-camera-preview");
  video.srcObject = null;
  video.hidden = true;
  $("#test-setup-camera").textContent = "Tes kamera";
}

function renderDevicePicker(kind, devices) {
  const card = $(`#onboarding-${kind}`);
  const select = $(`#setup-${kind}-select`);
  const testButton = $(`#test-setup-${kind}`);
  select.replaceChildren();
  devices.forEach(device => {
    const option = document.createElement("option");
    option.value = String(device.id || "");
    option.textContent = String(device.name || device.model || device.id || "Perangkat");
    select.append(option);
  });
  if (!devices.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Tidak ditemukan";
    select.append(option);
  }
  const connected = devices.length > 0;
  card.classList.toggle("connected", connected);
  card.querySelector("small").textContent = connected ? `${devices.length} terdeteksi` : "Tidak terhubung";
  select.disabled = !connected;
  testButton.disabled = !connected;
}

async function refreshOnboardingDevices(requestBrowserPermission = false) {
  const message = $("#device-onboarding-status");
  message.textContent = "Mencari perangkat…";
  const browserCameraPromise = browserCameras(requestBrowserPermission).catch(error => ({ error }));
  try {
    const { machine } = await bridgeApi("machine_status", { machineId: onboarding.machine.id }, "GET");
    onboarding.machine = { ...onboarding.machine, ...machine };
    if (!machine?.online) throw new Error("Agent offline");
    const [refreshed, storage] = await Promise.all([
      controllerRequest("/api/devices/refresh", "POST"),
      controllerRequest("/api/storage/overview", "GET").catch(() => null),
    ]);
    const browserResult = await browserCameraPromise;
    const localDevices = Array.isArray(refreshed?.devices) ? refreshed.devices : Array.isArray(machine?.devices) ? machine.devices : [];
    const browserDevices = Array.isArray(browserResult) ? browserResult : [];
    onboarding.devices = [...browserDevices, ...localDevices];
    renderMachineSummary(onboarding.machine, storage);
    const cameras = connectedDevices("camera");
    const printers = connectedDevices("printer");
    renderDevicePicker("camera", cameras);
    renderDevicePicker("printer", printers);
    message.textContent = cameras.length || printers.length ? "Pilih perangkat yang akan dipakai." : "Tidak ada perangkat terhubung.";
    if (browserResult?.error) message.textContent += ` Izin webcam: ${browserResult.error.message}.`;
  } catch (error) {
    const browserResult = await browserCameraPromise;
    onboarding.devices = Array.isArray(browserResult) ? browserResult : [];
    renderMachineSummary(onboarding.machine);
    renderDevicePicker("camera", connectedDevices("camera"));
    renderDevicePicker("printer", []);
    message.textContent = connectedDevices("camera").length ? `Webcam browser terdeteksi. ${error.message}.` : `${error.message}. Periksa Agent atau izin kamera browser.`;
  }
}

async function selectOnboardingDevice(kind) {
  const select = $(`#setup-${kind}-select`);
  if (!select.value) return;
  if (kind === "camera" && select.value.startsWith("browser:")) {
    await controllerRequest("/api/settings", "PATCH", { devices: { cameraSource: "browser", browserCameraId: select.value.slice(8) } });
    return;
  }
  const key = kind === "camera" ? "preferredCamera" : "preferredPrinter";
  await controllerRequest("/api/settings", "PATCH", { devices: { [key]: select.value, ...(kind === "camera" ? { cameraSource: "controller" } : {}) } });
}

async function testOnboardingDevice(kind) {
  const message = $("#device-onboarding-status");
  const button = $(`#test-setup-${kind}`);
  button.disabled = true;
  message.textContent = kind === "camera" ? "Menguji kamera…" : "Mengirim halaman tes…";
  try {
    if (kind === "camera" && $("#setup-camera-select").value.startsWith("browser:")) {
      if (onboarding.browserCameraStream) {
        stopSetupCameraPreview();
        message.textContent = "Preview kamera dimatikan.";
        return;
      }
      const deviceId = $("#setup-camera-select").value.slice(8);
      onboarding.browserCameraStream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });
      const video = $("#setup-camera-preview");
      video.srcObject = onboarding.browserCameraStream;
      video.hidden = false;
      await video.play();
      button.textContent = "Matikan preview";
      message.textContent = "Webcam browser siap.";
      await selectOnboardingDevice(kind);
      return;
    }
    await selectOnboardingDevice(kind);
    const result = await controllerRequest(kind === "camera" ? "/api/devices/camera/test" : "/api/devices/printer/test-page", "POST");
    message.textContent = result.message || (kind === "camera" ? "Kamera siap." : "Halaman tes dikirim.");
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = !connectedDevices(kind).length;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("File frame tidak dapat dibaca"));
    reader.readAsDataURL(file);
  });
}

function setupDefaultSlotTransforms(slots) {
  const count = Math.max(1, Math.min(8, Number(slots || 1)));
  const gap = 1.5;
  const slotHeight = Math.min(28, (84 - gap * (count - 1)) / count);
  const slotWidth = Math.min(88, slotHeight * 3);
  return Array.from({ length: count }, (_, index) => ({ x: 50, y: 3 + slotHeight / 2 + index * (slotHeight + gap), width: slotWidth, rotation: 0, opacity: 100, z: index + 1 }));
}

function setupFrameElementStyle(item = {}, sticker = false) {
  const width = sticker ? Number(item.size || 28) : Number(item.width || 84);
  return `left:${Number(item.x ?? 50)}%;top:${Number(item.y ?? 15)}%;width:${width}%;opacity:${Number(item.opacity ?? 100) / 100};z-index:${Number(item.z || 1)};transform:translate(-50%,-50%) rotate(${Number(item.rotation || 0)}deg)`;
}

function setupSelectedFrameElements(editor = onboarding.frameEditor) {
  if (!editor?.selected) return [];
  if (editor.selected.type === "all-slots") return editor.slotTransforms;
  if (editor.selected.type === "sticker") return [editor.stickers[editor.selected.index]].filter(Boolean);
  return [editor.slotTransforms[editor.selected.index]].filter(Boolean);
}

function setupFrameLayers(editor = onboarding.frameEditor) {
  if (!editor) return [];
  return [
    ...editor.slotTransforms.map((item, index) => ({ type: "slot", index, name: `Foto ${index + 1}`, z: Number(item.z || index + 1) })),
    ...editor.stickers.map((item, index) => ({ type: "sticker", index, name: `Logo / stiker ${index + 1}`, z: Number(item.z || 10 + index) })),
  ].sort((a, b) => b.z - a.z);
}

function setSetupFrameTab(name) {
  document.querySelectorAll("[data-setup-frame-tab]").forEach(button => {
    const active = button.dataset.setupFrameTab === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-setup-frame-panel]").forEach(panel => { panel.hidden = panel.dataset.setupFramePanel !== name; });
}

function renderSetupFrameEditor() {
  const editor = onboarding.frameEditor;
  if (!editor) return;
  const preview = $("#setup-frame-upload-preview");
  preview.style.aspectRatio = "3 / 4";
  const slots = editor.slotTransforms.map((item, index) => `<span class="setup-frame-element ${((editor.selected?.type === "slot" && editor.selected.index === index) || editor.selected?.type === "all-slots") ? "selected" : ""}" data-setup-editor-type="slot" data-setup-editor-index="${index}" style="${setupFrameElementStyle(item)}"><b>${index + 1}</b><img src="/icons/image.svg" alt="Area foto ${index + 1}"></span>`).join("");
  const stickers = editor.stickers.map((item, index) => `<span class="setup-frame-element setup-frame-sticker ${(editor.selected?.type === "sticker" && editor.selected.index === index) ? "selected" : ""}" data-setup-editor-type="sticker" data-setup-editor-index="${index}" style="${setupFrameElementStyle(item, true)}"><img src="${item.previewUrl || item.url}" alt="Logo atau stiker ${index + 1}"></span>`).join("");
  preview.innerHTML = `<div class="setup-frame-artwork" style="background:${editor.backgroundCss};transform:scale(${editor.zoom / 100});transform-origin:${editor.x}% ${editor.y}%"></div>${slots}${stickers}`;
  $("#setup-frame-crop-stage").style.setProperty("--setup-editor-art", editor.backgroundCss);
  $("#setup-frame-zoom-value").textContent = `${editor.zoom}%`;
  const selected = setupSelectedFrameElements(editor)[0] || {};
  const isSticker = editor.selected?.type === "sticker";
  const allSlots = editor.selected?.type === "all-slots";
  $("#setup-frame-selected-label").textContent = isSticker ? `Logo / stiker ${editor.selected.index + 1} dipilih` : allSlots ? `Semua ${editor.slots} foto dipilih` : `Area foto ${(editor.selected?.index || 0) + 1} dipilih`;
  $("#setup-frame-selected-help").textContent = allSlots ? "Geser satu area untuk memindahkan semuanya" : "Geser pada preview untuk memindahkan";
  $("#setup-select-all-slots").classList.toggle("active", allSlots);
  $("#setup-frame-rotation").value = Number(selected.rotation || 0);
  $("#setup-frame-rotation-value").textContent = `${Number(selected.rotation || 0)}°`;
  $("#setup-frame-size").value = isSticker ? Number(selected.size || 28) : Math.round(Number(selected.width || 84) / .84);
  $("#setup-frame-size-value").textContent = `${Math.round(Number($("#setup-frame-size").value))}%`;
  $("#setup-frame-opacity").value = Number(selected.opacity ?? 100);
  $("#setup-frame-opacity-value").textContent = `${Number(selected.opacity ?? 100)}%`;
  $("#setup-remove-frame-element").hidden = !isSticker;
  const layers = setupFrameLayers(editor);
  $("#setup-frame-layer-count").textContent = String(layers.length);
  $("#setup-frame-layer-list").innerHTML = layers.map((layer, position) => `<div class="setup-frame-layer-row ${(editor.selected?.type === layer.type && editor.selected.index === layer.index) ? "selected" : ""}" data-layer-type="${layer.type}" data-layer-index="${layer.index}"><button type="button" class="setup-layer-select"><img src="/icons/${layer.type === "sticker" ? "image-plus" : "image"}.svg" alt=""><b>${layer.name}</b></button><div><button type="button" class="setup-layer-up" aria-label="Naikkan ${layer.name}" ${position === 0 ? "disabled" : ""}><img src="/icons/chevron-up.svg" alt=""></button><button type="button" class="setup-layer-down" aria-label="Turunkan ${layer.name}" ${position === layers.length - 1 ? "disabled" : ""}><img src="/icons/chevron-down.svg" alt=""></button></div></div>`).join("");
}

function openSetupFrameEditor(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { $("#frame-onboarding-status").textContent = "Ukuran frame maksimal 10 MB."; return; }
  const previewUrl = URL.createObjectURL(file);
  onboarding.frameEditor = { file, previewUrl, backgroundCss: `center / cover no-repeat url('${previewUrl}')`, slots: 3, zoom: 100, x: 50, y: 50, slotTransforms: setupDefaultSlotTransforms(3), stickers: [], selected: { type: "slot", index: 0 } };
  $("#setup-frame-slots").value = "3";
  $("#setup-frame-zoom").value = "100";
  setSetupFrameTab("design");
  renderSetupFrameEditor();
  $("#setup-frame-editor-dialog").showModal();
}

function renderStarterUploadPreview() {
  const design = onboarding.frameDesign;
  const container = $("#upload-starter-frame > span");
  if (!design) return;
  const slots = design.slotTransforms.map(item => `<span style="${setupFrameElementStyle(item)};--rotation:${Number(item.rotation || 0)}deg">${design.slotTransforms.indexOf(item) + 1}</span>`).join("");
  const stickers = design.stickers.map(item => `<img src="${item.previewUrl || item.url}" alt="" style="left:${item.x}%;top:${item.y}%;width:${item.size || 28}%;opacity:${Number(item.opacity ?? 100) / 100};z-index:${Number(item.z || 10)};--rotation:${Number(item.rotation || 0)}deg">`).join("");
  container.innerHTML = `<div class="starter-frame-render" style="--setup-frame-art:${design.backgroundCss}">${slots}${stickers}</div>`;
}

function selectStarterFrame(value) {
  onboarding.selectedFrame = value;
  onboarding.frameFile = null;
  (onboarding.frameDesign?.stickers || []).forEach(item => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
  onboarding.frameDesign = null;
  $("#upload-starter-frame").classList.remove("active", "has-preview");
  $("#upload-starter-frame > span").innerHTML = '<img src="/icons/image-plus.svg" alt="">';
  $("#upload-starter-frame small").textContent = "PNG, JPG, atau WebP";
  document.querySelectorAll("[data-frame-choice]").forEach(button => button.classList.toggle("active", button.dataset.frameChoice === value));
}

async function saveStarterFrame() {
  const message = $("#frame-onboarding-status");
  const button = $("#save-onboarding-frame");
  button.disabled = true;
  message.textContent = "Menyimpan pilihan frame…";
  let activeFrame = onboarding.selectedFrame;
  try {
    if (onboarding.frameFile) {
      if (!onboarding.machine?.id) throw new Error("Mesin belum terhubung");
      const uploaded = await controllerRequest("/api/assets/frame", "PUT", null, {
        bodyBase64: await fileToBase64(onboarding.frameFile),
        headers: { "content-type": onboarding.frameFile.type, "x-filename": onboarding.frameFile.name },
      });
      activeFrame = uploaded.asset?.url || uploaded.body?.asset?.url;
      if (!activeFrame) throw new Error("Agent tidak mengembalikan file frame");
      onboarding.selectedFrame = activeFrame;
    }
    const design = onboarding.frameDesign || { slots: 3, zoom: 100, x: 50, y: 50, slotTransforms: setupDefaultSlotTransforms(3), stickers: [] };
    await controllerRequest("/api/settings", "PATCH", {
      appearance: {
        activeFrame,
        framePhotoSlots: { [activeFrame]: design.slots },
        frameBackgroundTransforms: { [activeFrame]: { zoom: design.zoom, x: design.x, y: design.y } },
        frameSlotTransforms: { [activeFrame]: design.slotTransforms },
        frameStickers: { [activeFrame]: design.stickers.map(({ previewUrl, ...item }) => item) },
      },
      booth: { name: $("#booth-name").value.trim(), photoSlotsPerSession: design.slots },
    });
    message.textContent = "Frame pertama siap digunakan.";
    setSetupStep(6);
    renderReadyChecklist();
  } catch (error) {
    message.textContent = error.message;
  } finally { button.disabled = false; }
}

function renderReadyChecklist() {
  const hasCamera = connectedDevices("camera").length > 0;
  const hasPrinter = connectedDevices("printer").length > 0;
  const items = [
    [true, "Akun pemilik", $("#owner-email").value],
    [Boolean(onboarding.machine?.online), "Photoslive Agent", onboarding.machine?.online ? "Online" : "Perlu dinyalakan"],
    [hasCamera, "Kamera", hasCamera ? "Terdeteksi" : "Atur nanti di admin"],
    [hasPrinter, "Printer", hasPrinter ? "Terdeteksi" : "Atur nanti di admin"],
    [true, "Frame awal", onboarding.frameFile ? onboarding.frameFile.name : onboarding.selectedFrame === "party-night" ? "Party night" : "Clean white"],
  ];
  $("#ready-checklist").innerHTML = items.map(([ready, name, detail]) => `<div class="${ready ? "ready" : "pending"}"><span><img src="/icons/${ready ? "circle-check" : "clock"}.svg" alt=""></span><b>${name}</b><small>${detail}</small></div>`).join("");
}

document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => {
  if (button.dataset.mode === "setup") setSetupStep(1);
  mode(button.dataset.mode);
}));
$("#open-forgot").addEventListener("click", () => mode("forgot"));
$("#forgot-back").addEventListener("click", () => mode("login"));
document.querySelectorAll("[data-login-method]").forEach(button => button.addEventListener("click", () => loginMethod(button.dataset.loginMethod)));
function agentPlatform(name) {
  document.querySelectorAll("[data-agent-platform]").forEach(button => {
    const selected = button.dataset.agentPlatform === name;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll("[data-agent-panel]").forEach(panel => panel.classList.toggle("hidden", panel.dataset.agentPanel !== name));
  $("#copy-feedback").textContent = "";
}
const setupCommands = {
  windows: ['Windows PowerShell', 'irm https://photoslive.vercel.app/downloads/install-windows.ps1 | iex', 'python "$env:LOCALAPPDATA\\Photoslive\\source\\photobox\\agent.py" --setup-code'],
  macos: ['macOS Terminal', 'curl -fsSL https://photoslive.vercel.app/downloads/install-macos.sh | bash', 'python3 "$HOME/Library/Application Support/Photoslive/source/photobox/agent.py" --setup-code'],
  linux: ['Linux Terminal', 'curl -fsSL https://photoslive.vercel.app/downloads/install-linux.sh | bash', 'python3 "$HOME/.local/share/photoslive/source/photobox/agent.py" --setup-code'],
};
function agentOperatingSystem(name) {
  const [label, installCommand, setupCommand] = setupCommands[name] || setupCommands.linux;
  $("#install-command-label").textContent = `Perintah instalasi ${label}`;
  $("#install-command").textContent = installCommand;
  $("#setup-command-label").textContent = `Perintah ${label}`;
  $("#setup-code-command").textContent = setupCommand;
  document.querySelectorAll("[data-agent-os]").forEach(button => button.classList.toggle("active", button.dataset.agentOs === name));
}
document.querySelectorAll("[data-agent-platform]").forEach(button => button.addEventListener("click", () => agentPlatform(button.dataset.agentPlatform)));
document.querySelectorAll("[data-agent-os]").forEach(button => button.addEventListener("click", () => agentOperatingSystem(button.dataset.agentOs)));
$("#use-companion-agent").addEventListener("click", () => agentPlatform("computer"));
agentOperatingSystem(/Win/i.test(navigator.platform) ? "windows" : /Mac/i.test(navigator.platform) ? "macos" : "linux");
document.querySelectorAll("[data-setup-back]").forEach(button => button.addEventListener("click", () => setSetupStep(onboarding.step - 1)));
document.querySelectorAll("[data-setup-next], [data-setup-skip]").forEach(button => button.addEventListener("click", () => {
  setSetupStep(onboarding.step + 1);
  if (onboarding.step === 6) renderReadyChecklist();
}));

async function copyCommand(sourceSelector, buttonSelector, successMessage) {
  const command = $(sourceSelector).textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(command);
    else {
      const temporary = document.createElement("textarea");
      temporary.value = command;
      temporary.setAttribute("readonly", "");
      temporary.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(temporary);
      temporary.select();
      const copied = document.execCommand("copy");
      temporary.remove();
      if (!copied) throw new Error("Copy tidak didukung");
    }
    $("#copy-feedback").textContent = successMessage;
    $(`${buttonSelector} span`).textContent = "Tersalin";
    setTimeout(() => { $("#copy-feedback").textContent = ""; $(`${buttonSelector} span`).textContent = "Salin"; }, 5000);
  } catch {
    $("#copy-feedback").textContent = "Tidak dapat menyalin otomatis. Blok perintah lalu salin manual.";
  }
}
$("#copy-install-command").addEventListener("click", () => copyCommand("#install-command", "#copy-install-command", "Perintah instalasi berhasil disalin. Tempel dan jalankan di Terminal."));
$("#copy-setup-command").addEventListener("click", () => copyCommand("#setup-code-command", "#copy-setup-command", "Perintah kode baru berhasil disalin."));

$("#setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (onboarding.step === 1) {
    const input = $("#pairing-code");
    if (!input.reportValidity()) return;
    status("Memeriksa kode setup…");
    try {
      const result = await api("validate_setup", { method: "POST", body: JSON.stringify({ pairingCode: input.value }) });
      onboarding.machine = result.machine;
      $("#booth-name").value = result.machine.name === "Photoslive Booth" ? "" : result.machine.name;
      $("#booth-location").value = result.machine.location || "";
      setSetupStep(2);
    } catch (error) { status(error.message); }
    return;
  }
  if (onboarding.step === 2) {
    if (!$("#booth-name").reportValidity()) return;
    setSetupStep(3);
    return;
  }
  if (onboarding.step === 3) {
    const fields = [$("#owner-email"), $("#owner-pin"), $("#owner-pin-confirm")];
    if (!fields.every(field => field.reportValidity())) return;
    if ($("#owner-pin").value !== $("#owner-pin-confirm").value) return status("Konfirmasi PIN belum sama");
    status("Membuat photobox dan akun pemilik…");
    try {
      const body = {
        pairingCode: $("#pairing-code").value,
        name: $("#booth-name").value,
        location: $("#booth-location").value,
        email: $("#owner-email").value,
        pin: $("#owner-pin").value,
        confirmPin: $("#owner-pin-confirm").value,
      };
      const result = await api("setup", { method: "POST", body: JSON.stringify(body) });
      onboarding.booth = result.booth;
      onboarding.machine = { ...onboarding.machine, id: result.booth.machineId };
      localStorage.setItem("photoslive.machineId", result.booth.machineId);
      localStorage.setItem("photoslive.boothCode", result.booth.boothCode);
      localStorage.setItem(`photoslive.boothAlias.${$("#pairing-code").value.trim().toLowerCase()}`, result.booth.boothCode);
      setSetupStep(4);
      refreshOnboardingDevices();
    } catch (error) { status(error.message); }
  }
});

$("#refresh-onboarding-devices").addEventListener("click", () => refreshOnboardingDevices(true));
$("#setup-camera-select").addEventListener("change", () => selectOnboardingDevice("camera").catch(error => { $("#device-onboarding-status").textContent = error.message; }));
$("#setup-printer-select").addEventListener("change", () => selectOnboardingDevice("printer").catch(error => { $("#device-onboarding-status").textContent = error.message; }));
$("#test-setup-camera").addEventListener("click", () => testOnboardingDevice("camera"));
$("#test-setup-printer").addEventListener("click", () => testOnboardingDevice("printer"));
$("#pick-setup-storage-folder").addEventListener("click", async () => {
  const button = $("#pick-setup-storage-folder");
  button.disabled = true;
  $("#device-onboarding-status").textContent = "Dialog folder dibuka di komputer Agent…";
  try {
    const result = await controllerRequest("/api/storage/pick-folder", "POST", {}, { timeoutMs: 305_000 });
    $("#setup-storage-path").value = result.path || "";
    $("#device-onboarding-status").textContent = result.path ? `Folder dipilih: ${result.path}` : "Folder belum dipilih.";
  } catch (error) {
    $("#device-onboarding-status").textContent = error.message;
  } finally { button.disabled = false; }
});
$("#save-device-onboarding").addEventListener("click", async () => {
  const button = $("#save-device-onboarding");
  button.disabled = true;
  $("#device-onboarding-status").textContent = "Menyimpan perangkat dan folder…";
  try {
    const localPhotoPath = $("#setup-storage-path").value.trim();
    await Promise.all([
      $("#setup-camera-select").value ? selectOnboardingDevice("camera") : Promise.resolve(),
      $("#setup-printer-select").value ? selectOnboardingDevice("printer") : Promise.resolve(),
      controllerRequest("/api/settings", "PATCH", { storage: { localPhotoPath } }),
    ]);
    setSetupStep(5);
  } catch (error) {
    $("#device-onboarding-status").textContent = error.message;
  } finally { button.disabled = false; }
});
document.querySelectorAll("[data-frame-choice]").forEach(button => button.addEventListener("click", () => {
  if (onboarding.framePreviewUrl) URL.revokeObjectURL(onboarding.framePreviewUrl);
  onboarding.framePreviewUrl = null;
  selectStarterFrame(button.dataset.frameChoice);
}));
$("#upload-starter-frame").addEventListener("click", () => $("#starter-frame-file").click());
$("#starter-frame-file").addEventListener("change", event => {
  const file = event.target.files[0];
  event.target.value = "";
  openSetupFrameEditor(file);
});
document.querySelectorAll("[data-setup-frame-tab]").forEach(button => button.addEventListener("click", () => setSetupFrameTab(button.dataset.setupFrameTab)));
$("#setup-frame-slots").addEventListener("change", event => {
  if (!onboarding.frameEditor) return;
  onboarding.frameEditor.slots = Number(event.target.value);
  onboarding.frameEditor.slotTransforms = setupDefaultSlotTransforms(onboarding.frameEditor.slots);
  onboarding.frameEditor.selected = { type: "slot", index: 0 };
  renderSetupFrameEditor();
});
$("#setup-frame-zoom").addEventListener("input", event => { if (onboarding.frameEditor) { onboarding.frameEditor.zoom = Number(event.target.value); renderSetupFrameEditor(); } });
$("#setup-frame-rotation").addEventListener("input", event => { setupSelectedFrameElements().forEach(item => { item.rotation = Number(event.target.value); }); renderSetupFrameEditor(); });
$("#setup-frame-size").addEventListener("input", event => {
  if (!onboarding.frameEditor?.selected) return;
  const sticker = onboarding.frameEditor.selected.type === "sticker";
  setupSelectedFrameElements().forEach(item => { if (sticker) item.size = Number(event.target.value); else item.width = Number(event.target.value) * .84; });
  renderSetupFrameEditor();
});
$("#setup-frame-opacity").addEventListener("input", event => { setupSelectedFrameElements().forEach(item => { item.opacity = Number(event.target.value); }); renderSetupFrameEditor(); });
$("#setup-select-all-slots").addEventListener("click", () => { if (onboarding.frameEditor) { onboarding.frameEditor.selected = { type: "all-slots", index: 0 }; renderSetupFrameEditor(); } });
$("#setup-remove-frame-element").addEventListener("click", () => {
  if (onboarding.frameEditor?.selected?.type !== "sticker") return;
  const [removed] = onboarding.frameEditor.stickers.splice(onboarding.frameEditor.selected.index, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
  onboarding.frameEditor.selected = { type: "slot", index: 0 };
  renderSetupFrameEditor();
});
$("#setup-add-frame-sticker").addEventListener("click", () => { $("#setup-frame-sticker-file").value = ""; $("#setup-frame-sticker-file").click(); });
$("#setup-frame-sticker-file").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file || !onboarding.frameEditor) return;
  if (file.size > 10 * 1024 * 1024) { $("#frame-onboarding-status").textContent = "Ukuran logo atau stiker maksimal 10 MB."; return; }
  try {
    const uploaded = await controllerRequest("/api/assets/sticker", "PUT", null, { bodyBase64: await fileToBase64(file), headers: { "content-type": file.type, "x-filename": file.name } });
    const url = uploaded.asset?.url || uploaded.body?.asset?.url;
    if (!url) throw new Error("Agent tidak mengembalikan file stiker");
    const top = Math.max(0, ...setupFrameLayers().map(layer => layer.z));
    onboarding.frameEditor.stickers.push({ url, previewUrl: URL.createObjectURL(file), x: 50, y: 88, size: 28, rotation: 0, opacity: 100, z: top + 1 });
    onboarding.frameEditor.selected = { type: "sticker", index: onboarding.frameEditor.stickers.length - 1 };
    renderSetupFrameEditor();
  } catch (error) { $("#frame-onboarding-status").textContent = error.message; }
});
$("#setup-frame-layer-list").addEventListener("click", event => {
  const row = event.target.closest(".setup-frame-layer-row");
  if (!row || !onboarding.frameEditor) return;
  const type = row.dataset.layerType;
  const index = Number(row.dataset.layerIndex);
  onboarding.frameEditor.selected = { type, index };
  const layers = setupFrameLayers();
  const position = layers.findIndex(layer => layer.type === type && layer.index === index);
  const direction = event.target.closest(".setup-layer-up") ? -1 : event.target.closest(".setup-layer-down") ? 1 : 0;
  if (direction && layers[position + direction]) {
    const current = type === "sticker" ? onboarding.frameEditor.stickers[index] : onboarding.frameEditor.slotTransforms[index];
    const adjacentLayer = layers[position + direction];
    const adjacent = adjacentLayer.type === "sticker" ? onboarding.frameEditor.stickers[adjacentLayer.index] : onboarding.frameEditor.slotTransforms[adjacentLayer.index];
    const currentZ = Number(current.z || 1); current.z = Number(adjacent.z || 1); adjacent.z = currentZ;
  }
  renderSetupFrameEditor();
});
const setupFramePreview = $("#setup-frame-upload-preview");
let setupFrameDrag = null;
setupFramePreview.addEventListener("pointerdown", event => {
  if (!onboarding.frameEditor) return;
  const element = event.target.closest(".setup-frame-element");
  if (element && !(onboarding.frameEditor.selected?.type === "all-slots" && element.dataset.setupEditorType === "slot")) onboarding.frameEditor.selected = { type: element.dataset.setupEditorType, index: Number(element.dataset.setupEditorIndex) };
  const selected = onboarding.frameEditor.selected;
  const target = element ? setupSelectedFrameElements()[0] : onboarding.frameEditor;
  setupFrameDrag = { kind: element ? "element" : "artwork", clientX: event.clientX, clientY: event.clientY, x: target.x, y: target.y, group: selected.type === "all-slots" ? onboarding.frameEditor.slotTransforms.map(item => ({ x: item.x, y: item.y })) : null };
  setupFramePreview.setPointerCapture(event.pointerId);
  setupFramePreview.classList.add("dragging");
  renderSetupFrameEditor();
});
setupFramePreview.addEventListener("pointermove", event => {
  if (!setupFrameDrag || !onboarding.frameEditor) return;
  const bounds = setupFramePreview.getBoundingClientRect();
  const direction = setupFrameDrag.kind === "element" ? 1 : -1;
  const x = Math.max(0, Math.min(100, setupFrameDrag.x + direction * ((event.clientX - setupFrameDrag.clientX) / bounds.width) * 100));
  const y = Math.max(0, Math.min(100, setupFrameDrag.y + direction * ((event.clientY - setupFrameDrag.clientY) / bounds.height) * 100));
  if (setupFrameDrag.kind === "element") {
    if (onboarding.frameEditor.selected.type === "all-slots") {
      const dx = x - setupFrameDrag.x, dy = y - setupFrameDrag.y;
      onboarding.frameEditor.slotTransforms.forEach((item, index) => { item.x = Math.max(0, Math.min(100, setupFrameDrag.group[index].x + dx)); item.y = Math.max(0, Math.min(100, setupFrameDrag.group[index].y + dy)); });
    } else { const target = setupSelectedFrameElements()[0]; if (target) { target.x = x; target.y = y; } }
  } else { onboarding.frameEditor.x = x; onboarding.frameEditor.y = y; }
  renderSetupFrameEditor();
});
const endSetupFrameDrag = event => {
  if (!setupFrameDrag) return;
  setupFrameDrag = null;
  setupFramePreview.classList.remove("dragging");
  if (setupFramePreview.hasPointerCapture(event.pointerId)) setupFramePreview.releasePointerCapture(event.pointerId);
};
setupFramePreview.addEventListener("pointerup", endSetupFrameDrag);
setupFramePreview.addEventListener("pointercancel", endSetupFrameDrag);
$("#save-setup-frame-design").addEventListener("click", event => {
  event.preventDefault();
  if (!onboarding.frameEditor) return;
  const editor = onboarding.frameEditor;
  if (onboarding.framePreviewUrl) URL.revokeObjectURL(onboarding.framePreviewUrl);
  onboarding.framePreviewUrl = editor.previewUrl;
  onboarding.frameFile = editor.file;
  onboarding.frameDesign = { backgroundCss: editor.backgroundCss, slots: editor.slots, zoom: editor.zoom, x: editor.x, y: editor.y, slotTransforms: structuredClone(editor.slotTransforms), stickers: structuredClone(editor.stickers) };
  onboarding.selectedFrame = "upload";
  document.querySelectorAll("[data-frame-choice]").forEach(button => button.classList.remove("active"));
  $("#upload-starter-frame").classList.add("active", "has-preview");
  $("#upload-starter-frame small").textContent = editor.file.name;
  renderStarterUploadPreview();
  onboarding.frameEditor = null;
  $("#setup-frame-editor-dialog").close();
  $("#frame-onboarding-status").textContent = "Desain siap. Tekan Lanjutkan untuk menyimpan.";
});
$("#setup-frame-editor-dialog").addEventListener("close", () => {
  if (onboarding.frameEditor) {
    if (onboarding.frameEditor.previewUrl) URL.revokeObjectURL(onboarding.frameEditor.previewUrl);
    (onboarding.frameEditor.stickers || []).forEach(item => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
  }
  onboarding.frameEditor = null;
});
$("#save-onboarding-frame").addEventListener("click", saveStarterFrame);
$("#finish-onboarding").addEventListener("click", () => {
  const code = onboarding.booth?.boothCode || localStorage.getItem("photoslive.boothCode");
  location.href = `/${code}/admin`;
});

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  status("Memeriksa akun…");
  try {
    const body = { boothCode: $("#login-booth").value, email: $("#login-email").value || $("#login-pin-email").value, password: $("#login-password").value, pin: $("#login-pin").value };
    let result;
    try {
      result = await api("login", { method: "POST", body: JSON.stringify(body) });
    } catch (error) {
      const savedCode = localStorage.getItem(`photoslive.boothAlias.${body.boothCode.trim().toLowerCase()}`) || "";
      const isMissing = error.data?.recoveryRequired || error.message.includes("Photobox tidak ditemukan");
      if (isMissing && savedCode && savedCode.toLowerCase() !== body.boothCode.trim().toLowerCase()) {
        result = await api("login", { method: "POST", body: JSON.stringify({ ...body, boothCode: savedCode, aliasCode: body.boothCode }) });
        $("#login-booth").value = result.booth.boothCode;
      } else if (error.data?.recoveryRequired) {
        $("#login-recovery-email-field").classList.remove("hidden");
        $("#login-pin-email").required = true;
        status(error.message);
        $("#login-pin-email").focus();
        return;
      } else throw error;
    }
    localStorage.setItem("photoslive.machineId", result.booth.machineId);
    localStorage.setItem("photoslive.boothCode", result.booth.boothCode);
    location.href = `/${result.booth.boothCode}/admin`;
  } catch (error) { status(error.message); }
});

$("#forgot-form").addEventListener("submit", async event => {
  event.preventDefault();
  status("Mengirim permintaan…");
  try {
    await api("forgot_password", { method: "POST", body: JSON.stringify({ email: $("#forgot-email").value, message: $("#forgot-message").value }) });
    status("Permintaan diterima. Superadmin akan memeriksa dan menghubungi Anda secara manual.", true);
  } catch (error) { status(error.message); }
});

const params = new URLSearchParams(location.search);
const rememberedBooth = localStorage.getItem("photoslive.boothCode") || "";
if (params.get("booth") || rememberedBooth) $("#login-booth").value = params.get("booth") || rememberedBooth;
loginMethod("pin");
const previewStep = ["127.0.0.1", "localhost"].includes(location.hostname) ? Number(params.get("previewStep")) : 0;
setSetupStep(previewStep >= 1 && previewStep <= 6 ? previewStep : 1);
mode(params.get("mode") || "setup");
