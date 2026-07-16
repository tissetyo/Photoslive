# Alur sesi foto, retake, photo strip, dan cetak

Dokumen ini adalah kontrak antara dashboard admin, aplikasi layar pelanggan,
service kamera, compositor photo strip, printer, dan penyimpanan Photoslive.

## Istilah utama

- **Sesi photobox**: satu akses berbayar atau satu voucher dari mulai sampai hasil
  dicetak.
- **Slot foto**: satu posisi foto di dalam frame photo strip. Frame berisi tiga foto
  berarti satu sesi mempunyai tiga slot.
- **Attempt**: satu hasil jepretan pada suatu slot. Foto awal adalah attempt 1;
  retake pertama adalah attempt 2.
- **Foto final**: tepat satu attempt yang dipilih untuk setiap slot.
- **Photo strip final**: hasil komposisi semua foto final secara vertikal dari
  atas ke bawah dalam satu strip.
- **Lembar cetak**: satu kertas printer, biasanya 4×6, yang dapat memuat dua
  photo strip identik untuk dipotong.

Contoh aturan admin: `photoSlotsPerSession = 3`, `unlimitedRetakes = true`,
`countdownSeconds = 15`, dan `sessionTimeoutSeconds = 150`. Pelanggan harus
menyelesaikan slot 1, 2, dan 3 dalam 150 detik. Setiap attempt selalu diawali
hitung mundur 15 detik dan dapat diulang tanpa batas selama deadline sesi belum
habis. Tiga foto final kemudian disusun vertikal menjadi satu photo strip.

## Pengaturan admin

Semua nilai berikut tersimpan di section `booth` melalui
`PATCH /api/settings/booth`.

| Field | Arti | Batas UI |
| --- | --- | --- |
| `photoSlotsPerSession` | Jumlah posisi foto dalam satu photo strip | 1–8 |
| `unlimitedRetakes` | Jika aktif, retake tidak dibatasi jumlah dan hanya dibatasi waktu sesi | on/off |
| `retakeLimit` | Retake maksimum untuk setiap slot | 0–10 |
| `countdownSeconds` | Hitung mundur sebelum setiap attempt | 1–30 detik |
| `sessionTimeoutSeconds` | Batas waktu seluruh sesi, bukan per slot | 30–1800 detik |
| `printsPerSession` | Jumlah lembar photo strip final | 0–10 |
| `dailySessionLimit` | Sesi baru maksimum per hari | minimal 1 |

Pengaturan printer `devices.stripsPerSheet` menentukan jumlah strip identik di
satu lembar kertas. Nilai umum adalah `2`: satu kertas 4×6 berisi dua strip,
masing-masing memuat foto slot 1, 2, dan 3 secara vertikal.

Kapasitas slot harus sesuai desain frame aktif. Dashboard menyimpan kapasitas
setiap frame di `appearance.framePhotoSlots`. Admin dapat mengaturnya di halaman
**Tampilan**, pada bagian **Frame foto**. Saat frame dipilih, nilai
`booth.photoSlotsPerSession` otomatis mengikuti kapasitas frame tersebut dan
tetap terlihat di **Sesi & pembayaran**. Mengubah jumlah slot dari halaman sesi
juga memperbarui kapasitas frame aktif.

Setiap frame adalah template cetak yang terdiri dari artwork/background dan
susunan slot. Admin menekan **Tambah desain**, memilih PNG, JPG, atau WebP,
lalu menyelesaikan satu modal sederhana: tentukan jumlah foto, geser gambar
untuk memilih area yang dipakai, dan atur zoom bila perlu. File tersebut menjadi
pilihan frame baru, bukan background layar pembuka. Jumlah slot disimpan di
`appearance.framePhotoSlots`, sedangkan posisi dan zoom artwork disimpan di
`appearance.frameBackgroundTransforms`.

Setiap slot foto selalu berbentuk `1:1`. Posisi, lebar, dan rotasi tiap slot
serta opacity dan urutan layer disimpan di `appearance.frameSlotTransforms`.
Susunan awal ditempatkan ke bagian
atas frame sehingga frame tiga foto masih memiliki ruang dekorasi di bawah.
Admin dapat memilih dan menggeser slot langsung pada preview, lalu mengatur
rotasinya. Tombol **Atur semua foto sekaligus** menerapkan pergeseran, ukuran,
rotasi, dan opacity ke seluruh slot tanpa memilih foto satu per satu.
Logo atau stiker tambahan diunggah melalui endpoint
`PUT /api/assets/sticker`; posisi, ukuran, dan rotasinya disimpan per frame di
`appearance.frameStickers`.

