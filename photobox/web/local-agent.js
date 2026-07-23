const $ = selector => document.querySelector(selector);
const state = { token: "", status: null, restoreBackup: "", companionUrl: "" };
const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(location.hostname);

const formatBytes = value => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value || 0); let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};
const formatUptime = seconds => { const value = Number(seconds || 0); const days = Math.floor(value / 86400); const hours = Math.floor((value % 86400) / 3600); const minutes = Math.floor((value % 3600) / 60); return days ? `${days}h ${hours}j` : hours ? `${hours}j ${minutes}m` : `${minutes}m`; };
const formatMilliseconds = value => `${Number(value || 0).toLocaleString("id-ID", { maximumFractionDigits: 1 })} ms`;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function toast(message, kind = "") { const element = $("#toast"); element.textContent = message; element.className = `toast show ${kind}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { element.className = "toast"; }, 3500); }

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token && (String(options.method || "GET").toUpperCase() !== "GET" || path.startsWith("/api/local/"))) headers["X-Photoslive-Token"] = state.token;
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
  const booth = status.config?.boothCode;
  const pairing = status.config?.pairingCode;
  $("#agent-detail").textContent = status.lastError || (booth ? `Booth ${booth}${pairing ? ` · pairing ${pairing}` : ""}` : "Belum dipasangkan");
  $("#cloud-value").textContent = status.cloud?.connected ? "Siap" : "Tidak tersambung";
  $("#cloud-detail").textContent = status.cloud?.lastHeartbeatAt ? `Heartbeat ${new Date(status.cloud.lastHeartbeatAt * 1000).toLocaleTimeString("id-ID")}` : "Belum ada heartbeat cloud";
  const pending = Number(status.sync?.pending || 0) + Number(status.sync?.running || 0);
  $("#sync-value").textContent = status.sync?.failed ? "Perlu diperiksa" : pending ? `${pending} menunggu` : "Siap";
  $("#sync-detail").textContent = status.sync?.lastError || `${status.queue?.pendingPrints || 0} print · ${status.sync?.remainingCapacity ?? "—"} slot sync tersedia`;
  const offlineLabels = { online: "Siap", normal: "Normal", warning: "Perlu internet", critical: "Kritis", blocked: "Sesi diblokir", disabled: "Dinonaktifkan", invalid: "Lease rusak", uninitialized: "Belum aktif" };
  $("#offline-value").textContent = offlineLabels[status.offlinePolicy?.state] || "Perlu diperiksa";
  $("#offline-detail").textContent = status.offlinePolicy?.message || status.offlinePolicy?.error || status.offlinePolicy?.action || "Lease belum tersedia";
  $("#uptime-value").textContent = formatUptime(status.uptimeSeconds);
  $("#version-detail").textContent = `Agent ${status.version || "—"}`;
  const memory = status.system?.memory;
  const cpu = status.system?.cpu;
  const disk = status.system?.disk;
  const storageSafety = status.system?.storageSafety;
  const systemCard = $("#system-value").closest("article");
  systemCard.classList.toggle("warning", storageSafety?.state === "warning");
  systemCard.classList.toggle("critical", storageSafety?.state === "critical" || storageSafety?.available === false);
  if (storageSafety?.state === "critical") {
    $("#system-value").textContent = "Penyimpanan kritis";
    $("#system-detail").textContent = `${storageSafety.message} · ${disk ? `${formatBytes(disk.freeBytes)} kosong` : "disk —"}`;
  } else if (storageSafety?.state === "warning") {
    $("#system-value").textContent = "Penyimpanan menipis";
    $("#system-detail").textContent = `${storageSafety.message} · ${disk ? `${formatBytes(disk.freeBytes)} kosong` : "disk —"}`;
  } else {
    $("#system-value").textContent = memory?.available ? `${memory.usedPercent}% RAM` : "Perlu diperiksa";
    $("#system-detail").textContent = `${cpu?.available ? `${cpu.loadPercent}% beban CPU` : "CPU —"} · ${disk?.available === false ? "disk perlu dipulihkan" : disk ? `${formatBytes(disk.freeBytes)} disk kosong` : "disk —"}`;
  }
  const update = status.update || {};
  const updateLabels = { ready: "Tersedia", current: "Terbaru", checking: "Memeriksa", downloading: "Mengunduh", installing: "Memasang", "rolling-back": "Rollback", "rolled-back": "Dipulihkan", "restart-required": "Perlu restart", failed: "Perlu diperiksa", "not-configured": "Belum dikonfigurasi" };
  $("#update-value").textContent = updateLabels[update.state] || "Belum tersedia";
  $("#update-detail").textContent = update.message || "Updater belum dikonfigurasi";
  const updateBusy = ["checking", "downloading", "installing", "rolling-back"].includes(update.state);
  $("#check-update").disabled = updateBusy;
  $("#install-update").disabled = updateBusy || update.state !== "ready";
  $("#install-update-help").textContent = update.state === "ready" ? `Pasang versi ${update.availableVersion || "baru"} dengan backup otomatis` : updateBusy ? "Proses update sedang berjalan" : "Periksa versi baru terlebih dahulu";
  $("#rollback-update").disabled = updateBusy || !update.rollbackAvailable;
  $("#rollback-update-help").textContent = update.rollbackAvailable ? "Pulihkan backup aplikasi terakhir" : "Backup versi sebelumnya belum tersedia";
  $("#pause-label").textContent = status.agentState === "paused" ? "Resume koneksi" : "Pause koneksi";
  $("#pause-help").textContent = status.agentState === "paused" ? "Lanjutkan command dari cloud" : "Heartbeat tetap aktif saat dijeda";
  if (booth) {
    const cloudOrigin = String(status.config?.cloud || "https://photoslive.vercel.app").replace(/\/$/, "");
    $("#open-admin").href = `${cloudOrigin}/${encodeURIComponent(booth)}/admin`;
  }
}

async function refreshStatus() { renderStatus(await api("/api/local/agent/status")); }

function renderCompanion(result) {
  const value = result.status || {};
  const status = value.status || "disconnected";
  const element = $("#companion-state");
  element.className = `companion-state ${status}`;
  const labels = { connected: "Tersambung", waiting: "Menunggu scan", disconnected: "Belum tersambung" };
  element.querySelector("b").textContent = labels[status] || "Perlu diperiksa";
  $("#companion-device").textContent = value.deviceName || (status === "waiting" ? "QR siap dipindai" : "Belum ada tablet");
  $("#revoke-companion").disabled = status === "disconnected";
  if (status === "connected") {
    $("#companion-detail").textContent = `Heartbeat ${new Date(Number(value.lastSeenAt || 0) * 1000).toLocaleTimeString("id-ID")} · listener ${value.listenerUrl || "LAN"}`;
    $("#companion-qr").hidden = true;
  } else if (status === "waiting") {
    const seconds = Math.max(0, Math.round(Number(value.pairingExpiresAt || 0) - Date.now() / 1000));
    $("#companion-detail").textContent = `Menunggu tablet · QR berakhir dalam ${Math.ceil(seconds / 60)} menit`;
  } else {
    $("#companion-detail").textContent = "Buat QR, lalu scan memakai kamera tablet pada Wi-Fi yang sama.";
  }
}

async function refreshCompanion() {
  const result = await api("/api/local/companion/status");
  renderCompanion(result);
  return result;
}

async function createCompanionPairing() {
  const button = $("#create-companion-pairing");
  button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/local/companion/pairing", { method: "POST", body: "{}" });
    state.companionUrl = result.pairingUrl || "";
    $("#companion-qr").hidden = false;
    $("#companion-qr-image").hidden = !result.qrImage;
    if (result.qrImage) $("#companion-qr-image").src = result.qrImage;
    renderCompanion({ status: result });
    toast(result.qrImage ? "QR companion siap dipindai" : "Library QR belum tersedia. Salin link pairing.", result.qrImage ? "" : "error");
  } catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}

async function revokeCompanionSession() {
  const button = $("#revoke-companion"); button.disabled = true;
  try {
    const result = await api("/api/local/companion/revoke", { method: "POST", body: "{}" });
    state.companionUrl = ""; $("#companion-qr").hidden = true; renderCompanion(result); toast("Tablet companion diputuskan");
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
}

async function copyCompanionLink() {
  if (!state.companionUrl) return toast("Buat QR pairing terlebih dahulu", "error");
  try { await navigator.clipboard.writeText(state.companionUrl); toast("Link pairing disalin"); }
  catch { toast("Browser tidak mengizinkan clipboard. Gunakan QR.", "error"); }
}

async function refreshMetrics() {
  const button = $("#refresh-metrics");
  const detail = $("#metrics-detail");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  detail.classList.remove("error");
  detail.textContent = "Memuat metrik lokal…";
  try {
    const result = await api("/api/local/metrics");
    const requests = result.requests || {};
    const sync = result.queues?.sync || {};
    const print = result.queues?.print || {};
    const failures = result.failures || {};
    const sampleCount = Number(requests.total || 0);
    $("#metrics-latency").textContent = sampleCount ? formatMilliseconds(requests.p95Ms) : "Belum ada data";
    $("#metrics-latency-detail").textContent = sampleCount ? `Rata-rata ${formatMilliseconds(requests.averageMs)} · maks ${formatMilliseconds(requests.maxMs)}` : "Gunakan booth atau admin untuk mulai mengukur";
    $("#metrics-error-rate").textContent = sampleCount ? `${Number(requests.errorRatePercent || 0).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%` : "Belum ada data";
    $("#metrics-error-detail").textContent = `${Number(requests.errors || 0)} error dari ${sampleCount} request`;
    const syncOpen = Number(sync.pending || 0) + Number(sync.running || 0) + Number(sync.failed || 0) + Number(sync.dead || 0);
    const printOpen = Number(print.pending || 0) + Number(print.running || 0) + Number(print.failed || 0);
    const queueUnavailable = sync.available === false || print.available === false;
    $("#metrics-queue").textContent = queueUnavailable ? "Perlu diperiksa" : `${syncOpen + printOpen} job`;
    $("#metrics-queue-detail").textContent = queueUnavailable ? (sync.error || print.error || "Antrean tidak dapat dibaca") : `${syncOpen} upload · ${printOpen} cetak`;
    const failureTotal = ["camera", "capture", "printer", "render"].reduce((total, kind) => total + Number(failures[kind] || 0), 0);
    $("#metrics-failures").textContent = failureTotal ? `${failureTotal} gagal` : "Tidak ada";
    $("#metrics-failures-detail").textContent = `${Number(failures.camera || 0)} kamera · ${Number(failures.capture || 0)} capture · ${Number(failures.printer || 0)} printer · ${Number(failures.render || 0)} render`;
    detail.textContent = `${sampleCount}/${Number(result.sampleLimit || 512)} sampel tersimpan · Controller hidup ${formatUptime(result.uptimeSeconds)} · diperbarui ${new Date(result.generatedAt).toLocaleTimeString("id-ID")}`;
  } catch (error) {
    $("#metrics-latency").textContent = "Perlu diperiksa";
    $("#metrics-error-rate").textContent = "Perlu diperiksa";
    $("#metrics-queue").textContent = "Perlu diperiksa";
    $("#metrics-failures").textContent = "Perlu diperiksa";
    detail.classList.add("error");
    detail.textContent = `${error.message}. Tekan muat ulang untuk mencoba lagi.`;
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

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

async function waitForUpdate() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await refreshStatus();
    const current = state.status?.update?.state;
    if (!["checking", "downloading", "installing", "rolling-back"].includes(current)) return current;
  }
  throw new Error("Proses update masih berjalan. Status akan tetap diperbarui di latar belakang.");
}

async function runUpdate(path, pendingText, body = {}) {
  const result = await api(path, { method: "POST", body: JSON.stringify(body) });
  toast(result.message || pendingText);
  await refreshStatus();
  const finalState = await waitForUpdate();
  const update = state.status?.update || {};
  if (["failed", "rolled-back"].includes(finalState)) throw new Error(update.message || "Update gagal");
  toast(update.message || "Proses update selesai");
  return update;
}

function openRollback() {
  $("#rollback-confirmation").value = "";
  $("#confirm-rollback").disabled = true;
  $("#rollback-dialog").showModal();
  $("#rollback-confirmation").focus();
}

function openStopAgent() {
  $("#stop-agent-confirmation").value = "";
  $("#confirm-stop-agent").disabled = true;
  $("#stop-agent-dialog").showModal();
  $("#stop-agent-confirmation").focus();
}

async function confirmStopAgent() {
  const button = $("#confirm-stop-agent");
  button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/local/agent/stop", { method: "POST", body: JSON.stringify({ confirmation: "STOP AGENT" }) });
    $("#stop-agent-dialog").close();
    toast(result.message || "Agent dihentikan. Gunakan Restart Agent untuk menyalakannya kembali.");
    await refreshStatus();
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
  finally { button.removeAttribute("aria-busy"); }
}

async function confirmRollback() {
  const button = $("#confirm-rollback");
  button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    $("#rollback-dialog").close();
    await runUpdate("/api/local/agent/update/rollback", "Rollback dimulai", { confirmation: "ROLLBACK" });
  } catch (error) { toast(error.message, "error"); }
  finally { button.removeAttribute("aria-busy"); }
}

async function testDevice(kind) {
  const button = $(`#test-${kind}`); button.disabled = true;
  try {
    const result = await api(`/api/local/devices/${kind}/test`, { method: "POST", body: "{}" });
    toast(result.message || `${kind === "camera" ? "Kamera" : "Printer"} siap`);
    await refreshDevices();
  } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; }
}

