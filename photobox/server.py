#!/usr/bin/env python3
"""Lightweight local control service for the Photoslive booth.

The control plane uses the Python standard library. Pillow is the only media
runtime dependency and is installed in the isolated Controller environment so
selected captures can be rendered to deterministic frame and print files.
Device commands gracefully degrade when platform utilities are unavailable.
"""

from __future__ import annotations

import base64
import io
import json
import hashlib
import hmac
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from html import escape
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from redaction import redact_log_value, redact_text
import updater as release_updater

try:
    from PIL import Image, ImageDraw, ImageEnhance, ImageOps
except ImportError:  # The API stays available and reports the missing capability.
    Image = ImageDraw = ImageEnhance = ImageOps = None

try:
    import qrcode
except ImportError:  # Installer installs it; Local Manager keeps a copyable URL fallback.
    qrcode = None


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
DATA_ROOT = Path(os.environ.get("PHOTOSLIVE_DATA_ROOT", ROOT / "data")).expanduser()
UPLOAD_ROOT = WEB_ROOT / "uploads"
PHOTO_ROOT = DATA_ROOT / "photos"
DB_PATH = DATA_ROOT / "photoslive.db"
SETTINGS_PATH = DATA_ROOT / "settings.json"
LOCAL_TOKEN_PATH = DATA_ROOT / ".installation-token"
AGENT_CONFIG_ROOT = Path(os.environ.get("PHOTOSLIVE_CONFIG_DIR", Path.home() / ".config" / "photoslive"))
AGENT_CONFIG_PATH = AGENT_CONFIG_ROOT / "agent.json"
AGENT_STATUS_PATH = AGENT_CONFIG_ROOT / "agent-status.json"
AGENT_CONTROL_PATH = AGENT_CONFIG_ROOT / "agent-control.json"
AGENT_LOG_PATH = AGENT_CONFIG_ROOT / "agent.log"
STARTED_AT = time.time()
SERVICE_VERSION = "0.8.0"
LOCAL_SCHEMA_VERSION = 5
PHOTO_CONSENT_VERSION = "2026-07-21"
MINIMUM_FREE_STORAGE_BYTES = 2 * 1024 * 1024 * 1024
MAX_PENDING_SYNC_JOBS = 1000
STORAGE_CACHE_SECONDS = 60
STORAGE_CACHE: dict[str, Any] = {"createdAt": 0.0, "payload": None}
STORAGE_CACHE_LOCK = threading.Lock()
UPDATE_TASK_LOCK = threading.Lock()
COMPANION_STATE_LOCK = threading.RLock()
THUMBNAIL_CACHE_MAX_BYTES = int(os.environ.get("PHOTOSLIVE_THUMBNAIL_CACHE_MAX_BYTES", str(128 * 1024 * 1024)))
GIF_CACHE_MAX_BYTES = int(os.environ.get("PHOTOSLIVE_GIF_CACHE_MAX_BYTES", str(256 * 1024 * 1024)))
TEMP_CACHE_MAX_BYTES = int(os.environ.get("PHOTOSLIVE_TEMP_CACHE_MAX_BYTES", str(256 * 1024 * 1024)))
TEMP_FILE_MAX_AGE_SECONDS = int(os.environ.get("PHOTOSLIVE_TEMP_FILE_MAX_AGE_SECONDS", str(24 * 60 * 60)))
LOCAL_BACKUP_LIMIT = max(3, int(os.environ.get("PHOTOSLIVE_LOCAL_BACKUP_LIMIT", "14")))
BOOTH_CLIENTS: dict[str, dict[str, Any]] = {}
BOOTH_CLIENTS_LOCK = threading.Lock()
PRINT_WORKER_STOP = threading.Event()
PRINT_WORKER_LOCK = threading.Lock()
PRINT_WORKER_THREAD: threading.Thread | None = None
OFFLINE_POLICY_STATE_KEY = "offline_policy_lease"
OFFLINE_ONLINE_SECONDS = 120
OFFLINE_NORMAL_SECONDS = 24 * 60 * 60
OFFLINE_WARNING_SECONDS = 48 * 60 * 60
OFFLINE_CRITICAL_SECONDS = 72 * 60 * 60
METRICS_LOCK = threading.Lock()
REQUEST_METRIC_SAMPLES: deque[dict[str, Any]] = deque(maxlen=512)
TEST_ADMIN_SESSION_TOKEN = secrets.token_urlsafe(32)
OPERATION_FAILURES: dict[str, int] = {
    "camera": 0,
    "capture": 0,
    "printer": 0,
    "render": 0,
}


def test_admin_account() -> dict[str, str] | None:
    """Return the isolated local account only when test mode is explicit."""
    if os.environ.get("PHOTOSLIVE_TEST_MODE") != "1":
        return None
    password = str(os.environ.get("PHOTOSLIVE_TEST_PASSWORD") or "")
    if len(password) < 8:
        return None
    return {
        "boothCode": str(os.environ.get("PHOTOSLIVE_TEST_BOOTH_CODE") or "test-booth").strip().lower(),
        "email": str(os.environ.get("PHOTOSLIVE_TEST_EMAIL") or "owner@photoslive.test").strip().lower(),
        "password": password,
        "name": str(os.environ.get("PHOTOSLIVE_TEST_NAME") or "Photoslive Test Booth").strip()[:80],
        "location": str(os.environ.get("PHOTOSLIVE_TEST_LOCATION") or "Local Test").strip()[:120],
    }


def test_admin_session_valid(cookie_header: str | None) -> bool:
    cookies: dict[str, str] = {}
    for part in str(cookie_header or "").split(";"):
        name, separator, value = part.strip().partition("=")
        if separator:
            cookies[name] = value
    supplied = cookies.get("photoslive_test_session", "")
    return bool(supplied) and hmac.compare_digest(supplied, TEST_ADMIN_SESSION_TOKEN)

DEFAULT_SETTINGS: dict[str, Any] = {
    "booth": {
        "name": "Photoslive Booth 01",
        "location": "Main Hall",
        "dailySessionLimit": 120,
        "sessionTimeoutSeconds": 150,
        "countdownSeconds": 15,
        "retakeLimit": 1,
        "unlimitedRetakes": True,
        "photoSlotsPerSession": 3,
        "printsPerSession": 1,
        "localRetentionHours": 24,
        "cloudRetentionDays": 7,
        "maintenanceMode": False,
    },
    "payment": {
        "qrisEnabled": True,
        "voucherEnabled": True,
        "price": 35000,
        "currency": "IDR",
        "provider": "Not configured",
        "paidPrintEnabled": False,
        "printPrice": 10000,
    },
    "appearance": {
        "activeBackground": "default-gradient",
        "activeFrame": "clean-white",
        "activeLogo": "text-logo",
        "welcomeTitle": "Abadikan momenmu",
        "touchPrompt": "Sentuh layar untuk memulai",
        "startButtonLabel": "Mulai foto",
        "fontFamily": "system",
        "screenPreset": "1080x1920",
        "screenSizeInches": 15.6,
        "logoSizePercent": 28,
        "headingFontSize": 48,
        "helperFontSize": 18,
        "buttonFontSize": 16,
        "accentColor": "#6d5dfc",
        "headingTextColor": "#ffffff",
        "helperTextColor": "#ffffff",
        "buttonBackgroundColor": "#ffffff",
        "buttonTextColor": "#7c3049",
        "frameFormat": "photo-strip-vertical",
        "framePhotoSlots": {"clean-white": 3, "party-night": 3},
        "framePhotoWidths": {"clean-white": 86, "party-night": 86},
        "frameBackgroundTransforms": {},
        "frameSlotTransforms": {},
        "frameStickers": {},
        "frameLayoutModes": {"clean-white": "auto", "party-night": "auto"},
        "frameSizePresets": {"clean-white": "auto", "party-night": "auto"},
        "frameCanvasSizes": {
            "clean-white": {"width": 1200, "height": 1600},
            "party-night": {"width": 1200, "height": 1600},
        },
        "frameOriginalCanvasSizes": {
            "clean-white": {"width": 1200, "height": 1600},
            "party-night": {"width": 1200, "height": 1600},
        },
        "frameAspectRatio": "3:4",
        "frameCanvasWidth": 1200,
        "frameCanvasHeight": 1600,
        "frameBottomMarginPercent": 20,
    },
    "storage": {
        "localPhotoPath": "",
        "cloudEnabled": False,
        "provider": "Cloudflare R2",
        "uploadFinalOnly": True,
        "deleteOnlyAfterUpload": True,
    },
    "devices": {
        "cameraSource": "auto",
        "browserCameraId": "",
        "preferredCamera": "auto",
        "preferredPrinter": "auto",
        "paperSize": "4x6",
        "printLayout": "photo-strip-vertical",
        "stripsPerSheet": 2,
        "borderless": True,
        "cameraMirror": False,
        "cameraRotation": "0",
    },
}


