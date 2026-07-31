const $ = selector => document.querySelector(selector);

const state = {
  account: null,
  loading: false,
  firstBoothCode: "",
};

function setStatus(message = "", kind = "error") {
  const node = $("#account-status");
  node.textContent = message;
  node.className = `account-alert${message ? ` ${kind}` : ""}`;
}

function setButtonBusy(button, busy, label = "Memuat…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.textContent = label;
    button.setAttribute("aria-busy", "true");
  } else {
    if (button.dataset.label) button.innerHTML = button.dataset.label;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function api(action, options = {}) {
  const response = await fetch(`/api/platform?action=${encodeURIComponent(action)}`, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Permintaan gagal (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function machineById(machineId) {
  return (state.account?.machines || []).find(machine => String(machine.machineId || machine.id) === String(machineId || "")) || null;
}

function machineStatus(machine) {
  const paired = machine?.paired !== false && String(machine?.status || "paired") !== "revoked";
  return paired
    ? { label: "TERHUBUNG", className: "machine-card-status" }
    : { label: "PERLU DIPERIKSA", className: "machine-card-status off" };
}

function createMachineCard(booth, fallbackMachine = null) {
  const machine = machineById(booth?.machineId) || fallbackMachine || {};
  const status = machineStatus(machine);
  const boothCode = String(booth?.boothCode || "");
  const machineCode = String(machine.machineCode || machine.machine_code || machine.machineId || machine.id || "—");
  const platform = String(machine.platform || machine.os || machine.system || "Belum dilaporkan");
  const article = document.createElement("article");
  article.className = "machine-card";

  const top = document.createElement("div");
  top.className = "machine-card-top";
  const titleWrap = document.createElement("div");
  const label = document.createElement("span");
  label.className = "machine-card-label";
  label.textContent = boothCode || "MESIN BELUM MEMILIKI BOOTH";
  const title = document.createElement("h3");
  title.textContent = booth?.name || machine.name || "Photoslive Booth";
  const location = document.createElement("p");
  location.className = "machine-card-location";
  location.textContent = booth?.location || machine.location || "Lokasi belum diatur";
  titleWrap.append(label, title, location);
  const badge = document.createElement("span");
  badge.className = status.className;
  badge.textContent = status.label;
  top.append(titleWrap, badge);

  const meta = document.createElement("div");
  meta.className = "machine-card-meta";
  [["KODE MESIN", machineCode], ["SISTEM", platform]].forEach(([key, value]) => {
    const block = document.createElement("div");
    const small = document.createElement("span");
    const strong = document.createElement("strong");
    small.textContent = key;
    strong.textContent = value;
    block.append(small, strong);
    meta.append(block);
  });

  const actions = document.createElement("div");
  actions.className = "machine-card-actions";
  if (boothCode) {
    const open = document.createElement("a");
    open.className = "btn primary";
    open.href = `/${encodeURIComponent(boothCode)}/admin`;
    open.innerHTML = '<img src="/icons/settings.svg" alt="">Pengaturan photobox';
    const boothPage = document.createElement("a");
    boothPage.className = "btn";
    boothPage.href = `/${encodeURIComponent(boothCode)}`;
    boothPage.innerHTML = '<img src="/icons/monitor.svg" alt="">Buka booth';
    actions.append(open, boothPage);
    const hint = document.createElement("p");
    hint.className = "machine-card-hint";
    hint.textContent = "Atur tampilan, sesi, pembayaran, perangkat, dan penyimpanan dari pengaturan photobox.";
    article.append(hint);
  } else {
    const pair = document.createElement("a");
    pair.className = "btn primary";
    pair.href = "/setup?mode=pairing";
    pair.textContent = "Selesaikan pairing";
    actions.append(pair);
  }
  article.append(top, meta, actions);
  return article;
}

function renderAccount(account) {
  const legacyBooth = account?.booth && !Array.isArray(account.booths) ? account.booth : null;
  const booths = Array.isArray(account.booths) ? account.booths : legacyBooth ? [legacyBooth] : [];
  const legacyMachine = legacyBooth?.machineId ? [{
    machineId: legacyBooth.machineId,
    machineCode: legacyBooth.machineCode || legacyBooth.machineId,
    name: legacyBooth.name,
    location: legacyBooth.location,
    status: legacyBooth.enabled === false ? "revoked" : "paired",
  }] : [];
  const machines = Array.isArray(account.machines) ? account.machines : legacyMachine;
  state.account = { ...account, booths, machines };
  state.firstBoothCode = String(booths[0]?.boothCode || "");
  const user = account.user || {};
  const organization = account.organization || {};

  $("#account-admin-code").textContent = user.adminCode || "Belum tersedia";
  $("#account-email").textContent = user.email || "—";
  $("#account-settings-email").value = user.email || "";
  $("#account-organization").textContent = organization.name || user.organizationName || "Organisasi";
  $("#account-role").textContent = `${organization.code || user.organizationCode || "—"} · ${String(user.role || "owner").toUpperCase()}`;
  $("#account-machine-count").textContent = String(machines.length);
  $("#account-summary").textContent = booths.length
    ? `${booths.length} photobox dalam organisasi ini`
    : "Akun siap; belum ada mesin yang dihubungkan";

  const grid = $("#account-machine-grid");
  grid.replaceChildren();
  booths.forEach(booth => grid.append(createMachineCard(booth)));
  const represented = new Set(booths.map(booth => String(booth.machineId || "")));
  machines.filter(machine => !represented.has(String(machine.machineId || machine.id || "")))
    .forEach(machine => grid.append(createMachineCard(null, machine)));

  const hasMachine = grid.childElementCount > 0;
  const usersLink = $("#account-users-link");
  if (state.firstBoothCode) {
    usersLink.href = `/${encodeURIComponent(state.firstBoothCode)}/admin?view=users`;
    usersLink.classList.remove("is-disabled");
    usersLink.removeAttribute("aria-disabled");
    usersLink.querySelector("small").textContent = "Kelola Owner, Admin, Operator, dan sesi login photobox ini.";
  } else {
    usersLink.removeAttribute("href");
    usersLink.classList.add("is-disabled");
    usersLink.setAttribute("aria-disabled", "true");
  }
  $("#account-loading").hidden = true;
  $("#account-empty").hidden = hasMachine;
  grid.hidden = !hasMachine;
}

async function loadAccount() {
  if (state.loading) return;
  state.loading = true;
  const refresh = $("#refresh-account");
  setButtonBusy(refresh, true, "Memuat…");
  setStatus("");
  try {
    const account = await api("me");
    if (!account?.user?.id) throw Object.assign(new Error("Session Admin tidak ditemukan"), { status: 401 });
    renderAccount(account);
  } catch (error) {
    $("#account-loading").hidden = true;
    if (error.status === 401) {
      location.replace("/setup?mode=login");
      return;
    }
    setStatus(`${error.message}. Periksa koneksi lalu coba lagi.`);
    $("#account-empty").hidden = false;
    $("#account-machine-grid").hidden = true;
  } finally {
    state.loading = false;
    setButtonBusy(refresh, false);
  }
}

$("#refresh-account").addEventListener("click", loadAccount);

function setSettingsStatus(message = "", kind = "") {
  const node = $("#account-settings-status");
  node.textContent = message;
  node.className = `account-settings-status${kind ? ` ${kind}` : ""}`;
}

function openAccountSettings() {
  setSettingsStatus("");
  $("#account-settings-password").value = "";
  $("#account-settings-confirm").value = "";
  $("#account-settings-dialog").showModal();
  $("#account-settings-password").focus();
}

function closeAccountSettings() {
  if ($("#account-settings-dialog").open) $("#account-settings-dialog").close();
}

$("#open-account-settings").addEventListener("click", openAccountSettings);
$("#open-account-settings-mobile").addEventListener("click", openAccountSettings);
$("#close-account-settings").addEventListener("click", closeAccountSettings);
$("#cancel-account-settings").addEventListener("click", closeAccountSettings);
$("#account-settings-dialog").addEventListener("click", event => {
  if (event.target === event.currentTarget) closeAccountSettings();
});
$("#account-users-link").addEventListener("click", event => {
  if (event.currentTarget.classList.contains("is-disabled")) event.preventDefault();
});
$("#account-settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  const password = $("#account-settings-password").value;
  const confirmation = $("#account-settings-confirm").value;
  if (password.length < 8) {
    setSettingsStatus("Password minimal 8 karakter.");
    $("#account-settings-password").focus();
    return;
  }
  if (password !== confirmation) {
    setSettingsStatus("Konfirmasi password tidak sama.");
    $("#account-settings-confirm").focus();
    return;
  }
  const button = $("#save-account-settings");
  setButtonBusy(button, true, "Menyimpan…");
  setSettingsStatus("");
  try {
    await api("profile", { method: "POST", body: JSON.stringify({ password }) });
    $("#account-settings-password").value = "";
    $("#account-settings-confirm").value = "";
    setSettingsStatus("Password berhasil diperbarui.", "success");
  } catch (error) {
    if (error.status === 401) {
      location.replace("/setup?mode=login");
      return;
    }
    setSettingsStatus(error.message || "Password belum dapat diperbarui.");
  } finally {
    setButtonBusy(button, false);
  }
});

$("#account-logout").addEventListener("click", async event => {
  const button = event.currentTarget;
  setButtonBusy(button, true, "Keluar…");
  try {
    await api("logout", { method: "POST", body: "{}" });
  } finally {
    location.replace("/setup?mode=login");
  }
});

loadAccount();
