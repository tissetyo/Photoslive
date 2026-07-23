# Payout manual Photoslive

## Status implementasi

Mode produksi yang tersedia saat ini adalah `MANUAL_SUPERADMIN`. Payout otomatis
belum diaktifkan karena memerlukan onboarding merchant, KYC, rekening withdrawal,
dan acceptance live dari provider. UI tidak menawarkan kontrol auto-payout palsu.

Data operasional disimpan di Redis untuk kompatibilitas rollout dan ditulis ke
PostgreSQL ketika `PHOTOSLIVE_POSTGRES_FINANCE=true`. PostgreSQL menyimpan rekening
dalam bentuk AES-256-GCM; nomor rekening utuh tidak pernah dikirim ke browser,
audit log, atau email.

## Alur operator finance

1. Finance Admin memilih photobox, mengaktifkan **Manual superadmin**, dan mengatur
   minimum payout.
2. Finance Admin menyimpan rekening. Perubahan rekening membatalkan batch aktif.
3. Platform Owner yang berbeda memverifikasi rekening dengan referensi pemeriksaan.
4. Finance Admin membuat satu batch untuk tanggal berjalan. Operasi ini idempotent:
   percobaan ulang tanggal yang sama mengembalikan batch yang sama.
5. Platform Owner yang bukan pembuat batch memberi approval.
6. Finance mengunggah bukti PDF/JPEG/PNG/WebP. Upload memakai signed URL, dibatasi
   10 MB, lalu diverifikasi ukuran dan SHA-256 sebelum dipasang ke payout.
7. Platform Owner memasukkan referensi bank dan menandai payout dibayar.
8. Sistem menulis entry ledger payout negatif satu kali, mencatat audit, dan
   mengantrekan email ringkasan owner. Kegagalan email tidak membatalkan transfer;
   email dapat dikirim ulang secara terpisah.

Penyimpanan/perubahan rekening, verifikasi, approval, finalisasi paid, dan
pembatalan meminta password akun aktif kembali. Pemeriksaan permission dilakukan
lebih dahulu. Password hanya diverifikasi server-side dan tidak pernah masuk
record payout atau audit. Approval, pemasangan bukti, finalisasi, dan pembatalan
memakai mutation lock per payout selama maksimal 30 detik; request kedua mendapat
konflik yang aman dan dapat dicoba ulang.

## State dan recovery

- `pending_approval`: menunggu checker yang berbeda dari maker.
- `approved`: bukti dapat diunggah; finalisasi membutuhkan bukti terverifikasi.
- `paid`: terminal dan tidak dapat dibuka kembali; koreksi harus berupa ledger entry baru.
- `cancelled`: terminal; alasan pembatalan wajib ada.

Jika PostgreSQL atau email provider sedang tidak tersedia, jalur Redis utama tetap
memberi hasil konsisten dan kegagalan integrasi tercatat. Payout yang sudah `paid`
aman dipanggil ulang karena business key dan ledger marker bersifat idempotent.
Mutation lock mencegah race pada proses berjalan, sedangkan marker ledger dan
business key tetap menjadi proteksi permanen setelah lock dilepas atau worker
restart.

## Konfigurasi server

- `PAYOUT_VAULT_KEYS`: JSON map versi kunci ke base64url 32 byte.
- `PAYOUT_VAULT_ACTIVE_KEY_VERSION`: versi aktif untuk enkripsi baru.
- `PHOTOSLIVE_POSTGRES_FINANCE=true`: aktifkan dual-write finance.
- `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`: hanya di server.
- Object storage provider aktif diperlukan untuk bukti transfer.
- Resend/provider email aktif diperlukan untuk pengiriman ringkasan.

Jangan menaruh service-role key, vault key, atau installation token pada client,
Local Manager, screenshot support, ataupun log.

Setiap perubahan rekening setelah pembuatan awal mengantrekan email peringatan
`system_alert` kepada owner. Email hanya memuat bank dan nomor tersamarkan,
sementara payout aktif dibatalkan dan wajib melewati approval ulang. Jika antrean
email sedang gagal, perubahan rekening tetap tersimpan, peringatannya ditampilkan
ke finance admin, dan kegagalan dicatat pada audit log tanpa membocorkan nomor.
