#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.local/share/photoslive"
SERVICE_DIR="${HOME}/.config/systemd/user"
ARCHIVE="${TMPDIR:-/tmp}/photoslive-main.zip"

command -v python3 >/dev/null || { echo "Python 3 wajib tersedia."; exit 1; }
command -v curl >/dev/null || { echo "curl wajib tersedia."; exit 1; }
command -v unzip >/dev/null || { echo "unzip wajib tersedia."; exit 1; }

mkdir -p "${INSTALL_DIR}" "${SERVICE_DIR}"
curl -fL "https://github.com/tissetyo/Photoslive/archive/refs/heads/main.zip" -o "${ARCHIVE}"
rm -rf "${INSTALL_DIR}/source"
unzip -q "${ARCHIVE}" -d "${INSTALL_DIR}/source"
SOURCE_DIR="$(find "${INSTALL_DIR}/source" -maxdepth 1 -type d -name 'Photoslive-*' | head -n 1)/photobox"

cat > "${SERVICE_DIR}/photoslive-controller.service" <<EOF
[Unit]
Description=Photoslive Local Controller
After=network.target

[Service]
WorkingDirectory=${SOURCE_DIR}
ExecStart=$(command -v python3) ${SOURCE_DIR}/server.py
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
ExecStart=$(command -v python3) ${SOURCE_DIR}/agent.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now photoslive-controller.service photoslive-agent.service
sleep 3
python3 "${SOURCE_DIR}/agent.py" --status
echo "Photoslive terpasang. Kode pairing juga tersedia di: ${HOME}/.config/photoslive/agent-status.json"
