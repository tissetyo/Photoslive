# Migrasi metadata sesi foto ke PostgreSQL

Migration `supabase/migrations/20260722150000_photo_session_metadata.sql`
menyimpan metadata sesi secara tenant-safe pada `public.photo_sessions`.
Foto binary tetap berada di disk lokal dan object storage; migration ini tidak
memindahkan JPEG, hasil frame, atau GIF ke PostgreSQL. Metadata internal object
storage disimpan sebagai manifest tervalidasi agar cache file serta retensi
dapat dipulihkan tanpa membocorkan object key ke halaman pelanggan.

## Konfigurasi

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
PHOTOSLIVE_POSTGRES_SESSIONS=off
PHOTOSLIVE_POSTGRES_TIMEOUT_MS=1500
```

- `off`: Redis tetap menjadi sumber metadata sesi.
- `dual`: Redis tetap authoritative dan setiap perubahan dimirror best-effort.
- `primary`: registrasi metadata wajib commit ke PostgreSQL sebelum cache Redis;
  public metadata dapat dipulihkan ketika cache Redis hilang.

Semua RPC hanya dapat dipanggil `service_role`. Browser, `anon`, dan
`authenticated` tidak mendapat akses langsung. Share code divalidasi, metadata
dibatasi 256 KiB, update memakai advisory lock, dan status `completed` atau
`expired` tidak dapat mundur menjadi sesi aktif.

## Rollout aman

1. Jalankan migration directory booth terlebih dahulu.
2. Backup Redis dan PostgreSQL.
3. Terapkan migration sesi pada staging.
4. Aktifkan `dual` dan selesaikan sesi dengan 1, 3, dan 4 slot.
5. Bandingkan booth, share code, status, slot, frame, file manifest, waktu mulai,
   selesai, dan kedaluwarsa.
6. Uji penghapusan pelanggan; PostgreSQL lebih dahulu mencatat
   `deletionRequested`, akses publik langsung ditutup, object storage dibersihkan,
   lalu row menjadi tombstone `expired`. Gangguan provider harus dapat di-retry.
7. Kosongkan cache metadata satu sesi pada staging dan buktikan halaman hasil
   pulih dari PostgreSQL tanpa menampilkan `machineId`.
8. Hapus cache session dan file di Redis, lalu pastikan manifest PostgreSQL
   menghidupkan ulang signed download serta retention record. Object binary
   tetap harus dibuktikan ada di provider; manifest bukan pengganti backup.
9. Aktifkan `primary` pada satu booth pilot dan pantau HTTP 503 retryable serta
   sync queue minimal 72 jam.
10. Lakukan restore drill sebelum rollout lebih luas.

## Perilaku kegagalan

Pada mode `primary`, kegagalan registrasi menghasilkan 503 retryable dengan
pesan bahwa foto lokal tetap aman. Upload yang sudah berhasil disimpan tetapi
gagal memperbarui metadata mengembalikan `stored: true`, sehingga worker harus
mengulang sinkronisasi metadata dan tidak mengambil foto baru. Mode `dual`
tidak menghambat Redis lama dan mencatat kegagalan secara tersanitasi.

## Gate yang masih terbuka

Test otomatis membuktikan RPC service-role-only, validasi, terminal-state guard,
persist/read/deletion-request/expire, recovery manifest/cache/retensi, penolakan
cross-session object key, dan redaksi public response. Item checklist tetap
terbuka sampai migration production, record-count, keberadaan binary provider,
multi-browser, restart, offline/reconnect, dan restore drill lulus.
