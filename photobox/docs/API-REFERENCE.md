# API reference ringkas

Semua payload mengikuti protocol v2 dan correlation ID. Mutation browser harus
lulus same-origin/CSRF, auth, permission, tenant scope, rate limit, dan
idempotency. API lokal hanya loopback dengan installation token.

## Local Controller

- `GET /api/local/agent/status`
- `POST /api/local/agent/pause`, `/resume`, `/restart`, `/update`, `/diagnose`
- `GET /api/local/agent/logs`
- `GET /api/local/devices/cameras`, `/printers`
- `POST /api/local/devices/camera/test`, `/printer/test`
- `POST /api/local/storage/pick-folder`
- `GET /api/local/sync/status`

## Cloud

Cloud operations tersedia melalui `/api/platform` dan `/api/bridge` dengan
action allowlist untuk booth config/assets, voucher/event, session, user/access,
provider, finance, fleet, remote job, email, telemetry, backup, dan audit.
Hardware action selalu masuk remote queue terpisah; save config/voucher tidak
boleh memanggil Agent dalam request yang sama.

Settings cloud:

- `GET /api/platform?action=cloud_data&path=/api/settings` — snapshot config
  tenant dan capability aktif;
- `PATCH /api/platform?action=cloud_data&path=/api/settings` — simpan seluruh
  dirty section dengan idempotency key;
- `PATCH /api/platform?action=cloud_data&path=/api/settings/{section}` — simpan
  satu section tervalidasi.

Mode PostgreSQL settings `off|dual|primary`, recovery cache, respons 503
retryable, dan urutan cutover dijelaskan di `POSTGRES-SETTINGS.md`.

Voucher dan event cloud:

- `GET /api/platform?action=cloud_data&path=/api/vouchers` — snapshot voucher,
  event, dan ringkasan tenant aktif.
- `POST /api/platform?action=cloud_data&path=/api/vouchers` — satu voucher.
- `POST /api/platform?action=cloud_data&path=/api/vouchers/generate` — batch
  maksimal 100 voucher dengan idempotency key.
- `POST /api/platform?action=cloud_data&path=/api/vouchers/redeem` — redeem
  atomik.
- `DELETE /api/platform?action=cloud_data&path=/api/vouchers/{code}` — hapus
  voucher yang belum dipakai.
- `GET|POST /api/platform?action=cloud_data&path=/api/voucher-events` — list dan
  buat event.

Mode PostgreSQL `off|dual|primary`, urutan cutover, RPC service-role-only, dan
recovery cache dijelaskan di `POSTGRES-VOUCHERS.md`. Mutasi tersebut tidak
memanggil Agent.

### Direktori booth/lokasi PostgreSQL

Setup, resolve booth, dan toggle akses menggunakan RPC server-only ketika
`PHOTOSLIVE_POSTGRES_DIRECTORY=dual|primary`. Mode primary menulis database
sebelum cache Redis, memulihkan cache dari snapshot, dan mengembalikan `503`
retryable tanpa partial pairing/access state jika database gagal. Machine link
berada di schema `private`; tidak ada endpoint browser yang mengembalikan tabel
link atau service-role credential. Detail rollout ada di
`POSTGRES-DIRECTORY.md`.

Endpoint control plane provider:

- `GET /api/platform?action=provider_connections` — koneksi provider tersamarkan.
- `GET /api/platform?action=provider_economics` — plan, snapshot, dan status kuota.
- `POST /api/platform?action=provider_economics` dengan operasi
  `save_entitlement` atau `record_usage` — perubahan terotorisasi dan teraudit.
- `GET /api/platform?action=provider_migrations` — manifest dan checkpoint aman.
- `POST /api/platform?action=provider_migrations` dengan operasi `create`,
  `process`, `pause`, `resume`, atau `finalize` — copy terverifikasi dan cutover
  aman tanpa menghapus object sumber.
- `GET /api/retention` (cron terotorisasi) — retensi, alert, rekonsiliasi
  payment, dan batch worker migrasi provider yang dibatasi.
- `GET /api/platform?action=webhook_events&limit=100` — log delivery pembayaran
  tanpa payload, token, atau provider event ID mentah.

Perpustakaan frame global:

- `GET /api/platform?action=platform_frame_library` — list metadata aman untuk
  superadmin dan admin booth.
- `POST /api/platform?action=platform_frame_library` operasi `prepare` lalu
  `finalize` — upload langsung ke object storage, khusus permission
  `platform.integrations.write`.
- `DELETE /api/platform?action=platform_frame_library` — hapus object dan
  metadata, khusus permission write.
- `GET /api/platform?action=platform_frame_download&id=...&download=1` — redirect
  singkat ke signed GET dan mencatat audit download.

Payout manual:

- `GET /api/platform?action=finance_payout` — daftar payout, rekening
  tersamarkan, policy, dan status delivery email sesuai permission finance.
- `POST /api/platform?action=finance_payout` — policy, rekening, batch,
  approval, bukti, finalisasi paid, pembatalan, dan retry email. Operasi rekening,
  approval, paid, dan cancel mewajibkan `reauthPassword`; mutasi record payout
  memakai lock sementara dan business idempotency permanen.

Risiko finance:

- `GET /api/platform?action=finance_risk` — daftar kasus yang dapat difilter
  berdasarkan booth, status, dan severity, beserta ringkasan bounded.
- `POST /api/platform?action=finance_risk` — operasi `acknowledge` untuk Finance
  Admin dan `resolve` khusus Platform Owner dengan `reauthPassword`. Perubahan
  rekening, payout bernilai tinggi, serta referensi transfer ganda membuat kasus
  persisten dan audit tanpa menyimpan nomor rekening atau credential mentah.

Operasi sensitif control plane mencakup `platform_staff` dan
`booth_ownership`. Transfer ownership hanya menerima Platform Owner yang sudah
re-authenticate, target tenant aktif, dan konfirmasi kode booth; role ditukar
atomik di Redis, sesi lama dicabut, audit dicatat, dan email diantrekan.

Error memakai status HTTP, kode stabil, pesan aman, dan correlation ID. Secret,
signed URL, raw provider response, bank account lengkap, serta remote-job payload
tidak boleh masuk response/list endpoint. Schema kanonis berada di
`shared/protocol-v2.schema.json` dan migration SQL di `supabase/migrations`.