async function refreshLogs() {
  try {
    const { lines } = await api("/api/local/agent/logs?limit=120");
    $("#agent-logs").textContent = lines?.length ? lines.map(line => { try { const item = JSON.parse(line); return `${new Date(item.time * 1000).toLocaleString("id-ID")}  ${String(item.level || "info").toUpperCase()}  ${item.message}`; } catch { return line; } }).join("\n") : "Belum ada log Agent.";
  } catch (error) { $("#agent-logs").textContent = error.message; }
}

async function exportLogs() {
  const button = $("#export-logs"); button.disabled = true;
  try {
    const { lines } = await api("/api/local/agent/logs?limit=500");
    const blob = new Blob([(lines || []).join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `photoslive-agent-${new Date().toISOString().slice(0, 10)}.log`;
    link.click(); URL.revokeObjectURL(url);
    toast("Log Agent diexport tanpa secret");
  } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; }
}

async function refreshBackups() {
  const list = $("#backup-list");
  list.innerHTML = '<p class="empty-state">Memuat daftar backup…</p>';
  try {
    const result = await api("/api/local/backups");
    const healthy = result.database?.healthy === true;
    $("#database-value").textContent = healthy ? "Siap" : "Perlu dipulihkan";
    $("#database-detail").textContent = result.database?.message || "Status tidak tersedia";
    const backups = Array.isArray(result.backups) ? result.backups : [];
    list.innerHTML = backups.length ? backups.map(backup => `<article class="backup-row"><div><strong>${new Date(backup.createdAt).toLocaleString("id-ID")}</strong><small>${backup.reason} · ${formatBytes(backup.sizeBytes)} · schema ${backup.schemaVersion || "—"}</small></div><button class="button secondary restore-backup" data-backup="${backup.name}"><img src="/icons/rotate-cw.svg" alt="">Restore</button></article>`).join("") : '<p class="empty-state">Belum ada backup lokal. Tekan Buat backup untuk membuat salinan pertama.</p>';
  } catch (error) {
    list.innerHTML = `<p class="empty-state">${error.message} <button class="device-test" id="retry-backups">Coba lagi</button></p>`;
    $("#retry-backups")?.addEventListener("click", refreshBackups);
  }
}

async function refreshSyncJobs() {
  const list = $("#sync-job-list");
  list.innerHTML = '<p class="empty-state">Memuat antrean upload…</p>';
  try {
    const result = await api("/api/local/sync/jobs?limit=50");
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    list.innerHTML = jobs.length ? jobs.map(job => {
      const retry = ["failed", "dead"].includes(job.status) ? `<button class="button secondary retry-sync-job" data-job="${escapeHtml(job.id)}"><img src="/icons/rotate-cw.svg" alt="">Retry</button>` : "";
      const multipart = job.completedPartCount ? ` · ${job.completedPartCount} part tersimpan` : "";
      const progress = `${job.completedFileCount || 0}/${job.fileCount || 0} file${multipart}`;
      const metadata = `<small>${progress} · ${job.attempts || 0} percobaan · ${new Date(job.updatedAt).toLocaleString("id-ID")}</small>`;
      const detail = `${metadata}${job.lastError ? `<small class="job-error">${escapeHtml(job.lastError)}</small>` : ""}`;
      return `<article class="sync-job-row"><div><span class="job-status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span><strong>${escapeHtml(job.shareCode || job.sessionId || job.id)}</strong>${detail}</div>${retry}</article>`;
    }).join("") : '<p class="empty-state">Belum ada antrean upload.</p>';
  } catch (error) {
    list.innerHTML = `<p class="empty-state">${error.message} <button class="device-test" id="retry-sync-list">Coba lagi</button></p>`;
    $("#retry-sync-list")?.addEventListener("click", refreshSyncJobs);
  }
}

async function retryFailedSync() {
  const button = $("#retry-failed-sync"); button.disabled = true;
  try { const result = await api("/api/local/sync/retry", { method: "POST", body: "{}" }); toast(`${result.retried || 0} job dijadwalkan ulang`); await Promise.all([refreshStatus(), refreshSyncJobs()]); }
  catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; }
}

