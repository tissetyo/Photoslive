# Tindakan manual pemilik Photoslive

Dokumen ini memisahkan pekerjaan yang dapat diselesaikan di repository dari
pekerjaan yang membutuhkan Anda, provider eksternal, atau perangkat nyata.
Sumber status tetap `IMPLEMENTATION-CHECKLIST.md`. Jangan menandai item selesai
hanya karena akun sudah dibuat atau environment variable sudah diisi; health
check dan acceptance test harus ikut lulus.

## Status saat ini

- Checklist kanonis: **505/627 selesai**, **122 terbuka** per 22 Juli 2026.
- Build otomatis sudah memiliki banyak fondasi cloud/local, tetapi belum mature
  production karena migrasi database live, installer signed, acceptance
  hardware, payment/payout live, security review, dan soak test masih terbuka.
- Nilai secret, token Agent, nomor rekening lengkap, API key, dan bukti KYC
  tidak boleh dikirim melalui chat, screenshot, repository, atau log.

## Yang perlu Anda lakukan sekarang

Kerjakan berurutan. Beri tahu developer setelah satu kelompok selesai agar
health check dan acceptance test dapat dijalankan sebelum lanjut.

### 1. Siapkan project Supabase/PostgreSQL

Pemilik: **Anda**. Pendamping: developer.

1. Buat project Supabase khusus Photoslive, pilih region terdekat dengan
   deployment Vercel dan pengguna utama.
