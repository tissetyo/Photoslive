#!/usr/bin/env python3
"""Reproducible synthetic Controller benchmark; never writes production data."""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path
from unittest import mock

PHOTOBOX_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PHOTOBOX_ROOT))

import server  # noqa: E402


def duration_ms(operation):
    started = time.perf_counter()
    result = operation()
    return (time.perf_counter() - started) * 1000, result


def summarize(samples: list[float]) -> dict:
    ordered = sorted(samples)
    p95_index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * 0.95) - 1))
    return {
        "samples": len(samples),
        "minMs": round(ordered[0], 2),
        "medianMs": round(statistics.median(ordered), 2),
        "p95Ms": round(ordered[p95_index], 2),
        "maxMs": round(ordered[-1], 2),
    }


def jpeg_bytes(color: str, size=(640, 640)) -> bytes:
    if server.Image is None:
        raise RuntimeError("Pillow wajib tersedia untuk benchmark render")
    stream = BytesIO()
    server.Image.new("RGB", size, color).save(stream, "JPEG", quality=88)
    return stream.getvalue()


def configure_temporary_data(root: Path) -> None:
    server.DATA_ROOT = root
    server.UPLOAD_ROOT = root / "uploads"
    server.PHOTO_ROOT = root / "photos"
    server.DB_PATH = root / "photoslive.db"
    server.SETTINGS_PATH = root / "settings.json"
    server.LOCAL_TOKEN_PATH = root / ".installation-token"
    server.STORAGE_CACHE["createdAt"] = 0.0
    server.STORAGE_CACHE["payload"] = None


def run(iterations: int) -> dict:
    timings: dict[str, list[float]] = {name: [] for name in ("saveSettings", "generate100Vouchers", "startSession", "captureUpload", "completeRender", "enqueuePrint")}
    synthetic_disk = {
        "PHOTOSLIVE_TEST_MODE": "1",
        "PHOTOSLIVE_TEST_DISK_TOTAL_BYTES": str(16 * 1024**3),
        "PHOTOSLIVE_TEST_DISK_FREE_BYTES": str(4 * 1024**3),
    }
    with mock.patch.dict(os.environ, synthetic_disk, clear=False), tempfile.TemporaryDirectory(prefix="photoslive-benchmark-") as folder:
        root = Path(folder)
        configure_temporary_data(root)
        startup_ms, _ = duration_ms(server.ensure_data)

        for index in range(iterations):
            elapsed, _ = duration_ms(lambda index=index: server.save_settings({"booth": {"name": f"Benchmark {index}"}}))
            timings["saveSettings"].append(elapsed)

        for _ in range(max(1, min(3, iterations))):
            elapsed, _ = duration_ms(lambda: server.generate_vouchers({"count": 100}))
            timings["generate100Vouchers"].append(elapsed)

        colors = ["#6d5dfc", "#1a8f75", "#d84747"]
        for _ in range(iterations):
            elapsed, session = duration_ms(lambda: server.create_photo_session("clean-white"))
            timings["startSession"].append(elapsed)
            for slot, color in enumerate(colors, 1):
                elapsed, capture = duration_ms(lambda slot=slot, color=color: server.capture_session_upload(session["id"], slot, jpeg_bytes(color)))
                timings["captureUpload"].append(elapsed)
                server.select_session_file(session["id"], {"fileId": capture["id"]})
            elapsed, _ = duration_ms(lambda: server.complete_photo_session(session["id"]))
            timings["completeRender"].append(elapsed)
            elapsed, _ = duration_ms(lambda: server.queue_session_print(session["id"]))
            timings["enqueuePrint"].append(elapsed)

        output_bytes = sum(path.stat().st_size for path in server.photo_root().rglob("*") if path.is_file())

    targets = {
        "saveSettings": 1000,
        "generate100Vouchers": 2000,
        "startSession": 200,
        "completeRender": 3000,
        "enqueuePrint": 1000,
    }
    metrics = {name: summarize(samples) for name, samples in timings.items()}
    return {
        "schemaVersion": 1,
        "kind": "synthetic-local-controller",
        "productionAcceptance": False,
        "generatedAt": server.utc_now(),
        "host": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "cpu": server.cpu_metrics(),
            "memory": server.memory_metrics(),
        },
        "iterations": iterations,
        "startupMs": round(startup_ms, 2),
        "metrics": metrics,
        "targetsMs": targets,
        "targetChecks": {name: metrics[name]["p95Ms"] <= limit for name, limit in targets.items()},
        "outputBytes": output_bytes,
        "unmeasured": ["real-camera-capture", "physical-print", "cloud-network-p95", "4gb-72-hour-soak"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Benchmark sintetis Photoslive Local Controller")
    parser.add_argument("--iterations", type=int, default=5)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--enforce-targets", action="store_true")
    args = parser.parse_args()
    report = run(max(1, min(50, args.iterations)))
    payload = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")
    print(payload)
    return 1 if args.enforce_targets and not all(report["targetChecks"].values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