async function retrySyncJob(jobId, button) {
  button.disabled = true;
  try { await api("/api/local/sync/retry-job", { method: "POST", body: JSON.stringify({ jobId }) }); toast("Job upload dijadwalkan ulang"); await Promise.all([refreshStatus(), refreshSyncJobs()]); }
  catch (error) { toast(error.message, "error"); button.disabled = false; }
}

async function refreshPrintJobs() {
  const list = $("#print-job-list");
  list.innerHTML = '<p class="empty-state">Memuat antrean cetak…</p>';
  try {
    const result = await api("/api/local/print/jobs?limit=50");
    const jobs = Array.isArray(result.jobs) ? result.jobs : [];
    list.innerHTML = jobs.length ? jobs.map(job => {
      const retry = job.status === "failed" ? `<button class="button secondary retry-print-job" data-job="${escapeHtml(job.id)}"><img src="/icons/rotate-cw.svg" alt="">Retry</button>` : "";
      const label = job.shareCode || job.sessionId || job.id;
      const file = job.fileName ? `${job.fileExists ? "File siap" : "File hilang"} · ${escapeHtml(job.fileName)}` : "File cetak belum tersedia";
      const metadata = `<small>${file} · ${job.attempts || 0} percobaan · ${new Date(job.updatedAt).toLocaleString("id-ID")}</small>`;
      const error = job.lastError ? `<small class="job-error">${escapeHtml(job.lastError)}</small>` : "";
      return `<article class="sync-job-row"><div><span class="job-status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span><strong>${escapeHtml(label)}</strong>${metadata}${error}</div>${retry}</article>`;
    }).join("") : '<p class="empty-state">Belum ada antrean cetak.</p>';
  } catch (error) {
    list.innerHTML = `<p class="empty-state">${escapeHtml(error.message)} <button class="device-test" id="retry-print-list">Coba lagi</button></p>`;
    $("#retry-print-list")?.addEventListener("click", refreshPrintJobs);
  }
}

