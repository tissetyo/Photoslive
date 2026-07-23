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
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from redaction import redact_log_value, redact_text


VERSION = "0.9.0"
PROTOCOL_VERSION = 2
DEFAULT_CLOUD = "https://photoslive.vercel.app"
DEFAULT_CONTROLLER = "http://127.0.0.1:8080"
CONFIG_DIR = Path(os.environ.get("PHOTOSLIVE_CONFIG_DIR", Path.home() / ".config" / "photoslive"))
CONFIG_PATH = CONFIG_DIR / "agent.json"
STATUS_PATH = CONFIG_DIR / "agent-status.json"
CONTROL_PATH = CONFIG_DIR / "agent-control.json"
LOG_PATH = CONFIG_DIR / "agent.log"
HEARTBEAT_SECONDS = max(60, int(os.environ.get("PHOTOSLIVE_HEARTBEAT_SECONDS", "300")))
JOB_POLL_SECONDS = max(10, int(os.environ.get("PHOTOSLIVE_JOB_POLL_SECONDS", "60")))
STATUS_WRITE_SECONDS = 15
LOG_MAX_BYTES = 512_000
MAX_CLOUD_RETRY_SECONDS = max(300, int(os.environ.get("PHOTOSLIVE_MAX_CLOUD_RETRY_SECONDS", "1800")))


class CloudRequestError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None, retry_after: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.retry_after = retry_after
        self.code = code


def request_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None, token: str | None = None, timeout: int = 12, extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {
        "Accept": "application/json",
        "User-Agent": f"Photoslive-Agent/{VERSION}",
        "X-Correlation-ID": f"agent-{uuid.uuid4().hex}",
        "X-Photoslive-Protocol-Version": str(PROTOCOL_VERSION),
    }
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
        retry_after: int | None = None
        try:
            retry_after = int(str(error.headers.get("retry-after") or "").strip())
        except (TypeError, ValueError):
            retry_after = None
        try:
            detail = json.loads(error.read().decode("utf-8"))
            message = detail.get("error")
            code = detail.get("code")
            retry_after = int(detail.get("retryAfterSeconds") or retry_after or 0) or retry_after
        except (ValueError, AttributeError):
            message = None
            code = None
        raise CloudRequestError(message or f"HTTP {error.code}", status_code=error.code, retry_after=retry_after, code=code) from error


def upload_presigned_file(url: str, raw: bytes, headers: dict[str, Any] | None = None, timeout: int = 120) -> str:
    """Upload bytes to one short-lived object URL without logging its bearer signature."""
    allowed = {"content-type", "content-md5", "x-amz-meta-sha256", "x-amz-security-token"}
    upload_headers = {str(name): str(value) for name, value in (headers or {}).items() if str(name).lower() in allowed}
    upload_headers["Content-Length"] = str(len(raw))
    upload_headers["User-Agent"] = f"Photoslive-Agent/{VERSION}"
    request = urllib.request.Request(url, data=raw, headers=upload_headers, method="PUT")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"Object storage HTTP {response.status}")
            return str(response.headers.get("ETag") or "").strip()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Upload object storage gagal (HTTP {error.code})") from error


def cloud_url(config: dict[str, Any], action: str) -> str:
    return f"{config['cloud'].rstrip('/')}/api/bridge?action={urllib.parse.quote(action)}"


def setup_url(config: dict[str, Any], pairing_code: str) -> str:
    query = urllib.parse.urlencode({"code": pairing_code})
    return f"{str(config['cloud']).rstrip('/')}/setup?{query}"


def open_setup_page(url: str) -> bool:
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception as error:
        log_event("warning", "Browser setup tidak dapat dibuka otomatis", error=str(error))
        return False


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
        record = {"time": time.time(), "level": level, "message": redact_text(message, 500), **redact_log_value(details)}
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


