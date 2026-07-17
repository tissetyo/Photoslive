# Cloud dan akses perangkat mini PC

Dokumen ini adalah syarat deployment Photoslive ke domain publik. Deployment
belum boleh disebut siap produksi jika hanya menampilkan dashboard/booth di
Vercel tetapi belum memiliki Photoslive Agent dan penyimpanan job persisten.

## Keputusan arsitektur

Vercel tidak mengakses port USB, CUPS, `/dev/video*`, disk, RAM, atau Wi-Fi mini
PC secara langsung. Perangkat itu hanya tersedia di sistem operasi tempat
hardware terpasang. Karena itu Photoslive dibagi menjadi dua bagian:

1. **Photoslive Cloud di Vercel**
   - Menyajikan admin dan layar pelanggan melalui HTTPS.
   - Menyimpan konfigurasi, identitas mesin, voucher, sesi, dan antrean job.
   - Menerima status/telemetry dari mesin.
   - Tidak menjalankan `gphoto2`, `ffmpeg`, `lp`, `lpstat`, atau CUPS.
2. **Photoslive Agent di mini PC**
   - Berjalan sebagai service lokal dan otomatis aktif saat mesin menyala.
   - Mendeteksi webcam/kamera foto, printer, disk, RAM, jaringan, dan uptime.
   - Mengambil foto, membuat hasil frame, menyimpan foto lokal 24 jam, dan
     mengirim job ke printer.
   - Membuka koneksi HTTPS keluar ke cloud. Cloud tidak membuka port masuk ke
     mini PC.

Webcam pada laptop, tablet, iPad, Android, Windows, macOS, atau Linux dapat
dipakai langsung oleh booth menggunakan `getUserMedia()`. Browser tetap akan
menampilkan izin kamera untuk domain Photoslive pada pemakaian pertama. Kamera
DSLR/mirrorless dan printer harus melalui Agent.

Pada pemasangan pertama, halaman `/setup` menyediakan installer Agent terpisah
untuk Windows, macOS, dan Linux melalui perintah satu baris yang dapat disalin
ke Terminal atau PowerShell. Installer langsung membuat kode setup setelah
service aktif. Android/iPad dapat menjalankan layar booth dan
kamera browser, tetapi belum dapat menjadi Agent perangkat: printer USB,
DSLR/mirrorless, telemetry mesin, dan pairing tetap memerlukan satu komputer
pendamping Windows, macOS, atau Linux.

## Alur pairing mesin

1. Admin membuka **Mesin > Hubungkan ke cloud** pada mini PC.
2. Agent membuat kode pairing/setup sekali pakai yang berlaku 15 menit.
3. Admin memasukkan kode pada `/setup`. Cloud memvalidasi kode tanpa menghapusnya,
   lalu wizard meminta nama, lokasi, email, dan PIN pemilik.
4. Setelah email dan PIN berhasil disimpan, kode sekali pakai dihapus
   (`pairingCode` menjadi `null`)
   dan `boothCode` permanen digunakan untuk URL tenant.
5. Wizard meminta scan perangkat baru melalui Agent, hanya menampilkan entri
   berstatus `connected`, lalu menyediakan pilihan dan tes untuk setiap model
   kamera/printer yang ditemukan. Placeholder `*-none` tidak boleh ditampilkan
   sebagai tersambung. Langkah perangkat dan frame boleh dilewati.
6. Cloud menerbitkan `machine_id` dan credential khusus mesin.
7. Credential disimpan oleh service lokal dengan permission file terbatas,
   tidak di localStorage dan tidak pernah dikirim ke browser pelanggan.
8. Agent mengirim heartbeat berkala. Dashboard menampilkan status *online*,
   waktu terakhir terhubung, perangkat aktif, dan versi Agent.

Credential harus dapat dicabut dan dirotasi dari admin. Satu credential hanya
berlaku untuk satu `machine_id`.

## Kontrak job perangkat

Cloud memerlukan database/queue persisten. State di memory Vercel Function atau
filesystem runtime tidak boleh dipakai sebagai sumber data utama.

Endpoint minimum:

| Method | Endpoint | Pemakai | Fungsi |
| --- | --- | --- | --- |
| `POST` | `/api/cloud/pairings` | Agent | Membuat kode pairing |
| `POST` | `/api/cloud/pairings/claim` | Admin | Menghubungkan mesin |
| `POST` | `/api/agent/heartbeat` | Agent | Status dan telemetry |
| `POST` | `/api/agent/jobs/claim` | Agent | Mengambil satu job atomik |
| `POST` | `/api/agent/jobs/:id/progress` | Agent | Progres capture/print/upload |
| `POST` | `/api/agent/jobs/:id/complete` | Agent | Hasil sukses |
| `POST` | `/api/agent/jobs/:id/fail` | Agent | Error yang dapat ditindaklanjuti |
| `POST` | `/api/machines/:id/jobs` | Admin/booth | Membuat job perangkat |
| `GET` | `/api/machines/:id/status` | Admin/booth | Membaca status mesin |

Jenis job awal: `camera.capture`, `camera.preview`, `printer.test`,
`printer.print`, `devices.refresh`, `storage.cleanup`, dan `service.restart`.
Job harus memiliki `idempotency_key`, deadline, jumlah percobaan, serta audit
siapa yang membuatnya. Agent hanya boleh mengambil job milik mesinnya sendiri.