async function retryPrintJob(jobId, button) {
  button.disabled = true;
  try { await api("/api/local/print/retry-job", { method: "POST", body: JSON.stringify({ jobId }) }); toast("Job cetak dijadwalkan ulang"); await Promise.all([refreshStatus(), refreshPrintJobs()]); }
  catch (error) { toast(error.message, "error"); button.disabled = false; }
}

async function createBackup() {
  const button = $("#create-backup"); button.disabled = true; button.setAttribute("aria-busy", "true");
  try { await api("/api/local/backups/create", { method: "POST", body: "{}" }); toast("Backup database berhasil dibuat"); await refreshBackups(); }
  catch (error) { toast(error.message, "error"); }
  finally { button.disabled = false; button.removeAttribute("aria-busy"); }
}

function openRestore(name) {
  state.restoreBackup = name;
  $("#restore-backup-name").textContent = name;
  $("#restore-confirmation").value = "";
  $("#confirm-restore").disabled = true;
  $("#restore-dialog").showModal();
  $("#restore-confirmation").focus();
}

async function restoreBackup() {
  const button = $("#confirm-restore"); button.disabled = true; button.setAttribute("aria-busy", "true");
  try {
    await api("/api/local/backups/restore", { method: "POST", body: JSON.stringify({ name: state.restoreBackup, confirmation: $("#restore-confirmation").value }) });
    $("#restore-dialog").close(); toast("Database lokal berhasil dipulihkan");
    await Promise.all([refreshStatus(), refreshBackups(), refreshLogs()]);
  } catch (error) { toast(error.message, "error"); button.disabled = false; }
  finally { button.removeAttribute("aria-busy"); }
}