2. Simpan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` hanya pada Vercel
   server environment. Service role tidak boleh memiliki prefix public dan
   tidak boleh masuk browser bundle.
3. Jangan mengaktifkan `PHOTOSLIVE_POSTGRES_SHADOW` atau
   `PHOTOSLIVE_POSTGRES_FINANCE` untuk production sebelum migration, backup,
   RLS test, record count, dan restore drill dilakukan bersama. Untuk voucher,
   mulai dari `PHOTOSLIVE_POSTGRES_CLOUD_DATA=dual`; jangan memakai `primary`
   sebelum langkah cutover di `POSTGRES-VOUCHERS.md` lulus. Jalankan migration
   direktori booth lebih dahulu dan ikuti urutan
   `off -> dual -> primary` di `POSTGRES-DIRECTORY.md`; booth/settings primary
   tidak boleh diaktifkan sebelum `npm run migrate:directory`, backup, lalu
   `node scripts/backfill-postgres-directory.mjs --apply --limit=5000`
   menghasilkan `failed: 0`, `mismatched: 0`, dan
   `verified === candidates` dengan checksum dry-run yang sama.
   Untuk settings, mulai dari `PHOTOSLIVE_POSTGRES_SETTINGS=dual` dan ikuti acceptance terpisah
   di `POSTGRES-SETTINGS.md` sebelum mengaktifkan `primary`. Metadata sesi mulai
   dari `PHOTOSLIVE_POSTGRES_SESSIONS=dual` dan wajib mengikuti
   `POSTGRES-SESSIONS.md`; jangan aktifkan primary sebelum recovery manifest,
   signed download, cleanup retry, dan privacy tombstone dua tahap diuji pada staging.
   Metadata aset booth mulai dari `PHOTOSLIVE_POSTGRES_ASSETS=dual` dan wajib
   mengikuti `POSTGRES-ASSETS.md`. Jangan aktifkan `primary` sebelum migration
   live, backfill metadata aset lama, record-count/checksum, cache-recovery,
   two-phase delete retry, serta acceptance R2/S3 lulus tanpa object key privat
   bocor ke client.
4. Tentukan jendela cutover. Penghentian write Redis lama memerlukan approval
   eksplisit Anda setelah report migrasi cocok.

Bukti penutupan: migration report untuk direktori, settings, voucher, sesi, dan
aset; jumlah record lama/baru; RLS test; backup ID; dan hasil restore drill
tanpa menyertakan secret.

### 2. Lengkapi secret dasar Vercel

Pemilik: **Anda**. Pendamping: developer.

Pastikan Production dan Preview yang memang memerlukannya memiliki:

- `SESSION_SECRET` minimal 32 karakter;
- `CRON_SECRET` untuk endpoint terjadwal;
- `PROVIDER_CREDENTIAL_KEYS` dan
  `PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION` untuk vault provider;
- `PAYOUT_VAULT_KEYS` dan `PAYOUT_VAULT_ACTIVE_KEY_VERSION` bila memakai key
  payout terpisah;
- `EMAIL_PAYLOAD_ENCRYPTION_KEYS` untuk payload antrean email;
- bootstrap superadmin sesuai `PLATFORM-STAFF-RBAC.md`.

Gunakan secret manager Vercel. Setelah disimpan, lakukan redeploy dan jalankan
health check. Jangan menyalin nilainya ke dokumen ini.

### 3. Pilih object storage dan atur bucket

Pemilik: **Anda**. Provider: Cloudflare R2 atau S3-compatible.

1. Buat bucket terpisah untuk Photoslive.
2. Buat credential least-privilege yang hanya dapat mengakses bucket tersebut.
3. Pilih salah satu set konfigurasi di `OBJECT-STORAGE.md`.
4. Atur CORS untuk origin admin Photoslive dan upload `PUT`.
5. Atur lifecycle/retention, versioning bila provider mendukung, quota alert,
   dan kebijakan biaya.
6. Jangan migrasikan file lama sebelum PUT/HEAD/GET/DELETE dan checksum test
   lulus.

Bukti penutupan: screenshot kebijakan tanpa secret, provider health ready,
acceptance file, checksum cocok, dan lifecycle test.

### 4. Siapkan email

Pemilik: **Anda**. Provider: Resend atau server SMTP milik Anda.

Untuk Resend:

1. Verifikasi domain pengirim.
2. Buat API key dengan scope minimum.
3. Isi koneksi provider dari superadmin, bukan dari client/Agent.
4. Daftarkan webhook delivery dan simpan secret webhook di vault.

Untuk Custom SMTP:

1. Siapkan host, port, mode TLS, username, password, dan alamat From.
2. Gunakan TLS yang valid; jangan menonaktifkan verifikasi sertifikat.
3. Isi credential melalui provider connection superadmin setelah adapter pada
   build ini lulus seluruh test.

Terakhir, kirim email visual test ke mailbox nyata dan periksa desktop/mobile,
delivered, bounce, complaint, suppression, serta retry. Detail teknis ada di
`EMAIL-DELIVERY.md`.

### 5. Siapkan Xendit sandbox sebelum live

Pemilik: **Anda**. Provider: Xendit.

1. Buat/aktifkan akun bisnis sandbox.
2. Selesaikan data legal/KYC hanya di dashboard resmi Xendit.
3. Buat secret key dan webhook token sandbox; simpan melalui vault provider.
4. Jangan mengaktifkan payment live, XenPlatform, split, atau payout otomatis
   sebelum reconciliation sandbox menghasilkan selisih nol.
5. Untuk payout, siapkan rekening withdrawal terverifikasi dan keputusan mode:
   `MANUAL_SUPERADMIN` dahulu atau auto-payout setelah XenPlatform selesai.

Bukti penutupan: create/status/webhook/refund sandbox, duplicate webhook test,
settlement report, ledger reconciliation nol, dan failed-payout scenario.

### 6. Sediakan perangkat acceptance

Pemilik: **Anda**. Pendamping: developer/operator.

Minimal perangkat yang diperlukan:

- satu mini PC RAM 4 GB dengan storage sesuai target;
- satu Windows dan satu macOS untuk installer/lifecycle;
- satu Linux Debian untuk paket `.deb`, systemd, gPhoto2, dan CUPS;
- webcam UVC;
- kamera yang didukung gPhoto2 bila kamera DSLR/mirrorless masuk scope;
- printer foto CUPS/IPP;
- printer AirPrint bila tablet standalone wajib mencetak;
- satu iPad dan satu tablet Android;
- jaringan normal, lambat, dan mode offline untuk recovery test.

Catat model, versi OS, driver, firmware, RAM, disk, waktu boot, dan hasil tes.
Jangan menyebut perangkat kompatibel hanya karena terdeteksi.

### 7. Siapkan signing installer

Pemilik: **Anda**. Provider eksternal: Apple dan certificate authority Windows.

- macOS memerlukan Apple Developer ID, signing, notarization, dan acceptance
  pada macOS bersih.
- Windows memerlukan code-signing certificate dan acceptance SmartScreen pada
  Windows bersih.
- Linux `.deb` memerlukan signing/repository policy yang diputuskan.

Jangan menyerahkan private signing key melalui chat. Signing sebaiknya berjalan
di CI yang dibatasi dan memiliki audit log.

### 8. Pilih peserta acceptance nonteknis

Pemilik: **Anda**.

Pilih setidaknya satu orang yang belum pernah melihat setup Photoslive. Minta
mereka mengikuti dokumentasi tanpa bantuan developer. Catat setiap langkah yang
membingungkan, waktu selesai, error, dan tindakan recovery. Item “setup dapat
diselesaikan orang nonteknis” baru ditutup bila tes ini berhasil.

## Tindakan menjelang pilot

Lakukan setelah kelompok 1–8 selesai:

1. Deploy internal development dengan feature flag aman.
2. Jalankan acceptance webcam, gPhoto2, CUPS/IPP, AirPrint, tablet companion,
   direct print, dan paid print.
3. Uji crash/reboot Agent dan Controller serta recovery SSD/backup.
4. Jalankan 72-hour soak test pada mini PC 4 GB sambil mencatat RAM, CPU, disk,
   network, startup, queue, dan error.
5. Jalankan ratusan sesi sintetis/operasional tanpa menggunakan pembayaran live.
6. Lakukan screen-reader test dengan VoiceOver/NVDA/TalkBack.
7. Jadwalkan penetration test independen dan security incident drill.
8. Minta support/operator menjalankan runbook tanpa bantuan developer.

## Tindakan menjelang production

Memerlukan approval eksplisit Anda:

1. Review laporan migrasi dan setujui cutover database.
2. Review security, privacy, finance, fee, refund, chargeback, KYC, dan payout.
3. Aktifkan infrastructure berbayar hanya setelah estimasi biaya dan quota alert
   disetujui.
4. Jalankan transaksi live internal dengan nominal minimum yang sah.
5. Rekonsiliasi provider, ledger, dan bank hingga selisih nol.
6. Rollout ke 5–10 booth; pantau error budget dan support ticket.
7. Setujui staged production rollout atau rollback berdasarkan data.
8. Jadwalkan post-launch review.

## Yang tidak perlu Anda lakukan sekarang

- Jangan mengirim API key atau password kepada developer melalui chat.
- Jangan membeli seluruh hardware sebelum hardware matrix dan prioritas pilot
  disepakati.
- Jangan mengaktifkan QRIS/payout live untuk mengejar angka checklist.
- Jangan menghapus Redis, Base64 asset, atau backup lama sebelum approval
  cutover terpisah.
- Jangan menandai final production gate selesai dari hasil simulator atau unit
  test saja.

## Format laporan balik

Saat satu kelompok selesai, cukup kirim laporan tanpa secret:

```text
Kelompok: Supabase / Storage / Email / Xendit / Hardware / Installer
Environment: Preview atau Production
Status: siap diuji / gagal
Provider atau model perangkat: ...
Waktu pengujian: ...
Error yang terlihat: ...
Bukti non-rahasia: screenshot atau correlation ID
```

Developer kemudian menjalankan test terkait dan hanya mengubah `- [ ]` menjadi
`- [x]` bila seluruh aturan penyelesaian checklist terpenuhi.
