# Migrasi direktori booth dan lokasi ke PostgreSQL

Direktori cloud menyimpan organisasi, kode booth permanen, nama, lokasi,
status akses, serta hubungan internal ke mesin. Hubungan `machineId` dan legacy
organization berada di schema `private`; browser tidak dapat membaca tabel link
tersebut.

## Konfigurasi

Jalankan migration `supabase/migrations/20260722140000_booth_directory.sql`,
lalu isi environment server:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PHOTOSLIVE_POSTGRES_DIRECTORY=off
PHOTOSLIVE_POSTGRES_TIMEOUT_MS=1500
```

Mode bersifat eksplisit:

- `off`: Redis tetap menjadi sumber direktori dan tidak ada request PostgreSQL.
- `dual`: setup/toggle selesai di Redis lalu melakukan mirror best-effort.
- `primary`: setup dan toggle wajib commit ke PostgreSQL sebelum cache Redis;
  booth yang hilang dari Redis dapat dipulihkan dari snapshot PostgreSQL.

Credential service role hanya boleh berada di Vercel/server. RPC directory
telah dicabut dari `public`, `anon`, dan `authenticated`.

## Urutan rollout aman

1. Backup Redis dan PostgreSQL.
2. Jalankan migration directory.
3. Aktifkan `dual` pada preview/staging.
4. Pair satu booth baru, ubah nama/lokasi dan toggle akses.
5. Bandingkan kode booth, nama, lokasi, access state, serta hubungan mesin.
6. Jalankan dry-run dari checkout yang sudah terhubung ke Redis production:

   ```bash
   cd photobox/web
   npm run migrate:directory
   ```

   Simpan output JSON sebagai bukti. Periksa `scanned`, `candidates`, `skipped`,
   `issues`, dan `checksumSha256`. Dry-run tidak memanggil PostgreSQL.
7. Setelah backup selesai dan checksum dry-run disetujui, jalankan backfill
   eksplisit melalui RPC yang sama secara idempotent:

   ```bash
   node scripts/backfill-postgres-directory.mjs --apply --limit=5000
   ```

   Perintah keluar dengan status gagal bila `failed`/`mismatched` tidak nol atau
   `verified` tidak sama dengan `candidates`. Machine ID pada issue dimasking dan
   service-role key tidak pernah masuk report. Menjalankan ulang aman karena RPC
   menggunakan upsert, row lock, advisory lock, serta conflict guard.
8. Verifikasi tidak ada satu mesin terhubung ke dua booth atau sebaliknya.
9. Restart API dan pastikan booth dapat dipulihkan ketika alias/cache Redis
   sengaja dikosongkan pada staging.
10. Aktifkan `primary` untuk kelompok pilot.
11. Lakukan restore drill sebelum memperluas rollout.

Jangan mengaktifkan settings/voucher `primary` sebelum row booth terkait sudah
ada. Migrasi Auth/user/membership bukan bagian dari migration ini dan tetap
memerlukan desain Supabase Auth serta acceptance tenant nyata.

## Perilaku kegagalan

Dalam `primary`, kegagalan database menghasilkan HTTP `503` dengan
`retryable: true`. Setup tidak menandai mesin paired dan toggle tidak mengubah
cache jika commit database gagal. Dalam `dual`, kegagalan mirror dicatat dengan
log tersanitasi tanpa menghambat jalur Redis lama.

## Bukti software dan acceptance yang belum dilakukan

`web/tests/postgres-directory.test.mjs` dan
`web/tests/postgres-directory-backfill.test.mjs` membuktikan mode eksplisit,
request service-role bounded, private link, row/advisory lock, conflict guard,
database-before-cache, pemulihan cache, fail-closed setup, dry-run deterministik,
checksum, apply+verify, serta laporan kegagalan tersanitasi. Test ini tidak
menggantikan migration, menjalankan report production, record-count, restart,
multi-browser, dan restore drill pada project Supabase production.
