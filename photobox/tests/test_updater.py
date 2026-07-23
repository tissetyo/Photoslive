import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

PHOTOBOX_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PHOTOBOX_ROOT))

import updater


@unittest.skipUnless(shutil.which("openssl"), "OpenSSL is required to create an ephemeral release fixture")
class SignedUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = self.root / "data"
        self.install = self.root / "install"
        self.install.mkdir()
        self.key = self.root / "release-private.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(self.key)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        modulus = subprocess.check_output(["openssl", "rsa", "-in", str(self.key), "-modulus", "-noout"], text=True).strip().split("=", 1)[1]
        modulus_bytes = int(modulus, 16).to_bytes((len(modulus) + 1) // 2, "big")
        self.public_key = {"n": int(modulus, 16), "e": 65537, "keyId": "test"}
        public_config = {"n": base64.urlsafe_b64encode(modulus_bytes).decode().rstrip("="), "e": 65537, "keyId": "test"}
        self.previous_public_key = os.environ.get("PHOTOSLIVE_UPDATE_PUBLIC_KEY")
        self.previous_insecure = os.environ.get("PHOTOSLIVE_UPDATE_ALLOW_INSECURE")
        os.environ["PHOTOSLIVE_UPDATE_PUBLIC_KEY"] = json.dumps(public_config)
        os.environ["PHOTOSLIVE_UPDATE_ALLOW_INSECURE"] = "1"

    def tearDown(self):
        if self.previous_public_key is None:
            os.environ.pop("PHOTOSLIVE_UPDATE_PUBLIC_KEY", None)
        else:
            os.environ["PHOTOSLIVE_UPDATE_PUBLIC_KEY"] = self.previous_public_key
        if self.previous_insecure is None:
            os.environ.pop("PHOTOSLIVE_UPDATE_ALLOW_INSECURE", None)
        else:
            os.environ["PHOTOSLIVE_UPDATE_ALLOW_INSECURE"] = self.previous_insecure
        self.temporary.cleanup()

    def release(self, body: bytes, version="0.9.0"):
        bundle = self.root / f"release-{version}.zip"
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("agent.py", body)
        manifest = {
            "schemaVersion": 1,
            "version": version,
            "bundleUrl": bundle.as_uri(),
            "sha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
            "files": {"agent.py": hashlib.sha256(body).hexdigest()},
            "publishedAt": "2026-07-22T00:00:00Z",
        }
        canonical = self.root / "manifest.canonical"
        signature = self.root / "manifest.signature"
        canonical.write_bytes(updater.canonical_manifest(manifest))
        subprocess.run(["openssl", "dgst", "-sha256", "-sign", str(self.key), "-out", str(signature), str(canonical)], check=True)
        manifest["signature"] = base64.urlsafe_b64encode(signature.read_bytes()).decode().rstrip("=")
        path = self.root / "manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path, manifest

    def test_signed_update_backup_health_check_and_manual_rollback(self):
        old = b'VERSION = "0.8.0"\n'
        new = b'VERSION = "0.9.0"\n'
        (self.install / "agent.py").write_bytes(old)
        manifest_path, _ = self.release(new)

        checked = updater.check_update(self.data, "0.8.0", manifest_path.as_uri(), self.public_key)
        self.assertEqual(checked["state"], "ready")
        applied = updater.apply_update(self.data, self.install, "0.8.0")
        self.assertEqual(applied["state"], "restart-required")
        self.assertEqual(applied["healthCheck"], "passed")
        self.assertEqual((self.install / "agent.py").read_bytes(), new)
        self.assertTrue(updater.update_status(self.data, "0.8.0")["rollbackAvailable"])

        rolled_back = updater.rollback_update(self.data, self.install, "0.9.0")
        self.assertTrue(rolled_back["rollback"])
        self.assertEqual((self.install / "agent.py").read_bytes(), old)

    def test_invalid_python_triggers_automatic_rollback(self):
        old = b'VERSION = "0.8.0"\n'
        (self.install / "agent.py").write_bytes(old)
        manifest_path, _ = self.release(b"def broken(:\n", version="0.9.1")
        updater.check_update(self.data, "0.8.0", manifest_path.as_uri(), self.public_key)

        with self.assertRaises(updater.UpdateError):
            updater.apply_update(self.data, self.install, "0.8.0")
        self.assertEqual((self.install / "agent.py").read_bytes(), old)
        status = updater.update_status(self.data, "0.8.0")
        self.assertEqual(status["state"], "rolled-back")
        self.assertTrue(status["automatic"])

    def test_tampered_manifest_is_rejected(self):
        manifest_path, manifest = self.release(b'VERSION = "0.9.0"\n')
        manifest["version"] = "9.9.9"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(updater.UpdateError, "Signature"):
            updater.check_update(self.data, "0.8.0", manifest_path.as_uri(), self.public_key)

    def test_manifest_requires_https_outside_explicit_test_mode(self):
        manifest_path, _ = self.release(b'VERSION = "0.9.0"\n')
        os.environ.pop("PHOTOSLIVE_UPDATE_ALLOW_INSECURE", None)
        with self.assertRaisesRegex(updater.UpdateError, "HTTPS"):
            updater.check_update(self.data, "0.8.0", manifest_path.as_uri(), self.public_key)
        os.environ["PHOTOSLIVE_UPDATE_ALLOW_INSECURE"] = "1"


if __name__ == "__main__":
    unittest.main()
