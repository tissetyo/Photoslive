# Panduan Local Manager

Buka `http://127.0.0.1:8080/local-agent` pada komputer photobox. Surface ini
hanya bind ke loopback dan tidak boleh dipublikasikan ke internet.

## Status

Pastikan Controller, Agent, internet, pairing, kamera, printer, folder foto,
disk, RAM, version, uptime, sync queue, dan print queue memiliki status nyata.
**Siap** berarti health check lulus; **Perlu diperiksa** dan **Tidak
tersambung** selalu disertai tindakan.

## Tindakan

- **Periksa** memuat status terbaru tanpa mengubah konfigurasi.
- **Pause/Resume koneksi** hanya mengatur sinkronisasi cloud; booth lokal tetap
  berjalan.
- **Restart** merestart service melalui supervisor OS.
- **Update/Rollback** memakai paket signed, checksum, health check, dan versi
  cadangan.
- **Tes perangkat/Pilih folder** memanggil API lokal nyata.
- **Diagnosis/Lihat log** menghasilkan laporan bounded yang menyensor secret.
- **Hard stop** hanya ada di Advanced dan membutuhkan konfirmasi.

Jika GUI ditutup, service tetap berjalan. Jika service mati, supervisor OS akan
menyalakannya kembali; remote restart tidak mungkin ketika Agent benar-benar
offline.
