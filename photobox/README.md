# Photoslive local control

Dashboard admin ringan untuk mini PC Linux. Controller memakai Python 3 dan
Python 3.10+ dan Pillow pada virtual environment terisolasi untuk membuat hasil frame/lembar
cetak; tidak menggunakan Electron, Docker, atau framework frontend berat.

## Menjalankan

```bash
python3 -m venv .venv
.venv/bin/pip install -r photobox/requirements-controller.txt
.venv/bin/python photobox/server.py
```

Buka layar pelanggan di `http://127.0.0.1:8080/booth` dan Local Manager di
`http://127.0.0.1:8080/local-agent`. Admin cloud tetap dapat dibuka dari
komputer lain melalui `/{boothCode}/admin`.

Local Manager juga dapat membuat QR pairing tablet companion pada jaringan
lokal. Listener companion terpisah dan hanya membuka endpoint pairing/status/
tes; panduan serta batas browsernya ada di
[`docs/TABLET-COMPANION.md`](docs/TABLET-COMPANION.md).

Lifecycle update Agent dan rollback lokal dijelaskan di
[`docs/AGENT-UPDATES.md`](docs/AGENT-UPDATES.md).

## Integrasi Linux

- Kamera DSLR/mirrorless: install `gphoto2` dan gunakan mode USB PTP.
- Webcam USB: kernel UVC/V4L2 (`/dev/video*`) serta `ffmpeg` untuk preview dan
  pengambilan frame JPEG. User yang menjalankan service harus memiliki izin
  membaca perangkat video (umumnya melalui group `video`).
- Windows, macOS, iPad, dan Android: layar pelanggan memakai kamera browser
  melalui WebRTC/MediaDevices. Akses dari tablet melalui jaringan harus HTTPS.
- Printer: konfigurasi antrean melalui CUPS agar muncul di `lpstat`.
- Wi-Fi telemetry: NetworkManager/`nmcli`.

Jika utilitas belum tersedia, dashboard tetap berjalan dan menampilkan status
`disconnected` beserta penjelasannya.

## Yang sudah tersedia

- Pengaturan background, frame dan halaman sambutan.
- Slot foto per photo strip, countdown 15 detik per attempt, retake tanpa batas
  selama timer sesi, jumlah cetak, dan batas sesi harian.
- Toggle terpisah untuk QRIS akses sesi, voucher, QRIS print berbayar, cloud
  upload, dan maintenance.
- Deteksi kamera dan printer secara general melalui protokol Linux. Kamera tidak
  di-hardcode per model: webcam memakai adapter UVC/V4L2, sedangkan kamera foto
  memakai adapter gPhoto2/PTP.
- Preview, tes koneksi, dan endpoint capture memakai kamera aktif yang sama.
- Monitoring disk, RAM, sinyal Wi-Fi, uptime, konsumsi sesi/foto/cetak/omzet.
- Activity log, antrean upload/cetak, test-print endpoint dan refresh otomatis.
- Penyimpanan settings atomik dan metadata lokal SQLite.
- UI pelanggan empat screen: Welcome, pilih frame dengan preview kamera, alur
  capture/retake, dan hasil/cetak dengan timer sesi 2:30 serta goodbye 15 detik
  yang dapat dilewati. Tombol Welcome membuka access gate full-screen berdasarkan
  metode QRIS/voucher yang diaktifkan admin.
- Controller membuat `result-frame.jpg` dan `result-print-sheet.jpg` secara
  deterministik dari foto final serta snapshot konfigurasi frame. Metadata dan
  checksum keduanya disimpan di SQLite; hanya hasil pelanggan yang masuk antrean
  upload cloud.
- Antrean print berjalan pada worker terpisah. Booth tidak menunggu CUPS, file
  siap cetak tetap aman bila printer offline, dan job gagal dapat dicoba ulang.
- Paket Agent dibangun dengan allowlist melalui
  `scripts/build-agent-archive.sh`; `.env`, config mesin, database, dan file
  pengembangan tidak boleh masuk archive installer.
- Link hasil pelanggan berakhir maksimal 24 jam. Cleanup cloud fisik memakai
  cron terautentikasi dan pelanggan dapat meminta penghapusan lebih awal;
  salinan lokal dihapus melalui job Agent yang tahan offline hingga tujuh hari.
  Lihat `docs/CLOUD-RETENTION.md` untuk `CRON_SECRET` dan failure mode.
- Quality CI mencakup dependency audit npm/Python dan full-history secret scan;
  aturan operasionalnya ada di `docs/SUPPLY-CHAIN-SECURITY.md`.

Endpoint capture, compositor, dan pengiriman file asli ke CUPS sudah tersedia,
tetapi kualitas, resolusi, kestabilan kamera, margin, serta hasil printer tetap
perlu divalidasi memakai perangkat fisik yang akan dipasang. Integrasi QRIS
masih memerlukan provider production. Adapter R2/S3 sudah memiliki upload
langsung bertanda tangan, tetapi tetap memerlukan credential, bucket, lifecycle,
dan acceptance test terhadap provider production sebelum dinyatakan siap.

