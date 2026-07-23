const button = document.querySelector("#refresh-public-status");
const banner = document.querySelector("#public-status-banner");
const title = document.querySelector("#public-status-title");
const notice = document.querySelector("#public-status-notice");
const list = document.querySelector("#status-component-list");
const updated = document.querySelector("#public-status-updated");

const labels = {
  operational: "Beroperasi normal",
  degraded: "Sebagian terbatas",
  limited: "Kemampuan terbatas",
  outage: "Sedang terganggu",
};

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function render(result) {
  const state = ["operational", "degraded", "outage"].includes(result.overall) ? result.overall : "outage";
  banner.className = `public-status-banner is-${state}`;
  title.textContent = labels[state];
  notice.textContent = result.notice;
  list.innerHTML = result.components.map(component => `<article class="status-component is-${escapeHtml(component.state)}"><span aria-hidden="true"></span><div><strong>${escapeHtml(component.label)}</strong><small>${escapeHtml(labels[component.state] || "Tidak diketahui")}</small></div></article>`).join("");
  updated.textContent = `Terakhir diperiksa ${new Date(result.checkedAt).toLocaleString("id-ID")}`;
}

function renderError(message) {
  banner.className = "public-status-banner is-outage";
  title.textContent = "Status belum dapat diperiksa";
  notice.textContent = message || "Koneksi ke status cloud gagal. Coba lagi.";
  updated.textContent = "Pemeriksaan gagal.";
}

async function refresh() {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("/api/platform?action=public_status", { signal: controller.signal, headers: { accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Pemeriksaan gagal (${response.status})`);
    render(payload);
  } catch (error) {
    renderError(error?.name === "AbortError" ? "Pemeriksaan melewati batas 8 detik. Coba lagi." : error.message);
  } finally {
    clearTimeout(timeout);
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

button.addEventListener("click", refresh);
refresh();
