# Baseline kompatibilitas hardware

Dokumen ini adalah **baseline capability**, bukan daftar perangkat
tersertifikasi. Status `supported` berarti jalur software tersedia; dukungan
model tertentu baru boleh diumumkan setelah acceptance test perangkat nyata.
Kontrak machine-readable berada di
`contracts/hardware-compatibility.json` dan sengaja mempertahankan
`testedDevices: []` sampai pilot ditandatangani operator.

## Matriks platform

| Platform | Agent/Controller | Kamera browser | Kamera dedicated | Silent print | Offline | Status rilis |
| --- | --- | --- | --- | --- | --- | --- |
| Linux computer | Ya | Ya | Bergantung gPhoto2/V4L2 dan model | Ya lewat CUPS/IPP yang kompatibel | Ya | Pilot |
| Windows computer | Ya | Ya | Bergantung driver/model | Bergantung driver/spooler | Ya | Pilot |
| macOS computer | Ya | Ya | Bergantung permission/driver/model | Bergantung driver/CUPS | Ya | Pilot |
| iPad standalone | Tidak | Terbatas browser | Tidak | Tidak; dialog AirPrint | Terbatas | Limited browser |
| Android standalone | Tidak | Terbatas browser | Tidak | Tidak; dialog sistem/vendor | Terbatas | Limited browser |
| Tablet companion | Direncanakan melalui komputer | Terbatas browser | Direncanakan | Direncanakan melalui komputer | Direncanakan | Belum tersedia |

Target minimum komputer adalah dual-core, RAM 4 GB, dan ruang bebas 4 GB.
Linux pilot dapat memakai storage 16 GB. Windows memerlukan minimal 64 GB;
macOS baseline memakai 32 GB. Nilai tersebut bukan jaminan kapasitas event:
operator tetap wajib menghitung jumlah sesi, ukuran foto, GIF, dan antrean
upload.

## Cara perangkat dideteksi

- Webcam browser memakai `MediaDevices`. Izin browser dan kamera yang sedang
  dipakai aplikasi lain dapat membuat deteksi gagal.
- Kamera USB/dedicated memakai adapter OS atau gPhoto2. Terdeteksi oleh USB
  belum berarti capture stabil.
- Printer komputer memakai CUPS/IPP atau spooler OS. Terdeteksi belum berarti
  ukuran kertas, borderless, pemotongan strip, dan 20 print beruntun lulus.
- iPad/Android standalone tidak menjalankan Photoslive Agent. Karena itu USB
  printer, silent print, filesystem penuh, service watchdog, dan telemetry
  sistem tidak boleh ditampilkan sebagai tersedia.

## Gate perangkat nyata

Sebelum model kamera/printer dimasukkan ke `testedDevices`, jalankan probe dan
benchmark pada perangkat target, lalu uji preview, 20 capture, 20 print,
disconnect/reconnect, reboot recovery, sesi offline, dan soak 72 jam. Simpan
model, driver, firmware, adapter, release ID, operator, tanggal, serta laporan
yang telah menyensor secret.

Perangkat yang belum dikenal tetap boleh muncul sebagai kandidat, tetapi UI
harus memakai status **Perlu diperiksa** sampai tes capture atau print berhasil.
Kegagalan satu adapter tidak boleh mengubah klaim menjadi “semua kamera” atau
“semua printer” tidak didukung.
