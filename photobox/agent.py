#!/usr/bin/env python3
"""Photoslive Agent: secure outbound bridge from a booth computer to Photoslive Cloud."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import platform
import shutil
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


VERSION = "0.6.0"
DEFAULT_CLOUD = "https://photoslive.vercel.app"
DEFAULT_CONTROLLER = "http://127.0.0.1:8080"
CONFIG_DIR = Path(os.environ.get("PHOTOSLIVE_CONFIG_DIR", Path.home() / ".config" / "photoslive"))
CONFIG_PATH = CONFIG_DIR / "agent.json"
STATUS_PATH = CONFIG_DIR / "agent-status.json"
CONTROL_PATH = CONFIG_DIR / "agent-control.json"
LOG_PATH = CONFIG_DIR / "agent.log"
HEARTBEAT_SECONDS = max(30, int(os.environ.get("PHOTOSLIVE_HEARTBEAT_SECONDS", "60")))
JOB_POLL_SECONDS = max(1, int(os.environ.get("PHOTOSLIVE_JOB_POLL_SECONDS", "2")))
STATUS_WRITE_SECONDS = 15
LOG_MAX_BYTES = 512_000


def request_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None, token: str | None = None, timeout: int = 12, extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": f"Photoslive-Agent/{VERSION}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(extra_headers or {})
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read().decode("utf-8")).get("error")
        except (ValueError, AttributeError):
            message = None
        raise RuntimeError(message or f"HTTP {error.code}") from error


def cloud_url(config: dict[str, Any], action: str) -> str:
    return f"{config['cloud'].rstrip('/')}/api/bridge?action={urllib.parse.quote(action)}"


def load_config(cloud: str, controller: str) -> dict[str, Any]:
    if CONFIG_PATH.exists():
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        config.setdefault("cloud", cloud)
        config.setdefault("controller", controller)
        return config
    return {"cloud": cloud, "controller": controller, "name": socket.gethostname() or "Photoslive Booth"}


def save_config(config: dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    temporary = CONFIG_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, indent=2), encoding="utf-8")
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    temporary.replace(CONFIG_PATH)


def save_status(payload: dict[str, Any]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    STATUS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def read_json(path: Path, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return dict(fallback or {})


def control_state() -> dict[str, Any]:
    control = read_json(CONTROL_PATH)
    return {"paused": bool(control.get("paused")), "updatedAt": control.get("updatedAt")}


def log_event(level: str, message: str, **details: Any) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
            backup = LOG_PATH.with_suffix(".log.1")
            backup.unlink(missing_ok=True)
            LOG_PATH.replace(backup)
        record = {"time": time.time(), "level": level, "message": str(message)[:500], **details}
        with LOG_PATH.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        pass


def ensure_pairing(config: dict[str, Any]) -> dict[str, Any]:
    if config.get("machineId") and config.get("agentToken"):
        return config
    token = f"agent_{uuid.uuid4().hex}{uuid.uuid4().hex}"
    response = request_json(
        cloud_url(config, "create_pairing"),
        "POST",
        {
            "name": config.get("name"),
            "platform": platform.platform(),
            "agentVersion": VERSION,
            "agentToken": token,
        },
    )
    config.update({"machineId": response["machineId"], "agentToken": token, "commandKey": response.get("commandKey"), "pairingCode": response["pairingCode"]})
    save_config(config)
    print(f"\nKode pairing Photoslive: {response['pairingCode']}\nBuka {config['cloud']}?view=agent lalu masukkan kode tersebut.\n", flush=True)
    return config


def controller_request(config: dict[str, Any], path: str, method: str = "GET", payload: dict[str, Any] | None = None, protected: bool = False) -> dict[str, Any]:
    headers: dict[str, str] = {}
    if protected:
        token = str(config.get("installationToken") or "")
        if not token:
            installation = request_json(f"{config['controller'].rstrip('/')}/api/local/installation", timeout=5)
            token = str(installation.get("token") or "")
            if not token:
                raise RuntimeError("Controller tidak memberikan token instalasi")
            config["installationToken"] = token
            save_config(config)
        headers["X-Photoslive-Token"] = token
    return request_json(f"{config['controller'].rstrip('/')}{path}", method, payload, timeout=20, extra_headers=headers)


def controller_raw_request(config: dict[str, Any], path: str, method: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = None
    headers = {"Accept": "application/json, image/*, text/html", "User-Agent": f"Photoslive-Agent/{VERSION}"}
    safe_headers = {"content-type", "x-slot-index", "x-filename", "x-client-id"}
    for name, value in (payload.get("headers") or {}).items():
        if str(name).lower() in safe_headers:
            headers[str(name)] = str(value)[:512]
    if payload.get("bodyBase64"):
        body = base64.b64decode(str(payload["bodyBase64"]), validate=True)
    elif isinstance(payload.get("body"), dict):
        body = json.dumps(payload["body"]).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(f"{config['controller'].rstrip('/')}{path}", data=body, headers=headers, method=method)
    try:
        timeout = 310 if path == "/api/storage/pick-folder" else 30
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "application/octet-stream")
            raw = response.read()
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            message = json.loads(raw.decode("utf-8")).get("error")
        except (ValueError, UnicodeDecodeError, AttributeError):
            message = None
        raise RuntimeError(message or f"Controller HTTP {error.code}") from error
    if "application/json" in content_type:
        return json.loads(raw.decode("utf-8") or "{}")
    return {"contentType": content_type, "bodyBase64": base64.b64encode(raw).decode("ascii")}


def memory_metrics() -> dict[str, int]:
    try:
        if os.name == "nt":
            import ctypes

            class MemoryStatus(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("memoryLoad", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("available", ctypes.c_ulonglong)] + [(f"unused{index}", ctypes.c_ulonglong) for index in range(4)]

            status = MemoryStatus()
            status.length = ctypes.sizeof(MemoryStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
            return {"totalBytes": int(status.total), "availableBytes": int(status.available)}
        page = os.sysconf("SC_PAGE_SIZE")
        return {"totalBytes": int(page * os.sysconf("SC_PHYS_PAGES")), "availableBytes": int(page * os.sysconf("SC_AVPHYS_PAGES"))}
    except (AttributeError, OSError, ValueError):
        return {}


def snapshot(config: dict[str, Any]) -> dict[str, Any]:
    disk = shutil.disk_usage(CONFIG_DIR.parent)
    storage: dict[str, Any] = {}
    devices: list[dict[str, Any]] = []
    controller = {"online": False, "url": config["controller"]}
    try:
        health = controller_request(config, "/api/health")
        device_payload = controller_request(config, "/api/devices")
        storage = controller_request(config, "/api/storage/overview")
        devices = device_payload.get("devices", [])
        controller.update({"online": True, "time": health.get("time")})
    except Exception as error:  # the heartbeat must survive a controller restart
        controller["error"] = str(error)
    return {
        "machineId": config["machineId"],
        "agentVersion": VERSION,
        "agentState": "paused" if control_state()["paused"] else "running",
        "platform": platform.platform(),
        "telemetry": {
            "hostname": socket.gethostname(),
            "disk": storage.get("disk") or {"totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
            "memory": storage.get("memory") or memory_metrics(),
            "photoStoragePath": storage.get("localPath"),
        },
        "devices": devices,
        "controller": controller,
        "update": {"status": "idle", "currentVersion": VERSION},
    }


JOB_ROUTES = {
    "devices.refresh": ("/api/devices/refresh", "POST"),
    "camera.test": ("/api/devices/camera/test", "POST"),
    "camera.capture": ("/api/devices/camera/capture", "POST"),
    "printer.test": ("/api/devices/printer/test-page", "POST"),
    "printer.print": ("/api/booth/print", "POST"),
    "storage.cleanup": ("/api/storage/cleanup", "POST"),
    "service.restart": ("/api/system/restart", "POST"),
}


def execute_controller_request(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    path = str(payload.get("path") or "")
    method = str(payload.get("method") or "GET").upper()
    if not path.startswith("/api/") or path.startswith("/api/bridge"):
        raise ValueError("Path controller tidak diizinkan")
    if method not in {"GET", "POST", "PATCH", "PUT", "DELETE"}:
        raise ValueError("Method controller tidak diizinkan")
    return controller_raw_request(config, path, method, payload)


def update_job(config: dict[str, Any], job: dict[str, Any], status: str, result: dict[str, Any] | None = None, error: str | None = None) -> None:
    request_json(
        cloud_url(config, "update_job"),
        "POST",
        {"machineId": config["machineId"], "jobId": job["id"], "status": status, "result": result or {}, "error": error},
        config["agentToken"],
    )


def verify_job_signature(config: dict[str, Any], job: dict[str, Any]) -> bool:
    secret = str(config.get("commandKey") or "")
    supplied = str(job.get("signature") or "")
    if not secret or not supplied:
        return False
    canonical = json.dumps(
        {"id": job.get("id"), "machineId": job.get("machineId"), "type": job.get("type"), "payload": job.get("payload") or {}, "expiresAt": job.get("expiresAt")},
        separators=(",", ":"),
        ensure_ascii=False,
    )
    expected = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, supplied)


def execute_job(config: dict[str, Any], job: dict[str, Any]) -> None:
    if not verify_job_signature(config, job):
        update_job(config, job, "failed", error="Signature command tidak valid")
        log_event("error", "Command ditolak karena signature tidak valid", jobId=job.get("id"))
        return
    if job.get("type") == "controller.request":
        update_job(config, job, "running")
        try:
            update_job(config, job, "completed", result=execute_controller_request(config, job.get("payload") or {}))
        except Exception as error:
            update_job(config, job, "failed", error=str(error))
        return
    route = JOB_ROUTES.get(job.get("type"))
    if not route:
        update_job(config, job, "failed", error="Jenis job tidak didukung Agent ini")
        return
    update_job(config, job, "running")
    try:
        result = controller_request(config, route[0], route[1], job.get("payload") or {})
        update_job(config, job, "completed", result=result)
    except Exception as error:
        update_job(config, job, "failed", error=str(error))


def heartbeat_once(config: dict[str, Any]) -> dict[str, Any]:
    heartbeat = request_json(cloud_url(config, "heartbeat"), "POST", snapshot(config), config["agentToken"])
    if heartbeat.get("commandKey") and config.get("commandKey") != heartbeat["commandKey"]:
        config["commandKey"] = heartbeat["commandKey"]
        save_config(config)
    if heartbeat.get("boothCode") and config.get("boothCode") != heartbeat["boothCode"]:
        config["boothCode"] = heartbeat["boothCode"]
        save_config(config)
    if heartbeat.get("paired") and config.pop("pairingCode", None):
        save_config(config)
        print("Mesin berhasil dipasangkan dengan Photoslive Cloud.", flush=True)
        log_event("info", "Mesin berhasil dipasangkan", boothCode=config.get("boothCode"))
    return heartbeat


def sync_vouchers(config: dict[str, Any], heartbeat: dict[str, Any]) -> None:
    """Keep an offline SQLite voucher cache and replay local redemptions."""
    if not heartbeat.get("paired"):
        return
    try:
        cloud_version = max(0, int(heartbeat.get("voucherVersion") or 0))
        local_version = max(0, int(config.get("voucherVersion") or 0))
        if cloud_version != local_version:
            snapshot = request_json(
                cloud_url(config, "voucher_snapshot"),
                "POST",
                {"machineId": config["machineId"]},
                config["agentToken"],
                timeout=20,
            )
            controller_request(config, "/api/local/vouchers/sync", "POST", snapshot, protected=True)
            config["voucherVersion"] = max(0, int(snapshot.get("version") or cloud_version))
            save_config(config)
            log_event("info", "Cache voucher lokal diperbarui", version=config["voucherVersion"], count=len(snapshot.get("vouchers") or []))
        local = controller_request(config, "/api/local/vouchers/redemptions", protected=True)
        redemptions = local.get("redemptions") if isinstance(local.get("redemptions"), list) else []
        if redemptions:
            result = request_json(
                cloud_url(config, "sync_voucher_redemptions"),
                "POST",
                {"machineId": config["machineId"], "redemptions": redemptions},
                config["agentToken"],
                timeout=20,
            )
            if result.get("updated"):
                log_event("info", "Pemakaian voucher offline disinkronkan", updated=result["updated"])
    except Exception as error:
        # Voucher sync is best-effort. It must never make hardware polling or
        # the local booth unavailable.
        log_event("warning", "Sinkronisasi voucher ditunda", error=str(error))


def sync_settings(config: dict[str, Any], heartbeat: dict[str, Any]) -> None:
    """Pull cloud settings by version without creating one hardware job per save."""
    if not heartbeat.get("paired"):
        return
    try:
        cloud_version = max(0, int(heartbeat.get("settingsVersion") or 0))
        local_version = max(0, int(config.get("settingsVersion") or 0))
        if cloud_version == local_version:
            return
        snapshot = request_json(
            cloud_url(config, "settings_snapshot"),
            "POST",
            {"machineId": config["machineId"]},
            config["agentToken"],
            timeout=20,
        )
        if isinstance(snapshot.get("settings"), dict):
            controller_request(config, "/api/local/settings/sync", "POST", snapshot, protected=True)
        config["settingsVersion"] = max(0, int(snapshot.get("version") or cloud_version))
        save_config(config)
        log_event("info", "Pengaturan cloud diterapkan ke Controller", version=config["settingsVersion"])
    except Exception as error:
        # Configuration sync is asynchronous and never blocks the booth UI.
        log_event("warning", "Sinkronisasi pengaturan ditunda", error=str(error))


def poll_job_once(config: dict[str, Any]) -> bool:
    response = request_json(cloud_url(config, "claim_job"), "POST", {"machineId": config["machineId"]}, config["agentToken"])
    if response.get("job"):
        log_event("info", "Job diterima", jobId=response["job"].get("id"), jobType=response["job"].get("type"))
        execute_job(config, response["job"])
        return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Photoslive hardware bridge")
    parser.add_argument("--cloud", default=os.environ.get("PHOTOSLIVE_CLOUD_URL", DEFAULT_CLOUD))
    parser.add_argument("--controller", default=os.environ.get("PHOTOSLIVE_CONTROLLER_URL", DEFAULT_CONTROLLER))
    parser.add_argument("--once", action="store_true", help="Jalankan satu heartbeat lalu berhenti")
    parser.add_argument("--status", action="store_true", help="Tampilkan konfigurasi/status lokal")
    parser.add_argument("--setup-code", action="store_true", help="Buat kode setup baru untuk mesin yang sudah pernah dipasangkan")
    parser.add_argument("--pause", action="store_true", help="Jeda job cloud tanpa menghentikan heartbeat")
    parser.add_argument("--resume", action="store_true", help="Lanjutkan job cloud")
    arguments = parser.parse_args()
    config = load_config(arguments.cloud, arguments.controller)
    if arguments.pause or arguments.resume:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONTROL_PATH.write_text(json.dumps({"paused": arguments.pause, "updatedAt": time.time()}, indent=2), encoding="utf-8")
        print("Koneksi job Agent dijeda" if arguments.pause else "Koneksi job Agent dilanjutkan", flush=True)
        return 0
    if arguments.setup_code:
        config = ensure_pairing(config)
        response = request_json(cloud_url(config, "create_setup_code"), "POST", {"machineId": config["machineId"]}, config["agentToken"])
        config.update({"pairingCode": response["pairingCode"], "boothCode": response.get("boothCode")})
        save_config(config)
        print(f"Kode setup baru: {response['pairingCode']}\nBerlaku 15 menit. Buka {config['cloud']}/setup", flush=True)
        return 0
    if arguments.status:
        safe_config = {**config}
        for secret in ("agentToken", "installationToken", "commandKey"):
            if safe_config.get(secret):
                safe_config[secret] = "***"
        print(json.dumps({"config": safe_config, "status": json.loads(STATUS_PATH.read_text()) if STATUS_PATH.exists() else {}}, indent=2))
        return 0
    retry = 2
    last_heartbeat = 0.0
    last_job_poll = 0.0
    last_status_write = 0.0
    heartbeat_at: float | None = None
    job_poll_at: float | None = None
    log_event("info", "Agent dimulai", version=VERSION, heartbeatSeconds=HEARTBEAT_SECONDS)
    while True:
        try:
            config = ensure_pairing(config)
            current = time.monotonic()
            paused = control_state()["paused"]
            worked = False
            if not last_heartbeat or current - last_heartbeat >= HEARTBEAT_SECONDS:
                heartbeat = heartbeat_once(config)
                sync_settings(config, heartbeat)
                sync_vouchers(config, heartbeat)
                last_heartbeat = current
                heartbeat_at = time.time()
            if not paused and (not last_job_poll or current - last_job_poll >= JOB_POLL_SECONDS):
                worked = poll_job_once(config)
                last_job_poll = current
                job_poll_at = time.time()
            if not last_status_write or current - last_status_write >= STATUS_WRITE_SECONDS or worked:
                status = {
                    "online": True,
                    "paused": paused,
                    "version": VERSION,
                    "machineId": config["machineId"],
                    "pairingCode": config.get("pairingCode"),
                    "updatedAt": time.time(),
                    "lastHeartbeatAt": heartbeat_at,
                    "lastJobPollAt": job_poll_at,
                    "error": None,
                }
                save_status(status)
                last_status_write = current
            retry = 2
            if arguments.once:
                return 0
            time.sleep(0.5 if worked else 1)
        except KeyboardInterrupt:
            return 0
        except Exception as error:
            save_status({"online": False, "version": VERSION, "machineId": config.get("machineId"), "pairingCode": config.get("pairingCode"), "updatedAt": time.time(), "lastHeartbeatAt": heartbeat_at, "lastJobPollAt": job_poll_at, "error": str(error)})
            log_event("error", str(error), retrySeconds=retry)
            print(f"Photoslive Agent: {error}; mencoba lagi dalam {retry} detik", file=sys.stderr, flush=True)
            if arguments.once:
                return 1
            time.sleep(retry)
            retry = min(retry * 2, 60)


if __name__ == "__main__":
    raise SystemExit(main())
