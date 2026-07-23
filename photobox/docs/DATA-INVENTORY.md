# Inventaris data Photoslive

Dokumen ini memetakan penyimpanan yang benar-benar dipakai build saat ini.
Tujuannya adalah mencegah migrasi atau cleanup menghapus data yang belum aman.
Redis masih menjadi source of truth cloud selama cutover PostgreSQL; SQLite dan
filesystem adalah source of truth operasional booth lokal.

## Upstash Redis cloud

| Pola key | Tipe | Isi dan retensi |
| --- | --- | --- |
| `photoslive:machine:{machineId}` | JSON | pairing, booth, status Agent/Controller, telemetry, config/voucher version |
| `photoslive:machine:{machineId}:telemetry-history` | list | maksimal 2.016 snapshot RAM/disk/status, bucket 5 menit, TTL 8 hari |
| `photoslive:machine:{machineId}:telemetry-bucket:{bucket}` | string | deduplikasi satu snapshot per 5 menit, TTL 8 hari |
| `photoslive:machines` | set | indeks seluruh machine |
| `photoslive:booth:{code}` | string | alias booth/pairing code ke machine ID |
| `photoslive:user:{userId}` | JSON | akun legacy, hash password/PIN, role, booth |
| `photoslive:email:{email}` | string | indeks email ke user ID |
| `photoslive:booth:{code}:users` | set | membership user legacy |
| `photoslive:session:{sessionId}` | JSON | web session admin; TTL 7 hari |
| `photoslive:pairing:{code}` | string | setup code ke machine; TTL 15 menit |
| `photoslive:booth:{code}:settings` | JSON | snapshot config cloud |
| `photoslive:booth:{code}:settings-version` | integer | versi sinkronisasi config |
| `photoslive:booth:{code}:vouchers` | set | indeks kode voucher |
| `photoslive:booth:{code}:voucher:{code}` | JSON | voucher, event, status redeem |
| `photoslive:booth:{code}:voucher-events` | set | indeks event voucher |
| `photoslive:booth:{code}:voucher-event:{id}` | JSON | nama, expiry, hak print |
| `photoslive:booth:{code}:voucher-version` | integer | versi snapshot voucher lokal |
| `photoslive:booth:{code}:voucher-lock:{code}` | string | lock redeem atomik; TTL pendek |
| `photoslive:booth:{code}:assets:{kind}` | set | indeks background/frame/logo/sticker |
| `photoslive:booth:{code}:asset:{id}` | JSON | metadata object atau payload Base64 legacy |
| `photoslive:booth:{code}:asset-upload:{uploadId}` | JSON | intent presigned upload; TTL 15 menit |
| `photoslive:public-session:{code}:{shareCode}` | JSON | metadata halaman hasil; TTL 24 jam |
| `photoslive:public-session-file:{code}:{shareCode}:{fileId}` | JSON | metadata object atau byte Base64 legacy; TTL 24 jam |
| `photoslive:session-upload-intent:{uploadId}` | JSON | intent upload hasil langsung; TTL 15 menit |
| `photoslive:job:{jobId}` | JSON | remote hardware job |
| `photoslive:jobs` | list | indeks bounded 500 ID remote job terbaru untuk superadmin |
| `photoslive:machine:{machineId}:jobs` | list | antrean remote job per machine |
| `photoslive:machine:{machineId}:job-idempotency:{key}` | string | deduplikasi job selama TTL job |
| `photoslive:job:{sourceJobId}:retry` | string | pointer retry idempotent; TTL 10 menit |
| `photoslive:machine:{machineId}:enqueue-rate:{window}` | integer | rate limit enqueue; TTL pendek |
| `photoslive:idempotency:{booth}:{key}` | JSON | response cloud mutation; TTL 24 jam |
| `photoslive:booth:{code}:client:{id}` | JSON | client booth aktif; TTL 180 detik |
| `photoslive:booth:{code}:clients` | set | indeks client booth |
| `photoslive:booth:{code}:audit` | list | 100 audit booth terakhir |
| `photoslive:audit:global` | list | maksimum 1.000 audit global |
| `photoslive:reset:{id}` / `photoslive:reset-requests` | JSON + set | permintaan recovery akun |
| `photoslive:feature-flag:{scope}:{target}:{key}` | JSON | override feature flag |
| `photoslive:feature-flags` | set | indeks override feature flag |

Key Redis tidak boleh dipindai pada request booth biasa. Indeks set/list di
atas adalah jalur baca utama; `SCAN photoslive:machine:machine_*` hanya fallback
rekonstruksi fleet superadmin.

## PostgreSQL/Supabase

Migration di `supabase/migrations` mendefinisikan target organization, booth,
membership, config, voucher/event, session, asset, provider connection,
feature flag, dan audit. Build saat ini baru melakukan shadow write server-only
ke `migration_shadow_events`; Redis tetap source of truth sampai dual-read,
checksum report, backup/restore, dan cutover gate selesai.

Setiap shadow event menyimpan `idempotency_key`, `entity_type`, `legacy_key`,
operasi, payload JSON, checksum payload, correlation ID, dan timestamp. Service
role key hanya digunakan server-side.

## SQLite Local Controller

Database berada di `${PHOTOSLIVE_DATA_ROOT}/photoslive.db` (default
`photobox/data/photoslive.db`) dan memakai `PRAGMA user_version = 4`.