Editor memiliki tab **Layer**. Foto 1, Foto 2, dan seterusnya merupakan layer
mandiri, demikian pula setiap logo atau stiker. Operator dapat menaikkan atau
menurunkan layer untuk menentukan apakah stiker berada di atas atau di bawah
foto. Nilai `z` dan `opacity` pada setiap transform menjadi sumber kebenaran
renderer admin, preview printer, dan hasil cetak.

Setiap kartu desain memiliki aksi **Edit desain**. Aksi ini membuka editor yang
sama dan wajib memuat jumlah slot, transform artwork, transform slot, serta
stiker yang sebelumnya disimpan. Menyimpan edit memperbarui konfigurasi frame
tanpa membuat file frame baru.

Semua frame pada satu mesin wajib memakai ukuran fisik yang sama. Sumber
kebenaran ukuran adalah `devices.paperSize`, `devices.printLayout`, dan
`devices.stripsPerSheet` pada halaman **Kamera & printer**. Halaman Tampilan
tidak menyediakan ukuran pixel, rasio khusus, lebar frame, atau pengaturan
lanjutan per desain. Tombol **Atur di printer** membawa operator langsung ke
pengaturan tersebut. Data lama seperti `appearance.frameCanvasSizes` boleh
dipertahankan untuk kompatibilitas, tetapi tidak boleh menentukan ukuran render.

Kartu pilihan frame, preview frame aktif, dan preview printer wajib memakai
renderer template serta rasio printer yang sama. Frame dengan satu slot
menampilkan satu foto; frame dengan lebih dari satu slot menjadi kolase vertikal.
Label jumlah foto hanya ditampilkan sebagai informasi admin dan tidak dicetak
di dalam artwork.

Daftar pilihan frame tidak mempertahankan renderer DOM lengkap untuk setiap
kartu. Dashboard meraster artwork, slot, opacity, rotasi, dan stiker ke thumbnail
WebP kecil di browser, lalu menampilkannya sebagai satu elemen gambar. Renderer
lengkap hanya dipakai pada modal editor dan preview printer. Thumbnail tidak
menambahkan caption atau branding otomatis; logo harus dibuat sebagai layer
logo/stiker di editor. Tombol edit dan hapus disusun vertikal di pojok kanan
thumbnail agar mudah ditemukan tanpa menambah tinggi kartu.

Pengaturan tampilan layar pelanggan disimpan di section `appearance` melalui
`PATCH /api/settings/appearance`. `screenPreset` menentukan resolusi sekaligus
orientasi preview (`1920x1080`, `1366x768`, `1024x768`, `1080x1920`, atau
`768x1024`), sedangkan `screenSizeInches` mencatat ukuran diagonal perangkat.
Ukuran inci tidak menentukan orientasi; operator harus memilih preset sesuai
resolusi Linux pada mesin. Field font, warna, logo, dan background tetap berlaku
untuk preset horizontal maupun vertikal.

Ukuran elemen layar disimpan bersama konfigurasi tersebut:
`headingFontSize` untuk judul, `helperFontSize` untuk instruksi,
`buttonFontSize` untuk teks tombol, dan `logoSizePercent` untuk lebar logo.
Dashboard memberi preview langsung pada setiap perubahan dan aplikasi layar
pelanggan wajib memakai nilai yang sama ketika merender layar pembuka.

Daftar background menampilkan maksimal 10 item per halaman. Pagination hanya
muncul ketika jumlah background melebihi 10 agar halaman tetap ringan pada mini
PC dan tetap mudah dipindai saat aset bertambah banyak.

## Kompatibilitas kamera

Pemilihan kamera berbasis kemampuan protokol, bukan daftar merek, model, atau
sistem operasi. Aplikasi mempunyai dua jalur kamera:

- **Kamera perangkat pelanggan** memakai WebRTC `MediaDevices`. Jalur ini berlaku
  untuk browser modern di Windows, macOS, iPadOS, dan Android. Browser meminta
  izin kamera setelah pelanggan menekan tombol mulai, kemudian mengirim JPEG ke
  `POST /api/sessions/:id/capture-upload`.
