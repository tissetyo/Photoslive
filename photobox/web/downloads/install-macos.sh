#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/Library/Application Support/Photoslive"
LAUNCH_DIR="${HOME}/Library/LaunchAgents"
ARCHIVE="${TMPDIR:-/tmp}/photoslive-agent.zip"

mkdir -p "${INSTALL_DIR}" "${LAUNCH_DIR}"
curl -fL "https://photoslive.vercel.app/downloads/photoslive-agent.zip" -o "${ARCHIVE}"
rm -rf "${INSTALL_DIR}/source"
unzip -q "${ARCHIVE}" -d "${INSTALL_DIR}/source"
SOURCE_DIR="${INSTALL_DIR}/source/photobox"
test -f "${SOURCE_DIR}/agent.py" || { echo "Paket Photoslive Agent tidak valid."; exit 1; }
PYTHON="$(command -v python3)"

cat > "${LAUNCH_DIR}/app.photoslive.controller.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.photoslive.controller</string><key>ProgramArguments</key><array><string>${PYTHON}</string><string>${SOURCE_DIR}/server.py</string></array><key>WorkingDirectory</key><string>${SOURCE_DIR}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
cat > "${LAUNCH_DIR}/app.photoslive.agent.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.photoslive.agent</string><key>ProgramArguments</key><array><string>${PYTHON}</string><string>${SOURCE_DIR}/agent.py</string></array><key>WorkingDirectory</key><string>${SOURCE_DIR}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.controller.plist" 2>/dev/null || true
launchctl bootout "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.agent.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.controller.plist"
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_DIR}/app.photoslive.agent.plist"
sleep 3
"${PYTHON}" "${SOURCE_DIR}/agent.py" --status
echo "Photoslive Agent diperbarui dan service sudah direstart."
"${PYTHON}" "${SOURCE_DIR}/agent.py" --setup-code
