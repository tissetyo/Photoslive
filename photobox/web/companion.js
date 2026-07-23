const $ = selector => document.querySelector(selector);
const STORAGE_KEY = "photoslive.companion.session";
const companion = { token: "", stream: null, capabilities: null, reconnectTimer: null, sourceFile: null };

function setConnection(state, label, detail) {
  const pill = $("#connection-state");
  pill.className = `state-pill ${state}`;
  pill.querySelector("b").textContent = label;
  $("#connection-label").textContent = label;
  $("#connection-detail").textContent = detail;
  $("#retry-connection").hidden = state !== "error";
}

async function request(path, options = {}) {
  const started = performance.now();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (companion.token) headers.Authorization = `Bearer ${companion.token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, { ...options, headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Permintaan gagal (${response.status})`);
    $("#latency-value").textContent = `${Math.round(performance.now() - started)} ms`;
    return payload;
  } finally { clearTimeout(timeout); }
}

function renderCapabilities(value = {}) {
  companion.capabilities = value;
  $("#storage-capability").textContent = value.storage?.available ? "Siap" : "Tidak tersedia";
  $("#printer-capability").textContent = value.printer?.available ? `${value.printer.devices?.length || 1} tersedia` : "Tidak tersambung";
  $("#test-printer").disabled = !value.printer?.available || !companion.token;
}

async function claimFromFragment() {
  const parameters = new URLSearchParams(location.hash.slice(1));
  const pairingId = parameters.get("pairing");
  const token = parameters.get("token");
  if (!pairingId || !token) return false;
  history.replaceState({}, "", `${location.pathname}${location.search}`);
  const result = await request("/api/companion/claim", {
    method: "POST",
    body: JSON.stringify({ pairingId, token, deviceName: navigator.userAgentData?.platform || navigator.platform || "Tablet" }),
  });
  companion.token = result.sessionToken;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ token: result.sessionToken, expiresAt: result.sessionExpiresAt }));
  renderCapabilities(result.capabilities);
  return true;
}

function restoredToken() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (Number(value.expiresAt || 0) <= Date.now() / 1000) throw new Error("expired");
    return String(value.token || "");
  } catch { localStorage.removeItem(STORAGE_KEY); return ""; }
}

async function connect() {
  clearTimeout(companion.reconnectTimer);
  setConnection("", "Menghubungkan", "Memeriksa Controller lokal…");
  try {
    if (!(await claimFromFragment())) companion.token = restoredToken();
    if (!companion.token) throw new Error("Scan QR baru dari Local Manager pada komputer photobox.");
    const result = await request("/api/companion/status");
    renderCapabilities(result.capabilities);
    setConnection("connected", "Tersambung", `Komputer menerima heartbeat · ${result.capabilities?.controller?.version || "Controller siap"}`);
    companion.reconnectTimer = setTimeout(() => heartbeat(), 10000);
  } catch (error) {
    setConnection("error", "Terputus", error.name === "AbortError" ? "Controller tidak merespons. Pastikan tablet dan komputer memakai Wi-Fi yang sama." : error.message);
  }
}

async function heartbeat() {
  try {
    const result = await request("/api/companion/heartbeat", { method: "POST", body: "{}" });
    setConnection("connected", "Tersambung", `Heartbeat ${new Date(result.status.lastSeenAt * 1000).toLocaleTimeString("id-ID")}`);
    companion.reconnectTimer = setTimeout(heartbeat, 10000);
  } catch (error) {
    setConnection("error", "Menyambungkan ulang", error.message);
    companion.reconnectTimer = setTimeout(connect, 3000);
  }
}

async function startCamera() {
  const button = $("#start-camera");
  button.disabled = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      $("#capture-fallback").hidden = false;
      $("#camera-help").textContent = "Browser memerlukan HTTPS untuk preview. Gunakan tombol Ambil foto uji.";
      throw new Error("Preview live tidak tersedia pada koneksi LAN ini; capture kamera sistem tetap dapat dipakai.");
    }
    companion.stream?.getTracks().forEach(track => track.stop());
    companion.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const video = $("#camera-preview");
    video.srcObject = companion.stream;
    video.hidden = false;
    $("#camera-empty").hidden = true;
    $("#test-storage").disabled = false;
    button.textContent = "Ganti kamera";
  } catch (error) {
    $("#connection-detail").textContent = error.message;
  } finally { button.disabled = false; }
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Foto uji tidak dapat dibaca"));
    reader.readAsDataURL(file);
  });
}

async function captureBase64() {
  if (companion.sourceFile) return (await fileAsDataUrl(companion.sourceFile)).split(",")[1] || "";
  const video = $("#camera-preview");
  if (!companion.stream || !video.videoWidth) throw new Error("Nyalakan kamera atau pilih foto uji terlebih dahulu");
  const canvas = $("#capture-canvas");
  const width = Math.min(1280, video.videoWidth);
  canvas.width = width;
  canvas.height = Math.round(width * video.videoHeight / video.videoWidth);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", .82).split(",")[1] || "";
}

async function testStorage() {
  const button = $("#test-storage");
  button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    const imageBase64 = await captureBase64();
    const result = await request("/api/companion/test/storage", { method: "POST", body: JSON.stringify({ imageBase64 }) });
    $("#storage-capability").textContent = `Siap · ${result.latencyMs} ms`;
    $("#connection-detail").textContent = `Capture ${Math.round(result.bytes / 1024)} KB berhasil ditulis dan dihapus kembali.`;
  } catch (error) { $("#connection-detail").textContent = error.message; }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}

async function testPrinter() {
  if (!confirm("Cetak satu lembar tes pada printer komputer?")) return;
  const button = $("#test-printer"); button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    const result = await request("/api/companion/test/printer", { method: "POST", body: JSON.stringify({ confirmation: "PRINT TEST" }) });
    $("#connection-detail").textContent = result.message;
  } catch (error) { $("#connection-detail").textContent = error.message; }
  finally { button.disabled = !companion.capabilities?.printer?.available; button.removeAttribute("aria-busy"); }
}

$("#retry-connection").addEventListener("click", connect);
$("#start-camera").addEventListener("click", startCamera);
$("#test-storage").addEventListener("click", testStorage);
$("#test-printer").addEventListener("click", testPrinter);
$("#capture-file").addEventListener("change", event => {
  companion.sourceFile = event.target.files?.[0] || null;
  $("#test-storage").disabled = !companion.sourceFile;
  $("#camera-help").textContent = companion.sourceFile ? `Foto uji dipilih: ${companion.sourceFile.name}` : "Pilih foto uji.";
});
$("#disconnect").addEventListener("click", async () => {
  try { if (companion.token) await request("/api/companion/revoke", { method: "POST", body: "{}" }); } catch {}
  localStorage.removeItem(STORAGE_KEY); companion.token = ""; companion.stream?.getTracks().forEach(track => track.stop());
  setConnection("error", "Diputuskan", "Buat dan scan QR baru untuk menyambungkan kembali.");
});
window.addEventListener("beforeunload", () => companion.stream?.getTracks().forEach(track => track.stop()));
connect();
