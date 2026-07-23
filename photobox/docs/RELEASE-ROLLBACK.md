# Prosedur release dan rollback Photoslive

Dokumen ini wajib diisi untuk setiap release. Rollback mengutamakan penghentian
dampak tanpa menghapus data. Jangan menjalankan migrasi turun yang destruktif,
menghapus object, atau menimpa SQLite operator sebagai bagian rollback rutin.

## Manifest release

Catat sebelum rollout:

- release ID dan Git commit;
- deployment URL serta Vercel deployment sebelumnya;
- versi minimum protocol Cloud, Controller, dan Agent;
- feature flag yang berubah beserta nilai sebelumnya;
- migration ID PostgreSQL dan SQLite;
- versi installer Agent, checksum, dan artefak rollback;
- perubahan provider, bucket, webhook, atau environment variable;
- owner rollout, waktu mulai, kelompok pilot, dan batas error.

Manifest dianggap tidak lengkap jika salah satu perubahan state tidak memiliki
nilai atau versi sebelumnya yang dapat dipulihkan.

## Urutan rollout

1. Pastikan backup database dan build sebelumnya dapat diakses.
2. Jalankan test web, Python, audit kontrol, dan pemeriksaan diff.
3. Deploy preview dan lakukan smoke test landing, setup, booth, admin, API, serta
   satu perjalanan data sampai persistence.
4. Aktifkan perubahan melalui feature flag untuk booth pilot terlebih dahulu.
5. Pantau error rate, p95 latency, queue depth, Agent compatibility, storage,
   capture, serta print selama jendela observasi.
6. Perluas rollout hanya jika seluruh batas penerimaan manifest terpenuhi.

## Pemicu rollback

Rollback segera bila ada kehilangan atau kebocoran data, tenant isolation gagal,
booth tidak dapat memulai/menyelesaikan sesi, pembayaran salah, antrean tumbuh
tanpa pemulihan, error P0/P1, atau target error/latency pada manifest terlewati.
Masalah hardware pada satu booth terlebih dahulu diisolasi melalui flag booth
atau maintenance mode agar booth sehat tidak ikut dihentikan.

## Jalur rollback

### Feature flag

Kembalikan override booth, organization, atau global ke nilai sebelumnya. Ini
adalah jalur pertama untuk object upload, provider marketplace, tablet PWA, dan
fitur bertahap. Simpan correlation ID dan alasan pada audit log.

### Web dan Cloud API

Promosikan deployment Vercel terakhir yang sehat. Jangan menjalankan deploy baru
dari working tree yang tidak identik. Setelah promosi, verifikasi endpoint
status, save config, voucher idempotency, booth cached config, dan tenant lain.

### PostgreSQL

Utamakan forward fix atau nonaktifkan dual-write/shadow flag. Migrasi schema baru
wajib backward compatible selama minimal satu release. Restore backup hanya
untuk insiden korupsi/kehilangan data, setelah write dihentikan dan incident
owner menyetujui. Bandingkan checksum dan jumlah record sebelum membuka write.

### Object storage dan provider

Alihkan sesi baru ke provider sebelumnya; object lama tetap readable melalui
metadata asal. Pause migration dan upload worker, tetapi jangan menghapus object
tujuan atau sumber. Lanjutkan setelah checksum dan pointer diverifikasi.

### Controller dan Agent

Installer menyimpan satu versi sehat sebelumnya. Update atomik harus melakukan
health check; bila gagal, supervisor mengaktifkan versi backup dan restart.
Cloud harus menurunkan command ke versi protocol yang didukung atau menonaktifkan
job baru. Jangan mematikan heartbeat ketika akses booth dinonaktifkan.

### SQLite dan sesi lokal

Hentikan sesi baru, izinkan sesi aktif selesai bila aman, backup file SQLite dan
folder sesi, lalu jalankan binary lama yang masih memahami schema tersebut.
Migration SQLite wajib additive; jangan menghapus tabel/kolom dalam satu release.
Outbox dan file unsynced tidak boleh dibersihkan selama rollback.

## Verifikasi setelah rollback

- versi web, Controller, Agent, dan protocol sesuai manifest;
- landing, booth, admin, serta Local Manager terbuka;
- save config dan voucher bekerja tanpa menunggu Agent;
- capture lokal, file hasil, outbox, upload, dan print queue tidak hilang;
- booth offline tetap dapat memakai voucher yang dialokasikan;
- tenant isolation, audit log, dan secret redaction tetap lulus;
- tidak ada object atau foto unsynced yang terhapus;
- incident timeline mencatat pemicu, tindakan, correlation ID, dan hasil.

## Penutupan incident

Release hanya boleh dilanjutkan lagi setelah akar masalah memiliki regression
test, manifest baru dibuat, dan pilot diulang. Bukti rollback, log yang sudah
disensor, hasil checksum, serta keputusan owner disimpan bersama release note.