Untuk MVP, Agent melakukan long-poll HTTPS dengan backoff. Interval normal 1-2
detik ketika booth aktif dan 10-30 detik ketika idle. Ini lebih mudah dipulihkan
daripada bergantung pada satu koneksi realtime. WebSocket dapat ditambahkan
kemudian tanpa mengubah kontrak job.

## Capture dan print dari domain

### Webcam browser

- Booth meminta permission hanya setelah tindakan pengguna, misalnya setelah
  menekan **Mulai**.
- Domain wajib HTTPS dan response mengizinkan `camera=(self)`.
- UI membedakan `permission denied`, `device not found`, `device busy`, dan
  `device disconnected`.
- Daftar kamera baru boleh ditampilkan setelah permission diberikan.
- Wizard setup menggabungkan kamera hasil heartbeat Agent dan `videoinput` dari
  browser. ID kamera browser yang dipilih disimpan agar booth memakai kamera yang
  sama pada sesi pelanggan.

### Folder foto lokal

- `storage.localPhotoPath` adalah path absolut pada mesin Agent, bukan path pada
  browser admin.
- Controller memvalidasi bahwa folder dapat dibuat dan ditulis sebelum setting
  disimpan. Saat lokasi berubah, folder sesi lama dipindahkan agar referensi file
  relatif dan link unduhan tetap valid.
- `GET /api/storage/overview` mengukur disk dari folder foto aktif dan mengirim
  `localPath`, kapasitas disk, ukuran library, serta RAM tanpa polling berat.
- `POST /api/storage/pick-folder` membuka dialog folder native di komputer Agent:
  `osascript` pada macOS, PowerShell pada Windows, serta `zenity` atau `kdialog`
  pada Linux. Input path manual tetap tersedia sebagai fallback.

### Kamera melalui Agent

- Booth membuat job `camera.capture` untuk mesin yang sedang dipakai.
- Agent menangkap file asli dengan adapter OS yang tersedia.
- Agent mengunggah hasil atau mengembalikan referensi file sesi.
- Preview memakai stream/thumbnail dengan batas frame rate agar mini PC 4 GB
  tetap ringan.

### Printer

- Tidak ada tombol permission printer generik yang dapat menjamin semua model
  printer di browser.
- Booth/admin membuat job `printer.print` atau `printer.test`.
- Agent memvalidasi printer, ukuran kertas, jumlah strip, dan status CUPS/driver
  sebelum menerima job.
- Cloud menampilkan status `queued`, `claimed`, `printing`, `completed`, atau
  `failed`, termasuk pesan error asli dari Agent.

## Mode offline

Booth produksi di mini PC harus memiliki cache/local fallback:

- konfigurasi terakhir yang sudah ditandatangani;
- voucher offline sekali pakai yang dialokasikan untuk mesin tersebut;
- sesi dan foto lokal selama 24 jam;
- antrean upload dan telemetry untuk dikirim ulang saat internet kembali;
- print lokal tetap berjalan jika akses sesi memang diizinkan offline.

Halaman Vercel tidak dapat menggantikan fallback ini ketika internet benar-benar
putus. Karena itu Agent juga perlu dapat menyajikan booth lokal atau memasang PWA
yang sudah dicache.

## Checklist sebelum production

- [ ] UI Photoslive yang sebenarnya menggantikan halaman placeholder Vercel.
- [ ] Database/queue persisten dipilih dan migration dibuat.
- [ ] Pairing, revoke, rotate credential, dan scope per mesin selesai.
- [ ] Agent berjalan sebagai service pada Windows, macOS, dan Linux.
- [ ] Adapter CUPS/Linux dan adapter print Windows/macOS diuji pada hardware.
- [ ] Webcam browser diuji di Chrome/Edge/Safari pada desktop, iPad, dan Android.
- [ ] Kamera foto diuji memakai adapter/protokol yang sesuai OS.
- [ ] Offline voucher, capture, print, restart, dan sinkronisasi diuji.
- [ ] Job idempotent; klik ulang tidak mencetak atau mengambil foto dua kali.
- [ ] Upload menggunakan signed URL dan tidak melewati body Function untuk file
      besar.
- [ ] Dashboard menunjukkan `last_seen_at` dan tidak menganggap mesin online
      hanya karena halaman admin dapat dibuka.
- [ ] Uji end-to-end dilakukan dari domain production pada mini PC sebenarnya.

## Status implementasi saat ini

- Booth sudah dapat meminta kamera browser melalui `getUserMedia()`.
- Controller lokal sudah mendeteksi kamera Linux/gPhoto2 dan printer CUPS serta
  menyediakan endpoint capture/test/print lokal.
- Pairing cloud, authentication Agent, heartbeat, telemetry, dan queue job telah
  tersedia melalui `/api/bridge` dan Photoslive Agent.
- Installer awal tersedia untuk Windows, macOS, dan Linux. Adapter printer serta
  kamera tetap mengikuti kemampuan controller pada setiap OS dan harus diuji
  memakai hardware fisik sebelum dinyatakan production-ready.