| Tabel | Fungsi |
| --- | --- |
| `events` | log event operasional lokal |
| `vouchers` | allocation voucher offline dan status redeem |
| `voucher_events` | expiry dan hak print event offline |
| `daily_usage` | agregat session, foto, print, revenue per hari |
| `jobs` | print dan GIF worker dengan attempts/error/reference |
| `photo_sessions` | state session, share token, frame snapshot, deadline, expiry, upload |
| `photo_files` | capture attempt, selected result, composite/GIF, checksum, upload |
| `sync_queue` | transactional outbox, dead-letter metadata, checkpoint per file, dan ETag multipart tanpa signed URL |
| `local_state` | device selection, offline lease, version snapshot, metadata sync |

Completion session dan insert `session.sync:{sessionId}` harus berada pada satu
transaksi. Foto yang belum memiliki `uploaded_at` tidak boleh menjadi kandidat
retensi atau cleanup.

## Filesystem lokal

| Path | Isi | Aturan |
| --- | --- | --- |
| `${PHOTOSLIVE_DATA_ROOT}/settings.json` | config lokal terakhir | ditulis atomik melalui file sementara |
| `${PHOTOSLIVE_DATA_ROOT}/.installation-token` | token Local API | permission `0600`, tidak diexpose ke UI/log |
| `${PHOTOSLIVE_DATA_ROOT}/restore-status.json` | status dan waktu restore database terakhir | ditulis atomik; tidak memuat filename, checksum, path, atau error mentah |
| `${PHOTOSLIVE_DATA_ROOT}/photos/` | capture, composite, print sheet, GIF | folder dapat diganti operator; lindungi file unsynced |
| `${PHOTOSLIVE_DATA_ROOT}/cache/thumbnails/` | thumbnail | maksimum default 128 MB, oldest-first |
| `${PHOTOSLIVE_DATA_ROOT}/cache/gif/` | cache GIF | maksimum default 256 MB, oldest-first |
| `${PHOTOSLIVE_DATA_ROOT}/tmp/` | file sementara | maksimum default 256 MB dan umur 24 jam |
| `web/uploads/{background,frame,logo,sticker}/` | aset upload Controller lokal | legacy local serving; bukan cloud source of truth |
| `${PHOTOSLIVE_CONFIG_DIR}/agent.json` | machine ID, cloud URL, token Agent | secret lokal |
| `${PHOTOSLIVE_CONFIG_DIR}/agent-status.json` | last status/error/pairing | dapat dibaca Local Manager setelah redaction |
| `${PHOTOSLIVE_CONFIG_DIR}/agent-control.json` | pause/resume desired state | tidak menghentikan supervisor |
| `${PHOTOSLIVE_CONFIG_DIR}/agent.log` | log Agent | rotasi 512 KB ke `.log.1` |

## Browser storage

- `photoslive.setupDraft.v2`: progress onboarding non-sensitif; PIN dan isi file
  tidak pernah disimpan.
- `photoslive.machine.{boothCode}`: cache resolusi booth ke machine selama 60
  detik agar route tenant tidak memakai machine booth lain.
- `photoslive.config.{boothCode}`: cache config booth untuk transisi Mulai foto
  instan; config baru ditahan selama session aktif.
- `photoslive.machineId`, `photoslive.boothCode`, dan
  `photoslive.boothAlias.{setupCode}`: compatibility/pairing hints.
- `photoslive-client-id`: identitas client booth non-rahasia.

Browser storage bukan source of truth untuk akun, voucher, foto, payment, atau
hasil sesi. Menghapusnya hanya menghapus cache/draft, bukan data booth.

## Base64 legacy dan batas migrasi

Base64 masih dipakai pada tiga jalur kompatibilitas yang dibatasi:

1. request/response Controller melalui remote Agent untuk preview atau body
   kecil; ini transport sementara, bukan persistence browser;
2. asset cloud `storageMode=legacy-redis` maksimal 2 MB bila object storage
   belum tersedia;
3. file hasil sesi legacy di Redis maksimal 2 MB dan TTL 24 jam.

Ketika R2/S3 tersedia, asset dan file sesi menggunakan presigned PUT langsung;
Redis hanya menyimpan object key, checksum, ukuran, content type, provider, dan
ETag. Record Base64 lama tetap readable selama migrasi, tetapi write baru tidak
boleh kembali ke Base64 bila direct object upload berhasil. Data legacy tidak
boleh dihapus sebelum object HEAD verification, checksum cocok, backup tersedia,
dan approval migrasi diberikan terpisah.

## Ownership dan larangan cleanup

- Cloud settings/voucher/account tidak tergantung Agent dan tidak boleh dihapus
  oleh cleanup lokal.
- SQLite + folder foto adalah source of truth session offline sampai upload
  terverifikasi.
- Object storage adalah source of truth byte cloud; Redis/PostgreSQL menyimpan
  metadata dan pointer.
- Cleanup harus selalu dry-run lebih dahulu, menolak path di luar root foto,
  serta melindungi file tanpa `uploaded_at`.
- Migrasi Redis ke PostgreSQL dan Base64 ke object storage bersifat copy,
  verify, cutover, lalu delete hanya setelah approval; tidak ada destructive
  migration otomatis.