## Kontrak aplikasi photobox

Alur pelanggan, aturan slot foto, retake, komposisi photo strip, struktur file, dan
kontrak endpoint dijelaskan di [docs/SESSION-FLOW.md](docs/SESSION-FLOW.md).
Dokumen tersebut menjadi acuan ketika membangun UI pelanggan dan service capture
agar perilakunya selalu sama dengan konfigurasi admin.

Arsitektur domain publik, pairing mini PC, pembagian tanggung jawab Vercel dan
Photoslive Agent, kontrak job perangkat, keamanan, serta checklist production
dijelaskan di [docs/CLOUD-DEVICE-BRIDGE.md](docs/CLOUD-DEVICE-BRIDGE.md). Vercel
tidak boleh dianggap dapat mengakses USB atau CUPS secara langsung; akses
hardware produksi selalu dijalankan Agent pada mesin tempat perangkat terpasang.

## Photoslive Agent

Agent bridge tersedia di `photobox/agent.py`. Agent membuat pairing code,
mengirim heartbeat/telemetry, mengambil job dari cloud, lalu meneruskannya ke
controller lokal di `http://127.0.0.1:8080`.

```bash
python3 photobox/server.py
python3 photobox/agent.py
```

Installer production dapat diunduh dari halaman **Photoslive Agent** pada admin
cloud atau langsung melalui `/downloads/install-linux.sh`,
`/downloads/install-macos.sh`, dan `/downloads/install-windows.ps1`.

## Redesign local-first

- [Arsitektur dan recovery](docs/LOCAL-FIRST-ARCHITECTURE.md)
- [Kontrak seluruh kontrol interaktif](docs/INTERACTION-CONTRACT.md)
- [Inventaris Redis, SQLite, filesystem, browser cache, dan Base64](docs/DATA-INVENTORY.md)
- [Matriks status capability dan gate produksi](docs/PRODUCT-CAPABILITY-MATRIX.md)
- [Status implementasi dan pilot blocker](docs/IMPLEMENTATION-STATUS.md)
- [Konfigurasi dan batas object storage](docs/OBJECT-STORAGE.md)
- [Feature flags dan prosedur rollback](docs/FEATURE-FLAGS.md)
- [Prosedur release dan rollback lintas komponen](docs/RELEASE-ROLLBACK.md)
- [Benchmark dan kontrak kompatibilitas hardware](docs/PERFORMANCE-HARDWARE-BASELINE.md)
- [Matriks capability Linux, Windows, macOS, iPad, dan Android](docs/HARDWARE-COMPATIBILITY.md)
- [Pairing dan batas tablet companion](docs/TABLET-COMPANION.md)
- [Known limitations build saat ini](docs/KNOWN-LIMITATIONS.md)
- [Backup dan restore database lokal](docs/LOCAL-BACKUP-RESTORE.md)
- [Metrik dan observability lokal yang bounded](docs/LOCAL-OBSERVABILITY.md)
- [Fleet health dan incident timeline superadmin](docs/FLEET-HEALTH-INCIDENTS.md)
- [Health backend superadmin](docs/BACKEND-HEALTH.md)
- [Public status page dan projection aman](docs/PUBLIC-STATUS-PAGE.md)
- [Permission matrix control-plane superadmin](docs/PLATFORM-RBAC.md)
- [Threat model dan security gate](docs/THREAT-MODEL.md)
- [Prosedur respons insiden produksi](docs/INCIDENT-RESPONSE.md)
- [Keamanan link hasil pelanggan](docs/CUSTOMER-DOWNLOAD-SECURITY.md)
- [Redaksi log dan diagnosis](docs/LOG-REDACTION.md)
- [Rate limiting autentikasi dan setup](docs/RATE-LIMITING.md)
- [Proteksi CSRF Cloud Platform](docs/CSRF-PROTECTION.md)
- [Proteksi pengambilalihan pairing](docs/PAIRING-TAKEOVER-PROTECTION.md)
- [Persetujuan pemrosesan foto](docs/PHOTO-CONSENT.md)
- [Monitoring dan retry antrean remote superadmin](docs/REMOTE-JOB-QUEUE.md)
- [Payout manual, maker-checker, bukti, ledger, dan recovery](docs/PAYOUTS.md)
- [Target RPO/RTO dan gap disaster recovery](docs/DISASTER-RECOVERY-SLO.md)

Script installer yang ada cocok untuk pilot/teknisi. Paket signed `.exe`,
notarized `.pkg`, `.deb`, passkey, QRIS production, acceptance GIF di mini PC, dan soak test 72
jam belum boleh diklaim production-ready; statusnya dicatat eksplisit agar UI
tidak menampilkan kontrol palsu.
