# Capability admin booth

Dokumen ini memisahkan fitur admin yang sudah nyata dari fitur yang masih
parsial. Status **Selesai** berarti ada kontrol UI, operasi Cloud atau Local,
persistence, state kegagalan, dan bukti test. Status ini tidak berarti seluruh
Phase 10 selesai.

| Capability | Status | Bukti utama |
| --- | --- | --- |
| Dashboard readiness | Selesai | `#health-banner`, `GET /api/overview`, `renderStatus()` |
| Machine status center | Selesai | halaman Agent, heartbeat cloud, device dan telemetry projection |
| Portrait/landscape | Selesai | `appearance.screenPreset`, preview responsif, cloud settings |
| Logo/font/warna/ukuran | Selesai | appearance settings dan preview optimistis |
| Background pagination | Selesai | `#background-pagination`, asset library persisten |
| Frame editor | Selesai | upload/finalize asset, transform slot, layer, stiker, opacity, rotasi, scale |
| Aturan sesi/countdown/retake | Selesai | booth settings dan customer-flow consumption |
| QRIS/voucher/paid print toggle | Selesai | payment settings dengan capability gate |
| Voucher umum/event | Selesai | transaction/idempotency, bulk generation, print list |
| Kamera/printer | Selesai | pilihan persisten dan hardware job terpisah |
| Storage/folder/quota/retention | Selesai | cloud setting, Local folder picker, overview dan cleanup policy |
| Maintenance mode | Selesai | booth setting yang dibaca customer flow |
| User/role/session revoke | Selesai | tenant-scoped API, role gate, audit dan revoke |
| Actionable error | Selesai | toast error memetakan masalah ke halaman perbaikan |
| Sync/upload queue | Selesai | admin menerima maksimal 10 job terbaru dari heartbeat, menampilkan progres/error, dan retry per-job melalui signed remote job |
| Print queue | Selesai | admin menerima maksimal 10 job terbaru dari heartbeat, menampilkan status/error, dan retry job gagal melalui signed remote job |
| Agent connection switch | Selesai | admin menyimpan desired state di cloud; Agent menerapkannya dari heartbeat sehingga koneksi dapat dilanjutkan lagi tanpa command queue |
| Update/version/rollback | Selesai | admin menampilkan versi/status dan mengirim signed remote job dengan loading, hasil, error, serta disabled state berbasis capability |
| Session recovery | Selesai | heartbeat memuat proyeksi maksimal 10 sesi tanpa token/path; admin mengirim signed `session.recover`, Controller memvalidasi dan mencatat event lokal, lalu booth loopback melanjutkan sesi tanpa reload |
| Integrations | Selesai | owner/admin melihat koneksi global dan tenant-scoped, dapat mengetes koneksi booth; credential tetap hanya dikelola superadmin |
| Finance | Selesai | owner/admin melihat saldo dan ledger tenant-scoped; fee, refund, payout, dan rekening tetap read-only di booth |

## Invarian penting

- Pengaturan cloud tidak menunggu Agent dan tetap dapat disimpan saat Agent
  offline.
- Aksi hardware dikirim ke antrean terpisah dan tidak boleh menyamar sebagai
  operasi yang telah selesai. Tombol hardware otomatis unavailable saat Agent
  offline, dan aksi online menampilkan status pending/running sampai terminal.
- Integrasi dan finance admin booth sengaja mengikuti least privilege: operator
  ditolak, owner/admin hanya menerima data booth sendiri, dan operasi sensitif
  tetap berada di control plane superadmin.
- PIN lokal tidak boleh digunakan untuk login admin jarak jauh.

## Bukti otomatis

`web/tests/admin-maturity.test.mjs` menjaga hubungan antara kontrol, handler,
API, audit, dan daftar capability yang sengaja masih terbuka.
