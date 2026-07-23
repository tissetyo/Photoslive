const $ = selector => document.querySelector(selector);
const requestedDomain = new URLSearchParams(location.search).get("section");
const state = { machines: [], definitions: [], overrides: [], platformFrames: [], platformFrameLoading: false, providerDefinitions: [], providerConnections: [], providerVault: null, providerEconomics: [], providerEconomicsLoading: false, providerMigrations: [], providerMigrationsLoading: false, emailDeliveries: [], financePolicies: [], financeReviews: [], financeBalances: [], payouts: [], payoutAccounts: [], payoutPolicy: null, payoutLoading: false, payoutProofId: null, financeRisks: [], financeRiskSummary: {}, financeRiskLoading: false, platformRole: "", platformStaff: [], platformStaffLoading: false, platformStaffActionLoading: false, ownershipLoading: false, ledgerReconciliationRuns: [], health: null, telemetryHistory: null, alertDeliveries: [], backendHealth: null, webhookEvents: [], remoteJobs: [], audits: [], permissions: new Set(), activeDomain: ["overview", "fleet", "integrations", "finance", "access", "platform"].includes(requestedDomain) ? requestedDomain : "overview", loading: false, healthLoading: false, telemetryLoading: false, alertLoading: false, alertProcessing: false, backendHealthLoading: false, webhookEventsLoading: false, providerLoading: false, emailLoading: false, emailProcessing: false, financePolicyLoading: false, financeReviewLoading: false, financeBalancesLoading: false, financeRefundLoading: false, financeChargebackLoading: false, financeAdjustmentLoading: false, financeProviderFeeLoading: false, ledgerReconciliationLoading: false, remoteJobsLoading: false, remoteJobSending: false, auditLoading: false };

const SUPERADMIN_DOMAINS = {
  overview: { label: "Ringkasan", title: "Kondisi platform", copy: "Hal penting yang perlu diperiksa sekarang.", cards: ["machine-card", "fleet-health-card", "reset-card"] },
  fleet: { label: "Fleet", title: "Mesin & operasional", copy: "Pantau perangkat, telemetry, alert, dan perintah hardware.", cards: ["fleet-health-card", "telemetry-history-card", "alert-routing-card", "remote-jobs-card", "machine-card"] },
  integrations: { label: "Integrasi", title: "Provider & pengiriman", copy: "Kelola frame global, koneksi provider, migrasi, webhook, dan email.", cards: ["platform-frame-card", "provider-connections-card", "provider-economics-card", "provider-migrations-card", "webhook-events-card", "email-delivery-card"] },
  finance: { label: "Finance", title: "Pembayaran & settlement", copy: "Tinjau fee, ledger, risiko, payout, refund, dan rekonsiliasi.", cards: ["finance-policy-card", "finance-review-card", "finance-balances-card", "finance-payout-card", "finance-risk-card", "finance-refund-card", "finance-chargeback-card", "finance-adjustment-card", "finance-provider-fee-card", "finance-ledger-reconciliation-card"] },
  access: { label: "Akses", title: "Pengguna & pemulihan", copy: "Kelola tim platform, pemilik photobox, dan permintaan pemulihan.", cards: ["platform-staff-card", "membership-card", "reset-card"] },
  platform: { label: "Platform", title: "Kontrol platform", copy: "Periksa backend, rollout fitur, dan audit aktivitas sensitif.", cards: ["backend-health-card", "feature-flag-card", "audit-card"] },
};

