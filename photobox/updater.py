"""Atomic, signed updater for the Photoslive local runtime.

The updater intentionally uses only Python's standard library. Release manifests
are signed with RSA PKCS#1 v1.5 + SHA-256 and pin the digest of every file in the
archive. The private key never ships with the Agent.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import py_compile
import shutil
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


MAX_MANIFEST_BYTES = 256 * 1024
MAX_BUNDLE_BYTES = int(os.environ.get("PHOTOSLIVE_UPDATE_MAX_BYTES", str(128 * 1024 * 1024)))
DIGEST_INFO_SHA256 = bytes.fromhex("3031300d060960864801650304020105000420")


class UpdateError(RuntimeError):
    """An update failed without exposing secrets or arbitrary response data."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def update_root(data_root: Path) -> Path:
    return data_root / "updates"


def status_path(data_root: Path) -> Path:
    return update_root(data_root) / "status.json"


def manifest_path(data_root: Path) -> Path:
    return update_root(data_root) / "verified-manifest.json"


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return fallback


def write_status(data_root: Path, state: str, **details: Any) -> dict[str, Any]:
    payload = {"state": state, "updatedAt": utc_now(), **details}
    atomic_json(status_path(data_root), payload)
    return payload


def update_status(data_root: Path, current_version: str) -> dict[str, Any]:
    payload = read_json(status_path(data_root), {})
    if not isinstance(payload, dict) or not payload:
        configured = bool(os.environ.get("PHOTOSLIVE_UPDATE_MANIFEST_URL") and public_key_configured())
        return {
            "state": "current" if configured else "not-configured",
            "currentVersion": current_version,
            "message": "Periksa update untuk mencari versi baru" if configured else "Channel update belum dikonfigurasi",
            "rollbackAvailable": latest_backup(data_root) is not None,
        }
    payload["currentVersion"] = current_version
    payload["rollbackAvailable"] = latest_backup(data_root) is not None
    return payload


