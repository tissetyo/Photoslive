import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys

PHOTOBOX_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PHOTOBOX_ROOT))

import server  # noqa: E402


class HardwareSimulatorTests(unittest.TestCase):
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

    def simulator(self, camera="connected", printer="connected"):
        return mock.patch.dict(os.environ, {
            "PHOTOSLIVE_HARDWARE_SIMULATOR": "1",
            "PHOTOSLIVE_SIM_CAMERA_STATE": camera,
            "PHOTOSLIVE_SIM_PRINTER_STATE": printer,
        }, clear=False)

    def test_virtual_camera_and_printer_complete_real_controller_operations(self):
        with self.simulator():
            devices = server.detect_devices()
            self.assertEqual([(item.id, item.status) for item in devices], [
                ("sim-camera", "connected"),
                ("sim-printer", "connected"),
            ])
            camera_ok, camera_message = server.test_camera()
            self.assertTrue(camera_ok, camera_message)
            image_ok, image_bytes, image_error = server.camera_image(capture=True)
            self.assertTrue(image_ok, image_error)
            self.assertGreater(len(image_bytes), 1000)
            self.assertEqual(image_bytes[:2], b"\xff\xd8")
            printer_ok, printer_message = server.test_printer_connection()
            self.assertTrue(printer_ok, printer_message)
            page_ok, page_message = server.print_test_page()
            self.assertTrue(page_ok, page_message)

        records = [json.loads(line) for line in (server.DATA_ROOT / "simulator-print-queue.jsonl").read_text().splitlines()]
        self.assertEqual(records[0]["kind"], "test-page")
        self.assertTrue(Path(records[0]["path"]).is_file())

    def test_busy_camera_is_detected_but_capture_fails_actionably(self):
        with self.simulator(camera="busy"):
            camera = next(item for item in server.detect_devices() if item.kind == "camera")
            self.assertEqual(camera.status, "connected")
            ok, message = server.test_camera()
            self.assertFalse(ok)
            self.assertIn("sedang dipakai", message)
            image_ok, image_bytes, image_error = server.camera_image(capture=True)
            self.assertFalse(image_ok)
            self.assertEqual(image_bytes, b"")
            self.assertIn("sedang dipakai", image_error)

    def test_disconnected_printer_cannot_test_or_enqueue_page(self):
        with self.simulator(printer="disconnected"):
            printer = next(item for item in server.detect_devices() if item.kind == "printer")
            self.assertEqual(printer.status, "disconnected")
            connection_ok, connection_message = server.test_printer_connection()
            self.assertFalse(connection_ok)
            self.assertIn("belum tersambung", connection_message)
            page_ok, page_message = server.print_test_page()
            self.assertFalse(page_ok)
            self.assertIn("belum tersambung", page_message)


if __name__ == "__main__":
    unittest.main()
