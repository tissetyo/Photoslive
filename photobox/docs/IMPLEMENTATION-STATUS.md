# Status implementasi local-first

Status dibedakan agar UI dan dokumentasi tidak menganggap prototype sebagai
fitur production.

## Code-complete dan teruji otomatis

- Cloud settings/voucher/assets tidak menunggu Agent.
- Cache booth per tenant dan transisi tombol mulai cache-first.
- Settings snapshot berbasis versi lewat heartbeat 60 detik.
- Voucher cloud cache, atomic redeem offline, dan replay redemption.
- SQLite session/attempt/sync queue serta foto di filesystem.
- Session metadata dan file download cloud dengan expiry 24 jam.
- HMAC remote command, expiry, idempotency, allowlist, dan rate limit.
- Installation token lokal, Local Manager, rotating log, pause/resume/diagnose.
- Owner/Admin/Operator dasar dan audit perubahan.
- Test Python local-first dan syntax test seluruh JavaScript.

## Membutuhkan pilot/perangkat/credential

- QRIS provider nyata dan webhook pembayaran.
- Capture/compositor/print dengan model kamera dan printer produksi.
- Webcam permission dan preview 720p 20–24 FPS pada target mini PC.
- Batas RAM idle 150 MB, total kiosk 1,5 GB, boot 30–60 detik.
- Soak test 72 jam dan recovery storage penuh/kamera sibuk/printer putus.
- Cloud object storage produksi untuk foto, frame besar, hasil kolase, dan GIF.
- Passkey remote dan penghapusan penuh compatibility PIN remote.
- Snapshot kamera remote resolusi rendah dengan consent/expiry.

## Gated dan tidak boleh ditampilkan sebagai aktif

- Signed `.exe`, signed/notarized `.pkg`, paket `.deb` release.
- Atomic updater dengan checksum, rollback, dan rollout superadmin.
- GIF renderer final (halaman sesi saat ini hanya menyediakan flipbook ringan).
- Migrasi data lama otomatis.
- Remote restart ketika Agent offline.