def backup_telemetry(config: dict[str, Any]) -> dict[str, Any]:
    try:
        payload = controller_request(config, "/api/local/backups", protected=True)
        backups = payload.get("backups") if isinstance(payload.get("backups"), list) else []
        latest = backups[0] if backups and isinstance(backups[0], dict) else {}
        database = payload.get("database") if isinstance(payload.get("database"), dict) else {}
        restore = payload.get("restore") if isinstance(payload.get("restore"), dict) else {}
        return {
            "status": "ready" if backups else "missing",
            "count": min(len(backups), 999),
            "latestAt": str(latest.get("createdAt") or "")[:64] or None,
            "latestReason": str(latest.get("reason") or "")[:32] or None,
            "latestSchemaVersion": max(0, int(latest.get("schemaVersion") or 0)),
            "latestSizeBytes": max(0, int(latest.get("sizeBytes") or 0)),
            "databaseStatus": str(database.get("status") or "unknown")[:40],
            "restoreStatus": str(restore.get("status") or "never")[:40],
            "restoreAt": str(restore.get("updatedAt") or "")[:64] or None,
        }
    except (RuntimeError, OSError, ValueError, TypeError):
        return {
            "status": "unavailable", "count": 0, "latestAt": None, "latestReason": None,
            "latestSchemaVersion": 0, "latestSizeBytes": 0, "databaseStatus": "unknown",
            "restoreStatus": "unknown", "restoreAt": None,
        }