- **Kamera controller** dipakai ketika kamera terhubung langsung ke mini PC:

- Webcam USB UVC muncul sebagai `/dev/video*` dan memakai V4L2 melalui FFmpeg.
- DSLR atau mirrorless yang mendukung tethering memakai gPhoto2/PTP.

Dropdown kamera, tombol **Cek kamera**, preview, dan capture wajib memakai nilai
`devices.preferredCamera` yang sama. Jika nilainya `auto`, service memilih kamera
aktif pertama. `GET /api/devices/camera/preview.jpg` mengambil frame ringan untuk
admin, sedangkan `POST /api/devices/camera/capture` mengambil JPEG untuk alur
sesi. Preview dimatikan secara eksplisit ketika tidak dipakai agar webcam dan CPU
mini PC tidak terus aktif.

`POST /api/booth/client` menerima heartbeat kemampuan perangkat pelanggan:
platform, user agent, resolusi, pixel ratio, touchscreen, mode PWA, dan nama
kamera yang telah diberi izin. Admin membacanya melalui `GET /api/booth/clients`
dan bagian **Perangkat layar pelanggan**. Data ini bersifat runtime dan tidak
menyimpan foto atau identifier pribadi perangkat.

WebRTC kamera hanya tersedia dalam secure context. `localhost` dapat dipakai
untuk pengembangan, tetapi iPad/tablet yang membuka alamat IP mini PC wajib
menggunakan HTTPS. Deployment produksi harus menempatkan service di belakang
reverse proxy TLS atau memasangnya sebagai PWA HTTPS.

Pada Linux, webcam memerlukan FFmpeg dan izin baca `/dev/video*` untuk user
service (biasanya group `video`). Kamera foto memerlukan `gphoto2`, mode PTP, dan
tidak boleh sedang dikunci aplikasi lain. Error dari dependency atau permission
wajib diteruskan ke admin agar operator mengetahui tindakan perbaikannya.

Aplikasi pelanggan wajib memakai snapshot `rules.photoSlots` dari respons
pembuatan sesi, bukan membaca setting admin berulang kali.

## Voucher sekali pakai dan voucher event

Semua voucher hanya berlaku untuk tepat satu sesi. Voucher yang sudah ditukar
tetap disimpan di database dengan `redeemed_at` agar tidak dapat digunakan
kembali, tetapi tidak lagi ditampilkan pada daftar voucher aktif di dashboard.

Ada dua jenis voucher:

- **Voucher umum** tidak mempunyai nama paket dan tidak kedaluwarsa. Voucher ini
  selalu memberi satu sesi beserta hak cetak.
- **Voucher event** terhubung ke satu event. Event menyimpan nama, waktu
  berakhir, serta pilihan `includesPrint`. Setelah event berakhir, seluruh kode
  aktif milik event tersebut tidak dapat ditukar dan tidak dihitung sebagai
  voucher aktif.

Tombol **Generate 100** selalu menambahkan batch baru, bukan mengganti kode yang
sudah ada. Menekan tombol tiga kali menghasilkan 300 kode. Dashboard hanya
merender 100 kode aktif terbaru agar tetap ringan, sedangkan halaman cetak
memuat seluruh kode aktif pada kelompok yang dipilih. Operator dapat mencetak
voucher umum secara terpisah atau mencetak hanya kode milik satu event.

Kontrak endpoint voucher:

| Method dan endpoint | Fungsi |
| --- | --- |
| `GET /api/vouchers` | Daftar aktif terbaru, ringkasan, dan daftar event |
| `POST /api/vouchers` | Membuat satu voucher umum dengan kode otomatis/manual |
| `POST /api/vouchers/generate` | Menambah batch; body `count` dan opsional `eventId` |
| `POST /api/vouchers/redeem` | Menukar kode satu kali secara atomik |
| `POST /api/voucher-events` | Membuat event dengan `name`, `expiresAt`, `includesPrint` |
| `GET /api/vouchers/print` | Halaman cetak voucher umum |
| `GET /api/vouchers/print?eventId=...` | Halaman cetak satu event |

