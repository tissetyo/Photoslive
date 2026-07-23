import base64
import hashlib
import hmac
import http.cookiejar
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import time
import tracemalloc
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from io import BytesIO
from unittest import mock
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request

from PIL import Image as PILImage

import sys

PHOTOBOX_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PHOTOBOX_ROOT))

import agent  # noqa: E402
import redaction  # noqa: E402
import server  # noqa: E402


class LocalFirstTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        server.DATA_ROOT = root
        server.PHOTO_ROOT = root / "photos"
        server.DB_PATH = root / "photoslive.db"
        server.SETTINGS_PATH = root / "settings.json"
        server.LOCAL_TOKEN_PATH = root / ".installation-token"
        server.ensure_data()

    def tearDown(self):
        self.temp.cleanup()

    def jpeg_bytes(self, color="#6d5dfc", size=(640, 640)):
        stream = BytesIO()
        PILImage.new("RGB", size, color).save(stream, "JPEG", quality=90)
        return stream.getvalue()

    def test_shared_log_redaction_removes_nested_secrets_and_signed_url_values(self):
        value = redaction.redact_log_value({
            "agentToken": "agent-secret",
            "nested": {
                "passwordHash": "hash-secret",
                "error": "Bearer bearer-secret https://bucket.test/x?X-Amz-Signature=deadbeef",
            },
        })
        self.assertEqual(value["agentToken"], "[REDACTED]")
        self.assertEqual(value["nested"]["passwordHash"], "[REDACTED]")
        self.assertNotIn("bearer-secret", value["nested"]["error"])
        self.assertNotIn("deadbeef", value["nested"]["error"])

    def test_agent_log_writer_redacts_secret_fields_before_persistence(self):
        log_path = Path(self.temp.name) / "agent.log"
        with mock.patch.object(agent, "CONFIG_DIR", log_path.parent), mock.patch.object(agent, "LOG_PATH", log_path):
            agent.log_event("error", "Bearer visible-secret", agentToken="agent-secret", error="token=other-secret")
        record = json.loads(log_path.read_text(encoding="utf-8"))
        self.assertEqual(record["agentToken"], "[REDACTED]")
        self.assertNotIn("visible-secret", record["message"])
        self.assertNotIn("other-secret", record["error"])

    def register_selected_capture(self, session, slot_index=1, color="#6d5dfc"):
        folder = server.photo_root() / session["id"]
        folder.mkdir(parents=True, exist_ok=True)
        capture = folder / f"slot-{slot_index}.jpg"
        capture.write_bytes(self.jpeg_bytes(color))
        return server.register_session_file(session["id"], {
            "path": str(capture.relative_to(server.photo_root())),
            "slotIndex": slot_index,
            "attemptNumber": 1,
            "selected": True,
        })

    def test_cloud_voucher_cache_keeps_offline_redemption(self):
        snapshot = {
            "version": 1,
            "events": [{"id": "event-1", "name": "Wedding", "expiresAt": "2099-01-01T00:00:00Z", "includesPrint": True}],
            "vouchers": [{"code": "WEDD-1234", "eventId": "event-1", "includesPrint": True, "createdAt": "2026-07-19T00:00:00Z", "redeemedAt": None}],
        }
        result = server.sync_cloud_vouchers(snapshot)
        self.assertEqual(result["imported"], 1)
        redeemed = server.redeem_voucher({"code": "WEDD-1234"})
        self.assertTrue(redeemed["redeemedAt"])

        server.sync_cloud_vouchers({**snapshot, "version": 2})
        self.assertEqual(server.list_vouchers(), [])
        self.assertEqual(server.offline_voucher_redemptions()[0]["code"], "WEDD-1234")

    def test_agent_reinstall_rotates_installation_token_without_losing_sessions(self):
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        original_token = server.installation_token()
        server.LOCAL_TOKEN_PATH.unlink()

        # Reinstalling the service re-runs data initialization against the same
        # data directory. The secret rotates, while SQLite and photos survive.
        server.ensure_data()
        replacement_token = server.installation_token()

        self.assertNotEqual(original_token, replacement_token)
        with sqlite3.connect(server.DB_PATH) as db:
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM photo_sessions WHERE id = ?", (session["id"],)).fetchone()[0],
                1,
            )

    def test_sync_queue_stress_drains_without_stall_or_unbounded_memory_growth(self):
        total_jobs = min(300, server.MAX_PENDING_SYNC_JOBS)
        tracemalloc.start()
        before, _ = tracemalloc.get_traced_memory()
        with sqlite3.connect(server.DB_PATH) as db:
            for index in range(total_jobs):
                server.enqueue_session_sync(
                    db,
                    {"id": f"stress-session-{index}"},
                    [{"id": f"stress-file-{index}", "path": f"stress/{index}.jpg"}],
                )
            db.commit()

        drained = 0
        while True:
            job = server.claim_sync_job()
            if not job:
                break
            server.update_sync_job(job["id"], True)
            drained += 1
        after, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()

        self.assertEqual(drained, total_jobs)
        self.assertEqual(server.sync_status()["open"], 0)
        self.assertLess(peak - before, 32 * 1024 * 1024)
        self.assertLess(after - before, 8 * 1024 * 1024)

    def test_cloud_snapshot_removes_deleted_active_voucher(self):
        server.sync_cloud_vouchers({"version": 1, "events": [], "vouchers": [{"code": "LIVE-1234"}]})
        self.assertEqual(len(server.list_vouchers()), 1)
        server.sync_cloud_vouchers({"version": 2, "events": [], "vouchers": []})
        self.assertEqual(server.list_vouchers(), [])

    def test_signed_remote_command_matches_agent_canonical_payload(self):
        job = {"id": "job_1", "machineId": "machine_1", "type": "camera.test", "payload": {}, "expiresAt": "2099-01-01T00:00:00Z"}
        canonical = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
        job["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
        self.assertTrue(agent.verify_job_signature({"commandKey": "secret"}, job))
        self.assertIsNone(agent.validate_job({"commandKey": "secret", "machineId": "machine_1"}, job, now_timestamp=1_800_000_000))
        job["payload"] = {"tampered": True}
        self.assertFalse(agent.verify_job_signature({"commandKey": "secret"}, job))

    def test_agent_executes_only_signed_unexpired_job_for_its_machine(self):
        config = {"commandKey": "secret", "machineId": "machine_1", "agentToken": "token", "cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080"}
        job = {"id": "job_1", "machineId": "machine_1", "type": "devices.refresh", "payload": {"force": True}, "expiresAt": "2099-01-01T00:00:00Z"}
        canonical = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
        job["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
        with mock.patch.object(agent, "controller_request", return_value={"devices": []}) as controller, mock.patch.object(agent, "update_job") as update:
            agent.execute_job(config, job)
        controller.assert_called_once_with(config, "/api/devices/refresh", "POST", {"force": True})
        self.assertEqual([call.args[2] for call in update.call_args_list], ["running", "completed"])

    def test_agent_update_jobs_use_protected_controller_api_and_safe_rollback_confirmation(self):
        config = {"commandKey": "secret", "machineId": "machine_1", "agentToken": "token", "cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080"}
        for job_type, expected_path, expected_payload in [
            ("agent.update.check", "/api/local/agent/update/check", {}),
            ("agent.update.apply", "/api/local/agent/update/apply", {}),
            ("agent.update.rollback", "/api/local/agent/update/rollback", {"confirmation": "ROLLBACK"}),
        ]:
            job = {"id": f"job_{job_type}", "machineId": "machine_1", "type": job_type, "payload": {"confirmation": "untrusted"}, "expiresAt": "2099-01-01T00:00:00Z"}
            canonical = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
            job["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
            with mock.patch.object(agent, "controller_request", return_value={"accepted": True}) as controller, mock.patch.object(agent, "update_job"):
                agent.execute_job(config, job)
            controller.assert_called_once_with(config, expected_path, "POST", expected_payload if job_type.endswith("rollback") else {"confirmation": "untrusted"}, protected=True)

    def test_agent_sync_retry_uses_protected_controller_api(self):
        config = {"commandKey": "secret", "machineId": "machine_1", "agentToken": "token", "cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080"}
        job = {"id": "job_sync", "machineId": "machine_1", "type": "sync.retry", "payload": {}, "expiresAt": "2099-01-01T00:00:00Z"}
        canonical = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
        job["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
        with mock.patch.object(agent, "controller_request", return_value={"retried": 2}) as controller, mock.patch.object(agent, "update_job"):
            agent.execute_job(config, job)
        controller.assert_called_once_with(config, "/api/local/sync/retry", "POST", {}, protected=True)

    def test_agent_per_job_retries_preserve_job_id_and_use_protected_controller_api(self):
        config = {"commandKey": "secret", "machineId": "machine_1", "agentToken": "token", "cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080"}
        for index, (job_type, expected_path) in enumerate([
            ("sync.retry_job", "/api/local/sync/retry-job"),
            ("print.retry_job", "/api/local/print/retry-job"),
        ]):
            payload = {"jobId": f"local_job_{index}"}
            job = {"id": f"remote_job_{index}", "machineId": "machine_1", "type": job_type, "payload": payload, "expiresAt": "2099-01-01T00:00:00Z"}
            canonical = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
            job["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
            with mock.patch.object(agent, "controller_request", return_value={"job": {"status": "pending"}}) as controller, mock.patch.object(agent, "update_job"):
                agent.execute_job(config, job)
            controller.assert_called_once_with(config, expected_path, "POST", payload, protected=True)

    def test_session_recovery_projection_is_bounded_and_does_not_expose_capabilities(self):
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False}):
            session = server.create_photo_session(consent={"accepted": True})
        overview = server.session_recovery_overview(100)
        self.assertEqual(len(overview["sessions"]), 1)
        record = overview["sessions"][0]
        self.assertEqual(record["id"], session["id"])
        self.assertNotIn("shareToken", record)
        self.assertNotIn("shareUrl", record)
        self.assertNotIn("path", json.dumps(record))

    def test_expired_session_can_be_recovered_for_a_bounded_window(self):
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False}):
            session = server.create_photo_session(consent={"accepted": True})
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute("UPDATE photo_sessions SET status = 'expired', deadline_at = ? WHERE id = ?", ("2020-01-01T00:00:00+00:00", session["id"]))
            db.commit()
        recovered = server.recover_photo_session(session["id"], 10_000)
        self.assertEqual(recovered["status"], "active")
        remaining = server._session_time(recovered["deadlineAt"]) - server.datetime.now(server.timezone.utc)
        self.assertGreater(remaining.total_seconds(), 890)
        self.assertLessEqual(remaining.total_seconds(), 900)
        local = server.current_recoverable_session()
        self.assertEqual(local["shareToken"], session["shareToken"])

    def test_recovery_rejects_parallel_active_session(self):
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False}):
            first = server.create_photo_session(consent={"accepted": True})
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute("UPDATE photo_sessions SET status = 'expired' WHERE id = ?", (first["id"],))
            db.commit()
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False}):
            second = server.create_photo_session(consent={"accepted": True})
        with self.assertRaisesRegex(ValueError, "Selesaikan sesi aktif lain"):
            server.recover_photo_session(first["id"], 180)
        self.assertEqual(server.current_recoverable_session()["shareToken"], second["shareToken"])

    def test_agent_session_recovery_job_uses_protected_controller_api(self):
        config = {"commandKey": "secret", "machineId": "machine_1", "agentToken": "token", "cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080"}
        payload = {"sessionId": "SES-1", "extensionSeconds": 180}
        job = {"id": "job_recovery", "machineId": "machine_1", "type": "session.recover", "payload": payload, "expiresAt": "2099-01-01T00:00:00Z"}
        canonical = json.dumps(job, separators=(",", ":"), ensure_ascii=False)
        job["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
        with mock.patch.object(agent, "controller_request", return_value={"session": {"status": "active"}}) as controller, mock.patch.object(agent, "update_job"):
            agent.execute_job(config, job)
        controller.assert_called_once_with(config, "/api/local/session-recovery/recover", "POST", payload, protected=True)

    def test_agent_rejects_expired_and_cross_machine_jobs(self):
        config = {"commandKey": "secret", "machineId": "machine_1", "agentToken": "token", "cloud": "https://cloud.test"}

        expired = {"id": "job_old", "machineId": "machine_1", "type": "devices.refresh", "payload": {}, "expiresAt": "2020-01-01T00:00:00Z"}
        canonical = json.dumps(expired, separators=(",", ":"), ensure_ascii=False)
        expired["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
        with mock.patch.object(agent, "update_job") as update, mock.patch.object(agent, "controller_request") as controller:
            agent.execute_job(config, expired)
        update.assert_called_once_with(config, expired, "failed", error="Command sudah kedaluwarsa")
        controller.assert_not_called()

        cross_machine = {"id": "job_other", "machineId": "machine_2", "type": "devices.refresh", "payload": {}, "expiresAt": "2099-01-01T00:00:00Z"}
        canonical = json.dumps(cross_machine, separators=(",", ":"), ensure_ascii=False)
        cross_machine["signature"] = hmac.new(b"secret", canonical.encode(), hashlib.sha256).hexdigest()
        with mock.patch.object(agent, "update_job") as update, mock.patch.object(agent, "controller_request") as controller:
            agent.execute_job(config, cross_machine)
        update.assert_not_called()
        controller.assert_not_called()

    def test_agent_restart_uses_os_supervisor_and_reports_failure(self):
        with mock.patch.object(server.platform, "system", return_value="Darwin"), mock.patch.object(server.os, "getuid", return_value=501):
            self.assertEqual(server.supervisor_restart_commands(), [["launchctl", "kickstart", "-k", "gui/501/app.photoslive.agent"]])
        with mock.patch.object(server.platform, "system", return_value="Windows"):
            self.assertEqual(server.supervisor_restart_commands(), [["schtasks", "/Run", "/TN", "Photoslive Agent"]])

        with mock.patch.object(server, "supervisor_restart_commands", return_value=[["first"], ["second"]]), mock.patch.object(server, "command_output", side_effect=[(False, "not installed"), (True, "restarted")]) as command:
            self.assertEqual(server.restart_agent_service(), (True, "restarted"))
            self.assertEqual(command.call_count, 2)
        with mock.patch.object(server, "supervisor_restart_commands", return_value=[["first"]]), mock.patch.object(server, "command_output", return_value=(False, "permission denied")):
            self.assertEqual(server.restart_agent_service(), (False, "permission denied"))

    def test_agent_hard_stop_is_os_supervised_and_separate_from_controller(self):
        with mock.patch.object(server.platform, "system", return_value="Darwin"), mock.patch.object(server.os, "getuid", return_value=501):
            self.assertEqual(server.supervisor_stop_commands(), [["launchctl", "bootout", "gui/501/app.photoslive.agent"]])
        with mock.patch.object(server.platform, "system", return_value="Windows"):
            self.assertEqual(server.supervisor_stop_commands(), [["schtasks", "/End", "/TN", "Photoslive Agent"]])
        with mock.patch.object(server, "supervisor_stop_commands", return_value=[["stop-agent"]]), mock.patch.object(server, "command_output", return_value=(True, "stopped")) as command:
            self.assertEqual(server.stop_agent_service(), (True, "stopped"))
            command.assert_called_once_with(["stop-agent"], timeout=12)

    def test_installation_token_is_file_permission_scoped(self):
        token = server.installation_token()
        self.assertGreaterEqual(len(token), 64)
        self.assertEqual(server.installation_token(), token)
        self.assertEqual(server.LOCAL_TOKEN_PATH.stat().st_mode & 0o777, 0o600)
        with sqlite3.connect(server.DB_PATH) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], server.LOCAL_SCHEMA_VERSION)

    def test_setup_url_is_prefilled_and_browser_open_is_best_effort(self):
        url = agent.setup_url({"cloud": "https://photoslive.example/"}, "ABCD-1234")
        self.assertEqual(url, "https://photoslive.example/setup?code=ABCD-1234")
        with mock.patch.object(agent.webbrowser, "open", return_value=True) as opener:
            self.assertTrue(agent.open_setup_page(url))
            opener.assert_called_once_with(url, new=2)
        with mock.patch.object(agent.webbrowser, "open", side_effect=RuntimeError("no browser")):
            self.assertFalse(agent.open_setup_page(url))

    def test_local_pin_assertion_is_short_lived_machine_bound_and_signed(self):
        config_path = Path(self.temp.name) / "agent.json"
        config_path.write_text(json.dumps({
            "cloud": "https://photoslive.example",
            "machineId": "machine-local-1",
            "boothCode": "booth-local-1",
            "commandKey": "command-secret",
            "agentToken": "must-not-leak",
        }), encoding="utf-8")

        with mock.patch.object(server, "AGENT_CONFIG_PATH", config_path):
            capability = server.local_login_capability()
            proof = server.local_login_assertion()
            self.assertTrue(server.local_auth_allowed_origin("https://photoslive.example"))
            self.assertFalse(server.local_auth_allowed_origin("https://evil.example"))

        self.assertEqual(capability, {
            "available": True,
            "machineId": "machine-local-1",
            "boothCode": "booth-local-1",
        })
        encoded, supplied_signature = proof["assertion"].split(".")
        payload = json.loads(base64.urlsafe_b64decode(encoded + "=" * ((4 - len(encoded) % 4) % 4)))
        expected_signature = hmac.new(
            b"command-secret",
            f"local-login:{encoded}".encode(),
            hashlib.sha256,
        ).hexdigest()
        self.assertTrue(hmac.compare_digest(supplied_signature, expected_signature))
        self.assertEqual(payload["purpose"], "admin-pin")
        self.assertEqual(payload["machineId"], "machine-local-1")
        self.assertEqual(payload["boothCode"], "booth-local-1")
        self.assertEqual(payload["exp"] - payload["iat"], 60_000)
        self.assertNotIn("commandKey", proof)
        self.assertNotIn("agentToken", proof)

    def test_local_manager_status_exposes_operations_without_secrets(self):
        now = time.time()
        device = server.Device("camera-1", "Webcam USB", "camera", "connected", "UVC")
        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(server, "read_json_file", return_value={"updatedAt": now, "lastHeartbeatAt": now, "version": "2.0"}))
            stack.enter_context(mock.patch.object(server, "public_agent_config", return_value={"machineId": "machine-1", "boothCode": "booth-1", "pairingCode": "PAIR-1", "configured": True}))
            stack.enter_context(mock.patch.object(server, "agent_control", return_value={"paused": False, "updatedAt": None}))
            stack.enter_context(mock.patch.object(server, "sync_status", return_value={"pending": 1, "running": 0, "failed": 0, "remainingCapacity": 999}))
            stack.enter_context(mock.patch.object(server, "queue_status", return_value={"pendingUploads": 0, "failedUploads": 0, "pendingPrints": 2}))
            stack.enter_context(mock.patch.object(server, "detect_devices", return_value=[device]))
            stack.enter_context(mock.patch.object(server, "memory_metrics", return_value={"available": True, "usedPercent": 25}))
            stack.enter_context(mock.patch.object(server, "cpu_metrics", return_value={"available": True, "loadPercent": 5, "cores": 2}))
            stack.enter_context(mock.patch.object(server, "disk_metrics", return_value={"freeBytes": 4_000_000_000, "totalBytes": 8_000_000_000}))
            stack.enter_context(mock.patch.object(server, "offline_policy_status", return_value={"state": "online", "message": "Online"}))
            status = server.local_agent_status()
        self.assertEqual(status["agentState"], "online")
        self.assertTrue(status["cloud"]["connected"])
        self.assertEqual(status["queue"]["pendingPrints"], 2)
        self.assertEqual(status["devices"][0]["name"], "Webcam USB")
        self.assertEqual(status["system"]["memory"]["usedPercent"], 25)
        self.assertEqual(status["system"]["storageSafety"]["state"], "ready")
        self.assertNotIn("agentToken", json.dumps(status))
        self.assertEqual(status["update"]["state"], "not-configured")

    def test_local_metrics_registry_is_bounded_and_collapses_session_ids(self):
        with server.METRICS_LOCK:
            server.REQUEST_METRIC_SAMPLES.clear()
            for kind in server.OPERATION_FAILURES:
                server.OPERATION_FAILURES[kind] = 0
        try:
            for index in range(520):
                server.record_request_metric(
                    "GET",
                    f"/api/sessions/session-{index}?include=files",
                    500 if index % 10 == 0 else 200,
                    index / 10,
                )
            server.increment_operation_failure("camera")
            server.increment_operation_failure("capture")
            snapshot = server.local_metrics_snapshot()
            self.assertEqual(snapshot["sampleLimit"], 512)
            self.assertEqual(snapshot["requests"]["total"], 512)
            self.assertGreater(snapshot["requests"]["errors"], 0)
            self.assertGreater(snapshot["requests"]["p95Ms"], 0)
            self.assertEqual(snapshot["routes"][0]["route"], "/api/sessions/:id")
            self.assertEqual(snapshot["routes"][0]["requests"], 512)
            self.assertEqual(snapshot["failures"]["camera"], 1)
            self.assertEqual(snapshot["failures"]["capture"], 1)
            self.assertIn("sync", snapshot["queues"])
            self.assertIn("print", snapshot["queues"])
            self.assertNotIn("agentToken", json.dumps(snapshot))
        finally:
            with server.METRICS_LOCK:
                server.REQUEST_METRIC_SAMPLES.clear()
                for kind in server.OPERATION_FAILURES:
                    server.OPERATION_FAILURES[kind] = 0

    def test_cloud_settings_snapshot_merges_and_persists_version(self):
        updated = server.save_settings({"booth": {"name": "Pilot Jakarta"}, "payment": {"qrisEnabled": False}})
        server.set_local_state("settings_version", 9)
        self.assertEqual(updated["booth"]["name"], "Pilot Jakarta")
        self.assertFalse(server.load_settings()["payment"]["qrisEnabled"])
        with sqlite3.connect(server.DB_PATH) as db:
            value = db.execute("SELECT value_json FROM local_state WHERE key = 'settings_version'").fetchone()[0]
        self.assertEqual(json.loads(value), 9)

    def test_device_selection_is_mirrored_to_sqlite_and_survives_settings_damage(self):
        selected = {
            "preferredCamera": "/dev/video2",
            "preferredPrinter": "cups-Canon_CP1500",
            "cameraSource": "controller",
            "browserCameraId": "",
        }
        server.save_settings({"devices": selected})
        with sqlite3.connect(server.DB_PATH) as db:
            saved = json.loads(db.execute(
                "SELECT value_json FROM local_state WHERE key = 'device_selection'"
            ).fetchone()[0])
        self.assertEqual(saved, selected)

        # Simulate a truncated settings file after a power loss. The default
        # config remains readable and the operational device selection is
        # recovered from SQLite on the next Controller start.
        server.SETTINGS_PATH.write_text("{", encoding="utf-8")
        recovered = server.load_settings()
        self.assertEqual(recovered["devices"]["preferredCamera"], "/dev/video2")
        self.assertEqual(recovered["devices"]["preferredPrinter"], "cups-Canon_CP1500")
        self.assertEqual(recovered["devices"]["cameraSource"], "controller")

    def test_device_selection_sqlite_values_are_bounded_and_allowlisted(self):
        server.set_local_state("device_selection", {
            "preferredCamera": "/dev/video9",
            "preferredPrinter": "cups-Test",
            "cameraSource": "controller",
            "browserCameraId": "browser-id",
            "paperSize": "A0",
            "unexpected": "ignored",
        })
        recovered = server.load_settings()["devices"]
        self.assertEqual(recovered["preferredCamera"], "/dev/video9")
        self.assertEqual(recovered["browserCameraId"], "browser-id")
        self.assertEqual(recovered["paperSize"], "4x6")
        self.assertNotIn("unexpected", recovered)

    def test_session_completion_creates_idempotent_transactional_outbox(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        file_record = self.register_selected_capture(session)

        first = server.complete_photo_session(session["id"])
        second = server.complete_photo_session(session["id"])
        self.assertEqual(first["sync"]["jobId"], second["sync"]["jobId"])
        with sqlite3.connect(server.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sync_queue").fetchone()[0], 1)
            output_kinds = {row[0] for row in db.execute(
                "SELECT file_kind FROM photo_files WHERE session_id = ?", (session["id"],),
            ).fetchall()}
        self.assertEqual(output_kinds, {"capture", "composite", "print-sheet"})
        with PILImage.open(server.photo_root() / session["id"] / "result-frame.jpg") as composite:
            self.assertEqual(composite.size, (600, 1800))
        with PILImage.open(server.photo_root() / session["id"] / "result-print-sheet.jpg") as sheet:
            self.assertEqual(sheet.size, (1200, 1800))
        claimed = server.claim_sync_job()
        self.assertEqual(claimed["kind"], "session.sync")
        self.assertEqual(
            {item["fileKind"] for item in claimed["payload"]["files"]},
            {"capture", "composite"},
        )
        capture_payload = next(item for item in claimed["payload"]["files"] if item["fileKind"] == "capture")
        self.assertEqual(capture_payload["checksumSha256"], file_record["checksumSha256"])
        self.assertIsNone(server.claim_sync_job())

        server.update_sync_job(claimed["id"], True)
        with sqlite3.connect(server.DB_PATH) as db:
            uploaded = db.execute("SELECT uploaded_at FROM photo_files WHERE id = ?", (file_record["id"],)).fetchone()[0]
        self.assertIsNotNone(uploaded)

    def test_active_session_and_selected_capture_survive_controller_restart(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        capture = self.register_selected_capture(session, color="#275e91")

        # Re-run startup migrations exactly as a restarted Controller does.
        server.ensure_data()
        recovered = server.session_summary(session["shareToken"])
        self.assertEqual(recovered["status"], "active")
        self.assertEqual(recovered["slots"][0]["selectedFileId"], capture["id"])
        self.assertTrue((server.photo_root() / capture["path"]).is_file())
        completed = server.complete_photo_session(session["id"])
        self.assertEqual(completed["status"], "completed")

    def test_offline_session_captures_renders_and_queues_without_cloud(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        offline = {"state": "normal", "allowNewSession": True, "allowActiveSessionFinish": True, "qrisAllowed": False, "message": "Mode offline"}
        with mock.patch.object(server, "offline_policy_status", return_value=offline), mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
            capture = server.capture_session_upload(session["id"], 1, self.jpeg_bytes("#824fc2"))
            server.select_session_file(session["id"], {"fileId": capture["id"]})
            completed = server.complete_photo_session(session["id"])
        self.assertEqual(completed["status"], "completed")
        self.assertTrue((server.photo_root() / session["id"] / "result-frame.jpg").is_file())
        self.assertEqual(server.sync_status()["pending"], 1)

    def test_customer_share_token_has_at_least_128_bits_of_randomness(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        self.assertRegex(session["shareToken"], r"^[a-f0-9]{32}$")
        self.assertEqual(len(session["shareToken"]), 32)

    def test_customer_consent_is_versioned_and_persisted_with_the_session(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        consent = {"accepted": True, "version": server.PHOTO_CONSENT_VERSION, "method": "welcome_continue"}
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session(consent=consent)
        self.assertEqual(session["consent"]["version"], server.PHOTO_CONSENT_VERSION)
        self.assertIsNotNone(session["consent"]["acceptedAt"])
        with sqlite3.connect(server.DB_PATH) as db:
            stored = db.execute(
                "SELECT consent_at, consent_version FROM photo_sessions WHERE id = ?", (session["id"],),
            ).fetchone()
        self.assertIsNotNone(stored[0])
        self.assertEqual(stored[1], server.PHOTO_CONSENT_VERSION)

    def test_customer_privacy_deletion_removes_local_files_database_and_queues(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        self.register_selected_capture(session)
        server.complete_photo_session(session["id"])
        self.assertTrue((server.photo_root() / session["id"]).is_dir())

        deleted = server.delete_photo_session_by_share_token(session["shareToken"])

        self.assertTrue(deleted["deleted"])
        self.assertFalse((server.photo_root() / session["id"]).exists())
        with sqlite3.connect(server.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM photo_sessions WHERE id = ?", (session["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM photo_files WHERE session_id = ?", (session["id"],)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sync_queue").fetchone()[0], 0)
        self.assertTrue(server.delete_photo_session_by_share_token(session["shareToken"])["alreadyDeleted"])

    def test_disk_full_capture_leaves_session_and_database_consistent(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        with mock.patch.object(server.os, "replace", side_effect=OSError("No space left on device")):
            with self.assertRaisesRegex(OSError, "Periksa ruang disk"):
                server.capture_session_upload(session["id"], 1, self.jpeg_bytes())
        folder = server.photo_root() / session["id"]
        self.assertEqual(list(folder.glob("*")), [])
        with sqlite3.connect(server.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT status FROM photo_sessions WHERE id = ?", (session["id"],)).fetchone()[0], "active")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM photo_files WHERE session_id = ?", (session["id"],)).fetchone()[0], 0)

    def test_capture_database_failure_removes_untracked_file(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        with mock.patch.object(server, "register_session_file", side_effect=sqlite3.DatabaseError("database disk image is malformed")):
            with self.assertRaises(sqlite3.DatabaseError):
                server.capture_session_upload(session["id"], 1, self.jpeg_bytes())
        self.assertEqual(list((server.photo_root() / session["id"]).glob("*")), [])
        with sqlite3.connect(server.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM photo_files WHERE session_id = ?", (session["id"],)).fetchone()[0], 0)

    def test_diagnosis_reports_corrupt_database_without_crashing(self):
        self.assertTrue(server.database_health()["healthy"])
        server.DB_PATH.write_bytes(b"not-a-sqlite-database")
        report = server.diagnostics()
        self.assertFalse(report["database"]["healthy"])
        self.assertEqual(report["database"]["status"], "corrupt")
        self.assertIn("pulihkan backup", report["database"]["action"])
        self.assertFalse(report["queue"]["available"])

    def test_local_manager_status_stays_available_for_corrupt_database_recovery(self):
        server.DB_PATH.write_bytes(b"not-a-sqlite-database")
        status = server.local_agent_status()
        self.assertFalse(status["database"]["healthy"])
        self.assertFalse(status["queue"]["available"])
        self.assertFalse(status["sync"]["available"])
        self.assertFalse(status["offlinePolicy"]["available"])
        self.assertIn("Pulihkan database", status["offlinePolicy"]["action"])

    def test_local_database_backup_restore_and_safety_backup(self):
        server.add_event("test", "before backup")
        backup = server.create_local_database_backup("manual")
        self.assertTrue((server.backup_root() / backup["name"]).is_file())
        self.assertEqual(backup["checksumSha256"], server.file_checksum(server.backup_root() / backup["name"]))
        server.add_event("test", "after backup")

        restored = server.restore_local_database_backup(backup["name"], "RESTORE")
        self.assertTrue(restored["restored"])
        self.assertIsNotNone(restored["safetyBackup"])
        self.assertEqual(restored["restore"]["status"], "completed")
        self.assertEqual(server.local_restore_status()["status"], "completed")
        self.assertTrue(server.restore_status_path().is_file())
        with sqlite3.connect(server.DB_PATH) as db:
            messages = [row[0] for row in db.execute("SELECT message FROM events ORDER BY created_at").fetchall()]
        self.assertIn("before backup", messages)
        self.assertNotIn("after backup", messages)
        self.assertTrue(server.database_health()["healthy"])

    def test_agent_backup_telemetry_is_bounded_and_redacted(self):
        payload = {
            "database": {"status": "healthy"},
            "restore": {"status": "completed", "updatedAt": "2026-07-21T01:02:03+00:00", "error": "secret"},
            "backups": [{
                "name": "photoslive-secret.db", "createdAt": "2026-07-21T00:00:00+00:00", "reason": "daily",
                "sizeBytes": 1234, "schemaVersion": 4, "checksumSha256": "secret-checksum", "path": "/secret/path",
            }],
        }
        with mock.patch.object(agent, "controller_request", return_value=payload):
            telemetry = agent.backup_telemetry({"controller": "http://127.0.0.1:8080"})
        self.assertEqual(telemetry["status"], "ready")
        self.assertEqual(telemetry["count"], 1)
        self.assertEqual(telemetry["restoreStatus"], "completed")
        serialized = json.dumps(telemetry)
        self.assertNotIn("photoslive-secret.db", serialized)
        self.assertNotIn("secret-checksum", serialized)
        self.assertNotIn("/secret/path", serialized)

    def test_agent_backup_telemetry_failure_does_not_raise(self):
        with mock.patch.object(agent, "controller_request", side_effect=RuntimeError("controller offline")):
            telemetry = agent.backup_telemetry({"controller": "http://127.0.0.1:8080"})
        self.assertEqual(telemetry["status"], "unavailable")
        self.assertEqual(telemetry["count"], 0)

    def test_corrupt_live_database_is_recovered_from_verified_backup(self):
        server.add_event("recovery", "record that must survive")
        backup = server.create_local_database_backup("before-corruption")
        server.DB_PATH.write_bytes(b"not-a-sqlite-database")
        self.assertFalse(server.database_health()["healthy"])

        restored = server.restore_local_database_backup(backup["name"], "RESTORE")

        self.assertTrue(restored["restored"])
        self.assertIsNone(restored["safetyBackup"])
        self.assertTrue(server.database_health()["healthy"])
        with sqlite3.connect(server.DB_PATH) as db:
            messages = [row[0] for row in db.execute("SELECT message FROM events ORDER BY created_at").fetchall()]
        self.assertIn("record that must survive", messages)

    def test_tampered_backup_is_rejected_without_changing_live_database(self):
        backup = server.create_local_database_backup("manual")
        path = server.backup_root() / backup["name"]
        path.write_bytes(path.read_bytes() + b"tampered")
        server.add_event("test", "live database remains")
        with self.assertRaisesRegex(ValueError, "Checksum backup tidak cocok"):
            server.restore_local_database_backup(backup["name"], "RESTORE")
        with sqlite3.connect(server.DB_PATH) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events WHERE message = 'live database remains'").fetchone()[0], 1)

    def test_daily_database_backup_is_idempotent_for_the_same_day(self):
        first = server.ensure_daily_local_database_backup()
        second = server.ensure_daily_local_database_backup()
        self.assertEqual(first["name"], second["name"])
        self.assertEqual(len(server.list_local_database_backups()), 1)

    def test_restore_refuses_to_replace_database_with_active_session(self):
        backup = server.create_local_database_backup("manual")
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            server.create_photo_session()
        with self.assertRaisesRegex(ValueError, "sesi aktif"):
            server.restore_local_database_backup(backup["name"], "RESTORE")

    def test_print_worker_uses_persisted_sheet_and_failed_job_can_retry(self):
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        self.register_selected_capture(session, color="#1a8f75")
        server.complete_photo_session(session["id"])
        queued = server.queue_session_print(session["id"])

        with mock.patch.object(server, "detect_devices", return_value=[]):
            failed = server.process_next_print_job()
        self.assertEqual(failed["status"], "failed")
        self.assertIn("Printer belum tersambung", failed["error"])
        self.assertTrue((server.photo_root() / session["id"] / "result-print-sheet.jpg").is_file())

        retried = server.queue_session_print(session["id"])
        self.assertEqual(retried["id"], queued["id"])
        self.assertEqual(retried["status"], "pending")
        printer = server.Device("cups-Canon_CP1500", "Canon SELPHY CP1500", "printer", "connected", "CUPS")
        with mock.patch.object(server, "detect_devices", return_value=[printer]), \
             mock.patch.object(server, "command_output", return_value=(True, "request id is Canon_CP1500-1")) as command:
            completed = server.process_next_print_job()
        self.assertEqual(completed["status"], "completed")
        command.assert_called_once()
        self.assertEqual(command.call_args.args[0][:3], ["lp", "-d", "Canon_CP1500"])
        self.assertTrue(command.call_args.args[0][-1].endswith("result-print-sheet.jpg"))

    def test_print_queue_list_and_scoped_retry_preserve_operator_context(self):
        now = server.utc_now()
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute(
                """INSERT INTO jobs(id, kind, status, attempts, message,
                          reference_id, last_error, created_at, updated_at)
                   VALUES ('PRINT-FAILED', 'print', 'failed', 3, 'Perlu diperiksa',
                          'session-missing', 'Printer belum tersambung', ?, ?)""",
                (now, now),
            )
            db.commit()

        listed = server.list_print_jobs()
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], "PRINT-FAILED")
        self.assertEqual(listed[0]["attempts"], 3)
        self.assertEqual(listed[0]["lastError"], "Printer belum tersambung")
        self.assertFalse(listed[0]["fileExists"])

        with mock.patch.object(server, "ensure_print_worker") as worker:
            retried = server.retry_print_job("PRINT-FAILED")
        self.assertEqual(retried["status"], "pending")
        self.assertEqual(retried["attempts"], 0)
        self.assertIsNone(retried["lastError"])
        worker.assert_called_once()
        with self.assertRaisesRegex(ValueError, "tidak gagal"):
            server.retry_print_job("PRINT-FAILED")

    def test_gif_is_rendered_after_main_result_and_synced_as_a_separate_job(self):
        server.save_settings({
            "booth": {"photoSlotsPerSession": 3},
            "appearance": {"framePhotoSlots": {"clean-white": 3}},
        })
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        for slot, color in enumerate(("#c74848", "#47a06a", "#4c68bd"), start=1):
            self.register_selected_capture(session, slot_index=slot, color=color)

        completed = server.complete_photo_session(session["id"])
        self.assertTrue((server.photo_root() / session["id"] / "result-frame.jpg").is_file())
        self.assertFalse((server.photo_root() / session["id"] / "result-flipbook.gif").exists())
        self.assertEqual(completed["outputs"]["gif"]["status"], "pending")

        rendered = server.process_next_gif_job()
        self.assertEqual(rendered["status"], "completed")
        gif_path = server.photo_root() / session["id"] / "result-flipbook.gif"
        with PILImage.open(gif_path) as gif:
            self.assertTrue(gif.is_animated)
            self.assertEqual(gif.n_frames, 3)
            self.assertEqual(gif.size, (640, 640))
        summary = server.session_summary(session["shareToken"])
        gif_file = next(item for item in summary["files"] if item["kind"] == "gif")
        self.assertEqual(gif_file["url"], f"/api/session-files/{session['id']}:gif")

        first_sync = server.claim_sync_job()
        server.update_sync_job(first_sync["id"], True)
        gif_sync = server.claim_sync_job()
        self.assertEqual(gif_sync["id"], f"session.sync:{session['id']}:gif")
        self.assertEqual(gif_sync["payload"]["files"][0]["fileKind"], "gif")
        server.update_sync_job(gif_sync["id"], True)
        with sqlite3.connect(server.DB_PATH) as db:
            uploaded_at = db.execute("SELECT uploaded_at FROM photo_files WHERE id = ?", (gif_file["id"],)).fetchone()[0]
        self.assertIsNotNone(uploaded_at)

    def test_unlimited_retakes_keep_attempts_per_slot_and_persist_final_selection(self):
        server.save_settings({
            "booth": {"photoSlotsPerSession": 2, "unlimitedRetakes": True, "sessionTimeoutSeconds": 300},
            "appearance": {"activeFrame": "two-slot", "framePhotoSlots": {"two-slot": 2}},
        })
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session("two-slot")

        self.assertTrue(session["rules"]["unlimitedRetakes"])
        self.assertIsNone(session["rules"]["maxAttemptsPerSlot"])
        slot_one = [
            server.capture_session_upload(session["id"], 1, self.jpeg_bytes("#d84747")),
            server.capture_session_upload(session["id"], 1, self.jpeg_bytes("#4a65d8")),
            server.capture_session_upload(session["id"], 1, self.jpeg_bytes("#4bbf73")),
        ]
        slot_two = server.capture_session_upload(session["id"], 2, self.jpeg_bytes("#d5a836"))
        server.select_session_file(session["id"], {"fileId": slot_one[-1]["id"]})
        server.select_session_file(session["id"], {"fileId": slot_two["id"]})

        summary = server.session_summary(session["shareToken"])
        self.assertEqual([len(slot["attempts"]) for slot in summary["slots"]], [3, 1])
        self.assertEqual(summary["slots"][0]["selectedFileId"], slot_one[-1]["id"])
        self.assertEqual(summary["slots"][1]["selectedFileId"], slot_two["id"])
        completed = server.complete_photo_session(session["id"])
        self.assertEqual(completed["status"], "completed")

    def test_failed_outbox_can_be_retried_manually(self):
        now = server.utc_now()
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute(
                "INSERT INTO sync_queue(id, kind, payload_json, status, created_at, updated_at) VALUES ('job-1', 'session.sync', '{}', 'pending', ?, ?)",
                (now, now),
            )
            db.commit()
        job = server.claim_sync_job()
        server.update_sync_job(job["id"], False, "internet offline")
        self.assertEqual(server.sync_status()["failed"], 1)
        self.assertEqual(server.retry_failed_sync_jobs(), 1)
        self.assertEqual(server.claim_sync_job()["id"], "job-1")

    def test_failed_outbox_becomes_claimable_automatically_after_backoff(self):
        now = server.utc_now()
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute(
                "INSERT INTO sync_queue(id, kind, payload_json, status, created_at, updated_at) VALUES ('job-reconnect', 'session.sync', '{}', 'pending', ?, ?)",
                (now, now),
            )
            db.commit()
        claimed = server.claim_sync_job()
        server.update_sync_job(claimed["id"], False, "internet offline")
        self.assertIsNone(server.claim_sync_job())
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute("UPDATE sync_queue SET next_attempt_at = ? WHERE id = ?", ("2000-01-01T00:00:00+00:00", claimed["id"]))
            db.commit()
        retried = server.claim_sync_job()
        self.assertEqual(retried["id"], "job-reconnect")
        self.assertEqual(retried["attempts"], 2)
        server.update_sync_job(retried["id"], True)
        self.assertEqual(server.sync_status()["completed"], 1)

    def test_outbox_stops_at_dead_letter_and_can_be_retried_manually(self):
        now = server.utc_now()
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute(
                """INSERT INTO sync_queue(
                     id, kind, payload_json, status, attempts, created_at, updated_at
                   ) VALUES ('job-dead', 'session.sync', '{}', 'running', 10, ?, ?)""",
                (now, now),
            )
            db.commit()
        result = server.update_sync_job("job-dead", False, "permanent failure")
        self.assertEqual(result["status"], "dead")
        self.assertEqual(server.sync_status()["dead"], 1)
        self.assertEqual(server.retry_failed_sync_jobs(), 1)
        claimed = server.claim_sync_job()
        self.assertEqual(claimed["id"], "job-dead")
        self.assertEqual(claimed["attempts"], 1)

    def test_outbox_capacity_is_bounded_and_reported(self):
        original_limit = server.MAX_PENDING_SYNC_JOBS
        server.MAX_PENDING_SYNC_JOBS = 2
        try:
            now = server.utc_now()
            with sqlite3.connect(server.DB_PATH) as db:
                for index in range(2):
                    db.execute(
                        """INSERT INTO sync_queue(id, kind, payload_json, status, created_at, updated_at)
                           VALUES (?, 'session.sync', '{}', 'pending', ?, ?)""",
                        (f"job-{index}", now, now),
                    )
                db.commit()
                with self.assertRaisesRegex(ValueError, "Antrean upload mencapai batas 2 sesi"):
                    server.enqueue_session_sync(db, {"id": "SES-LIMIT"}, [])
                db.rollback()
            status = server.sync_status()
            self.assertEqual(status["limit"], 2)
            self.assertEqual(status["remainingCapacity"], 0)
        finally:
            server.MAX_PENDING_SYNC_JOBS = original_limit

    def test_agent_drains_session_outbox_and_acknowledges_controller(self):
        job = {
            "id": "session.sync:SES-1",
            "kind": "session.sync",
            "payload": {
                "session": {"id": "SES-1", "shareCode": "share-1"},
                "files": [{"id": "file-1", "fileKind": "composite", "slotIndex": 0, "contentType": "image/jpeg", "checksumSha256": "a" * 64}],
            },
        }
        config = {"cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080", "machineId": "machine-1", "agentToken": "token"}
        prepared = {"mode": "direct-object-storage", "uploadId": "upload-1", "upload": {"url": "https://bucket.test/signed", "headers": {"content-type": "image/jpeg"}}}
        with mock.patch.object(agent, "controller_request", side_effect=[{"job": job}, {"checkpoint": {}}, {"job": {"status": "completed"}}]) as controller, \
             mock.patch.object(agent, "controller_raw_request", return_value={"contentType": "image/jpeg", "bodyBase64": "/9j/2Q=="}), \
             mock.patch.object(agent, "request_json", side_effect=[{}, prepared, {}, {}]) as cloud, \
             mock.patch.object(agent, "upload_presigned_file") as direct_upload:
            self.assertTrue(agent.sync_local_outbox_once(config))
        self.assertIn("sync_session_metadata", cloud.call_args_list[0].args[0])
        self.assertIn("prepare_session_file", cloud.call_args_list[1].args[0])
        uploaded_payload = cloud.call_args_list[1].args[2]
        self.assertEqual(uploaded_payload["fileKind"], "composite")
        self.assertNotIn("bodyBase64", uploaded_payload)
        direct_upload.assert_called_once()
        self.assertIn("finalize_session_file", cloud.call_args_list[2].args[0])
        self.assertIn("sync_session_metadata", cloud.call_args_list[3].args[0])
        self.assertEqual(controller.call_args_list[-2].args[1], "/api/local/sync/progress")
        self.assertEqual(controller.call_args_list[-2].args[3]["fileId"], "file-1")
        self.assertEqual(controller.call_args_list[-1].args[1], "/api/local/sync/complete")

    def test_agent_falls_back_to_legacy_file_sync_with_an_older_cloud(self):
        job = {
            "id": "session.sync:SES-OLD",
            "kind": "session.sync",
            "payload": {"session": {"id": "SES-OLD", "shareCode": "share-old"}, "files": [{"id": "file-old", "fileKind": "capture", "slotIndex": 1, "contentType": "image/jpeg", "checksumSha256": "a" * 64}]},
        }
        config = {"cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080", "machineId": "machine-1", "agentToken": "token"}
        with mock.patch.object(agent, "controller_request", side_effect=[{"job": job}, {"checkpoint": {}}, {"job": {"status": "completed"}}]), \
             mock.patch.object(agent, "controller_raw_request", return_value={"contentType": "image/jpeg", "bodyBase64": "/9j/2Q=="}), \
             mock.patch.object(agent, "request_json", side_effect=[{}, RuntimeError("Endpoint tidak ditemukan"), {}, {}]) as cloud:
            self.assertTrue(agent.sync_local_outbox_once(config))
        self.assertIn("sync_session_file", cloud.call_args_list[2].args[0])
        self.assertEqual(cloud.call_args_list[2].args[2]["bodyBase64"], "/9j/2Q==")
        self.assertIn("sync_session_metadata", cloud.call_args_list[3].args[0])

    def test_sync_checkpoint_survives_failure_and_is_returned_on_retry(self):
        files = [{"id": "file-a"}, {"id": "file-b"}]
        with sqlite3.connect(server.DB_PATH) as db:
            server.enqueue_session_sync(db, {"id": "SES-RESUME"}, files)
            db.commit()
        first = server.claim_sync_job()
        self.assertEqual(first["progress"], {})
        checkpoint = server.checkpoint_sync_file(first["id"], "file-a")
        self.assertEqual(checkpoint["progress"]["completedFileIds"], ["file-a"])
        server.update_sync_job(first["id"], False, "internet terputus")
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute("UPDATE sync_queue SET next_attempt_at = ? WHERE id = ?", ("2000-01-01T00:00:00+00:00", first["id"]))
            db.commit()
        retried = server.claim_sync_job()
        self.assertEqual(retried["progress"]["completedFileIds"], ["file-a"])
        server.checkpoint_sync_file(retried["id"], "file-b")
        server.update_sync_job(retried["id"], True)
        with sqlite3.connect(server.DB_PATH) as db:
            status, progress = db.execute("SELECT status, progress_json FROM sync_queue WHERE id = ?", (retried["id"],)).fetchone()
        self.assertEqual(status, "completed")
        self.assertEqual(json.loads(progress)["completedFileIds"], ["file-a", "file-b"])

    def test_multipart_checkpoint_survives_retry_and_is_removed_after_file_completion(self):
        files = [{"id": "file-large"}]
        with sqlite3.connect(server.DB_PATH) as db:
            server.enqueue_session_sync(db, {"id": "SES-MULTIPART"}, files)
            db.commit()
        first = server.claim_sync_job()
        checkpoint = server.checkpoint_sync_multipart(
            first["id"], "file-large", "upload-safe-1", 1, '"etag-1"', 5 * 1024 * 1024, 6 * 1024 * 1024,
        )
        state = checkpoint["progress"]["multipart"]["file-large"]
        self.assertEqual(state["uploadId"], "upload-safe-1")
        self.assertEqual(state["completedParts"], [{"partNumber": 1, "etag": '"etag-1"'}])
        self.assertNotIn("https://", json.dumps(checkpoint))
        server.update_sync_job(first["id"], False, "offline setelah part pertama")
        with sqlite3.connect(server.DB_PATH) as db:
            db.execute("UPDATE sync_queue SET next_attempt_at = ? WHERE id = ?", ("2000-01-01T00:00:00+00:00", first["id"]))
            db.commit()
        retried = server.claim_sync_job()
        self.assertEqual(retried["progress"]["multipart"]["file-large"]["completedParts"][0]["partNumber"], 1)
        server.checkpoint_sync_multipart(
            retried["id"], "file-large", "upload-safe-1", 2, '"etag-2"', 5 * 1024 * 1024, 6 * 1024 * 1024,
        )
        completed = server.checkpoint_sync_file(retried["id"], "file-large")
        self.assertEqual(completed["progress"]["completedFileIds"], ["file-large"])
        self.assertNotIn("file-large", completed["progress"]["multipart"])

    def test_agent_resumes_multipart_from_the_first_missing_part(self):
        raw = b"a" * (6 * 1024 * 1024)
        job = {
            "id": "session.sync:SES-MULTIPART",
            "kind": "session.sync",
            "payload": {
                "session": {"id": "SES-MULTIPART", "shareCode": "share-multipart"},
                "files": [{"id": "file-large", "fileKind": "gif", "contentType": "image/gif", "checksumSha256": hashlib.sha256(raw).hexdigest()}],
            },
            "progress": {
                "multipart": {
                    "file-large": {
                        "uploadId": "upload-resume-1",
                        "partSize": 5 * 1024 * 1024,
                        "totalSize": len(raw),
                        "completedParts": [{"partNumber": 1, "etag": '"etag-1"'}],
                    }
                }
            },
        }
        config = {"cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080", "machineId": "machine-1", "agentToken": "token"}
        prepared = {"mode": "multipart-object-storage", "uploadId": "upload-resume-1", "partSize": 5 * 1024 * 1024, "totalParts": 2, "resumed": True}
        part = {"upload": {"url": "https://bucket.test/part-2", "headers": {}}}
        controller_results = [
            {"job": job},
            {"checkpoint": {"progress": job["progress"]}},
            {"checkpoint": {}},
            {"job": {"status": "completed"}},
        ]
        with mock.patch.object(agent, "controller_request", side_effect=controller_results) as controller, \
             mock.patch.object(agent, "controller_raw_request", return_value={"contentType": "image/gif", "bodyBase64": base64.b64encode(raw).decode("ascii")}), \
             mock.patch.object(agent, "request_json", side_effect=[{}, prepared, part, {}, {}]) as cloud, \
             mock.patch.object(agent, "upload_presigned_file", return_value='"etag-2"') as upload:
            self.assertTrue(agent.sync_local_outbox_once(config))
        prepare_payload = cloud.call_args_list[1].args[2]
        self.assertEqual(prepare_payload["resumeUploadId"], "upload-resume-1")
        self.assertEqual(cloud.call_args_list[2].args[2]["partNumber"], 2)
        self.assertEqual(len(upload.call_args.args[1]), 1024 * 1024)
        multipart_checkpoint = controller.call_args_list[1]
        self.assertEqual(multipart_checkpoint.args[1], "/api/local/sync/multipart")
        self.assertEqual(multipart_checkpoint.args[3]["partNumber"], 2)
        completion = cloud.call_args_list[3].args[2]
        self.assertEqual(completion["parts"], [{"partNumber": 1, "etag": '"etag-1"'}, {"partNumber": 2, "etag": '"etag-2"'}])
        self.assertIn("sync_session_metadata", cloud.call_args_list[4].args[0])

    def test_sync_queue_lists_progress_and_retries_only_selected_job(self):
        timestamp = server.utc_now()
        payload = json.dumps({"session": {"id": "SES-QUEUE", "shareCode": "share-queue"}, "files": [{"id": "file-a"}, {"id": "file-b"}]})
        progress = json.dumps({"completedFileIds": ["file-a"]})
        with sqlite3.connect(server.DB_PATH) as db:
            db.executemany(
                """INSERT INTO sync_queue(
                     id, kind, payload_json, progress_json, status, attempts,
                     last_error, created_at, updated_at
                   ) VALUES (?, 'session.sync', ?, ?, ?, 10, 'offline', ?, ?)""",
                [
                    ("job-selected", payload, progress, "dead", timestamp, timestamp),
                    ("job-other", payload, "{}", "dead", timestamp, timestamp),
                ],
            )
            db.commit()
        listed = {item["id"]: item for item in server.list_sync_jobs()}
        self.assertEqual(listed["job-selected"]["completedFileCount"], 1)
        self.assertEqual(listed["job-selected"]["fileCount"], 2)
        retried = server.retry_sync_job("job-selected")
        self.assertEqual(retried["status"], "pending")
        self.assertEqual(retried["completedFileCount"], 1)
        with sqlite3.connect(server.DB_PATH) as db:
            statuses = dict(db.execute("SELECT id, status FROM sync_queue").fetchall())
        self.assertEqual(statuses, {"job-selected": "pending", "job-other": "dead"})

    def test_agent_skips_files_already_checkpointed_by_controller(self):
        job = {
            "id": "session.sync:SES-RESUME",
            "kind": "session.sync",
            "payload": {
                "session": {"id": "SES-RESUME", "shareCode": "share-resume"},
                "files": [{"id": "file-a"}, {"id": "file-b", "contentType": "image/jpeg"}],
            },
            "progress": {"completedFileIds": ["file-a"]},
        }
        config = {"cloud": "https://cloud.test", "controller": "http://127.0.0.1:8080", "machineId": "machine-1", "agentToken": "token"}
        with mock.patch.object(agent, "controller_request", side_effect=[{"job": job}, {"checkpoint": {}}, {"job": {"status": "completed"}}]) as controller, \
             mock.patch.object(agent, "controller_raw_request", return_value={"contentType": "image/jpeg", "bodyBase64": "/9j/2Q=="}) as local, \
             mock.patch.object(agent, "request_json", side_effect=[{}, RuntimeError("Endpoint tidak ditemukan"), {}, {}]):
            self.assertTrue(agent.sync_local_outbox_once(config))
        local.assert_called_once()
        self.assertIn("file-b", local.call_args.args[1])
        self.assertEqual(controller.call_args_list[-2].args[3]["fileId"], "file-b")

    def test_storage_reserve_blocks_new_session_before_disk_is_full(self):
        with mock.patch.object(server, "disk_metrics", return_value={"totalBytes": 16 * 1024**3, "usedBytes": 15 * 1024**3, "freeBytes": 1 * 1024**3, "usedPercent": 93.8}):
            safety = server.storage_safety(server.photo_root())
            self.assertTrue(safety["blocked"])
            with self.assertRaisesRegex(ValueError, "Ruang foto kritis"):
                server.create_photo_session()
        with mock.patch.object(server, "disk_metrics", return_value={"totalBytes": 16 * 1024**3, "usedBytes": 13 * 1024**3, "freeBytes": 3 * 1024**3, "usedPercent": 81.3}):
            warning = server.storage_safety(server.photo_root())
            self.assertEqual(warning["state"], "warning")
            self.assertFalse(warning["blocked"])
            self.assertIn("kurang dari 20%", warning["message"])

    def test_signed_offline_policy_transitions_and_disables_qris_offline(self):
        base = 1_800_000_000.0
        online = server.refresh_offline_policy_lease({"qrisAllowed": True}, now=base)
        self.assertEqual(online["state"], "online")
        self.assertTrue(online["qrisAllowed"])
        normal = server.offline_policy_status(base + 60 * 60)
        warning = server.offline_policy_status(base + 25 * 60 * 60)
        critical = server.offline_policy_status(base + 49 * 60 * 60)
        blocked = server.offline_policy_status(base + 73 * 60 * 60)
        self.assertEqual(normal["state"], "normal")
        self.assertFalse(normal["qrisAllowed"])
        self.assertEqual(warning["state"], "warning")
        self.assertEqual(critical["state"], "critical")
        self.assertEqual(blocked["state"], "blocked")
        self.assertFalse(blocked["allowNewSession"])
        self.assertTrue(blocked["allowActiveSessionFinish"])

    def test_tampered_offline_policy_is_rejected(self):
        server.refresh_offline_policy_lease({"qrisAllowed": True}, now=1_800_000_000.0)
        with sqlite3.connect(server.DB_PATH) as db:
            lease = json.loads(db.execute("SELECT value_json FROM local_state WHERE key = ?", (server.OFFLINE_POLICY_STATE_KEY,)).fetchone()[0])
            lease["payload"]["expiresAt"] += 999_999
            db.execute("UPDATE local_state SET value_json = ? WHERE key = ?", (json.dumps(lease), server.OFFLINE_POLICY_STATE_KEY))
            db.commit()
        status = server.offline_policy_status(1_800_000_100.0)
        self.assertEqual(status["state"], "invalid")
        self.assertFalse(status["allowNewSession"])

    def test_agent_refreshes_controller_policy_after_cloud_heartbeat(self):
        config = {"controller": "http://127.0.0.1:8080", "installationToken": "local"}
        heartbeat = {"serverTime": "2027-01-15T08:00:00Z", "offlinePolicy": {"accessEnabled": True, "qrisAllowed": True}}
        with mock.patch.object(agent, "controller_request", return_value={"state": "online"}) as request:
            agent.refresh_offline_policy(config, heartbeat)
        self.assertEqual(request.call_args.args[1], "/api/local/offline-policy/refresh")
        self.assertTrue(request.call_args.kwargs["protected"])

    def test_blocked_policy_rejects_new_session_but_active_session_can_finish(self):
        server.refresh_offline_policy_lease({"qrisAllowed": True}, now=time.time())
        server.save_settings({"booth": {"photoSlotsPerSession": 1}, "appearance": {"framePhotoSlots": {"clean-white": 1}}})
        with mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            session = server.create_photo_session()
        self.register_selected_capture(session, color="#333333")
        blocked = {"allowNewSession": False, "allowActiveSessionFinish": True, "message": "Offline lebih dari 72 jam"}
        with mock.patch.object(server, "offline_policy_status", return_value=blocked), \
             mock.patch.object(server, "storage_safety", return_value={"blocked": False, "warning": False, "message": "Penyimpanan siap"}):
            with self.assertRaisesRegex(ValueError, "Offline lebih dari 72 jam"):
                server.create_photo_session()
            completed = server.complete_photo_session(session["id"])
        self.assertEqual(completed["status"], "completed")

    def test_qris_is_rejected_without_fresh_cloud_lease(self):
        server.save_settings({"payment": {"qrisEnabled": True, "provider": "Xendit"}})
        with self.assertRaisesRegex(ValueError, "QRIS tidak tersedia saat cloud offline"):
            server.request_qris_payment("access")

    def test_cleanup_preview_is_dry_run_and_unsynced_files_are_always_protected(self):
        server.save_settings({"booth": {"localRetentionHours": 1}, "storage": {"deleteOnlyAfterUpload": False}})
        root = server.photo_root()
        uploaded = root / "uploaded.jpg"
        unsynced = root / "unsynced.jpg"
        outside = Path(self.temp.name) / "outside.jpg"
        for path in (uploaded, unsynced, outside):
            path.write_bytes(b"photo")
            old = time.time() - 7200
            path.touch()
            path.chmod(0o600)
            os.utime(path, (old, old))
        now = server.utc_now()
        with sqlite3.connect(server.DB_PATH) as db:
            db.executemany(
                """INSERT INTO photo_files(id, path, uploaded_at, created_at)
                   VALUES (?, ?, ?, ?)""",
                [
                    ("uploaded", uploaded.name, now, now),
                    ("unsynced", unsynced.name, None, now),
                    ("outside", "../outside.jpg", now, now),
                ],
            )
            db.commit()

        preview = server.storage_cleanup(dry_run=True)
        self.assertEqual(preview["photos"]["candidateFiles"], 1)
        self.assertEqual(preview["protectedUnsyncedFiles"], 1)
        self.assertTrue(uploaded.exists())
        self.assertTrue(unsynced.exists())
        self.assertTrue(outside.exists())

        result = server.storage_cleanup(dry_run=False)
        self.assertEqual(result["photos"]["deletedFiles"], 1)
        self.assertFalse(uploaded.exists())
        self.assertTrue(unsynced.exists())
        self.assertTrue(outside.exists())
        with sqlite3.connect(server.DB_PATH) as db:
            remaining = {row[0] for row in db.execute("SELECT id FROM photo_files").fetchall()}
        self.assertEqual(remaining, {"unsynced", "outside"})

    def test_thumbnail_and_gif_cache_limits_remove_oldest_files(self):
        originals = (server.THUMBNAIL_CACHE_MAX_BYTES, server.GIF_CACHE_MAX_BYTES)
        server.THUMBNAIL_CACHE_MAX_BYTES = 10
        server.GIF_CACHE_MAX_BYTES = 10
        try:
            for folder, prefix in ((server.thumbnail_cache_root(), "thumb"), (server.gif_cache_root(), "gif")):
                for index in range(3):
                    path = folder / f"{prefix}-{index}.bin"
                    path.write_bytes(b"123456")
                    old = time.time() - (300 - index)
                    os.utime(path, (old, old))
            preview = server.maintain_local_cache(dry_run=True)
            self.assertEqual(preview["groups"]["thumbnails"]["candidateFiles"], 2)
            self.assertEqual(preview["groups"]["gif"]["candidateFiles"], 2)
            self.assertEqual(len(list(server.thumbnail_cache_root().iterdir())), 3)
            executed = server.maintain_local_cache(dry_run=False)
            self.assertEqual(executed["deletedFiles"], 4)
            self.assertLessEqual(sum(path.stat().st_size for path in server.thumbnail_cache_root().iterdir()), 10)
            self.assertLessEqual(sum(path.stat().st_size for path in server.gif_cache_root().iterdir()), 10)
        finally:
            server.THUMBNAIL_CACHE_MAX_BYTES, server.GIF_CACHE_MAX_BYTES = originals

    def test_temporary_files_are_rotated_by_age_without_touching_recent_files(self):
        old_file = server.temporary_root() / "abandoned.tmp"
        recent_file = server.temporary_root() / "active.tmp"
        old_file.write_bytes(b"old")
        recent_file.write_bytes(b"recent")
        os.utime(old_file, (time.time() - server.TEMP_FILE_MAX_AGE_SECONDS - 60,) * 2)
        preview = server.maintain_local_cache(dry_run=True)
        self.assertEqual(preview["groups"]["temporary"]["candidateFiles"], 1)
        self.assertTrue(old_file.exists())
        server.maintain_local_cache(dry_run=False)
        self.assertFalse(old_file.exists())
        self.assertTrue(recent_file.exists())

    def test_companion_pairing_is_one_time_expiring_and_machine_local(self):
        with mock.patch.object(server, "companion_local_address", return_value="http://192.168.1.20:8081"), mock.patch.object(server, "companion_capabilities", return_value={"controller": {"available": True}}):
            pairing = server.create_companion_pairing()
            fragment = pairing["pairingUrl"].split("#", 1)[1]
            values = dict(item.split("=", 1) for item in fragment.split("&"))
            claimed = server.claim_companion_pairing(values["pairing"], values["token"], "iPad Zoe")
            self.assertTrue(server.companion_session_valid(claimed["sessionToken"]))
            self.assertEqual(server.companion_heartbeat(claimed["sessionToken"])["status"], "connected")
            with self.assertRaisesRegex(ValueError, "kedaluwarsa"):
                server.claim_companion_pairing(values["pairing"], values["token"], "replay")
        stored = server.companion_state()
        self.assertNotIn(values["token"], json.dumps(stored))
        self.assertNotEqual(stored["sessionTokenHash"], claimed["sessionToken"])

    def test_companion_storage_test_writes_flushes_and_removes_capture(self):
        encoded = base64.b64encode(self.jpeg_bytes(size=(120, 120))).decode("ascii")
        result = server.companion_storage_test(encoded)
        self.assertTrue(result["ok"])
        self.assertGreater(result["bytes"], 100)
        self.assertGreaterEqual(result["latencyMs"], 0)
        self.assertEqual(list(server.photo_root().rglob(".companion-test/*.jpg")), [])

    def test_companion_pairing_claim_is_atomic_under_concurrency(self):
        with mock.patch.object(server, "companion_local_address", return_value="http://192.168.1.20:8081"):
            pairing = server.create_companion_pairing()
        values = dict(item.split("=", 1) for item in pairing["pairingUrl"].split("#", 1)[1].split("&"))

        def claim(name):
            try:
                return server.claim_companion_pairing(values["pairing"], values["token"], name)["sessionToken"]
            except ValueError as exc:
                return str(exc)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, ["Tablet A", "Tablet B"]))
        successful = [value for value in results if not value.startswith("Kode pairing")]
        rejected = [value for value in results if value.startswith("Kode pairing")]
        self.assertEqual(len(successful), 1)
        self.assertEqual(len(rejected), 1)


class ControllerProcessRecoveryTests(unittest.TestCase):
    """Acceptance coverage that uses a real Controller process and HTTP API."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data_root = Path(self.temp.name) / "controller-data"
        self.port = self.free_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.companion_port = self.free_port()
        self.companion_base_url = f"http://127.0.0.1:{self.companion_port}"
        self.process = None

    def tearDown(self):
        self.stop_controller(force=True)
        self.temp.cleanup()

    @staticmethod
    def free_port():
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            return int(listener.getsockname()[1])

    def start_controller(self, companion=False, extra_environment=None):
        environment = os.environ.copy()
        environment.update({
            "PHOTOSLIVE_DATA_ROOT": str(self.data_root),
            "PHOTOSLIVE_HOST": "127.0.0.1",
            "PHOTOSLIVE_PORT": str(self.port),
            "PHOTOSLIVE_TEST_MODE": "1",
            "PHOTOSLIVE_TEST_DISK_TOTAL_BYTES": str(16 * 1024**3),
            "PHOTOSLIVE_TEST_DISK_FREE_BYTES": str(4 * 1024**3),
            "PHOTOSLIVE_COMPANION_ENABLED": "1" if companion else "0",
            "PHOTOSLIVE_COMPANION_PORT": str(self.companion_port),
            "PHOTOSLIVE_COMPANION_PUBLIC_URL": self.companion_base_url,
        })
        environment.update(extra_environment or {})
        self.process = subprocess.Popen(
            [sys.executable, str(PHOTOBOX_ROOT / "server.py")],
            cwd=PHOTOBOX_ROOT,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail(f"Controller berhenti saat startup dengan kode {self.process.returncode}")
            try:
                payload = self.json_request("/api/health")
                if payload.get("status") == "ok":
                    return
            except (OSError, urllib_error.URLError, json.JSONDecodeError):
                time.sleep(0.05)
        self.fail("Controller tidak siap dalam 10 detik")

    def stop_controller(self, force=False):
        if not self.process or self.process.poll() is not None:
            return
        if force:
            self.process.kill()
        else:
            self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)

    def json_request(self, path, method="GET", payload=None, body=None, headers=None):
        request_headers = dict(headers or {})
        data = body
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib_request.Request(
            f"{self.base_url}{path}", data=data, headers=request_headers, method=method,
        )
        with urllib_request.urlopen(request, timeout=5) as response:
            return json.loads(response.read())

    @staticmethod
    def json_request_to(base_url, path, method="GET", payload=None, headers=None):
        request_headers = dict(headers or {})
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        request = urllib_request.Request(f"{base_url}{path}", data=data, headers=request_headers, method=method)
        with urllib_request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())

    @staticmethod
    def jpeg_bytes():
        stream = BytesIO()
        PILImage.new("RGB", (64, 64), "#275e91").save(stream, "JPEG", quality=85)
        return stream.getvalue()

    def test_companion_listener_claims_once_and_does_not_expose_controller_api(self):
        self.start_controller(companion=True)
        token = self.json_request("/api/local/installation")["token"]
        pairing = self.json_request(
            "/api/local/companion/pairing",
            method="POST",
            payload={},
            headers={"X-Photoslive-Token": token},
        )
        fragment = pairing["pairingUrl"].split("#", 1)[1]
        values = dict(item.split("=", 1) for item in fragment.split("&"))
        status, claimed = self.json_request_to(self.companion_base_url, "/api/companion/claim", method="POST", payload={
            "pairingId": values["pairing"],
            "token": values["token"],
            "deviceName": "Acceptance iPad",
        })
        self.assertEqual(status, 201)
        session_token = claimed["sessionToken"]
        status, heartbeat = self.json_request_to(
            self.companion_base_url,
            "/api/companion/heartbeat",
            method="POST",
            payload={},
            headers={"Authorization": f"Bearer {session_token}"},
        )
        self.assertEqual(status, 200)
        self.assertEqual(heartbeat["status"]["deviceName"], "Acceptance iPad")
        with self.assertRaises(urllib_error.HTTPError) as replay:
            self.json_request_to(self.companion_base_url, "/api/companion/claim", method="POST", payload={
                "pairingId": values["pairing"], "token": values["token"], "deviceName": "Replay",
            })
        self.assertEqual(replay.exception.code, 400)
        with self.assertRaises(urllib_error.HTTPError) as hidden_api:
            self.json_request_to(self.companion_base_url, "/api/settings")
        self.assertEqual(hidden_api.exception.code, 404)

    def test_isolated_test_admin_login_sets_session_and_serves_dynamic_admin_route(self):
        self.start_controller(extra_environment={
            "PHOTOSLIVE_TEST_PASSWORD": "PhotosliveTest2026",
            "PHOTOSLIVE_TEST_BOOTH_CODE": "test-booth",
            "PHOTOSLIVE_TEST_EMAIL": "owner@photoslive.test",
        })
        cookie_jar = http.cookiejar.CookieJar()
        opener = urllib_request.build_opener(urllib_request.HTTPCookieProcessor(cookie_jar))
        login_request = urllib_request.Request(
            f"{self.base_url}/api/platform?action=login",
            data=json.dumps({
                "boothCode": "test-booth",
                "email": "owner@photoslive.test",
                "password": "PhotosliveTest2026",
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with opener.open(login_request, timeout=5) as response:
            login = json.loads(response.read())
        self.assertTrue(login["testMode"])
        self.assertEqual(login["booth"]["boothCode"], "test-booth")
        self.assertTrue(any(cookie.name == "photoslive_test_session" for cookie in cookie_jar))

        with opener.open(f"{self.base_url}/api/platform?action=me", timeout=5) as response:
            current = json.loads(response.read())
        self.assertTrue(current["testMode"])
        self.assertEqual(current["user"]["boothCode"], "test-booth")

        with opener.open(f"{self.base_url}/test-booth/admin", timeout=5) as response:
            admin_html = response.read().decode("utf-8")
        self.assertIn("Kontrol photobox", admin_html)

    def test_test_admin_is_disabled_without_explicit_password(self):
        self.start_controller()
        request = urllib_request.Request(
            f"{self.base_url}/api/platform?action=login",
            data=json.dumps({"boothCode": "test-booth", "email": "owner@photoslive.test", "password": "anything"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib_error.HTTPError) as denied:
            urllib_request.urlopen(request, timeout=5)
        self.assertEqual(denied.exception.code, 404)

    def test_active_session_and_selected_capture_survive_abrupt_process_kill(self):
        self.start_controller()
        created = self.json_request("/api/booth/sessions", method="POST", payload={
            "consent": {"accepted": True, "version": server.PHOTO_CONSENT_VERSION, "method": "welcome_continue"},
        })["session"]
        capture_bytes = self.jpeg_bytes()
        uploaded = self.json_request(
            f"/api/sessions/{created['id']}/capture-upload",
            method="POST",
            body=capture_bytes,
            headers={"Content-Type": "image/jpeg", "X-Slot-Index": "1"},
        )["file"]
        self.json_request(
            f"/api/sessions/{created['id']}/select",
            method="POST",
            payload={"fileId": uploaded["id"]},
        )

        # Simulate a power loss/SIGKILL: no graceful shutdown or in-process
        # migration call may help the recovery path.
        self.stop_controller(force=True)
        self.start_controller()

        recovered = self.json_request(f"/api/sessions/{created['shareToken']}")["session"]
        self.assertEqual(recovered["id"], created["id"])
        self.assertEqual(recovered["status"], "active")
        self.assertEqual(recovered["slots"][0]["selectedFileId"], uploaded["id"])
        self.assertEqual(recovered["slots"][0]["attempts"][0]["id"], uploaded["id"])
        recovered_file = self.data_root / "photos" / uploaded["path"]
        self.assertTrue(recovered_file.is_file())
        self.assertEqual(recovered_file.read_bytes(), capture_bytes)

    def test_session_recovery_http_contract_requires_local_token_and_keeps_capability_local(self):
        self.start_controller()
        created = self.json_request("/api/booth/sessions", method="POST", payload={
            "consent": {"accepted": True, "version": server.PHOTO_CONSENT_VERSION, "method": "welcome_continue"},
        })["session"]
        with self.assertRaises(urllib_error.HTTPError) as denied:
            self.json_request("/api/local/session-recovery")
        self.assertEqual(denied.exception.code, 401)
        token = self.json_request("/api/local/installation")["token"]
        overview = self.json_request("/api/local/session-recovery", headers={"X-Photoslive-Token": token})
        self.assertEqual(overview["sessions"][0]["id"], created["id"])
        self.assertNotIn("shareToken", overview["sessions"][0])
        recovered = self.json_request(
            "/api/local/session-recovery/recover", method="POST",
            payload={"sessionId": created["id"], "extensionSeconds": 180},
            headers={"X-Photoslive-Token": token},
        )
        self.assertEqual(recovered["session"]["status"], "active")
        local = self.json_request("/api/booth/recovery")["session"]
        self.assertEqual(local["shareToken"], created["shareToken"])


if __name__ == "__main__":
    unittest.main()