def snapshot(config: dict[str, Any]) -> dict[str, Any]:
    disk = shutil.disk_usage(CONFIG_DIR.parent)
    storage: dict[str, Any] = {}
    devices: list[dict[str, Any]] = []
    sync_jobs: list[dict[str, Any]] = []
    print_jobs: list[dict[str, Any]] = []
    recovery: dict[str, Any] = {"sessions": []}
    local_status: dict[str, Any] = {}
    controller = {"online": False, "url": config["controller"]}
    update = {"state": "unavailable", "currentVersion": VERSION, "message": "Controller tidak tersambung"}
    try:
        health = controller_request(config, "/api/health")
        device_payload = controller_request(config, "/api/devices")
        storage = controller_request(config, "/api/storage/overview")
        local_status = controller_request(config, "/api/local/agent/status")
        sync_jobs = controller_request(config, "/api/local/sync/jobs?limit=10", protected=True).get("jobs", [])
        print_jobs = controller_request(config, "/api/local/print/jobs?limit=10", protected=True).get("jobs", [])
        recovery = controller_request(config, "/api/local/session-recovery?limit=10", protected=True)
        devices = device_payload.get("devices", [])
        controller.update({"online": True, "time": health.get("time")})
        if isinstance(local_status.get("update"), dict):
            update = local_status["update"]
    except Exception as error:  # the heartbeat must survive a controller restart
        controller["error"] = str(error)
    return {
        "machineId": config["machineId"],
        "agentVersion": VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "agentState": "paused" if control_state()["paused"] else "running",
        "platform": platform.platform(),
        "telemetry": {
            "hostname": socket.gethostname(),
            "disk": storage.get("disk") or {"totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
            "memory": storage.get("memory") or memory_metrics(),
            "photoStoragePath": storage.get("localPath"),
            "backup": backup_telemetry(config) if controller.get("online") else {
                "status": "unavailable", "count": 0, "latestAt": None, "latestReason": None,
                "latestSchemaVersion": 0, "latestSizeBytes": 0, "databaseStatus": "unknown",
                "restoreStatus": "unknown", "restoreAt": None,
            },
        },
        "devices": devices,
        "controller": controller,
        "update": update,
        "sync": local_status.get("sync") if isinstance(local_status.get("sync"), dict) else {},
        "queue": local_status.get("queue") if isinstance(local_status.get("queue"), dict) else {},
        "syncJobs": sync_jobs[:10],
        "printJobs": print_jobs[:10],
        "sessionRecovery": {"sessions": list(recovery.get("sessions") or [])[:10], "measuredAt": recovery.get("measuredAt")},
    }


JOB_ROUTES = {
    "devices.refresh": ("/api/devices/refresh", "POST", False),
    "camera.test": ("/api/devices/camera/test", "POST", False),
    "camera.capture": ("/api/devices/camera/capture", "POST", False),
    "printer.test": ("/api/devices/printer/test-page", "POST", False),
    "printer.print": ("/api/booth/print", "POST", False),
    "storage.cleanup": ("/api/storage/cleanup", "POST", False),
    "service.restart": ("/api/system/restart", "POST", False),
    "agent.update.check": ("/api/local/agent/update/check", "POST", True),
    "agent.update.apply": ("/api/local/agent/update/apply", "POST", True),
    "agent.update.rollback": ("/api/local/agent/update/rollback", "POST", True),
    "sync.retry": ("/api/local/sync/retry", "POST", True),
    "sync.retry_job": ("/api/local/sync/retry-job", "POST", True),
    "print.retry_job": ("/api/local/print/retry-job", "POST", True),
    "session.recover": ("/api/local/session-recovery/recover", "POST", True),
}

JOB_FIXED_PAYLOADS = {"agent.update.rollback": {"confirmation": "ROLLBACK"}}


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


def validate_job(config: dict[str, Any], job: dict[str, Any], now_timestamp: float | None = None) -> str | None:
    """Return a safe operator-facing rejection reason, or None for an authorized job."""
    if not verify_job_signature(config, job):
        return "Signature command tidak valid"
    if str(job.get("machineId") or "") != str(config.get("machineId") or ""):
        return "Command ditujukan ke mesin lain"
    expires_at = str(job.get("expiresAt") or "")
    if not expires_at:
        return "Command tidak memiliki masa berlaku"
    try:
        expires_timestamp = datetime.fromisoformat(expires_at.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    except (TypeError, ValueError, OverflowError):
        return "Masa berlaku command tidak valid"
    if expires_timestamp <= (time.time() if now_timestamp is None else now_timestamp):
        return "Command sudah kedaluwarsa"
    return None


def execute_job(config: dict[str, Any], job: dict[str, Any]) -> None:
    rejection = validate_job(config, job)
    if rejection:
        # A command for another machine must never be acknowledged with this
        # installation's credential. Same-machine validation failures can be
        # reported so the Cloud job does not remain stuck in "claimed".
        if str(job.get("machineId") or "") == str(config.get("machineId") or ""):
            update_job(config, job, "failed", error=rejection)
        log_event("error", "Command ditolak Agent", jobId=job.get("id"), reason=rejection)
        return
    if job.get("type") == "controller.request":
        update_job(config, job, "running")
        try:
            update_job(config, job, "completed", result=execute_controller_request(config, job.get("payload") or {}))
        except Exception as error:
            update_job(config, job, "failed", error=str(error))
        return
    if job.get("type") == "privacy.delete_session":
        update_job(config, job, "running")
        try:
            share_code = urllib.parse.quote(str((job.get("payload") or {}).get("shareCode") or ""), safe="")
            if not share_code:
                raise ValueError("Kode sesi penghapusan kosong")
            result = controller_request(config, f"/api/local/privacy/sessions/{share_code}", "POST", {}, protected=True)
            update_job(config, job, "completed", result=result)
        except Exception as error:
            update_job(config, job, "failed", error=str(error))
        return
    route = JOB_ROUTES.get(job.get("type"))
    if not route:
        update_job(config, job, "failed", error="Jenis job tidak didukung Agent ini")
        return
    update_job(config, job, "running")
    try:
        payload = JOB_FIXED_PAYLOADS.get(str(job.get("type")), job.get("payload") or {})
        result = controller_request(config, route[0], route[1], payload, protected=True) if route[2] else controller_request(config, route[0], route[1], payload)
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


def refresh_offline_policy(config: dict[str, Any], heartbeat: dict[str, Any]) -> None:
    """Grant the local Controller a bounded lease after a real cloud heartbeat."""
    policy = heartbeat.get("offlinePolicy") if isinstance(heartbeat.get("offlinePolicy"), dict) else {}
    try:
        controller_request(
            config,
            "/api/local/offline-policy/refresh",
            "POST",
            {
                "serverTime": heartbeat.get("serverTime"),
                "accessEnabled": bool(policy.get("accessEnabled", heartbeat.get("accessEnabled", True))),
                "qrisAllowed": bool(policy.get("qrisAllowed", True)),
            },
            protected=True,
        )
    except Exception as error:
        # A Controller restart must not turn a successful cloud heartbeat into
        # an Agent outage. The next heartbeat refreshes the lease again.
        log_event("warning", "Lease offline belum diterapkan ke Controller", error=str(error))


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


def sync_local_outbox_once(config: dict[str, Any]) -> bool:
    """Drain one durable Controller outbox job without involving the booth UI."""
    claimed = controller_request(config, "/api/local/sync/claim", protected=True)
    job = claimed.get("job")
    if not isinstance(job, dict):
        return False
    job_id = str(job.get("id") or "")
    try:
        if job.get("kind") != "session.sync":
            raise RuntimeError(f"Jenis sync job tidak didukung: {job.get('kind')}")
        payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
        session = payload.get("session") if isinstance(payload.get("session"), dict) else {}
        request_json(
            cloud_url(config, "sync_session_metadata"),
            "POST",
            {"machineId": config["machineId"], "session": session},
            config["agentToken"],
            timeout=20,
        )
        progress = job.get("progress") if isinstance(job.get("progress"), dict) else {}
        completed_file_ids = {str(value) for value in progress.get("completedFileIds", []) if value}
        multipart_progress = progress.get("multipart") if isinstance(progress.get("multipart"), dict) else {}
        for file in payload.get("files") if isinstance(payload.get("files"), list) else []:
            if not isinstance(file, dict):
                continue
            file_id = str(file.get("id") or "")
            if file_id and file_id in completed_file_ids:
                continue
            local = controller_raw_request(config, f"/api/session-files/{urllib.parse.quote(str(file.get('id') or ''))}", "GET", {})
            raw = base64.b64decode(str(local.get("bodyBase64") or ""), validate=True)
            file_payload = {
                "machineId": config["machineId"],
                "shareCode": session.get("shareCode"),
                "fileId": file.get("id"),
                "slotIndex": file.get("slotIndex"),
                "fileKind": file.get("fileKind") or "capture",
                "contentType": local.get("contentType") or file.get("contentType") or "image/jpeg",
                "checksumSha256": file.get("checksumSha256") or hashlib.sha256(raw).hexdigest(),
                "contentMd5": base64.b64encode(hashlib.md5(raw).digest()).decode("ascii"),
                "size": len(raw),
            }
            prior_multipart = multipart_progress.get(file_id) if isinstance(multipart_progress.get(file_id), dict) else {}
            if prior_multipart.get("uploadId"):
                file_payload["resumeUploadId"] = str(prior_multipart["uploadId"])
            try:
                prepared = request_json(cloud_url(config, "prepare_session_file"), "POST", file_payload, config["agentToken"], timeout=20)
            except RuntimeError as error:
                if "Endpoint tidak ditemukan" not in str(error):
                    raise
                prepared = {"mode": "legacy-redis"}
            if prepared.get("mode") == "direct-object-storage":
                upload = prepared.get("upload") if isinstance(prepared.get("upload"), dict) else {}
                upload_presigned_file(str(upload.get("url") or ""), raw, upload.get("headers"), timeout=120)
                request_json(
                    cloud_url(config, "finalize_session_file"),
                    "POST",
                    {"machineId": config["machineId"], "uploadId": prepared.get("uploadId")},
                    config["agentToken"],
                    timeout=30,
                )
            elif prepared.get("mode") == "multipart-object-storage":
                upload_id = str(prepared.get("uploadId") or "")
                part_size = int(prepared.get("partSize") or 0)
                total_parts = int(prepared.get("totalParts") or 0)
                if not upload_id or part_size < 5 * 1024 * 1024 or total_parts != (len(raw) + part_size - 1) // part_size:
                    raise RuntimeError("Kontrak multipart cloud tidak valid")
                completed_parts = {}
                if prior_multipart.get("uploadId") == upload_id:
                    completed_parts = {
                        int(part.get("partNumber")): str(part.get("etag") or "")
                        for part in prior_multipart.get("completedParts", [])
                        if isinstance(part, dict) and int(part.get("partNumber") or 0) > 0 and part.get("etag")
                    }
                for part_number in range(1, total_parts + 1):
                    if completed_parts.get(part_number):
                        continue
                    start = (part_number - 1) * part_size
                    chunk = raw[start:start + part_size]
                    part = request_json(
                        cloud_url(config, "prepare_session_file_part"),
                        "POST",
                        {"machineId": config["machineId"], "uploadId": upload_id, "partNumber": part_number},
                        config["agentToken"],
                        timeout=20,
                    )
                    upload = part.get("upload") if isinstance(part.get("upload"), dict) else {}
                    etag = upload_presigned_file(str(upload.get("url") or ""), chunk, upload.get("headers"), timeout=120)
                    if not etag:
                        raise RuntimeError(f"Object storage tidak mengembalikan ETag untuk part {part_number}")
                    completed_parts[part_number] = etag
                    checkpoint = controller_request(
                        config,
                        "/api/local/sync/multipart",
                        "POST",
                        {
                            "jobId": job_id,
                            "fileId": file_id,
                            "uploadId": upload_id,
                            "partNumber": part_number,
                            "etag": etag,
                            "partSize": part_size,
                            "totalSize": len(raw),
                        },
                        protected=True,
                    )
                    checkpoint_progress = checkpoint.get("checkpoint", {}).get("progress", {}) if isinstance(checkpoint.get("checkpoint"), dict) else {}
                    if isinstance(checkpoint_progress.get("multipart"), dict):
                        multipart_progress = checkpoint_progress["multipart"]
                request_json(
                    cloud_url(config, "complete_session_file_multipart"),
                    "POST",
                    {
                        "machineId": config["machineId"],
                        "uploadId": upload_id,
                        "parts": [{"partNumber": number, "etag": completed_parts[number]} for number in sorted(completed_parts)],
                    },
                    config["agentToken"],
                    timeout=60,
                )
            else:
                request_json(
                    cloud_url(config, "sync_session_file"),
                    "POST",
                    {**file_payload, "bodyBase64": local.get("bodyBase64")},
                    config["agentToken"],
                    timeout=30,
                )
            if file_id:
                try:
                    controller_request(
                        config,
                        "/api/local/sync/progress",
                        "POST",
                        {"jobId": job_id, "fileId": file_id},
                        protected=True,
                    )
                except RuntimeError as checkpoint_error:
                    if "Endpoint tidak ditemukan" not in str(checkpoint_error):
                        raise
                    log_event("warning", "Controller lama tidak mendukung checkpoint upload", jobId=job_id)
        # Commit metadata once more after every object has been finalized. The
        # cloud preserves its private object manifest in the cached session;
        # this second checkpoint makes that manifest durable before the local
        # outbox is acknowledged.
        request_json(
            cloud_url(config, "sync_session_metadata"),
            "POST",
            {"machineId": config["machineId"], "session": session},
            config["agentToken"],
            timeout=20,
        )
        controller_request(config, "/api/local/sync/complete", "POST", {"jobId": job_id}, protected=True)
        log_event("info", "Sesi lokal tersinkron ke cloud", jobId=job_id, sessionId=session.get("id"))
    except Exception as error:
        try:
            controller_request(config, "/api/local/sync/fail", "POST", {"jobId": job_id, "error": str(error)}, protected=True)
        except Exception as report_error:
            log_event("error", "Status sync gagal disimpan ke Controller", jobId=job_id, error=str(report_error))
        log_event("warning", "Sinkronisasi sesi ditunda", jobId=job_id, error=str(error))
    return True


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
    parser.add_argument("--open-setup", action="store_true", help="Buka halaman setup setelah kode berhasil dibuat")
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
        url = setup_url(config, response["pairingCode"])
        print(f"Kode setup baru: {response['pairingCode']}\nBerlaku 15 menit. Buka {url}", flush=True)
        if arguments.open_setup and not open_setup_page(url):
            print("Browser tidak dapat dibuka otomatis. Salin URL di atas.", flush=True)
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
                desired_state = str(heartbeat.get("desiredState") or "running")
                desired_paused = desired_state == "paused"
                if desired_paused != paused:
                    CONTROL_PATH.parent.mkdir(parents=True, exist_ok=True)
                    CONTROL_PATH.write_text(json.dumps({"paused": desired_paused, "updatedAt": time.time()}, indent=2), encoding="utf-8")
                refresh_offline_policy(config, heartbeat)
                sync_settings(config, heartbeat)
                sync_vouchers(config, heartbeat)
                last_heartbeat = current
                heartbeat_at = time.time()
            if not paused and (not last_job_poll or current - last_job_poll >= JOB_POLL_SECONDS):
                worked = poll_job_once(config)
                worked = sync_local_outbox_once(config) or worked
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
            cloud_retry = getattr(error, "retry_after", None)
            retry_seconds = min(MAX_CLOUD_RETRY_SECONDS, max(retry, int(cloud_retry or 0))) if cloud_retry else retry
            log_event("error", str(error), retrySeconds=retry_seconds, statusCode=getattr(error, "status_code", None), code=getattr(error, "code", None))
            print(f"Photoslive Agent: {error}; mencoba lagi dalam {retry_seconds} detik", file=sys.stderr, flush=True)
            if arguments.once:
                return 1
            time.sleep(retry_seconds)
            retry = min(retry * 2, 60)


if __name__ == "__main__":
    raise SystemExit(main())
