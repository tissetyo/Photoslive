# Threat model Photoslive

Terakhir ditinjau: 21 Juli 2026. Dokumen ini adalah baseline keamanan untuk
arsitektur local-first dan cloud control Photoslive. Status **mitigated** tidak
berarti risiko hilang; artinya kontrol utama sudah ada dan memiliki bukti test.
Status **blocked** berarti capability terkait wajib tetap tersembunyi atau tidak
aktif sampai kontrol yang disebutkan selesai.

Kontrak machine-readable berada di `contracts/threat-model.json` dan diuji oleh
`web/tests/threat-model.test.mjs` agar risiko penting tidak hilang ketika
arsitektur berubah.

## Aset yang dilindungi

- Foto mentah pelanggan, hasil frame, GIF, dan link unduhan.
- Konfigurasi booth, voucher offline, sesi aktif, dan antrean print/upload.
- Identitas admin, role platform, session, installation token, serta provider secret.
- Rekaman payment, ledger, payout, audit log, dan telemetry mesin.

## Trust boundary

1. Browser publik, booth, admin, dan superadmin berkomunikasi dengan cloud API.
2. Cloud API berkomunikasi dengan database, cache, object storage, dan provider.
3. Remote command melewati queue cloud menuju Agent yang terpasang di mesin.
4. Agent hanya memanggil Controller melalui loopback dengan installation token.
5. Controller mengakses SQLite, filesystem, kamera, dan printer lokal.
6. Link pelanggan membuka aset sesi yang memiliki masa akses terbatas.

Kompromi penuh pada akun sistem operasi lokal berada di luar boundary yang bisa
ditahan oleh Agent saja. Risiko tersebut membutuhkan hardening OS, disk
encryption, akun operator terbatas, serta keamanan fisik mesin.

## Register risiko

| ID | Area | Status | Kontrol sekarang | Residual/gate |
|---|---|---|---|---|
| T01 | Pairing takeover | Partial | Setup code 15 menit, machine binding, token tidak tampil di browser | One-time consume, brute-force limit, dan provenance installer perlu verifikasi produksi |
| T02 | Session theft | Partial | Session server-side, cookie produksi, permission role | Passkey, revoke lengkap, dan CSRF verification masih terbuka |
| T03 | Tenant escape | Partial | Membership check, PostgreSQL RLS, projection bounded | Runtime Supabase dan cutover Redis belum selesai |
| T04 | Remote command forgery/replay | Mitigated | HMAC, expiry, idempotency, allowlist, rate limit, audit | Rotasi key dan clock-skew perlu pilot |
| T05 | Local API exposure | Mitigated | Loopback only, installation token, redacted diagnosis | Akun OS yang sudah compromised tetap berisiko |
| T06 | Secret leakage | Partial | Provider server-side, projection masked, log redaction dasar | Encrypted credential rotation dan secret scanning belum lengkap |
| T07 | Customer photo disclosure | Partial | Share code opaque, expiry 24 jam, signed URL singkat, upload-aware retention | Consent, early deletion, lifecycle cloud, dan privacy drill belum ada |
| T08 | Offline voucher replay | Mitigated | Atomic SQLite, redemption record, transactional outbox, idempotency | Clock drift dan multi-device conflict perlu fault test |
| T09 | Storage exhaustion/deletion | Mitigated | Reserve 2 GB, warning 20/10%, session block, dry-run cleanup, lindungi unsynced | Kerusakan SSD perlu restore drill nyata |
| T10 | Payment webhook spoofing | Blocked | QRIS disembunyikan tanpa adapter production | Signature, replay protection, idempotency, reconciliation belum ada |
| T11 | Payout fraud | Blocked | Ledger append-only, maker-checker, rekening terenkripsi/terverifikasi, lock mutasi, re-authentication aksi sensitif, referensi transfer unik, risk engine persisten, review RBAC, audit | KYC, rekonsiliasi bank live, dan acceptance payout production belum selesai |
| T12 | Supply-chain/update tampering | Blocked | Manifest RSA wajib, HTTPS, checksum bundle/file, backup, health check, rollback otomatis, dan remote job signed/expiring | Installer signed/notarized, release signing production, dan staged fleet rollout belum selesai |
| T13 | Telemetry/audit disclosure | Partial | Projection dan registry bounded, error disensor | Data classification dan retention enforcement belum lengkap |
| T14 | Denial of service | Partial | Rate limit command, queue/cache/log bounded, upload limit | Global API rate limit dan load test produksi belum ada |
| T15 | Device permission abuse | Partial | Permission kamera eksplisit, device selection lokal, tanpa live stream remote | Consent snapshot dan acceptance lintas perangkat belum selesai |

Detail control, owner, residual risk, dan evidence tiap risiko berada di kontrak
JSON. Kontrak adalah sumber untuk audit otomatis; tabel ini ditujukan untuk
review manusia.

## Abuse case yang wajib ditolak

- Setup code kedaluwarsa atau milik mesin lain tidak boleh membuat booth baru.
- User booth tidak boleh membaca atau mengubah tenant lain dengan mengganti URL.
- Remote command tanpa signature, sudah kedaluwarsa, duplicate, atau di luar
  allowlist tidak boleh dijalankan.
- Local Manager dari alamat non-loopback tidak boleh menjalankan kontrol service.
- Secret provider, installation token, HMAC, signed URL, dan password hash tidak
  boleh masuk response browser, telemetry, diagnosis, atau audit projection.
- Foto yang belum sync tidak boleh dihapus oleh retensi atau cleanup.
- Payment/payout tidak boleh diaktifkan sebelum webhook, ledger, dan
  reconciliation gate lulus.

## Secure defaults

- Capability belum siap disembunyikan atau ditandai unavailable, bukan tombol aktif.
- QRIS otomatis tidak efektif ketika offline.
- Agent tetap heartbeat ketika akses booth dimatikan agar dapat dipulihkan.
- Remote camera hanya snapshot singkat di masa depan, bukan live stream kontinu.
- Queue, log, thumbnail, GIF, dan temporary file selalu memiliki batas.
- PIN enam digit hanya ditargetkan untuk login lokal; compatibility PIN remote
  yang masih ada adalah risiko terbuka, bukan desain final.

## Review dan acceptance

Threat model ditinjau ulang ketika trust boundary, provider, metode login,
payment/payout, installer/updater, atau jalur penyimpanan berubah. Setiap temuan
baru harus memiliki owner, status, residual risk, dan bukti verifikasi. Sebelum
production gate, tim tetap wajib menyelesaikan penetration test, incident drill,
privacy deletion drill, runtime tenant-isolation test, dan supply-chain signing.
