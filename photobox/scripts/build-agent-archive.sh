#!/usr/bin/env bash
set -euo pipefail

PHOTOBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${PHOTOBOX_DIR}/web/downloads/photoslive-agent.zip"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/photoslive-agent.XXXXXX")"
PACKAGE="${STAGE}/photobox"
ARCHIVE="${OUTPUT}.$$.new"

mkdir -p "${PACKAGE}/web" "${PACKAGE}/contracts"
cp "${PHOTOBOX_DIR}/agent.py" "${PACKAGE}/agent.py"
cp "${PHOTOBOX_DIR}/server.py" "${PACKAGE}/server.py"
cp "${PHOTOBOX_DIR}/redaction.py" "${PACKAGE}/redaction.py"
cp "${PHOTOBOX_DIR}/requirements-controller.txt" "${PACKAGE}/requirements-controller.txt"
cp -R "${PHOTOBOX_DIR}/contracts/v2" "${PACKAGE}/contracts/v2"
cp "${PHOTOBOX_DIR}/contracts/README.md" "${PACKAGE}/contracts/README.md"

WEB_FILES=(
  admin.html app.js booth.html booth.js booth.css
  index.html platform.css session.html session.js
  setup.html setup.js setup.css styles.css
  local-agent.html local-agent.js local-agent.css
  companion.html companion.js companion.css
)
for file in "${WEB_FILES[@]}"; do
  cp "${PHOTOBOX_DIR}/web/${file}" "${PACKAGE}/web/${file}"
done
cp -R "${PHOTOBOX_DIR}/web/icons" "${PACKAGE}/web/icons"

(cd "${STAGE}" && zip -X -q -r "${ARCHIVE}" photobox)
if unzip -l "${ARCHIVE}" | grep -Eiq '(\.env|\.DS_Store|/\.agents/|agent-config\.json|settings\.json)'; then
  echo "Paket ditolak: file lokal/secret terdeteksi." >&2
  exit 1
fi
mv "${ARCHIVE}" "${OUTPUT}"
echo "Paket aman dibuat: ${OUTPUT}"