@dataclass
class Device:
    id: str
    name: str
    kind: str
    status: str
    detail: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_data() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    PHOTO_ROOT.mkdir(parents=True, exist_ok=True)
    thumbnail_cache_root().mkdir(parents=True, exist_ok=True)
    gif_cache_root().mkdir(parents=True, exist_ok=True)
    temporary_root().mkdir(parents=True, exist_ok=True)
    if not LOCAL_TOKEN_PATH.exists():
        LOCAL_TOKEN_PATH.write_text(uuid.uuid4().hex + uuid.uuid4().hex, encoding="utf-8")
        try:
            LOCAL_TOKEN_PATH.chmod(0o600)
        except OSError:
            pass
    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")
    with sqlite3.connect(DB_PATH) as db:
        existing_version = int(db.execute("PRAGMA user_version").fetchone()[0])
        if existing_version > LOCAL_SCHEMA_VERSION:
            raise RuntimeError(f"Database lokal memakai schema {existing_version}; Controller hanya mendukung sampai {LOCAL_SCHEMA_VERSION}")
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
              id TEXT PRIMARY KEY,
              type TEXT NOT NULL,
              message TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS vouchers (
              code TEXT PRIMARY KEY,
              package_name TEXT NOT NULL,
              expires_at TEXT,
              redeemed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS voucher_events (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              includes_print INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_usage (
              day TEXT PRIMARY KEY,
              sessions INTEGER NOT NULL DEFAULT 0,
              photos INTEGER NOT NULL DEFAULT 0,
              prints INTEGER NOT NULL DEFAULT 0,
              revenue INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              status TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              message TEXT,
              reference_id TEXT,
              last_error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS photo_files (
              id TEXT PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              session_id TEXT,
              slot_index INTEGER NOT NULL DEFAULT 1,
              attempt_number INTEGER NOT NULL DEFAULT 1,
              is_selected INTEGER NOT NULL DEFAULT 0,
              file_kind TEXT NOT NULL DEFAULT 'capture',
              checksum_sha256 TEXT,
              uploaded_at TEXT,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS photo_sessions (
              id TEXT PRIMARY KEY,
              share_token TEXT NOT NULL UNIQUE,
              status TEXT NOT NULL DEFAULT 'active',
              frame_id TEXT,
              photo_slots INTEGER NOT NULL DEFAULT 1,
              retake_limit INTEGER NOT NULL DEFAULT 0,
              timeout_seconds INTEGER NOT NULL DEFAULT 180,
              strips_per_sheet INTEGER NOT NULL DEFAULT 2,
              print_layout TEXT NOT NULL DEFAULT 'photo-strip-vertical',
              frame_config_json TEXT NOT NULL DEFAULT '{}',
              deadline_at TEXT,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              uploaded_at TEXT,
              consent_at TEXT,
              consent_version TEXT
            );
            CREATE TABLE IF NOT EXISTS sync_queue (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              payload_json TEXT NOT NULL DEFAULT '{}',
              progress_json TEXT NOT NULL DEFAULT '{}',
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,
              next_attempt_at TEXT,
              last_error TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_state (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
        file_columns = {row[1] for row in db.execute("PRAGMA table_info(photo_files)").fetchall()}
        if "session_id" not in file_columns:
            db.execute("ALTER TABLE photo_files ADD COLUMN session_id TEXT")
        for name, definition in {
            "slot_index": "INTEGER NOT NULL DEFAULT 1",
            "attempt_number": "INTEGER NOT NULL DEFAULT 1",
            "is_selected": "INTEGER NOT NULL DEFAULT 0",
            "file_kind": "TEXT NOT NULL DEFAULT 'capture'",
            "checksum_sha256": "TEXT",
        }.items():
            if name not in file_columns:
                db.execute(f"ALTER TABLE photo_files ADD COLUMN {name} {definition}")
        session_columns = {row[1] for row in db.execute("PRAGMA table_info(photo_sessions)").fetchall()}
        for name, definition in {
            "frame_id": "TEXT",
            "photo_slots": "INTEGER NOT NULL DEFAULT 1",
            "retake_limit": "INTEGER NOT NULL DEFAULT 0",
            "timeout_seconds": "INTEGER NOT NULL DEFAULT 180",
            "strips_per_sheet": "INTEGER NOT NULL DEFAULT 2",
            "print_layout": "TEXT NOT NULL DEFAULT 'photo-strip-vertical'",
            "frame_config_json": "TEXT NOT NULL DEFAULT '{}'",
            "deadline_at": "TEXT",
            "consent_at": "TEXT",
            "consent_version": "TEXT",
        }.items():
            if name not in session_columns:
                db.execute(f"ALTER TABLE photo_sessions ADD COLUMN {name} {definition}")
        job_columns = {row[1] for row in db.execute("PRAGMA table_info(jobs)").fetchall()}
        for name, definition in {"reference_id": "TEXT", "last_error": "TEXT"}.items():
            if name not in job_columns:
                db.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
        db.execute("UPDATE jobs SET reference_id = COALESCE(reference_id, message) WHERE kind = 'print'")
        db.execute("CREATE INDEX IF NOT EXISTS idx_jobs_kind_status ON jobs(kind, status, created_at)")
        voucher_columns = {row[1] for row in db.execute("PRAGMA table_info(vouchers)").fetchall()}
        for name, definition in {
            "event_id": "TEXT",
            "includes_print": "INTEGER NOT NULL DEFAULT 1",
            "created_at": "TEXT",
            "source": "TEXT NOT NULL DEFAULT 'local'",
        }.items():
            if name not in voucher_columns:
                db.execute(f"ALTER TABLE vouchers ADD COLUMN {name} {definition}")
        db.execute("UPDATE vouchers SET created_at = COALESCE(created_at, ?)", (utc_now(),))
        db.execute("CREATE INDEX IF NOT EXISTS idx_vouchers_event ON vouchers(event_id)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_vouchers_active ON vouchers(redeemed_at)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_vouchers_source ON vouchers(source, redeemed_at)")
        sync_columns = {row[1] for row in db.execute("PRAGMA table_info(sync_queue)").fetchall()}
        if "progress_json" not in sync_columns:
            db.execute("ALTER TABLE sync_queue ADD COLUMN progress_json TEXT NOT NULL DEFAULT '{}'")
        db.execute("CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_attempt_at)")
        today = datetime.now().date().isoformat()
        db.execute("INSERT OR IGNORE INTO daily_usage(day) VALUES (?)", (today,))
        db.execute(f"PRAGMA user_version = {LOCAL_SCHEMA_VERSION}")
        db.commit()

    # Keep maintenance bounded and synchronous only at startup. The folders are
    # small by design, so a 4 GB machine never needs a resident cleanup worker.
    maintain_local_cache(dry_run=False)


def backup_root() -> Path:
    return DATA_ROOT / "backups"


def restore_status_path() -> Path:
    return DATA_ROOT / "restore-status.json"


def read_json_file(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback


def write_json_file_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.part")
    try:
        temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def local_restore_status() -> dict[str, Any]:
    value = read_json_file(restore_status_path(), {})
    if not isinstance(value, dict):
        return {"status": "never", "updatedAt": None}
    status = str(value.get("status") or "never")
    if status not in {"never", "completed", "failed"}:
        status = "never"
    return {
        "status": status,
        "updatedAt": value.get("updatedAt") if isinstance(value.get("updatedAt"), str) else None,
        "sourceCreatedAt": value.get("sourceCreatedAt") if isinstance(value.get("sourceCreatedAt"), str) else None,
        "databaseStatus": str(value.get("databaseStatus") or "unknown")[:40],
    }


def record_local_restore_status(status: str, source_created_at: str | None = None, database_status: str = "unknown") -> dict[str, Any]:
    payload = {
        "status": status if status in {"completed", "failed"} else "failed",
        "updatedAt": utc_now(),
        "sourceCreatedAt": source_created_at,
        "databaseStatus": str(database_status or "unknown")[:40],
    }
    write_json_file_atomic(restore_status_path(), payload)
    return payload


def installation_token() -> str:
    return LOCAL_TOKEN_PATH.read_text(encoding="utf-8").strip()


def public_agent_config() -> dict[str, Any]:
    config = read_json_file(AGENT_CONFIG_PATH, {})
    return {
        "cloud": config.get("cloud"),
        "controller": config.get("controller"),
        "name": config.get("name"),
        "machineId": config.get("machineId"),
        "boothCode": config.get("boothCode"),
        "pairingCode": config.get("pairingCode"),
        "configured": bool(config.get("machineId") and config.get("agentToken")),
    }


def companion_token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def companion_state_path() -> Path:
    return DATA_ROOT / "companion-state.json"


def companion_state() -> dict[str, Any]:
    value = read_json_file(companion_state_path(), {})
    return value if isinstance(value, dict) else {}


def companion_port() -> int:
    try:
        return max(1024, min(65535, int(os.environ.get("PHOTOSLIVE_COMPANION_PORT", "8081"))))
    except ValueError:
        return 8081


def companion_local_address() -> str:
    configured = str(os.environ.get("PHOTOSLIVE_COMPANION_PUBLIC_URL") or "").strip().rstrip("/")
    if configured:
        return configured
    candidates: list[str] = []
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = str(item[4][0])
            if address and not address.startswith("127.") and address not in candidates:
                candidates.append(address)
    except OSError:
        pass
    if not candidates:
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.settimeout(0.2)
            probe.connect(("192.0.2.1", 9))
            address = str(probe.getsockname()[0])
            if address and not address.startswith("127."):
                candidates.append(address)
            probe.close()
        except OSError:
            pass
    host = candidates[0] if candidates else "127.0.0.1"
    return f"http://{host}:{companion_port()}"


def companion_qr_image(value: str) -> str | None:
    if qrcode is None:
        return None
    image = qrcode.make(value)
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def companion_capabilities() -> dict[str, Any]:
    devices = detect_devices()
    cameras = [asdict(item) for item in devices if item.kind == "camera" and item.status == "connected"]
    printers = [asdict(item) for item in devices if item.kind == "printer" and item.status == "connected"]
    settings = load_settings()
    photo_path = photo_root(settings)
    return {
        "camera": {"available": bool(cameras), "devices": cameras},
        "printer": {"available": bool(printers), "devices": printers},
        "storage": {"available": os.access(photo_path, os.W_OK), "pathLabel": photo_path.name or "Photoslive"},
        "controller": {"available": True, "version": SERVICE_VERSION},
    }


def companion_safe_state(state: dict[str, Any] | None = None) -> dict[str, Any]:
    value = state or companion_state()
    now = time.time()
    session_valid = bool(value.get("sessionTokenHash") and float(value.get("sessionExpiresAt") or 0) > now)
    last_seen = float(value.get("lastSeenAt") or 0)
    connected = bool(session_valid and last_seen and now - last_seen <= 30)
    pairing_valid = bool(value.get("pairingTokenHash") and float(value.get("pairingExpiresAt") or 0) > now)
    return {
        "status": "connected" if connected else "waiting" if pairing_valid else "disconnected",
        "pairingId": value.get("pairingId") if pairing_valid else None,
        "pairingExpiresAt": value.get("pairingExpiresAt") if pairing_valid else None,
        "sessionExpiresAt": value.get("sessionExpiresAt") if session_valid else None,
        "deviceName": str(value.get("deviceName") or "")[:80] or None,
        "lastSeenAt": last_seen or None,
        "listenerUrl": companion_local_address(),
    }


def create_companion_pairing() -> dict[str, Any]:
    with COMPANION_STATE_LOCK:
        pairing_id = uuid.uuid4().hex
        token = secrets.token_urlsafe(32)
        expires_at = time.time() + 5 * 60
        state = {
            "version": 1,
            "pairingId": pairing_id,
            "pairingTokenHash": companion_token_hash(token),
            "pairingExpiresAt": expires_at,
            "sessionTokenHash": None,
            "sessionExpiresAt": None,
            "deviceName": None,
            "lastSeenAt": None,
            "createdAt": utc_now(),
        }
        write_json_file_atomic(companion_state_path(), state)
    url = f"{companion_local_address()}/companion#pairing={pairing_id}&token={token}"
    return {
        **companion_safe_state(state),
        "pairingUrl": url,
        "qrImage": companion_qr_image(url),
        "expiresInSeconds": 5 * 60,
    }


def claim_companion_pairing(pairing_id: str, token: str, device_name: str) -> dict[str, Any]:
    with COMPANION_STATE_LOCK:
        state = companion_state()
        now = time.time()
        if not pairing_id or pairing_id != state.get("pairingId"):
            raise ValueError("Kode pairing companion tidak ditemukan")
        if float(state.get("pairingExpiresAt") or 0) <= now:
            raise ValueError("Kode pairing companion sudah kedaluwarsa. Buat QR baru di Local Manager.")
        expected = str(state.get("pairingTokenHash") or "")
        if not expected or not hmac.compare_digest(expected, companion_token_hash(token)):
            raise ValueError("Token pairing companion tidak valid")
        session_token = secrets.token_urlsafe(48)
        state.update({
            "pairingTokenHash": None,
            "pairingExpiresAt": None,
            "sessionTokenHash": companion_token_hash(session_token),
            "sessionExpiresAt": now + 12 * 60 * 60,
            "deviceName": re.sub(r"[^\w .()\-/]", "", device_name, flags=re.UNICODE)[:80] or "Tablet",
            "lastSeenAt": now,
            "claimedAt": utc_now(),
        })
        write_json_file_atomic(companion_state_path(), state)
    return {
        "sessionToken": session_token,
        "sessionExpiresAt": state["sessionExpiresAt"],
        "status": companion_safe_state(state),
        "capabilities": companion_capabilities(),
    }


def companion_session_valid(token: str) -> bool:
    with COMPANION_STATE_LOCK:
        state = companion_state()
        expected = str(state.get("sessionTokenHash") or "")
        return bool(
            expected
            and float(state.get("sessionExpiresAt") or 0) > time.time()
            and hmac.compare_digest(expected, companion_token_hash(token))
        )


def companion_heartbeat(token: str) -> dict[str, Any]:
    with COMPANION_STATE_LOCK:
        if not companion_session_valid(token):
            raise ValueError("Sesi companion tidak valid atau sudah berakhir")
        state = companion_state()
        state["lastSeenAt"] = time.time()
        write_json_file_atomic(companion_state_path(), state)
        return companion_safe_state(state)


def revoke_companion() -> dict[str, Any]:
    with COMPANION_STATE_LOCK:
        state = companion_state()
        state.update({
            "pairingTokenHash": None,
            "pairingExpiresAt": None,
            "sessionTokenHash": None,
            "sessionExpiresAt": None,
            "lastSeenAt": None,
            "revokedAt": utc_now(),
        })
        write_json_file_atomic(companion_state_path(), state)
        return companion_safe_state(state)


def companion_storage_test(image_base64: str) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        data = base64.b64decode(image_base64, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("Foto uji companion tidak valid") from exc
    if not 100 <= len(data) <= 2_000_000 or not (data.startswith(b"\xff\xd8") or data.startswith(b"\x89PNG")):
        raise ValueError("Foto uji harus JPEG/PNG berukuran maksimal 2 MB")
    settings = load_settings()
    root = photo_root(settings) / ".companion-test"
    root.mkdir(parents=True, exist_ok=True)
    target = root / f"{uuid.uuid4().hex}.jpg"
    try:
        with target.open("wb") as destination:
            destination.write(data)
            destination.flush()
            os.fsync(destination.fileno())
    finally:
        target.unlink(missing_ok=True)
        try:
            root.rmdir()
        except OSError:
            pass
    return {"ok": True, "bytes": len(data), "latencyMs": round((time.perf_counter() - started) * 1000, 1)}


def local_login_capability() -> dict[str, Any]:
    """Expose only enough metadata to decide whether local PIN can be offered."""
    config = read_json_file(AGENT_CONFIG_PATH, {})
    machine_id = str(config.get("machineId") or "")
    booth_code = str(config.get("boothCode") or "").strip().lower()
    command_key = str(config.get("commandKey") or "")
    return {
        "available": bool(machine_id and booth_code and command_key),
        "machineId": machine_id if machine_id and booth_code and command_key else None,
        "boothCode": booth_code if machine_id and booth_code and command_key else None,
    }


def local_login_assertion() -> dict[str, Any]:
    """Create a one-time, short-lived proof that can only originate on loopback."""
    config = read_json_file(AGENT_CONFIG_PATH, {})
    machine_id = str(config.get("machineId") or "")
    booth_code = str(config.get("boothCode") or "").strip().lower()
    command_key = str(config.get("commandKey") or "")
    if not machine_id or not booth_code or not command_key:
        raise ValueError("Agent belum paired atau belum menerima konfigurasi login lokal")
    issued_at = int(time.time() * 1000)
    payload = {
        "v": 1,
        "purpose": "admin-pin",
        "machineId": machine_id,
        "boothCode": booth_code,
        "nonce": uuid.uuid4().hex,
        "iat": issued_at,
        "exp": issued_at + 60_000,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    signature = hmac.new(command_key.encode("utf-8"), f"local-login:{encoded}".encode("utf-8"), hashlib.sha256).hexdigest()
    return {"assertion": f"{encoded}.{signature}", "expiresAt": payload["exp"], "boothCode": booth_code}


def local_auth_allowed_origin(origin: str | None) -> str | None:
    if not origin:
        return None
    config = read_json_file(AGENT_CONFIG_PATH, {})
    cloud = urlparse(str(config.get("cloud") or "https://photoslive.vercel.app"))
    expected = f"{cloud.scheme}://{cloud.netloc}" if cloud.scheme in {"http", "https"} and cloud.netloc else ""
    return origin if expected and origin == expected else None


def agent_control() -> dict[str, Any]:
    control = read_json_file(AGENT_CONTROL_PATH, {})
    return {"paused": bool(control.get("paused")), "updatedAt": control.get("updatedAt")}


def set_agent_paused(paused: bool) -> dict[str, Any]:
    AGENT_CONFIG_ROOT.mkdir(parents=True, exist_ok=True)
    control = {"paused": paused, "updatedAt": utc_now()}
    temporary = AGENT_CONTROL_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(control, indent=2), encoding="utf-8")
    temporary.replace(AGENT_CONTROL_PATH)
    add_event("agent", "Koneksi Agent dijeda" if paused else "Koneksi Agent dilanjutkan")
    return control


def tail_agent_logs(limit: int = 120) -> list[str]:
    try:
        lines = AGENT_LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [redact_text(line, 4000) for line in lines[-max(1, min(limit, 500)):]]


def sync_status() -> dict[str, Any]:
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute("SELECT status, COUNT(*) FROM sync_queue GROUP BY status").fetchall()
        last_error = db.execute(
            "SELECT last_error, updated_at FROM sync_queue WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
    counts = {status: count for status, count in rows}
    open_jobs = sum(counts.get(status, 0) for status in ("pending", "running", "failed", "dead"))
    return {
        "pending": counts.get("pending", 0),
        "running": counts.get("running", 0),
        "failed": counts.get("failed", 0),
        "dead": counts.get("dead", 0),
        "completed": counts.get("completed", 0),
        "open": open_jobs,
        "limit": MAX_PENDING_SYNC_JOBS,
        "remainingCapacity": max(0, MAX_PENDING_SYNC_JOBS - open_jobs),
        "lastError": last_error[0] if last_error else None,
        "lastErrorAt": last_error[1] if last_error else None,
    }


def enqueue_session_sync(
    db: sqlite3.Connection,
    session: dict[str, Any],
    files: list[dict[str, Any]],
    job_id: str | None = None,
) -> str:
    """Write the session upload intent in the same transaction as completion."""
    session_id = str(session["id"])
    job_id = job_id or f"session.sync:{session_id}"
    if db.execute("SELECT 1 FROM sync_queue WHERE id = ?", (job_id,)).fetchone():
        return job_id
    open_jobs = int(db.execute(
        "SELECT COUNT(*) FROM sync_queue WHERE status IN ('pending', 'running', 'failed', 'dead')"
    ).fetchone()[0])
    if open_jobs >= MAX_PENDING_SYNC_JOBS:
        raise ValueError(
            f"Antrean upload mencapai batas {MAX_PENDING_SYNC_JOBS} sesi. "
            "Periksa internet atau retry antrean sebelum menyelesaikan sesi baru."
        )
    # Keep a bounded amount of operational history without growing SQLite forever.
    db.execute(
        """DELETE FROM sync_queue WHERE id IN (
             SELECT id FROM sync_queue WHERE status = 'completed'
             ORDER BY updated_at DESC LIMIT -1 OFFSET 200
           )"""
    )
    payload = {
        "session": {**session, "status": "completed"},
        "files": files,
    }
    timestamp = utc_now()
    db.execute(
        """INSERT INTO sync_queue(
             id, kind, payload_json, status, attempts, next_attempt_at, created_at, updated_at
           ) VALUES (?, 'session.sync', ?, 'pending', 0, ?, ?, ?)""",
        (job_id, json.dumps(payload), timestamp, timestamp, timestamp),
    )
    return job_id


def claim_sync_job() -> dict[str, Any] | None:
    """Atomically claim one due outbox job and recover abandoned claims."""
    timestamp = utc_now()
    stale_before = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            """UPDATE sync_queue SET status = 'pending', next_attempt_at = ?, updated_at = ?
               WHERE status = 'running' AND updated_at < ?""",
            (timestamp, timestamp, stale_before),
        )
        row = db.execute(
            """SELECT id, kind, payload_json, attempts, progress_json FROM sync_queue
               WHERE status IN ('pending', 'failed')
                 AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
               ORDER BY created_at ASC LIMIT 1""",
            (timestamp,),
        ).fetchone()
        if not row:
            db.commit()
            return None
        updated = db.execute(
            """UPDATE sync_queue SET status = 'running', attempts = attempts + 1,
                      last_error = NULL, updated_at = ?
               WHERE id = ? AND status IN ('pending', 'failed')""",
            (timestamp, row[0]),
        )
        db.commit()
    if updated.rowcount != 1:
        return None
    try:
        progress = json.loads(row[4] or "{}")
    except (TypeError, ValueError):
        progress = {}
    return {
        "id": row[0], "kind": row[1], "payload": json.loads(row[2]),
        "attempts": int(row[3]) + 1, "progress": progress,
    }


def checkpoint_sync_file(job_id: str, file_id: str) -> dict[str, Any]:
    """Persist one uploaded file so a retried session skips completed work."""
    clean_job_id = str(job_id or "").strip()
    clean_file_id = str(file_id or "").strip()
    if not clean_job_id or not clean_file_id:
        raise ValueError("Job dan file sinkronisasi wajib diisi")
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT kind, payload_json, progress_json, status FROM sync_queue WHERE id = ?",
            (clean_job_id,),
        ).fetchone()
        if not row:
            db.rollback()
            raise ValueError("Job sinkronisasi tidak ditemukan")
        if row[0] != "session.sync" or row[3] not in {"running", "failed", "pending"}:
            db.rollback()
            raise ValueError("Job sinkronisasi tidak dapat diberi checkpoint")
        payload = json.loads(row[1] or "{}")
        expected = {
            str(item.get("id") or "") for item in payload.get("files", [])
            if isinstance(item, dict) and item.get("id")
        }
        if clean_file_id not in expected:
            db.rollback()
            raise ValueError("File tidak termasuk dalam job sinkronisasi")
        try:
            progress = json.loads(row[2] or "{}")
        except (TypeError, ValueError):
            progress = {}
        completed = {str(value) for value in progress.get("completedFileIds", []) if value}
        completed.add(clean_file_id)
        multipart = progress.get("multipart") if isinstance(progress.get("multipart"), dict) else {}
        multipart.pop(clean_file_id, None)
        progress = {**progress, "completedFileIds": sorted(completed), "multipart": multipart, "updatedAt": timestamp}
        db.execute(
            "UPDATE sync_queue SET progress_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(progress, separators=(",", ":")), timestamp, clean_job_id),
        )
        db.commit()
    return {"id": clean_job_id, "fileId": clean_file_id, "progress": progress}


def checkpoint_sync_multipart(job_id: str, file_id: str, upload_id: str, part_number: int,
                              etag: str, part_size: int, total_size: int) -> dict[str, Any]:
    """Durably checkpoint one uploaded multipart part without storing signed URLs."""
    clean_job_id = str(job_id or "").strip()
    clean_file_id = str(file_id or "").strip()
    clean_upload_id = re.sub(r"[^A-Za-z0-9_-]", "", str(upload_id or ""))[:160]
    clean_etag = str(etag or "").strip()[:200]
    safe_part_number = int(part_number or 0)
    safe_part_size = int(part_size or 0)
    safe_total_size = int(total_size or 0)
    if not clean_job_id or not clean_file_id or not clean_upload_id:
        raise ValueError("Job, file, dan upload multipart wajib diisi")
    if safe_part_number < 1 or safe_part_number > 10_000 or not clean_etag or "\n" in clean_etag or "\r" in clean_etag:
        raise ValueError("Checkpoint part multipart tidak valid")
    if safe_part_size < 5 * 1024 * 1024 or safe_part_size > 20 * 1024 * 1024 or safe_total_size < 1 or safe_total_size > 25_000_000:
        raise ValueError("Ukuran multipart tidak valid")
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT kind, payload_json, progress_json, status FROM sync_queue WHERE id = ?",
            (clean_job_id,),
        ).fetchone()
        if not row:
            db.rollback()
            raise ValueError("Job sinkronisasi tidak ditemukan")
        if row[0] != "session.sync" or row[3] not in {"running", "failed", "pending"}:
            db.rollback()
            raise ValueError("Job sinkronisasi tidak dapat diberi checkpoint")
        payload = json.loads(row[1] or "{}")
        expected = {
            str(item.get("id") or "") for item in payload.get("files", [])
            if isinstance(item, dict) and item.get("id")
        }
        if clean_file_id not in expected:
            db.rollback()
            raise ValueError("File tidak termasuk dalam job sinkronisasi")
        try:
            progress = json.loads(row[2] or "{}")
        except (TypeError, ValueError):
            progress = {}
        multipart = progress.get("multipart") if isinstance(progress.get("multipart"), dict) else {}
        previous = multipart.get(clean_file_id) if isinstance(multipart.get(clean_file_id), dict) else {}
        completed_parts = previous.get("completedParts") if previous.get("uploadId") == clean_upload_id and isinstance(previous.get("completedParts"), list) else []
        by_number = {
            int(part.get("partNumber")): {"partNumber": int(part.get("partNumber")), "etag": str(part.get("etag"))[:200]}
            for part in completed_parts if isinstance(part, dict) and int(part.get("partNumber") or 0) > 0 and part.get("etag")
        }
        by_number[safe_part_number] = {"partNumber": safe_part_number, "etag": clean_etag}
        multipart[clean_file_id] = {
            "uploadId": clean_upload_id,
            "partSize": safe_part_size,
            "totalSize": safe_total_size,
            "completedParts": [by_number[number] for number in sorted(by_number)],
            "updatedAt": timestamp,
        }
        progress = {**progress, "multipart": multipart, "updatedAt": timestamp}
        db.execute(
            "UPDATE sync_queue SET progress_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(progress, separators=(",", ":")), timestamp, clean_job_id),
        )
        db.commit()
    return {"id": clean_job_id, "fileId": clean_file_id, "progress": progress}


def update_sync_job(job_id: str, succeeded: bool, error: str = "") -> dict[str, Any]:
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute("SELECT kind, payload_json, attempts FROM sync_queue WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise ValueError("Job sinkronisasi tidak ditemukan")
        if succeeded:
            db.execute(
                "UPDATE sync_queue SET status = 'completed', last_error = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ?",
                (timestamp, job_id),
            )
            if row[0] == "session.sync":
                payload = json.loads(row[1])
                session_id = str(payload.get("session", {}).get("id") or "")
                db.execute("UPDATE photo_sessions SET uploaded_at = ? WHERE id = ?", (timestamp, session_id))
                file_ids = [str(item.get("id") or "") for item in payload.get("files", []) if isinstance(item, dict)]
                for file_id in file_ids:
                    if file_id:
                        db.execute("UPDATE photo_files SET uploaded_at = ? WHERE id = ?", (timestamp, file_id))
        else:
            attempts = max(0, int(row[2]))
            next_status = "dead" if attempts >= 10 else "failed"
            delay_seconds = min(3600, 2 ** min(max(attempts, 1), 10))
            next_attempt = None if next_status == "dead" else (datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)).isoformat()
            db.execute(
                """UPDATE sync_queue SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
                   WHERE id = ?""",
                (next_status, str(error or "Sinkronisasi gagal")[:500], next_attempt, timestamp, job_id),
            )
        db.commit()
    return {"id": job_id, "status": "completed" if succeeded else next_status, "updatedAt": timestamp}


def retry_failed_sync_jobs() -> int:
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        result = db.execute(
            """UPDATE sync_queue SET status = 'pending', attempts = 0, last_error = NULL,
                      next_attempt_at = ?, updated_at = ? WHERE status IN ('failed', 'dead')""",
            (timestamp, timestamp),
        )
        db.commit()
    return int(result.rowcount)


def list_sync_jobs(limit: int = 50) -> list[dict[str, Any]]:
    bounded_limit = max(1, min(int(limit or 50), 100))
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            """SELECT id, kind, payload_json, progress_json, status, attempts,
                      next_attempt_at, last_error, created_at, updated_at
               FROM sync_queue ORDER BY created_at DESC LIMIT ?""",
            (bounded_limit,),
        ).fetchall()
    jobs: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(row[2] or "{}")
        except (TypeError, ValueError):
            payload = {}
        try:
            progress = json.loads(row[3] or "{}")
        except (TypeError, ValueError):
            progress = {}
        files = payload.get("files") if isinstance(payload.get("files"), list) else []
        completed = {str(value) for value in progress.get("completedFileIds", []) if value}
        multipart = progress.get("multipart") if isinstance(progress.get("multipart"), dict) else {}
        completed_part_count = sum(
            len(value.get("completedParts", [])) for value in multipart.values()
            if isinstance(value, dict) and isinstance(value.get("completedParts"), list)
        )
        session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
        jobs.append({
            "id": row[0], "kind": row[1], "status": row[4], "attempts": int(row[5] or 0),
            "nextAttemptAt": row[6], "lastError": row[7], "createdAt": row[8], "updatedAt": row[9],
            "sessionId": session.get("id"), "shareCode": session.get("shareCode"),
            "fileCount": len(files), "completedFileCount": len(completed),
            "multipartFileCount": len(multipart), "completedPartCount": completed_part_count,
        })
    return jobs


def retry_sync_job(job_id: str) -> dict[str, Any]:
    clean_id = str(job_id or "").strip()
    if not clean_id:
        raise ValueError("Job sinkronisasi wajib dipilih")
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        result = db.execute(
            """UPDATE sync_queue SET status = 'pending', attempts = 0,
                      last_error = NULL, next_attempt_at = ?, updated_at = ?
               WHERE id = ? AND status IN ('failed', 'dead')""",
            (timestamp, timestamp, clean_id),
        )
        db.commit()
    if result.rowcount != 1:
        raise ValueError("Job tidak gagal, sudah diproses, atau tidak ditemukan")
    add_event("sync", f"Retry manual antrean upload {clean_id}")
    return next(item for item in list_sync_jobs(100) if item["id"] == clean_id)


def list_print_jobs(limit: int = 50) -> list[dict[str, Any]]:
    """Return bounded, operator-safe print queue metadata for Local Manager."""
    bounded_limit = max(1, min(int(limit or 50), 100))
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            """SELECT jobs.id, jobs.status, jobs.attempts, jobs.message,
                      jobs.reference_id, jobs.last_error, jobs.created_at,
                      jobs.updated_at, photo_sessions.share_token,
                      photo_files.path
               FROM jobs
               LEFT JOIN photo_sessions ON photo_sessions.id = jobs.reference_id
               LEFT JOIN photo_files ON photo_files.session_id = jobs.reference_id
                    AND photo_files.file_kind = 'print-sheet'
               WHERE jobs.kind = 'print'
               ORDER BY jobs.created_at DESC LIMIT ?""",
            (bounded_limit,),
        ).fetchall()
    return [{
        "id": row[0],
        "status": row[1],
        "attempts": int(row[2] or 0),
        "message": row[3],
        "sessionId": row[4],
        "lastError": row[5],
        "createdAt": row[6],
        "updatedAt": row[7],
        "shareCode": row[8],
        "fileName": Path(str(row[9])).name if row[9] else None,
        "fileExists": bool(row[9] and (photo_root() / str(row[9])).is_file()),
    } for row in rows]


def retry_print_job(job_id: str) -> dict[str, Any]:
    clean_id = str(job_id or "").strip()
    if not clean_id:
        raise ValueError("Job cetak wajib dipilih")
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        result = db.execute(
            """UPDATE jobs SET status = 'pending', attempts = 0,
                      message = 'Menunggu printer', last_error = NULL,
                      updated_at = ?
               WHERE id = ? AND kind = 'print' AND status = 'failed'""",
            (timestamp, clean_id),
        )
        db.commit()
    if result.rowcount != 1:
        raise ValueError("Job cetak tidak gagal, sudah diproses, atau tidak ditemukan")
    add_event("print", f"Retry manual antrean cetak {clean_id}")
    ensure_print_worker()
    return next(item for item in list_print_jobs(100) if item["id"] == clean_id)


def local_agent_status() -> dict[str, Any]:
    status = read_json_file(AGENT_STATUS_PATH, {})
    updated_at = float(status.get("updatedAt") or 0)
    recent = bool(updated_at and time.time() - updated_at < 90)
    heartbeat_at = float(status.get("lastHeartbeatAt") or 0)
    cloud_connected = bool(heartbeat_at and time.time() - heartbeat_at < 120)
    controller_ok = True
    config = public_agent_config()
    devices = [asdict(device) for device in detect_devices()]
    photo_location = diagnostic_part(
        photo_root,
        "Pulihkan database lokal agar folder foto dapat dibaca kembali.",
    )
    if isinstance(photo_location, Path):
        storage_path: str | None = str(photo_location)
        disk = diagnostic_part(
            lambda: disk_metrics(photo_location),
            "Periksa folder foto dan ruang disk.",
        )
        storage_alert = diagnostic_part(
            lambda: storage_safety(photo_location),
            "Periksa folder foto dan ruang disk.",
        )
    else:
        storage_path = None
        disk = photo_location
        storage_alert = photo_location
    return {
        "agentState": "paused" if agent_control()["paused"] else ("online" if recent else "offline"),
        "controllerState": "online" if controller_ok else "offline",
        "desiredState": "paused" if agent_control()["paused"] else "running",
        "lastSeenAt": datetime.fromtimestamp(updated_at, timezone.utc).isoformat() if updated_at else None,
        "version": status.get("version"),
        "uptimeSeconds": int(time.time() - STARTED_AT),
        "lastError": status.get("error"),
        "lastHeartbeatAt": status.get("lastHeartbeatAt"),
        "lastJobPollAt": status.get("lastJobPollAt"),
        "config": config,
        "control": agent_control(),
        "database": database_health(),
        "sync": diagnostic_part(sync_status, "Pulihkan database lokal dari Local Manager."),
        "queue": diagnostic_part(queue_status, "Pulihkan database lokal dari Local Manager."),
        "cloud": {
            "connected": cloud_connected,
            "state": "online" if cloud_connected else "offline",
            "lastHeartbeatAt": heartbeat_at or None,
        },
        "system": {
            "memory": memory_metrics(),
            "cpu": cpu_metrics(),
            "disk": disk,
            "storageSafety": storage_alert,
        },
        "devices": devices,
        "storagePath": storage_path,
        # Updater state belongs to the Controller. Agent heartbeat snapshots
        # must not overwrite an update or rollback currently in progress.
        "update": release_updater.update_status(DATA_ROOT, SERVICE_VERSION),
        "offlinePolicy": diagnostic_part(
            offline_policy_status,
            "Pulihkan database lokal dari backup, lalu periksa koneksi cloud.",
        ),
    }


def load_settings() -> dict[str, Any]:
    stored = read_json_file(SETTINGS_PATH, {})
    if not isinstance(stored, dict):
        stored = {}
    settings = deep_merge(DEFAULT_SETTINGS, stored)
    # Device identity is operational state, not only presentation config. Keep
    # a compact SQLite copy so an interrupted settings-file write or a damaged
    # JSON file does not silently return a booth to the wrong camera/printer.
    selection = get_local_state("device_selection", {})
    if isinstance(selection, dict):
        settings["devices"] = deep_merge(settings["devices"], {
            key: value for key, value in selection.items()
            if key in {"preferredCamera", "preferredPrinter", "cameraSource", "browserCameraId"}
            and isinstance(value, str)
        })
    if settings["appearance"].get("frameFormat") == "polaroid-vertical":
        settings["appearance"]["frameFormat"] = "photo-strip-vertical"
    if settings["devices"].get("printLayout") == "polaroid-vertical":
        settings["devices"]["printLayout"] = "photo-strip-vertical"
    return settings


def thumbnail_cache_root() -> Path:
    return DATA_ROOT / "cache" / "thumbnails"


def gif_cache_root() -> Path:
    return DATA_ROOT / "cache" / "gif"


def temporary_root() -> Path:
    return DATA_ROOT / "tmp"


def _cache_files(folder: Path) -> list[tuple[Path, int, float]]:
    """List regular files without following links outside the managed folder."""
    resolved_root = folder.resolve()
    files: list[tuple[Path, int, float]] = []
    pending = [resolved_root]
    while pending:
        current = pending.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    files.append((Path(entry.path), stat.st_size, stat.st_mtime))
            except OSError:
                continue
    return files


def _trim_cache_folder(
    folder: Path,
    maximum_bytes: int,
    *,
    dry_run: bool,
    maximum_age_seconds: int | None = None,
    now: float | None = None,
) -> dict[str, Any]:
    folder.mkdir(parents=True, exist_ok=True)
    timestamp = time.time() if now is None else now
    files = sorted(_cache_files(folder), key=lambda item: item[2])
    current_bytes = sum(item[1] for item in files)
    selected: list[tuple[Path, int, float]] = []
    selected_paths: set[Path] = set()

    if maximum_age_seconds is not None:
        cutoff = timestamp - max(0, maximum_age_seconds)
        for item in files:
            if item[2] <= cutoff:
                selected.append(item)
                selected_paths.add(item[0])

    remaining_bytes = current_bytes - sum(item[1] for item in selected)
    for item in files:
        if remaining_bytes <= maximum_bytes:
            break
        if item[0] in selected_paths:
            continue
        selected.append(item)
        selected_paths.add(item[0])
        remaining_bytes -= item[1]

    deleted_files = 0
    reclaimed_bytes = 0
    errors: list[str] = []
    if not dry_run:
        for path, size, _mtime in selected:
            try:
                path.unlink()
                deleted_files += 1
                reclaimed_bytes += size
            except OSError as error:
                errors.append(f"{path.name}: {error}")
        for child in sorted((path for path in folder.rglob("*") if path.is_dir()), key=lambda path: len(path.parts), reverse=True):
            try:
                child.rmdir()
            except OSError:
                pass

    candidate_bytes = sum(item[1] for item in selected)
    return {
        "path": str(folder),
        "limitBytes": maximum_bytes,
        "currentFiles": len(files),
        "currentBytes": current_bytes,
        "candidateFiles": len(selected),
        "candidateBytes": candidate_bytes,
        "deletedFiles": deleted_files,
        "reclaimedBytes": reclaimed_bytes,
        "afterBytes": max(0, current_bytes - (reclaimed_bytes if not dry_run else candidate_bytes)),
        "errors": errors[:10],
        "dryRun": dry_run,
    }


def maintain_local_cache(dry_run: bool = True, now: float | None = None) -> dict[str, Any]:
    thumbnail = _trim_cache_folder(
        thumbnail_cache_root(), THUMBNAIL_CACHE_MAX_BYTES, dry_run=dry_run, now=now
    )
    gif = _trim_cache_folder(gif_cache_root(), GIF_CACHE_MAX_BYTES, dry_run=dry_run, now=now)
    temporary = _trim_cache_folder(
        temporary_root(), TEMP_CACHE_MAX_BYTES, dry_run=dry_run,
        maximum_age_seconds=TEMP_FILE_MAX_AGE_SECONDS, now=now,
    )
    groups = {"thumbnails": thumbnail, "gif": gif, "temporary": temporary}
    return {
        "groups": groups,
        "candidateFiles": sum(group["candidateFiles"] for group in groups.values()),
        "candidateBytes": sum(group["candidateBytes"] for group in groups.values()),
        "deletedFiles": sum(group["deletedFiles"] for group in groups.values()),
        "reclaimedBytes": sum(group["reclaimedBytes"] for group in groups.values()),
        "dryRun": dry_run,
    }


def photo_root(settings: dict[str, Any] | None = None) -> Path:
    current = settings or load_settings()
    raw = str(current.get("storage", {}).get("localPhotoPath") or "").strip()
    if not raw:
        return PHOTO_ROOT.resolve()
    expanded = Path(os.path.expandvars(os.path.expanduser(raw)))
    if not expanded.is_absolute():
        raise ValueError("Folder foto lokal harus memakai path absolut")
    resolved = expanded.resolve()
    if resolved == Path(resolved.anchor):
        raise ValueError("Folder root sistem tidak boleh dipakai untuk menyimpan foto")
    return resolved


def validate_photo_root(settings: dict[str, Any]) -> Path:
    target = photo_root(settings)
    target.mkdir(parents=True, exist_ok=True)
    probe = target / f".photoslive-write-{uuid.uuid4().hex[:8]}"
    try:
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as error:
        raise ValueError(f"Folder foto tidak dapat ditulis: {error}") from error
    return target


def migrate_photo_root(source: Path, target: Path) -> None:
    if source == target or not source.exists():
        return
    entries = list(source.iterdir())
    conflicts = [entry.name for entry in entries if (target / entry.name).exists()]
    if conflicts:
        raise ValueError(f"Folder tujuan sudah memiliki nama yang sama: {', '.join(conflicts[:3])}")
    moved: list[tuple[Path, Path]] = []
    try:
        for entry in entries:
            destination = target / entry.name
            shutil.move(str(entry), str(destination))
            moved.append((entry, destination))
    except OSError as error:
        for original, destination in reversed(moved):
            if destination.exists() and not original.exists():
                shutil.move(str(destination), str(original))
        raise ValueError(f"Foto lama gagal dipindahkan: {error}") from error


def deep_merge(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def save_settings(incoming: dict[str, Any]) -> dict[str, Any]:
    current = load_settings()
    updated = deep_merge(current, incoming)
    old_root = photo_root(current)
    new_root = validate_photo_root(updated)
    migrate_photo_root(old_root, new_root)
    temporary_root().mkdir(parents=True, exist_ok=True)
    temp = temporary_root() / f"settings-{uuid.uuid4().hex}.tmp"
    temp.write_text(json.dumps(updated, indent=2), encoding="utf-8")
    temp.replace(SETTINGS_PATH)
    devices = updated.get("devices") if isinstance(updated.get("devices"), dict) else {}
    set_local_state("device_selection", {
        "preferredCamera": str(devices.get("preferredCamera") or "auto")[:240],
        "preferredPrinter": str(devices.get("preferredPrinter") or "auto")[:240],
        "cameraSource": str(devices.get("cameraSource") or "auto")[:40],
        "browserCameraId": str(devices.get("browserCameraId") or "")[:240],
    })
    with STORAGE_CACHE_LOCK:
        STORAGE_CACHE["createdAt"] = 0.0
        STORAGE_CACHE["payload"] = None
    add_event("settings", "Pengaturan booth diperbarui")
    return updated


def add_event(event_type: str, message: str) -> None:
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            "INSERT INTO events(id, type, message, created_at) VALUES (?, ?, ?, ?)",
            (str(uuid.uuid4()), event_type, message, utc_now()),
        )
        db.commit()


def command_output(command: list[str], timeout: float = 3.0) -> tuple[bool, str]:
    if shutil.which(command[0]) is None:
        return False, f"{command[0]} belum terpasang"
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        text = (result.stdout or result.stderr).strip()
        return result.returncode == 0, text
    except (subprocess.SubprocessError, OSError) as exc:
        return False, str(exc)


def command_bytes(command: list[str], timeout: float = 8.0) -> tuple[bool, bytes, str]:
    if shutil.which(command[0]) is None:
        return False, b"", f"{command[0]} belum terpasang"
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
        return result.returncode == 0, result.stdout, result.stderr.decode("utf-8", errors="replace").strip()
    except (subprocess.SubprocessError, OSError) as exc:
        return False, b"", str(exc)


def pick_local_folder() -> dict[str, str]:
    """Open the host operating system's folder picker for the signed-in user."""
    system = platform.system().lower()
    if system == "darwin":
        command = [
            "osascript",
            "-e",
            'POSIX path of (choose folder with prompt "Pilih folder foto Photoslive")',
        ]
        picker = "macOS"
    elif system == "windows":
        powershell = shutil.which("powershell.exe") or shutil.which("powershell")
        if not powershell:
            raise ValueError("PowerShell tidak tersedia untuk membuka pemilih folder")
        script = (
            "Add-Type -AssemblyName System.Windows.Forms; "
            "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; "
            "$dialog.Description = 'Pilih folder foto Photoslive'; "
            "$dialog.ShowNewFolderButton = $true; "
            "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
            "{ [Console]::Write($dialog.SelectedPath) }"
        )
        command = [powershell, "-NoProfile", "-STA", "-Command", script]
        picker = "Windows"
    elif shutil.which("zenity"):
        command = ["zenity", "--file-selection", "--directory", "--title=Pilih folder foto Photoslive"]
        picker = "Zenity"
    elif shutil.which("kdialog"):
        command = ["kdialog", "--getexistingdirectory", str(Path.home()), "--title", "Pilih folder foto Photoslive"]
        picker = "KDialog"
    else:
        raise ValueError("Pemilih folder grafis belum tersedia. Instal zenity atau masukkan path secara manual")

    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=300, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Pemilihan folder melewati batas waktu 5 menit") from error
    selected = result.stdout.strip().rstrip("\r\n")
    if result.returncode != 0 or not selected:
        raise ValueError(result.stderr.strip() or "Pemilihan folder dibatalkan")
    path = Path(selected).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise ValueError("Folder yang dipilih tidak valid")
    return {"path": str(path.resolve()), "picker": picker}


def active_camera() -> Device | None:
    devices = detect_devices()
    connected = [device for device in devices if device.kind == "camera" and device.status == "connected"]
    if not connected:
        return None
    selected = load_settings()["devices"]["preferredCamera"]
    return next((device for device in connected if device.id == selected), connected[0])


def hardware_simulator_enabled() -> bool:
    """Return true only for the explicit CI/development simulator."""
    return os.environ.get("PHOTOSLIVE_HARDWARE_SIMULATOR", "").strip() == "1"


def simulator_state(kind: str) -> str:
    allowed = {
        "camera": {"connected", "busy", "disconnected"},
        "printer": {"connected", "error", "disconnected"},
    }
    value = os.environ.get(f"PHOTOSLIVE_SIM_{kind.upper()}_STATE", "connected").strip().lower()
    return value if value in allowed[kind] else "disconnected"


def simulated_camera_image() -> tuple[bool, bytes, str]:
    state = simulator_state("camera")
    if state == "busy":
        return False, b"", "Kamera simulator sedang dipakai aplikasi lain"
    if state != "connected":
        return False, b"", "Kamera simulator terputus"
    if Image is None or ImageDraw is None:
        return False, b"", "Pillow diperlukan oleh simulator hardware"
    image = Image.new("RGB", (640, 480), "#1d2b4f")
    draw = ImageDraw.Draw(image)
    draw.rectangle((28, 28, 612, 452), outline="#79d5ff", width=5)
    draw.text((48, 54), "PHOTOSLIVE HARDWARE SIMULATOR", fill="white")
    draw.text((48, 402), utc_now(), fill="#a8c4e8")
    stream = io.BytesIO()
    image.save(stream, format="JPEG", quality=86)
    return True, stream.getvalue(), ""


def camera_image(capture: bool = False) -> tuple[bool, bytes, str]:
    camera = active_camera()
    if not camera:
        return False, b"", "Kamera belum tersambung. Webcam USB dan kamera gPhoto2 akan muncul setelah terdeteksi."
    if camera.id == "sim-camera":
        ok, data, error = simulated_camera_image()
    elif camera.id.startswith("gphoto-"):
        command = ["gphoto2", "--capture-image-and-download", "--stdout"] if capture else ["gphoto2", "--capture-preview", "--stdout"]
        ok, data, error = command_bytes(command, timeout=20 if capture else 12)
    elif camera.id.startswith("/dev/video"):
        ok, data, error = command_bytes(
            ["ffmpeg", "-loglevel", "error", "-f", "video4linux2", "-i", camera.id, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
            timeout=8,
        )
    else:
        return False, b"", f"Driver kamera {camera.detail} belum didukung"
    if not ok or not data:
        hint = " Pastikan FFmpeg terpasang dan user service memiliki izin membaca /dev/video*." if camera.id.startswith("/dev/video") else " Pastikan kamera berada pada mode PTP dan tidak sedang dipakai aplikasi lain."
        return False, b"", (error or "Kamera tidak mengirim gambar") + hint
    return True, data, ""


def camera_preview() -> tuple[bool, bytes, str]:
    return camera_image(capture=False)


def test_camera() -> tuple[bool, str]:
    camera = active_camera()
    if not camera:
        return False, "Tidak ada kamera aktif. Sambungkan webcam USB atau kamera PTP lalu cari perangkat."
    ok, data, error = camera_image(capture=False)
    if not ok:
        return False, error
    if camera.id == "sim-camera":
        camera_type = "Kamera virtual CI"
    elif camera.id.startswith("/dev/video"):
        camera_type = "Webcam USB (UVC/V4L2)"
    else:
        camera_type = "Kamera DSLR/mirrorless (gPhoto2/PTP)"
    return True, f"{camera_type} siap · {camera.name} · frame uji {len(data) // 1024 or 1} KB"


def build_photo_strip_test_page(settings: dict[str, Any]) -> Path:
    paper_sizes = {"4x6": (288, 432), "5x7": (360, 504), "6x8": (432, 576), "A4": (595, 842)}
    width, height = paper_sizes.get(settings["devices"]["paperSize"], paper_sizes["4x6"])
    strips = max(1, min(4, int(settings["devices"].get("stripsPerSheet", 2))))
    slots = max(1, min(8, int(settings["booth"].get("photoSlotsPerSession", 3))))
    margin, gap, caption_height = 18, 10, 34
    strip_width = (width - (2 * margin) - (gap * (strips - 1))) / strips
    photo_height = height - (2 * margin) - caption_height
    slot_gap = 4
    slot_height = (photo_height - (slot_gap * (slots - 1))) / slots
    commands = [
        "%!PS-Adobe-3.0", f"%%BoundingBox: 0 0 {width} {height}",
        f"<< /PageSize [{width} {height}] >> setpagedevice", "/Helvetica-Bold findfont 7 scalefont setfont",
    ]
    for strip_index in range(strips):
        x = margin + strip_index * (strip_width + gap)
        commands.append(f"0.94 setgray {x:.2f} {margin:.2f} {strip_width:.2f} {height - 2 * margin:.2f} rectfill")
        for slot_index in range(slots):
            y = height - margin - ((slot_index + 1) * slot_height) - (slot_index * slot_gap)
            commands.extend([
                f"0.72 setgray {x + 5:.2f} {y:.2f} {strip_width - 10:.2f} {slot_height:.2f} rectfill",
                f"0 setgray {x + 9:.2f} {y + slot_height - 12:.2f} moveto (FOTO {slot_index + 1}) show",
            ])
        commands.append(f"0 setgray {x + 7:.2f} {margin + 10:.2f} moveto (PHOTOSLIVE - STRIP {strip_index + 1}) show")
        if strip_index < strips - 1:
            cut_x = x + strip_width + (gap / 2)
            commands.extend(["[3 3] 0 setdash", f"0.55 setgray {cut_x:.2f} 8 moveto {cut_x:.2f} {height - 8} lineto stroke", "[] 0 setdash"])
    commands.extend(["showpage", "%%EOF"])
    target = DATA_ROOT / "photoslive-photo-strip-test.ps"
    target.write_text("\n".join(commands), encoding="ascii")
    return target


def print_test_page() -> tuple[bool, str]:
    printers = [device for device in detect_devices() if device.kind == "printer" and device.status == "connected"]
    if not printers:
        return False, "Printer belum tersambung"
    settings = load_settings()
    selected = settings["devices"]["preferredPrinter"]
    printer = next((device for device in printers if device.id == selected), printers[0])
    if printer.id == "sim-printer":
        if simulator_state("printer") == "error":
            return False, "Printer simulator menolak pekerjaan cetak"
        test_file = build_photo_strip_test_page(load_settings())
        queue_file = DATA_ROOT / "simulator-print-queue.jsonl"
        with queue_file.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"createdAt": utc_now(), "path": str(test_file), "kind": "test-page"}) + "\n")
        return True, "Lembar tes masuk antrean printer simulator"
    printer_name = printer.id.removeprefix("cups-")
    test_file = build_photo_strip_test_page(settings)
    ok, output = command_output(["lp", "-d", printer_name, str(test_file)], timeout=8)
    return ok, output or ("Lembar tes photo strip masuk antrean printer" if ok else "Gagal mengirim lembar tes photo strip")


def test_printer_connection() -> tuple[bool, str]:
    printers = [device for device in detect_devices() if device.kind == "printer" and device.status == "connected"]
    if not printers:
        return False, "Printer belum tersambung"
    settings = load_settings()
    selected = settings["devices"]["preferredPrinter"]
    printer = next((device for device in printers if device.id == selected), printers[0])
    if printer.id == "sim-printer":
        if simulator_state("printer") == "error":
            return False, "Printer simulator terdeteksi tetapi sedang error"
        return True, f"Printer simulator siap · {printer.name}"
    printer_name = printer.id.removeprefix("cups-")
    ok, output = command_output(["lpstat", "-p", printer_name])
    return ok, output or ("Printer siap" if ok else "Printer tidak tersedia")


def detect_devices() -> list[Device]:
    devices: list[Device] = []

    if hardware_simulator_enabled():
        camera_state = simulator_state("camera")
        printer_state = simulator_state("printer")
        devices.append(Device(
            "sim-camera",
            "Photoslive Virtual Webcam",
            "camera",
            "connected" if camera_state in {"connected", "busy"} else "disconnected",
            f"Hardware simulator · {camera_state}",
        ))
        devices.append(Device(
            "sim-printer",
            "Photoslive Virtual Printer",
            "printer",
            "connected" if printer_state in {"connected", "error"} else "disconnected",
            f"Hardware simulator · {printer_state}",
        ))
        return devices

    camera_ok, camera_output = command_output(["gphoto2", "--auto-detect"])
    camera_lines = [line.strip() for line in camera_output.splitlines()[2:] if line.strip()] if camera_ok else []
    for index, line in enumerate(camera_lines):
        devices.append(Device(f"gphoto-{index}", line.split("usb:")[0].strip(), "camera", "connected", "gPhoto2/PTP"))

    video_devices = sorted(Path("/dev").glob("video*"))
    for device_path in video_devices:
        sys_name = Path("/sys/class/video4linux") / device_path.name / "name"
        try:
            camera_name = sys_name.read_text(encoding="utf-8").strip()
        except OSError:
            camera_name = device_path.name
        devices.append(Device(str(device_path), camera_name or device_path.name, "camera", "connected", f"Webcam USB · UVC/V4L2 · {device_path}"))

    printer_ok, printer_output = command_output(["lpstat", "-p"])
    if printer_ok:
        for line in printer_output.splitlines():
            if not line.startswith("printer "):
                continue
            parts = line.split()
            name = parts[1] if len(parts) > 1 else "Printer"
            status = "connected" if "disabled" not in line.lower() else "attention"
            devices.append(Device(f"cups-{name}", name, "printer", status, "CUPS"))

    if not any(device.kind == "camera" for device in devices):
        detail = camera_output if not camera_ok and "belum terpasang" not in camera_output else "Webcam USB UVC/V4L2 atau kamera gPhoto2/PTP belum ditemukan"
        devices.append(Device("camera-none", "Kamera", "camera", "disconnected", detail[:160]))
    if not any(device.kind == "printer" for device in devices):
        devices.append(Device("printer-none", "Printer", "printer", "disconnected", "Tidak ada antrean CUPS aktif"))
    return devices


def list_assets() -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = {"background": [], "frame": [], "logo": [], "sticker": []}
    for kind in result:
        folder = UPLOAD_ROOT / kind
        folder.mkdir(parents=True, exist_ok=True)
        for path in sorted(folder.iterdir(), key=lambda item: item.stat().st_mtime, reverse=True):
            if path.is_file():
                result[kind].append({"name": path.name, "url": f"/uploads/{kind}/{path.name}"})
    return result


def safe_asset_name(value: str) -> str:
    clean = "".join(character for character in Path(value).name if character.isalnum() or character in "-_.")
    if not clean or Path(clean).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("Gunakan file PNG, JPG, JPEG, atau WebP")
    return clean


def renderer_capability() -> dict[str, Any]:
    available = Image is not None
    return {
        "available": available,
        "engine": "Pillow" if available else None,
        "reason": None if available else "Media renderer belum terpasang. Jalankan ulang installer Photoslive.",
    }


def default_frame_slot_transforms(slot_count: int) -> list[dict[str, Any]]:
    count = max(1, min(8, int(slot_count or 1)))
    gap = 1.5
    slot_height = min(28.0, (84.0 - gap * (count - 1)) / count)
    slot_width = min(88.0, slot_height * 3)
    return [
        {
            "x": 50.0,
            "y": 3.0 + slot_height / 2 + index * (slot_height + gap),
            "width": slot_width,
            "rotation": 0.0,
            "opacity": 100.0,
            "z": index + 1,
        }
        for index in range(count)
    ]


def frame_config_snapshot(settings: dict[str, Any], frame_id: str) -> dict[str, Any]:
    appearance = settings["appearance"]
    devices = settings["devices"]
    slots = max(1, min(8, int(appearance.get("framePhotoSlots", {}).get(frame_id, settings["booth"]["photoSlotsPerSession"]))))
    configured = appearance.get("frameSlotTransforms", {}).get(frame_id)
    slot_transforms = configured if isinstance(configured, list) and len(configured) == slots else default_frame_slot_transforms(slots)
    stickers = appearance.get("frameStickers", {}).get(frame_id)
    return {
        "frameId": frame_id,
        "photoSlots": slots,
        "backgroundTransform": appearance.get("frameBackgroundTransforms", {}).get(frame_id, {"zoom": 100, "x": 50, "y": 50}),
        "slotTransforms": slot_transforms,
        "stickers": stickers if isinstance(stickers, list) else [],
        "paperSize": str(devices.get("paperSize") or "4x6"),
        "printLayout": str(devices.get("printLayout") or "photo-strip-vertical"),
        "stripsPerSheet": max(1, min(4, int(devices.get("stripsPerSheet") or 1))),
    }


def _paper_pixels(paper_size: str) -> tuple[int, int]:
    return {
        "4x6": (1200, 1800),
        "5x7": (1500, 2100),
        "6x8": (1800, 2400),
        "A4": (2480, 3508),
    }.get(str(paper_size), (1200, 1800))


def _asset_path(url: str) -> Path | None:
    clean = str(url or "").split("?", 1)[0]
    if not clean.startswith("/uploads/"):
        return None
    target = (WEB_ROOT / clean.lstrip("/")).resolve()
    if WEB_ROOT not in target.parents or not target.is_file():
        return None
    return target


def _opened_rgba(path: Path) -> Any:
    if Image is None:
        raise ValueError(renderer_capability()["reason"])
    with Image.open(path) as source:
        return ImageOps.exif_transpose(source).convert("RGBA")


def _cover_image(source: Any, width: int, height: int, focal_x: float = 50, focal_y: float = 50, zoom: float = 100) -> Any:
    source_width, source_height = source.size
    scale = max(width / max(1, source_width), height / max(1, source_height)) * max(1.0, float(zoom or 100) / 100.0)
    resized_width = max(width, round(source_width * scale))
    resized_height = max(height, round(source_height * scale))
    resized = source.resize((resized_width, resized_height), Image.Resampling.LANCZOS)
    left = round((resized_width - width) * max(0.0, min(100.0, float(focal_x))) / 100.0)
    top = round((resized_height - height) * max(0.0, min(100.0, float(focal_y))) / 100.0)
    return resized.crop((left, top, left + width, top + height))


def _base_frame(frame_id: str, width: int, height: int, transform: dict[str, Any]) -> Any:
    asset = _asset_path(frame_id)
    if asset:
        source = _opened_rgba(asset)
        return _cover_image(
            source,
            width,
            height,
            float(transform.get("x", 50)),
            float(transform.get("y", 50)),
            float(transform.get("zoom", 100)),
        )
    if frame_id == "party-night":
        canvas = Image.new("RGBA", (width, height), "#211b32")
        draw = ImageDraw.Draw(canvas)
        for y in range(height):
            blend = y / max(1, height - 1)
            color = (
                round(35 + 87 * blend),
                round(28 + 65 * blend),
                round(57 + 81 * blend),
                255,
            )
            draw.line((0, y, width, y), fill=color)
        return canvas
    return Image.new("RGBA", (width, height), "#f4f4f0")


def _opacity(image: Any, percent: float) -> Any:
    value = max(0.0, min(100.0, float(percent))) / 100.0
    if value >= 1:
        return image
    alpha = image.getchannel("A")
    image.putalpha(ImageEnhance.Brightness(alpha).enhance(value))
    return image


def _paste_center(canvas: Any, layer: Any, x_percent: float, y_percent: float, rotation: float = 0) -> None:
    if rotation:
        layer = layer.rotate(-float(rotation), resample=Image.Resampling.BICUBIC, expand=True)
    x = round(canvas.width * float(x_percent) / 100.0 - layer.width / 2)
    y = round(canvas.height * float(y_percent) / 100.0 - layer.height / 2)
    canvas.alpha_composite(layer, (x, y))


def _frame_layer_items(frame_config: dict[str, Any], captures: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    transforms = frame_config.get("slotTransforms") if isinstance(frame_config.get("slotTransforms"), list) else []
    defaults = default_frame_slot_transforms(len(captures))
    layers = []
    for index, capture in enumerate(captures):
        transform = transforms[index] if index < len(transforms) and isinstance(transforms[index], dict) else defaults[index]
        layers.append({"type": "slot", "path": capture[1], "transform": transform, "z": float(transform.get("z", index + 1))})
    for index, sticker in enumerate(frame_config.get("stickers") or []):
        if isinstance(sticker, dict):
            layers.append({"type": "sticker", "sticker": sticker, "z": float(sticker.get("z", 10 + index))})
    return sorted(layers, key=lambda item: item["z"])


def render_session_outputs(session_id: str, frame_config: dict[str, Any], captures: list[tuple[Any, ...]]) -> list[dict[str, Any]]:
    """Render one customer frame plus one printer sheet using bounded images."""
    if Image is None:
        raise ValueError(renderer_capability()["reason"])
    paper_width, paper_height = _paper_pixels(str(frame_config.get("paperSize") or "4x6"))
    strips = 1 if frame_config.get("printLayout") == "full-photo" else max(1, min(4, int(frame_config.get("stripsPerSheet") or 1)))
    strip_width = max(300, paper_width // strips)
    canvas = _base_frame(
        str(frame_config.get("frameId") or "clean-white"),
        strip_width,
        paper_height,
        frame_config.get("backgroundTransform") if isinstance(frame_config.get("backgroundTransform"), dict) else {},
    )
    root = photo_root()
    for layer in _frame_layer_items(frame_config, captures):
        transform = layer.get("transform") or {}
        if layer["type"] == "slot":
            source_path = (root / str(layer["path"])).resolve()
            if root not in source_path.parents or not source_path.is_file():
                raise ValueError("Foto pilihan tidak ditemukan saat membuat hasil frame")
            width = max(80, round(canvas.width * max(10.0, min(100.0, float(transform.get("width", 84)))) / 100.0))
            photo = _cover_image(_opened_rgba(source_path), width, width)
            photo = _opacity(photo, float(transform.get("opacity", 100)))
            _paste_center(canvas, photo, float(transform.get("x", 50)), float(transform.get("y", 15)), float(transform.get("rotation", 0)))
        else:
            sticker = layer["sticker"]
            sticker_path = _asset_path(str(sticker.get("url") or ""))
            if not sticker_path:
                continue
            source = _opened_rgba(sticker_path)
            width = max(20, round(canvas.width * max(2.0, min(100.0, float(sticker.get("size", 28)))) / 100.0))
            height = max(1, round(source.height * width / max(1, source.width)))
            source = source.resize((width, height), Image.Resampling.LANCZOS)
            source = _opacity(source, float(sticker.get("opacity", 100)))
            _paste_center(canvas, source, float(sticker.get("x", 50)), float(sticker.get("y", 88)), float(sticker.get("rotation", 0)))

    session_folder = root / session_id
    session_folder.mkdir(parents=True, exist_ok=True)
    composite_path = session_folder / "result-frame.jpg"
    print_path = session_folder / "result-print-sheet.jpg"
    temporary = temporary_root()
    temporary.mkdir(parents=True, exist_ok=True)
    composite_temp = temporary / f"{session_id}-frame.tmp"
    print_temp = temporary / f"{session_id}-print.tmp"
    canvas.convert("RGB").save(composite_temp, "JPEG", quality=88, optimize=True, progressive=True)
    composite_temp.replace(composite_path)
    sheet = Image.new("RGB", (paper_width, paper_height), "white")
    strip_rgb = canvas.convert("RGB")
    for index in range(strips):
        sheet.paste(strip_rgb, (index * strip_width, 0))
    sheet.save(print_temp, "JPEG", quality=88, optimize=True, progressive=True)
    print_temp.replace(print_path)
    return [
        {"id": f"{session_id}:composite", "path": str(composite_path.relative_to(root)), "kind": "composite", "selected": True, "contentType": "image/jpeg"},
        {"id": f"{session_id}:print-sheet", "path": str(print_path.relative_to(root)), "kind": "print-sheet", "selected": False, "contentType": "image/jpeg"},
    ]


def render_session_gif(session_id: str, captures: list[tuple[Any, ...]]) -> dict[str, Any]:
    """Create a bounded flipbook GIF from selected captures.

    This intentionally runs outside the completion request. A 640 px maximum
    keeps CPU, memory, cache, and upload cost predictable on a 4 GB kiosk.
    """
    if Image is None:
        raise ValueError(renderer_capability()["reason"])
    root = photo_root()
    frames = []
    for capture in captures[:8]:
        source_path = (root / str(capture[1])).resolve()
        if root not in source_path.parents or not source_path.is_file():
            raise ValueError("Foto pilihan tidak ditemukan saat membuat GIF")
        frame = _cover_image(_opened_rgba(source_path), 640, 640).convert("P", palette=Image.Palette.ADAPTIVE, colors=128)
        frames.append(frame)
    if not frames:
        raise ValueError("Tidak ada foto pilihan untuk membuat GIF")
    session_folder = root / session_id
    session_folder.mkdir(parents=True, exist_ok=True)
    target = session_folder / "result-flipbook.gif"
    temporary = temporary_root()
    temporary.mkdir(parents=True, exist_ok=True)
    temp = temporary / f"{session_id}-flipbook.tmp"
    frames[0].save(
        temp,
        "GIF",
        save_all=True,
        append_images=frames[1:],
        duration=650,
        loop=0,
        optimize=True,
        disposal=2,
    )
    temp.replace(target)
    return {
        "id": f"{session_id}:gif",
        "path": str(target.relative_to(root)),
        "kind": "gif",
        "contentType": "image/gif",
        "checksumSha256": file_checksum(target),
    }


def file_checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def disk_metrics(path: Path | None = None) -> dict[str, Any]:
    # Acceptance tests may run on a developer volume that is already below the
    # production 10% safety threshold. Keep those tests deterministic without
    # weakening the real reserve: the override is accepted only in explicit
    # test mode and requires internally consistent byte values.
    if os.environ.get("PHOTOSLIVE_TEST_MODE") == "1":
        try:
            test_total = int(os.environ.get("PHOTOSLIVE_TEST_DISK_TOTAL_BYTES", "0"))
            test_free = int(os.environ.get("PHOTOSLIVE_TEST_DISK_FREE_BYTES", "-1"))
        except ValueError:
            test_total = test_free = 0
        if test_total > 0 and 0 <= test_free <= test_total:
            used = test_total - test_free
            return {
                "totalBytes": test_total,
                "usedBytes": used,
                "freeBytes": test_free,
                "usedPercent": round((used / test_total) * 100, 1),
            }
    usage = shutil.disk_usage(path or ROOT)
    return {
        "totalBytes": usage.total,
        "usedBytes": usage.used,
        "freeBytes": usage.free,
        "usedPercent": round((usage.used / usage.total) * 100, 1),
    }


def storage_safety(path: Path | None = None) -> dict[str, Any]:
    metrics = disk_metrics(path)
    free_percent = (metrics["freeBytes"] / metrics["totalBytes"] * 100) if metrics["totalBytes"] else 0
    blocked = metrics["freeBytes"] < MINIMUM_FREE_STORAGE_BYTES or free_percent < 10
    warning = blocked or free_percent < 20
    return {
        "state": "critical" if blocked else ("warning" if warning else "ready"),
        "blocked": blocked,
        "warning": warning,
        "freePercent": round(free_percent, 1),
        "reserveBytes": MINIMUM_FREE_STORAGE_BYTES,
        "message": (
            "Ruang foto kritis. Kosongkan penyimpanan sebelum memulai sesi baru."
            if blocked else
            "Ruang foto tinggal kurang dari 20%. Jadwalkan cleanup setelah upload selesai."
            if warning else
            "Penyimpanan siap"
        ),
    }


def memory_metrics() -> dict[str, Any]:
    data: dict[str, int] = {}
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            key, value = line.split(":", 1)
            data[key] = int(value.strip().split()[0]) * 1024
    except (OSError, ValueError):
        try:
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            total = page_size * int(os.sysconf("SC_PHYS_PAGES"))
            available = page_size * int(os.sysconf("SC_AVPHYS_PAGES"))
            used = max(0, total - available)
            if total > 0:
                return {
                    "available": True,
                    "totalBytes": total,
                    "usedBytes": used,
                    "usedPercent": round((used / total) * 100, 1),
                }
        except (OSError, ValueError):
            pass
        host_ok, host_output = command_output(["hostinfo"])
        memory_line = next((line for line in host_output.splitlines() if "Primary memory available:" in line), "") if host_ok else ""
        if memory_line:
            parts = memory_line.split(":", 1)[1].strip().split()
            try:
                amount = float(parts[0])
                multiplier = 1024 ** 3 if parts[1].lower().startswith("giga") else 1024 ** 2
                total = int(amount * multiplier)
                vm_ok, vm_output = command_output(["vm_stat"])
                page_size = 4096
                values: dict[str, int] = {}
                if vm_ok:
                    for line in vm_output.splitlines():
                        if "page size of" in line:
                            size_text = line.split("page size of", 1)[1].split("bytes", 1)[0]
                            page_size = int("".join(character for character in size_text if character.isdigit()) or page_size)
                        elif ":" in line:
                            key, value = line.split(":", 1)
                            values[key.strip()] = int(value.strip().rstrip(".") or 0)
                available = sum(values.get(key, 0) for key in ("Pages free", "Pages inactive", "Pages speculative")) * page_size
                used = max(0, total - available)
                return {"available": True, "totalBytes": total, "usedBytes": used, "usedPercent": round((used / total) * 100, 1)}
            except (ValueError, IndexError):
                pass
        ok, total_output = command_output(["sysctl", "-n", "hw.memsize"])
        if not ok or not total_output.isdigit():
            return {"available": False}
        total = int(total_output)
        vm_ok, vm_output = command_output(["vm_stat"])
        page_size = 4096
        values: dict[str, int] = {}
        if vm_ok:
            for line in vm_output.splitlines():
                if "page size of" in line:
                    digits = "".join(character for character in line if character.isdigit())
                    page_size = int(digits or page_size)
                elif ":" in line:
                    key, value = line.split(":", 1)
                    values[key.strip()] = int(value.strip().rstrip(".") or 0)
        available = sum(values.get(key, 0) for key in ("Pages free", "Pages inactive", "Pages speculative")) * page_size
        used = max(0, total - available) if values else 0
        return {
            "available": True,
            "totalBytes": total,
            "usedBytes": used,
            "usedPercent": round((used / total) * 100, 1) if total and values else 0,
        }
    total = data.get("MemTotal", 0)
    available = data.get("MemAvailable", 0)
    return {
        "available": True,
        "totalBytes": total,
        "usedBytes": max(0, total - available),
        "usedPercent": round(((total - available) / total) * 100, 1) if total else 0,
    }


def cpu_metrics() -> dict[str, Any]:
    cores = max(1, int(os.cpu_count() or 1))
    try:
        load_1m, load_5m, load_15m = os.getloadavg()
    except (AttributeError, OSError):
        return {"available": False, "cores": cores}
    return {
        "available": True,
        "cores": cores,
        "load1m": round(load_1m, 2),
        "load5m": round(load_5m, 2),
        "load15m": round(load_15m, 2),
        "loadPercent": round(min(100.0, (load_1m / cores) * 100), 1),
    }


def photo_library_metrics() -> dict[str, int]:
    root = photo_root()
    files = 0
    total_bytes = 0
    session_folders: set[str] = set()
    pending = [root]
    while pending:
        folder = pending.pop()
        try:
            for entry in os.scandir(folder):
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                    if folder == root:
                        session_folders.add(entry.name)
                elif entry.is_file(follow_symlinks=False):
                    files += 1
                    total_bytes += entry.stat(follow_symlinks=False).st_size
        except OSError:
            continue
    return {"fileCount": files, "totalBytes": total_bytes, "sessionFolders": len(session_folders)}


def storage_snapshot(force: bool = False) -> dict[str, Any]:
    now = time.time()
    with STORAGE_CACHE_LOCK:
        cached = STORAGE_CACHE.get("payload")
        created_at = float(STORAGE_CACHE.get("createdAt", 0))
        if cached and not force and now - created_at < STORAGE_CACHE_SECONDS:
            return {**cached, "cached": True, "cacheAgeSeconds": int(now - created_at)}
        payload = {
            "measuredAt": utc_now(),
            "localPath": str(photo_root()),
            "disk": disk_metrics(photo_root()),
            "safety": storage_safety(photo_root()),
            "memory": memory_metrics(),
            "library": photo_library_metrics(),
            "managedCache": maintain_local_cache(dry_run=True),
            "cacheSeconds": STORAGE_CACHE_SECONDS,
            "cached": False,
            "cacheAgeSeconds": 0,
        }
        STORAGE_CACHE["createdAt"] = now
        STORAGE_CACHE["payload"] = payload
        return payload


def recent_photo_sessions(hours: int = 24) -> list[dict[str, Any]]:
    root = photo_root()
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=max(1, min(hours, 168)))).isoformat()
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            """
            SELECT s.id, s.share_token, s.status, s.created_at, s.expires_at, s.uploaded_at,
                   COUNT(f.id), s.photo_slots,
                   COALESCE(SUM(CASE WHEN f.is_selected = 1 THEN 1 ELSE 0 END), 0)
            FROM photo_sessions s
            LEFT JOIN photo_files f ON f.session_id = s.id
            WHERE s.created_at >= ?
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT 200
            """,
            (cutoff,),
        ).fetchall()
        sessions: list[dict[str, Any]] = []
        for row in rows:
            file_rows = db.execute("SELECT path FROM photo_files WHERE session_id = ?", (row[0],)).fetchall()
            total_bytes = 0
            for (relative_path,) in file_rows:
                try:
                    total_bytes += (root / relative_path).stat().st_size
                except OSError:
                    pass
            sessions.append({
                "id": row[0], "shareToken": row[1], "status": row[2], "createdAt": row[3],
                "expiresAt": row[4], "uploadedAt": row[5], "photoCount": row[6],
                "photoSlots": row[7], "selectedPhotoCount": row[8],
                "totalBytes": total_bytes, "shareUrl": f"/session/{row[1]}",
            })
    return sessions


def _session_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def session_recovery_overview(limit: int = 10) -> dict[str, Any]:
    """Return a bounded, secret-free projection of locally recoverable sessions."""
    maximum = max(1, min(int(limit or 10), 10))
    timestamp = datetime.now(timezone.utc)
    cutoff = (timestamp - timedelta(hours=24)).isoformat()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "UPDATE photo_sessions SET status = 'expired' WHERE status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?",
            (timestamp.isoformat(),),
        )
        rows = db.execute(
            """
            SELECT s.id, s.status, s.created_at, s.deadline_at, s.photo_slots,
                   COUNT(CASE WHEN f.file_kind = 'capture' THEN 1 END),
                   COALESCE(SUM(CASE WHEN f.file_kind = 'capture' AND f.is_selected = 1 THEN 1 ELSE 0 END), 0)
            FROM photo_sessions s
            LEFT JOIN photo_files f ON f.session_id = s.id
            WHERE s.created_at >= ? AND s.status IN ('active', 'expired')
            GROUP BY s.id
            ORDER BY s.created_at DESC
            LIMIT ?
            """,
            (cutoff, maximum),
        ).fetchall()
        db.commit()
    sessions = [{
        "id": row[0], "status": row[1], "createdAt": row[2], "deadlineAt": row[3],
        "photoSlots": int(row[4] or 1), "captureCount": int(row[5] or 0),
        "selectedPhotoCount": int(row[6] or 0),
    } for row in rows]
    return {"sessions": sessions, "measuredAt": timestamp.isoformat(), "retentionHours": 24}