Proses akses pelanggan wajib memanggil `POST /api/vouchers/redeem` sebelum
membuka sesi. Respons `includesPrint` menjadi sumber kebenaran apakah sesi
tersebut boleh masuk antrean printer. Pemeriksaan kode dan penandaan terpakai
dilakukan dalam satu transaksi agar dua pelanggan tidak dapat memakai kode yang
sama secara bersamaan.

## User flow pelanggan

UI pelanggan tersedia di `/booth` dan dibagi menjadi empat screen utama. Screen
kamera memakai beberapa state agar perpindahan tetap cepat dan preview kamera
tidak perlu dimatikan lalu dinyalakan ulang.

1. **Welcome** menampilkan logo, welcome message, instruksi, background, font,
   warna, dan satu tombol mulai. Semua nilainya berasal dari pengaturan Tampilan
   admin sehingga layar pelanggan dan preview admin selalu sama. Setelah tombol
   ditekan, modal akses full-screen hanya menampilkan metode yang aktif:
   `payment.qrisEnabled` untuk QRIS dan `payment.voucherEnabled` untuk voucher.
   Jika keduanya mati, modal dilewati dan pilihan frame langsung dibuka.
2. **Pilih frame** mulai menyalakan preview kamera aktual. Pelanggan dapat melihat
   posisi tubuh sambil memilih desain. Sesi backend baru dibuat setelah pelanggan
   menekan lanjut agar orang yang hanya melihat-lihat tidak mengurangi batas sesi
   harian. `frameId` yang dipilih menentukan jumlah slot foto sesi. Daftar hanya
   merender 8 frame per halaman pada layar horizontal atau 4 pada layar vertikal;
   tombol sebelumnya/berikutnya menjaga koleksi besar tetap ringan.
3. **Kamera** mula-mula menampilkan preview full-screen yang diburamkan dengan
   overlay gelap 30 persen dan tombol ketuk untuk mulai. Setelah ditekan, countdown
   15 detik berjalan. Pada state pengambilan, slot kosong terlihat di HUD; setiap
   hasil dapat dipakai atau di-retake tanpa batas selama timer sesi tersedia.
   Countdown 15 detik berjalan lagi sebelum setiap attempt. Panel keputusan hasil
   tetap berukuran kecil di pojok kiri bawah agar preview kamera tidak tertutup.
4. **Hasil** menampilkan seluruh foto final di dalam frame terpilih, animasi
   perayaan ringan, tombol cetak, dan tombol selesai. Toggle
   `payment.paidPrintEnabled` menentukan apakah tombol cetak membuka pembayaran
   QRIS tambahan. Jika mati, hasil langsung dikirim ke antrean printer. Voucher
   dengan `includesPrint=true` juga melewati pembayaran cetak. Sesudah selesai
   muncul modal goodbye selama 15 detik; pelanggan dapat menunggu atau menekan
   **Lewati dan kembali sekarang** untuk langsung kembali ke Welcome.

Timer 2 menit 30 detik memakai `deadlineAt` dari server, mulai saat sesi dibuat di
akhir pemilihan frame, dan tetap berlaku melewati screen Kamera hingga Hasil.
Kehabisan waktu menghentikan preview serta menutup sesi tanpa mencetak hasil
sebagian.

Jika deadline habis sebelum seluruh slot selesai, UI menghentikan kamera,
menandai sesi expired, dan tidak mencetak photo strip sebagian. Admin dapat memulai
sesi pengganti sesuai kebijakan operasional.

## Kontrak API

### Membuat sesi

`POST /api/booth/sessions`

Body opsional memilih frame yang sudah tersedia:

```json
{ "frameId": "party-night" }
```

Contoh bagian penting respons:

```json
{
  "session": {
    "id": "SES-20260716-120000-AB12",
    "status": "active",
    "deadlineAt": "2026-07-16T05:03:00+00:00",
    "rules": {
      "photoSlots": 3,
      "retakeLimitPerSlot": 1,
      "maxAttemptsPerSlot": 2,
      "timeoutSeconds": 150,
      "countdownSeconds": 3,
      "prints": 1,
      "stripsPerSheet": 2,
      "printLayout": "photo-strip-vertical"
    },
    "slots": [
      { "index": 1, "status": "pending", "attempts": [], "selectedFileId": null },
      { "index": 2, "status": "pending", "attempts": [], "selectedFileId": null },
      { "index": 3, "status": "pending", "attempts": [], "selectedFileId": null }
    ]
  }
}
```

### Mengambil foto dari kamera aktif

