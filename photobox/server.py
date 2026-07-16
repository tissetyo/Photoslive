#!/usr/bin/env python3
"""Lightweight local control service for the Photoslive booth.

Uses only the Python standard library so it remains suitable for a small Linux
mini PC. Device commands gracefully degrade when their Linux utilities are not
installed, which lets the admin UI explain what is missing instead of failing.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from html import escape
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
DATA_ROOT = ROOT / "data"
UPLOAD_ROOT = WEB_ROOT / "uploads"
PHOTO_ROOT = DATA_ROOT / "photos"
DB_PATH = DATA_ROOT / "photoslive.db"
SETTINGS_PATH = DATA_ROOT / "settings.json"
STARTED_AT = time.time()
STORAGE_CACHE_SECONDS = 60
STORAGE_CACHE: dict[str, Any] = {"createdAt": 0.0, "payload": None}
STORAGE_CACHE_LOCK = threading.Lock()
BOOTH_CLIENTS: dict[str, dict[str, Any]] = {}
BOOTH_CLIENTS_LOCK = threading.Lock()

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
        "cloudEnabled": False,
        "provider": "Cloudflare R2",
        "uploadFinalOnly": True,
        "deleteOnlyAfterUpload": True,
    },
    "devices": {
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
    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(json.dumps(DEFAULT_SETTINGS, indent=2), encoding="utf-8")
    with sqlite3.connect(DB_PATH) as db:
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
              deadline_at TEXT,
              created_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              uploaded_at TEXT
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
            "deadline_at": "TEXT",
        }.items():
            if name not in session_columns:
                db.execute(f"ALTER TABLE photo_sessions ADD COLUMN {name} {definition}")
        voucher_columns = {row[1] for row in db.execute("PRAGMA table_info(vouchers)").fetchall()}
        for name, definition in {
            "event_id": "TEXT",
            "includes_print": "INTEGER NOT NULL DEFAULT 1",
            "created_at": "TEXT",
        }.items():
            if name not in voucher_columns:
                db.execute(f"ALTER TABLE vouchers ADD COLUMN {name} {definition}")
        db.execute("UPDATE vouchers SET created_at = COALESCE(created_at, ?)", (utc_now(),))
        db.execute("CREATE INDEX IF NOT EXISTS idx_vouchers_event ON vouchers(event_id)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_vouchers_active ON vouchers(redeemed_at)")
        today = datetime.now().date().isoformat()
        db.execute("INSERT OR IGNORE INTO daily_usage(day) VALUES (?)", (today,))
        db.commit()


def load_settings() -> dict[str, Any]:
    stored = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    settings = deep_merge(DEFAULT_SETTINGS, stored)
    if settings["appearance"].get("frameFormat") == "polaroid-vertical":
        settings["appearance"]["frameFormat"] = "photo-strip-vertical"
    if settings["devices"].get("printLayout") == "polaroid-vertical":
        settings["devices"]["printLayout"] = "photo-strip-vertical"
    return settings


def deep_merge(base: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in incoming.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def save_settings(incoming: dict[str, Any]) -> dict[str, Any]:
    updated = deep_merge(load_settings(), incoming)
    temp = SETTINGS_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(updated, indent=2), encoding="utf-8")
    temp.replace(SETTINGS_PATH)
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


def active_camera() -> Device | None:
    devices = detect_devices()
    connected = [device for device in devices if device.kind == "camera" and device.status == "connected"]
    if not connected:
        return None
    selected = load_settings()["devices"]["preferredCamera"]
    return next((device for device in connected if device.id == selected), connected[0])


def camera_image(capture: bool = False) -> tuple[bool, bytes, str]:
    camera = active_camera()
    if not camera:
        return False, b"", "Kamera belum tersambung. Webcam USB dan kamera gPhoto2 akan muncul setelah terdeteksi."
    if camera.id.startswith("gphoto-"):
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
    camera_type = "Webcam USB (UVC/V4L2)" if camera.id.startswith("/dev/video") else "Kamera DSLR/mirrorless (gPhoto2/PTP)"
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
    printer_name = printer.id.removeprefix("cups-")
    test_file = build_photo_strip_test_page(settings)
    ok, output = command_output(["lp", "-d", printer_name, str(test_file)], timeout=8)
    return ok, output or ("Lembar tes photo strip masuk antrean printer" if ok else "Gagal mengirim lembar tes photo strip")


def detect_devices() -> list[Device]:
    devices: list[Device] = []

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


def disk_metrics() -> dict[str, Any]:
    usage = shutil.disk_usage(ROOT)
    return {
        "totalBytes": usage.total,
        "usedBytes": usage.used,
        "freeBytes": usage.free,
        "usedPercent": round((usage.used / usage.total) * 100, 1),
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


def photo_library_metrics() -> dict[str, int]:
    files = 0
    total_bytes = 0
    session_folders: set[str] = set()
    pending = [PHOTO_ROOT]
    while pending:
        folder = pending.pop()
        try:
            for entry in os.scandir(folder):
                if entry.is_dir(follow_symlinks=False):
                    pending.append(Path(entry.path))
                    if folder == PHOTO_ROOT:
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
            "disk": disk_metrics(),
            "memory": memory_metrics(),
            "library": photo_library_metrics(),
            "cacheSeconds": STORAGE_CACHE_SECONDS,
            "cached": False,
            "cacheAgeSeconds": 0,
        }
        STORAGE_CACHE["createdAt"] = now
        STORAGE_CACHE["payload"] = payload
        return payload


def recent_photo_sessions(hours: int = 24) -> list[dict[str, Any]]:
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
                    total_bytes += (PHOTO_ROOT / relative_path).stat().st_size
                except OSError:
                    pass
            sessions.append({
                "id": row[0], "shareToken": row[1], "status": row[2], "createdAt": row[3],
                "expiresAt": row[4], "uploadedAt": row[5], "photoCount": row[6],
                "photoSlots": row[7], "selectedPhotoCount": row[8],
                "totalBytes": total_bytes, "shareUrl": f"/session/{row[1]}",
            })
    return sessions


def create_photo_session(frame_id: str | None = None) -> dict[str, Any]:
    session_id = f"SES-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4].upper()}"
    token = uuid.uuid4().hex[:16]
    created_at = datetime.now(timezone.utc)
    settings = load_settings()
    booth = settings["booth"]
    appearance = settings["appearance"]
    devices = settings["devices"]
    if booth["maintenanceMode"]:
        raise ValueError("Photobox sedang dalam mode perawatan")
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
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """INSERT INTO photo_sessions(
                 id, share_token, frame_id, photo_slots, retake_limit, timeout_seconds, strips_per_sheet,
                 print_layout, deadline_at, created_at, expires_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (session_id, token, selected_frame, photo_slots, retake_limit, timeout_seconds, int(devices["stripsPerSheet"]),
             devices["printLayout"], deadline_at.isoformat(), created_at.isoformat(), expires_at.isoformat()),
        )
        db.execute("UPDATE daily_usage SET sessions = sessions + 1 WHERE day = ?", (today,))
        db.commit()
    add_event("session", f"Sesi foto {session_id} dibuat")
    return {
        "id": session_id, "shareToken": token, "frameId": selected_frame, "status": "active", "createdAt": created_at.isoformat(),
        "deadlineAt": deadline_at.isoformat(), "expiresAt": expires_at.isoformat(), "shareUrl": f"/session/{token}",
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
    values = {"pendingUploads": 0, "failedUploads": 0, "pendingPrints": 0}
    for kind, status, count in rows:
        if kind == "upload" and status in {"pending", "processing"}:
            values["pendingUploads"] += count
        if kind == "upload" and status == "failed":
            values["failedUploads"] += count
        if kind == "print" and status in {"pending", "processing"}:
            values["pendingPrints"] += count
    return values


def clear_failed_jobs() -> int:
    with sqlite3.connect(DB_PATH) as db:
        result = db.execute("DELETE FROM jobs WHERE status = 'failed'")
        db.commit()
    add_event("queue", f"{result.rowcount} antrean gagal dibersihkan")
    return result.rowcount


def cleanup_uploaded_photos() -> dict[str, int]:
    settings = load_settings()
    retention = int(settings["booth"]["localRetentionHours"])
    require_upload = bool(settings["storage"]["deleteOnlyAfterUpload"])
    cutoff = time.time() - (retention * 3600)
    deleted = 0
    reclaimed = 0
    with sqlite3.connect(DB_PATH) as db:
        query = "SELECT id, path FROM photo_files WHERE uploaded_at IS NOT NULL" if require_upload else "SELECT id, path FROM photo_files"
        rows = db.execute(query).fetchall()
        for photo_id, relative_path in rows:
            path = PHOTO_ROOT / relative_path
            if path.exists() and path.stat().st_mtime <= cutoff:
                size = path.stat().st_size
                path.unlink()
                db.execute("DELETE FROM photo_files WHERE id = ?", (photo_id,))
                deleted += 1
                reclaimed += size
        db.commit()
    add_event("storage", f"Cleanup selesai: {deleted} file dihapus")
    with STORAGE_CACHE_LOCK:
        STORAGE_CACHE["createdAt"] = 0.0
        STORAGE_CACHE["payload"] = None
    return {"deletedFiles": deleted, "reclaimedBytes": reclaimed}


def register_session_file(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    relative_path = str(payload.get("path") or "").strip().lstrip("/")
    if not relative_path:
        raise ValueError("Path file wajib diisi")
    target = (PHOTO_ROOT / relative_path).resolve()
    if PHOTO_ROOT.resolve() not in target.parents or not target.is_file():
        raise ValueError("File foto tidak ditemukan di penyimpanan lokal")
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
                 id, path, session_id, slot_index, attempt_number, is_selected, file_kind, uploaded_at, created_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (file_id, relative_path, session_id, slot_index, attempt_number, int(selected), "capture", payload.get("uploadedAt"), created_at),
        )
        db.commit()
    with STORAGE_CACHE_LOCK:
        STORAGE_CACHE["createdAt"] = 0.0
        STORAGE_CACHE["payload"] = None
    return {
        "id": file_id, "path": relative_path, "sessionId": session_id, "slotIndex": slot_index,
        "attemptNumber": attempt_number, "selected": selected, "createdAt": created_at,
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
            "SELECT status, photo_slots, deadline_at, strips_per_sheet, print_layout FROM photo_sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        if not session:
            raise ValueError("Sesi foto tidak ditemukan")
        if session[0] != "active":
            raise ValueError("Sesi foto sudah tidak aktif")
        if session[2] and datetime.now(timezone.utc) > datetime.fromisoformat(session[2]):
            db.execute("UPDATE photo_sessions SET status = 'expired' WHERE id = ?", (session_id,))
            db.commit()
            raise ValueError("Batas waktu sesi sudah habis")
        rows = db.execute(
            "SELECT id, path, slot_index FROM photo_files WHERE session_id = ? AND is_selected = 1 AND file_kind = 'capture' ORDER BY slot_index",
            (session_id,),
        ).fetchall()
        selected_slots = {row[2] for row in rows}
        missing = [index for index in range(1, int(session[1]) + 1) if index not in selected_slots]
        if missing:
            raise ValueError(f"Pilih satu foto final untuk slot: {', '.join(map(str, missing))}")
        db.execute("UPDATE photo_sessions SET status = 'completed' WHERE id = ?", (session_id,))
        db.commit()
    add_event("session", f"Sesi foto {session_id} siap dibuat photo strip")
    return {
        "id": session_id, "status": "completed", "photoSlots": int(session[1]),
        "printOutput": {"stripsPerSheet": int(session[3]), "layout": session[4]},
        "compositeInput": [{"fileId": row[0], "path": row[1], "slotIndex": row[2]} for row in rows],
        "nextAction": "compose-and-print",
    }


def booth_config() -> dict[str, Any]:
    settings = load_settings()
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
            "qrisEnabled": bool(settings["payment"]["qrisEnabled"]),
            "voucherEnabled": bool(settings["payment"]["voucherEnabled"]),
            "paidPrintEnabled": bool(settings["payment"].get("paidPrintEnabled", False)),
            "printPrice": int(settings["payment"].get("printPrice", 10000)),
            "price": int(settings["payment"]["price"]),
            "currency": settings["payment"]["currency"],
            "provider": settings["payment"]["provider"],
        },
        "devices": {
            "cameraMirror": bool(settings["devices"]["cameraMirror"]),
            "cameraRotation": str(settings["devices"]["cameraRotation"]),
            "paperSize": settings["devices"]["paperSize"],
            "stripsPerSheet": int(settings["devices"]["stripsPerSheet"]),
        },
        "assets": list_assets(),
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
    session_folder = PHOTO_ROOT / session_id
    session_folder.mkdir(parents=True, exist_ok=True)
    filename = f"slot-{slot_index}-attempt-{attempt_number}-{uuid.uuid4().hex[:6]}.jpg"
    target = session_folder / filename
    target.write_bytes(data)
    file_data = register_session_file(session_id, {
        "path": str(target.relative_to(PHOTO_ROOT)), "slotIndex": slot_index, "attemptNumber": attempt_number,
    })
    with sqlite3.connect(DB_PATH) as db:
        db.execute("UPDATE daily_usage SET photos = photos + 1 WHERE day = ?", (datetime.now().date().isoformat(),))
        db.commit()
    add_event("session", f"Foto browser slot {slot_index} attempt {attempt_number} diambil untuk {session_id}")
    return {**file_data, "url": f"/api/session-files/{file_data['id']}"}


def capture_session_photo(session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
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
    session_folder = PHOTO_ROOT / session_id
    session_folder.mkdir(parents=True, exist_ok=True)
    filename = f"slot-{slot_index}-attempt-{attempt_number}-{uuid.uuid4().hex[:6]}.jpg"
    target = session_folder / filename
    target.write_bytes(data)
    file_data = register_session_file(session_id, {
        "path": str(target.relative_to(PHOTO_ROOT)),
        "slotIndex": slot_index,
        "attemptNumber": attempt_number,
    })
    with sqlite3.connect(DB_PATH) as db:
        db.execute("UPDATE daily_usage SET photos = photos + 1 WHERE day = ?", (datetime.now().date().isoformat(),))
        db.commit()
    add_event("session", f"Foto slot {slot_index} attempt {attempt_number} diambil untuk {session_id}")
    return {**file_data, "url": f"/api/session-files/{file_data['id']}"}


def session_file(file_id: str) -> tuple[bytes, str] | None:
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute("SELECT path FROM photo_files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        return None
    path = (PHOTO_ROOT / row[0]).resolve()
    if PHOTO_ROOT.resolve() not in path.parents or not path.is_file():
        return None
    return path.read_bytes(), "image/jpeg"


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
        existing = db.execute("SELECT id, status FROM jobs WHERE kind = 'print' AND message = ? ORDER BY created_at DESC LIMIT 1", (session_id,)).fetchone()
        if existing:
            return {"id": existing[0], "status": existing[1], "sessionId": session_id}
        job_id = f"PRINT-{uuid.uuid4().hex[:10].upper()}"
        now = utc_now()
        db.execute("INSERT INTO jobs(id, kind, status, message, created_at, updated_at) VALUES (?, 'print', 'pending', ?, ?, ?)", (job_id, session_id, now, now))
        db.commit()
    add_event("print", f"Sesi {session_id} masuk antrean cetak")
    return {"id": job_id, "status": "pending", "sessionId": session_id}


def request_qris_payment(session_id: str, purpose: str = "session") -> dict[str, Any]:
    settings = load_settings()
    payment = settings["payment"]
    is_print = purpose == "print"
    required = payment.get("paidPrintEnabled", False) if is_print else payment.get("qrisEnabled", False)
    if not required:
        return {"required": False, "status": "not-required"}
    if payment["provider"] == "Not configured":
        raise ValueError("QRIS belum dikonfigurasi oleh admin. Pilih provider dan kredensial pembayaran terlebih dahulu.")
    raise ValueError(f"Adapter QRIS {payment['provider']} belum memiliki kredensial aktif pada mesin ini")


def diagnostics() -> dict[str, Any]:
    return {
        "generatedAt": utc_now(),
        "service": {"version": "0.4.0", "uptimeSeconds": int(time.time() - STARTED_AT)},
        "system": {"disk": disk_metrics(), "memory": memory_metrics(), "network": network_metrics()},
        "devices": [asdict(device) for device in detect_devices()],
        "queue": queue_status(),
        "settings": load_settings(),
    }


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
    }


class ApiHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

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

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
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

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/settings":
            return self.send_json(load_settings())
        if path in {"/api/status", "/api/overview"}:
            return self.send_json(system_status())
        if path == "/api/health":
            return self.send_json({"status": "ok", "time": utc_now()})
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
        if path in {"/booth", "/kiosk"}:
            self.path = "/booth.html"
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
        path = urlparse(self.path).path
        if path == "/api/devices/refresh":
            add_event("device", "Pendeteksian perangkat dijalankan")
            return self.send_json({"devices": [asdict(device) for device in detect_devices()]})
        if path in {"/api/actions/test-print", "/api/devices/printer/test"}:
            settings = load_settings()
            printer = settings["devices"]["preferredPrinter"]
            command = ["lpstat", "-p"] if printer == "auto" else ["lpstat", "-p", printer.removeprefix("cups-")]
            ok, output = command_output(command)
            add_event("device", f"Tes koneksi printer: {'berhasil' if ok else 'gagal'}")
            return self.send_json({"ok": ok, "message": output or ("Printer siap" if ok else "Printer tidak tersedia")}, HTTPStatus.OK if ok else HTTPStatus.CONFLICT)
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
            return self.send_json(cleanup_uploaded_photos())
        if path == "/api/booth/sessions":
            try:
                payload = self.read_json()
                return self.send_json({"session": create_photo_session(str(payload.get("frameId") or "").strip() or None)}, HTTPStatus.CREATED)
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
                return self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
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


def main() -> None:
    ensure_data()
    host = os.environ.get("PHOTOSLIVE_HOST", "127.0.0.1")
    port = int(os.environ.get("PHOTOSLIVE_PORT", "8080"))
    server = ThreadingHTTPServer((host, port), ApiHandler)
    signal.signal(signal.SIGTERM, lambda *_: server.shutdown())
    print(f"Photoslive admin ready at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