def recover_photo_session(session_id: str, extension_seconds: int = 180) -> dict[str, Any]:
    clean_id = str(session_id or "").strip()
    if not clean_id:
        raise ValueError("ID sesi wajib diisi")
    extension = max(60, min(int(extension_seconds or 180), 900))
    timestamp = datetime.now(timezone.utc)
    cutoff = timestamp - timedelta(hours=24)
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "UPDATE photo_sessions SET status = 'expired' WHERE status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?",
            (timestamp.isoformat(),),
        )
        target = db.execute(
            "SELECT status, created_at FROM photo_sessions WHERE id = ?",
            (clean_id,),
        ).fetchone()
        if not target:
            db.rollback()
            raise ValueError("Sesi foto tidak ditemukan")
        created_at = _session_time(target[1])
        if target[0] not in {"active", "expired"} or not created_at or created_at < cutoff:
            db.rollback()
            raise ValueError("Sesi ini sudah tidak dapat dipulihkan")
        competing = db.execute(
            "SELECT id FROM photo_sessions WHERE status = 'active' AND id != ? LIMIT 1",
            (clean_id,),
        ).fetchone()
        if competing:
            db.rollback()
            raise ValueError("Selesaikan sesi aktif lain sebelum memulihkan sesi ini")
        deadline = timestamp + timedelta(seconds=extension)
        db.execute(
            "UPDATE photo_sessions SET status = 'active', deadline_at = ? WHERE id = ?",
            (deadline.isoformat(), clean_id),
        )
        db.commit()
    add_event("session", f"Sesi {clean_id} dipulihkan selama {extension} detik")
    session = next((item for item in session_recovery_overview(10)["sessions"] if item["id"] == clean_id), None)
    return session or {"id": clean_id, "status": "active", "deadlineAt": deadline.isoformat()}