`POST /api/sessions/:id/capture`

```json
{ "slotIndex": 1 }
```

Backend mengambil JPEG dari adapter kamera aktif, menentukan nomor attempt secara
otoritatif, menyimpan file di folder sesi, lalu mengembalikan URL lokal foto.
Webcam UVC/V4L2 dan kamera gPhoto2/PTP memakai endpoint yang sama.

### Mendaftarkan attempt dari service eksternal

File harus sudah berada di penyimpanan lokal `photobox/data/photos`.

`POST /api/sessions/:id/files`

```json
{
  "path": "SES-20260716-120000-AB12/slot-1-attempt-2.jpg",
  "slotIndex": 1,
  "attemptNumber": 2,
  "selected": false
}
```

Backend menolak slot di luar kapasitas frame, attempt di atas batas retake,
sesi nonaktif, file yang tidak ada, dan sesi yang melewati deadline.

### Memilih foto final sebuah slot

`POST /api/sessions/:id/select`

```json
{ "fileId": "uuid-file-attempt" }
```

Memilih file baru otomatis membatalkan pilihan sebelumnya pada slot yang sama.

### Menyelesaikan sesi

`POST /api/sessions/:id/complete`

Endpoint hanya berhasil jika setiap slot mempunyai satu foto final. Respons
`compositeInput` sudah diurutkan berdasarkan `slotIndex` dan harus dipakai oleh
compositor serta antrean cetak.

### Endpoint khusus layar pelanggan

| Method dan endpoint | Fungsi |
| --- | --- |
| `GET /api/booth/config` | Konfigurasi tampilan aman, frame, pembayaran, dan perangkat |
| `POST /api/booth/sessions` | Membuat sesi setelah frame dipilih |
| `POST /api/sessions/:id/capture` | Mengambil dan menyimpan satu attempt |
| `POST /api/sessions/:id/select` | Memilih attempt final untuk satu slot |
| `POST /api/sessions/:id/complete` | Memvalidasi semua slot dan menutup pengambilan |
| `POST /api/booth/qris` | Membuat permintaan pembayaran cetak ketika QRIS aktif |
| `POST /api/booth/print` | Mengirim sesi selesai ke antrean cetak |
| `GET /api/session-files/:id` | Menampilkan foto sesi lokal tanpa membuka path filesystem |

Endpoint QRIS tidak boleh menghasilkan QR palsu. Jika credential provider belum
diatur, UI menampilkan alasan konkret dan cetak tetap terkunci. Setelah adapter
provider tersedia, callback pembayaran harus menandai transaksi lunas sebelum
`/api/booth/print` menerima pekerjaan.

## Struktur penyimpanan yang direkomendasikan

```text
photos/
└── SES-20260716-120000-AB12/
    ├── captures/
    │   ├── slot-1-attempt-1.jpg
    │   ├── slot-1-attempt-2.jpg
    │   ├── slot-2-attempt-1.jpg
    │   └── slot-3-attempt-1.jpg
    └── final/
        ├── strip.jpg
        └── print-sheet.jpg
```

Mode **Upload hasil akhir saja** hanya mengunggah hasil final `strip.jpg` dan
`print-sheet.jpg`. Jika dimatikan, seluruh attempt dan hasil final diunggah. Penghapusan lokal tetap
mengikuti retensi dan opsi hapus hanya setelah upload berhasil.

## Aturan implementasi penting

- Timer memakai `deadlineAt` dari server untuk mencegah reset karena refresh UI.
- Setting admin disnapshot saat sesi dibuat; jangan mengubah aturan sesi aktif.
- Kapasitas foto disimpan per frame; memilih frame harus menyinkronkan jumlah
  slot untuk sesi berikutnya.
- Retake dihitung per slot, bukan untuk seluruh sesi.
- Hanya satu attempt terpilih per slot.
- Photo strip tidak boleh dibuat jika jumlah foto final kurang dari jumlah slot.
- Satu sesi menghasilkan satu desain strip. Strip dapat digandakan dua kali
  pada satu lembar dan lembar yang sama dapat dicetak lebih dari sekali.
- Attempt tidak dihitung sebagai sesi baru dan tidak meminta pembayaran ulang.
- Semua file menggunakan ID sesi yang sama agar monitoring, link unduhan, upload,
  cleanup, dan audit tetap konsisten.
