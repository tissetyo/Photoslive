# PostgreSQL voucher dan event

Implementasi ini memindahkan sumber kebenaran voucher dari Redis ke PostgreSQL
secara bertahap. Redis tetap dipakai sebagai cache agar UI admin dan booth tetap
cepat, tetapi mode `primary` selalu menulis PostgreSQL lebih dahulu dan gagal
tertutup bila transaksi database gagal.

## Mode rollout

`PHOTOSLIVE_POSTGRES_CLOUD_DATA` hanya menerima:

- `off` — Redis tetap sumber utama. Ini default aman.
- `dual` — Redis sumber utama; PostgreSQL menerima write bayangan best-effort.
- `primary` — PostgreSQL sumber utama; Redis hanya cache yang diperbarui setelah
  transaksi database berhasil.

Credential Supabase saja tidak mengaktifkan migrasi. Server juga membutuhkan
`SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`. Service role hanya boleh berada
di environment server Vercel dan tidak boleh masuk browser, Agent, log, atau
response API.

## Operasi transaksional

Migration `20260722110000_transactional_voucher_batches.sql` menyediakan RPC
service-role-only:

- `photoslive_persist_voucher_batch` — satu SQL insert untuk 1–100 voucher,
  satu booth row lock, dan satu kenaikan `voucher_version`;
- `photoslive_persist_voucher_event` — upsert event berdasarkan legacy ID;
- `photoslive_redeem_voucher` — redeem atomik hanya jika belum digunakan;
- `photoslive_delete_voucher` — hapus hanya voucher yang belum digunakan;
- `photoslive_voucher_snapshot` — recovery read voucher, event, dan versi.

Batch yang mengandung kode duplikat atau referensi event tidak valid di-rollback
seluruhnya. Pada mode `primary`, kegagalan PostgreSQL tidak boleh menghasilkan
voucher Redis-only. Jika cache Redis hilang, API membaca satu snapshot
PostgreSQL bersama untuk voucher dan event lalu dapat membangun ulang response.

## Urutan cutover

1. Backup database dan Redis; simpan ID backup tanpa secret.
2. Terapkan seluruh migration Supabase pada environment non-production.
3. Aktifkan `dual`, generate/redeem/delete voucher dan event, lalu cocokkan
   jumlah record serta versi.
4. Jalankan test tenant isolation, restart/reload, duplicate code, timeout, dan
   Agent offline.
5. Simpan migration report dan checksum evidence.
6. Setelah approval pemilik, ubah ke `primary` dan redeploy.
7. Pertahankan Redis cache serta legacy fallback selama masa observasi.

Jangan menandai item migrasi voucher selesai sebelum integration test pada
PostgreSQL nyata, restart acceptance, record-count report, dan restore drill
lulus. Unit test repository memverifikasi kontrak dan urutan write, bukan
cutover production.

## Rollback

Jika mode `primary` bermasalah, hentikan mutasi voucher sementara, simpan bukti
correlation ID, dan kembalikan deployment ke `dual` atau `off` hanya setelah
menentukan record PostgreSQL mana yang belum masuk Redis. Jangan menghapus tabel,
event, atau kode voucher selama rollback. Rekonsiliasi dilakukan berdasarkan
`voucher_version`, kode booth, dan kode voucher.
