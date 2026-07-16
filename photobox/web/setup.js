const $ = selector => document.querySelector(selector);

const api = async (action, options = {}) => {
  const response = await fetch(`/api/platform?action=${action}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request gagal (${response.status})`);
  return data;
};

const status = (message, success = false) => {
  $("#setup-status").textContent = message;
  $("#setup-status").classList.toggle("success", success);
};

function mode(name) {
  document.querySelectorAll("[data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === name));
  ["setup", "login", "forgot"].forEach(value => $(`#${value}-form`).classList.toggle("hidden", value !== name));
  $("#setup-modes").classList.toggle("hidden", name === "forgot");
  $("#agent-recovery").classList.toggle("hidden", name === "forgot");
  const labels = {
    setup: ["Setup photobox", "Hubungkan mesin dan buat akun pemilik."],
    login: ["Masuk", "Pilih cara masuk ke admin photobox."],
    forgot: ["Bantuan password", "Kirim permintaan kepada superadmin."],
  };
  $("#setup-title").textContent = labels[name][0];
  $("#setup-copy").textContent = labels[name][1];
  const booth = $("#login-booth").value.trim();
  const query = new URLSearchParams();
  if (name !== "setup") query.set("mode", name);
  if (booth) query.set("booth", booth);
  history.replaceState(null, "", query.size ? `/setup?${query}` : "/setup");
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

document.querySelectorAll("[data-mode]").forEach(button => button.addEventListener("click", () => mode(button.dataset.mode)));
$("#open-forgot").addEventListener("click", () => mode("forgot"));
$("#forgot-back").addEventListener("click", () => mode("login"));
document.querySelectorAll("[data-login-method]").forEach(button => button.addEventListener("click", () => loginMethod(button.dataset.loginMethod)));
$("#copy-setup-command").addEventListener("click", async () => {
  const command = $("#setup-code-command").textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
    } else {
      const temporary = document.createElement("textarea");
      temporary.value = command;
      temporary.setAttribute("readonly", "");
      temporary.style.position = "fixed";
      temporary.style.opacity = "0";
      document.body.appendChild(temporary);
      temporary.select();
      const copied = document.execCommand("copy");
      temporary.remove();
      if (!copied) throw new Error("Copy tidak didukung");
    }
    $("#copy-feedback").textContent = "Perintah berhasil disalin.";
    $("#copy-setup-command span").textContent = "Tersalin";
    setTimeout(() => {
      $("#copy-feedback").textContent = "";
      $("#copy-setup-command span").textContent = "Salin";
    }, 5000);
  } catch {
    $("#copy-feedback").textContent = "Tidak dapat menyalin otomatis. Blok perintah lalu salin manual.";
  }
});

$("#setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  status("Menghubungkan mesin dan membuat akun…");
  try {
    const body = {
      pairingCode: $("#pairing-code").value,
      name: $("#booth-name").value,
      location: $("#booth-location").value,
      email: $("#owner-email").value,
      password: $("#owner-password").value,
      userName: $("#owner-name").value,
      pin: $("#owner-pin").value,
      confirmPin: $("#owner-pin-confirm").value,
    };
    const result = await api("setup", { method: "POST", body: JSON.stringify(body) });
    localStorage.setItem("photoslive.machineId", result.booth.machineId);
    localStorage.setItem("photoslive.boothCode", result.booth.boothCode);
    status("Setup berhasil. Membuka admin…", true);
    location.href = `/${result.booth.boothCode}/admin`;
  } catch (error) {
    status(error.message);
  }
});

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  status("Memeriksa akun…");
  try {
    const body = {
      boothCode: $("#login-booth").value,
      email: $("#login-email").value,
      password: $("#login-password").value,
      pin: $("#login-pin").value,
    };
    const result = await api("login", { method: "POST", body: JSON.stringify(body) });
    localStorage.setItem("photoslive.machineId", result.booth.machineId);
    localStorage.setItem("photoslive.boothCode", result.booth.boothCode);
    location.href = `/${result.booth.boothCode}/admin`;
  } catch (error) {
    status(error.message);
  }
});

$("#forgot-form").addEventListener("submit", async event => {
  event.preventDefault();
  status("Mengirim permintaan…");
  try {
    await api("forgot_password", { method: "POST", body: JSON.stringify({ email: $("#forgot-email").value, message: $("#forgot-message").value }) });
    status("Permintaan diterima. Superadmin akan memeriksa dan menghubungi Anda secara manual.", true);
  } catch (error) {
    status(error.message);
  }
});

const params = new URLSearchParams(location.search);
if (params.get("booth")) $("#login-booth").value = params.get("booth");
loginMethod("pin");
mode(params.get("mode") || "setup");
