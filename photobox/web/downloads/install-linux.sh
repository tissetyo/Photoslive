#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/share/photoslive"
SERVICE_DIR="${HOME}/.config/systemd/user"
ARCHIVE="${TMPDIR:-/tmp}/photoslive-agent.zip"
UV_INSTALLER="${TMPDIR:-/tmp}/photoslive-uv-installer.sh"
UV_DIR="${INSTALL_DIR}/bootstrap"
UV_BIN="${UV_DIR}/uv"
MANAGED_PYTHON_DIR="${INSTALL_DIR}/python"
UV_VERSION="0.11.32"
AGENT_ARCHIVE_SOURCE="${PHOTOSLIVE_AGENT_ARCHIVE:-https://photoslive.vercel.app/downloads/photoslive-agent.zip}"

command -v curl >/dev/null || { echo "curl wajib tersedia."; exit 1; }
mkdir -p "${INSTALL_DIR}" "${SERVICE_DIR}"

RUNTIME_PYTHON="${INSTALL_DIR}/runtime/bin/python"
RUNTIME_READY=0
if [ "${PHOTOSLIVE_FORCE_MANAGED_PYTHON:-0}" != "1" ] && command -v python3 >/dev/null && python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  SYSTEM_PYTHON="$(command -v python3)"
  echo "Menggunakan Python kompatibel: $("${SYSTEM_PYTHON}" --version 2>&1)"
  rm -rf "${INSTALL_DIR}/runtime"
  if "${SYSTEM_PYTHON}" -m venv "${INSTALL_DIR}/runtime"; then
    RUNTIME_READY=1
  else
    echo "Modul venv sistem tidak tersedia. Menyiapkan runtime Python 3.12 khusus Photoslive..."
  fi
else
  echo "Python sistem belum kompatibel. Menyiapkan runtime Python 3.12 khusus Photoslive..."
fi

if [ "${RUNTIME_READY}" -ne 1 ]; then
  mkdir -p "${UV_DIR}" "${MANAGED_PYTHON_DIR}"
  curl --fail --location --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 --max-time 180 \
    "https://astral.sh/uv/${UV_VERSION}/install.sh" -o "${UV_INSTALLER}"
  env UV_UNMANAGED_INSTALL="${UV_DIR}" sh "${UV_INSTALLER}"
  test -x "${UV_BIN}" || { echo "Runtime bootstrap Photoslive gagal dipasang."; exit 1; }
  rm -rf "${INSTALL_DIR}/runtime"
  env \
    UV_MANAGED_PYTHON=1 \
    UV_PYTHON_INSTALL_DIR="${MANAGED_PYTHON_DIR}" \
    UV_CACHE_DIR="${INSTALL_DIR}/cache" \
    "${UV_BIN}" venv --python 3.12 "${INSTALL_DIR}/runtime"
fi

test -x "${RUNTIME_PYTHON}" || { echo "Runtime Python Photoslive tidak terbentuk."; exit 1; }
if test -f "${AGENT_ARCHIVE_SOURCE}"; then
  cp "${AGENT_ARCHIVE_SOURCE}" "${ARCHIVE}"
else
  curl --fail --location --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 --max-time 180 "${AGENT_ARCHIVE_SOURCE}" -o "${ARCHIVE}"
fi
rm -rf "${INSTALL_DIR}/source"
"${RUNTIME_PYTHON}" -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "${ARCHIVE}" "${INSTALL_DIR}/source"
SOURCE_DIR="${INSTALL_DIR}/source/photobox"
test -f "${SOURCE_DIR}/agent.py" || { echo "Paket Photoslive Agent tidak valid."; exit 1; }
test -f "${SOURCE_DIR}/updater.py" || { echo "Paket Photoslive tidak lengkap (updater.py tidak ditemukan)."; exit 1; }
test -f "${SOURCE_DIR}/requirements-controller.txt" || { echo "Daftar dependency Controller tidak ditemukan."; exit 1; }
if test -x "${UV_BIN}"; then
  env UV_CACHE_DIR="${INSTALL_DIR}/cache" "${UV_BIN}" pip install --python "${RUNTIME_PYTHON}" -r "${SOURCE_DIR}/requirements-controller.txt"
  rm -rf "${INSTALL_DIR}/cache"
else
  "${RUNTIME_PYTHON}" -m pip install --disable-pip-version-check --no-input -r "${SOURCE_DIR}/requirements-controller.txt"
fi

if [ "${PHOTOSLIVE_INSTALLER_RUNTIME_ONLY:-0}" = "1" ]; then
  echo "Runtime Python Photoslive siap: $("${RUNTIME_PYTHON}" --version 2>&1)"
  exit 0
fi

cat > "${SERVICE_DIR}/photoslive-controller.service" <<EOF
[Unit]
Description=Photoslive Local Controller
After=network.target

[Service]
WorkingDirectory=${SOURCE_DIR}
ExecStart=${RUNTIME_PYTHON} ${SOURCE_DIR}/server.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

cat > "${SERVICE_DIR}/photoslive-agent.service" <<EOF
[Unit]
Description=Photoslive Cloud Agent
After=network-online.target photoslive-controller.service

[Service]
WorkingDirectory=${SOURCE_DIR}
ExecStart=${RUNTIME_PYTHON} ${SOURCE_DIR}/agent.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable photoslive-controller.service photoslive-agent.service
systemctl --user restart photoslive-controller.service photoslive-agent.service

CONTROLLER_READY=0
for _ in $(seq 1 30); do
  SETUP_PAGE=""
  if curl --silent --fail --max-time 2 "http://127.0.0.1:8080/api/health" >/dev/null 2>&1 \
    && SETUP_PAGE="$(curl --silent --fail --max-time 3 "http://127.0.0.1:8080/setup?local=1" 2>/dev/null)" \
    && [[ "${SETUP_PAGE}" == *"<title>Setup Photoslive</title>"* ]]; then
    CONTROLLER_READY=1
    break
  fi
  sleep 1
done
if [ "${CONTROLLER_READY}" -ne 1 ]; then
  echo "Photoslive Controller atau halaman setup lokal gagal dijalankan. Browser tidak akan dibuka." >&2
  systemctl --user status photoslive-controller.service --no-pager >&2 || true
  journalctl --user -u photoslive-controller.service -n 30 --no-pager >&2 || true
  exit 1
fi
echo "Photoslive Agent diperbarui dan service sudah direstart."
"${RUNTIME_PYTHON}" "${SOURCE_DIR}/agent.py" --setup-link --open-setup
echo "Status lokal terakhir:"
"${RUNTIME_PYTHON}" "${SOURCE_DIR}/agent.py" --status || true