def current_recoverable_session() -> dict[str, Any] | None:
    """Local booth-only recovery capability. Never send this payload in heartbeat."""
    session_recovery_overview(10)
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute(
            "SELECT share_token FROM photo_sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
    if not row:
        return None
    summary = session_summary(row[0])
    return {**summary, "shareToken": row[0]} if summary else None


def reset_e2e_sessions() -> dict[str, int]:
    """Reset only unfinished test sessions; never expose this in production."""
    if os.environ.get("PHOTOSLIVE_TEST_MODE") != "1":
        raise ValueError("Test reset tidak tersedia")
    with sqlite3.connect(DB_PATH) as db:
        cursor = db.execute(
            "UPDATE photo_sessions SET status = 'cancelled' WHERE status = 'active'"
        )
        db.commit()
    return {"cancelled": max(0, int(cursor.rowcount or 0))}


def create_photo_session(frame_id: str | None = None, consent: dict[str, Any] | None = None) -> dict[str, Any]:
    session_id = f"SES-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4].upper()}"
    # Public download URLs are bearer capabilities. Keep at least 128 bits of
    # cryptographic randomness in the URL instead of the previous 64-bit
    # truncated token.
    token = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc)
    settings = load_settings()
    booth = settings["booth"]
    appearance = settings["appearance"]
    devices = settings["devices"]
    if booth["maintenanceMode"]:
        raise ValueError("Photobox sedang dalam mode perawatan")
    policy = offline_policy_status()
    if not policy["allowNewSession"]:
        raise ValueError(policy["message"])
    storage = storage_safety(photo_root(settings))
    if storage["blocked"]:
        raise ValueError(storage["message"])
    if storage["warning"]:
        add_event("storage", storage["message"])
    today = datetime.now().date().isoformat()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("INSERT OR IGNORE INTO daily_usage(day) VALUES (?)", (today,))
        sessions_today = int(db.execute("SELECT sessions FROM daily_usage WHERE day = ?", (today,)).fetchone()[0])
        if sessions_today >= int(booth["dailySessionLimit"]):
            raise ValueError("Batas sesi hari ini sudah tercapai")
        db.commit()
    retention = int(booth["localRetentionHours"])
    selected_frame = str(frame_id or appearance["activeFrame"])
    configured_slots = appearance.get("framePhotoSlots", {}).get(selected_frame, booth["photoSlotsPerSession"])
    photo_slots = max(1, min(8, int(configured_slots)))
    unlimited_retakes = bool(booth.get("unlimitedRetakes", True))
    retake_limit = 9999 if unlimited_retakes else max(0, min(10, int(booth["retakeLimit"])))
    timeout_seconds = max(30, min(1800, int(booth["sessionTimeoutSeconds"])))
    deadline_at = created_at + timedelta(seconds=timeout_seconds)
    expires_at = created_at + timedelta(hours=retention)
    frozen_frame_config = frame_config_snapshot(settings, selected_frame)
    consent_at = created_at.isoformat() if consent and consent.get("accepted") is True else None
    consent_version = PHOTO_CONSENT_VERSION if consent_at else None
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """INSERT INTO photo_sessions(
                 id, share_token, frame_id, photo_slots, retake_limit, timeout_seconds, strips_per_sheet,
                 print_layout, frame_config_json, deadline_at, created_at, expires_at, consent_at, consent_version
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, token, selected_frame, photo_slots, retake_limit, timeout_seconds, int(devices["stripsPerSheet"]),
             devices["printLayout"], json.dumps(frozen_frame_config), deadline_at.isoformat(), created_at.isoformat(), expires_at.isoformat(), consent_at, consent_version),
        )
        db.execute("UPDATE daily_usage SET sessions = sessions + 1 WHERE day = ?", (today,))
        db.commit()
    add_event("session", f"Sesi foto {session_id} dibuat")
    return {
        "id": session_id, "shareToken": token, "frameId": selected_frame, "status": "active", "createdAt": created_at.isoformat(),
        "deadlineAt": deadline_at.isoformat(), "expiresAt": expires_at.isoformat(), "shareUrl": f"/session/{token}",
        "consent": {"acceptedAt": consent_at, "version": consent_version} if consent_at else None,
        "rules": {
            "photoSlots": photo_slots, "retakeLimitPerSlot": None if unlimited_retakes else retake_limit,
            "unlimitedRetakes": unlimited_retakes,
            "maxAttemptsPerSlot": None if unlimited_retakes else retake_limit + 1, "timeoutSeconds": timeout_seconds,
            "countdownSeconds": int(booth["countdownSeconds"]), "prints": int(booth["printsPerSession"]),
            "stripsPerSheet": int(devices["stripsPerSheet"]), "printLayout": devices["printLayout"],
        },
        "slots": [{"index": index, "status": "pending", "attempts": [], "selectedFileId": None} for index in range(1, photo_slots + 1)],
    }


def session_summary(token: str) -> dict[str, Any] | None:
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute(
            """SELECT id, status, created_at, deadline_at, expires_at, uploaded_at,
                      photo_slots, retake_limit, timeout_seconds, strips_per_sheet, print_layout, frame_id
               FROM photo_sessions WHERE share_token = ?""",
            (token,),
        ).fetchone()
        if not row:
            return None
        files = db.execute(
            """SELECT id, path, uploaded_at, created_at, slot_index, attempt_number, is_selected, file_kind
               FROM photo_files WHERE session_id = ? ORDER BY slot_index, attempt_number""",
            (row[0],),
        ).fetchall()
    slot_data = []
    for slot_index in range(1, int(row[6]) + 1):
        attempts = [item for item in files if item[4] == slot_index and item[7] == "capture"]
        selected = next((item[0] for item in attempts if item[6]), None)
        slot_data.append({
            "index": slot_index, "status": "selected" if selected else "pending",
            "selectedFileId": selected,
            "attempts": [{"id": item[0], "name": Path(item[1]).name, "attemptNumber": item[5], "selected": bool(item[6])} for item in attempts],
        })
    return {
        "id": row[0], "status": row[1], "createdAt": row[2], "deadlineAt": row[3],
        "expiresAt": row[4], "uploadedAt": row[5], "frameId": row[11],
        "rules": {
            "photoSlots": row[6],
            "retakeLimitPerSlot": None if row[7] >= 9999 else row[7],
            "unlimitedRetakes": row[7] >= 9999,
            "maxAttemptsPerSlot": None if row[7] >= 9999 else row[7] + 1,
            "timeoutSeconds": row[8], "stripsPerSheet": row[9], "printLayout": row[10],
        },
        "slots": slot_data,
        "files": [{
            "id": item[0], "name": Path(item[1]).name, "uploadedAt": item[2], "createdAt": item[3],
            "slotIndex": item[4], "attemptNumber": item[5], "selected": bool(item[6]), "kind": item[7],
            "url": f"/api/session-files/{item[0]}",
        } for item in files],
    }


def session_page(token: str) -> bytes | None:
    session = session_summary(token)
    if not session:
        return None
    title = session["id"].replace("<", "&lt;").replace(">", "&gt;")
    created = session["createdAt"].replace("<", "&lt;").replace(">", "&gt;")
    file_items = "".join(f"<li>{item['name'].replace('<', '&lt;').replace('>', '&gt;')}</li>" for item in session["files"]) or "<li>Foto belum tersedia.</li>"
    return f"""<!doctype html><html lang='id'><meta charset='utf-8'><meta name='viewport' content='width=device-width'><title>{title}</title><style>body{{font:16px system-ui;margin:0;background:#f5f6f8;color:#171a21}}main{{max-width:720px;margin:48px auto;padding:24px}}section{{background:#fff;border:1px solid #e0e3e8;border-radius:14px;padding:28px}}small{{color:#667085}}li{{padding:12px 0;border-bottom:1px solid #e0e3e8}}</style><main><section><small>PHOTOSLIVE · SESI FOTO</small><h1>{title}</h1><p>Dibuat {created}</p><h2>File sesi</h2><ul>{file_items}</ul></section></main></html>""".encode("utf-8")


def network_metrics() -> dict[str, Any]:
    ok, output = command_output(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi"])
    active = next((line for line in output.splitlines() if line.startswith("yes:")), "") if ok else ""
    if active:
        _, ssid, signal_strength = (active.split(":", 2) + ["", ""])[:3]
        return {"connected": True, "ssid": ssid, "signalPercent": int(signal_strength or 0)}
    return {"connected": False, "ssid": "Offline", "signalPercent": 0, "detail": output[:120]}


def today_usage() -> dict[str, int]:
    today = datetime.now().date().isoformat()
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute(
            "SELECT sessions, photos, prints, revenue FROM daily_usage WHERE day = ?", (today,)
        ).fetchone()
    sessions, photos, prints, revenue = row or (0, 0, 0, 0)
    return {"sessions": sessions, "photos": photos, "prints": prints, "revenue": revenue}


def recent_events() -> list[dict[str, str]]:
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            "SELECT type, message, created_at FROM events ORDER BY created_at DESC LIMIT 12"
        ).fetchall()
    return [{"type": row[0], "message": row[1], "createdAt": row[2]} for row in rows]


def list_vouchers(limit: int = 100) -> list[dict[str, Any]]:
    safe_limit = max(1, min(500, int(limit)))
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            """
            SELECT v.code, v.event_id, v.includes_print, v.created_at, e.name
            FROM vouchers v
            LEFT JOIN voucher_events e ON e.id = v.event_id
            WHERE v.redeemed_at IS NULL
              AND (v.event_id IS NULL OR datetime(e.expires_at) > datetime('now', 'localtime'))
            ORDER BY v.rowid DESC LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
    return [{"code": row[0], "eventId": row[1], "includesPrint": bool(row[2]), "createdAt": row[3], "eventName": row[4], "status": "active"} for row in rows]


def create_voucher(payload: dict[str, Any]) -> dict[str, Any]:
    code = str(payload.get("code") or f"PBX-{uuid.uuid4().hex[:8].upper()}").strip().upper()
    if len(code) < 6 or len(code) > 40:
        raise ValueError("Kode voucher harus 6-40 karakter")
    if not re.fullmatch(r"[A-Z0-9-]+", code):
        raise ValueError("Kode voucher hanya boleh berisi huruf, angka, dan tanda hubung")
    created_at = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        try:
            db.execute(
                "INSERT INTO vouchers(code, package_name, expires_at, event_id, includes_print, created_at) VALUES (?, '1 sesi', NULL, NULL, 1, ?)",
                (code, created_at),
            )
            db.commit()
        except sqlite3.IntegrityError as exc:
            raise ValueError("Kode voucher sudah digunakan") from exc
    add_event("voucher", f"Voucher {code} dibuat")
    return {"code": code, "eventId": None, "includesPrint": True, "createdAt": created_at, "status": "active"}


def parse_event_expiry(value: Any) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise ValueError("Tanggal berakhir event wajib diisi")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Tanggal berakhir event tidak valid") from exc
    comparison = datetime.now(parsed.tzinfo) if parsed.tzinfo else datetime.now()
    if parsed <= comparison:
        raise ValueError("Tanggal berakhir event harus di masa depan")
    return parsed


def create_voucher_event(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    if len(name) < 2 or len(name) > 80:
        raise ValueError("Nama event harus 2-80 karakter")
    expires_at = parse_event_expiry(payload.get("expiresAt")).isoformat(timespec="minutes")
    includes_print = bool(payload.get("includesPrint", True))
    event_id = f"EVT-{uuid.uuid4().hex[:10].upper()}"
    created_at = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            "INSERT INTO voucher_events(id, name, expires_at, includes_print, created_at) VALUES (?, ?, ?, ?, ?)",
            (event_id, name, expires_at, int(includes_print), created_at),
        )
        db.commit()
    add_event("voucher", f"Event voucher {name} dibuat")
    return {"id": event_id, "name": name, "expiresAt": expires_at, "includesPrint": includes_print, "createdAt": created_at, "total": 0, "active": 0, "used": 0, "status": "active"}


def voucher_event_expired(expires_at: str) -> bool:
    try:
        parsed = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        comparison = datetime.now(parsed.tzinfo) if parsed.tzinfo else datetime.now()
        return parsed <= comparison
    except (TypeError, ValueError):
        return True


def list_voucher_events() -> list[dict[str, Any]]:
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            """
            SELECT e.id, e.name, e.expires_at, e.includes_print, e.created_at,
                   COUNT(v.code),
                   SUM(CASE WHEN v.code IS NOT NULL AND v.redeemed_at IS NULL THEN 1 ELSE 0 END),
                   SUM(CASE WHEN v.code IS NOT NULL AND v.redeemed_at IS NOT NULL THEN 1 ELSE 0 END)
            FROM voucher_events e
            LEFT JOIN vouchers v ON v.event_id = e.id
            GROUP BY e.id
            ORDER BY e.created_at DESC
            """
        ).fetchall()
    events = []
    for row in rows:
        expired = voucher_event_expired(row[2])
        events.append({"id": row[0], "name": row[1], "expiresAt": row[2], "includesPrint": bool(row[3]), "createdAt": row[4], "total": int(row[5] or 0), "active": 0 if expired else int(row[6] or 0), "used": int(row[7] or 0), "status": "expired" if expired else "active"})
    return events


def voucher_summary() -> dict[str, int]:
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute(
            """
            SELECT
              SUM(CASE WHEN event_id IS NULL AND redeemed_at IS NULL THEN 1 ELSE 0 END),
              SUM(CASE WHEN redeemed_at IS NOT NULL THEN 1 ELSE 0 END)
            FROM vouchers
            """
        ).fetchone()
    event_active = sum(event["active"] for event in list_voucher_events())
    return {"generalActive": int(row[0] or 0), "eventActive": event_active, "used": int(row[1] or 0)}


def generate_vouchers(payload: dict[str, Any]) -> dict[str, Any]:
    count = int(payload.get("count") or 100)
    if count < 1 or count > 500:
        raise ValueError("Jumlah voucher harus 1-500")
    event_id = str(payload.get("eventId") or "").strip() or None
    includes_print = True
    prefix = "PBX"
    if event_id:
        with sqlite3.connect(DB_PATH) as db:
            event = db.execute("SELECT name, expires_at, includes_print FROM voucher_events WHERE id = ?", (event_id,)).fetchone()
        if not event:
            raise ValueError("Event tidak ditemukan")
        if voucher_event_expired(event[1]):
            raise ValueError("Event sudah berakhir")
        includes_print = bool(event[2])
        prefix = f"EVT-{event_id[-4:]}"
    created_at = utc_now()
    codes: list[str] = []
    with sqlite3.connect(DB_PATH) as db:
        while len(codes) < count:
            code = f"{prefix}-{uuid.uuid4().hex[:8].upper()}"
            try:
                db.execute(
                    "INSERT INTO vouchers(code, package_name, expires_at, event_id, includes_print, created_at) VALUES (?, '1 sesi', NULL, ?, ?, ?)",
                    (code, event_id, int(includes_print), created_at),
                )
                codes.append(code)
            except sqlite3.IntegrityError:
                continue
        db.commit()
    add_event("voucher", f"{count} voucher {'event' if event_id else 'umum'} dibuat")
    return {"created": count, "eventId": event_id, "codes": codes}


def redeem_voucher(payload: dict[str, Any]) -> dict[str, Any]:
    code = str(payload.get("code") or "").strip().upper()
    if not code:
        raise ValueError("Kode voucher wajib diisi")
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            """SELECT v.event_id, v.includes_print, v.redeemed_at, e.name, e.expires_at
               FROM vouchers v LEFT JOIN voucher_events e ON e.id = v.event_id WHERE v.code = ?""",
            (code,),
        ).fetchone()
        if not row:
            raise ValueError("Voucher tidak ditemukan")
        if row[2]:
            raise ValueError("Voucher sudah pernah dipakai")
        if row[0] and voucher_event_expired(row[4]):
            raise ValueError("Voucher event sudah kedaluwarsa")
        redeemed_at = utc_now()
        result = db.execute("UPDATE vouchers SET redeemed_at = ? WHERE code = ? AND redeemed_at IS NULL", (redeemed_at, code))
        db.commit()
    if not result.rowcount:
        raise ValueError("Voucher sudah pernah dipakai")
    add_event("voucher", f"Voucher {code} dipakai")
    return {"code": code, "eventId": row[0], "eventName": row[3], "includesPrint": bool(row[1]), "redeemedAt": redeemed_at}


def sync_cloud_vouchers(payload: dict[str, Any]) -> dict[str, Any]:
    """Replace the active cloud voucher cache without losing offline redemptions."""
    vouchers = payload.get("vouchers") if isinstance(payload.get("vouchers"), list) else []
    events = payload.get("events") if isinstance(payload.get("events"), list) else []
    version = max(0, int(payload.get("version") or 0))
    synced_at = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        locally_redeemed = {
            row[0]: row[1]
            for row in db.execute(
                "SELECT code, redeemed_at FROM vouchers WHERE source = 'cloud' AND redeemed_at IS NOT NULL"
            ).fetchall()
        }
        db.execute("DELETE FROM voucher_events")
        for item in events[:500]:
            if not isinstance(item, dict):
                continue
            event_id = str(item.get("id") or "").strip()[:80]
            expires_at = str(item.get("expiresAt") or "").strip()
            if not event_id or not expires_at:
                continue
            db.execute(
                """INSERT OR REPLACE INTO voucher_events(id, name, expires_at, includes_print, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (
                    event_id,
                    str(item.get("name") or "Event")[:80],
                    expires_at,
                    int(bool(item.get("includesPrint", True))),
                    str(item.get("createdAt") or synced_at),
                ),
            )
        db.execute("DELETE FROM vouchers WHERE source = 'cloud' AND redeemed_at IS NULL")
        imported = 0
        for item in vouchers[:5000]:
            if not isinstance(item, dict):
                continue
            code = str(item.get("code") or "").strip().upper()[:40]
            if not code or not re.fullmatch(r"[A-Z0-9-]+", code):
                continue
            cloud_redeemed = str(item.get("redeemedAt") or "").strip() or None
            redeemed_at = locally_redeemed.get(code) or cloud_redeemed
            db.execute(
                """INSERT INTO vouchers(code, package_name, expires_at, redeemed_at, event_id,
                                          includes_print, created_at, source)
                   VALUES (?, '1 sesi', NULL, ?, ?, ?, ?, 'cloud')
                   ON CONFLICT(code) DO UPDATE SET
                     redeemed_at = COALESCE(vouchers.redeemed_at, excluded.redeemed_at),
                     event_id = excluded.event_id,
                     includes_print = excluded.includes_print,
                     created_at = excluded.created_at,
                     source = CASE WHEN vouchers.source = 'local' THEN vouchers.source ELSE 'cloud' END""",
                (
                    code,
                    redeemed_at,
                    str(item.get("eventId") or "").strip() or None,
                    int(bool(item.get("includesPrint", True))),
                    str(item.get("createdAt") or synced_at),
                ),
            )
            imported += 1
        db.execute(
            "INSERT OR REPLACE INTO local_state(key, value_json, updated_at) VALUES ('voucher_snapshot', ?, ?)",
            (json.dumps({"version": version, "imported": imported}), synced_at),
        )
        db.commit()
    return {"version": version, "imported": imported, "events": min(len(events), 500), "syncedAt": synced_at}


def offline_voucher_redemptions(limit: int = 500) -> list[dict[str, str]]:
    safe_limit = max(1, min(500, int(limit)))
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            """SELECT code, redeemed_at FROM vouchers
               WHERE source = 'cloud' AND redeemed_at IS NOT NULL
               ORDER BY redeemed_at ASC LIMIT ?""",
            (safe_limit,),
        ).fetchall()
    return [{"code": row[0], "redeemedAt": row[1]} for row in rows]


def set_local_state(key: str, value: Any) -> None:
    """Persist small controller metadata without expanding settings.json."""
    clean_key = re.sub(r"[^a-z0-9_.-]", "", str(key).lower())[:80]
    if not clean_key:
        raise ValueError("Key local state tidak valid")
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            "INSERT OR REPLACE INTO local_state(key, value_json, updated_at) VALUES (?, ?, ?)",
            (clean_key, json.dumps(value), utc_now()),
        )
        db.commit()


