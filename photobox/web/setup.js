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
  if (!response.ok) throw new Error(data.error || `Request gagal (${response.status})`);
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

function selectStarterFrame(value) {
  onboarding.selectedFrame = value;
  document.querySelectorAll("[data-frame-choice]").forEach(button => button.classList.toggle("active", button.dataset.frameChoice === value));
}

async function saveStarterFrame() {
  const message = $("#frame-onboarding-status");
  message.textContent = "Menyimpan pilihan frame…";
  let activeFrame = onboarding.selectedFrame;
  try {
    if (onboarding.frameFile) {
      if (!onboarding.machine?.online) throw new Error("Agent harus online untuk upload frame");
      const uploaded = await controllerRequest("/api/assets/frame", "PUT", null, {
        bodyBase64: await fileToBase64(onboarding.frameFile),
        headers: { "content-type": onboarding.frameFile.type, "x-filename": onboarding.frameFile.name },
      });
      activeFrame = uploaded.asset?.url || uploaded.body?.asset?.url;
      if (!activeFrame) throw new Error("Agent tidak mengembalikan file frame");
      onboarding.selectedFrame = activeFrame;
    }
    if (onboarding.machine?.online) {
      await controllerRequest("/api/settings", "PATCH", { appearance: { activeFrame }, booth: { name: $("#booth-name").value.trim() } });
    }
    message.textContent = "Frame pertama siap digunakan.";
    setSetupStep(6);
    renderReadyChecklist();
  } catch (error) {
    message.textContent = `${error.message}. Pilih frame bawaan atau gunakan tombol lewati.`;
  }
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
  onboarding.frameFile = null;
  if (onboarding.framePreviewUrl) URL.revokeObjectURL(onboarding.framePreviewUrl);
  onboarding.framePreviewUrl = null;
  $("#upload-starter-frame").style.removeProperty("--frame-preview");
  selectStarterFrame(button.dataset.frameChoice);
}));
$("#upload-starter-frame").addEventListener("click", () => $("#starter-frame-file").click());
$("#starter-frame-file").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return $("#frame-onboarding-status").textContent = "Ukuran frame maksimal 10 MB.";
  if (onboarding.framePreviewUrl) URL.revokeObjectURL(onboarding.framePreviewUrl);
  onboarding.frameFile = file;
  onboarding.framePreviewUrl = URL.createObjectURL(file);
  onboarding.selectedFrame = "upload";
  document.querySelectorAll("[data-frame-choice]").forEach(button => button.classList.remove("active"));
  $("#upload-starter-frame").classList.add("active", "has-preview");
  $("#upload-starter-frame").style.setProperty("--frame-preview", `url('${onboarding.framePreviewUrl}')`);
  $("#upload-starter-frame small").textContent = file.name;
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
    const body = { boothCode: $("#login-booth").value, email: $("#login-email").value, password: $("#login-password").value, pin: $("#login-pin").value };
    const result = await api("login", { method: "POST", body: JSON.stringify(body) });
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
if (params.get("booth")) $("#login-booth").value = params.get("booth");
loginMethod("pin");
const previewStep = ["127.0.0.1", "localhost"].includes(location.hostname) ? Number(params.get("previewStep")) : 0;
setSetupStep(previewStep >= 1 && previewStep <= 6 ? previewStep : 1);
mode(params.get("mode") || "setup");
