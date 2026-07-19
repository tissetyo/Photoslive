import hashlib
import hmac
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import sys

PHOTOBOX_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PHOTOBOX_ROOT))

import agent  # noqa: E402
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
        job["payload"] = {"tampered": True}
        self.assertFalse(agent.verify_job_signature({"commandKey": "secret"}, job))

    def test_installation_token_is_file_permission_scoped(self):
        token = server.installation_token()
        self.assertGreaterEqual(len(token), 64)
        self.assertEqual(server.LOCAL_TOKEN_PATH.stat().st_mode & 0o777, 0o600)

    def test_cloud_settings_snapshot_merges_and_persists_version(self):
        updated = server.save_settings({"booth": {"name": "Pilot Jakarta"}, "payment": {"qrisEnabled": False}})
        server.set_local_state("settings_version", 9)
        self.assertEqual(updated["booth"]["name"], "Pilot Jakarta")
        self.assertFalse(server.load_settings()["payment"]["qrisEnabled"])
        with sqlite3.connect(server.DB_PATH) as db:
            value = db.execute("SELECT value_json FROM local_state WHERE key = 'settings_version'").fetchone()[0]
        self.assertEqual(json.loads(value), 9)


if __name__ == "__main__":
    unittest.main()
