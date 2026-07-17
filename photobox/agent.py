#!/usr/bin/env python3
"""Photoslive Agent: secure outbound bridge from a booth computer to Photoslive Cloud."""

from __future__ import annotations

import argparse
import base64
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


VERSION = "0.4.0"
DEFAULT_CLOUD = "https://photoslive.vercel.app"
DEFAULT_CONTROLLER = "http://127.0.0.1:8080"
CONFIG_DIR = Path(os.environ.get("PHOTOSLIVE_CONFIG_DIR", Path.home() / ".config" / "photoslive"))
CONFIG_PATH = CONFIG_DIR / "agent.json"
STATUS_PATH = CONFIG_DIR / "agent-status.json"


def request_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None, token: str | None = None, timeout: int = 12) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json", "User-Agent": f"Photoslive-Agent/{VERSION}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
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
    config.update({"machineId": response["machineId"], "agentToken": token, "pairingCode": response["pairingCode"]})
    save_config(config)
    print(f"\nKode pairing Photoslive: {response['pairingCode']}\nBuka {config['cloud']}?view=agent lalu masukkan kode tersebut.\n", flush=True)
    return config


def controller_request(config: dict[str, Any], path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return request_json(f"{config['controller'].rstrip('/')}{path}", method, payload, timeout=20)


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
        with urllib.request.urlopen(request, timeout=30) as response:
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
        "platform": platform.platform(),
        "telemetry": {
            "hostname": socket.gethostname(),
            "disk": storage.get("disk") or {"totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
            "memory": storage.get("memory") or memory_metrics(),
            "photoStoragePath": storage.get("localPath"),
        },
        "devices": devices,
        "controller": controller,
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


def execute_job(config: dict[str, Any], job: dict[str, Any]) -> None:
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


def cycle(config: dict[str, Any]) -> bool:
    heartbeat = request_json(cloud_url(config, "heartbeat"), "POST", snapshot(config), config["agentToken"])
    if heartbeat.get("boothCode") and config.get("boothCode") != heartbeat["boothCode"]:
        config["boothCode"] = heartbeat["boothCode"]
        save_config(config)
    if heartbeat.get("paired") and config.pop("pairingCode", None):
        save_config(config)
        print("Mesin berhasil dipasangkan dengan Photoslive Cloud.", flush=True)
    response = request_json(cloud_url(config, "claim_job"), "POST", {"machineId": config["machineId"]}, config["agentToken"])
    if response.get("job"):
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
    arguments = parser.parse_args()
    config = load_config(arguments.cloud, arguments.controller)
    if arguments.setup_code:
        config = ensure_pairing(config)
        response = request_json(cloud_url(config, "create_setup_code"), "POST", {"machineId": config["machineId"]}, config["agentToken"])
        config.update({"pairingCode": response["pairingCode"], "boothCode": response.get("boothCode")})
        save_config(config)
        print(f"Kode setup baru: {response['pairingCode']}\nBerlaku 15 menit. Buka {config['cloud']}/setup", flush=True)
        return 0
    if arguments.status:
        print(json.dumps({"config": {**config, "agentToken": "***" if config.get("agentToken") else None}, "status": json.loads(STATUS_PATH.read_text()) if STATUS_PATH.exists() else {}}, indent=2))
        return 0
    retry = 2
    while True:
        try:
            config = ensure_pairing(config)
            worked = cycle(config)
            status = {"online": True, "machineId": config["machineId"], "pairingCode": config.get("pairingCode"), "updatedAt": time.time(), "error": None}
            save_status(status)
            retry = 2
            if arguments.once:
                return 0
            time.sleep(1 if worked else 5)
        except KeyboardInterrupt:
            return 0
        except Exception as error:
            save_status({"online": False, "machineId": config.get("machineId"), "pairingCode": config.get("pairingCode"), "updatedAt": time.time(), "error": str(error)})
            print(f"Photoslive Agent: {error}; mencoba lagi dalam {retry} detik", file=sys.stderr, flush=True)
            if arguments.once:
                return 1
            time.sleep(retry)
            retry = min(retry * 2, 60)


if __name__ == "__main__":
    raise SystemExit(main())
