# Photoslive local control

Dashboard admin ringan untuk mini PC Linux. Runtime hanya membutuhkan Python 3
standard library; tidak menggunakan Electron, Docker, atau framework frontend.

## Menjalankan

```bash
python3 photobox/server.py
```

Buka dashboard admin di `http://127.0.0.1:8080` dan layar pelanggan di
`http://127.0.0.1:8080/booth`.

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

Endpoint capture kamera sudah tersedia, tetapi kualitas, resolusi, dan kestabilan
tetap perlu divalidasi memakai perangkat fisik yang akan dipasang. Integrasi QRIS
provider, upload R2/Drive, dan print file asli masih memerlukan credential serta
perangkat fisik untuk validasi.

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
