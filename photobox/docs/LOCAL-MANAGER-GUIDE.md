# Panduan Local Manager

Buka `http://127.0.0.1:8080/local-agent` pada komputer photobox. Surface ini
hanya bind ke loopback dan tidak boleh dipublikasikan ke internet.

## Status

Pastikan Controller, Agent, internet, status registrasi, kamera, printer, folder foto,
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
- **Hubungkan ke akun** membuat QR dan fallback code satu kali hanya ketika
  ditekan. Kode berlaku 15 menit dan Local Manager menampilkan status menunggu,
  berhasil, kedaluwarsa, atau gagal.
- **Buat kode baru/Salin kode/Buka pairing** tersedia selama mesin belum paired.
  Setelah berhasil, mapping booth disimpan lokal dan service tidak meminta
  pairing ulang setelah reboot.
- **Cabut pairing** bukan tindakan Local Manager biasa. Owner/Superadmin
  melakukannya dari cloud dengan re-authentication dan audit log.
- **Hard stop** hanya ada di Advanced dan membutuhkan konfirmasi.

Jika GUI ditutup, service tetap berjalan. Jika service mati, supervisor OS akan
menyalakannya kembali; remote restart tidak mungkin ketika Agent benar-benar
offline.
