#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/Library/Application Support/Photoslive"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
ARCHIVE="${TMPDIR:-/tmp}/photoslive-agent.zip"
UV_INSTALLER="${TMPDIR:-/tmp}/photoslive-uv-installer.sh"
UV_DIR="${INSTALL_DIR}/bootstrap"
UV_BIN="${UV_DIR}/uv"
MANAGED_PYTHON_DIR="${INSTALL_DIR}/python"
LOG_DIR="${INSTALL_DIR}/logs"
UV_VERSION="0.11.32"

mkdir -p "${INSTALL_DIR}" "${LAUNCH_DIR}" "${LOG_DIR}"
command -v curl >/dev/null || { echo "curl wajib tersedia."; exit 1; }
command -v unzip >/dev/null || { echo "unzip wajib tersedia."; exit 1; }
curl --fail --location --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 --max-time 180 "https://photoslive.vercel.app/downloads/photoslive-agent.zip" -o "${ARCHIVE}"
rm -rf "${INSTALL_DIR}/source"
unzip -q "${ARCHIVE}" -d "${INSTALL_DIR}/source"
SOURCE_DIR="${INSTALL_DIR}/source/photobox"
test -f "${SOURCE_DIR}/agent.py" || { echo "Paket Photoslive Agent tidak valid."; exit 1; }
test -f "${SOURCE_DIR}/updater.py" || { echo "Paket Photoslive tidak lengkap (updater.py tidak ditemukan)."; exit 1; }
test -f "${SOURCE_DIR}/requirements-controller.txt" || { echo "Daftar dependency Controller tidak ditemukan."; exit 1; }

PYTHON=""
if command -v python3 >/dev/null && python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'; then
  PYTHON="$(command -v python3)"
  echo "Menggunakan Python kompatibel: $("${PYTHON}" --version 2>&1)"
  rm -rf "${INSTALL_DIR}/runtime"
  "${PYTHON}" -m venv "${INSTALL_DIR}/runtime"
else
  echo "Python bawaan macOS terlalu lama. Menyiapkan runtime Python 3.12 khusus Photoslive..."
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

RUNTIME_PYTHON="${INSTALL_DIR}/runtime/bin/python"
test -x "${RUNTIME_PYTHON}" || { echo "Runtime Python Photoslive tidak terbentuk."; exit 1; }
if test -x "${UV_BIN}"; then
  env UV_CACHE_DIR="${INSTALL_DIR}/cache" "${UV_BIN}" pip install --python "${RUNTIME_PYTHON}" -r "${SOURCE_DIR}/requirements-controller.txt"
  rm -rf "${INSTALL_DIR}/cache"
else
  "${RUNTIME_PYTHON}" -m pip install --disable-pip-version-check --no-input -r "${SOURCE_DIR}/requirements-controller.txt"
fi

cat > "${LAUNCH_DIR}/app.photoslive.controller.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.photoslive.controller</string><key>ProgramArguments</key><array><string>${RUNTIME_PYTHON}</string><string>${SOURCE_DIR}/server.py</string></array><key>WorkingDirectory</key><string>${SOURCE_DIR}</string><key>StandardOutPath</key><string>${LOG_DIR}/controller.stdout.log</string><key>StandardErrorPath</key><string>${LOG_DIR}/controller.stderr.log</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
cat > "${LAUNCH_DIR}/app.photoslive.agent.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.photoslive.agent</string><key>ProgramArguments</key><array><string>${RUNTIME_PYTHON}</string><string>${SOURCE_DIR}/agent.py</string></array><key>WorkingDirectory</key><string>${SOURCE_DIR}</string><key>StandardOutPath</key><string>${LOG_DIR}/agent.stdout.log</string><key>StandardErrorPath</key><string>${LOG_DIR}/agent.stderr.log</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.controller.plist" 2>/dev/null || true
launchctl bootout "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.agent.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.controller.plist"

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
  echo "Log error terakhir:" >&2
  tail -n 30 "${LOG_DIR}/controller.stderr.log" 2>/dev/null >&2 || true
  echo "Buka log lengkap: ${LOG_DIR}/controller.stderr.log" >&2
  exit 1
fi
if [ -n "${PHOTOSLIVE_HELPER_BOOTSTRAP:-}" ]; then
  "${RUNTIME_PYTHON}" "${SOURCE_DIR}/agent.py" --helper-bootstrap "${PHOTOSLIVE_HELPER_BOOTSTRAP}"
  launchctl bootstrap "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.agent.plist"
  echo "Photoslive Helper terpasang dan akan hidup otomatis bersama komputer."
else
  launchctl bootstrap "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.agent.plist"
  echo "Photoslive Helper terpasang tanpa booth aktif. Hubungkan dari Admin sebelum digunakan."
  "${RUNTIME_PYTHON}" "${SOURCE_DIR}/agent.py" --setup-link --open-setup
fi
echo "Status lokal terakhir:"
"${RUNTIME_PYTHON}" "${SOURCE_DIR}/agent.py" --status || true
