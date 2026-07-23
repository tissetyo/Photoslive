# Runbook operator Photoslive

Dokumen ini untuk operator booth. Jangan membuka Terminal, mengubah database,
atau membagikan installation token. Semua tindakan awal dilakukan dari **Local
Manager** di `http://127.0.0.1:8080/local-agent`.

## Sebelum booth dibuka

1. Pastikan status **Controller**, **Agent**, kamera, printer, folder foto, dan
   ruang disk tampil **Siap**.
2. Tekan **Tes kamera** dan **Tes printer**. Gunakan kertas tes, bukan transaksi
   pelanggan.
3. Pastikan antrean upload dan cetak tidak macet.
4. Bila internet mati, pastikan voucher offline tersedia. QRIS memang tidak
   dapat digunakan tanpa internet.
5. Jangan menerima sesi baru bila disk kritis atau Local Manager menampilkan
   larangan sesi.

## Kamera tidak terhubung

1. Pastikan kamera menyala dan kabel tidak longgar.
2. Tutup aplikasi lain yang memakai kamera.
3. Tekan **Periksa perangkat**, pilih nama kamera yang benar, lalu **Tes kamera**.
4. Jika masih gagal, tekan **Restart Controller** sekali dan tunggu status siap.
5. Bila tetap gagal, export diagnosis dan eskalasi. Jangan reinstall Agent saat
   masih ada sesi atau foto yang belum tersinkron.

## Printer tidak terhubung atau cetak macet

1. Pastikan printer menyala, kertas tersedia, dan tidak ada paper jam.
2. Tekan **Periksa perangkat**, pilih printer yang benar, lalu **Tes printer**.
3. Periksa **Antrean cetak**. Retry hanya job yang gagal; jangan membuat sesi
   pelanggan baru untuk mengganti job.
4. Foto tetap tersimpan walau cetak gagal. Berikan link hasil kepada pelanggan.
5. Jika lebih dari satu job gagal, hentikan penerimaan sesi dan eskalasi.

## Internet mati

1. Booth lokal tetap dipakai dari `127.0.0.1`; jangan mengganti ke URL cloud.
2. QRIS akan nonaktif. Gunakan voucher offline yang telah dialokasikan atau mode
   gratis yang sudah disetujui owner.
3. Jangan menghapus antrean upload. Agent akan melanjutkannya setelah reconnect.
4. Jika offline lebih dari 24 jam, ikuti peringatan Local Manager. Setelah 72
   jam, sesi baru diblokir oleh kebijakan keselamatan.

## Disk hampir penuh

1. Hentikan sesi baru jika ruang bebas kurang dari reserve 2 GB atau status
   kritis.
2. Tekan **Preview cleanup**. Pastikan daftar tidak berisi foto `unsynced`.
3. Jalankan cleanup hanya setelah preview aman.
4. Jika ruang tidak pulih, pilih folder baru yang writable atau eskalasi.
5. Jangan menghapus folder sesi dengan file manager.

## Sesi pelanggan terhenti

1. Buka **Session recovery** di admin/Local Manager.
2. Lanjutkan sesi yang masih aktif; jangan membuat sesi pengganti sebelum status
   sesi lama jelas.
3. Jika recovery gagal, simpan/export diagnosis. Foto yang sudah diambil tidak
   boleh dihapus.

## Agent atau Controller bermasalah

- Agent offline tetapi Controller siap: booth lokal tetap dapat bekerja; simpan
  pengaturan cloud tetap boleh dilakukan dari admin remote.
- Controller offline: hentikan sesi baru, tekan **Restart Controller**, lalu
  periksa kamera dan storage.
- **Pause koneksi** hanya menghentikan komunikasi cloud, bukan capture lokal.
- **Hard stop** hanya untuk teknisi dan tidak digunakan selama operasi normal.

## Setelah operasional

1. Pastikan tidak ada sesi aktif.
2. Pastikan upload queue kosong atau terus berkurang.
3. Buat backup database lokal dan cek status berhasil.
4. Catat job cetak gagal, periode offline, atau pergantian perangkat.
5. Jangan mematikan listrik ketika update atau restore berlangsung.

## Bukti untuk eskalasi

Kirim: booth code, waktu kejadian, langkah terakhir, status pada Local Manager,
correlation ID bila ada, hasil **Diagnosis**, dan export log. Jangan kirim API
key, cookie, PIN, password, QRIS secret, atau installation token.
