# PostgreSQL settings photobox

Settings admin dapat dipindahkan dari Redis ke PostgreSQL secara bertahap tanpa
melibatkan Photoslive Agent. Redis tetap menjadi cache cepat, sedangkan mode
`primary` selalu menyelesaikan transaksi PostgreSQL sebelum memperbarui cache.

## Mode rollout

`PHOTOSLIVE_POSTGRES_SETTINGS` hanya menerima:

- `off` — Redis tetap sumber utama dan merupakan default aman;
- `dual` — Redis sumber utama, PostgreSQL menerima write bayangan best-effort;
- `primary` — PostgreSQL sumber utama, Redis diperbarui hanya setelah commit.

Mode tidak aktif hanya karena credential Supabase tersedia. Server tetap
memerlukan `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`; service role tidak
boleh masuk client bundle, Agent, log, atau response.

## Kontrak transaksi

Migration `20260722123000_transactional_booth_settings.sql` menyediakan dua RPC
service-role-only:

- `photoslive_persist_booth_config` mengunci row booth, membatasi config hingga
  500 KB, menaikkan `config_version`, memperbarui nama/lokasi, dan meng-upsert
  satu snapshot config dalam transaksi yang sama;
- `photoslive_booth_config_snapshot` membaca versi dan config untuk membangun
  ulang cache setelah Redis kosong.

Pada mode `primary`, kegagalan database mengembalikan HTTP 503 yang retryable.
Cache tidak disentuh dan UI mempertahankan edit lokal agar operator dapat
mencoba lagi. Save settings tidak pernah menunggu heartbeat atau job Agent.

## Urutan cutover

1. Backup Redis dan PostgreSQL serta catat ID backup.
2. Terapkan migration pada non-production.
3. Aktifkan `PHOTOSLIVE_POSTGRES_SETTINGS=dual` dan cocokkan snapshot, versi,
   nama, serta lokasi untuk beberapa photobox.
4. Uji edit bersamaan, payload terlalu besar, timeout, Redis kosong, reload,
   Agent offline, dan tenant isolation.
5. Jalankan restore drill dan simpan report jumlah record lama/baru.
6. Setelah approval pemilik, ubah ke `primary` dan lakukan redeploy bertahap.
7. Pertahankan cache dan fallback lama selama masa observasi.

Jangan menandai migrasi config selesai hanya berdasarkan unit test. Integration
test Supabase nyata, restart/recovery, record-count, p95, dan restore drill tetap
menjadi acceptance gate.

## Rollback

Jika mode `primary` bermasalah, hentikan write sementara dan gunakan correlation
ID untuk menentukan transaksi terakhir yang berhasil. Kembali ke `dual` atau
`off` hanya setelah versi PostgreSQL dan cache direkonsiliasi. Jangan menurunkan
schema atau menghapus snapshot config selama rollback.
