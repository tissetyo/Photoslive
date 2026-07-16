const $ = selector => document.querySelector(selector);

const onboarding = {
  step: 1,
  machine: null,
  booth: null,
  devices: [],
  selectedFrame: "clean-white",
  frameFile: null,
  framePreviewUrl: null,
};

const setupSteps = [
  ["Hubungkan mesin", "Masukkan kode dari Photoslive Agent."],
  ["Identitas photobox", "Beri nama agar mesin mudah dikenali."],
  ["Akses pemilik", "Email dan PIN wajib diisi."],
  ["Kamera & printer", "Periksa perangkat yang terhubung."],
  ["Frame pertama", "Pilih tampilan awal hasil foto."],
  ["Siap digunakan", "Setup dasar telah selesai."],
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
  const deadline = Date.now() + 35_000;
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
  onboarding.step = Math.max(1, Math.min(6, Number(step) || 1));
  document.querySelectorAll("[data-setup-step]").forEach(panel => panel.classList.toggle("hidden", Number(panel.dataset.setupStep) !== onboarding.step));
  const [name, help] = setupSteps[onboarding.step - 1];
  $("#wizard-step-label").textContent = `Langkah ${onboarding.step} dari 6`;
  $("#wizard-step-name").textContent = name;
  $("#wizard-progress-bar").style.width = `${(onboarding.step / 6) * 100}%`;
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

function renderDeviceCard(kind, device) {
  const card = $(`#onboarding-${kind}`);
  card.classList.toggle("connected", Boolean(device));
  card.querySelector("small").textContent = device ? String(device.name || device.model || "Terdeteksi") : "Belum terdeteksi";
}

async function refreshOnboardingDevices() {
  const message = $("#device-onboarding-status");
  message.textContent = "Memeriksa Agent dan perangkat…";
  try {
    const { machine } = await bridgeApi("machine_status", { machineId: onboarding.machine.id }, "GET");
    onboarding.machine = { ...onboarding.machine, ...machine };
    onboarding.devices = Array.isArray(machine?.devices) ? machine.devices : [];
    const camera = onboarding.devices.find(device => deviceKind(device) === "camera");
    const printer = onboarding.devices.find(device => deviceKind(device) === "printer");
    renderDeviceCard("camera", camera);
    renderDeviceCard("printer", printer);
    message.textContent = !machine?.online ? "Agent sedang offline. Nyalakan Agent lalu periksa kembali, atau lewati dulu." : camera || printer ? "Perangkat yang terdeteksi sudah diperbarui." : "Agent online, tetapi kamera dan printer belum terdeteksi.";
  } catch (error) {
    message.textContent = `${error.message} Anda dapat melewati langkah ini.`;
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
      await controllerRequest("/api/settings", "POST", { appearance: { activeFrame }, booth: { name: $("#booth-name").value.trim() } });
    }
    message.textContent = "Frame pertama siap digunakan.";
    setSetupStep(6);
    renderReadyChecklist();
  } catch (error) {
    message.textContent = `${error.message}. Pilih frame bawaan atau gunakan tombol lewati.`;
  }
}

function renderReadyChecklist() {
  const hasCamera = onboarding.devices.some(device => deviceKind(device) === "camera");
  const hasPrinter = onboarding.devices.some(device => deviceKind(device) === "printer");
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
document.querySelectorAll("[data-setup-back]").forEach(button => button.addEventListener("click", () => setSetupStep(onboarding.step - 1)));
document.querySelectorAll("[data-setup-next], [data-setup-skip]").forEach(button => button.addEventListener("click", () => {
  setSetupStep(onboarding.step + 1);
  if (onboarding.step === 6) renderReadyChecklist();
}));

$("#copy-setup-command").addEventListener("click", async () => {
  const command = $("#setup-code-command").textContent;
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
    $("#copy-feedback").textContent = "Perintah berhasil disalin.";
    $("#copy-setup-command span").textContent = "Tersalin";
    setTimeout(() => { $("#copy-feedback").textContent = ""; $("#copy-setup-command span").textContent = "Salin"; }, 5000);
  } catch {
    $("#copy-feedback").textContent = "Tidak dapat menyalin otomatis. Blok perintah lalu salin manual.";
  }
});

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

$("#refresh-onboarding-devices").addEventListener("click", refreshOnboardingDevices);
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