def canonical_manifest(manifest: dict[str, Any]) -> bytes:
    unsigned = {key: value for key, value in manifest.items() if key != "signature"}
    return json.dumps(unsigned, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def decode_base64url(value: str) -> bytes:
    clean = str(value or "").strip()
    return base64.urlsafe_b64decode(clean + "=" * (-len(clean) % 4))


def load_public_key(path: Path | None = None) -> dict[str, Any]:
    inline = os.environ.get("PHOTOSLIVE_UPDATE_PUBLIC_KEY", "").strip()
    key_path = path or (Path(os.environ["PHOTOSLIVE_UPDATE_PUBLIC_KEY_PATH"]).expanduser() if os.environ.get("PHOTOSLIVE_UPDATE_PUBLIC_KEY_PATH") else None)
    try:
        payload = json.loads(inline) if inline else read_json(key_path, {}) if key_path else {}
    except (ValueError, TypeError) as exc:
        raise UpdateError("Public key update tidak valid") from exc
    if not isinstance(payload, dict) or not payload.get("n"):
        raise UpdateError("Public key update belum dikonfigurasi")
    try:
        modulus = int.from_bytes(decode_base64url(str(payload["n"])), "big")
        exponent = int(payload.get("e") or 65537)
    except (ValueError, TypeError) as exc:
        raise UpdateError("Public key update tidak valid") from exc
    if modulus.bit_length() < 2048 or exponent < 3 or exponent % 2 == 0:
        raise UpdateError("Public key update tidak memenuhi minimum RSA-2048")
    return {"n": modulus, "e": exponent, "keyId": str(payload.get("keyId") or "default")[:80]}


def public_key_configured() -> bool:
    try:
        load_public_key()
        return True
    except UpdateError:
        return False


def verify_manifest_signature(manifest: dict[str, Any], public_key: dict[str, Any]) -> None:
    try:
        signature = decode_base64url(str(manifest.get("signature") or ""))
        modulus = int(public_key["n"])
        exponent = int(public_key.get("e") or 65537)
    except (ValueError, TypeError, KeyError) as exc:
        raise UpdateError("Signature manifest update tidak valid") from exc
    length = (modulus.bit_length() + 7) // 8
    if len(signature) != length:
        raise UpdateError("Signature manifest update tidak valid")
    encoded = pow(int.from_bytes(signature, "big"), exponent, modulus).to_bytes(length, "big")
    digest = hashlib.sha256(canonical_manifest(manifest)).digest()
    expected = b"\x00\x01" + b"\xff" * (length - len(DIGEST_INFO_SHA256) - len(digest) - 3) + b"\x00" + DIGEST_INFO_SHA256 + digest
    if not hmac.compare_digest(encoded, expected):
        raise UpdateError("Signature manifest update tidak valid")


def safe_relative_path(value: str) -> Path:
    pure = PurePosixPath(str(value or ""))
    if not value or pure.is_absolute() or ".." in pure.parts or any(part in {"", "."} for part in pure.parts):
        raise UpdateError("Manifest berisi path file yang tidak aman")
    return Path(*pure.parts)


def validate_manifest(manifest: dict[str, Any], public_key: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(manifest, dict) or int(manifest.get("schemaVersion") or 0) != 1:
        raise UpdateError("Versi manifest update tidak didukung")
    version = str(manifest.get("version") or "").strip()
    bundle_url = str(manifest.get("bundleUrl") or "").strip()
    digest = str(manifest.get("sha256") or "").lower()
    files = manifest.get("files")
    if not version or not bundle_url or len(digest) != 64 or not isinstance(files, dict) or not files:
        raise UpdateError("Manifest update tidak lengkap")
    if any(character not in "0123456789abcdef" for character in digest):
        raise UpdateError("Checksum bundle update tidak valid")
    parsed = urllib.parse.urlparse(bundle_url)
    allow_insecure = os.environ.get("PHOTOSLIVE_UPDATE_ALLOW_INSECURE") == "1"
    if parsed.scheme != "https" and not (allow_insecure and parsed.scheme in {"http", "file"}):
        raise UpdateError("Bundle update wajib menggunakan HTTPS")
    for name, file_digest in files.items():
        safe_relative_path(str(name))
        clean_digest = str(file_digest or "").lower()
        if len(clean_digest) != 64 or any(character not in "0123456789abcdef" for character in clean_digest):
            raise UpdateError("Checksum file update tidak valid")
    verify_manifest_signature(manifest, public_key)
    return manifest


def version_tuple(value: str) -> tuple[int, ...]:
    clean = str(value or "0").split("-", 1)[0]
    try:
        return tuple(int(part) for part in clean.split("."))
    except ValueError:
        return (0,)


def download_bytes(url: str, limit: int, timeout: int = 20) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Photoslive-Updater/1"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        length = int(response.headers.get("Content-Length") or 0)
        if length > limit:
            raise UpdateError("File update melebihi batas ukuran")
        body = response.read(limit + 1)
    if len(body) > limit:
        raise UpdateError("File update melebihi batas ukuran")
    return body


def download_file(url: str, target: Path, limit: int, timeout: int = 60) -> str:
    """Stream a release to disk so a small machine never buffers the bundle."""
    request = urllib.request.Request(url, headers={"User-Agent": "Photoslive-Updater/1"})
    digest = hashlib.sha256()
    written = 0
    with urllib.request.urlopen(request, timeout=timeout) as response, target.open("wb") as output:
        length = int(response.headers.get("Content-Length") or 0)
        if length > limit:
            raise UpdateError("File update melebihi batas ukuran")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > limit:
                raise UpdateError("File update melebihi batas ukuran")
            digest.update(chunk)
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return digest.hexdigest()


def check_update(data_root: Path, current_version: str, manifest_url: str | None = None, public_key: dict[str, Any] | None = None) -> dict[str, Any]:
    url = str(manifest_url or os.environ.get("PHOTOSLIVE_UPDATE_MANIFEST_URL") or "").strip()
    if not url:
        raise UpdateError("Channel update belum dikonfigurasi")
    parsed_url = urllib.parse.urlparse(url)
    allow_insecure = os.environ.get("PHOTOSLIVE_UPDATE_ALLOW_INSECURE") == "1"
    if parsed_url.scheme != "https" and not (allow_insecure and parsed_url.scheme in {"http", "file"}):
        raise UpdateError("Manifest update wajib menggunakan HTTPS")
    write_status(data_root, "checking", currentVersion=current_version, message="Memeriksa manifest bertanda tangan")
    try:
        raw = download_bytes(url, MAX_MANIFEST_BYTES)
        manifest = json.loads(raw.decode("utf-8"))
        validate_manifest(manifest, public_key or load_public_key())
        atomic_json(manifest_path(data_root), manifest)
        newer = version_tuple(str(manifest["version"])) > version_tuple(current_version)
        return write_status(
            data_root,
            "ready" if newer else "current",
            currentVersion=current_version,
            availableVersion=str(manifest["version"]),
            message=f"Versi {manifest['version']} siap dipasang" if newer else "Photoslive sudah versi terbaru",
            verified=True,
        )
    except Exception as exc:
        error = exc if isinstance(exc, UpdateError) else UpdateError("Manifest update tidak dapat diperiksa")
        write_status(data_root, "failed", currentVersion=current_version, message=str(error), retryable=True)
        raise error


def verify_archive(archive: Path, manifest: dict[str, Any], staging: Path, archive_digest: str | None = None) -> None:
    if (archive_digest or file_digest(archive)) != str(manifest["sha256"]).lower():
        raise UpdateError("Checksum bundle update tidak cocok")
    expected = {str(name): str(digest).lower() for name, digest in manifest["files"].items()}
    with zipfile.ZipFile(archive) as bundle:
        members = {item.filename: item for item in bundle.infolist() if not item.is_dir()}
        if set(members) != set(expected):
            raise UpdateError("Isi bundle update tidak cocok dengan manifest")
        for name, item in members.items():
            relative = safe_relative_path(name)
            # Unix symlink entries are not accepted.
            if (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise UpdateError("Bundle update tidak boleh berisi symlink")
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with bundle.open(item) as source, target.open("wb") as output:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected[name]:
                target.unlink(missing_ok=True)
                raise UpdateError(f"Checksum file update tidak cocok: {name}")


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def health_check(root: Path, files: dict[str, str]) -> None:
    for name, digest in files.items():
        target = root / safe_relative_path(name)
        if not target.is_file() or file_digest(target) != str(digest).lower():
            raise UpdateError(f"Health check gagal untuk {name}")
        if target.suffix == ".py":
            # Passing an explicit bytecode target keeps the updater independent
            # from the operator account's global Python cache. This matters for
            # sandboxed macOS accounts and read-only home directories.
            compiled = root / ".photoslive-healthcheck" / f"{hashlib.sha256(name.encode('utf-8')).hexdigest()}.pyc"
            try:
                compiled.parent.mkdir(parents=True, exist_ok=True)
                py_compile.compile(str(target), cfile=str(compiled), doraise=True)
            except (OSError, py_compile.PyCompileError) as exc:
                raise UpdateError(f"Health check Python gagal untuk {name}") from exc
            finally:
                compiled.unlink(missing_ok=True)
                try:
                    compiled.parent.rmdir()
                except OSError:
                    pass
        elif target.suffix == ".json":
            try:
                json.loads(target.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise UpdateError(f"Health check JSON gagal untuk {name}") from exc


def latest_backup(data_root: Path) -> Path | None:
    root = update_root(data_root) / "backups"
    candidates = sorted((path for path in root.glob("*") if path.is_dir() and (path / "backup.json").is_file()), reverse=True) if root.exists() else []
    return candidates[0] if candidates else None


def create_backup(data_root: Path, install_root: Path, manifest: dict[str, Any], current_version: str) -> Path:
    backup = update_root(data_root) / "backups" / f"{int(time.time())}-{current_version}"
    backup.mkdir(parents=True, exist_ok=False)
    present: list[str] = []
    absent: list[str] = []
    for name in manifest["files"]:
        relative = safe_relative_path(name)
        source = install_root / relative
        if source.is_file():
            destination = backup / "files" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            present.append(name)
        else:
            absent.append(name)
    atomic_json(backup / "backup.json", {"createdAt": utc_now(), "version": current_version, "present": present, "absent": absent})
    return backup


def restore_backup(backup: Path, install_root: Path) -> dict[str, Any]:
    metadata = read_json(backup / "backup.json", {})
    if not isinstance(metadata, dict) or not isinstance(metadata.get("present"), list) or not isinstance(metadata.get("absent"), list):
        raise UpdateError("Metadata rollback tidak valid")
    for name in metadata["present"]:
        relative = safe_relative_path(name)
        source = backup / "files" / relative
        if not source.is_file():
            raise UpdateError("File backup rollback tidak lengkap")
        destination = install_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".rollback")
        shutil.copy2(source, temporary)
        os.replace(temporary, destination)
    for name in metadata["absent"]:
        target = install_root / safe_relative_path(name)
        if target.is_file():
            target.unlink()
    return metadata


def apply_update(data_root: Path, install_root: Path, current_version: str) -> dict[str, Any]:
    manifest = read_json(manifest_path(data_root), {})
    if not isinstance(manifest, dict):
        raise UpdateError("Periksa update sebelum memasang")
    validate_manifest(manifest, load_public_key())
    if version_tuple(str(manifest["version"])) <= version_tuple(current_version):
        return write_status(data_root, "current", currentVersion=current_version, availableVersion=manifest["version"], message="Photoslive sudah versi terbaru")
    write_status(data_root, "downloading", currentVersion=current_version, availableVersion=manifest["version"], message="Mengunduh bundle terverifikasi")
    backup: Path | None = None
    with tempfile.TemporaryDirectory(prefix="photoslive-update-", dir=str(update_root(data_root))) as temporary_root:
        temporary = Path(temporary_root)
        archive = temporary / "release.zip"
        archive_digest = download_file(str(manifest["bundleUrl"]), archive, MAX_BUNDLE_BYTES, timeout=60)
        staging = temporary / "staging"
        verify_archive(archive, manifest, staging, archive_digest)
        backup = create_backup(data_root, install_root, manifest, current_version)
        write_status(data_root, "installing", currentVersion=current_version, availableVersion=manifest["version"], backup=backup.name, message="Memasang file secara atomik")
        try:
            for name in manifest["files"]:
                relative = safe_relative_path(name)
                source = staging / relative
                destination = install_root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                staged = destination.with_suffix(destination.suffix + ".update")
                shutil.copy2(source, staged)
                os.replace(staged, destination)
            health_check(install_root, manifest["files"])
        except Exception as exc:
            if backup:
                restore_backup(backup, install_root)
            error = exc if isinstance(exc, UpdateError) else UpdateError("Update gagal dan versi sebelumnya dipulihkan")
            write_status(data_root, "rolled-back", currentVersion=current_version, availableVersion=manifest.get("version"), backup=backup.name if backup else None, message=str(error), automatic=True)
            raise error
    return write_status(data_root, "restart-required", currentVersion=current_version, availableVersion=manifest["version"], backup=backup.name if backup else None, verified=True, healthCheck="passed", message="Update terpasang. Restart Agent untuk mengaktifkan versi baru")


def rollback_update(data_root: Path, install_root: Path, current_version: str) -> dict[str, Any]:
    backup = latest_backup(data_root)
    if backup is None:
        raise UpdateError("Belum ada versi backup untuk rollback")
    write_status(data_root, "rolling-back", currentVersion=current_version, backup=backup.name, message="Memulihkan versi sebelumnya")
    metadata = restore_backup(backup, install_root)
    return write_status(data_root, "restart-required", currentVersion=current_version, availableVersion=metadata.get("version"), backup=backup.name, rollback=True, message="Rollback selesai. Restart Agent untuk mengaktifkan versi sebelumnya")
