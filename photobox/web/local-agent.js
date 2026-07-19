const $ = selector => document.querySelector(selector);
const state = { token: "", status: null };

const formatBytes = value => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value || 0); let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};
const formatUptime = seconds => { const value = Number(seconds || 0); const days = Math.floor(value / 86400); const hours = Math.floor((value % 86400) / 3600); const minutes = Math.floor((value % 3600) / 60); return days ? `${days}h ${hours}j` : hours ? `${hours}j ${minutes}m` : `${minutes}m`; };

function toast(message, kind = "") { const element = $("#toast"); element.textContent = message; element.className = `toast show ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { element.className = "toast"; }, 3500); }

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token && String(options.method || "GET").toUpperCase() !== "GET") headers["X-Photoslive-Token"] = state.token;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Permintaan gagal (${response.status})`);
  return payload;
}

function renderStatus(status) {
  state.status = status;
  const online = status.controllerState === "online";
  $("#connection-state").classList.toggle("ready", online);
  $("#connection-state span").textContent = online ? "Controller siap" : "Perlu diperiksa";
  $("#controller-value").textContent = online ? "Siap" : "Tidak tersambung";
  $("#controller-detail").textContent = status.config?.controller || "127.0.0.1:8080";
  const agentLabels = { online: "Siap", paused: "Dijeda", offline: "Tidak tersambung" };
  $("#agent-value").textContent = agentLabels[status.agentState] || status.agentState;
  $("#agent-detail").textContent = status.lastError || (status.lastHeartbeatAt ? `Heartbeat ${new Date(status.lastHeartbeatAt * 1000).toLocaleTimeString("id-ID")}` : "Menunggu heartbeat");
  const pending = Number(status.sync?.pending || 0) + Number(status.sync?.running || 0);
  $("#sync-value").textContent = status.sync?.failed ? "Perlu diperiksa" : pending ? `${pending} menunggu` : "Siap";
  $("#sync-detail").textContent = status.sync?.lastError || "Tidak ada antrean tertunda";
  $("#uptime-value").textContent = formatUptime(status.uptimeSeconds);
  $("#version-detail").textContent = `Agent ${status.version || "—"}`;
  $("#pause-label").textContent = status.agentState === "paused" ? "Resume koneksi" : "Pause koneksi";
  $("#pause-help").textContent = status.agentState === "paused" ? "Lanjutkan command dari cloud" : "Heartbeat tetap aktif saat dijeda";
  const booth = status.config?.boothCode;
  if (booth) {
    const cloudOrigin = String(status.config?.cloud || "https://photoslive.vercel.app").replace(/\/$/, "");
    $("#open-admin").href = `${cloudOrigin}/${encodeURIComponent(booth)}/admin`;
  }
}

async function refreshStatus() { renderStatus(await api("/api/local/agent/status")); }

async function refreshDevices() {
  const button = $("#refresh-devices"); button.disabled = true;
  try {
    const [devicePayload, storage] = await Promise.all([
      api("/api/local/devices/refresh", { method: "POST", body: "{}" }),
      api("/api/storage/overview?refresh=1"),
    ]);
    for (const kind of ["camera", "printer"]) {
      const devices = (devicePayload.devices || []).filter(device => device.kind === kind && device.status === "connected");
      const card = $(`#${kind}-value`).closest("article");
      card.classList.toggle("ready", devices.length > 0);
      $(`#${kind}-value`).textContent = devices.length ? devices[0].name : "Tidak tersambung";
      $(`#${kind}-detail`).textContent = devices.length > 1 ? `${devices.length} perangkat terdeteksi` : devices[0]?.detail || "Tidak ditemukan";
    }
    $("#storage-path").textContent = storage.localPath || "Folder bawaan";
    $("#storage-usage").textContent = `${formatBytes(storage.disk?.freeBytes)} kosong dari ${formatBytes(storage.disk?.totalBytes)}`;
    toast("Perangkat dan penyimpanan diperbarui");
  } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; }
}

async function mutate(path, pendingText) {
  const result = await api(path, { method: "POST", body: "{}" });
  toast(result.message || pendingText);
  await refreshStatus();
  return result;
}

async function refreshLogs() {
  try {
    const { lines } = await api("/api/local/agent/logs?limit=120");
    $("#agent-logs").textContent = lines?.length ? lines.map(line => { try { const item = JSON.parse(line); return `${new Date(item.time * 1000).toLocaleString("id-ID")}  ${String(item.level || "info").toUpperCase()}  ${item.message}`; } catch { return line; } }).join("\n") : "Belum ada log Agent.";
  } catch (error) { $("#agent-logs").textContent = error.message; }
}

$("#refresh-status").addEventListener("click", () => Promise.all([refreshStatus(), refreshDevices(), refreshLogs()]).catch(error => toast(error.message, "error")));
$("#refresh-devices").addEventListener("click", refreshDevices);
$("#refresh-logs").addEventListener("click", refreshLogs);
$("#toggle-pause").addEventListener("click", () => mutate(state.status?.agentState === "paused" ? "/api/local/agent/resume" : "/api/local/agent/pause", "Status Agent diperbarui").catch(error => toast(error.message, "error")));
$("#restart-agent").addEventListener("click", () => mutate("/api/local/agent/restart", "Restart Agent diminta").catch(error => toast(error.message, "error")));
$("#run-diagnosis").addEventListener("click", async () => { try { const result = await api("/api/local/agent/diagnose", { method: "POST", body: "{}" }); const camera = (result.devices || []).filter(item => item.kind === "camera" && item.status === "connected").length; const printer = (result.devices || []).filter(item => item.kind === "printer" && item.status === "connected").length; toast(`Diagnosis selesai: ${camera} kamera, ${printer} printer, ${result.sync?.pending || 0} sinkronisasi menunggu`); await refreshLogs(); } catch (error) { toast(error.message, "error"); } });
$("#create-setup-code").addEventListener("click", async () => { const button = $("#create-setup-code"); button.disabled = true; try { const result = await api("/api/local/agent/setup-code", { method: "POST", body: "{}" }); await navigator.clipboard?.writeText(result.code).catch(() => {}); toast(`Kode ${result.code} dibuat dan disalin. Buka halaman setup.`); } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; } });
$("#pick-folder").addEventListener("click", async () => { const button = $("#pick-folder"); button.disabled = true; try { const selected = await api("/api/local/storage/pick-folder", { method: "POST", body: "{}" }); await api("/api/settings/storage", { method: "PATCH", body: JSON.stringify({ localPhotoPath: selected.path }) }); toast("Folder foto diperbarui"); await refreshDevices(); } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; } });

async function init() {
  try {
    state.token = (await api("/api/local/installation")).token;
    await Promise.all([refreshStatus(), refreshDevices(), refreshLogs()]);
    setInterval(() => refreshStatus().catch(() => {}), 5000);
  } catch (error) { toast(error.message, "error"); }
}
init();