def get_local_state(key: str, fallback: Any = None) -> Any:
    """Read controller metadata while keeping malformed state non-fatal."""
    clean_key = re.sub(r"[^a-z0-9_.-]", "", str(key).lower())[:80]
    if not clean_key:
        return fallback
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute("SELECT value_json FROM local_state WHERE key = ?", (clean_key,)).fetchone()
    if not row:
        return fallback
    try:
        return json.loads(row[0])
    except (ValueError, TypeError):
        return fallback


def _offline_policy_signature(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hmac.new(installation_token().encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


def refresh_offline_policy_lease(payload: dict[str, Any] | None = None, now: float | None = None) -> dict[str, Any]:
    """Refresh the signed local lease after the Agent reaches Photoslive Cloud.

    The endpoint is installation-token protected. The Controller deliberately
    uses its own clock so a malformed cloud timestamp cannot extend the lease.
    """
    current = float(time.time() if now is None else now)
    source = payload if isinstance(payload, dict) else {}
    lease_payload = {
        "version": 1,
        "cloudContactAt": current,
        "expiresAt": current + OFFLINE_CRITICAL_SECONDS,
        "accessEnabled": bool(source.get("accessEnabled", True)),
        "qrisAllowed": bool(source.get("qrisAllowed", True)),
        "serverTime": str(source.get("serverTime") or "")[:80] or None,
    }
    lease = {"payload": lease_payload, "signature": _offline_policy_signature(lease_payload)}
    set_local_state(OFFLINE_POLICY_STATE_KEY, lease)
    return offline_policy_status(current)


def offline_policy_status(now: float | None = None) -> dict[str, Any]:
    """Return effective offline capabilities from a tamper-evident lease."""
    current = float(time.time() if now is None else now)
    lease = get_local_state(OFFLINE_POLICY_STATE_KEY, None)
    if not isinstance(lease, dict) or not isinstance(lease.get("payload"), dict):
        return {
            "state": "uninitialized", "signed": False, "online": False,
            "ageSeconds": None, "expiresAt": None, "allowNewSession": True,
            "allowActiveSessionFinish": True, "qrisAllowed": False, "voucherAllowed": True,
            "message": "Belum ada lease cloud. Mode gratis atau voucher lokal tetap tersedia; QRIS dinonaktifkan.",
        }
    payload = lease["payload"]
    expected = _offline_policy_signature(payload)
    if not hmac.compare_digest(str(lease.get("signature") or ""), expected):
        return {
            "state": "invalid", "signed": False, "online": False,
            "ageSeconds": None, "expiresAt": None, "allowNewSession": False,
            "allowActiveSessionFinish": True, "qrisAllowed": False, "voucherAllowed": False,
            "message": "Lease offline tidak valid. Hubungkan Agent ke cloud untuk memperbaruinya.",
        }
    try:
        contacted_at = float(payload["cloudContactAt"])
    except (KeyError, TypeError, ValueError):
        contacted_at = 0.0
    age = max(0.0, current - contacted_at) if contacted_at else OFFLINE_CRITICAL_SECONDS + 1
    online = age <= OFFLINE_ONLINE_SECONDS
    access_enabled = bool(payload.get("accessEnabled", True))
    if not access_enabled:
        state = "disabled"
        allow_new = False
        message = "Akses photobox dinonaktifkan. Sesi aktif tetap dapat diselesaikan."
    elif age <= OFFLINE_ONLINE_SECONDS:
        state, allow_new, message = "online", True, "Cloud tersambung."
    elif age <= OFFLINE_NORMAL_SECONDS:
        state, allow_new, message = "normal", True, "Mode offline normal. QRIS dimatikan; voucher lokal tetap tersedia."
    elif age <= OFFLINE_WARNING_SECONDS:
        state, allow_new, message = "warning", True, "Offline lebih dari 24 jam. Hubungkan internet sebelum masa aman berakhir."
    elif age <= OFFLINE_CRITICAL_SECONDS:
        state, allow_new, message = "critical", True, "Offline lebih dari 48 jam. Sesi baru akan diblokir setelah 72 jam."
    else:
        state, allow_new, message = "blocked", False, "Offline lebih dari 72 jam. Hubungkan Agent ke cloud untuk memulai sesi baru."
    return {
        "state": state, "signed": True, "online": online, "ageSeconds": int(age),
        "lastCloudContactAt": datetime.fromtimestamp(contacted_at, timezone.utc).isoformat() if contacted_at else None,
        "expiresAt": datetime.fromtimestamp(float(payload.get("expiresAt") or contacted_at + OFFLINE_CRITICAL_SECONDS), timezone.utc).isoformat() if contacted_at else None,
        "allowNewSession": allow_new, "allowActiveSessionFinish": True,
        "qrisAllowed": bool(online and allow_new and payload.get("qrisAllowed", True)),
        "voucherAllowed": bool(allow_new), "message": message,
    }


def printable_vouchers(event_id: str | None) -> bytes:
    with sqlite3.connect(DB_PATH) as db:
        if event_id:
            event = db.execute("SELECT name, expires_at, includes_print FROM voucher_events WHERE id = ?", (event_id,)).fetchone()
            if not event:
                raise ValueError("Event tidak ditemukan")
            title = event[0]
            detail = f"Berlaku sampai {event[1]} · {'Termasuk cetak' if event[2] else 'Tanpa cetak'}"
            rows = [] if voucher_event_expired(event[1]) else db.execute("SELECT code FROM vouchers WHERE event_id = ? AND redeemed_at IS NULL ORDER BY rowid", (event_id,)).fetchall()
        else:
            title = "Voucher umum Photoslive"
            detail = "Satu kali pakai · 1 sesi · termasuk cetak"
            rows = db.execute("SELECT code FROM vouchers WHERE event_id IS NULL AND redeemed_at IS NULL ORDER BY rowid",).fetchall()
    cards = "".join(f"<li><b>{escape(row[0])}</b><small>{escape(title)}</small></li>" for row in rows)
    return f"""<!doctype html><html lang='id'><meta charset='utf-8'><meta name='viewport' content='width=device-width'><title>{escape(title)}</title><style>*{{box-sizing:border-box}}body{{margin:0;padding:28px;font:14px system-ui;color:#171a21}}header{{display:flex;justify-content:space-between;align-items:start;margin-bottom:24px}}h1{{margin:0 0 6px;font-size:24px}}p{{margin:0;color:#667085}}button{{padding:10px 16px;border:0;border-radius:7px;background:#171a21;color:white;font-weight:700}}ul{{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;list-style:none;padding:0}}li{{min-height:90px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px;border:1px dashed #8d929f;border-radius:8px;text-align:center;break-inside:avoid}}li b{{font:800 16px ui-monospace,monospace;letter-spacing:.04em}}li small{{color:#667085}}.empty{{padding:30px;border:1px solid #ddd}}@media print{{body{{padding:0}}button{{display:none}}ul{{grid-template-columns:repeat(3,1fr)}}}}</style><header><div><h1>{escape(title)}</h1><p>{escape(detail)} · {len(rows)} kode aktif</p></div><button onclick='window.print()'>Cetak</button></header>{f'<ul>{cards}</ul>' if rows else '<p class="empty">Tidak ada voucher aktif untuk dicetak.</p>'}</html>""".encode("utf-8")


def delete_voucher(code: str) -> bool:
    with sqlite3.connect(DB_PATH) as db:
        result = db.execute("DELETE FROM vouchers WHERE code = ? AND redeemed_at IS NULL", (code,))
        db.commit()
    if result.rowcount:
        add_event("voucher", f"Voucher {code} dihapus")
    return bool(result.rowcount)


def queue_status() -> dict[str, int]:
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute("SELECT kind, status, COUNT(*) FROM jobs GROUP BY kind, status").fetchall()
    values = {"pendingUploads": 0, "failedUploads": 0, "pendingPrints": 0, "pendingMedia": 0}
    for kind, status, count in rows:
        if kind == "upload" and status in {"pending", "processing"}:
            values["pendingUploads"] += count
        if kind == "upload" and status == "failed":
            values["failedUploads"] += count
        if kind == "print" and status in {"pending", "processing", "running"}:
            values["pendingPrints"] += count
        if kind == "gif" and status in {"pending", "processing", "running"}:
            values["pendingMedia"] += count
    return values


def clear_failed_jobs() -> int:
    with sqlite3.connect(DB_PATH) as db:
        result = db.execute("DELETE FROM jobs WHERE status = 'failed'")
        db.commit()
    add_event("queue", f"{result.rowcount} antrean gagal dibersihkan")
    return result.rowcount


def cleanup_uploaded_photos(dry_run: bool = False, now: float | None = None) -> dict[str, Any]:
    settings = load_settings()
    root = photo_root(settings).resolve()
    retention = int(settings["booth"]["localRetentionHours"])
    cutoff = (time.time() if now is None else now) - (retention * 3600)
    deleted = 0
    reclaimed = 0
    candidates = 0
    candidate_bytes = 0
    protected_unsynced = 0
    missing_records = 0
    errors: list[str] = []
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute("SELECT id, path, uploaded_at FROM photo_files").fetchall()
        for photo_id, relative_path, uploaded_at in rows:
            path = (root / str(relative_path)).resolve()
            if root not in path.parents:
                errors.append(f"Path di luar folder foto diabaikan: {relative_path}")
                continue
            if not path.exists():
                missing_records += 1
                if not dry_run and uploaded_at:
                    db.execute("DELETE FROM photo_files WHERE id = ?", (photo_id,))
                continue
            try:
                stat = path.stat()
            except OSError as error:
                errors.append(f"{path.name}: {error}")
                continue
            if stat.st_mtime > cutoff:
                continue
            # Unsynced captures are never deleted, even if an older setting
            # allowed age-only cleanup. This is a hard storage-safety rule.
            if not uploaded_at:
                protected_unsynced += 1
                continue
            candidates += 1
            candidate_bytes += stat.st_size
            if dry_run:
                continue
            try:
                path.unlink()
                db.execute("DELETE FROM photo_files WHERE id = ?", (photo_id,))
                deleted += 1
                reclaimed += stat.st_size
            except OSError as error:
                errors.append(f"{path.name}: {error}")
        if not dry_run:
            db.commit()
    with STORAGE_CACHE_LOCK:
        STORAGE_CACHE["createdAt"] = 0.0
        STORAGE_CACHE["payload"] = None
    return {
        "candidateFiles": candidates,
        "candidateBytes": candidate_bytes,
        "deletedFiles": deleted,
        "reclaimedBytes": reclaimed,
        "protectedUnsyncedFiles": protected_unsynced,
        "missingRecords": missing_records,
        "retentionHours": retention,
        "dryRun": dry_run,
        "errors": errors[:10],
    }


def delete_photo_session_by_share_token(share_token: str) -> dict[str, Any]:
    """Delete a customer's local session and every derived file idempotently."""
    clean_token = str(share_token or "").strip()
    if len(clean_token) < 32 or len(clean_token) > 100 or not all(character.isalnum() or character in "_-" for character in clean_token):
        raise ValueError("Kode sesi penghapusan tidak valid")
    root = photo_root().resolve()
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute("SELECT id FROM photo_sessions WHERE share_token = ?", (clean_token,)).fetchone()
        if not row:
            return {"deleted": True, "alreadyDeleted": True, "filesDeleted": 0}
        session_id = str(row[0])
        files = db.execute("SELECT id, path FROM photo_files WHERE session_id = ?", (session_id,)).fetchall()
        deleted_files = 0
        for _, relative_path in files:
            path = (root / str(relative_path)).resolve()
            if root not in path.parents:
                raise ValueError("Path sesi berada di luar folder foto")
            if path.exists():
                path.unlink()
                deleted_files += 1
        session_folder = (root / session_id).resolve()
        if session_folder.parent == root and session_folder.exists():
            shutil.rmtree(session_folder)
        queue_rows = db.execute("SELECT id, payload_json FROM sync_queue").fetchall()
        queue_ids = []
        for queue_id, raw_payload in queue_rows:
            try:
                queued_session = json.loads(raw_payload or "{}").get("session", {})
            except (TypeError, ValueError):
                queued_session = {}
            if str(queued_session.get("id") or "") == session_id or str(queued_session.get("shareCode") or "") == clean_token:
                queue_ids.append(str(queue_id))
        for queue_id in queue_ids:
            db.execute("DELETE FROM sync_queue WHERE id = ?", (queue_id,))
        db.execute("DELETE FROM jobs WHERE reference_id = ?", (session_id,))
        db.execute("DELETE FROM photo_files WHERE session_id = ?", (session_id,))
        db.execute("DELETE FROM photo_sessions WHERE id = ?", (session_id,))
        db.commit()
    with STORAGE_CACHE_LOCK:
        STORAGE_CACHE["createdAt"] = 0.0
        STORAGE_CACHE["payload"] = None
    add_event("privacy", f"Sesi pelanggan dihapus permanen ({session_id[:12]})")
    return {"deleted": True, "alreadyDeleted": False, "filesDeleted": deleted_files}


def storage_cleanup(dry_run: bool = True) -> dict[str, Any]:
    photos = cleanup_uploaded_photos(dry_run=dry_run)
    cache = maintain_local_cache(dry_run=dry_run)
    result = {
        "dryRun": dry_run,
        "photos": photos,
        "cache": cache,
        "candidateFiles": photos["candidateFiles"] + cache["candidateFiles"],
        "candidateBytes": photos["candidateBytes"] + cache["candidateBytes"],
        "deletedFiles": photos["deletedFiles"] + cache["deletedFiles"],
        "reclaimedBytes": photos["reclaimedBytes"] + cache["reclaimedBytes"],
        "protectedUnsyncedFiles": photos["protectedUnsyncedFiles"],
        "errors": [*photos["errors"], *(error for group in cache["groups"].values() for error in group["errors"])][:10],
    }
    if not dry_run:
        add_event(
            "storage",
            f"Perawatan storage selesai: {result['deletedFiles']} file, {result['reclaimedBytes']} byte",
        )
    return result


def register_session_file(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    root = photo_root()
    relative_path = str(payload.get("path") or "").strip().lstrip("/")
    if not relative_path:
        raise ValueError("Path file wajib diisi")
    target = (root / relative_path).resolve()
    if root not in target.parents or not target.is_file():
        raise ValueError("File foto tidak ditemukan di penyimpanan lokal")
    digest = hashlib.sha256()
    with target.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    checksum = digest.hexdigest()
    with sqlite3.connect(DB_PATH) as db:
        session = db.execute(
            "SELECT status, photo_slots, retake_limit, deadline_at FROM photo_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not session:
            raise ValueError("Sesi foto tidak ditemukan")
        if session[0] != "active":
            raise ValueError("Sesi foto sudah tidak aktif")
        if session[3] and datetime.now(timezone.utc) > datetime.fromisoformat(session[3]):
            db.execute("UPDATE photo_sessions SET status = 'expired' WHERE id = ?", (session_id,))
            db.commit()
            raise ValueError("Batas waktu sesi sudah habis")
        slot_index = int(payload.get("slotIndex") or 0)
        attempt_number = int(payload.get("attemptNumber") or 0)
        if slot_index < 1 or slot_index > int(session[1]):
            raise ValueError(f"slotIndex harus antara 1 dan {session[1]}")
        max_attempts = int(session[2]) + 1
        if attempt_number < 1 or attempt_number > max_attempts:
            raise ValueError(f"attemptNumber maksimal {max_attempts} untuk setiap slot")
        file_id = str(payload.get("id") or uuid.uuid4())
        created_at = str(payload.get("createdAt") or utc_now())
        selected = bool(payload.get("selected", False))
        if selected:
            db.execute("UPDATE photo_files SET is_selected = 0 WHERE session_id = ? AND slot_index = ?", (session_id, slot_index))
        db.execute(
            """INSERT OR REPLACE INTO photo_files(
                 id, path, session_id, slot_index, attempt_number, is_selected, file_kind,
                 checksum_sha256, uploaded_at, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (file_id, relative_path, session_id, slot_index, attempt_number, int(selected), "capture", checksum, payload.get("uploadedAt"), created_at),
        )
        db.commit()
    with STORAGE_CACHE_LOCK:
        STORAGE_CACHE["createdAt"] = 0.0
        STORAGE_CACHE["payload"] = None
    return {
        "id": file_id, "path": relative_path, "sessionId": session_id, "slotIndex": slot_index,
        "attemptNumber": attempt_number, "selected": selected, "createdAt": created_at, "checksumSha256": checksum,
    }


def select_session_file(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    file_id = str(payload.get("fileId") or "").strip()
    if not file_id:
        raise ValueError("fileId wajib diisi")
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute(
            """SELECT f.slot_index, s.status, s.deadline_at
               FROM photo_files f JOIN photo_sessions s ON s.id = f.session_id
               WHERE f.id = ? AND f.session_id = ? AND f.file_kind = 'capture'""",
            (file_id, session_id),
        ).fetchone()
        if not row:
            raise ValueError("Foto tidak ditemukan pada sesi ini")
        if row[1] != "active":
            raise ValueError("Sesi foto sudah tidak aktif")
        if row[2] and datetime.now(timezone.utc) > datetime.fromisoformat(row[2]):
            db.execute("UPDATE photo_sessions SET status = 'expired' WHERE id = ?", (session_id,))
            db.commit()
            raise ValueError("Batas waktu sesi sudah habis")
        db.execute("UPDATE photo_files SET is_selected = 0 WHERE session_id = ? AND slot_index = ?", (session_id, row[0]))
        db.execute("UPDATE photo_files SET is_selected = 1 WHERE id = ?", (file_id,))
        db.commit()
    return {"sessionId": session_id, "slotIndex": row[0], "selectedFileId": file_id}


def complete_photo_session(session_id: str) -> dict[str, Any]:
    with sqlite3.connect(DB_PATH) as db:
        session = db.execute(
            """SELECT status, share_token, frame_id, photo_slots, deadline_at, strips_per_sheet,
                      print_layout, created_at, expires_at, frame_config_json
               FROM photo_sessions WHERE id = ?""",
            (session_id,),
        ).fetchone()
        if not session:
            raise ValueError("Sesi foto tidak ditemukan")
        if session[0] not in {"active", "completed"}:
            raise ValueError("Sesi foto sudah tidak aktif")
        if session[0] == "active" and session[4] and datetime.now(timezone.utc) > datetime.fromisoformat(session[4]):
            db.execute("UPDATE photo_sessions SET status = 'expired' WHERE id = ?", (session_id,))
            db.commit()
            raise ValueError("Batas waktu sesi sudah habis")
        rows = db.execute(
            """SELECT id, path, slot_index, checksum_sha256 FROM photo_files
               WHERE session_id = ? AND is_selected = 1 AND file_kind = 'capture'
               ORDER BY slot_index""",
            (session_id,),
        ).fetchall()
        selected_slots = {row[2] for row in rows}
        missing = [index for index in range(1, int(session[3]) + 1) if index not in selected_slots]
        if missing:
            raise ValueError(f"Pilih satu foto final untuk slot: {', '.join(map(str, missing))}")
        existing_outputs = db.execute(
            """SELECT id, path, file_kind, checksum_sha256, is_selected FROM photo_files
               WHERE session_id = ? AND file_kind IN ('composite', 'print-sheet')""",
            (session_id,),
        ).fetchall()

    frame_config = json.loads(session[9] or "{}")
    if not frame_config:
        frame_config = frame_config_snapshot(load_settings(), str(session[2] or "clean-white"))
    root = photo_root()
    reusable = [item for item in existing_outputs if (root / item[1]).is_file()]
    if {item[2] for item in reusable} != {"composite", "print-sheet"}:
        rendered = render_session_outputs(session_id, frame_config, rows)
    else:
        rendered = [
            {
                "id": item[0], "path": item[1], "kind": item[2], "selected": bool(item[4]),
                "contentType": "image/jpeg", "checksumSha256": item[3],
            }
            for item in reusable
        ]

    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        for output in rendered:
            target = (root / output["path"]).resolve()
            checksum = output.get("checksumSha256") or file_checksum(target)
            output["checksumSha256"] = checksum
            db.execute(
                """INSERT OR REPLACE INTO photo_files(
                     id, path, session_id, slot_index, attempt_number, is_selected, file_kind,
                     checksum_sha256, uploaded_at, created_at
                   ) VALUES (?, ?, ?, 0, 0, ?, ?, ?, NULL, ?)""",
                (output["id"], output["path"], session_id, int(bool(output["selected"])), output["kind"], checksum, timestamp),
            )
        db.execute("UPDATE photo_sessions SET status = 'completed' WHERE id = ?", (session_id,))
        sync_files = [
            {
                "id": row[0], "path": row[1], "slotIndex": int(row[2]), "fileKind": "capture",
                "contentType": "image/jpeg", "checksumSha256": row[3],
            }
            for row in rows
        ]
        sync_files.extend(
            {
                "id": output["id"], "path": output["path"], "slotIndex": 0,
                "fileKind": output["kind"], "contentType": output["contentType"],
                "checksumSha256": output["checksumSha256"],
            }
            for output in rendered if output["kind"] == "composite"
        )
        sync_job_id = enqueue_session_sync(
            db,
            {
                "id": session_id,
                "shareCode": session[1],
                "frameId": session[2],
                "photoSlots": int(session[3]),
                "createdAt": session[7],
                "expiresAt": session[8],
            },
            sync_files,
        )
        gif_job_id = f"GIF-{session_id}"
        db.execute(
            """INSERT OR IGNORE INTO jobs(
                 id, kind, status, message, reference_id, created_at, updated_at
               ) VALUES (?, 'gif', 'pending', 'Menunggu pembuatan GIF', ?, ?, ?)""",
            (gif_job_id, session_id, timestamp, timestamp),
        )
        db.execute(
            """UPDATE jobs SET status = 'pending', message = 'Menunggu pembuatan GIF',
                      last_error = NULL, updated_at = ?
               WHERE id = ? AND status = 'failed'""",
            (timestamp, gif_job_id),
        )
        db.commit()
    composite = next(output for output in rendered if output["kind"] == "composite")
    print_sheet = next(output for output in rendered if output["kind"] == "print-sheet")
    add_event("session", f"Hasil frame sesi {session_id} selesai dibuat")
    return {
        "id": session_id, "status": "completed", "photoSlots": int(session[3]),
        "printOutput": {"stripsPerSheet": int(session[5]), "layout": session[6]},
        "compositeInput": [{"fileId": row[0], "path": row[1], "slotIndex": row[2]} for row in rows],
        "outputs": {
            "composite": {"fileId": composite["id"], "url": f"/api/session-files/{composite['id']}"},
            "printSheet": {"fileId": print_sheet["id"]},
            "gif": {"jobId": gif_job_id, "status": "pending"},
        },
        "sync": {"jobId": sync_job_id, "status": "pending"},
        "nextAction": "show-result",
    }


def booth_config() -> dict[str, Any]:
    settings = load_settings()
    policy = offline_policy_status()
    return {
        "booth": {
            "name": settings["booth"]["name"],
            "sessionTimeoutSeconds": int(settings["booth"]["sessionTimeoutSeconds"]),
            "countdownSeconds": int(settings["booth"]["countdownSeconds"]),
            "retakeLimit": int(settings["booth"]["retakeLimit"]),
            "unlimitedRetakes": bool(settings["booth"].get("unlimitedRetakes", True)),
            "photoSlotsPerSession": int(settings["booth"]["photoSlotsPerSession"]),
            "printsPerSession": int(settings["booth"]["printsPerSession"]),
            "maintenanceMode": bool(settings["booth"]["maintenanceMode"]),
        },
        "appearance": settings["appearance"],
        "payment": {
            "qrisEnabled": bool(settings["payment"]["qrisEnabled"] and policy["qrisAllowed"]),
            "configuredQrisEnabled": bool(settings["payment"]["qrisEnabled"]),
            "voucherEnabled": bool(settings["payment"]["voucherEnabled"]),
            "paidPrintEnabled": bool(settings["payment"].get("paidPrintEnabled", False) and policy["qrisAllowed"]),
            "printPrice": int(settings["payment"].get("printPrice", 10000)),
            "price": int(settings["payment"]["price"]),
            "currency": settings["payment"]["currency"],
            "provider": settings["payment"]["provider"],
        },
        "devices": {
            "cameraSource": str(settings["devices"].get("cameraSource", "auto")),
            "browserCameraId": str(settings["devices"].get("browserCameraId", "")),
            "cameraMirror": bool(settings["devices"]["cameraMirror"]),
            "cameraRotation": str(settings["devices"]["cameraRotation"]),
            "paperSize": settings["devices"]["paperSize"],
            "stripsPerSheet": int(settings["devices"]["stripsPerSheet"]),
        },
        "assets": list_assets(),
        "capabilities": {"renderer": renderer_capability()},
        "offlinePolicy": policy,
    }


def register_booth_client(client_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "", client_id)[:64] or uuid.uuid4().hex[:16]
    screen = payload.get("screen") if isinstance(payload.get("screen"), dict) else {}
    cameras = payload.get("cameras") if isinstance(payload.get("cameras"), list) else []
    client = {
        "id": safe_id,
        "platform": str(payload.get("platform") or "Unknown")[:80],
        "userAgent": str(payload.get("userAgent") or "")[:240],
        "screen": {
            "width": int(screen.get("width") or 0), "height": int(screen.get("height") or 0),
            "pixelRatio": float(screen.get("pixelRatio") or 1),
        },
        "touch": bool(payload.get("touch")), "standalone": bool(payload.get("standalone")),
        "cameras": [str(camera)[:120] for camera in cameras[:12]], "lastSeenAt": utc_now(),
    }
    with BOOTH_CLIENTS_LOCK:
        BOOTH_CLIENTS[safe_id] = client
        if len(BOOTH_CLIENTS) > 50:
            oldest = sorted(BOOTH_CLIENTS.values(), key=lambda item: item["lastSeenAt"])[:-50]
            for item in oldest:
                BOOTH_CLIENTS.pop(item["id"], None)
    return client


def list_booth_clients() -> list[dict[str, Any]]:
    with BOOTH_CLIENTS_LOCK:
        return sorted(BOOTH_CLIENTS.values(), key=lambda item: item["lastSeenAt"], reverse=True)


def capture_session_upload(session_id: str, slot_index: int, data: bytes) -> dict[str, Any]:
    root = photo_root()
    if not data or len(data) > 20_000_000:
        raise ValueError("File foto harus berupa JPEG maksimal 20 MB")
    if not data.startswith(b"\xff\xd8"):
        raise ValueError("File capture bukan JPEG yang valid")
    with sqlite3.connect(DB_PATH) as db:
        session = db.execute(
            "SELECT status, photo_slots, retake_limit, deadline_at FROM photo_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not session:
            raise ValueError("Sesi foto tidak ditemukan")
        if session[0] != "active":
            raise ValueError("Sesi foto sudah tidak aktif")
        if session[3] and datetime.now(timezone.utc) > datetime.fromisoformat(session[3]):
            db.execute("UPDATE photo_sessions SET status = 'expired' WHERE id = ?", (session_id,))
            db.commit()
            raise ValueError("Batas waktu sesi sudah habis")
        if slot_index < 1 or slot_index > int(session[1]):
            raise ValueError(f"Slot foto harus antara 1 dan {session[1]}")
        attempt_number = int(db.execute(
            "SELECT COUNT(*) FROM photo_files WHERE session_id = ? AND slot_index = ? AND file_kind = 'capture'",
            (session_id, slot_index),
        ).fetchone()[0]) + 1
        if attempt_number > int(session[2]) + 1:
            raise ValueError("Batas retake untuk foto ini sudah tercapai")
    session_folder = root / session_id
    session_folder.mkdir(parents=True, exist_ok=True)
    filename = f"slot-{slot_index}-attempt-{attempt_number}-{uuid.uuid4().hex[:6]}.jpg"
    target = session_folder / filename
    temporary = target.with_suffix(".jpg.part")
    try:
        with temporary.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        raise OSError("Foto tidak dapat disimpan. Periksa ruang disk dan folder penyimpanan.") from exc
    try:
        file_data = register_session_file(session_id, {
            "path": str(target.relative_to(root)), "slotIndex": slot_index, "attemptNumber": attempt_number,
        })
    except Exception:
        # A file without its SQLite record cannot be recovered or protected by
        # the upload-aware cleanup policy. Remove it before returning failure.
        target.unlink(missing_ok=True)
        raise
    with sqlite3.connect(DB_PATH) as db:
        db.execute("UPDATE daily_usage SET photos = photos + 1 WHERE day = ?", (datetime.now().date().isoformat(),))
        db.commit()
    add_event("session", f"Foto browser slot {slot_index} attempt {attempt_number} diambil untuk {session_id}")
    return {**file_data, "url": f"/api/session-files/{file_data['id']}"}


def capture_session_photo(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    root = photo_root()
    slot_index = int(payload.get("slotIndex") or 0)
    with sqlite3.connect(DB_PATH) as db:
        session = db.execute(
            "SELECT status, photo_slots, retake_limit, deadline_at FROM photo_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not session:
            raise ValueError("Sesi foto tidak ditemukan")
        if session[0] != "active":
            raise ValueError("Sesi foto sudah tidak aktif")
        if session[3] and datetime.now(timezone.utc) > datetime.fromisoformat(session[3]):
            db.execute("UPDATE photo_sessions SET status = 'expired' WHERE id = ?", (session_id,))
            db.commit()
            raise ValueError("Batas waktu sesi sudah habis")
        if slot_index < 1 or slot_index > int(session[1]):
            raise ValueError(f"Slot foto harus antara 1 dan {session[1]}")
        attempt_number = int(db.execute(
            "SELECT COUNT(*) FROM photo_files WHERE session_id = ? AND slot_index = ? AND file_kind = 'capture'",
            (session_id, slot_index),
        ).fetchone()[0]) + 1
        if attempt_number > int(session[2]) + 1:
            raise ValueError("Batas retake untuk foto ini sudah tercapai")

    ok, data, error = camera_image(capture=True)
    if not ok:
        raise ValueError(error)
    session_folder = root / session_id
    session_folder.mkdir(parents=True, exist_ok=True)
    filename = f"slot-{slot_index}-attempt-{attempt_number}-{uuid.uuid4().hex[:6]}.jpg"
    target = session_folder / filename
    target.write_bytes(data)
    file_data = register_session_file(session_id, {
        "path": str(target.relative_to(root)),
        "slotIndex": slot_index,
        "attemptNumber": attempt_number,
    })
    with sqlite3.connect(DB_PATH) as db:
        db.execute("UPDATE daily_usage SET photos = photos + 1 WHERE day = ?", (datetime.now().date().isoformat(),))
        db.commit()
    add_event("session", f"Foto slot {slot_index} attempt {attempt_number} diambil untuk {session_id}")
    return {**file_data, "url": f"/api/session-files/{file_data['id']}"}


def content_type_for_path(path: Path) -> str:
    return {
        ".gif": "image/gif",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "image/jpeg")


def session_file(file_id: str) -> tuple[bytes, str] | None:
    root = photo_root()
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute("SELECT path FROM photo_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        return None
    path = (root / row[0]).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path.read_bytes(), content_type_for_path(path)


def queue_session_print(session_id: str, voucher_code: str = "") -> dict[str, Any]:
    settings = load_settings()
    if settings["payment"].get("paidPrintEnabled", False):
        normalized_voucher = voucher_code.strip().upper()
        with sqlite3.connect(DB_PATH) as db:
            voucher = db.execute(
                "SELECT includes_print, redeemed_at FROM vouchers WHERE code = ?",
                (normalized_voucher,),
            ).fetchone() if normalized_voucher else None
        if not voucher or not voucher[0] or not voucher[1]:
            raise ValueError("Pembayaran QRIS harus terverifikasi sebelum mencetak")
    with sqlite3.connect(DB_PATH) as db:
        session = db.execute("SELECT status FROM photo_sessions WHERE id = ?", (session_id,)).fetchone()
        if not session:
            raise ValueError("Sesi foto tidak ditemukan")
        if session[0] != "completed":
            raise ValueError("Selesaikan semua foto sebelum mencetak")
        output = db.execute(
            "SELECT id FROM photo_files WHERE session_id = ? AND file_kind = 'print-sheet'",
            (session_id,),
        ).fetchone()
        if not output:
            raise ValueError("File siap cetak belum tersedia. Selesaikan render hasil terlebih dahulu.")
        existing = db.execute(
            "SELECT id, status FROM jobs WHERE kind = 'print' AND reference_id = ? ORDER BY created_at DESC LIMIT 1",
            (session_id,),
        ).fetchone()
        if existing:
            if existing[1] == "failed":
                db.execute(
                    "UPDATE jobs SET status = 'pending', last_error = NULL, updated_at = ? WHERE id = ?",
                    (utc_now(), existing[0]),
                )
                db.commit()
                add_event("print", f"Antrean cetak sesi {session_id} dicoba ulang")
                return {"id": existing[0], "status": "pending", "sessionId": session_id}
            return {"id": existing[0], "status": existing[1], "sessionId": session_id}
        job_id = f"PRINT-{uuid.uuid4().hex[:10].upper()}"
        now = utc_now()
        db.execute(
            """INSERT INTO jobs(id, kind, status, message, reference_id, created_at, updated_at)
               VALUES (?, 'print', 'pending', 'Menunggu printer', ?, ?, ?)""",
            (job_id, session_id, now, now),
        )
        db.commit()
    add_event("print", f"Sesi {session_id} masuk antrean cetak")
    return {"id": job_id, "status": "pending", "sessionId": session_id}


def process_next_print_job() -> dict[str, Any] | None:
    """Claim and execute one CUPS/IPP print job outside the booth request."""
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        stale_before = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        db.execute(
            """UPDATE jobs SET status = 'pending', updated_at = ?
               WHERE kind = 'print' AND status = 'running' AND updated_at < ?""",
            (timestamp, stale_before),
        )
        row = db.execute(
            """SELECT id, reference_id, attempts FROM jobs
               WHERE kind = 'print' AND status = 'pending' ORDER BY created_at LIMIT 1"""
        ).fetchone()
        if not row:
            db.commit()
            return None
        updated = db.execute(
            """UPDATE jobs SET status = 'running', attempts = attempts + 1,
                      message = 'Mengirim ke printer', last_error = NULL, updated_at = ?
               WHERE id = ? AND status = 'pending'""",
            (timestamp, row[0]),
        )
        db.commit()
    if updated.rowcount != 1:
        return None

    job_id, session_id, attempts = row[0], str(row[1] or ""), int(row[2]) + 1
    try:
        with sqlite3.connect(DB_PATH) as db:
            file_row = db.execute(
                "SELECT path FROM photo_files WHERE session_id = ? AND file_kind = 'print-sheet'",
                (session_id,),
            ).fetchone()
        if not file_row:
            raise ValueError("File siap cetak tidak ditemukan")
        root = photo_root()
        print_path = (root / file_row[0]).resolve()
        if root not in print_path.parents or not print_path.is_file():
            raise ValueError("File siap cetak hilang dari penyimpanan lokal")
        printers = [device for device in detect_devices() if device.kind == "printer" and device.status == "connected"]
        if not printers:
            raise ValueError("Printer belum tersambung")
        settings = load_settings()
        preferred = str(settings["devices"].get("preferredPrinter") or "auto")
        printer = next((device for device in printers if device.id == preferred), printers[0])
        printer_name = printer.id.removeprefix("cups-")
        ok, output = command_output(["lp", "-d", printer_name, str(print_path)], timeout=12)
        if not ok:
            raise ValueError(output or "Printer menolak file")
        finished = utc_now()
        with sqlite3.connect(DB_PATH) as db:
            db.execute(
                """UPDATE jobs SET status = 'completed', message = ?, last_error = NULL, updated_at = ?
                   WHERE id = ?""",
                ((output or "Terkirim ke printer")[:300], finished, job_id),
            )
            db.execute(
                "UPDATE daily_usage SET prints = prints + 1 WHERE day = ?",
                (datetime.now().date().isoformat(),),
            )
            db.commit()
        add_event("print", f"Sesi {session_id} dikirim ke {printer.name}")
        return {"id": job_id, "sessionId": session_id, "status": "completed", "attempts": attempts}
    except (ValueError, OSError) as error:
        increment_operation_failure("printer")
        failed = utc_now()
        with sqlite3.connect(DB_PATH) as db:
            db.execute(
                """UPDATE jobs SET status = 'failed', message = 'Perlu diperiksa',
                          last_error = ?, updated_at = ? WHERE id = ?""",
                (str(error)[:500], failed, job_id),
            )
            db.commit()
        add_event("print", f"Cetak sesi {session_id} gagal: {error}")
        return {"id": job_id, "sessionId": session_id, "status": "failed", "attempts": attempts, "error": str(error)}


def process_next_gif_job() -> dict[str, Any] | None:
    """Render one pending flipbook and enqueue its cloud upload."""
    timestamp = utc_now()
    with sqlite3.connect(DB_PATH) as db:
        db.execute("BEGIN IMMEDIATE")
        stale_before = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        db.execute(
            """UPDATE jobs SET status = 'pending', updated_at = ?
               WHERE kind = 'gif' AND status = 'running' AND updated_at < ?""",
            (timestamp, stale_before),
        )
        row = db.execute(
            """SELECT id, reference_id, attempts FROM jobs
               WHERE kind = 'gif' AND status = 'pending' ORDER BY created_at LIMIT 1"""
        ).fetchone()
        if not row:
            db.commit()
            return None
        updated = db.execute(
            """UPDATE jobs SET status = 'running', attempts = attempts + 1,
                      message = 'Membuat GIF', last_error = NULL, updated_at = ?
               WHERE id = ? AND status = 'pending'""",
            (timestamp, row[0]),
        )
        db.commit()
    if updated.rowcount != 1:
        return None

    job_id, session_id, attempts = row[0], str(row[1] or ""), int(row[2]) + 1
    try:
        with sqlite3.connect(DB_PATH) as db:
            session = db.execute(
                """SELECT share_token, frame_id, photo_slots, created_at, expires_at
                   FROM photo_sessions WHERE id = ? AND status = 'completed'""",
                (session_id,),
            ).fetchone()
            captures = db.execute(
                """SELECT id, path, slot_index, checksum_sha256 FROM photo_files
                   WHERE session_id = ? AND is_selected = 1 AND file_kind = 'capture'
                   ORDER BY slot_index""",
                (session_id,),
            ).fetchall()
        if not session:
            raise ValueError("Sesi selesai tidak ditemukan")
        output = render_session_gif(session_id, captures)
        finished = utc_now()
        with sqlite3.connect(DB_PATH) as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                """INSERT OR REPLACE INTO photo_files(
                     id, path, session_id, slot_index, attempt_number, is_selected, file_kind,
                     checksum_sha256, uploaded_at, created_at
                   ) VALUES (?, ?, ?, 0, 0, 0, 'gif', ?, NULL, ?)""",
                (output["id"], output["path"], session_id, output["checksumSha256"], finished),
            )
            enqueue_session_sync(
                db,
                {
                    "id": session_id,
                    "shareCode": session[0],
                    "frameId": session[1],
                    "photoSlots": int(session[2]),
                    "createdAt": session[3],
                    "expiresAt": session[4],
                },
                [{
                    "id": output["id"],
                    "path": output["path"],
                    "slotIndex": 0,
                    "fileKind": "gif",
                    "contentType": "image/gif",
                    "checksumSha256": output["checksumSha256"],
                }],
                job_id=f"session.sync:{session_id}:gif",
            )
            db.execute(
                """UPDATE jobs SET status = 'completed', message = 'GIF siap',
                          last_error = NULL, updated_at = ? WHERE id = ?""",
                (finished, job_id),
            )
            db.commit()
        add_event("session", f"GIF sesi {session_id} selesai dibuat")
        return {"id": job_id, "sessionId": session_id, "status": "completed", "attempts": attempts, "fileId": output["id"]}
    except (ValueError, OSError) as error:
        increment_operation_failure("render")
        failed = utc_now()
        with sqlite3.connect(DB_PATH) as db:
            db.execute(
                """UPDATE jobs SET status = 'failed', message = 'GIF gagal',
                          last_error = ?, updated_at = ? WHERE id = ?""",
                (str(error)[:500], failed, job_id),
            )
            db.commit()
        add_event("session", f"GIF sesi {session_id} gagal: {error}")
        return {"id": job_id, "sessionId": session_id, "status": "failed", "attempts": attempts, "error": str(error)}


def print_worker_loop() -> None:
    while not PRINT_WORKER_STOP.is_set():
        processed = process_next_print_job() or process_next_gif_job()
        PRINT_WORKER_STOP.wait(0.25 if processed else 1.0)


def ensure_print_worker() -> threading.Thread:
    global PRINT_WORKER_THREAD
    with PRINT_WORKER_LOCK:
        if PRINT_WORKER_THREAD and PRINT_WORKER_THREAD.is_alive():
            return PRINT_WORKER_THREAD
        PRINT_WORKER_STOP.clear()
        PRINT_WORKER_THREAD = threading.Thread(target=print_worker_loop, name="photoslive-print-worker", daemon=True)
        PRINT_WORKER_THREAD.start()
        return PRINT_WORKER_THREAD


def request_qris_payment(session_id: str, purpose: str = "session") -> dict[str, Any]:
    settings = load_settings()
    payment = settings["payment"]
    is_print = purpose == "print"
    required = payment.get("paidPrintEnabled", False) if is_print else payment.get("qrisEnabled", False)
    if not required:
        return {"required": False, "status": "not-required"}
    policy = offline_policy_status()
    if not policy["qrisAllowed"]:
        raise ValueError("QRIS tidak tersedia saat cloud offline. Gunakan voucher lokal atau mode gratis.")
    if payment["provider"] == "Not configured":
        raise ValueError("QRIS belum dikonfigurasi oleh admin. Pilih provider dan kredensial pembayaran terlebih dahulu.")
    raise ValueError(f"Adapter QRIS {payment['provider']} belum memiliki kredensial aktif pada mesin ini")


def database_health_for(path: Path) -> dict[str, Any]:
    try:
        with sqlite3.connect(path, timeout=2) as db:
            result = str(db.execute("PRAGMA quick_check").fetchone()[0])
        if result.lower() == "ok":
            return {"healthy": True, "status": "ready", "message": "Database lokal siap"}
        return {
            "healthy": False,
            "status": "corrupt",
            "message": f"Pemeriksaan SQLite gagal: {result[:160]}",
            "action": "Hentikan sesi baru, export log, lalu pulihkan backup database lokal.",
        }
    except sqlite3.DatabaseError:
        return {
            "healthy": False,
            "status": "corrupt",
            "message": "Database lokal rusak atau tidak dapat dibaca.",
            "action": "Hentikan sesi baru, export log, lalu pulihkan backup database lokal.",
        }
    except OSError:
        return {
            "healthy": False,
            "status": "unavailable",
            "message": "File database lokal tidak dapat diakses.",
            "action": "Periksa izin folder data Photoslive lalu jalankan Diagnosis lagi.",
        }


def database_health() -> dict[str, Any]:
    return database_health_for(DB_PATH)


def local_backup_metadata(path: Path) -> dict[str, Any]:
    manifest = read_json_file(path.with_suffix(".json"), {})
    created_at = str(manifest.get("createdAt") or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat())
    return {
        "name": path.name,
        "createdAt": created_at,
        "reason": str(manifest.get("reason") or "manual"),
        "sizeBytes": path.stat().st_size,
        "checksumSha256": str(manifest.get("checksumSha256") or ""),
        "schemaVersion": int(manifest.get("schemaVersion") or 0),
    }


def list_local_database_backups() -> list[dict[str, Any]]:
    root = backup_root()
    if not root.exists():
        return []
    backups: list[dict[str, Any]] = []
    for path in sorted(root.glob("photoslive-*.db"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            backups.append(local_backup_metadata(path))
        except OSError:
            continue
    return backups


def prune_local_database_backups(limit: int = LOCAL_BACKUP_LIMIT) -> None:
    root = backup_root()
    backups = sorted(root.glob("photoslive-*.db"), key=lambda item: item.stat().st_mtime, reverse=True)
    for path in backups[max(1, limit):]:
        path.unlink(missing_ok=True)
        path.with_suffix(".json").unlink(missing_ok=True)


def create_local_database_backup(reason: str = "manual") -> dict[str, Any]:
    health = database_health()
    if not health["healthy"]:
        raise ValueError("Database lokal tidak sehat sehingga backup baru tidak dibuat. Pulihkan backup yang sudah ada.")
    root = backup_root()
    root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc)
    safe_reason = re.sub(r"[^a-z0-9-]", "-", str(reason).lower()).strip("-")[:32] or "manual"
    name = f"photoslive-{timestamp.strftime('%Y%m%dT%H%M%S%fZ')}-{safe_reason}.db"
    target = root / name
    temporary = target.with_suffix(".db.part")
    try:
        with sqlite3.connect(DB_PATH, timeout=5) as source, sqlite3.connect(temporary) as destination:
            source.backup(destination)
        backup_health = database_health_for(temporary)
        if not backup_health["healthy"]:
            raise ValueError(backup_health["message"])
        os.replace(temporary, target)
        metadata = {
            "name": name,
            "createdAt": timestamp.isoformat(),
            "reason": safe_reason,
            "sizeBytes": target.stat().st_size,
            "checksumSha256": file_checksum(target),
            "schemaVersion": LOCAL_SCHEMA_VERSION,
        }
        manifest = target.with_suffix(".json")
        manifest_temp = manifest.with_suffix(".json.part")
        manifest_temp.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        os.replace(manifest_temp, manifest)
        prune_local_database_backups()
        return metadata
    except (OSError, sqlite3.DatabaseError, ValueError):
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        target.with_suffix(".json.part").unlink(missing_ok=True)
        raise


def ensure_daily_local_database_backup() -> dict[str, Any]:
    today = datetime.now(timezone.utc).date().isoformat()
    existing = next((item for item in list_local_database_backups() if item["createdAt"].startswith(today)), None)
    return existing or create_local_database_backup("daily")


def restore_local_database_backup(name: str, confirmation: str) -> dict[str, Any]:
    if confirmation != "RESTORE":
        raise ValueError("Konfirmasi restore tidak valid")
    filename = Path(str(name or "")).name
    if filename != name or not re.fullmatch(r"photoslive-[a-zA-Z0-9-]+\.db", filename):
        raise ValueError("Nama backup tidak valid")
    source_path = backup_root() / filename
    if not source_path.is_file():
        raise ValueError("Backup database tidak ditemukan")
    manifest = read_json_file(source_path.with_suffix(".json"), {})
    expected_checksum = str(manifest.get("checksumSha256") or "")
    if expected_checksum and not hmac.compare_digest(expected_checksum, file_checksum(source_path)):
        raise ValueError("Checksum backup tidak cocok; restore dibatalkan")
    backup_health = database_health_for(source_path)
    if not backup_health["healthy"]:
        raise ValueError("Backup database rusak; restore dibatalkan")

    current_health = database_health()
    safety_backup = None
    if current_health["healthy"]:
        with sqlite3.connect(DB_PATH, timeout=2) as current:
            active = int(current.execute("SELECT COUNT(*) FROM photo_sessions WHERE status = 'active'").fetchone()[0])
        if active:
            raise ValueError("Selesaikan atau batalkan sesi aktif sebelum restore database")
        safety_backup = create_local_database_backup("before-restore")

    restore_candidate = DB_PATH.with_name(f"{DB_PATH.name}.restore.part")
    restore_candidate.unlink(missing_ok=True)
    try:
        with sqlite3.connect(source_path, timeout=5) as source, sqlite3.connect(restore_candidate, timeout=5) as destination:
            source.backup(destination)
        candidate_health = database_health_for(restore_candidate)
        if not candidate_health["healthy"]:
            raise ValueError("Database kandidat restore tidak sehat")
        for suffix in ("-wal", "-shm"):
            DB_PATH.with_name(f"{DB_PATH.name}{suffix}").unlink(missing_ok=True)
        os.replace(restore_candidate, DB_PATH)
    except (OSError, sqlite3.DatabaseError, ValueError) as exc:
        restore_candidate.unlink(missing_ok=True)
        raise ValueError("Restore database gagal; backup sebelumnya tetap tersedia") from exc
    restored_health = database_health()
    if not restored_health["healthy"]:
        raise ValueError("Database hasil restore tidak sehat")
    add_event("storage", f"Database lokal dipulihkan dari {filename}")
    restore_status = record_local_restore_status(
        "completed",
        str(manifest.get("createdAt") or local_backup_metadata(source_path).get("createdAt") or ""),
        str(restored_health.get("status") or "unknown"),
    )
    return {
        "restored": True,
        "backup": local_backup_metadata(source_path),
        "safetyBackup": safety_backup,
        "database": restored_health,
        "restore": restore_status,
    }


def diagnostic_part(callback: Any, action: str) -> Any:
    try:
        return callback()
    except (OSError, sqlite3.DatabaseError, ValueError) as exc:
        return {"available": False, "error": redact_text(exc, 240), "action": action}


def diagnostics() -> dict[str, Any]:
    database = database_health()
    return redact_log_value({
        "generatedAt": utc_now(),
        "service": {"version": SERVICE_VERSION, "uptimeSeconds": int(time.time() - STARTED_AT)},
        "database": database,
        "system": {
            "disk": diagnostic_part(disk_metrics, "Periksa folder data dan ruang disk."),
            "memory": diagnostic_part(memory_metrics, "Restart Controller bila telemetry tidak pulih."),
            "network": diagnostic_part(network_metrics, "Periksa koneksi jaringan komputer."),
        },
        "devices": diagnostic_part(lambda: [asdict(device) for device in detect_devices()], "Periksa izin kamera dan service printer."),
        "queue": diagnostic_part(queue_status, database.get("action", "Pulihkan database lokal.")),
        "sync": diagnostic_part(sync_status, database.get("action", "Pulihkan database lokal.")),
        "agent": diagnostic_part(local_agent_status, "Periksa service Photoslive Agent."),
        "settings": diagnostic_part(load_settings, "Pulihkan pengaturan dari backup terakhir."),
    })


def supervisor_restart_commands() -> list[list[str]]:
    system = platform.system().lower()
    if system == "darwin":
        uid = str(os.getuid()) if hasattr(os, "getuid") else ""
        return [["launchctl", "kickstart", "-k", f"gui/{uid}/app.photoslive.agent"]]
    if system == "windows":
        return [["schtasks", "/Run", "/TN", "Photoslive Agent"]]
    return [
        ["systemctl", "--user", "restart", "photoslive-agent.service"],
        ["systemctl", "restart", "photoslive-agent.service"],
    ]


def restart_agent_service() -> tuple[bool, str]:
    errors: list[str] = []
    commands = supervisor_restart_commands()
    for command in commands:
        ok, output = command_output(command, timeout=12)
        if ok:
            add_event("agent", "Restart Agent diminta melalui OS supervisor")
            return True, output or "Restart Agent dijalankan"
        errors.append(output)
    if platform.system().lower() == "darwin" and any(command[:2] == ["launchctl", "kickstart"] for command in commands):
        uid = str(os.getuid()) if hasattr(os, "getuid") else ""
        plist = Path.home() / "Library" / "LaunchAgents" / "app.photoslive.agent.plist"
        ok, output = command_output(["launchctl", "bootstrap", f"gui/{uid}", str(plist)], timeout=12)
        if ok:
            ok, restart_output = command_output(["launchctl", "kickstart", "-k", f"gui/{uid}/app.photoslive.agent"], timeout=12)
            if ok:
                add_event("agent", "Agent dimuat kembali dan dijalankan melalui launchd")
                return True, restart_output or "Agent dimuat dan dijalankan"
            errors.append(restart_output)
        else:
            errors.append(output)
    return False, "; ".join(filter(None, errors)) or "OS supervisor Agent tidak tersedia"


def supervisor_stop_commands() -> list[list[str]]:
    system = platform.system().lower()
    if system == "darwin":
        uid = str(os.getuid()) if hasattr(os, "getuid") else ""
        return [["launchctl", "bootout", f"gui/{uid}/app.photoslive.agent"]]
    if system == "windows":
        return [["schtasks", "/End", "/TN", "Photoslive Agent"]]
    return [
        ["systemctl", "--user", "stop", "photoslive-agent.service"],
        ["systemctl", "stop", "photoslive-agent.service"],
    ]


def stop_agent_service() -> tuple[bool, str]:
    errors: list[str] = []
    for command in supervisor_stop_commands():
        ok, output = command_output(command, timeout=12)
        if ok:
            add_event("agent", "Agent dihentikan melalui kontrol Advanced")
            return True, output or "Agent dihentikan. Controller dan booth lokal tetap berjalan."
        errors.append(output)
    return False, "; ".join(filter(None, errors)) or "OS supervisor Agent tidak tersedia"


def start_update_task(action: str) -> dict[str, Any]:
    """Run update I/O outside the request thread and reject concurrent runs."""
    if not UPDATE_TASK_LOCK.acquire(blocking=False):
        raise ValueError("Proses update atau rollback masih berjalan")

    def worker() -> None:
        try:
            if action == "check":
                release_updater.check_update(DATA_ROOT, SERVICE_VERSION)
            elif action == "apply":
                release_updater.apply_update(DATA_ROOT, ROOT, SERVICE_VERSION)
            elif action == "rollback":
                release_updater.rollback_update(DATA_ROOT, ROOT, SERVICE_VERSION)
            else:
                raise release_updater.UpdateError("Tindakan update tidak didukung")
            add_event("update", f"Lifecycle update selesai: {action}")
        except Exception as exc:
            # The updater has already persisted a safe failure/rollback state.
            # Keep logs actionable without including manifests or credentials.
            add_event("update", f"Lifecycle update gagal: {action} ({redact_text(str(exc))[:180]})")
        finally:
            UPDATE_TASK_LOCK.release()

    thread = threading.Thread(target=worker, name=f"photoslive-update-{action}", daemon=True)
    thread.start()
    return {"accepted": True, "action": action, "status": release_updater.update_status(DATA_ROOT, SERVICE_VERSION)}


def create_agent_setup_code() -> dict[str, Any]:
    ok, output = command_output([sys.executable, str(ROOT / "agent.py"), "--setup-code"], timeout=25)
    if not ok:
        raise ValueError(output or "Kode setup gagal dibuat. Pastikan Agent terhubung ke internet.")
    match = re.search(r"Kode setup baru:\s*([A-Z0-9-]+)", output)
    if not match:
        raise ValueError("Agent tidak mengembalikan kode setup")
    code = match.group(1)
    add_event("agent", "Kode setup baru dibuat dari Local Manager")
    return {"code": code, "expiresInSeconds": 900, "setupUrl": f"https://photoslive.vercel.app/setup?code={code}"}


def system_status() -> dict[str, Any]:
    devices = detect_devices()
    usage = today_usage()
    settings = load_settings()
    return {
        "timestamp": utc_now(),
        "uptimeSeconds": int(time.time() - STARTED_AT),
        "disk": disk_metrics(),
        "memory": memory_metrics(),
        "network": network_metrics(),
        "devices": [asdict(device) for device in devices],
        "boothClients": list_booth_clients(),
        "usage": usage,
        "dailyLimit": settings["booth"]["dailySessionLimit"],
        "events": recent_events(),
        "queue": queue_status(),
        "capabilities": {"renderer": renderer_capability()},
        "offlinePolicy": offline_policy_status(),
    }


def metric_route(path: str) -> str:
    """Collapse per-session identifiers so the in-memory registry stays bounded."""
    clean = urlparse(path or "").path
    clean = re.sub(r"^(/api/sessions)/[^/]+", r"\1/:id", clean)
    clean = re.sub(r"^(/api/session-files)/[^/]+", r"\1/:id", clean)
    return clean[:160] or "/"


def record_request_metric(method: str, path: str, status: int, duration_ms: float) -> None:
    route = metric_route(path)
    if not route.startswith("/api/") or route == "/api/local/metrics":
        return
    with METRICS_LOCK:
        REQUEST_METRIC_SAMPLES.append({
            "method": str(method or "GET")[:12],
            "route": route,
            "status": int(status),
            "durationMs": max(0.0, round(float(duration_ms), 3)),
            "recordedAt": time.time(),
        })


def increment_operation_failure(kind: str) -> None:
    with METRICS_LOCK:
        OPERATION_FAILURES[kind] = int(OPERATION_FAILURES.get(kind, 0)) + 1


def percentile(values: list[float], quantile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) - 1) * quantile)))
    return round(ordered[index], 2)


def print_queue_metrics() -> dict[str, int]:
    with sqlite3.connect(DB_PATH) as db:
        rows = db.execute(
            "SELECT status, COUNT(*) FROM jobs WHERE kind = 'print' GROUP BY status"
        ).fetchall()
    counts = {str(status): int(count) for status, count in rows}
    return {
        "pending": counts.get("pending", 0),
        "running": counts.get("running", 0),
        "failed": counts.get("failed", 0),
        "completed": counts.get("completed", 0),
    }


def local_metrics_snapshot() -> dict[str, Any]:
    with METRICS_LOCK:
        samples = list(REQUEST_METRIC_SAMPLES)
        failures = dict(OPERATION_FAILURES)
    durations = [float(item["durationMs"]) for item in samples]
    errors = sum(1 for item in samples if int(item["status"]) >= 400)
    routes: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in samples:
        routes.setdefault((str(item["method"]), str(item["route"])), []).append(item)
    route_metrics = []
    for (method, route), items in routes.items():
        route_durations = [float(item["durationMs"]) for item in items]
        route_errors = sum(1 for item in items if int(item["status"]) >= 400)
        route_metrics.append({
            "method": method,
            "route": route,
            "requests": len(items),
            "errors": route_errors,
            "p95Ms": percentile(route_durations, 0.95),
        })
    route_metrics.sort(key=lambda item: (-item["errors"], -item["p95Ms"], item["route"]))
    sync = diagnostic_part(sync_status, "Pulihkan database untuk membaca antrean upload.")
    prints = diagnostic_part(print_queue_metrics, "Pulihkan database untuk membaca antrean cetak.")
    disk = diagnostic_part(lambda: disk_metrics(photo_root()), "Periksa folder foto dan ruang disk.")
    storage_alert = diagnostic_part(lambda: storage_safety(photo_root()), "Periksa folder foto dan ruang disk.")
    return {
        "generatedAt": utc_now(),
        "uptimeSeconds": int(time.time() - STARTED_AT),
        "sampleLimit": REQUEST_METRIC_SAMPLES.maxlen,
        "requests": {
            "total": len(samples),
            "errors": errors,
            "errorRatePercent": round((errors / len(samples)) * 100, 2) if samples else 0.0,
            "averageMs": round(sum(durations) / len(durations), 2) if durations else 0.0,
            "p95Ms": percentile(durations, 0.95),
            "maxMs": round(max(durations), 2) if durations else 0.0,
        },
        "routes": route_metrics[:20],
        "queues": {"sync": sync, "print": prints},
        "storage": {"disk": disk, "safety": storage_alert},
        "failures": failures,
    }


class ApiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {redact_text(format % args, 1000)}")

    def handle_one_request(self) -> None:
        started = time.perf_counter()
        self._response_status = HTTPStatus.INTERNAL_SERVER_ERROR
        try:
            super().handle_one_request()
        finally:
            command = getattr(self, "command", "")
            path = getattr(self, "path", "")
            if command and path:
                record_request_metric(
                    command,
                    path,
                    int(self._response_status),
                    (time.perf_counter() - started) * 1000,
                )

    def send_response(self, code: int, message: str | None = None) -> None:
        self._response_status = int(code)
        super().send_response(code, message)

    def send_head(self) -> Any:
        # Admin assets change frequently during setup. Ignore conditional cache
        # headers so a normal refresh never keeps an older HTML/CSS/JS bundle.
        for header in ("If-Modified-Since", "If-None-Match"):
            if header in self.headers:
                del self.headers[header]
        return super().send_head()

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, payload: Any, status: int = HTTPStatus.OK, headers: dict[str, str] | None = None) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("Payload terlalu besar")
        return json.loads(self.rfile.read(length) or b"{}")

    def read_bytes(self, maximum: int = 20_000_000) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > maximum:
            raise ValueError(f"Payload harus 1-{maximum // 1_000_000} MB")
        return self.rfile.read(length)

    def local_auth_headers(self) -> dict[str, str] | None:
        origin = local_auth_allowed_origin(self.headers.get("Origin"))
        if self.headers.get("Origin") and not origin:
            return None
        headers = {"Vary": "Origin"}
        if origin:
            headers.update({
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Private-Network": "true",
            })
        return headers

    def loopback_request(self) -> bool:
        return str(self.client_address[0]) in {"127.0.0.1", "::1"}

    def do_OPTIONS(self) -> None:
        if urlparse(self.path).path not in {"/api/local/auth/capability", "/api/local/auth/assertion"}:
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return
        headers = self.local_auth_headers()
        if not self.loopback_request() or headers is None:
            self.send_json({"error": "Origin login lokal tidak diizinkan"}, HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()

    def local_token_valid(self) -> bool:
        return self.headers.get("X-Photoslive-Token", "") == installation_token()

    def require_local_token(self) -> bool:
        if self.local_token_valid():
            return True
        self.send_json({"error": "Token instalasi lokal tidak valid"}, HTTPStatus.UNAUTHORIZED)
        return False

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/platform" and query.get("action", [""])[0] == "me":
            account = test_admin_account()
            if not account or not self.loopback_request() or not test_admin_session_valid(self.headers.get("Cookie")):
                return self.send_json({"error": "Login admin testing diperlukan"}, HTTPStatus.UNAUTHORIZED)
            return self.send_json({
                "testMode": True,
                "user": {"id": "test-owner", "boothCode": account["boothCode"], "email": account["email"], "name": "Pemilik Test", "role": "owner"},
                "booth": {"boothCode": account["boothCode"], "machineId": "test-machine", "name": account["name"], "location": account["location"], "enabled": True},
            })
        if path == "/api/settings":
            return self.send_json(load_settings())
        if path in {"/api/status", "/api/overview"}:
            return self.send_json(system_status())
        if path == "/api/health":
            return self.send_json({"status": "ok", "time": utc_now(), "version": SERVICE_VERSION})
        if path == "/api/local/installation":
            return self.send_json({"token": installation_token()})
        if path == "/api/local/auth/capability":
            headers = self.local_auth_headers()
            if not self.loopback_request() or headers is None:
                return self.send_json({"error": "Login PIN hanya tersedia di komputer photobox"}, HTTPStatus.FORBIDDEN)
            return self.send_json(local_login_capability(), headers=headers)
        if path == "/api/local/agent/status":
            return self.send_json(local_agent_status())
        if path == "/api/local/companion/status":
            if not self.require_local_token():
                return
            return self.send_json({"status": companion_safe_state(), "capabilities": companion_capabilities()})
        if path == "/api/local/metrics":
            if not self.require_local_token():
                return
            return self.send_json(local_metrics_snapshot())
        if path == "/api/local/agent/logs":
            try:
                limit = int(query.get("limit", ["120"])[0])
            except ValueError:
                limit = 120
            return self.send_json({"lines": tail_agent_logs(limit)})
        if path == "/api/local/backups":
            if not self.require_local_token():
                return
            return self.send_json({"database": database_health(), "backups": list_local_database_backups(), "restore": local_restore_status()})
        if path == "/api/local/sync/status":
            return self.send_json(sync_status())
        if path == "/api/local/sync/jobs":
            if not self.require_local_token():
                return
            try:
                limit = int(query.get("limit", ["50"])[0])
                return self.send_json({"jobs": list_sync_jobs(limit), "summary": sync_status()})
            except (ValueError, sqlite3.DatabaseError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/print/jobs":
            if not self.require_local_token():
                return
            try:
                limit = int(query.get("limit", ["50"])[0])
                return self.send_json({"jobs": list_print_jobs(limit)})
            except (ValueError, sqlite3.DatabaseError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/session-recovery":
            if not self.require_local_token():
                return
            try:
                limit = int(query.get("limit", ["10"])[0])
                return self.send_json(session_recovery_overview(limit))
            except (ValueError, sqlite3.DatabaseError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/offline-policy":
            return self.send_json(offline_policy_status())
        if path == "/api/local/sync/claim":
            if not self.require_local_token():
                return
            return self.send_json({"job": claim_sync_job()})
        if path == "/api/local/vouchers/redemptions":
            if not self.require_local_token():
                return
            return self.send_json({"redemptions": offline_voucher_redemptions()})
        if path == "/api/devices":
            return self.send_json({"devices": [asdict(device) for device in detect_devices()]})
        if path == "/api/devices/camera/preview.jpg":
            ok, data, error = camera_preview()
            if ok:
                return self.send_bytes(data, "image/jpeg")
            return self.send_json({"error": error}, HTTPStatus.SERVICE_UNAVAILABLE)
        if path == "/api/assets":
            return self.send_json(list_assets())
        if path == "/api/booth/config":
            return self.send_json(booth_config())
        if path == "/api/booth/recovery":
            if not self.loopback_request():
                return self.send_json({"error": "Pemulihan sesi hanya tersedia di komputer photobox"}, HTTPStatus.FORBIDDEN)
            return self.send_json({"session": current_recoverable_session()})
        if path == "/api/booth/clients":
            return self.send_json({"clients": list_booth_clients()})
        if path.startswith("/api/session-files/"):
            file_data = session_file(path.rsplit("/", 1)[-1])
            if file_data:
                return self.send_bytes(file_data[0], file_data[1])
            return self.send_json({"error": "File foto tidak ditemukan"}, HTTPStatus.NOT_FOUND)
        if path == "/api/vouchers":
            return self.send_json({"vouchers": list_vouchers(), "summary": voucher_summary(), "events": list_voucher_events()})
        if path == "/api/voucher-events":
            return self.send_json({"events": list_voucher_events()})
        if path == "/api/vouchers/print":
            try:
                event_id = str(query.get("eventId", [""])[0]).strip() or None
                return self.send_bytes(printable_vouchers(event_id), "text/html; charset=utf-8")
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        if path == "/api/diagnostics":
            return self.send_json(diagnostics())
        if path == "/api/storage/overview":
            return self.send_json(storage_snapshot(force=query.get("refresh") == ["1"]))
        if path == "/api/storage/cleanup/preview":
            return self.send_json(storage_cleanup(dry_run=True))
        if path == "/api/storage/sessions":
            try:
                hours = int(query.get("hours", ["24"])[0])
            except ValueError:
                hours = 24
            return self.send_json({"hours": max(1, min(hours, 168)), "sessions": recent_photo_sessions(hours)})
        if path.startswith("/api/sessions/"):
            token = path.rsplit("/", 1)[-1]
            session = session_summary(token)
            return self.send_json({"session": session}, HTTPStatus.OK if session else HTTPStatus.NOT_FOUND)
        if path.startswith("/session/"):
            token = path.rsplit("/", 1)[-1]
            page = session_page(token)
            if page:
                return self.send_bytes(page, "text/html; charset=utf-8")
            return self.send_bytes(b"Sesi tidak ditemukan atau sudah kedaluwarsa", "text/plain; charset=utf-8", HTTPStatus.NOT_FOUND)
        dynamic_admin = re.fullmatch(r"/([a-z0-9][a-z0-9-]{1,62})/admin", path, re.IGNORECASE)
        dynamic_session = re.fullmatch(r"/([a-z0-9][a-z0-9-]{1,62})/sesi/([a-z0-9-]{6,128})", path, re.IGNORECASE)
        dynamic_booth = re.fullmatch(r"/([a-z0-9][a-z0-9-]{1,62})", path, re.IGNORECASE)
        if dynamic_admin:
            self.path = "/admin.html"
        elif dynamic_session:
            self.path = "/session.html"
        elif dynamic_booth and dynamic_booth.group(1).lower() not in {"setup", "superadmin", "local-agent", "status", "companion", "booth", "kiosk"}:
            self.path = "/booth.html"
        elif path in {"/booth", "/kiosk"}:
            self.path = "/booth.html"
        elif path == "/setup":
            self.path = "/setup.html"
        elif path == "/local-agent":
            self.path = "/local-agent.html"
        elif path == "/status":
            self.path = "/status.html"
        elif path == "/superadmin":
            self.path = "/superadmin.html"
        elif path == "/companion":
            self.path = "/companion.html"
        elif path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/settings":
            section = None
        elif path.startswith("/api/settings/"):
            section = path.rsplit("/", 1)[-1]
            if section not in DEFAULT_SETTINGS:
                return self.send_json({"error": "Bagian pengaturan tidak dikenal"}, HTTPStatus.NOT_FOUND)
        else:
            return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        try:
            payload = self.read_json()
            return self.send_json(save_settings({section: payload} if section else payload))
        except (ValueError, json.JSONDecodeError) as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/platform" and query.get("action", [""])[0] == "login":
            account = test_admin_account()
            if not account or not self.loopback_request():
                return self.send_json({"error": "Akun testing lokal tidak aktif"}, HTTPStatus.NOT_FOUND)
            try:
                payload = self.read_json()
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            booth_code = str(payload.get("boothCode") or "").strip().lower()
            email = str(payload.get("email") or "").strip().lower()
            password = str(payload.get("password") or "")
            valid = (
                hmac.compare_digest(booth_code, account["boothCode"])
                and hmac.compare_digest(email, account["email"])
                and hmac.compare_digest(password, account["password"])
            )
            if not valid:
                return self.send_json({"error": "Kode photobox, email, atau password testing tidak benar"}, HTTPStatus.UNAUTHORIZED)
            return self.send_json({
                "testMode": True,
                "user": {"id": "test-owner", "email": account["email"], "name": "Pemilik Test", "role": "owner"},
                "booth": {"boothCode": account["boothCode"], "machineId": "test-machine", "name": account["name"], "location": account["location"], "enabled": True},
            }, HTTPStatus.OK, {"Set-Cookie": f"photoslive_test_session={TEST_ADMIN_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax"})
        if path == "/api/platform" and query.get("action", [""])[0] == "logout":
            return self.send_json({"ok": True}, headers={"Set-Cookie": "photoslive_test_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"})
        if path == "/api/test/reset-sessions" and os.environ.get("PHOTOSLIVE_TEST_MODE") == "1" and self.loopback_request():
            return self.send_json(reset_e2e_sessions())
        if path == "/api/local/auth/assertion":
            headers = self.local_auth_headers()
            if not self.loopback_request() or headers is None:
                return self.send_json({"error": "Login PIN hanya tersedia di komputer photobox"}, HTTPStatus.FORBIDDEN)
            try:
                return self.send_json(local_login_assertion(), headers=headers)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.SERVICE_UNAVAILABLE, headers=headers)
        if path.startswith("/api/local/privacy/sessions/"):
            if not self.require_local_token():
                return
            share_token = unquote(path.rsplit("/", 1)[-1])
            try:
                return self.send_json(delete_photo_session_by_share_token(share_token))
            except (ValueError, OSError, sqlite3.DatabaseError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path in {"/api/local/agent/pause", "/api/local/agent/resume"}:
            if not self.require_local_token():
                return
            return self.send_json({"control": set_agent_paused(path.endswith("pause")), "status": local_agent_status()})
        if path == "/api/local/agent/restart":
            if not self.require_local_token():
                return
            ok, message = restart_agent_service()
            return self.send_json({"accepted": ok, "message": message}, HTTPStatus.ACCEPTED if ok else HTTPStatus.CONFLICT)
        if path == "/api/local/agent/stop":
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                if str(payload.get("confirmation") or "") != "STOP AGENT":
                    raise ValueError("Ketik STOP AGENT untuk menghentikan service cloud Agent")
                ok, message = stop_agent_service()
                return self.send_json({"accepted": ok, "message": message}, HTTPStatus.ACCEPTED if ok else HTTPStatus.CONFLICT)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path in {"/api/local/agent/update/check", "/api/local/agent/update/apply"}:
            if not self.require_local_token():
                return
            try:
                action = "check" if path.endswith("check") else "apply"
                current = release_updater.update_status(DATA_ROOT, SERVICE_VERSION)
                if action == "apply" and current.get("state") != "ready":
                    raise ValueError("Periksa update dan tunggu hingga versi baru siap dipasang")
                return self.send_json(start_update_task(action), HTTPStatus.ACCEPTED)
            except (ValueError, release_updater.UpdateError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/agent/update/rollback":
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                if str(payload.get("confirmation") or "") != "ROLLBACK":
                    raise ValueError("Ketik ROLLBACK untuk memulihkan versi sebelumnya")
                return self.send_json(start_update_task("rollback"), HTTPStatus.ACCEPTED)
            except (ValueError, release_updater.UpdateError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/agent/setup-code":
            if not self.require_local_token():
                return
            try:
                return self.send_json(create_agent_setup_code(), HTTPStatus.CREATED)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/companion/pairing":
            if not self.require_local_token():
                return
            try:
                return self.send_json(create_companion_pairing(), HTTPStatus.CREATED)
            except (OSError, ValueError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/companion/revoke":
            if not self.require_local_token():
                return
            try:
                return self.send_json({"status": revoke_companion()})
            except OSError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/agent/diagnose":
            if not self.require_local_token():
                return
            return self.send_json(diagnostics())
        if path == "/api/local/backups/create":
            if not self.require_local_token():
                return
            try:
                return self.send_json({"backup": create_local_database_backup("manual")}, HTTPStatus.CREATED)
            except (ValueError, OSError, sqlite3.DatabaseError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/backups/restore":
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                result = restore_local_database_backup(str(payload.get("name") or ""), str(payload.get("confirmation") or ""))
                ensure_print_worker()
                return self.send_json(result)
            except (ValueError, OSError, sqlite3.DatabaseError, json.JSONDecodeError) as exc:
                try:
                    record_local_restore_status("failed", database_status=str(database_health().get("status") or "unknown"))
                except OSError:
                    pass
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/devices/refresh":
            if not self.require_local_token():
                return
            diagnostic_part(
                lambda: add_event("device", "Pendeteksian perangkat dijalankan dari Local Manager"),
                "Pulihkan database lokal agar audit perangkat kembali tercatat.",
            )
            return self.send_json({"devices": [asdict(device) for device in detect_devices()]})
        if path == "/api/local/devices/camera/test":
            if not self.require_local_token():
                return
            ok, output = test_camera()
            if not ok:
                increment_operation_failure("camera")
            diagnostic_part(
                lambda: add_event("device", f"Tes kamera Local Manager: {'berhasil' if ok else 'gagal'}"),
                "Pulihkan database lokal agar audit perangkat kembali tercatat.",
            )
            return self.send_json({"ok": ok, "message": output[:1000]}, HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
        if path == "/api/local/devices/printer/test":
            if not self.require_local_token():
                return
            settings = load_settings()
            printer = settings["devices"]["preferredPrinter"]
            command = ["lpstat", "-p"] if printer == "auto" else ["lpstat", "-p", printer.removeprefix("cups-")]
            ok, output = command_output(command)
            if not ok:
                increment_operation_failure("printer")
            diagnostic_part(
                lambda: add_event("device", f"Tes printer Local Manager: {'berhasil' if ok else 'gagal'}"),
                "Pulihkan database lokal agar audit perangkat kembali tercatat.",
            )
            return self.send_json({"ok": ok, "message": output or ("Printer siap" if ok else "Printer tidak tersedia")}, HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
        if path == "/api/local/storage/pick-folder":
            if not self.require_local_token():
                return
            try:
                return self.send_json(pick_local_folder())
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/vouchers/sync":
            if not self.require_local_token():
                return
            try:
                return self.send_json(sync_cloud_vouchers(self.read_json()))
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/offline-policy/refresh":
            if not self.require_local_token():
                return
            try:
                return self.send_json(refresh_offline_policy_lease(self.read_json()))
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/settings/sync":
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                incoming = payload.get("settings") if isinstance(payload, dict) else None
                if not isinstance(incoming, dict):
                    raise ValueError("Snapshot pengaturan cloud tidak valid")
                updated = save_settings(incoming)
                set_local_state("settings_version", str(max(0, int(payload.get("version") or 0))))
                return self.send_json({"settings": updated, "version": int(payload.get("version") or 0)})
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/sync/progress":
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                return self.send_json({"checkpoint": checkpoint_sync_file(
                    str(payload.get("jobId") or ""), str(payload.get("fileId") or "")
                )})
            except (ValueError, sqlite3.DatabaseError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/sync/multipart":
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                return self.send_json({"checkpoint": checkpoint_sync_multipart(
                    str(payload.get("jobId") or ""),
                    str(payload.get("fileId") or ""),
                    str(payload.get("uploadId") or ""),
                    int(payload.get("partNumber") or 0),
                    str(payload.get("etag") or ""),
                    int(payload.get("partSize") or 0),
                    int(payload.get("totalSize") or 0),
                )})
            except (ValueError, TypeError, sqlite3.DatabaseError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path in {"/api/local/sync/complete", "/api/local/sync/fail"}:
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                result = update_sync_job(
                    str(payload.get("jobId") or ""),
                    path.endswith("complete"),
                    str(payload.get("error") or ""),
                )
                return self.send_json({"job": result})
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/local/sync/retry":
            if not self.require_local_token():
                return
            return self.send_json({"retried": retry_failed_sync_jobs()})
        if path == "/api/local/sync/retry-job":
            if not self.require_local_token():
                return
            try:
                return self.send_json({"job": retry_sync_job(str(self.read_json().get("jobId") or ""))})
            except (ValueError, sqlite3.DatabaseError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/print/retry-job":
            if not self.require_local_token():
                return
            try:
                return self.send_json({"job": retry_print_job(str(self.read_json().get("jobId") or ""))})
            except (ValueError, sqlite3.DatabaseError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/local/session-recovery/recover":
            if not self.require_local_token():
                return
            try:
                payload = self.read_json()
                return self.send_json({"session": recover_photo_session(
                    str(payload.get("sessionId") or ""), int(payload.get("extensionSeconds") or 180)
                )})
            except (ValueError, TypeError, sqlite3.DatabaseError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/devices/refresh":
            add_event("device", "Pendeteksian perangkat dijalankan")
            return self.send_json({"devices": [asdict(device) for device in detect_devices()]})
        if path in {"/api/actions/test-print", "/api/devices/printer/test"}:
            ok, output = test_printer_connection()
            add_event("device", f"Tes koneksi printer: {'berhasil' if ok else 'gagal'}")
            return self.send_json({"ok": ok, "message": output}, HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
        if path == "/api/devices/printer/test-page":
            ok, message = print_test_page()
            add_event("device", f"Cetak lembar tes: {'dikirim' if ok else 'gagal'}")
            return self.send_json({"ok": ok, "message": message}, HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
        if path == "/api/devices/camera/test":
            ok, output = test_camera()
            add_event("device", f"Tes koneksi kamera: {'berhasil' if ok else 'gagal'}")
            return self.send_json({"ok": ok, "message": output[:1000]}, HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
        if path == "/api/devices/camera/capture":
            ok, data, error = camera_image(capture=True)
            add_event("device", f"Pengambilan foto: {'berhasil' if ok else 'gagal'}")
            if ok:
                return self.send_bytes(data, "image/jpeg")
            return self.send_json({"error": error}, HTTPStatus.SERVICE_UNAVAILABLE)
        if path in {"/api/actions/restart-service", "/api/system/restart"}:
            if os.environ.get("PHOTOSLIVE_ALLOW_RESTART") != "1":
                return self.send_json({"error": "Restart belum diaktifkan pada service Linux"}, HTTPStatus.CONFLICT)
            add_event("system", "Service dijadwalkan untuk restart")
            threading.Thread(
                target=lambda: subprocess.run(["systemctl", "restart", "photoslive.service"], check=False),
                daemon=True,
            ).start()
            return self.send_json({"accepted": True, "message": "Service sedang direstart"}, HTTPStatus.ACCEPTED)
        if path == "/api/vouchers":
            try:
                return self.send_json({"voucher": create_voucher(self.read_json())}, HTTPStatus.CREATED)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/vouchers/generate":
            try:
                return self.send_json(generate_vouchers(self.read_json()), HTTPStatus.CREATED)
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/vouchers/redeem":
            try:
                return self.send_json({"voucher": redeem_voucher(self.read_json())})
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/voucher-events":
            try:
                return self.send_json({"event": create_voucher_event(self.read_json())}, HTTPStatus.CREATED)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/jobs/clear-failed":
            return self.send_json({"deleted": clear_failed_jobs()})
        if path == "/api/storage/cleanup":
            try:
                payload = self.read_json()
                return self.send_json(storage_cleanup(dry_run=bool(payload.get("dryRun", False))))
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/storage/pick-folder":
            try:
                selected = pick_local_folder()
                add_event("storage", f"Folder foto dipilih: {selected['path']}")
                return self.send_json(selected)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/booth/sessions":
            try:
                payload = self.read_json()
                consent = payload.get("consent") if isinstance(payload.get("consent"), dict) else None
                if not consent or consent.get("accepted") is not True or consent.get("version") != PHOTO_CONSENT_VERSION:
                    raise ValueError("Persetujuan pemrosesan foto diperlukan untuk memulai sesi")
                return self.send_json({"session": create_photo_session(str(payload.get("frameId") or "").strip() or None, consent)}, HTTPStatus.CREATED)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/booth/client":
            try:
                return self.send_json({"client": register_booth_client(self.headers.get("X-Client-Id", self.client_address[0]), self.read_json())}, HTTPStatus.CREATED)
            except (ValueError, TypeError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/booth/qris":
            try:
                payload = self.read_json()
                return self.send_json({"payment": request_qris_payment(str(payload.get("sessionId") or ""), str(payload.get("purpose") or "session"))}, HTTPStatus.CREATED)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/booth/print":
            try:
                payload = self.read_json()
                return self.send_json({"job": queue_session_print(str(payload.get("sessionId") or ""), str(payload.get("voucherCode") or ""))}, HTTPStatus.ACCEPTED)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.CONFLICT)
        if path == "/api/sessions":
            try:
                return self.send_json({"session": create_photo_session()}, HTTPStatus.CREATED)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path.startswith("/api/sessions/") and path.endswith("/capture"):
            session_id = path.split("/")[3]
            try:
                return self.send_json({"file": capture_session_photo(session_id, self.read_json())}, HTTPStatus.CREATED)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path.startswith("/api/sessions/") and path.endswith("/capture-upload"):
            session_id = path.split("/")[3]
            try:
                if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "image/jpeg":
                    raise ValueError("Content-Type capture harus image/jpeg")
                slot_index = int(self.headers.get("X-Slot-Index", "0"))
                return self.send_json({"file": capture_session_upload(session_id, slot_index, self.read_bytes())}, HTTPStatus.CREATED)
            except (ValueError, TypeError) as exc:
                increment_operation_failure("capture")
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
            except OSError as exc:
                increment_operation_failure("capture")
                return self.send_json({"error": str(exc)}, HTTPStatus.INSUFFICIENT_STORAGE)
            except sqlite3.DatabaseError:
                increment_operation_failure("capture")
                return self.send_json(
                    {"error": "Database lokal tidak dapat menyimpan foto. Jalankan Diagnosis dari Local Manager."},
                    HTTPStatus.SERVICE_UNAVAILABLE,
                )
        if path.startswith("/api/sessions/") and path.endswith("/files"):
            session_id = path.split("/")[3]
            try:
                return self.send_json({"file": register_session_file(session_id, self.read_json())}, HTTPStatus.CREATED)
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path.startswith("/api/sessions/") and path.endswith("/select"):
            session_id = path.split("/")[3]
            try:
                return self.send_json({"selection": select_session_file(session_id, self.read_json())})
            except (ValueError, json.JSONDecodeError) as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path.startswith("/api/sessions/") and path.endswith("/complete"):
            session_id = path.split("/")[3]
            try:
                return self.send_json({"session": complete_photo_session(session_id)})
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if path not in {"/api/assets/background", "/api/assets/frame", "/api/assets/logo", "/api/assets/sticker"}:
            return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 10 * 1024 * 1024:
                raise ValueError("Ukuran aset harus antara 1 byte dan 10 MB")
            kind = path.rsplit("/", 1)[-1]
            filename = safe_asset_name(self.headers.get("X-Filename", ""))
            target = UPLOAD_ROOT / kind / f"{int(time.time())}-{filename}"
            target.write_bytes(self.rfile.read(length))
            add_event("asset", f"{kind.title()} baru ditambahkan: {filename}")
            return self.send_json({"asset": {"name": target.name, "url": f"/uploads/{kind}/{target.name}"}}, HTTPStatus.CREATED)
        except (ValueError, OSError) as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if path.startswith("/api/vouchers/"):
            code = path.rsplit("/", 1)[-1].upper()
            if delete_voucher(code):
                return self.send_json({"deleted": True})
            return self.send_json({"error": "Voucher tidak ditemukan atau sudah dipakai"}, HTTPStatus.NOT_FOUND)
        if path.startswith("/api/assets/"):
            parts = path.split("/")
            if len(parts) != 5 or parts[3] not in {"background", "frame", "logo", "sticker"}:
                return self.send_json({"error": "Aset tidak valid"}, HTTPStatus.BAD_REQUEST)
            kind, filename = parts[3], safe_asset_name(parts[4])
            target = UPLOAD_ROOT / kind / filename
            if not target.exists():
                return self.send_json({"error": "Aset tidak ditemukan"}, HTTPStatus.NOT_FOUND)
            target.unlink()
            add_event("asset", f"{kind.title()} dihapus: {filename}")
            return self.send_json({"deleted": True})
        return self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)


class CompanionApiHandler(SimpleHTTPRequestHandler):
    """Narrow LAN surface for a paired tablet; never exposes Local Manager APIs."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # URL fragments hold the one-time token and are never sent to this server.
        print(f"[companion {self.log_date_time_string()}] {redact_text(format % args, 500)}")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self'")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self, maximum: int = 3_000_000) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > maximum:
            raise ValueError("Payload companion terlalu besar")
        value = json.loads(self.rfile.read(length))
        if not isinstance(value, dict):
            raise ValueError("Payload companion harus berupa object")
        return value

    def bearer(self) -> str:
        authorization = str(self.headers.get("Authorization") or "")
        return authorization[7:].strip() if authorization.startswith("Bearer ") else ""

    def require_session(self) -> str | None:
        token = self.bearer()
        if token and companion_session_valid(token):
            return token
        self.send_json({"error": "Sesi companion tidak valid atau sudah berakhir"}, HTTPStatus.UNAUTHORIZED)
        return None

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in {"/", "/companion", "/companion.html"}:
            self.path = "/companion.html"
            return super().do_GET()
        if path in {"/companion.css", "/companion.js"}:
            return super().do_GET()
        if path == "/api/companion/status":
            token = self.require_session()
            if not token:
                return
            try:
                return self.send_json({"status": companion_heartbeat(token), "capabilities": companion_capabilities()})
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, HTTPStatus.UNAUTHORIZED)
        return self.send_json({"error": "Route companion tidak ditemukan"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            if path == "/api/companion/claim":
                payload = self.read_json(20_000)
                result = claim_companion_pairing(
                    str(payload.get("pairingId") or ""),
                    str(payload.get("token") or ""),
                    str(payload.get("deviceName") or "Tablet"),
                )
                return self.send_json(result, HTTPStatus.CREATED)
            token = self.require_session()
            if not token:
                return
            if path == "/api/companion/heartbeat":
                return self.send_json({"status": companion_heartbeat(token)})
            if path == "/api/companion/test/storage":
                payload = self.read_json()
                result = companion_storage_test(str(payload.get("imageBase64") or ""))
                companion_heartbeat(token)
                return self.send_json(result)
            if path == "/api/companion/test/printer":
                payload = self.read_json(10_000)
                if str(payload.get("confirmation") or "") != "PRINT TEST":
                    raise ValueError("Konfirmasi cetak uji diperlukan")
                ok, message = print_test_page()
                companion_heartbeat(token)
                return self.send_json({"ok": ok, "message": message}, HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
            if path == "/api/companion/revoke":
                return self.send_json({"status": revoke_companion()})
            return self.send_json({"error": "Route companion tidak ditemukan"}, HTTPStatus.NOT_FOUND)
        except (ValueError, json.JSONDecodeError, OSError) as exc:
            return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)


def main() -> None:
    database_ready = True
    try:
        ensure_data()
        ensure_daily_local_database_backup()
    except (sqlite3.DatabaseError, RuntimeError, OSError) as exc:
        # Keep the loopback recovery surface reachable even when SQLite cannot
        # boot. Booth/database routes will fail closed until a verified backup
        # is restored from Local Manager.
        database_ready = False
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        backup_root().mkdir(parents=True, exist_ok=True)
        if not LOCAL_TOKEN_PATH.exists():
            LOCAL_TOKEN_PATH.write_text(uuid.uuid4().hex + uuid.uuid4().hex, encoding="utf-8")
        print(f"Photoslive database recovery required: {exc}", file=sys.stderr)
    host = os.environ.get("PHOTOSLIVE_HOST", "127.0.0.1")
    port = int(os.environ.get("PHOTOSLIVE_PORT", "8080"))
    server = ThreadingHTTPServer((host, port), ApiHandler)
    companion_server: ThreadingHTTPServer | None = None
    companion_thread: threading.Thread | None = None
    if os.environ.get("PHOTOSLIVE_COMPANION_ENABLED", "1").strip().lower() not in {"0", "false", "no"}:
        try:
            companion_server = ThreadingHTTPServer(("0.0.0.0", companion_port()), CompanionApiHandler)
            companion_thread = threading.Thread(target=companion_server.serve_forever, name="photoslive-companion", daemon=True)
            companion_thread.start()
        except OSError as exc:
            print(f"Photoslive companion listener unavailable: {redact_text(str(exc), 300)}", file=sys.stderr)
    worker = ensure_print_worker() if database_ready else None
    def stop_services(*_: Any) -> None:
        PRINT_WORKER_STOP.set()
        if companion_server:
            threading.Thread(target=companion_server.shutdown, name="photoslive-companion-shutdown", daemon=True).start()
        # BaseServer.shutdown() must run outside the serve_forever thread.
        threading.Thread(target=server.shutdown, name="photoslive-shutdown", daemon=True).start()
    signal.signal(signal.SIGTERM, stop_services)
    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, stop_services)
    print(f"Photoslive admin ready at http://{host}:{port}")
    if companion_server:
        print(f"Photoslive companion ready at {companion_local_address()}/companion")
    try:
        server.serve_forever()
    finally:
        PRINT_WORKER_STOP.set()
        if worker:
            worker.join(timeout=2)
        if companion_server:
            companion_server.server_close()
        if companion_thread:
            companion_thread.join(timeout=2)


if __name__ == "__main__":
    main()
