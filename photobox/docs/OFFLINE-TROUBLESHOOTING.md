# Operasi offline dan troubleshooting

## Saat internet mati

- Booth memakai cached config dan Controller lokal; tombol mulai tidak menunggu
  heartbeat cloud.
- QRIS disembunyikan. Hanya free/manual mode atau voucher yang sudah
  dialokasikan yang dapat dipakai.
- Foto, attempt, pilihan final, render, print job, dan upload job disimpan lokal.
- Jangan menghapus foto unsynced. Retensi 24 jam baru dimulai setelah upload
  berhasil.

Policy lease: normal sampai 24 jam, warning 24–48 jam, critical 48–72 jam, lalu
sesi baru diblokir. Sesi aktif tetap boleh selesai. Disk bebas di bawah 20%
memberi warning; di bawah 10% atau reserve 2 GB hilang, sesi baru diblokir.

## Tindakan cepat

1. **Tombol mulai lambat:** buka Local Manager, pastikan Controller siap; jangan
   tunggu cloud/Agent di jalur tombol.
2. **Kamera tidak muncul:** tutup aplikasi lain yang memakai kamera, Periksa,
   pilih device aktual, lalu Tes kamera.
3. **Printer gagal:** foto tetap aman; cek print queue, CUPS/IPP, kertas, lalu
   retry job yang gagal.
4. **Setting tidak tersimpan:** lihat error cloud dan correlation ID. Agent
   offline bukan alasan save cloud gagal.
5. **Disk kritis:** tunggu upload, jalankan cleanup preview/dry run, atau pilih
   folder lain; jangan hapus file unsynced.
6. **Sync macet:** lihat queue/dead letter, perbaiki koneksi/provider, lalu retry
   scoped job.

Jika langkah ini gagal, export diagnosis tersensor dan ikuti
`SUPPORT-ESCALATION-GUIDE.md`.
