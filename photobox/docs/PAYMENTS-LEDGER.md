# Payment QRIS dan ledger

Dokumen ini menjelaskan implementasi payment yang benar-benar tersedia pada
build saat ini serta gate yang masih terbuka. Implementasi ini belum boleh
disebut production-ready sebelum acceptance sandbox dan live selesai.

Ledger produksi di PostgreSQL bersifat append-only. Hash entry dihitung oleh
trigger database saat insert, sedangkan update dan delete ditolak oleh trigger
serta privilege table. Koreksi selalu dibuat sebagai entry kompensasi baru.

## Alur yang tersedia

1. Booth meminta payment `session` atau `print` melalui Cloud API.
2. Server membaca harga dari konfigurasi booth. Nominal dari browser tidak
   dipercaya.
3. Server membuat Xendit Payment Request v3 dengan channel `QRIS`, mata uang
   `IDR`, reference ID internal, dan idempotency key.
4. QR string dari provider dirender menjadi PNG data URL di server. Secret dan
   raw credential tidak pernah dikirim ke booth.
5. Booth melakukan polling status dengan interval 1,5 detik. Poll server ke
   provider dibatasi minimal tiga detik agar banyak browser tidak menggandakan
   beban Xendit.
6. Webhook `payment.capture` yang valid menandai payment paid dan membuat satu
   entry `payment_captured`. Polling status juga dapat membuat entry yang sama
   secara idempotent jika webhook terlambat.
7. Setiap payment masuk reconciliation queue. Cron memeriksa payment pending
   yang jatuh tempo dengan retry exponential. Payment yang diterima setelah
   timer checkout tetap disimpan, tetapi ditandai `latePayment` dan masuk review
   finance—tidak otomatis dianggap hilang atau dibayar dua kali.
8. Superadmin Finance Admin dapat menetapkan fee global atau override per
   photobox. Nilai basis point disalin ke payment baru; payment lama tidak ikut
   berubah ketika policy diperbarui.
9. Antrean review superadmin memungkinkan Finance Admin menyetujui atau menolak
   payment terlambat. Keputusan, catatan, reviewer, timestamp, dan audit event
   disimpan. Penolakan sengaja tidak menjalankan refund provider otomatis.
10. Saat payment dibuat, server menyimpan referensi immutable ke provider,
    connection ID, credential version, dan fingerprint SHA-256 non-rahasia.
    Polling, webhook, dan reconciliation memakai referensi itu—bukan koneksi
    default terbaru—sehingga rotasi credential tidak memindahkan transaksi aktif
    ke akun merchant lain.
11. Finance Admin dapat meminta refund penuh dari superadmin. Server memvalidasi
    payment `paid/settled`, memakai provider connection yang dipin saat payment
    dibuat, mengirim satu request idempotent ke Xendit, lalu menunggu webhook
    final `refund.succeeded` atau `refund.failed`.
12. Refund berhasil mengubah payment menjadi `refunded` dan membuat compensating
    ledger entry negatif untuk gross, platform fee, dan booth earning tepat satu
    kali. Payment lama yang sudah keluar dari Redis direhidrasi dari PostgreSQL;
    status terminal refund tidak dapat diubah oleh webhook yang datang tidak
    berurutan.

## Endpoint

| Operasi | Endpoint |
| --- | --- |
| Buat QRIS | `POST /api/platform?action=cloud_data&booth={boothCode}&path=/api/booth/qris` |
| Status payment | `GET /api/platform?action=cloud_data&booth={boothCode}&path=/api/booth/payments/{paymentId}` |
| Callback Xendit | `POST /api/platform?action=xendit_webhook` |
| Fee global/per photobox | `GET/POST/DELETE /api/platform?action=finance_policy` |
| Refund penuh superadmin | `POST /api/platform?action=finance_refund` |
| Chargeback terkonfirmasi | `POST /api/platform?action=finance_chargeback` |
| Koreksi saldo append-only | `POST /api/platform?action=finance_adjustment` |
| Saldo pending/available | `GET /api/platform?action=finance_balances` |
| Reconciliation terjadwal | `GET /api/retention` dengan `CRON_SECRET` |

Pembuatan QRIS tidak melewati hardware bridge atau menunggu Agent. Pada booth
lokal yang offline, QRIS tetap dinonaktifkan; akses offline memakai voucher
yang telah dialokasikan atau mode gratis.

## Security dan consistency

- Payment selalu terikat ke `boothCode`, `sessionId`, `purpose`, dan payment ID.
- V1 hanya menerima IDR dan nominal 1.000–10.000.000 sesuai batas QRIS.
- Satu intent pending untuk kombinasi booth/purpose/session digunakan ulang.
- Callback token dibandingkan secara constant-time setelah di-hash.
- Webhook delivery diklaim atomik memakai webhook ID atau hash payload dan
  memiliki TTL 30 hari.
- Callback paid ditolak bila nominal atau currency berbeda dari intent.
- Payment menyimpan provider ID, connection/version fingerprint, provider expiry,
  dan fee snapshot; response publik tidak membawa
  raw QR string, credential, atau provider payload.