$("#refresh-status").addEventListener("click", () => Promise.all([refreshStatus(), refreshMetrics(), refreshDevices(), refreshLogs()]).catch(error => toast(error.message, "error")));
$("#refresh-metrics").addEventListener("click", refreshMetrics);
$("#refresh-devices").addEventListener("click", refreshDevices);
$("#refresh-logs").addEventListener("click", refreshLogs);
$("#export-logs").addEventListener("click", exportLogs);
$("#create-backup").addEventListener("click", createBackup);
$("#refresh-sync-jobs").addEventListener("click", refreshSyncJobs);
$("#retry-failed-sync").addEventListener("click", retryFailedSync);
$("#sync-job-list").addEventListener("click", event => { const button = event.target.closest(".retry-sync-job"); if (button) retrySyncJob(button.dataset.job, button); });
$("#refresh-print-jobs").addEventListener("click", refreshPrintJobs);
$("#print-job-list").addEventListener("click", event => { const button = event.target.closest(".retry-print-job"); if (button) retryPrintJob(button.dataset.job, button); });
$("#backup-list").addEventListener("click", event => { const button = event.target.closest(".restore-backup"); if (button) openRestore(button.dataset.backup); });
$("#restore-confirmation").addEventListener("input", event => { $("#confirm-restore").disabled = event.target.value !== "RESTORE"; });
$("#confirm-restore").addEventListener("click", restoreBackup);
$("#test-camera").addEventListener("click", () => testDevice("camera"));
$("#test-printer").addEventListener("click", () => testDevice("printer"));
$("#toggle-pause").addEventListener("click", () => mutate(state.status?.agentState === "paused" ? "/api/local/agent/resume" : "/api/local/agent/pause", "Status Agent diperbarui").catch(error => toast(error.message, "error")));
$("#restart-agent").addEventListener("click", () => mutate("/api/local/agent/restart", "Restart Agent diminta").catch(error => toast(error.message, "error")));
$("#stop-agent").addEventListener("click", openStopAgent);
$("#stop-agent-confirmation").addEventListener("input", event => { $("#confirm-stop-agent").disabled = event.target.value !== "STOP AGENT"; });
$("#confirm-stop-agent").addEventListener("click", confirmStopAgent);
$("#check-update").addEventListener("click", () => runUpdate("/api/local/agent/update/check", "Memeriksa update").catch(error => toast(error.message, "error")));
$("#install-update").addEventListener("click", () => runUpdate("/api/local/agent/update/apply", "Memasang update").catch(error => toast(error.message, "error")));
$("#rollback-update").addEventListener("click", openRollback);
$("#rollback-confirmation").addEventListener("input", event => { $("#confirm-rollback").disabled = event.target.value !== "ROLLBACK"; });
$("#confirm-rollback").addEventListener("click", confirmRollback);
$("#run-diagnosis").addEventListener("click", async () => { try { const result = await api("/api/local/agent/diagnose", { method: "POST", body: "{}" }); if (result.database?.healthy === false) { toast(`${result.database.message} ${result.database.action || ""}`.trim(), "error"); } else { const devices = Array.isArray(result.devices) ? result.devices : []; const camera = devices.filter(item => item.kind === "camera" && item.status === "connected").length; const printer = devices.filter(item => item.kind === "printer" && item.status === "connected").length; toast(`Diagnosis selesai: ${camera} kamera, ${printer} printer, ${result.sync?.pending || 0} sinkronisasi menunggu`); } await refreshLogs(); } catch (error) { toast(error.message, "error"); } });
$("#create-setup-code").addEventListener("click", async () => { const button = $("#create-setup-code"); button.disabled = true; try { const result = await api("/api/local/agent/setup-code", { method: "POST", body: "{}" }); await navigator.clipboard?.writeText(result.code).catch(() => {}); toast(`Kode ${result.code} dibuat dan disalin. Buka halaman setup.`); } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; } });
$("#create-companion-pairing").addEventListener("click", createCompanionPairing);
$("#revoke-companion").addEventListener("click", revokeCompanionSession);
$("#copy-companion-link").addEventListener("click", copyCompanionLink);
$("#pick-folder").addEventListener("click", async () => { const button = $("#pick-folder"); button.disabled = true; try { const selected = await api("/api/local/storage/pick-folder", { method: "POST", body: "{}" }); await api("/api/settings/storage", { method: "PATCH", body: JSON.stringify({ localPhotoPath: selected.path }) }); toast("Folder foto diperbarui"); await refreshDevices(); } catch (error) { toast(error.message, "error"); } finally { button.disabled = false; } });