function showSuperDomain(name, { updateUrl = true } = {}) {
  const domain = SUPERADMIN_DOMAINS[name] || SUPERADMIN_DOMAINS.overview;
  state.activeDomain = SUPERADMIN_DOMAINS[name] ? name : "overview";
  document.querySelectorAll("[data-super-domain]").forEach(button => {
    const active = button.dataset.superDomain === state.activeDomain;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  document.querySelectorAll("#super-dashboard > .dashboard-card").forEach(card => card.classList.toggle("super-domain-hidden", !domain.cards.includes(card.id)));
  $("#super-overview-metrics").classList.toggle("super-domain-hidden", state.activeDomain !== "overview");
  $("#super-domain-eyebrow").textContent = domain.label.toUpperCase();
  $("#super-domain-title").textContent = domain.title;
  $("#super-domain-copy").textContent = domain.copy;
  if (updateUrl) {
    const url = new URL(location.href);
    if (state.activeDomain === "overview") url.searchParams.delete("section"); else url.searchParams.set("section", state.activeDomain);
    history.replaceState(null, "", url);
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

const can = permission => state.permissions.has(permission);
function applyPlatformIdentity(user) {
  state.permissions = new Set(Array.isArray(user?.permissions) ? user.permissions : []);
  state.platformRole = String(user?.platformRole || "platform_owner");
  $("#platform-role").textContent = String(user?.platformRole || "platform_owner").replaceAll("_", " ").toUpperCase();
  $("#remote-job-form").hidden = !can("platform.remote_jobs.write");
  $("#feature-flag-form").hidden = !can("platform.flags.write");
  $("#provider-form").hidden = !can("platform.integrations.write");
  $("#provider-entitlement-form").hidden = !can("platform.integrations.write");
  $("#provider-migrations-card").hidden = !can("platform.integrations.read");
  $("#provider-migration-form").hidden = !can("platform.integrations.write");
  $("#platform-frame-card").hidden = !can("platform.integrations.read");
  $("#platform-frame-upload").hidden = !can("platform.integrations.write");
  $("#email-delivery-card").hidden = !can("platform.integrations.read");
  $("#email-test-form").hidden = !can("platform.integrations.write");
  $("#email-delivery-process").hidden = !can("platform.integrations.write");
  $("#finance-policy-card").hidden = !can("platform.finance.read");
  $("#finance-review-card").hidden = !can("platform.finance.read");
  $("#finance-balances-card").hidden = !can("platform.finance.read");
  $("#finance-payout-card").hidden = !can("platform.finance.read");
  $("#finance-risk-card").hidden = !can("platform.finance.read");
  $("#finance-refund-card").hidden = !can("platform.finance.write");
  $("#finance-chargeback-card").hidden = !can("platform.finance.write");
  $("#finance-adjustment-card").hidden = !can("platform.finance.write");
  $("#finance-provider-fee-card").hidden = !can("platform.finance.write");
  $("#finance-ledger-reconciliation-card").hidden = !can("platform.finance.read");
  $("#webhook-events-card").hidden = !can("platform.finance.read");
  $("#finance-ledger-reconciliation-form").hidden = !can("platform.finance.write");
  $("#finance-policy-form").hidden = !can("platform.finance.write");
  $("#finance-payout-account-form").hidden = !can("platform.finance.write");
  $("#finance-payout-verify-form").hidden = !can("platform.finance.write") || state.platformRole !== "platform_owner";
  $("#alert-routing-process").hidden = !can("platform.fleet.write");
  $("#platform-staff-card").hidden = !can("platform.staff.read");
  $("#platform-staff-invite-form").hidden = !can("platform.staff.write");
}

async function api(action, options = {}) {
  const response = await fetch(`/api/platform?action=${action}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request gagal (${response.status})`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function setStatus(selector, message = "", success = false) {
  const node = $(selector);
  node.textContent = message;
  node.classList.toggle("success", success);
}

function formatTime(value) {
  if (!value) return "Belum pernah";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("id-ID");
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

async function sha256File(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function renderPlatformFrames(result) {
  state.platformFrames = Array.isArray(result.frames) ? result.frames : [];
  $("#platform-frame-grid").innerHTML = state.platformFrames.length ? state.platformFrames.map(frame => `<article class="platform-frame-item" data-platform-frame-id="${escapeHtml(frame.id)}">
    <a class="platform-frame-preview" href="${escapeHtml(frame.downloadUrl)}" download aria-label="Unduh ${escapeHtml(frame.name)}"><img src="${escapeHtml(frame.previewUrl)}" alt="Preview ${escapeHtml(frame.name)}" loading="lazy"></a>
    <h3 title="${escapeHtml(frame.name)}">${escapeHtml(frame.name)}</h3><p>${escapeHtml(formatBytes(frame.size))} · ${escapeHtml(formatTime(frame.createdAt))}</p>
    <div class="card-actions"><a class="btn" href="${escapeHtml(frame.downloadUrl)}" download><img src="/icons/download.svg" alt="">Unduh</a>${can("platform.integrations.write") ? `<button class="btn danger" type="button" data-platform-frame-delete="${escapeHtml(frame.id)}">Hapus</button>` : ""}</div>
  </article>`).join("") : '<p class="empty">Belum ada frame global. Upload frame pertama untuk membagikannya ke seluruh admin photobox.</p>';
  setStatus("#platform-frame-status", `${state.platformFrames.length} frame tersedia`, true);
}

function renderPlatformFramesError(error) {
  $("#platform-frame-grid").innerHTML = '<div class="empty"><p>Perpustakaan frame tidak dapat dimuat.</p><button class="btn" id="platform-frame-inline-retry" type="button">Coba lagi</button></div>';
  setStatus("#platform-frame-status", error.message || "Gagal memuat perpustakaan frame");
}

async function refreshPlatformFrames() {
  if (state.platformFrameLoading || !can("platform.integrations.read")) return;
  state.platformFrameLoading = true;
  $("#platform-frame-retry").disabled = true;
  setStatus("#platform-frame-status", "Memuat perpustakaan frame…");
  try { renderPlatformFrames(await api("platform_frame_library")); }
  catch (error) { renderPlatformFramesError(error); }
  finally { state.platformFrameLoading = false; $("#platform-frame-retry").disabled = false; }
}

async function uploadPlatformFrame(file) {
  if (!file || state.platformFrameLoading) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return setStatus("#platform-frame-status", "Pilih file PNG, JPEG, atau WebP.");
  if (file.size > 25_000_000) return setStatus("#platform-frame-status", "Ukuran frame maksimal 25 MB.");
  state.platformFrameLoading = true;
  $("#platform-frame-upload").disabled = true;
  $("#platform-frame-retry").disabled = true;
  setStatus("#platform-frame-status", "Menyiapkan upload aman…");
  try {
    const prepared = await api("platform_frame_library", { method: "POST", body: JSON.stringify({ operation: "prepare", filename: file.name, contentType: file.type, size: file.size, checksumSha256: await sha256File(file) }) });
    setStatus("#platform-frame-status", "Mengunggah frame…");
    const uploaded = await fetch(prepared.upload.url, { method: prepared.upload.method, headers: prepared.upload.headers, body: file });
    if (!uploaded.ok) throw new Error(`Object storage menolak upload (${uploaded.status})`);
    await api("platform_frame_library", { method: "POST", body: JSON.stringify({ operation: "finalize", uploadId: prepared.uploadId }) });
    setStatus("#platform-frame-status", "Frame berhasil dibagikan ke seluruh admin photobox.", true);
    state.platformFrameLoading = false;
    await refreshPlatformFrames();
  } catch (error) { setStatus("#platform-frame-status", error.message || "Upload frame gagal"); }
  finally { state.platformFrameLoading = false; $("#platform-frame-upload").disabled = false; $("#platform-frame-retry").disabled = false; }
}

async function deletePlatformFrame(button) {
  if (state.platformFrameLoading || !can("platform.integrations.write")) return;
  const frame = state.platformFrames.find(item => item.id === button.dataset.platformFrameDelete);
  if (!frame || !window.confirm(`Hapus frame ${frame.name} dari seluruh perpustakaan?`)) return;
  state.platformFrameLoading = true;
  const card = button.closest(".platform-frame-item");
  card?.classList.add("is-loading"); button.disabled = true;
  setStatus("#platform-frame-status", "Menghapus frame…");
  try {
    await api("platform_frame_library", { method: "DELETE", body: JSON.stringify({ id: frame.id }) });
    state.platformFrameLoading = false;
    await refreshPlatformFrames();
    setStatus("#platform-frame-status", "Frame dihapus dari perpustakaan.", true);
  } catch (error) { setStatus("#platform-frame-status", error.message || "Frame gagal dihapus"); }
  finally { state.platformFrameLoading = false; button.disabled = false; card?.classList.remove("is-loading"); }
}

function healthLabel(value) {
  if (value === "ready") return { label: "SIAP", className: "" };
  if (value === "delayed") return { label: "TERLAMBAT", className: "warn" };
  return { label: "OFFLINE", className: "off" };
}

const providerFieldLabels = {
  R2_ACCOUNT_ID: "Account ID", R2_ACCESS_KEY_ID: "Access key ID", R2_SECRET_ACCESS_KEY: "Secret access key", R2_BUCKET: "Nama bucket",
  S3_ENDPOINT: "Endpoint S3", S3_ACCESS_KEY_ID: "Access key ID", S3_SECRET_ACCESS_KEY: "Secret access key", S3_BUCKET: "Nama bucket",
  XENDIT_SECRET_KEY: "Secret key Xendit", XENDIT_WEBHOOK_TOKEN: "Webhook verification token",
  RESEND_API_KEY: "API key Resend", RESEND_FROM_EMAIL: "Email pengirim",
  RESEND_WEBHOOK_SECRET: "Webhook signing secret",
  MONITORING_WEBHOOK_URL: "URL webhook HTTPS", MONITORING_WEBHOOK_SECRET: "Signing secret",
};

function providerTarget() {
  return $("#provider-scope").value === "global" ? "" : $("#provider-target").value;
}

function renderProviderTargets() {
  const scope = $("#provider-scope").value;
  $("#provider-target-wrap").hidden = scope === "global";
  let targets = [];
  if (scope === "booth") targets = state.machines.map(machine => ({ id: machine.boothCode, label: `${machine.name} · ${machine.boothCode}` }));
  if (scope === "organization") {
    const ids = [...new Set(state.machines.map(machine => machine.organizationId).filter(Boolean))];
    targets = ids.map(id => ({ id, label: id }));
  }
  $("#provider-target").innerHTML = targets.length ? targets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("") : '<option value="">Belum tersedia</option>';
  $("#provider-target").disabled = scope !== "global" && !targets.length;
  syncProviderForm();
}

function syncProviderForm() {
  const definition = state.providerDefinitions.find(item => item.id === $("#provider-id").value);
  const byo = $("#provider-source").value === "byo";
  const fields = definition?.credentialFields || [];
  $("#provider-credentials").hidden = !byo;
  $("#provider-credentials").innerHTML = byo ? fields.map(name => `<label>${escapeHtml(providerFieldLabels[name] || name)}<input data-provider-credential="${escapeHtml(name)}" type="${name.includes("SECRET") || name.includes("TOKEN") || name.includes("KEY") ? "password" : name.includes("EMAIL") ? "email" : "text"}" autocomplete="off" required></label>`).join("") : "";
  const targetMissing = $("#provider-scope").value !== "global" && !providerTarget();
  $("#provider-save").disabled = !can("platform.integrations.write") || state.providerLoading || targetMissing || (byo && !state.providerVault?.available);
}

function renderProviderConnections(result) {
  state.providerDefinitions = Array.isArray(result.definitions) ? result.definitions : [];
  state.providerConnections = Array.isArray(result.connections) ? result.connections : [];
  state.providerVault = result.vault || { available: false, activeKeyVersion: null };
  $("#provider-id").innerHTML = state.providerDefinitions.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${escapeHtml(item.kind)}</option>`).join("");
  $("#provider-vault-state").innerHTML = state.providerVault.available
    ? `<span class="pill">SIAP</span><p>Vault aktif · kunci ${escapeHtml(state.providerVault.activeKeyVersion)}</p>`
    : '<span class="pill off">BELUM SIAP</span><p>Vault server belum dikonfigurasi. API key sendiri belum dapat disimpan dengan aman.</p>';
  $("#provider-rows").innerHTML = state.providerConnections.length ? state.providerConnections.map(connection => {
    const status = connection.status === "active" ? { label: "AKTIF", className: "" } : connection.status === "paused" ? { label: "DIJEDA", className: "warn" } : { label: "DICABUT", className: "off" };
    const fields = connection.source === "platform-managed" ? '<small>Dikelola environment platform</small>' : connection.credentialFields.length ? connection.credentialFields.map(field => `<small>${escapeHtml(providerFieldLabels[field.name] || field.name)}: ${escapeHtml(field.masked)}</small>`).join("") : "<small>Credential telah dihapus</small>";
    const identity = `${connection.scope}|${connection.targetId || ""}|${connection.providerId}`;
    const mutable = can("platform.integrations.write");
    const actions = mutable ? `<div class="provider-actions">
      ${connection.status === "active" && connection.adapterImplemented ? `<button class="btn" type="button" data-provider-test="${escapeHtml(identity)}" aria-label="Tes koneksi ${escapeHtml(connection.label)}">Tes koneksi</button>` : ""}
      ${connection.status !== "revoked" ? `<button class="btn" type="button" data-provider-edit="${escapeHtml(identity)}">Ganti credential</button>` : ""}
      ${connection.status === "active" ? `<button class="btn" type="button" data-provider-state="paused" data-provider-key="${escapeHtml(identity)}">Jeda</button>` : connection.status === "paused" ? `<button class="btn" type="button" data-provider-state="active" data-provider-key="${escapeHtml(identity)}">Aktifkan</button>` : ""}
      ${connection.status !== "revoked" && connection.keyVersion && connection.keyVersion !== state.providerVault.activeKeyVersion ? `<button class="btn" type="button" data-provider-state="rewrap" data-provider-key="${escapeHtml(identity)}">Rotasi kunci</button>` : ""}
      ${connection.status !== "revoked" ? `<button class="btn danger" type="button" data-provider-state="revoked" data-provider-key="${escapeHtml(identity)}">Cabut</button>` : ""}
    </div>` : "—";
    const lastCheck = connection.lastCheck
      ? `<br><small>${connection.lastCheck.state === "ready" ? "Tes siap" : "Tes gagal"}${Number.isFinite(connection.lastCheck.latencyMs) ? ` · ${escapeHtml(connection.lastCheck.latencyMs)} ms` : ""}<br>${escapeHtml(formatTime(connection.lastCheck.checkedAt))}</small>`
      : "<br><small>Belum pernah dites</small>";
    return `<tr><td><b>${escapeHtml(connection.label)}</b>${connection.adapterImplemented ? "" : '<span class="adapter-note">Adapter belum tersedia</span>'}</td><td>${escapeHtml(connection.scope)}<br><small>${escapeHtml(connection.targetId || "Semua")}</small></td><td>${escapeHtml(connection.source === "byo" ? "API key sendiri" : "Platform")}${connection.isDefault ? "<br><small>Default</small>" : ""}</td><td><span class="credential-list">${fields}</span></td><td><span class="pill ${status.className}">${status.label}</span>${connection.expiresAt ? `<br><small>${escapeHtml(formatTime(connection.expiresAt))}</small>` : ""}${lastCheck}</td><td>Credential ${escapeHtml(connection.credentialVersion)}<br><small>Kunci ${escapeHtml(connection.keyVersion || "platform")}</small></td><td>${actions}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada koneksi provider tersimpan.</td></tr>';
  renderProviderTargets();
  syncProviderForm();
  setStatus("#provider-status", `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`, true);
}

function renderProviderConnectionsError(error) {
  $("#provider-rows").innerHTML = '<tr><td colspan="7" class="empty">Koneksi provider tidak dapat dimuat. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#provider-status", error.message || "Gagal memuat koneksi provider");
}

async function refreshProviderConnections() {
  if (state.providerLoading) return;
  state.providerLoading = true;
  $("#provider-retry").disabled = true;
  syncProviderForm();
  setStatus("#provider-status", "Memuat koneksi provider…");
  try { renderProviderConnections(await api("provider_connections")); }
  catch (error) { renderProviderConnectionsError(error); }
  finally { state.providerLoading = false; $("#provider-retry").disabled = false; syncProviderForm(); }
}

function renderProviderEconomicsTargets() {
  const scope = $("#provider-entitlement-scope").value;
  $("#provider-entitlement-target-wrap").hidden = scope === "global";
  let targets = [];
  if (scope === "booth") targets = state.machines.map(machine => ({ id: machine.boothCode, label: `${machine.name} · ${machine.boothCode}` }));
  if (scope === "organization") targets = [...new Set(state.machines.map(machine => machine.organizationId).filter(Boolean))].map(id => ({ id, label: id }));
  $("#provider-entitlement-target").innerHTML = targets.length ? targets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("") : '<option value="">Belum tersedia</option>';
  $("#provider-entitlement-target").disabled = scope !== "global" && !targets.length;
  syncProviderEconomicsForm();
}

function syncProviderEconomicsForm() {
  const scope = $("#provider-entitlement-scope").value;
  const missingTarget = scope !== "global" && !$("#provider-entitlement-target").value;
  $("#provider-entitlement-save").disabled = state.providerEconomicsLoading || !can("platform.integrations.write") || missingTarget;
}

function formatProviderQuantity(value, metric) {
  return metric === "bytes" ? formatBytes(value) : Number(value || 0).toLocaleString("id-ID");
}

function renderProviderEconomics(result) {
  state.providerEconomics = Array.isArray(result.records) ? result.records : [];
  const summary = result.summary || {};
  $("#provider-economics-total").textContent = Number(summary.total || 0).toLocaleString("id-ID");
  $("#provider-economics-ready").textContent = Number(summary.ready || 0).toLocaleString("id-ID");
  $("#provider-economics-warning").textContent = Number(summary.warning || 0).toLocaleString("id-ID");
  $("#provider-economics-exhausted").textContent = Number(summary.exhausted || 0).toLocaleString("id-ID");
  $("#provider-entitlement-id").innerHTML = state.providerDefinitions.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("");
  $("#provider-economics-rows").innerHTML = state.providerEconomics.length ? state.providerEconomics.map(item => {
    const entitlement = item.entitlement;
    const quota = item.quota;
    const status = quota.state === "ready" ? ["SIAP", ""] : quota.state === "warning" ? ["HAMPIR HABIS", "warn"] : quota.state === "exhausted" ? ["HABIS", "off"] : ["BELUM DIATUR", "warn"];
    return `<tr><td><b>${escapeHtml(entitlement.providerId)}</b><br><small>${escapeHtml(entitlement.metric)}</small></td><td>${escapeHtml(entitlement.scope)}<br><small>${escapeHtml(entitlement.targetId || "Semua")}</small></td><td>${escapeHtml(entitlement.plan)}<br><small>Gratis ${escapeHtml(formatProviderQuantity(entitlement.allowance, entitlement.metric))} · add-on ${escapeHtml(formatProviderQuantity(entitlement.addon, entitlement.metric))}</small><br><small>${entitlement.monthlyPriceIdr ? `Rp${Number(entitlement.monthlyPriceIdr).toLocaleString("id-ID")}/bulan` : "Rp0/bulan"}</small></td><td>${escapeHtml(formatProviderQuantity(quota.used, entitlement.metric))}<br><small>${escapeHtml(quota.percent)}%</small></td><td>${escapeHtml(formatProviderQuantity(quota.remaining, entitlement.metric))}</td><td><span class="pill ${status[1]}">${status[0]}</span><br><small>${entitlement.hardLimit ? "Hard limit" : "Peringatan saja"}</small></td><td>${escapeHtml(formatTime(item.latestUsage?.measuredAt || entitlement.updatedAt))}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada plan provider. Tambahkan allowance gratis atau add-on.</td></tr>';
  renderProviderEconomicsTargets();
  setStatus("#provider-economics-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderProviderEconomicsError(error) {
  $("#provider-economics-rows").innerHTML = '<tr><td colspan="7" class="empty">Plan provider tidak dapat dimuat. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#provider-economics-status", error.message || "Gagal memuat plan provider");
}

async function refreshProviderEconomics() {
  if (state.providerEconomicsLoading || !can("platform.integrations.read")) return;
  state.providerEconomicsLoading = true;
  $("#provider-economics-retry").disabled = true;
  syncProviderEconomicsForm();
  setStatus("#provider-economics-status", "Memuat plan dan pemakaian…");
  try { renderProviderEconomics(await api("provider_economics")); }
  catch (error) { renderProviderEconomicsError(error); }
  finally { state.providerEconomicsLoading = false; $("#provider-economics-retry").disabled = false; syncProviderEconomicsForm(); }
}

function syncProviderMigrationForm() {
  const booths = state.machines.map(machine => `<option value="${escapeHtml(machine.boothCode)}">${escapeHtml(machine.name)} · ${escapeHtml(machine.boothCode)}</option>`).join("");
  if ($("#provider-migration-booth").innerHTML !== booths) $("#provider-migration-booth").innerHTML = booths || '<option value="">Belum ada photobox</option>';
  const invalid = !$("#provider-migration-booth").value || $("#provider-migration-source").value === $("#provider-migration-destination").value;
  $("#provider-migration-create").disabled = state.providerMigrationsLoading || !can("platform.integrations.write") || invalid;
}

function providerMigrationStatus(value) {
  if (value === "completed") return ["SELESAI", ""];
  if (value === "running") return ["BERJALAN", ""];
  if (value === "paused") return ["DIJEDA", "warn"];
  if (value === "failed") return ["GAGAL", "off"];
  return ["MENUNGGU", "warn"];
}

function renderProviderMigrations(result) {
  state.providerMigrations = Array.isArray(result.migrations) ? result.migrations : [];
  syncProviderMigrationForm();
  $("#provider-migration-rows").innerHTML = state.providerMigrations.length ? state.providerMigrations.map(item => {
    const status = providerMigrationStatus(item.state);
    const mutable = can("platform.integrations.write") && !state.providerMigrationsLoading;
    const process = mutable && ["queued", "running"].includes(item.state) ? `<button class="btn" type="button" data-migration-operation="process" data-migration-id="${escapeHtml(item.id)}">Salin berikutnya</button>` : "";
    const pause = mutable && ["queued", "running"].includes(item.state) ? `<button class="btn" type="button" data-migration-operation="pause" data-migration-id="${escapeHtml(item.id)}">Jeda</button>` : "";
    const resume = mutable && item.state === "paused" ? `<button class="btn" type="button" data-migration-operation="resume" data-migration-id="${escapeHtml(item.id)}">Lanjutkan</button>` : "";
    const finalize = mutable && item.cutoverReady && !item.finalizedAt ? `<button class="btn primary" type="button" data-migration-operation="finalize" data-migration-id="${escapeHtml(item.id)}">Finalisasi cutover</button>` : "";
    const finalState = item.finalizedAt ? `<span class="pill">CUTOVER SELESAI</span><br><small>${escapeHtml(item.sourceRetirement?.reason || "Provider tujuan aktif")}</small>` : "";
    return `<tr><td><b>${escapeHtml(item.boothCode)}</b><br><small>${escapeHtml(item.id)}</small></td><td>${escapeHtml(item.sourceProvider)} → ${escapeHtml(item.destinationProvider)}</td><td><b>${escapeHtml(item.progressPercent)}%</b><br><small>${escapeHtml(item.copied)} / ${escapeHtml(item.total)} tersalin${item.failed ? ` · ${escapeHtml(item.failed)} gagal` : ""}</small></td><td><span class="pill ${status[1]}">${status[0]}</span>${item.lastError ? `<br><small>${escapeHtml(item.lastError)}</small>` : ""}${finalState}</td><td>${escapeHtml(formatTime(item.updatedAt))}</td><td><div class="provider-actions">${process}${pause}${resume}${finalize || (!item.finalizedAt && item.state === "completed" ? "Menunggu finalisasi" : item.state === "failed" ? "Batas retry tercapai" : "")}</div></td></tr>`;
  }).join("") : '<tr><td colspan="6" class="empty">Belum ada migrasi object storage.</td></tr>';
  setStatus("#provider-migrations-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderProviderMigrationsError(error) {
  $("#provider-migration-rows").innerHTML = '<tr><td colspan="6" class="empty">Migrasi provider tidak dapat dimuat. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#provider-migrations-status", error.message || "Gagal memuat migrasi provider");
}

async function refreshProviderMigrations() {
  if (state.providerMigrationsLoading || !can("platform.integrations.read")) return;
  state.providerMigrationsLoading = true;
  $("#provider-migrations-retry").disabled = true;
  syncProviderMigrationForm();
  setStatus("#provider-migrations-status", "Memuat migrasi provider…");
  try { renderProviderMigrations(await api("provider_migrations")); }
  catch (error) { renderProviderMigrationsError(error); }
  finally { state.providerMigrationsLoading = false; $("#provider-migrations-retry").disabled = false; syncProviderMigrationForm(); }
}

function emailStatus(value) {
  if (value === "delivered") return { label: "DITERIMA", className: "" };
  if (value === "sent") return { label: "TERKIRIM", className: "" };
  if (["queued", "retry", "waiting_configuration"].includes(value)) return { label: value === "queued" ? "MENUNGGU" : value === "retry" ? "COBA LAGI" : "BELUM DIKONFIGURASI", className: "warn" };
  return { label: String(value || "failed").replaceAll("_", " ").toUpperCase(), className: "off" };
}

function renderEmailDeliveries(result) {
  state.emailDeliveries = Array.isArray(result.deliveries) ? result.deliveries : [];
  const summary = result.summary || {};
  $("#email-summary-queued").textContent = Number(summary.queued || 0).toLocaleString("id-ID");
  $("#email-summary-sent").textContent = Number(summary.sent || 0).toLocaleString("id-ID");
  $("#email-summary-delivered").textContent = Number(summary.delivered || 0).toLocaleString("id-ID");
  $("#email-summary-problems").textContent = Number(summary.problems || 0).toLocaleString("id-ID");
  $("#email-delivery-rows").innerHTML = state.emailDeliveries.length ? state.emailDeliveries.map(delivery => {
    const status = emailStatus(delivery.status);
    const retryable = ["failed", "retry", "waiting_configuration"].includes(delivery.status) && can("platform.integrations.write");
    return `<tr><td>${escapeHtml(formatTime(delivery.createdAt))}</td><td><b>${escapeHtml(delivery.template)}</b><br><small>${escapeHtml(delivery.boothCode || "Platform")}</small></td><td>${escapeHtml(delivery.recipient)}</td><td><span class="pill ${status.className}">${escapeHtml(status.label)}</span><br><small>${escapeHtml(formatTime(delivery.updatedAt))}</small></td><td>${Number(delivery.attempts || 0).toLocaleString("id-ID")}</td><td>${escapeHtml(delivery.lastError || "—")}</td><td>${retryable ? `<button class="btn" type="button" data-retry-email="${escapeHtml(delivery.id)}">Coba lagi</button>` : "—"}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada pengiriman email.</td></tr>';
  setStatus("#email-delivery-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderEmailDeliveriesError(error) {
  $("#email-delivery-rows").innerHTML = '<tr><td colspan="7" class="empty">Antrean email tidak dapat dimuat. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#email-delivery-status", error.message || "Gagal memuat antrean email");
}

async function refreshEmailDeliveries() {
  if (state.emailLoading || !can("platform.integrations.read")) return;
  state.emailLoading = true;
  $("#email-delivery-retry").disabled = true;
  setStatus("#email-delivery-status", "Memuat antrean email…");
  try { renderEmailDeliveries(await api("email_deliveries")); }
  catch (error) { renderEmailDeliveriesError(error); }
  finally { state.emailLoading = false; $("#email-delivery-retry").disabled = false; }
}

async function processEmailQueue() {
  if (state.emailProcessing || !can("platform.integrations.write")) return;
  state.emailProcessing = true;
  $("#email-delivery-process").disabled = true;
  setStatus("#email-delivery-status", "Mengirim email yang sudah jatuh tempo…");
  try {
    const result = await api("email_deliveries", { method: "POST", body: JSON.stringify({ operation: "process" }) });
    await refreshEmailDeliveries();
    setStatus("#email-delivery-status", `${result.processed} email diproses · ${result.sent} diteruskan ke Resend · ${result.retrying} menunggu retry.`, true);
  } catch (error) { setStatus("#email-delivery-status", error.message || "Antrean email gagal diproses"); }
  finally { state.emailProcessing = false; $("#email-delivery-process").disabled = false; }
}

function renderFinancePolicyTargets() {
  const boothScope = $("#finance-policy-scope").value === "booth";
  $("#finance-policy-target-wrap").hidden = !boothScope;
  $("#finance-policy-target").innerHTML = state.machines.length
    ? state.machines.map(machine => `<option value="${escapeHtml(machine.boothCode)}">${escapeHtml(machine.name)} · ${escapeHtml(machine.boothCode)}</option>`).join("")
    : '<option value="">Belum ada photobox</option>';
  $("#finance-policy-target").disabled = !state.machines.length;
  $("#finance-policy-save").disabled = state.financePolicyLoading || !can("platform.finance.write") || (boothScope && !state.machines.length);
}

function renderFinancePolicies(result) {
  state.financePolicies = Array.isArray(result.policies) ? result.policies : [];
  $("#finance-policy-rows").innerHTML = state.financePolicies.length ? state.financePolicies.map(policy => {
    const target = policy.scope === "global" ? "Semua photobox" : policy.targetId;
    const remove = policy.scope === "booth" && can("platform.finance.write")
      ? `<button class="btn danger" type="button" data-finance-policy-delete="${escapeHtml(policy.targetId)}">Gunakan fee global</button>` : "—";
    return `<tr><td>${escapeHtml(policy.scope === "global" ? "GLOBAL" : "PHOTOBOX")}</td><td>${escapeHtml(target)}</td><td><b>${(Number(policy.platformFeeBps || 0) / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%</b><br><small>${escapeHtml(policy.platformFeeBps)} bps</small></td><td>${escapeHtml(formatTime(policy.updatedAt))}<br><small>${escapeHtml(policy.updatedBy || "environment")}</small></td><td>${remove}</td></tr>`;
  }).join("") : '<tr><td colspan="5" class="empty">Belum ada kebijakan fee.</td></tr>';
  renderFinancePolicyTargets();
  setStatus("#finance-policy-status", `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`, true);
}

function renderFinancePoliciesError(error) {
  $("#finance-policy-rows").innerHTML = '<tr><td colspan="5" class="empty">Kebijakan fee tidak dapat dimuat. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#finance-policy-status", error.message || "Gagal memuat kebijakan fee");
}

async function refreshFinancePolicies() {
  if (state.financePolicyLoading || !can("platform.finance.read")) return;
  state.financePolicyLoading = true;
  $("#finance-policy-retry").disabled = true;
  renderFinancePolicyTargets();
  setStatus("#finance-policy-status", "Memuat kebijakan fee…");
  try { renderFinancePolicies(await api("finance_policy")); }
  catch (error) { renderFinancePoliciesError(error); }
  finally { state.financePolicyLoading = false; $("#finance-policy-retry").disabled = false; renderFinancePolicyTargets(); }
}

function formatCurrency(value, currency = "IDR") {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value || 0));
}

function renderFinanceReviews(result) {
  state.financeReviews = Array.isArray(result.records) ? result.records : [];
  $("#finance-review-rows").innerHTML = state.financeReviews.length ? state.financeReviews.map(({ payment, reconciliation }) => {
    const mutable = can("platform.finance.write");
    const actions = mutable ? `<div class="card-actions"><button class="btn" type="button" data-payment-review="approved" data-payment-id="${escapeHtml(payment.id)}">Setujui</button><button class="btn danger" type="button" data-payment-review="rejected" data-payment-id="${escapeHtml(payment.id)}">Tolak</button></div>` : "—";
    return `<tr><td><b>${escapeHtml(payment.id)}</b><br><small>${escapeHtml(payment.providerPaymentId || "—")}</small></td><td>${escapeHtml(payment.boothCode)}</td><td>${escapeHtml(formatCurrency(payment.amount, payment.currency))}</td><td>${escapeHtml(formatTime(payment.paidAt))}</td><td><span class="pill warn">REVIEW</span><br><small>${escapeHtml(reconciliation.reason || "late_payment")}</small></td><td>${actions}</td></tr>`;
  }).join("") : '<tr><td colspan="6" class="empty">Tidak ada pembayaran terlambat yang menunggu review.</td></tr>';
  setStatus("#finance-review-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderFinanceReviewsError(error) {
  $("#finance-review-rows").innerHTML = '<tr><td colspan="6" class="empty">Antrean review tidak dapat dimuat. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#finance-review-status", error.message || "Gagal memuat review pembayaran");
}

async function refreshFinanceReviews() {
  if (state.financeReviewLoading || !can("platform.finance.read")) return;
  state.financeReviewLoading = true;
  $("#finance-review-retry").disabled = true;
  setStatus("#finance-review-status", "Memuat pembayaran yang perlu direview…");
  try { renderFinanceReviews(await api("finance_reconciliation&status=review")); }
  catch (error) { renderFinanceReviewsError(error); }
  finally { state.financeReviewLoading = false; $("#finance-review-retry").disabled = false; }
}

function renderFinanceBalances(result) {
  state.financeBalances = Array.isArray(result.records) ? result.records : [];
  const totals = result.totals || {};
  $("#finance-balance-pending").textContent = formatCurrency(totals.pendingBalance, totals.currency);
  $("#finance-balance-available").textContent = formatCurrency(totals.availableBalance, totals.currency);
  $("#finance-balance-total").textContent = formatCurrency(totals.totalBalance, totals.currency);
  $("#finance-balance-provisional").textContent = Number(totals.provisionalEntryCount || 0).toLocaleString("id-ID");
  $("#finance-balances-rows").innerHTML = state.financeBalances.length ? state.financeBalances.map(record => `<tr><td><b>${escapeHtml(record.name)}</b><br><small>${escapeHtml(record.boothCode)}</small></td><td>${escapeHtml(formatCurrency(record.pendingBalance, record.currency))}</td><td>${escapeHtml(formatCurrency(record.availableBalance, record.currency))}</td><td><b>${escapeHtml(formatCurrency(record.totalBalance, record.currency))}</b></td><td>${Number(record.entryCount || 0).toLocaleString("id-ID")}<br><small>${Number(record.provisionalEntryCount || 0).toLocaleString("id-ID")} provisional</small></td><td>${escapeHtml(formatTime(record.latestEntryAt))}</td></tr>`).join("") : '<tr><td colspan="6" class="empty">Belum ada saldo ledger pada photobox.</td></tr>';
  setStatus("#finance-balances-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderFinanceBalancesError(error) {
  $("#finance-balances-rows").innerHTML = '<tr><td colspan="6" class="empty">Saldo ledger tidak dapat dimuat. Gunakan Perbarui saldo untuk mencoba lagi.</td></tr>';
  setStatus("#finance-balances-status", error.message || "Gagal memuat saldo ledger");
}

async function refreshFinanceBalances() {
  if (state.financeBalancesLoading || !can("platform.finance.read")) return;
  state.financeBalancesLoading = true;
  $("#finance-balances-retry").disabled = true;
  setStatus("#finance-balances-status", "Menghitung saldo dari ledger…");
  try { renderFinanceBalances(await api("finance_balances")); }
  catch (error) { renderFinanceBalancesError(error); }
  finally { state.financeBalancesLoading = false; $("#finance-balances-retry").disabled = false; }
}

function payoutStatus(value) {
  if (value === "paid") return { label: "DIBAYAR", className: "" };
  if (value === "approved") return { label: "DISETUJUI", className: "warn" };
  if (value === "pending_approval") return { label: "MENUNGGU APPROVAL", className: "warn" };
  return { label: "DIBATALKAN", className: "off" };
}

function selectedPayoutAccount() {
  return state.payoutAccounts.find(account => account.boothCode === $("#finance-payout-booth").value) || null;
}

function syncPayoutControls() {
  const select = $("#finance-payout-booth");
  const previous = select.value;
  select.innerHTML = state.machines.length
    ? state.machines.map(machine => `<option value="${escapeHtml(machine.boothCode)}">${escapeHtml(machine.name)} · ${escapeHtml(machine.boothCode)}</option>`).join("")
    : '<option value="">Belum ada photobox</option>';
  if (state.machines.some(machine => machine.boothCode === previous)) select.value = previous;
  const account = selectedPayoutAccount();
  const isOwner = state.platformRole === "platform_owner";
  const writable = can("platform.finance.write") && Boolean(select.value) && !state.payoutLoading;
  for (const id of ["#finance-payout-mode", "#finance-payout-minimum", "#finance-payout-policy-save", "#finance-payout-bank", "#finance-payout-account-name", "#finance-payout-account-number", "#finance-payout-account-save", "#finance-payout-verification-reference", "#finance-payout-verify", "#finance-payout-create"]) $(id).disabled = !writable;
  $("#finance-payout-verify").disabled = !writable || !isOwner || !account || account.status === "verified";
  $("#finance-payout-create").disabled = !writable || state.payoutPolicy?.mode !== "manual_superadmin" || account?.status !== "verified";
  $("#finance-payout-account-summary").innerHTML = account
    ? `<span class="pill ${account.status === "verified" ? "" : "warn"}">${account.status === "verified" ? "TERVERIFIKASI" : "MENUNGGU VERIFIKASI"}</span><p><b>${escapeHtml(account.bankCode)} · ${escapeHtml(account.accountNumberMasked)}</b><br>${escapeHtml(account.accountName)} · versi ${Number(account.version || 0)}${account.verifiedAt ? `<br><small>Diverifikasi ${escapeHtml(formatTime(account.verifiedAt))}</small>` : ""}</p>`
    : '<span class="pill warn">BELUM SIAP</span><p>Rekening payout belum tersimpan untuk photobox ini.</p>';
}

function payoutActions(payout) {
  if (!can("platform.finance.write")) return "—";
  const actions = [];
  if (payout.status === "pending_approval" && state.platformRole === "platform_owner") actions.push(`<button class="btn" type="button" data-payout-action="approve" data-payout-id="${escapeHtml(payout.id)}">Setujui</button>`);
  if (payout.status === "approved") {
    actions.push(`<button class="btn" type="button" data-payout-action="proof" data-payout-id="${escapeHtml(payout.id)}">${payout.proofObjectKey ? "Ganti bukti" : "Upload bukti"}</button>`);
    if (payout.proofObjectKey && state.platformRole === "platform_owner") actions.push(`<button class="btn primary" type="button" data-payout-action="paid" data-payout-id="${escapeHtml(payout.id)}">Tandai dibayar</button>`);
  }
  if (["pending_approval", "approved"].includes(payout.status)) actions.push(`<button class="btn danger" type="button" data-payout-action="cancel" data-payout-id="${escapeHtml(payout.id)}">Batalkan</button>`);
  if (payout.status === "paid" && payout.emailDeliveryId) actions.push(`<button class="btn" type="button" data-payout-action="resend" data-payout-id="${escapeHtml(payout.id)}">Kirim ulang email</button>`);
  return actions.length ? `<div class="payout-row-actions">${actions.join("")}</div>` : "—";
}

function renderPayouts(result) {
  state.payouts = Array.isArray(result.payouts) ? result.payouts : [];
  state.payoutAccounts = Array.isArray(result.accounts) ? result.accounts : [];
  if (result.policy) state.payoutPolicy = result.policy;
  if (state.payoutPolicy) {
    $("#finance-payout-mode").value = state.payoutPolicy.mode || "disabled";
    $("#finance-payout-minimum").value = Number(state.payoutPolicy.minimumAmount || 10000);
  }
  const deliverySummary = result.deliverySummary || {};
  $("#payout-delivery-paid").textContent = deliverySummary.paid || 0;
  $("#payout-delivery-delivered").textContent = deliverySummary.delivered || 0;
  $("#payout-delivery-pending").textContent = deliverySummary.pending || 0;
  $("#payout-delivery-problems").textContent = Number(deliverySummary.failed || 0) + Number(deliverySummary.missing || 0);
  $("#finance-payout-rows").innerHTML = state.payouts.length ? state.payouts.map(payout => {
    const status = payoutStatus(payout.status);
    const proof = payout.proofObjectKey ? `<button class="btn" type="button" data-payout-proof-view="${escapeHtml(payout.id)}">Lihat bukti</button><br><small>Link aman 5 menit</small>` : "Belum ada bukti";
    return `<tr><td>${escapeHtml(formatTime(payout.createdAt))}<br><small>${escapeHtml(payout.preparedBy || "—")}</small></td><td><b>${escapeHtml(payout.boothCode)}</b><br><small>${escapeHtml(payout.period)}</small></td><td>${escapeHtml(payout.account?.bankCode || "—")} · ${escapeHtml(payout.account?.accountNumberMasked || "—")}<br><small>${escapeHtml(payout.account?.accountName || "—")}</small></td><td><b>${escapeHtml(formatCurrency(payout.amount, payout.currency))}</b></td><td><span class="pill ${status.className}">${status.label}</span>${payout.approvedBy ? `<br><small>Approval ${escapeHtml(payout.approvedBy)}</small>` : ""}</td><td>${proof}${payout.transferReference ? `<br><small>${escapeHtml(payout.transferReference)}</small>` : ""}</td><td>${payoutActions(payout)}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada batch payout.</td></tr>';
  syncPayoutControls();
  setStatus("#finance-payout-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderPayoutsError(error) {
  $("#finance-payout-rows").innerHTML = '<tr><td colspan="7" class="empty">Payout tidak dapat dimuat. Gunakan Perbarui payout untuk mencoba lagi.</td></tr>';
  setStatus("#finance-payout-status", error.message || "Gagal memuat payout");
}

async function refreshPayouts() {
  if (state.payoutLoading || !can("platform.finance.read")) return;
  state.payoutLoading = true;
  $("#finance-payout-retry").disabled = true;
  syncPayoutControls();
  setStatus("#finance-payout-status", "Memuat payout dan rekening…");
  try {
    const boothCode = $("#finance-payout-booth").value || state.machines[0]?.boothCode || "";
    renderPayouts(await api(`finance_payout&boothCode=${encodeURIComponent(boothCode)}&limit=100`));
  } catch (error) { renderPayoutsError(error); }
  finally { state.payoutLoading = false; $("#finance-payout-retry").disabled = false; syncPayoutControls(); }
}

function financeRiskLabel(value) {
  if (value === "critical") return { label: "KRITIS", className: "off" };
  if (value === "high") return { label: "TINGGI", className: "warn" };
  if (value === "medium") return { label: "SEDANG", className: "warn" };
  return { label: "RENDAH", className: "" };
}

function financeRiskStatus(value) {
  if (value === "resolved") return { label: "SELESAI", className: "" };
  if (value === "acknowledged") return { label: "DIAKUI", className: "warn" };
  return { label: "TERBUKA", className: "off" };
}

function financeRiskActions(risk) {
  if (!can("platform.finance.write") || risk.status === "resolved") return "—";
  const actions = [];
  if (risk.status === "open") actions.push(`<button class="btn" type="button" data-finance-risk-action="acknowledge" data-finance-risk-id="${escapeHtml(risk.id)}">Akui</button>`);
  if (state.platformRole === "platform_owner") actions.push(`<button class="btn primary" type="button" data-finance-risk-action="resolve" data-finance-risk-id="${escapeHtml(risk.id)}">Selesaikan</button>`);
  return actions.length ? `<div class="payout-row-actions">${actions.join("")}</div>` : "—";
}

function syncFinanceRiskFilters() {
  const select = $("#finance-risk-booth");
  const previous = select.value;
  select.innerHTML = `<option value="">Semua photobox</option>${state.machines.map(machine => `<option value="${escapeHtml(machine.boothCode)}">${escapeHtml(machine.name)} · ${escapeHtml(machine.boothCode)}</option>`).join("")}`;
  if (!previous || state.machines.some(machine => machine.boothCode === previous)) select.value = previous;
  for (const id of ["#finance-risk-booth", "#finance-risk-status-filter", "#finance-risk-severity-filter"]) $(id).disabled = state.financeRiskLoading;
}

function renderFinanceRisks(result) {
  state.financeRisks = Array.isArray(result.records) ? result.records : [];
  state.financeRiskSummary = result.summary || {};
  $("#finance-risk-open").textContent = Number(state.financeRiskSummary.open || 0).toLocaleString("id-ID");
  $("#finance-risk-critical").textContent = Number(state.financeRiskSummary.critical || 0).toLocaleString("id-ID");
  $("#finance-risk-acknowledged").textContent = Number(state.financeRiskSummary.acknowledged || 0).toLocaleString("id-ID");
  $("#finance-risk-resolved").textContent = Number(state.financeRiskSummary.resolved || 0).toLocaleString("id-ID");
  $("#finance-risk-rows").innerHTML = state.financeRisks.length ? state.financeRisks.map(risk => {
    const severity = financeRiskLabel(risk.severity);
    const status = financeRiskStatus(risk.status);
    return `<tr><td>${escapeHtml(formatTime(risk.lastSeenAt))}<br><small>Pertama ${escapeHtml(formatTime(risk.firstSeenAt))}</small></td><td><b>${escapeHtml(risk.rule.replaceAll("_", " "))}</b><br><small>${escapeHtml(risk.boothCode || "Platform")}</small></td><td><b>${escapeHtml(risk.title)}</b><br><small>${escapeHtml(risk.description || "—")}</small>${risk.reviewNote ? `<br><small>Review: ${escapeHtml(risk.reviewNote)}</small>` : ""}</td><td><span class="pill ${severity.className}">${severity.label}</span></td><td><span class="pill ${status.className}">${status.label}</span></td><td>${Number(risk.occurrenceCount || 1).toLocaleString("id-ID")}</td><td>${financeRiskActions(risk)}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Tidak ada kasus risiko yang cocok dengan filter.</td></tr>';
  syncFinanceRiskFilters();
  setStatus("#finance-risk-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderFinanceRisksError(error) {
  $("#finance-risk-rows").innerHTML = '<tr><td colspan="7" class="empty">Kasus risiko tidak dapat dimuat. Gunakan Perbarui risiko untuk mencoba lagi.</td></tr>';
  setStatus("#finance-risk-status", error.message || "Gagal memuat risiko finance");
}

async function refreshFinanceRisks() {
  if (state.financeRiskLoading || !can("platform.finance.read")) return;
  state.financeRiskLoading = true;
  $("#finance-risk-retry").disabled = true;
  syncFinanceRiskFilters();
  setStatus("#finance-risk-status", "Memuat kasus risiko…");
  try {
    const query = new URLSearchParams({ limit: "200" });
    if ($("#finance-risk-booth").value) query.set("boothCode", $("#finance-risk-booth").value);
    if ($("#finance-risk-status-filter").value) query.set("status", $("#finance-risk-status-filter").value);
    if ($("#finance-risk-severity-filter").value) query.set("severity", $("#finance-risk-severity-filter").value);
    renderFinanceRisks(await api(`finance_risk&${query}`));
  } catch (error) { renderFinanceRisksError(error); }
  finally { state.financeRiskLoading = false; $("#finance-risk-retry").disabled = false; syncFinanceRiskFilters(); }
}

async function sha256File(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadPayoutProof(payoutId, file) {
  const checksumSha256 = await sha256File(file);
  const prepared = await api("finance_payout", { method: "POST", body: JSON.stringify({ operation: "proof_prepare", id: payoutId, filename: file.name, contentType: file.type || "application/pdf", size: file.size, checksumSha256 }) });
  const response = await fetch(prepared.upload.url, { method: prepared.upload.method || "PUT", headers: prepared.upload.headers || {}, body: file });
  if (!response.ok) throw new Error(`Upload bukti gagal (${response.status})`);
  return api("finance_payout", { method: "POST", body: JSON.stringify({ operation: "proof_finalize", uploadId: prepared.uploadId }) });
}

function syncLedgerReconciliationForm() {
  const select = $("#finance-ledger-reconciliation-booth");
  const previous = select.value;
  select.innerHTML = state.machines.length
    ? state.machines.map(machine => `<option value="${escapeHtml(machine.boothCode)}">${escapeHtml(machine.name)} · ${escapeHtml(machine.boothCode)}</option>`).join("")
    : '<option value="">Belum ada photobox</option>';
  if (state.machines.some(machine => machine.boothCode === previous)) select.value = previous;
  const disabled = state.ledgerReconciliationLoading || !state.machines.length || !can("platform.finance.write");
  select.disabled = disabled;
  $("#finance-ledger-reconciliation-provider").disabled = disabled;
  $("#finance-ledger-reconciliation-reference").disabled = disabled;
  $("#finance-ledger-reconciliation-file").disabled = disabled;
  $("#finance-ledger-reconciliation-confirm").disabled = disabled;
  $("#finance-ledger-reconciliation-submit").disabled = disabled;
}

function renderLedgerReconciliationRuns(result) {
  state.ledgerReconciliationRuns = Array.isArray(result.runs) ? result.runs : [];
  const latest = state.ledgerReconciliationRuns[0] || {};
  $("#finance-ledger-reconciliation-matched").textContent = Number(latest.matchedCount || 0).toLocaleString("id-ID");
  $("#finance-ledger-reconciliation-mismatch").textContent = Number(latest.mismatchCount || 0).toLocaleString("id-ID");
  $("#finance-ledger-reconciliation-gross").textContent = formatCurrency(latest.grossDifference || 0, latest.currency || "IDR");
  $("#finance-ledger-reconciliation-fee").textContent = formatCurrency(latest.providerFeeDifference || 0, latest.currency || "IDR");
  $("#finance-ledger-reconciliation-rows").innerHTML = state.ledgerReconciliationRuns.length ? state.ledgerReconciliationRuns.map(run => {
    const status = run.zeroDifference ? { label: "COCOK", className: "" } : { label: "PERLU DIPERIKSA", className: "warn" };
    return `<tr><td>${escapeHtml(formatTime(run.createdAt))}<br><small>${escapeHtml(run.createdBy || "finance")}</small></td><td>${escapeHtml(run.boothCode)}</td><td><b>${escapeHtml(run.reference)}</b></td><td>${escapeHtml(String(run.provider || "—").toUpperCase())}</td><td>${Number(run.matchedCount || 0).toLocaleString("id-ID")}</td><td>${Number(run.mismatchCount || 0).toLocaleString("id-ID")}</td><td>${escapeHtml(formatCurrency(run.grossDifference || 0, run.currency))}<br><small>Biaya ${escapeHtml(formatCurrency(run.providerFeeDifference || 0, run.currency))}</small></td><td><span class="pill ${status.className}">${status.label}</span></td></tr>`;
  }).join("") : '<tr><td colspan="8" class="empty">Belum ada run rekonsiliasi. Impor laporan CSV pertama untuk mulai membandingkan.</td></tr>';
  syncLedgerReconciliationForm();
  setStatus("#finance-ledger-reconciliation-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderLedgerReconciliationError(error) {
  $("#finance-ledger-reconciliation-rows").innerHTML = '<tr><td colspan="8" class="empty">Riwayat rekonsiliasi tidak dapat dimuat. Gunakan Perbarui riwayat untuk mencoba lagi.</td></tr>';
  setStatus("#finance-ledger-reconciliation-status", error.message || "Gagal memuat rekonsiliasi ledger");
}

async function refreshLedgerReconciliationRuns() {
  if (state.ledgerReconciliationLoading || !can("platform.finance.read")) return;
  state.ledgerReconciliationLoading = true;
  $("#finance-ledger-reconciliation-retry").disabled = true;
  syncLedgerReconciliationForm();
  setStatus("#finance-ledger-reconciliation-status", "Memuat riwayat rekonsiliasi…");
  try { renderLedgerReconciliationRuns(await api("finance_ledger_reconciliation&limit=25")); }
  catch (error) { renderLedgerReconciliationError(error); }
  finally {
    state.ledgerReconciliationLoading = false;
    $("#finance-ledger-reconciliation-retry").disabled = false;
    syncLedgerReconciliationForm();
  }
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') { current += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { values.push(current.trim()); current = ""; }
    else current += character;
  }
  if (quoted) throw new Error("CSV memiliki tanda kutip yang belum ditutup");
  values.push(current.trim());
  return values;
}

function parseProviderCsv(content) {
  const lines = String(content || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error("CSV harus memiliki header dan minimal satu transaksi");
  const headers = parseCsvLine(lines[0]).map(header => header.trim().toLowerCase().replace(/[ -]+/g, "_"));
  const aliases = {
    providerPaymentId: ["provider_payment_id", "payment_request_id", "payment_id"],
    gross: ["gross", "amount", "request_amount"],
    providerFee: ["provider_fee", "fee"],
    status: ["status", "payment_status"],
  };
  const indexes = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, names.map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1]));
  const missing = Object.entries(indexes).filter(([, index]) => index < 0).map(([key]) => key);
  if (missing.length) throw new Error(`Header CSV belum lengkap: ${missing.join(", ")}`);
  if (lines.length > 501) throw new Error("Satu run maksimal 500 transaksi");
  return lines.slice(1).map((line, rowIndex) => {
    const values = parseCsvLine(line);
    const gross = Number(values[indexes.gross]);
    const providerFee = Number(values[indexes.providerFee]);
    if (!Number.isSafeInteger(gross) || gross < 0 || !Number.isSafeInteger(providerFee) || providerFee < 0) throw new Error(`Nominal pada baris ${rowIndex + 2} tidak valid`);
    return {
      providerPaymentId: values[indexes.providerPaymentId], gross, providerFee,
      status: String(values[indexes.status] || "").toLowerCase(),
    };
  });
}

function currentTarget() {
  return $("#flag-scope").value === "global" ? "" : $("#flag-target").value;
}

function currentOverride() {
  return state.overrides.find(item => item.key === $("#flag-key").value && item.scope === $("#flag-scope").value && (item.targetId || "") === currentTarget());
}

function renderTargets() {
  const scope = $("#flag-scope").value;
  const wrap = $("#flag-target-wrap");
  wrap.hidden = scope === "global";
  let targets = [];
  if (scope === "booth") targets = state.machines.map(machine => ({ id: machine.boothCode, label: `${machine.name} · ${machine.boothCode}` }));
  if (scope === "organization") {
    const ids = [...new Set(state.machines.map(machine => machine.organizationId).filter(Boolean))];
    targets = ids.map(id => ({ id, label: id }));
  }
  $("#flag-target").innerHTML = targets.length ? targets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("") : '<option value="">Belum tersedia</option>';
  $("#flag-target").disabled = scope !== "global" && !targets.length;
  syncFlagForm();
}

function syncFlagForm() {
  const override = currentOverride();
  if (override) $("#flag-enabled").value = String(override.enabled);
  $("#flag-delete").disabled = !can("platform.flags.write") || state.loading || !override;
  $("#flag-save").disabled = !can("platform.flags.write") || state.loading || ($("#flag-scope").value !== "global" && !currentTarget());
}

function renderFlags() {
  const labels = Object.fromEntries(state.definitions.map(item => [item.key, item.label]));
  $("#flag-key").innerHTML = state.definitions.map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.label)}</option>`).join("");
  $("#flag-rows").innerHTML = state.overrides.length ? state.overrides.map(item => `<tr>
    <td><b>${escapeHtml(labels[item.key] || item.key)}</b><br><small>${escapeHtml(item.key)}</small></td>
    <td>${escapeHtml(item.scope)}</td><td>${escapeHtml(item.targetId || "Semua")}</td>
    <td><span class="pill ${item.enabled ? "" : "off"}">${item.enabled ? "AKTIF" : "NONAKTIF"}</span></td>
    <td>${item.updatedAt ? new Date(item.updatedAt).toLocaleString("id-ID") : "—"}</td>
  </tr>`).join("") : '<tr><td colspan="5" class="empty">Belum ada override. Semua fitur memakai nilai bawaan.</td></tr>';
  renderTargets();
}

function renderOverview(machines, resetRequests) {
  state.machines = machines;
  syncTelemetryTargets();
  syncRemoteJobForm();
  syncLedgerReconciliationForm();
  $("#metric-total").textContent = machines.length;
  $("#metric-online").textContent = machines.filter(machine => machine.health?.state === "ready").length;
  $("#metric-disabled").textContent = machines.filter(machine => !machine.enabled).length;
  $("#metric-reset").textContent = resetRequests.filter(request => request.status === "pending").length;
  $("#machine-rows").innerHTML = machines.length ? machines.map(machine => {
    const health = healthLabel(machine.health?.state);
    const controllerOnline = machine.controllerState === "online";
    const memory = machine.telemetry?.memory;
    const disk = machine.telemetry?.disk;
    const usedMemory = memory?.totalBytes && memory?.availableBytes ? Math.max(0, memory.totalBytes - memory.availableBytes) : 0;
    const system = `${usedMemory ? `${formatBytes(usedMemory)} / ${formatBytes(memory.totalBytes)} RAM` : "RAM —"}<br><small>${disk?.freeBytes ? `${formatBytes(disk.freeBytes)} disk kosong` : "Disk —"}</small>`;
    const backup = machine.telemetry?.backup;
    const backupClass = backup?.status === "ready" ? "" : backup?.status === "missing" ? "warn" : "off";
    const backupLabel = backup?.status === "ready" ? "SIAP" : backup?.status === "missing" ? "BELUM ADA" : "TIDAK TERSEDIA";
    const backupDetail = backup?.latestAt ? `${formatTime(backup.latestAt)} · ${Number(backup.count || 0)} salinan` : "Belum ada backup terverifikasi";
    const restoreDetail = backup?.restoreStatus === "completed" ? `Restore selesai ${formatTime(backup.restoreAt)}` : backup?.restoreStatus === "failed" ? `Restore gagal ${formatTime(backup.restoreAt)}` : "Restore belum pernah";
    const update = machine.update || {};
    const updateState = update.state || "unknown";
    const updateClass = ["current", "restart-required", "rolled-back"].includes(updateState) ? "" : updateState === "ready" ? "warn" : ["failed", "unavailable"].includes(updateState) ? "off" : "warn";
    const updateLabel = ({ current: "TERBARU", ready: "TERSEDIA", checking: "MEMERIKSA", downloading: "MENGUNDUH", installing: "MEMASANG", "restart-required": "RESTART", "rolled-back": "DIPULIHKAN", failed: "GAGAL", unavailable: "OFFLINE" })[updateState] || "BELUM ADA";
    const updateDetail = update.availableVersion ? `${update.currentVersion || machine.agentVersion || "—"} → ${update.availableVersion}` : update.currentVersion || machine.agentVersion || "—";
    const accessControl = can("platform.access.write") ? `<button class="btn ${machine.enabled ? "danger" : ""}" data-machine="${escapeHtml(machine.machineId)}" data-enabled="${!machine.enabled}">${machine.enabled ? "Matikan" : "Aktifkan"}</button>` : `<span class="pill ${machine.enabled ? "" : "off"}">${machine.enabled ? "AKTIF" : "NONAKTIF"}</span>`;
    return `<tr><td><b>${escapeHtml(machine.name)}</b><br><small>${escapeHtml(machine.location || "Lokasi belum diisi")} · /${escapeHtml(machine.boothCode)}</small></td><td><span class="pill ${health.className}">${health.label}</span></td><td><span class="pill ${controllerOnline ? "" : "off"}">${controllerOnline ? "ONLINE" : "OFFLINE"}</span></td><td>${escapeHtml(formatTime(machine.lastSeenAt))}</td><td>${system}</td><td><span class="pill ${backupClass}">${backupLabel}</span><br><small>${escapeHtml(backupDetail)}<br>${escapeHtml(restoreDetail)}</small></td><td><span class="pill ${updateClass}">${updateLabel}</span><br><small>${escapeHtml(updateDetail)}<br>${escapeHtml(machine.platform || machine.agentState || "—")}</small></td><td>${accessControl}</td><td><a class="btn" href="/${escapeHtml(machine.boothCode)}/admin">Admin</a></td></tr>`;
  }).join("") : '<tr><td colspan="9" class="empty">Belum ada mesin.</td></tr>';
  const memberships = machines.flatMap(machine => (Array.isArray(machine.members) ? machine.members : []).map(member => ({ ...member, boothCode: machine.boothCode, boothName: machine.name })));
  $("#member-rows").innerHTML = memberships.length ? memberships.map(member => {
    const transfer = can("platform.ownership.write") && member.active && member.role !== "owner"
      ? `<button class="btn" type="button" data-transfer-owner="${escapeHtml(member.id)}" data-booth-code="${escapeHtml(member.boothCode)}" data-member-name="${escapeHtml(member.name || member.email)}">Jadikan owner</button>`
      : "—";
    return `<tr><td><b>${escapeHtml(member.boothName)}</b><br><small>/${escapeHtml(member.boothCode)}</small></td><td>${escapeHtml(member.name || "—")}</td><td>${escapeHtml(member.email || "—")}</td><td><span class="pill ${member.role === "owner" ? "" : "warn"}">${escapeHtml(String(member.role || "operator").toUpperCase())}</span></td><td><span class="pill ${member.active ? "" : "off"}">${member.active ? "AKTIF" : "NONAKTIF"}</span></td><td>${escapeHtml(formatTime(member.createdAt))}</td><td>${transfer}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada owner atau pengguna yang terindeks.</td></tr>';
  $("#reset-rows").innerHTML = resetRequests.length ? resetRequests.map(request => `<tr><td>${escapeHtml(request.email)}</td><td>${escapeHtml(request.boothCode)}</td><td>${new Date(request.createdAt).toLocaleString("id-ID")}</td><td>${request.status === "pending" && can("platform.recovery.write") ? `<button class="btn" data-reset="${escapeHtml(request.id)}">Tandai email terkirim</button>` : `<span class="pill ${request.status === "pending" ? "warn" : ""}">${request.status === "pending" ? "MENUNGGU" : "EMAIL TERKIRIM"}</span>`}</td></tr>`).join("") : '<tr><td colspan="4" class="empty">Tidak ada permintaan.</td></tr>';
}

function syncTelemetryTargets() {
  const select = $("#telemetry-machine");
  const previous = select.value;
  select.innerHTML = state.machines.length ? state.machines.map(machine => `<option value="${escapeHtml(machine.machineId)}">${escapeHtml(machine.name)} · /${escapeHtml(machine.boothCode)}</option>`).join("") : '<option value="">Belum ada mesin</option>';
  if (state.machines.some(machine => machine.machineId === previous)) select.value = previous;
  select.disabled = state.telemetryLoading || !state.machines.length;
  $("#telemetry-range").disabled = state.telemetryLoading || !state.machines.length;
  $("#telemetry-history-retry").disabled = state.telemetryLoading || !state.machines.length;
}

function telemetryPoints(records, metric) {
  const width = 700;
  const height = 180;
  const denominator = Math.max(1, records.length - 1);
  return records.map((record, index) => {
    const value = Number(record[metric]?.freePercent);
    if (!Number.isFinite(value)) return null;
    return `${(index / denominator * width).toFixed(1)},${(height - Math.max(0, Math.min(100, value)) / 100 * height).toFixed(1)}`;
  }).filter(Boolean);
}

function renderTelemetryHistory(result) {
  state.telemetryHistory = result;
  const records = Array.isArray(result.records) ? result.records : [];
  const summary = result.summary || {};
  const machine = result.machine?.name || "Photobox";
  $("#telemetry-history-summary").textContent = `${machine} · ${summary.samples || 0} snapshot · ${result.rangeHours || 24} jam`;
  if (!records.length) {
    $("#telemetry-chart").innerHTML = '<div class="empty">Belum ada snapshot pada rentang ini. Agent akan menambahkan data maksimal setiap 5 menit.</div>';
    $("#telemetry-chart").setAttribute("aria-label", `Belum ada histori telemetry untuk ${machine}`);
    return setStatus("#telemetry-history-status", "Belum ada data. Heartbeat Agent tetap berjalan tanpa menunggu halaman ini.");
  }
  const disk = telemetryPoints(records, "disk");
  const memory = telemetryPoints(records, "memory");
  const grid = [0, 25, 50, 75, 100].map(value => `<line class="grid-line" x1="0" y1="${180 - value * 1.8}" x2="700" y2="${180 - value * 1.8}"></line><text class="axis-label" x="706" y="${184 - value * 1.8}">${value}%</text>`).join("");
  const diskDot = disk.length ? disk.at(-1).split(",") : null;
  const memoryDot = memory.length ? memory.at(-1).split(",") : null;
  $("#telemetry-chart").innerHTML = `<svg viewBox="0 0 750 205" aria-hidden="true"><g transform="translate(8 8)">${grid}${disk.length > 1 ? `<polyline class="disk-line" points="${disk.join(" ")}"></polyline>` : ""}${memory.length > 1 ? `<polyline class="memory-line" points="${memory.join(" ")}"></polyline>` : ""}${diskDot ? `<circle class="latest-dot disk" cx="${diskDot[0]}" cy="${diskDot[1]}" r="5"></circle>` : ""}${memoryDot ? `<circle class="latest-dot memory" cx="${memoryDot[0]}" cy="${memoryDot[1]}" r="5"></circle>` : ""}</g></svg>`;
  $("#telemetry-chart").setAttribute("aria-label", `${machine}: disk kosong ${summary.latestDiskFreePercent ?? "tidak tersedia"} persen, RAM tersedia ${summary.latestMemoryAvailablePercent ?? "tidak tersedia"} persen, ${records.length} snapshot`);
  setStatus("#telemetry-history-status", `Terakhir ${formatTime(summary.latestAt)} · rata-rata disk ${summary.averageDiskFreePercent ?? "—"}% · RAM ${summary.averageMemoryAvailablePercent ?? "—"}%`, true);
}

function renderTelemetryHistoryError(error) {
  $("#telemetry-history-summary").textContent = "Histori kesehatan belum dapat dimuat.";
  $("#telemetry-chart").innerHTML = '<div class="empty">Data histori tidak tersedia. Gunakan Perbarui untuk mencoba lagi.</div>';
  $("#telemetry-chart").setAttribute("aria-label", "Histori telemetry gagal dimuat");
  setStatus("#telemetry-history-status", error.message || "Gagal memuat histori telemetry");
}

async function refreshTelemetryHistory() {
  if (state.telemetryLoading || !$("#telemetry-machine").value) return;
  state.telemetryLoading = true;
  syncTelemetryTargets();
  setStatus("#telemetry-history-status", "Memuat histori telemetry…");
  try {
    const machineId = encodeURIComponent($("#telemetry-machine").value);
    const hours = encodeURIComponent($("#telemetry-range").value);
    renderTelemetryHistory(await api(`telemetry_history&machineId=${machineId}&hours=${hours}&limit=2016`));
  } catch (error) { renderTelemetryHistoryError(error); }
  finally { state.telemetryLoading = false; syncTelemetryTargets(); }
}

function syncRemoteJobForm() {
  const select = $("#remote-job-machine");
  const previous = select.value;
  const available = state.machines.filter(machine => machine.enabled !== false);
  select.innerHTML = available.length ? available.map(machine => `<option value="${escapeHtml(machine.machineId)}">${escapeHtml(machine.name)} · /${escapeHtml(machine.boothCode)}${machine.online ? "" : " · offline"}</option>`).join("") : '<option value="">Tidak ada mesin aktif</option>';
  if (available.some(machine => machine.machineId === previous)) select.value = previous;
  select.disabled = state.remoteJobSending || !available.length;
  $("#remote-job-type").disabled = state.remoteJobSending || !available.length;
  $("#remote-job-send").disabled = !can("platform.remote_jobs.write") || state.remoteJobSending || !available.length;
}

function renderAudit(records) {
  state.audits = records;
  $("#audit-rows").innerHTML = records.length ? records.map(record => `<tr><td>${escapeHtml(formatTime(record.createdAt))}</td><td>${escapeHtml(record.actorId || record.actorRole || "system")}<br><small>${escapeHtml(record.actorRole || "")}</small></td><td>${escapeHtml(record.boothCode || "platform")}</td><td><b>${escapeHtml(record.action || "—")}</b><br><small>${escapeHtml(record.correlationId || "")}</small></td><td>${escapeHtml(record.target || "—")}</td></tr>`).join("") : '<tr><td colspan="5" class="empty">Belum ada aktivitas sensitif yang tercatat.</td></tr>';
  setStatus("#audit-status", `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`, true);
}

function renderAuditError(error) {
  $("#audit-rows").innerHTML = '<tr><td colspan="5" class="empty">Audit log tidak tersedia. Gunakan Perbarui log untuk mencoba lagi.</td></tr>';
  setStatus("#audit-status", error.message || "Gagal memuat audit log");
}

async function refreshAudit() {
  if (state.auditLoading) return;
  state.auditLoading = true;
  $("#audit-retry").disabled = true;
  setStatus("#audit-status", "Memuat audit log…");
  try { renderAudit((await api("audit")).records || []); }
  catch (error) { renderAuditError(error); }
  finally { state.auditLoading = false; $("#audit-retry").disabled = false; }
}

function renderFleetHealth(health) {
  state.health = health;
  const summary = health.summary || {};
  $("#metric-alert").textContent = summary.activeIncidents || 0;
  $("#fleet-health-summary").textContent = `${summary.ready || 0} siap · ${summary.delayed || 0} terlambat · ${summary.offline || 0} offline`;
  const incidents = Array.isArray(health.incidents) ? health.incidents : [];
  $("#incident-rows").innerHTML = incidents.length ? incidents.map(incident => {
    const open = incident.status === "open";
    const status = incident.status === "resolved" ? "PULIH" : incident.status === "acknowledged" ? "DIAKUI" : "BARU";
    const statusClass = incident.status === "resolved" ? "" : incident.status === "acknowledged" ? "warn" : "off";
    return `<tr><td><b>${escapeHtml(incident.machineName)}</b><br><small>/${escapeHtml(incident.boothCode || "—")}</small></td><td>Agent offline<br><small>Heartbeat terakhir: ${escapeHtml(formatTime(incident.lastSeenAt))}</small></td><td>${escapeHtml(formatTime(incident.openedAt))}</td><td><span class="pill ${statusClass}">${status}</span></td><td>${open && can("platform.fleet.write") ? `<button class="btn" data-incident="${escapeHtml(incident.id)}">Akui</button>` : "—"}</td></tr>`;
  }).join("") : '<tr><td colspan="5" class="empty">Tidak ada insiden. Semua heartbeat yang diterima berada dalam batas aman.</td></tr>';
  setStatus("#health-status", `Diperiksa ${formatTime(health.checkedAt)}`, true);
}

function renderFleetHealthError(error) {
  $("#fleet-health-summary").textContent = "Status fleet belum dapat diperiksa.";
  $("#incident-rows").innerHTML = '<tr><td colspan="5" class="empty">Data insiden tidak tersedia. Gunakan Periksa sekarang untuk mencoba lagi.</td></tr>';
  setStatus("#health-status", error.message || "Gagal memeriksa fleet");
}

async function refreshFleetHealth() {
  if (state.healthLoading) return;
  state.healthLoading = true;
  $("#health-retry").disabled = true;
  setStatus("#health-status", "Memeriksa heartbeat Agent…");
  try { renderFleetHealth(await api("fleet_health")); }
  catch (error) { renderFleetHealthError(error); }
  finally { state.healthLoading = false; $("#health-retry").disabled = false; }
}

function alertDeliveryStatus(value) {
  if (value === "delivered") return { label: "TERKIRIM", className: "" };
  if (value === "failed") return { label: "GAGAL", className: "off" };
  if (value === "waiting_configuration") return { label: "BUTUH PROVIDER", className: "warn" };
  if (value === "retry") return { label: "COBA LAGI", className: "warn" };
  return { label: "MENUNGGU", className: "warn" };
}

function renderAlertRouting(result) {
  state.alertDeliveries = Array.isArray(result.deliveries) ? result.deliveries : [];
  const summary = result.summary || {
    queued: state.alertDeliveries.filter(item => ["queued", "retry", "waiting_configuration"].includes(item.status)).length,
    delivered: state.alertDeliveries.filter(item => item.status === "delivered").length,
    failed: state.alertDeliveries.filter(item => item.status === "failed").length,
  };
  $("#alert-routing-summary").textContent = `${summary.queued || 0} menunggu · ${summary.delivered || 0} terkirim · ${summary.failed || 0} gagal`;
  $("#alert-routing-rows").innerHTML = state.alertDeliveries.length ? state.alertDeliveries.map(delivery => {
    const status = alertDeliveryStatus(delivery.status);
    const eventLabel = delivery.eventType === "fleet.incident.resolved" ? "Agent pulih" : "Agent offline";
    const retryable = ["failed", "retry", "waiting_configuration"].includes(delivery.status) && can("platform.fleet.write");
    return `<tr><td>${escapeHtml(formatTime(delivery.createdAt))}</td><td><b>${escapeHtml(eventLabel)}</b><br><small>${escapeHtml(delivery.eventType)}</small></td><td><b>${escapeHtml(delivery.machineName)}</b><br><small>/${escapeHtml(delivery.boothCode || "—")}</small></td><td><span class="pill ${status.className}">${status.label}</span></td><td>${escapeHtml(delivery.attempts)}</td><td>${escapeHtml(delivery.lastError || "—")}</td><td>${retryable ? `<button class="btn" type="button" data-retry-alert="${escapeHtml(delivery.id)}">Coba lagi</button>` : "—"}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada delivery alert. Insiden Agent offline akan masuk otomatis.</td></tr>';
  setStatus("#alert-routing-status", `Diperbarui ${formatTime(result.checkedAt || new Date().toISOString())}`, true);
  $("#alert-routing-process").disabled = state.alertProcessing || !can("platform.fleet.write");
}

function renderAlertRoutingError(error) {
  $("#alert-routing-summary").textContent = "Antrean alert belum dapat diperiksa.";
  $("#alert-routing-rows").innerHTML = '<tr><td colspan="7" class="empty">Delivery alert tidak tersedia. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#alert-routing-status", error.message || "Gagal memuat routing alert");
}

async function refreshAlertRouting() {
  if (state.alertLoading) return;
  state.alertLoading = true;
  $("#alert-routing-retry").disabled = true;
  setStatus("#alert-routing-status", "Memuat antrean alert…");
  try { renderAlertRouting(await api("alert_routing")); }
  catch (error) { renderAlertRoutingError(error); }
  finally { state.alertLoading = false; $("#alert-routing-retry").disabled = false; }
}

async function processAlertRouting() {
  if (state.alertProcessing || !can("platform.fleet.write")) return;
  state.alertProcessing = true;
  $("#alert-routing-process").disabled = true;
  setStatus("#alert-routing-status", "Mengirim delivery yang sudah jatuh tempo…");
  try {
    const response = await api("alert_routing", { method: "POST", body: JSON.stringify({ operation: "process", limit: 10 }) });
    await refreshAlertRouting();
    const result = response.result || {};
    setStatus("#alert-routing-status", `${result.delivered || 0} terkirim · ${result.retrying || 0} dijadwalkan ulang · ${result.waiting || 0} menunggu provider`, !result.failed);
  } catch (error) { setStatus("#alert-routing-status", error.message); }
  finally { state.alertProcessing = false; $("#alert-routing-process").disabled = !can("platform.fleet.write"); }
}

function backendStateLabel(stateValue) {
  if (stateValue === "ready") return { label: "SIAP", className: "" };
  if (stateValue === "disabled") return { label: "NONAKTIF", className: "warn" };
  return { label: "PERLU DIPERIKSA", className: "off" };
}

function renderBackendHealth(result) {
  state.backendHealth = result;
  for (const [key, value] of [["cache", result.cache], ["database", result.database]]) {
    const status = backendStateLabel(value?.state);
    $(`#backend-${key}-state`).innerHTML = `<span class="pill ${status.className}">${status.label}</span>`;
    $(`#backend-${key}-detail`).textContent = `${value?.message || "Status tidak tersedia"}${Number.isFinite(value?.latencyMs) ? ` · ${value.latencyMs} ms` : ""}`;
  }
  const providers = Array.isArray(result.providers) ? result.providers : [];
  $("#backend-provider-list").innerHTML = providers.length ? providers.map(provider => {
    const status = provider.state === "ready" ? { label: "SIAP", className: "" } : provider.state === "standby" ? { label: "SIAGA", className: "warn" } : provider.configured ? { label: "PERLU DIPERIKSA", className: "off" } : { label: "BELUM DIATUR", className: "off" };
    const detail = `${provider.message || provider.kind}${Number.isFinite(provider.latencyMs) ? ` · ${provider.latencyMs} ms` : ""}`;
    return `<div class="provider-health-row"><span><b>${escapeHtml(provider.label)}</b><small>${escapeHtml(detail)}</small></span><span class="pill ${status.className}">${status.label}</span></div>`;
  }).join("") : '<p class="empty">Belum ada adapter provider pada registry.</p>';
  setStatus("#backend-health-status", `Diperiksa ${formatTime(result.checkedAt)}`, result.cache?.state === "ready");
}

function renderBackendHealthError(error) {
  $("#backend-cache-state").textContent = "Tidak tersedia";
  $("#backend-database-state").textContent = "Tidak tersedia";
  $("#backend-provider-list").innerHTML = '<p class="empty">Status backend tidak dapat dimuat. Coba periksa lagi.</p>';
  setStatus("#backend-health-status", error.message || "Gagal memeriksa backend");
}

async function refreshBackendHealth() {
  if (state.backendHealthLoading) return;
  state.backendHealthLoading = true;
  $("#backend-health-retry").disabled = true;
  setStatus("#backend-health-status", "Memeriksa backend…");
  try { renderBackendHealth(await api("backend_health")); }
  catch (error) { renderBackendHealthError(error); }
  finally { state.backendHealthLoading = false; $("#backend-health-retry").disabled = false; }
}

function webhookEventStatus(value) {
  if (value === "succeeded") return { label: "BERHASIL", className: "" };
  if (value === "duplicate") return { label: "DUPLIKAT", className: "warn" };
  if (value === "received") return { label: "DITERIMA", className: "warn" };
  return { label: "GAGAL", className: "off" };
}

function renderWebhookEvents(result) {
  state.webhookEvents = Array.isArray(result.records) ? result.records : [];
  const summary = result.summary || {};
  $("#webhook-summary-total").textContent = summary.total || 0;
  $("#webhook-summary-succeeded").textContent = summary.succeeded || 0;
  $("#webhook-summary-failed").textContent = summary.failed || 0;
  $("#webhook-summary-duplicate").textContent = summary.duplicate || 0;
  $("#webhook-event-rows").innerHTML = state.webhookEvents.length ? state.webhookEvents.map(event => {
    const status = webhookEventStatus(event.state);
    return `<tr><td>${escapeHtml(formatTime(event.receivedAt))}<br><small>${escapeHtml(event.providerEventRef || "—")}</small></td><td><b>${escapeHtml(event.provider)}</b><br><small>${escapeHtml(event.eventType)}</small></td><td>${escapeHtml(event.boothCode || "Belum teridentifikasi")}</td><td>${escapeHtml(event.paymentId || "—")}</td><td><span class="pill ${status.className}">${status.label}</span><br><small>HTTP ${escapeHtml(event.httpStatus || "—")}</small></td><td>${escapeHtml(event.latencyMs)} ms</td><td>${escapeHtml(event.error || "—")}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada delivery webhook pembayaran yang tercatat.</td></tr>';
  setStatus("#webhook-events-status", `Diperbarui ${formatTime(result.checkedAt)}`, !(summary.failed > 0));
}

function renderWebhookEventsError(error) {
  $("#webhook-event-rows").innerHTML = '<tr><td colspan="7" class="empty">Log webhook tidak tersedia. Tekan Perbarui log untuk mencoba lagi.</td></tr>';
  setStatus("#webhook-events-status", error.message || "Gagal memuat log webhook");
}

async function refreshWebhookEvents() {
  if (state.webhookEventsLoading || !can("platform.finance.read")) return;
  state.webhookEventsLoading = true;
  $("#webhook-events-retry").disabled = true;
  setStatus("#webhook-events-status", "Memuat log webhook…");
  try { renderWebhookEvents(await api("webhook_events&limit=100")); }
  catch (error) { renderWebhookEventsError(error); }
  finally { state.webhookEventsLoading = false; $("#webhook-events-retry").disabled = false; }
}

function remoteJobStatus(value) {
  if (value === "completed") return { label: "SELESAI", className: "" };
  if (["queued", "claimed", "running"].includes(value)) return { label: value === "queued" ? "MENUNGGU" : "BERJALAN", className: "warn" };
  return { label: value === "expired" ? "KEDALUWARSA" : "GAGAL", className: "off" };
}

function remoteJobLabel(value) {
  return ({ "devices.refresh": "Periksa perangkat", "service.restart": "Restart Controller", "agent.update.check": "Periksa update Agent", "agent.update.apply": "Pasang update Agent", "agent.update.rollback": "Rollback Agent" })[value] || value;
}

function renderRemoteJobs(result) {
  state.remoteJobs = Array.isArray(result.jobs) ? result.jobs : [];
  const summary = result.summary || {};
  $("#remote-jobs-summary").textContent = `${summary.queued || 0} menunggu · ${summary.active || 0} berjalan · ${summary.failed || 0} gagal · ${summary.completed || 0} selesai`;
  $("#remote-job-rows").innerHTML = state.remoteJobs.length ? state.remoteJobs.map(job => {
    const status = remoteJobStatus(job.status);
    return `<tr><td>${escapeHtml(formatTime(job.createdAt))}</td><td><b>${escapeHtml(job.machineName)}</b><br><small>/${escapeHtml(job.boothCode || "—")}</small></td><td>${escapeHtml(remoteJobLabel(job.type))}${job.retryOf ? `<br><small>Retry dari ${escapeHtml(job.retryOf)}</small>` : ""}</td><td><span class="pill ${status.className}">${status.label}</span></td><td>${escapeHtml(job.attempts)}</td><td>${escapeHtml(job.error || "—")}</td><td>${job.retryable && can("platform.remote_jobs.write") ? `<button class="btn" data-retry-job="${escapeHtml(job.id)}">Coba lagi</button>` : "—"}</td></tr>`;
  }).join("") : '<tr><td colspan="7" class="empty">Belum ada perintah hardware yang tercatat.</td></tr>';
  setStatus("#remote-jobs-status", `Diperbarui ${formatTime(result.checkedAt)}`, true);
}

function renderRemoteJobsError(error) {
  $("#remote-jobs-summary").textContent = "Antrean remote belum dapat diperiksa.";
  $("#remote-job-rows").innerHTML = '<tr><td colspan="7" class="empty">Data antrean tidak tersedia. Gunakan Perbarui antrean untuk mencoba lagi.</td></tr>';
  setStatus("#remote-jobs-status", error.message || "Gagal memuat antrean remote");
}

async function refreshRemoteJobs() {
  if (state.remoteJobsLoading) return;
  state.remoteJobsLoading = true;
  $("#remote-jobs-retry").disabled = true;
  setStatus("#remote-jobs-status", "Memuat antrean remote…");
  try { renderRemoteJobs(await api("remote_jobs")); }
  catch (error) { renderRemoteJobsError(error); }
  finally { state.remoteJobsLoading = false; $("#remote-jobs-retry").disabled = false; }
}

const platformRoleLabels = {
  platform_owner: "Platform Owner",
  integration_admin: "Integration Admin",
  finance_admin: "Finance Admin",
  fleet_admin: "Fleet Admin",
  support: "Support",
  auditor: "Auditor",
};

function platformStaffStatus(value) {
  if (value === "active") return { label: "AKTIF", className: "" };
  if (value === "invited") return { label: "MENUNGGU AKTIVASI", className: "warn" };
  if (value === "suspended") return { label: "DITANGGUHKAN", className: "off" };
  return { label: "DICABUT", className: "off" };
}

function renderPlatformStaff(result) {
  state.platformStaff = Array.isArray(result.staff) ? result.staff : [];
  const mutable = can("platform.staff.write") && result.permissions?.canManage !== false;
  $("#platform-staff-rows").innerHTML = state.platformStaff.length ? state.platformStaff.map(staff => {
    const status = platformStaffStatus(staff.status);
    const roleOptions = Object.entries(platformRoleLabels).map(([value, label]) => `<option value="${value}" ${staff.platformRole === value ? "selected" : ""}>${label}</option>`).join("");
    const actions = mutable && staff.status !== "revoked" ? `<div class="platform-staff-actions">
      <select data-staff-role="${escapeHtml(staff.id)}" aria-label="Role ${escapeHtml(staff.name)}">${roleOptions}</select>
      <button class="btn" type="button" data-staff-action="set_role" data-staff-id="${escapeHtml(staff.id)}">Ubah role</button>
      ${staff.status === "active" ? `<button class="btn danger" type="button" data-staff-action="suspend" data-staff-id="${escapeHtml(staff.id)}">Tangguhkan</button>` : staff.status === "suspended" ? `<button class="btn" type="button" data-staff-action="activate" data-staff-id="${escapeHtml(staff.id)}">Aktifkan</button>` : ""}
      ${staff.status === "active" ? `<button class="btn" type="button" data-staff-action="revoke_sessions" data-staff-id="${escapeHtml(staff.id)}">Keluar semua sesi</button>` : ""}
      <button class="btn danger" type="button" data-staff-action="revoke" data-staff-id="${escapeHtml(staff.id)}">Cabut akun</button>
    </div>` : "—";
    return `<tr><td><b>${escapeHtml(staff.name || "—")}</b></td><td>${escapeHtml(staff.email)}</td><td><span class="pill warn">${escapeHtml(platformRoleLabels[staff.platformRole] || staff.platformRole)}</span></td><td><span class="pill ${status.className}">${status.label}</span>${staff.inviteExpiresAt && staff.status === "invited" ? `<br><small>hingga ${escapeHtml(formatTime(staff.inviteExpiresAt))}</small>` : ""}</td><td>${escapeHtml(formatTime(staff.lastLoginAt))}</td><td>${actions}</td></tr>`;
  }).join("") : '<tr><td colspan="6" class="empty">Belum ada anggota tim platform. Akun bootstrap environment tetap aktif.</td></tr>';
  setStatus("#platform-staff-status", `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`, true);
}

function renderPlatformStaffError(error) {
  $("#platform-staff-rows").innerHTML = '<tr><td colspan="6" class="empty">Tim platform tidak dapat dimuat. Gunakan Perbarui untuk mencoba lagi.</td></tr>';
  setStatus("#platform-staff-status", error.message || "Gagal memuat tim platform");
}

async function refreshPlatformStaff() {
  if (state.platformStaffLoading || !can("platform.staff.read")) return;
  state.platformStaffLoading = true;
  $("#platform-staff-retry").disabled = true;
  setStatus("#platform-staff-status", "Memuat tim platform…");
  try { renderPlatformStaff(await api("platform_staff")); }
  catch (error) { renderPlatformStaffError(error); }
  finally { state.platformStaffLoading = false; $("#platform-staff-retry").disabled = false; }
}

function openPlatformStaffAction(staffId, operation, role = "") {
  const staff = state.platformStaff.find(item => item.id === staffId);
  if (!staff) return setStatus("#platform-staff-status", "Anggota tim tidak ditemukan. Perbarui daftar lalu coba lagi.");
  const labels = { set_role: "Ubah role", suspend: "Tangguhkan akun", activate: "Aktifkan akun", revoke_sessions: "Keluar semua sesi", revoke: "Cabut akun" };
  $("#platform-staff-action-id").value = staffId;
  $("#platform-staff-action-type").value = operation;
  $("#platform-staff-dialog-title").textContent = labels[operation] || "Kelola anggota tim";
  $("#platform-staff-dialog-copy").textContent = `${staff.name} · ${staff.email}. Konfirmasi password Anda untuk melanjutkan.`;
  $("#platform-staff-action-role-wrap").hidden = operation !== "set_role";
  if (role) $("#platform-staff-action-role").value = role;
  $("#platform-staff-action-password").value = "";
  setStatus("#platform-staff-dialog-status");
  $("#platform-staff-dialog").showModal();
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  $("#super-refresh").disabled = true;
  setStatus("#super-status", "Memperbarui data…");
  try {
    const session = await api("superadmin_session");
    applyPlatformIdentity(session.user);
    const healthRequest = api("fleet_health").then(data => ({ data }), error => ({ error }));
    const alertRoutingRequest = api("alert_routing").then(data => ({ data }), error => ({ error }));
    const backendHealthRequest = api("backend_health").then(data => ({ data }), error => ({ error }));
    const webhookEventsRequest = can("platform.finance.read") ? api("webhook_events&limit=100").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { records: [], summary: {} } });
    const providerRequest = api("provider_connections").then(data => ({ data }), error => ({ error }));
    const platformFrameRequest = can("platform.integrations.read") ? api("platform_frame_library").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { frames: [] } });
    const providerEconomicsRequest = can("platform.integrations.read") ? api("provider_economics").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { records: [], summary: {} } });
    const providerMigrationsRequest = can("platform.integrations.read") ? api("provider_migrations").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { migrations: [] } });
    const emailRequest = can("platform.integrations.read") ? api("email_deliveries").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { deliveries: [], summary: {} } });
    const financePolicyRequest = can("platform.finance.read") ? api("finance_policy").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { policies: [] } });
    const financeReviewRequest = can("platform.finance.read") ? api("finance_reconciliation&status=review").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { records: [] } });
    const financeBalancesRequest = can("platform.finance.read") ? api("finance_balances").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { records: [], totals: {} } });
    const financePayoutRequest = can("platform.finance.read") ? api("finance_payout&limit=100").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { payouts: [], accounts: [], policy: null } });
    const financeRiskRequest = can("platform.finance.read") ? api("finance_risk&limit=200").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { records: [], summary: {} } });
    const ledgerReconciliationRequest = can("platform.finance.read") ? api("finance_ledger_reconciliation&limit=25").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { runs: [] } });
    const remoteJobsRequest = api("remote_jobs").then(data => ({ data }), error => ({ error }));
    const auditRequest = api("audit").then(data => ({ data }), error => ({ error }));
    const platformStaffRequest = can("platform.staff.read") ? api("platform_staff").then(data => ({ data }), error => ({ error })) : Promise.resolve({ data: { staff: [], permissions: { canManage: false } } });
    const [{ machines, resetRequests }, flags, healthResult, alertRoutingResult, backendHealthResult, webhookEventsResult, providerResult, platformFrameResult, providerEconomicsResult, providerMigrationsResult, emailResult, financePolicyResult, financeReviewResult, financeBalancesResult, financePayoutResult, financeRiskResult, ledgerReconciliationResult, remoteJobsResult, auditResult, platformStaffResult] = await Promise.all([api("superadmin_overview"), api("feature_flags"), healthRequest, alertRoutingRequest, backendHealthRequest, webhookEventsRequest, providerRequest, platformFrameRequest, providerEconomicsRequest, providerMigrationsRequest, emailRequest, financePolicyRequest, financeReviewRequest, financeBalancesRequest, financePayoutRequest, financeRiskRequest, ledgerReconciliationRequest, remoteJobsRequest, auditRequest, platformStaffRequest]);
    $("#super-login-view").classList.add("hidden");
    $("#super-dashboard").classList.remove("hidden");
    $("#super-logout").hidden = false;
    showSuperDomain(state.activeDomain, { updateUrl: false });
    renderOverview(machines, resetRequests);
    queueMicrotask(() => refreshTelemetryHistory());
    state.definitions = flags.definitions;
    state.overrides = flags.overrides;
    renderFlags();
    if (healthResult.data) renderFleetHealth(healthResult.data); else renderFleetHealthError(healthResult.error);
    if (alertRoutingResult.data) renderAlertRouting(alertRoutingResult.data); else renderAlertRoutingError(alertRoutingResult.error);
    if (backendHealthResult.data) renderBackendHealth(backendHealthResult.data); else renderBackendHealthError(backendHealthResult.error);
    if (webhookEventsResult.data) renderWebhookEvents(webhookEventsResult.data); else renderWebhookEventsError(webhookEventsResult.error);
    if (providerResult.data) renderProviderConnections(providerResult.data); else renderProviderConnectionsError(providerResult.error);
    if (platformFrameResult.data) renderPlatformFrames(platformFrameResult.data); else renderPlatformFramesError(platformFrameResult.error);
    if (providerEconomicsResult.data) renderProviderEconomics(providerEconomicsResult.data); else renderProviderEconomicsError(providerEconomicsResult.error);
    if (providerMigrationsResult.data) renderProviderMigrations(providerMigrationsResult.data); else renderProviderMigrationsError(providerMigrationsResult.error);
    if (emailResult.data) renderEmailDeliveries(emailResult.data); else renderEmailDeliveriesError(emailResult.error);
    if (financePolicyResult.data) renderFinancePolicies(financePolicyResult.data); else renderFinancePoliciesError(financePolicyResult.error);
    if (financeReviewResult.data) renderFinanceReviews(financeReviewResult.data); else renderFinanceReviewsError(financeReviewResult.error);
    if (financeBalancesResult.data) renderFinanceBalances(financeBalancesResult.data); else renderFinanceBalancesError(financeBalancesResult.error);
    if (financePayoutResult.data) {
      renderPayouts(financePayoutResult.data);
      if (!financePayoutResult.data.policy && state.machines[0]?.boothCode) queueMicrotask(() => refreshPayouts());
    } else renderPayoutsError(financePayoutResult.error);
    if (financeRiskResult.data) renderFinanceRisks(financeRiskResult.data); else renderFinanceRisksError(financeRiskResult.error);
    if (ledgerReconciliationResult.data) renderLedgerReconciliationRuns(ledgerReconciliationResult.data); else renderLedgerReconciliationError(ledgerReconciliationResult.error);
    if (remoteJobsResult.data) renderRemoteJobs(remoteJobsResult.data); else renderRemoteJobsError(remoteJobsResult.error);
    if (auditResult.data) renderAudit(auditResult.data.records || []); else renderAuditError(auditResult.error);
    if (platformStaffResult.data) renderPlatformStaff(platformStaffResult.data); else renderPlatformStaffError(platformStaffResult.error);
    $("#flags-retry").hidden = true;
    setStatus("#super-status", `Diperbarui ${new Date().toLocaleTimeString("id-ID")}`, true);
    if (alertRoutingResult.data?.summary?.queued && can("platform.fleet.write")) queueMicrotask(() => processAlertRouting());
  } catch (error) {
    setStatus("#super-status", error.message);
    $("#flags-retry").hidden = false;
    throw error;
  } finally {
    state.loading = false;
    $("#super-refresh").disabled = false;
    syncFlagForm();
  }
}

$("#super-login").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  setStatus("#super-login-status", "Memeriksa…");
  try {
    const result = await api("superadmin_login", { method: "POST", body: JSON.stringify({ email: $("#super-email").value, password: $("#super-password").value }) });
    applyPlatformIdentity(result.user);
    await load();
  } catch (error) { setStatus("#super-login-status", error.message); }
  finally { button.disabled = false; }
});

$("#platform-activate").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  const password = $("#platform-activate-password").value;
  if (password !== $("#platform-activate-confirm").value) return setStatus("#super-login-status", "Konfirmasi password tidak sama.");
  button.disabled = true;
  setStatus("#super-login-status", "Mengaktifkan akun…");
  try {
    const params = new URLSearchParams(location.search);
    await api("platform_staff_activate", { method: "POST", body: JSON.stringify({ email: params.get("email"), token: params.get("invite"), password }) });
    history.replaceState({}, "", "/superadmin");
    $("#platform-activate").hidden = true;
    $("#super-login").hidden = false;
    $("#super-email").value = $("#platform-activate-email").value;
    $("#super-password").value = "";
    $("#super-login-title").textContent = "Masuk superadmin";
    $("#super-login-copy").textContent = "Akun aktif. Masuk dengan password baru Anda.";
    setStatus("#super-login-status", "Akun berhasil diaktifkan.", true);
  } catch (error) { setStatus("#super-login-status", error.message); }
  finally { button.disabled = false; }
});

$("#platform-staff-retry").addEventListener("click", refreshPlatformStaff);
$("#platform-staff-invite-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.platformStaffLoading || !can("platform.staff.write")) return;
  const button = event.submitter;
  button.disabled = true;
  setStatus("#platform-staff-status", "Membuat undangan aman…");
  try {
    const result = await api("platform_staff", { method: "POST", body: JSON.stringify({
      operation: "invite",
      name: $("#platform-staff-name").value.trim(),
      email: $("#platform-staff-email").value.trim(),
      platformRole: $("#platform-staff-role").value,
      reauthPassword: $("#platform-staff-invite-password").value,
    }) });
    $("#platform-staff-activation-url").textContent = result.activationUrl;
    $("#platform-staff-activation-result").hidden = false;
    $("#platform-staff-invite-form").reset();
    await Promise.all([refreshPlatformStaff(), refreshAudit()]);
    setStatus("#platform-staff-status", result.invitationEmailQueued ? "Undangan dibuat dan masuk antrean email. Tautan manual tetap tersedia sebagai fallback." : "Undangan dibuat, tetapi email belum dapat diantrekan. Salin tautan dan kirim melalui saluran aman.", true);
  } catch (error) { setStatus("#platform-staff-status", error.message); }
  finally { button.disabled = false; }
});
$("#platform-staff-copy").addEventListener("click", async () => {
  const value = $("#platform-staff-activation-url").textContent;
  try { await navigator.clipboard.writeText(value); setStatus("#platform-staff-status", "Tautan aktivasi disalin.", true); }
  catch { setStatus("#platform-staff-status", "Browser tidak mengizinkan salin otomatis. Pilih dan salin tautan secara manual."); }
});
$("#platform-staff-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-staff-action]");
  if (!button || !can("platform.staff.write")) return;
  const role = document.querySelector(`[data-staff-role="${CSS.escape(button.dataset.staffId)}"]`)?.value || "";
  openPlatformStaffAction(button.dataset.staffId, button.dataset.staffAction, role);
});
$("#platform-staff-dialog-cancel").addEventListener("click", () => $("#platform-staff-dialog").close());
$("#platform-staff-action-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.platformStaffActionLoading || !can("platform.staff.write")) return;
  const operation = $("#platform-staff-action-type").value;
  if (operation === "revoke" && !confirm("Cabut akun ini secara permanen? Seluruh sesi akan dihentikan.")) return;
  state.platformStaffActionLoading = true;
  $("#platform-staff-dialog-submit").disabled = true;
  setStatus("#platform-staff-dialog-status", "Menyimpan dan mencabut sesi terkait…");
  try {
    const result = await api("platform_staff", { method: "POST", body: JSON.stringify({
      operation,
      staffId: $("#platform-staff-action-id").value,
      platformRole: $("#platform-staff-action-role").value,
      reauthPassword: $("#platform-staff-action-password").value,
    }) });
    $("#platform-staff-dialog").close();
    await Promise.all([refreshPlatformStaff(), refreshAudit()]);
    setStatus("#platform-staff-status", `Perubahan tersimpan${result.sessionsRevoked ? ` · ${result.sessionsRevoked} sesi dihentikan` : ""}.`, true);
  } catch (error) { setStatus("#platform-staff-dialog-status", error.message); }
  finally { state.platformStaffActionLoading = false; $("#platform-staff-dialog-submit").disabled = false; }
});

$("#member-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-transfer-owner]");
  if (!button || !can("platform.ownership.write") || state.ownershipLoading) return;
  $("#ownership-booth-code").value = button.dataset.boothCode;
  $("#ownership-target-user-id").value = button.dataset.transferOwner;
  $("#ownership-confirmation").value = "";
  $("#ownership-confirmation").placeholder = button.dataset.boothCode;
  $("#ownership-password").value = "";
  $("#ownership-dialog-copy").textContent = `${button.dataset.memberName} akan menjadi owner /${button.dataset.boothCode}. Owner lama menjadi Admin dan seluruh sesi keduanya akan dihentikan.`;
  setStatus("#ownership-dialog-status");
  $("#ownership-dialog").showModal();
});
$("#ownership-cancel").addEventListener("click", () => $("#ownership-dialog").close());
$("#ownership-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.ownershipLoading || !can("platform.ownership.write")) return;
  state.ownershipLoading = true;
  $("#ownership-submit").disabled = true;
  setStatus("#ownership-dialog-status", "Memindahkan kepemilikan dan menghentikan sesi lama…");
  try {
    const result = await api("booth_ownership", { method: "POST", body: JSON.stringify({
      boothCode: $("#ownership-booth-code").value,
      targetUserId: $("#ownership-target-user-id").value,
      confirmation: $("#ownership-confirmation").value,
      reauthPassword: $("#ownership-password").value,
    }) });
    $("#ownership-dialog").close();
    await Promise.all([load(), refreshAudit()]);
    setStatus("#ownership-status", `Owner dipindahkan ke ${result.newOwner.name || result.newOwner.email}. ${result.sessionsRevoked} sesi dihentikan dan ${result.notificationsQueued} notifikasi diantrekan.`, true);
  } catch (error) { setStatus("#ownership-dialog-status", error.message); }
  finally { state.ownershipLoading = false; $("#ownership-submit").disabled = false; }
});

$("#machine-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-machine]");
  if (!button) return;
  button.disabled = true;
  try { await api("toggle_machine", { method: "POST", body: JSON.stringify({ machineId: button.dataset.machine, enabled: button.dataset.enabled === "true" }) }); await load(); }
  catch (error) { setStatus("#super-status", error.message); button.disabled = false; }
});

$("#reset-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-reset]");
  if (!button) return;
  button.disabled = true;
  try { await api("resolve_reset", { method: "POST", body: JSON.stringify({ requestId: button.dataset.reset }) }); await load(); }
  catch (error) { setStatus("#super-status", error.message); button.disabled = false; }
});

$("#incident-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-incident]");
  if (!button) return;
  button.disabled = true;
  setStatus("#health-status", "Menyimpan acknowledgement…");
  try {
    await api("fleet_health", { method: "POST", body: JSON.stringify({ incidentId: button.dataset.incident }) });
    await refreshFleetHealth();
  } catch (error) { setStatus("#health-status", error.message); button.disabled = false; }
});

$("#alert-routing-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-retry-alert]");
  if (!button) return;
  button.disabled = true;
  setStatus("#alert-routing-status", "Menjadwalkan ulang delivery…");
  try {
    await api("alert_routing", { method: "POST", body: JSON.stringify({ operation: "retry", deliveryId: button.dataset.retryAlert }) });
    await processAlertRouting();
  } catch (error) { setStatus("#alert-routing-status", error.message); button.disabled = false; }
});

$("#feature-flag-form").addEventListener("submit", async event => {
  event.preventDefault();
  state.loading = true;
  syncFlagForm();
  setStatus("#flag-status", "Menerapkan rollout…");
  try {
    await api("feature_flags", { method: "POST", body: JSON.stringify({ key: $("#flag-key").value, scope: $("#flag-scope").value, targetId: currentTarget(), enabled: $("#flag-enabled").value === "true", config: {} }) });
    state.loading = false;
    await load();
    setStatus("#flag-status", "Feature flag diterapkan dan tercatat di audit log.", true);
  } catch (error) { state.loading = false; setStatus("#flag-status", error.message); syncFlagForm(); }
});

$("#flag-delete").addEventListener("click", async () => {
  state.loading = true;
  syncFlagForm();
  setStatus("#flag-status", "Menghapus override…");
  try {
    await api("feature_flags", { method: "DELETE", body: JSON.stringify({ key: $("#flag-key").value, scope: $("#flag-scope").value, targetId: currentTarget() }) });
    state.loading = false;
    await load();
    setStatus("#flag-status", "Override dihapus; nilai kembali mengikuti scope di atasnya.", true);
  } catch (error) { state.loading = false; setStatus("#flag-status", error.message); syncFlagForm(); }
});

$("#flag-scope").addEventListener("change", renderTargets);
$("#flag-key").addEventListener("change", syncFlagForm);
$("#flag-target").addEventListener("change", syncFlagForm);
$("#super-refresh").addEventListener("click", () => load().catch(() => {}));
$("#flags-retry").addEventListener("click", () => load().catch(() => {}));
$("#health-retry").addEventListener("click", refreshFleetHealth);
$("#telemetry-machine").addEventListener("change", refreshTelemetryHistory);
$("#telemetry-range").addEventListener("change", refreshTelemetryHistory);
$("#telemetry-history-retry").addEventListener("click", refreshTelemetryHistory);
$("#alert-routing-retry").addEventListener("click", refreshAlertRouting);
$("#alert-routing-process").addEventListener("click", processAlertRouting);
$("#backend-health-retry").addEventListener("click", refreshBackendHealth);
$("#provider-retry").addEventListener("click", refreshProviderConnections);
$("#provider-economics-retry").addEventListener("click", refreshProviderEconomics);
$("#email-delivery-retry").addEventListener("click", refreshEmailDeliveries);
$("#email-delivery-process").addEventListener("click", processEmailQueue);
$("#provider-scope").addEventListener("change", renderProviderTargets);
$("#provider-id").addEventListener("change", syncProviderForm);
$("#provider-entitlement-scope").addEventListener("change", renderProviderEconomicsTargets);
$("#provider-source").addEventListener("change", syncProviderForm);
$("#provider-target").addEventListener("change", syncProviderForm);
$("#email-test-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.emailProcessing || !can("platform.integrations.write")) return;
  state.emailProcessing = true;
  const button = $("#email-test-submit");
  button.disabled = true;
  setStatus("#email-delivery-status", "Mengantrekan dan mengirim email tes…");
  try {
    const result = await api("email_deliveries", { method: "POST", body: JSON.stringify({ operation: "test", to: $("#email-test-recipient").value.trim(), confirmed: $("#email-test-confirm").checked }) });
    $("#email-test-confirm").checked = false;
    await refreshEmailDeliveries();
    setStatus("#email-delivery-status", result.delivery.status === "sent" ? "Email tes diteruskan ke Resend. Status penerimaan akan diperbarui lewat webhook." : `Email tes berstatus ${result.delivery.status}. Periksa konfigurasi provider.`, result.delivery.status === "sent");
  } catch (error) { setStatus("#email-delivery-status", error.message || "Email tes gagal dikirim"); }
  finally { state.emailProcessing = false; button.disabled = false; }
});
$("#email-delivery-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-retry-email]");
  if (!button || !can("platform.integrations.write")) return;
  button.disabled = true;
  setStatus("#email-delivery-status", "Mengantrekan ulang email…");
  try {
    await api("email_deliveries", { method: "POST", body: JSON.stringify({ operation: "retry", id: button.dataset.retryEmail }) });
    await refreshEmailDeliveries();
    setStatus("#email-delivery-status", "Email masuk kembali ke antrean dengan idempotency key yang sama.", true);
  } catch (error) { setStatus("#email-delivery-status", error.message || "Retry email gagal"); button.disabled = false; }
});
$("#finance-policy-retry").addEventListener("click", refreshFinancePolicies);
$("#finance-review-retry").addEventListener("click", refreshFinanceReviews);
$("#finance-balances-retry").addEventListener("click", refreshFinanceBalances);
$("#finance-payout-retry").addEventListener("click", refreshPayouts);
$("#finance-payout-booth").addEventListener("change", async () => {
  state.payoutPolicy = null;
  await refreshPayouts();
});
$("#finance-payout-policy-save").addEventListener("click", async () => {
  if (state.payoutLoading || !can("platform.finance.write")) return;
  state.payoutLoading = true;
  syncPayoutControls();
  setStatus("#finance-payout-status", "Menyimpan kebijakan payout…");
  try {
    await api("finance_payout", { method: "POST", body: JSON.stringify({ operation: "policy", boothCode: $("#finance-payout-booth").value, mode: $("#finance-payout-mode").value, minimumAmount: Number($("#finance-payout-minimum").value) }) });
    state.payoutLoading = false;
    await refreshPayouts();
    setStatus("#finance-payout-status", "Kebijakan payout tersimpan.", true);
  } catch (error) { setStatus("#finance-payout-status", error.message || "Kebijakan payout gagal disimpan"); }
  finally { state.payoutLoading = false; syncPayoutControls(); }
});
$("#finance-payout-account-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.payoutLoading || !can("platform.finance.write")) return;
  const submit = $("#finance-payout-account-save");
  state.payoutLoading = true; submit.disabled = true;
  setStatus("#finance-payout-status", "Mengenkripsi dan menyimpan rekening…");
  try {
    const result = await api("finance_payout", { method: "POST", body: JSON.stringify({ operation: "account_save", boothCode: $("#finance-payout-booth").value, bankCode: $("#finance-payout-bank").value, accountName: $("#finance-payout-account-name").value, accountNumber: $("#finance-payout-account-number").value, reauthPassword: $("#finance-payout-account-password").value }) });
    $("#finance-payout-account-number").value = "";
    $("#finance-payout-account-password").value = "";
    state.payoutLoading = false;
    await refreshPayouts();
    setStatus("#finance-payout-status", result.invalidatedPayouts ? `Rekening tersimpan. ${result.invalidatedPayouts} payout aktif dibatalkan karena rekening berubah.` : "Rekening tersimpan dan menunggu verifikasi oleh Platform Owner lain.", true);
  } catch (error) { setStatus("#finance-payout-status", error.message || "Rekening payout gagal disimpan"); }
  finally { state.payoutLoading = false; submit.disabled = false; $("#finance-payout-account-password").value = ""; syncPayoutControls(); }
});
$("#finance-payout-verify-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.payoutLoading || state.platformRole !== "platform_owner") return;
  state.payoutLoading = true; syncPayoutControls();
  setStatus("#finance-payout-status", "Memverifikasi rekening…");
  try {
    await api("finance_payout", { method: "POST", body: JSON.stringify({ operation: "account_verify", boothCode: $("#finance-payout-booth").value, reference: $("#finance-payout-verification-reference").value, reauthPassword: $("#finance-payout-verification-password").value }) });
    $("#finance-payout-verification-reference").value = "";
    $("#finance-payout-verification-password").value = "";
    state.payoutLoading = false;
    await refreshPayouts();
    setStatus("#finance-payout-status", "Rekening payout terverifikasi.", true);
  } catch (error) { setStatus("#finance-payout-status", error.message || "Rekening belum dapat diverifikasi"); }
  finally { state.payoutLoading = false; $("#finance-payout-verification-password").value = ""; syncPayoutControls(); }
});
$("#finance-payout-create").addEventListener("click", async () => {
  if (state.payoutLoading || !can("platform.finance.write")) return;
  state.payoutLoading = true; syncPayoutControls();
  setStatus("#finance-payout-status", "Mengunci saldo ledger ke batch payout…");
  try {
    const result = await api("finance_payout", { method: "POST", body: JSON.stringify({ operation: "create", boothCode: $("#finance-payout-booth").value, period: new Date().toISOString().slice(0, 10) }) });
    state.payoutLoading = false;
    await Promise.all([refreshPayouts(), refreshAudit()]);
    setStatus("#finance-payout-status", result.reused ? `Batch ${result.payout.id} hari ini sudah tersedia.` : `Batch ${result.payout.id} dibuat dan menunggu approval.`, true);
  } catch (error) { setStatus("#finance-payout-status", error.message || "Batch payout gagal dibuat"); }
  finally { state.payoutLoading = false; syncPayoutControls(); }
});
$("#finance-payout-rows").addEventListener("click", async event => {
  const proofView = event.target.closest("[data-payout-proof-view]");
  if (proofView && !state.payoutLoading) {
    proofView.disabled = true;
    setStatus("#finance-payout-status", "Membuat link bukti transfer…");
    try {
      const result = await api(`finance_payout&operation=proof_download&id=${encodeURIComponent(proofView.dataset.payoutProofView)}`);
      window.open(result.download.url, "_blank", "noopener,noreferrer");
      setStatus("#finance-payout-status", `Bukti dibuka. Link kedaluwarsa ${formatTime(result.download.expiresAt)}.`, true);
    } catch (error) {
      setStatus("#finance-payout-status", error.message || "Bukti transfer tidak dapat dibuka");
    } finally { proofView.disabled = false; }
    return;
  }
  const button = event.target.closest("[data-payout-action]");
  if (!button || state.payoutLoading) return;
  const { payoutAction: action, payoutId: id } = button.dataset;
  if (action === "proof") {
    state.payoutProofId = id;
    $("#finance-payout-proof-file").value = "";
    return $("#finance-payout-proof-file").click();
  }
  if (action === "resend") {
    button.disabled = true;
    setStatus("#finance-payout-status", "Mengantrekan ulang email payout…");
    try { await api("finance_payout", { method: "POST", body: JSON.stringify({ operation: "resend_email", id }) }); await refreshPayouts(); setStatus("#finance-payout-status", "Email payout masuk kembali ke antrean.", true); }
    catch (error) { setStatus("#finance-payout-status", error.message || "Email payout gagal diantrikan ulang"); button.disabled = false; }
    return;
  }
  $("#finance-payout-action-id").value = id;
  $("#finance-payout-action-type").value = action;
  const needsValue = action === "paid" || action === "cancel";
  $("#finance-payout-action-value-wrap").hidden = !needsValue;
  $("#finance-payout-action-value").required = needsValue;
  $("#finance-payout-action-value").value = "";
  $("#finance-payout-dialog-title").textContent = action === "approve" ? "Setujui payout" : action === "paid" ? "Finalisasi transfer" : "Batalkan payout";
  $("#finance-payout-dialog-copy").textContent = action === "approve" ? "Pastikan rekening dan nominal sudah benar. Maker tidak dapat menyetujui batch sendiri." : action === "paid" ? "Masukkan referensi bank setelah transfer dan bukti transfer terverifikasi." : "Tuliskan alasan pembatalan agar dapat ditelusuri.";
  $("#finance-payout-action-value-wrap").firstChild.textContent = action === "paid" ? "Referensi transfer" : "Alasan pembatalan";
  $("#finance-payout-action-password").value = "";
  setStatus("#finance-payout-dialog-status", "");
  $("#finance-payout-dialog").showModal();
});
$("#finance-payout-dialog-cancel").addEventListener("click", () => $("#finance-payout-dialog").close());
$("#finance-payout-action-form").addEventListener("submit", async event => {
  event.preventDefault();
  const action = $("#finance-payout-action-type").value;
  const id = $("#finance-payout-action-id").value;
  const value = $("#finance-payout-action-value").value.trim();
  const submit = $("#finance-payout-dialog-submit"); submit.disabled = true;
  setStatus("#finance-payout-dialog-status", "Menyimpan tindakan payout…");
  try {
    const reauthPassword = $("#finance-payout-action-password").value;
    const payload = action === "approve" ? { operation: "approve", id, reauthPassword } : action === "paid" ? { operation: "mark_paid", id, transferReference: value, reauthPassword } : { operation: "cancel", id, reason: value, reauthPassword };
    const result = await api("finance_payout", { method: "POST", body: JSON.stringify(payload) });
    $("#finance-payout-action-password").value = "";
    $("#finance-payout-dialog").close();
    await Promise.all([refreshPayouts(), refreshFinanceBalances(), refreshEmailDeliveries(), refreshAudit()]);
    setStatus("#finance-payout-status", action === "paid" ? (result.emailWarning || "Payout ditandai dibayar, ledger diperbarui, dan email diantrikan.") : action === "approve" ? "Payout disetujui. Upload bukti setelah transfer dilakukan." : "Payout dibatalkan.", true);
  } catch (error) { setStatus("#finance-payout-dialog-status", error.message || "Tindakan payout gagal"); }
  finally { submit.disabled = false; $("#finance-payout-action-password").value = ""; }
});
$("#finance-payout-proof-file").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  const id = state.payoutProofId;
  if (!file || !id) return;
  state.payoutLoading = true; syncPayoutControls();
  setStatus("#finance-payout-status", "Mengunggah dan memverifikasi bukti transfer…");
  try { await uploadPayoutProof(id, file); state.payoutLoading = false; await Promise.all([refreshPayouts(), refreshAudit()]); setStatus("#finance-payout-status", "Bukti transfer terunggah dan checksum terverifikasi.", true); }
  catch (error) { setStatus("#finance-payout-status", error.message || "Bukti transfer gagal diunggah"); }
  finally { state.payoutLoading = false; state.payoutProofId = null; syncPayoutControls(); }
});
$("#finance-risk-retry").addEventListener("click", refreshFinanceRisks);
for (const id of ["#finance-risk-booth", "#finance-risk-status-filter", "#finance-risk-severity-filter"]) $(id).addEventListener("change", refreshFinanceRisks);
$("#finance-risk-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-finance-risk-action]");
  if (!button || !can("platform.finance.write")) return;
  const operation = button.dataset.financeRiskAction;
  const risk = state.financeRisks.find(item => item.id === button.dataset.financeRiskId);
  if (!risk || (operation === "resolve" && state.platformRole !== "platform_owner")) return;
  $("#finance-risk-action-id").value = risk.id;
  $("#finance-risk-action-type").value = operation;
  $("#finance-risk-action-note").value = "";
  $("#finance-risk-action-password").value = "";
  $("#finance-risk-action-password-wrap").hidden = operation !== "resolve";
  $("#finance-risk-action-password").required = operation === "resolve";
  $("#finance-risk-dialog-title").textContent = operation === "resolve" ? "Selesaikan kasus risiko" : "Akui kasus risiko";
  $("#finance-risk-dialog-copy").textContent = operation === "resolve"
    ? `${risk.title}. Platform Owner harus menjelaskan bukti atau tindakan perbaikan.`
    : `${risk.title}. Kasus tetap terbuka untuk tindak lanjut.`;
  setStatus("#finance-risk-dialog-status", "");
  $("#finance-risk-dialog").showModal();
});
$("#finance-risk-dialog-cancel").addEventListener("click", () => $("#finance-risk-dialog").close());
$("#finance-risk-action-form").addEventListener("submit", async event => {
  event.preventDefault();
  const operation = $("#finance-risk-action-type").value;
  const submit = $("#finance-risk-dialog-submit");
  submit.disabled = true;
  setStatus("#finance-risk-dialog-status", operation === "resolve" ? "Menyelesaikan kasus risiko…" : "Menyimpan pengakuan kasus…");
  try {
    await api("finance_risk", { method: "POST", body: JSON.stringify({
      operation,
      id: $("#finance-risk-action-id").value,
      note: $("#finance-risk-action-note").value.trim(),
      reauthPassword: $("#finance-risk-action-password").value,
    }) });
    $("#finance-risk-action-password").value = "";
    $("#finance-risk-dialog").close();
    await Promise.all([refreshFinanceRisks(), refreshAudit()]);
    setStatus("#finance-risk-status", operation === "resolve" ? "Kasus risiko diselesaikan dan tercatat di audit log." : "Kasus risiko diakui dan tetap terlihat sampai diselesaikan.", true);
  } catch (error) { setStatus("#finance-risk-dialog-status", error.message || "Review risiko gagal disimpan"); }
  finally { submit.disabled = false; $("#finance-risk-action-password").value = ""; }
});
$("#finance-ledger-reconciliation-retry").addEventListener("click", refreshLedgerReconciliationRuns);
$("#finance-policy-scope").addEventListener("change", renderFinancePolicyTargets);
$("#finance-policy-form").addEventListener("submit", async event => {
  event.preventDefault();
  const scope = $("#finance-policy-scope").value;
  const targetId = scope === "booth" ? $("#finance-policy-target").value : "";
  const percent = Number($("#finance-policy-percent").value);
  const platformFeeBps = Math.round(percent * 100);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return setStatus("#finance-policy-status", "Platform fee harus antara 0% dan 100%.");
  state.financePolicyLoading = true;
  renderFinancePolicyTargets();
  setStatus("#finance-policy-status", "Menyimpan fee untuk transaksi baru…");
  try {
    await api("finance_policy", { method: "POST", body: JSON.stringify({ scope, targetId, platformFeeBps }) });
    state.financePolicyLoading = false;
    await refreshFinancePolicies();
    setStatus("#finance-policy-status", "Platform fee tersimpan. Payment yang sudah dibuat tidak berubah.", true);
  } catch (error) { setStatus("#finance-policy-status", error.message); }
  finally { state.financePolicyLoading = false; renderFinancePolicyTargets(); }
});
$("#finance-policy-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-finance-policy-delete]");
  if (!button) return;
  button.disabled = true;
  setStatus("#finance-policy-status", "Menghapus override photobox…");
  try {
    await api("finance_policy", { method: "DELETE", body: JSON.stringify({ scope: "booth", targetId: button.dataset.financePolicyDelete }) });
    await refreshFinancePolicies();
    setStatus("#finance-policy-status", "Override dihapus. Photobox memakai fee global.", true);
  } catch (error) { setStatus("#finance-policy-status", error.message); button.disabled = false; }
});
$("#finance-review-rows").addEventListener("click", event => {
  const button = event.target.closest("[data-payment-review]");
  if (!button || !can("platform.finance.write")) return;
  const decision = button.dataset.paymentReview;
  $("#finance-review-payment-id").value = button.dataset.paymentId;
  $("#finance-review-decision").value = decision;
  $("#finance-review-note").value = "";
  $("#finance-review-title").textContent = decision === "approved" ? "Setujui pembayaran terlambat" : "Tolak pembayaran terlambat";
  setStatus("#finance-review-dialog-status", decision === "rejected" ? "Penolakan tidak menjalankan refund otomatis." : "");
  $("#finance-review-dialog").showModal();
  $("#finance-review-note").focus();
});
$("#finance-review-cancel").addEventListener("click", () => $("#finance-review-dialog").close());
$("#finance-review-form").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = $("#finance-review-submit");
  submit.disabled = true;
  setStatus("#finance-review-dialog-status", "Menyimpan keputusan…");
  try {
    await api("finance_reconciliation", { method: "POST", body: JSON.stringify({
      paymentId: $("#finance-review-payment-id").value,
      decision: $("#finance-review-decision").value,
      note: $("#finance-review-note").value,
    }) });
    $("#finance-review-dialog").close();
    await Promise.all([refreshFinanceReviews(), refreshAudit()]);
    setStatus("#finance-review-status", "Keputusan tersimpan dan tercatat di audit log.", true);
  } catch (error) { setStatus("#finance-review-dialog-status", error.message); }
  finally { submit.disabled = false; }
});
$("#finance-refund-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.financeRefundLoading || !can("platform.finance.write")) return;
  const submit = $("#finance-refund-submit");
  state.financeRefundLoading = true;
  submit.disabled = true;
  setStatus("#finance-refund-status", "Mengirim permintaan refund ke Xendit…");
  try {
    const result = await api("finance_refund", {
      method: "POST",
      headers: { "Idempotency-Key": `refund-${$("#finance-refund-payment-id").value.trim()}` },
      body: JSON.stringify({
        paymentId: $("#finance-refund-payment-id").value.trim(),
        reason: $("#finance-refund-reason").value,
      }),
    });
    $("#finance-refund-confirm").checked = false;
    setStatus("#finance-refund-status", result.reused
      ? `Refund ${result.refund.providerRefundId} sudah pernah dibuat; status ${result.refund.status}.`
      : `Refund ${result.refund.providerRefundId} diterima Xendit. Menunggu status final webhook.`, true);
    await refreshAudit();
  } catch (error) {
    setStatus("#finance-refund-status", error.message || "Refund gagal dibuat. Periksa ID pembayaran dan coba lagi.");
  } finally {
    state.financeRefundLoading = false;
    submit.disabled = false;
  }
});
$("#finance-chargeback-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.financeChargebackLoading || !can("platform.finance.write")) return;
  const submit = $("#finance-chargeback-submit");
  state.financeChargebackLoading = true;
  submit.disabled = true;
  setStatus("#finance-chargeback-status", "Mencatat chargeback dan entry ledger…");
  try {
    const result = await api("finance_chargeback", {
      method: "POST",
      headers: { "Idempotency-Key": `chargeback-${$("#finance-chargeback-provider-id").value.trim()}` },
      body: JSON.stringify({
        paymentId: $("#finance-chargeback-payment-id").value.trim(),
        providerChargebackId: $("#finance-chargeback-provider-id").value.trim(),
        disputedAt: new Date($("#finance-chargeback-at").value).toISOString(),
        reason: $("#finance-chargeback-reason").value.trim(),
      }),
    });
    $("#finance-chargeback-confirm").checked = false;
    setStatus("#finance-chargeback-status", result.reused
      ? `Kasus ${result.chargeback.providerChargebackId} sudah tercatat sebelumnya.`
      : `Chargeback ${result.chargeback.providerChargebackId} tercatat dan ledger telah dikompensasi.`, true);
    await refreshAudit();
  } catch (error) {
    setStatus("#finance-chargeback-status", error.message || "Chargeback gagal dicatat. Periksa data provider dan coba lagi.");
  } finally {
    state.financeChargebackLoading = false;
    submit.disabled = false;
  }
});
$("#finance-adjustment-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.financeAdjustmentLoading || !can("platform.finance.write")) return;
  const submit = $("#finance-adjustment-submit");
  state.financeAdjustmentLoading = true;
  submit.disabled = true;
  setStatus("#finance-adjustment-status", "Menambahkan entry koreksi ke ledger…");
  try {
    const result = await api("finance_adjustment", {
      method: "POST",
      headers: { "Idempotency-Key": `adjustment-${$("#finance-adjustment-payment-id").value.trim()}-${$("#finance-adjustment-reference").value.trim()}` },
      body: JSON.stringify({
        paymentId: $("#finance-adjustment-payment-id").value.trim(),
        amount: Number($("#finance-adjustment-amount").value),
        reference: $("#finance-adjustment-reference").value.trim(),
        reason: $("#finance-adjustment-reason").value.trim(),
      }),
    });
    $("#finance-adjustment-confirm").checked = false;
    setStatus("#finance-adjustment-status", result.reused
      ? `Koreksi ${result.ledger.adjustmentReference} sudah tercatat sebelumnya.`
      : `Koreksi ${result.ledger.adjustmentReference} berhasil ditambahkan ke ledger.`, true);
    await refreshAudit();
  } catch (error) {
    setStatus("#finance-adjustment-status", error.message || "Koreksi ledger gagal dibuat.");
  } finally {
    state.financeAdjustmentLoading = false;
    submit.disabled = false;
  }
});
$("#finance-provider-fee-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.financeProviderFeeLoading || !can("platform.finance.write")) return;
  const submit = $("#finance-provider-fee-submit");
  state.financeProviderFeeLoading = true;
  submit.disabled = true;
  setStatus("#finance-provider-fee-status", "Mencatat biaya final dan memperbarui proyeksi saldo…");
  try {
    const paymentId = $("#finance-provider-fee-payment-id").value.trim();
    const reference = $("#finance-provider-fee-reference").value.trim();
    const result = await api("finance_provider_fee", {
      method: "POST",
      headers: { "Idempotency-Key": `provider-fee-${paymentId}` },
      body: JSON.stringify({
        paymentId,
        amount: Number($("#finance-provider-fee-amount").value),
        reference,
      }),
    });
    $("#finance-provider-fee-confirm").checked = false;
    setStatus("#finance-provider-fee-status", result.reused
      ? `Biaya provider untuk ${result.payment.id} sudah pernah difinalisasi.`
      : `Biaya provider ${formatCurrency(result.ledger.providerFee)} berhasil difinalisasi.`, true);
    await Promise.all([refreshFinanceBalances(), refreshAudit()]);
  } catch (error) {
    setStatus("#finance-provider-fee-status", error.message || "Biaya provider gagal difinalisasi.");
  } finally {
    state.financeProviderFeeLoading = false;
    submit.disabled = false;
  }
});
$("#finance-ledger-reconciliation-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.ledgerReconciliationLoading || !can("platform.finance.write")) return;
  const file = $("#finance-ledger-reconciliation-file").files?.[0];
  if (!file) return setStatus("#finance-ledger-reconciliation-status", "Pilih file laporan CSV terlebih dahulu.");
  state.ledgerReconciliationLoading = true;
  $("#finance-ledger-reconciliation-retry").disabled = true;
  syncLedgerReconciliationForm();
  setStatus("#finance-ledger-reconciliation-status", "Membaca CSV dan membandingkan ledger…");
  try {
    const providerRows = parseProviderCsv(await file.text());
    const result = await api("finance_ledger_reconciliation", {
      method: "POST",
      body: JSON.stringify({
        boothCode: $("#finance-ledger-reconciliation-booth").value,
        provider: $("#finance-ledger-reconciliation-provider").value,
        reference: $("#finance-ledger-reconciliation-reference").value.trim(),
        providerRows,
      }),
    });
    $("#finance-ledger-reconciliation-confirm").checked = false;
    state.ledgerReconciliationLoading = false;
    await Promise.all([refreshLedgerReconciliationRuns(), refreshAudit()]);
    setStatus("#finance-ledger-reconciliation-status", result.run.zeroDifference
      ? `${result.reused ? "Run yang sama digunakan kembali" : "Rekonsiliasi selesai"}: seluruh ${result.run.matchedCount} transaksi cocok.`
      : `Rekonsiliasi selesai dengan ${result.run.mismatchCount} selisih. Periksa laporan sebelum settlement.`, result.run.zeroDifference);
  } catch (error) {
    setStatus("#finance-ledger-reconciliation-status", error.message || "Rekonsiliasi ledger gagal.");
  } finally {
    state.ledgerReconciliationLoading = false;
    $("#finance-ledger-reconciliation-retry").disabled = false;
    syncLedgerReconciliationForm();
  }
});
$("#provider-form").addEventListener("submit", async event => {
  event.preventDefault();
  const definition = state.providerDefinitions.find(item => item.id === $("#provider-id").value);
  const source = $("#provider-source").value;
  const credentials = source === "byo" ? Object.fromEntries([...document.querySelectorAll("[data-provider-credential]")].map(input => [input.dataset.providerCredential, input.value])) : {};
  state.providerLoading = true;
  syncProviderForm();
  setStatus("#provider-status", "Mengenkripsi dan menyimpan credential…");
  try {
    const result = await api("provider_connections", { method: "POST", body: JSON.stringify({
      operation: "save", providerId: definition.id, scope: $("#provider-scope").value, targetId: providerTarget(), source,
      credentials, isDefault: $("#provider-default").checked, expiresAt: $("#provider-expires-at").value || null,
    }) });
    state.providerLoading = false;
    $("#provider-form").reset();
    await refreshProviderConnections();
    setStatus("#provider-status", result.operation === "rotated" ? "Credential diganti, versi lama tidak lagi digunakan." : "Koneksi provider tersimpan terenkripsi.", true);
  } catch (error) { state.providerLoading = false; setStatus("#provider-status", error.message); syncProviderForm(); }
});
$("#provider-entitlement-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.providerEconomicsLoading || !can("platform.integrations.write")) return;
  const scope = $("#provider-entitlement-scope").value;
  const targetId = scope === "global" ? "" : $("#provider-entitlement-target").value;
  const common = {
    providerId: $("#provider-entitlement-id").value,
    scope,
    targetId,
    metric: $("#provider-entitlement-metric").value,
  };
  state.providerEconomicsLoading = true;
  syncProviderEconomicsForm();
  setStatus("#provider-economics-status", "Menyimpan plan dan snapshot pemakaian…");
  try {
    await api("provider_economics", { method: "POST", body: JSON.stringify({
      operation: "save_entitlement",
      ...common,
      plan: $("#provider-entitlement-plan").value,
      allowance: Number($("#provider-entitlement-allowance").value),
      addon: Number($("#provider-entitlement-addon").value),
      monthlyPriceIdr: Number($("#provider-entitlement-price").value),
      hardLimit: $("#provider-entitlement-hard-limit").checked,
    }) });
    await api("provider_economics", { method: "POST", body: JSON.stringify({
      operation: "record_usage",
      ...common,
      used: Number($("#provider-entitlement-used").value),
    }) });
    state.providerEconomicsLoading = false;
    await Promise.all([refreshProviderEconomics(), refreshAudit()]);
    setStatus("#provider-economics-status", "Plan, allowance, add-on, dan snapshot pemakaian tersimpan.", true);
  } catch (error) {
    setStatus("#provider-economics-status", error.message || "Plan provider gagal disimpan");
  } finally {
    state.providerEconomicsLoading = false;
    syncProviderEconomicsForm();
  }
});
$("#provider-migrations-retry").addEventListener("click", refreshProviderMigrations);
$("#provider-migration-source").addEventListener("change", syncProviderMigrationForm);
$("#provider-migration-destination").addEventListener("change", syncProviderMigrationForm);
$("#provider-migration-booth").addEventListener("change", syncProviderMigrationForm);
$("#provider-migration-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.providerMigrationsLoading || !can("platform.integrations.write")) return;
  const sourceProvider = $("#provider-migration-source").value;
  const destinationProvider = $("#provider-migration-destination").value;
  if (sourceProvider === destinationProvider) return setStatus("#provider-migrations-status", "Provider tujuan harus berbeda dari sumber.");
  state.providerMigrationsLoading = true;
  syncProviderMigrationForm();
  setStatus("#provider-migrations-status", "Membuat manifest migrasi…");
  try {
    await api("provider_migrations", { method: "POST", body: JSON.stringify({ operation: "create", boothCode: $("#provider-migration-booth").value, sourceProvider, destinationProvider }) });
    state.providerMigrationsLoading = false;
    await Promise.all([refreshProviderMigrations(), refreshAudit()]);
    setStatus("#provider-migrations-status", "Migrasi dibuat. Worker terjadwal akan melanjutkan otomatis; proses manual tetap tersedia.", true);
  } catch (error) {
    setStatus("#provider-migrations-status", error.message || "Migrasi gagal dibuat");
  } finally {
    state.providerMigrationsLoading = false;
    syncProviderMigrationForm();
  }
});
$("#provider-migration-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-migration-operation]");
  if (!button || state.providerMigrationsLoading || !can("platform.integrations.write")) return;
  button.disabled = true;
  state.providerMigrationsLoading = true;
  syncProviderMigrationForm();
  const operation = button.dataset.migrationOperation;
  if (operation === "finalize" && !window.confirm("Finalisasi cutover setelah seluruh object terverifikasi? Koneksi sumber khusus booth akan dipause, bukan dihapus.")) {
    button.disabled = false;
    state.providerMigrationsLoading = false;
    syncProviderMigrationForm();
    return;
  }
  setStatus("#provider-migrations-status", operation === "process" ? "Menyalin dan memverifikasi object berikutnya…" : operation === "pause" ? "Menjeda migrasi…" : operation === "finalize" ? "Memverifikasi metadata dan memfinalisasi cutover…" : "Melanjutkan migrasi…");
  try {
    await api("provider_migrations", { method: "POST", body: JSON.stringify({ operation, id: button.dataset.migrationId, limit: 1 }) });
    state.providerMigrationsLoading = false;
    await Promise.all([refreshProviderMigrations(), refreshAudit()]);
    setStatus("#provider-migrations-status", operation === "process" ? "Checkpoint object tersimpan." : operation === "pause" ? "Migrasi dijeda." : operation === "finalize" ? "Cutover selesai dan provider sumber ditangani sesuai scope koneksinya." : "Migrasi dilanjutkan.", true);
  } catch (error) {
    setStatus("#provider-migrations-status", error.message || "Operasi migrasi gagal");
    button.disabled = false;
  } finally {
    state.providerMigrationsLoading = false;
    syncProviderMigrationForm();
  }
});
$("#provider-rows").addEventListener("click", async event => {
  const testButton = event.target.closest("[data-provider-test]");
  if (testButton) {
    const [scope, targetId, providerId] = testButton.dataset.providerTest.split("|");
    testButton.disabled = true;
    setStatus("#provider-status", "Menguji credential dan endpoint provider…");
    try {
      const { check } = await api("provider_connections", { method: "POST", body: JSON.stringify({ operation: "test", providerId, scope, targetId }) });
      const latency = Number.isFinite(check?.latencyMs) ? ` · ${check.latencyMs} ms` : "";
      await refreshProviderConnections();
      setStatus("#provider-status", `${check?.message || "Tes koneksi selesai"}${latency}`, check?.state === "ready");
    } catch (error) {
      setStatus("#provider-status", error.message || "Tes koneksi provider gagal");
    } finally {
      testButton.disabled = false;
    }
    return;
  }
  const editButton = event.target.closest("[data-provider-edit]");
  if (editButton) {
    const [scope, targetId, providerId] = editButton.dataset.providerEdit.split("|");
    $("#provider-id").value = providerId;
    $("#provider-scope").value = scope;
    renderProviderTargets();
    if (scope !== "global") $("#provider-target").value = targetId;
    $("#provider-source").value = "byo";
    syncProviderForm();
    $("#provider-form").scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus("#provider-status", "Isi credential baru. Nilai lama tidak dapat dilihat kembali.");
    return;
  }
  const button = event.target.closest("[data-provider-state]");
  if (!button) return;
  const [scope, targetId, providerId] = button.dataset.providerKey.split("|");
  const operation = button.dataset.providerState;
  if (operation === "revoked" && !confirm("Cabut dan hapus credential provider ini? Tindakan ini tidak dapat dibatalkan.")) return;
  button.disabled = true;
  setStatus("#provider-status", operation === "rewrap" ? "Merotasi enkripsi credential…" : "Memperbarui status koneksi…");
  try {
    await api("provider_connections", { method: "POST", body: JSON.stringify({ operation, providerId, scope, targetId }) });
    await refreshProviderConnections();
    setStatus("#provider-status", operation === "revoked" ? "Credential dicabut dan ciphertext dihapus." : operation === "rewrap" ? "Credential dienkripsi ulang dengan kunci aktif." : "Status koneksi diperbarui.", true);
  } catch (error) { setStatus("#provider-status", error.message); button.disabled = false; }
});
$("#remote-jobs-retry").addEventListener("click", refreshRemoteJobs);
$("#webhook-events-retry").addEventListener("click", refreshWebhookEvents);
$("#remote-job-form").addEventListener("submit", async event => {
  event.preventDefault();
  const machineId = $("#remote-job-machine").value;
  const type = $("#remote-job-type").value;
  if (!machineId) return setStatus("#remote-jobs-status", "Pilih photobox terlebih dahulu.");
  if (type === "service.restart" && !confirm("Restart Controller photobox ini? Booth dapat tidak merespons selama beberapa detik.")) return;
  if (type === "agent.update.apply" && !confirm("Pasang update Agent yang sudah diverifikasi pada photobox ini? Booth lokal tetap berjalan, tetapi Agent perlu restart setelah instalasi.")) return;
  if (type === "agent.update.rollback" && !confirm("Rollback Agent photobox ini ke backup update terakhir? Foto dan database sesi tidak diubah.")) return;
  state.remoteJobSending = true;
  syncRemoteJobForm();
  setStatus("#remote-jobs-status", "Mengirim perintah aman ke antrean…");
  try {
    const idempotencyKey = `superadmin.${machineId}.${type}.${crypto.randomUUID()}`;
    const result = await api("remote_jobs", { method: "POST", body: JSON.stringify({ operation: "create", machineId, type, idempotencyKey }) });
    await refreshRemoteJobs();
    setStatus("#remote-jobs-status", result.reused ? "Perintah yang sama sudah berada di antrean." : "Perintah berhasil ditambahkan ke antrean.", true);
  } catch (error) { setStatus("#remote-jobs-status", error.message); }
  finally { state.remoteJobSending = false; syncRemoteJobForm(); }
});
$("#remote-job-rows").addEventListener("click", async event => {
  const button = event.target.closest("[data-retry-job]");
  if (!button) return;
  button.disabled = true;
  setStatus("#remote-jobs-status", "Mengantrekan ulang perintah…");
  try {
    const result = await api("remote_jobs", { method: "POST", body: JSON.stringify({ jobId: button.dataset.retryJob }) });
    await refreshRemoteJobs();
    setStatus("#remote-jobs-status", result.reused ? "Retry yang sama sudah berada di antrean." : "Perintah baru berhasil dimasukkan ke antrean.", true);
  } catch (error) { setStatus("#remote-jobs-status", error.message); button.disabled = false; }
});
$("#audit-retry").addEventListener("click", refreshAudit);
$("#platform-frame-retry").addEventListener("click", refreshPlatformFrames);
$("#platform-frame-upload").addEventListener("click", () => { $("#platform-frame-file").value = ""; $("#platform-frame-file").click(); });
$("#platform-frame-file").addEventListener("change", event => uploadPlatformFrame(event.target.files?.[0]));
$("#platform-frame-grid").addEventListener("click", event => {
  const retry = event.target.closest("#platform-frame-inline-retry");
  if (retry) { refreshPlatformFrames(); return; }
  const remove = event.target.closest("[data-platform-frame-delete]");
  if (remove) deletePlatformFrame(remove);
});
$("#super-logout").addEventListener("click", async () => { await api("logout", { method: "POST" }); location.reload(); });
$("#super-domain-nav").addEventListener("click", event => {
  const button = event.target.closest("[data-super-domain]");
  if (button) showSuperDomain(button.dataset.superDomain);
});
const activationParams = new URLSearchParams(location.search);
if (activationParams.get("invite") && activationParams.get("email")) {
  $("#super-login").hidden = true;
  $("#platform-activate").hidden = false;
  $("#platform-activate-email").value = activationParams.get("email");
  $("#super-login-title").textContent = "Aktifkan akun tim";
  $("#super-login-copy").textContent = "Buat password kuat untuk mengaktifkan akses control plane.";
} else {
  api("superadmin_session").then(({ authenticated }) => authenticated && load().catch(() => {})).catch(() => {});
}