- Versi credential vault dipertahankan terenkripsi selama delapan hari, satu hari
  lebih lama dari TTL payment Redis. Pause/default switch tidak memengaruhi
  transaksi aktif; revoke sengaja fail-closed. Fallback deployment environment
  menolak polling bila fingerprint secret berubah agar tidak memakai akun baru
  secara diam-diam.
- Entry capture hanya dibuat sekali untuk satu payment memakai idempotency key.
- Refund v1 hanya menerima nominal penuh dan alasan provider yang diizinkan.
- Chargeback hanya dicatat setelah finance admin memverifikasi kasus pada
  dashboard provider. Referensi kasus dan payment bersifat unik; pencatatan
  ulang tidak membuat ledger ganda.
  Permission `platform.finance.write`, confirmation UI, provider refund ID unik,
  audit event, webhook deduplication, dan terminal-state guard mencegah request
  ganda serta regresi status.
- Payment dan refund di-dual-write ke PostgreSQL ketika finance persistence
  diaktifkan. Lookup durable berdasarkan internal payment ID dan provider payment
  ID membuat refund serta webhook tetap bekerja setelah cache expiry/restart.
- Koreksi finance memakai entry `adjustment` baru dengan referensi unik, alasan,
  nominal bertanda, permission finance, audit log, serta idempotensi. Entry lama
  tidak pernah diubah; koreksi salah harus dibalik dengan adjustment baru.
- Proyeksi saldo menduplikasi berdasarkan ledger ID antara cache Redis dan
  PostgreSQL durable. Entry dengan biaya provider yang belum final tetap masuk
  `pending`; entry final dan adjustment finance masuk `available`. Endpoint
  hanya dapat dibaca role finance dan UI menyediakan loading, empty, error,
  retry, serta total per photobox.
- Migration `20260721104654_create_payment_ledger.sql` menyiapkan payment intent,
  reconciliation queue server-only, RLS finance, hash entry, dan trigger yang
  menolak update/delete ledger. Direct dual-write diaktifkan terpisah agar
  kegagalan PostgreSQL tidak memutus flow booth yang masih Redis-primary.
- Provider fee final dicatat sebagai entry append-only terpisah melalui kontrol
  finance superadmin. Entry capture tetap tidak diubah; proyeksi saldo memakai
  entry finalisasi tersebut untuk memindahkan pendapatan dari pending ke available.
  Nilai ini sengaja tidak dipalsukan sebagai nol; settlement provider final harus
  ditambahkan lewat compensating entry pada batch lanjutan.

## Runtime configuration

Fallback environment server:

```text
XENDIT_SECRET_KEY=...
XENDIT_WEBHOOK_TOKEN=...
PHOTOSLIVE_PLATFORM_FEE_BPS=0
PHOTOSLIVE_POSTGRES_FINANCE=false
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

Credential yang disimpan lewat provider vault lebih spesifik daripada fallback
environment. Jangan menaruh nilai tersebut di client bundle, Agent, screenshot,
atau log.

## Gate yang masih terbuka

- Belum ada acceptance dengan credential Xendit sandbox/live dan webhook publik.
- XenPlatform sub-account dan split rule belum ada.
- Provider fee final tersedia sebagai entry ledger append-only dan dapat
  difinalisasi dari superadmin dengan permission serta audit.
- Refund penuh beserta webhook final dan compensating ledger sudah tersedia.
  Chargeback terkonfirmasi juga membuat compensating ledger append-only melalui
  kontrol superadmin yang permission-guarded dan diaudit. Koreksi saldo juga
  tersedia sebagai adjustment append-only dengan referensi unik. Proyeksi saldo
  pending/available sudah tersedia, tetapi belum boleh dipakai payout produksi
  sebelum run rekonsiliasi provider-vs-ledger selesai tanpa selisih.
  Refund sebagian belum diimplementasikan; status `settled` sudah didukung.
- Redis entry masih memiliki TTL. Migration append-only dan direct dual-write
  PostgreSQL sudah disiapkan, tetapi belum diterapkan dan diuji pada project
  Supabase Photoslive yang terverifikasi; karena itu belum diklaim sebagai
  immutable production ledger.
- Reconciliation webhook hilang dan late-payment review tetap tersedia.
  Rekonsiliasi settlement report sekarang menerima CSV dari finance admin,
  membandingkan gross/provider fee dengan ledger, mendeteksi laporan/entry
  hilang, menyimpan run idempotent, menampilkan riwayat, dan telah lulus
  skenario nol-selisih. Ingest laporan provider otomatis tetap gate produksi.
- QRIS pada `127.0.0.1` masih memerlukan Controller proxy ke Cloud ketika online;
  jalur ini belum memiliki acceptance end-to-end.
- Refund belum melewati acceptance Xendit sandbox/live. Migration PostgreSQL
  refund juga belum diterapkan pada project Supabase Photoslive yang
  terverifikasi, sehingga UI finance tetap harus berada di balik permission dan
  feature rollout yang terkendali.

Sampai seluruh gate tersebut selesai, UI finance dan payout harus tetap berada
di balik feature flag dan tidak boleh disajikan sebagai laporan keuangan final.