async function init() {
  if (!isLoopback) {
    document.querySelectorAll("button").forEach(button => { button.disabled = true; });
    const main = document.querySelector("main");
    main.innerHTML = `<section class="remote-manager-message"><span><img src="/icons/monitor.svg" alt="" /></span><p class="eyebrow">LOCAL MANAGER</p><h1>Buka di komputer photobox</h1><p>Kontrol Agent, kamera, printer, dan pemilihan folder hanya tersedia pada mesin yang menjalankan Photoslive.</p><code>http://127.0.0.1:8080/local-agent</code><a class="button primary" href="/setup?mode=login">Kembali ke admin cloud</a></section>`;
    return;
  }
  try {
    state.token = (await api("/api/local/installation")).token;
    // Recovery controls stay usable when one diagnostic surface is unavailable.
    await Promise.allSettled([refreshStatus(), refreshMetrics(), refreshDevices(), refreshLogs(), refreshBackups(), refreshSyncJobs(), refreshPrintJobs(), refreshCompanion()]);
    setInterval(() => refreshStatus().catch(() => {}), 5000);
    setInterval(() => refreshMetrics().catch(() => {}), 10000);
    setInterval(() => refreshCompanion().catch(() => {}), 5000);
  } catch (error) { toast(error.message, "error"); }
}
init();
