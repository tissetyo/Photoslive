# Rollout metadata aset PostgreSQL

Dokumen ini mengatur rollout metadata aset booth. File binary tetap disimpan di
R2/S3-compatible storage; PostgreSQL hanya menyimpan metadata dan referensi
object privat. Status kode lokal bukan bukti bahwa rollout production selesai.

## Mode

- `PHOTOSLIVE_POSTGRES_ASSETS=off`: Redis/legacy menjadi sumber utama.
- `PHOTOSLIVE_POSTGRES_ASSETS=dual`: legacy tetap sumber baca; setiap mutasi
  dimirror ke PostgreSQL untuk verifikasi.
- `PHOTOSLIVE_POSTGRES_ASSETS=primary`: PostgreSQL dibaca sebelum cache Redis.
  Mode ini hanya boleh dipakai setelah seluruh acceptance di bawah lulus.

## Urutan rollout aman

1. Backup data legacy dan database.
2. Terapkan migration `20260722170000_booth_asset_metadata.sql` pada staging.
3. Jalankan RLS/grant test dengan service role dan role yang tidak berwenang.
4. Aktifkan `dual` dan backfill metadata aset lama secara idempotent.
5. Bandingkan record count, checksum, booth ownership, jenis aset, dan status.
6. Uji cache expiry/recovery, multi-browser, restart, dan retry penghapusan.
7. Uji PUT/HEAD/GET/DELETE binary pada provider, termasuk checksum dan outage.
8. Jalankan backup/restore drill dan ulangi pembacaan seluruh aset.
9. Aktifkan `primary` pada staging, lalu produksi bertahap setelah approval
   pemilik. Pertahankan legacy fallback selama jendela rollback.

## Gate yang masih terbuka

- Project Supabase production dan migration live.
- Tool/report backfill aset legacy serta migrasi payload Base64 ke object
  storage.
- Acceptance R2/S3 nyata dan lifecycle/retention provider.
- Record-count/checksum report, RLS runtime, restart, dan restore drill.
- Approval eksplisit sebelum menghentikan write legacy.

Object key, credential, service-role key, dan signed upload token tidak boleh
ditampilkan di browser, screenshot, audit payload publik, atau log operator.
