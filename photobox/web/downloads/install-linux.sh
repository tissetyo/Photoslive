#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/share/photoslive"
SERVICE_DIR="${HOME}/.config/systemd/user"
ARCHIVE="${TMPDIR:-/tmp}/photoslive-agent.zip"

command -v python3 >/dev/null || { echo "Python 3 wajib tersedia."; exit 1; }
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || { echo "Photoslive memerlukan Python 3.10 atau lebih baru."; exit 1; }
command -v curl >/dev/null || { echo "curl wajib tersedia."; exit 1; }
command -v unzip >/dev/null || { echo "unzip wajib tersedia."; exit 1; }

mkdir -p "${INSTALL_DIR}" "${SERVICE_DIR}"
curl --fail --location --retry 5 --retry-delay 3 --retry-all-errors --connect-timeout 20 --max-time 180 "https://photoslive.vercel.app/downloads/photoslive-agent.zip" -o "${ARCHIVE}"
rm -rf "${INSTALL_DIR}/source"
unzip -q "${ARCHIVE}" -d "${INSTALL_DIR}/source"
SOURCE_DIR="${INSTALL_DIR}/source/photobox"
test -f "${SOURCE_DIR}/agent.py" || { echo "Paket Photoslive Agent tidak valid."; exit 1; }
test -f "${SOURCE_DIR}/requirements-controller.txt" || { echo "Daftar dependency Controller tidak ditemukan."; exit 1; }
python3 -m venv "${INSTALL_DIR}/runtime" || { echo "Python venv belum tersedia. Instal paket python3-venv lalu jalankan installer lagi."; exit 1; }
RUNTIME_PYTHON="${INSTALL_DIR}/runtime/bin/python"
"${RUNTIME_PYTHON}" -m pip install --disable-pip-version-check --no-input -r "${SOURCE_DIR}/requirements-controller.txt"

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
sleep 3
"${RUNTIME_PYTHON}" "${SOURCE_DIR}/agent.py" --status
echo "Photoslive Agent diperbarui dan service sudah direstart."
"${RUNTIME_PYTHON}" "${SOURCE_DIR}/agent.py" --setup-code --open-setup
