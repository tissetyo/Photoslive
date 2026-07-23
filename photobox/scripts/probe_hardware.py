#!/usr/bin/env python3
"""Produce a redacted Photoslive hardware probe without changing configuration."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from pathlib import Path

PHOTOBOX_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PHOTOBOX_ROOT))

import server  # noqa: E402


def probe() -> dict:
    devices = [server.asdict(device) for device in server.detect_devices()]
    return {
        "schemaVersion": 1,
        "controllerVersion": server.SERVICE_VERSION,
        "platform": {
            "system": platform.system().lower(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "system": {
            "cpu": server.cpu_metrics(),
            "memory": server.memory_metrics(),
            "disk": server.disk_metrics(server.photo_root()),
        },
        "storage": {
            "path": str(server.photo_root()),
            "writable": server.photo_root().is_dir() and os.access(server.photo_root(), os.W_OK),
            "safety": server.storage_safety(server.photo_root()),
        },
        "devices": devices,
        "summary": {
            "connectedCameras": sum(item["kind"] == "camera" and item["status"] == "connected" for item in devices),
            "connectedPrinters": sum(item["kind"] == "printer" and item["status"] == "connected" for item in devices),
        },
        "notice": "Probe ini hanya mendeteksi capability. Status compatible memerlukan acceptance test perangkat nyata.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Periksa hardware Photoslive tanpa mengubah setting")
    parser.add_argument("--output", type=Path, help="Simpan laporan JSON ke file")
    args = parser.parse_args()
    payload = json.dumps(probe(), indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
