# Status implementasi menuju mature product

Terakhir diverifikasi: 22 Juli 2026. Dokumen ini sengaja memisahkan fondasi
yang sudah ada dari gate produksi yang masih terbuka. Checklist produk lengkap
ada di `MATURE-PRODUCT-TRACKER.md`.

Status dibedakan agar UI dan dokumentasi tidak menganggap prototype sebagai
fitur production.

Item terbuka pada checklist kanonis kini memiliki penanda ownership. Dari 122
item terbuka, 31 memerlukan tindakan/approval pemilik, 49 memerlukan acceptance
atau cutover bersama, dan 21 melibatkan provider/pihak eksternal; kategori
tersebut dapat saling tumpang tindih. Item tanpa penanda merupakan pekerjaan
development atau gate turunan yang menunggu seluruh prasyarat. Urutan setup
manual, bukti yang harus disimpan, serta batas secret didokumentasikan di
`MANUAL-SETUP-ACTIONS.md`.

## Code-complete dan teruji otomatis

- Metadata aset booth kini memiliki adapter PostgreSQL service-role-only dan
  mode `off|dual|primary`. Mode primary membaca database sebelum cache,
  memulihkan cache Redis, menyensor object key privat dari respons browser, dan
  memakai penghapusan dua tahap agar kegagalan object provider dapat di-retry.
  Ini baru **code-complete dan teruji lokal**: migration live, backfill aset
  lama/Base64, record-count/checksum, RLS runtime, R2/S3 acceptance, dan restore
  drill masih terbuka. Detail rollout: `POSTGRES-ASSETS.md`.

- Metadata sesi foto kini memiliki RPC PostgreSQL service-role-only dengan mode
  off/dual/primary, database-before-cache, batas payload, status terminal
  anti-regresi, privacy deletion dua tahap yang dapat di-retry, serta recovery
  session/file/retention cache dari manifest internal. Public session projection
  tidak mengirim identitas mesin maupun object key. File foto tetap di
  disk/object storage; migration, binary-provider, dan restore acceptance
  production masih merupakan gate terbuka. Detail: `POSTGRES-SESSIONS.md`.

- Direktori booth/lokasi kini memiliki migration PostgreSQL tenant-safe dengan
  machine/legacy organization link privat, RPC service-role-only, mode
  `off|dual|primary`, database-before-cache, serta cache recovery. CLI backfill
  default-dry-run menghasilkan checksum deterministik; mode `--apply` melakukan
  upsert idempotent dan membaca ulang setiap snapshot, lalu gagal bila hasil
  tidak cocok. Migration/report production, record-count, restart,
  multi-browser, dan restore drill tetap belum dilakukan sehingga item Phase 2
  belum ditandai selesai. Runbook: `POSTGRES-DIRECTORY.md`.

- Finance risk engine kini menyimpan kasus persisten untuk perubahan rekening
  payout, payout di atas ambang server, dan referensi transfer yang digunakan
  ulang. Fingerprint mencegah duplikasi kasus, referensi transfer diklaim secara
  atomik, metadata dibatasi, serta review acknowledge/resolve memakai RBAC,
  re-authentication Platform Owner, shadow event PostgreSQL, dan audit log.
  Superadmin memiliki filter, ringkasan, retry, dan dialog review nyata. KYC,
  rekonsiliasi bank live, dan acceptance payout production tetap gate terpisah.

- Mutasi payout manual sekarang memakai lock terdistribusi per record dengan
  TTL dan pelepasan berbasis token, sehingga dua worker tidak dapat menyetujui,
  memasang bukti, membayar, atau membatalkan payout yang sama secara bersamaan.
  Penyimpanan/perubahan rekening, verifikasi, approval, finalisasi paid, dan
  pembatalan juga mewajibkan konfirmasi password server-side setelah pemeriksaan
  role; kegagalan re-authentication masuk audit tanpa menyimpan password.

- Superadmin kini memiliki perpustakaan frame global yang menyimpan file asli
  di R2/S3-compatible melalui direct signed upload, memverifikasi ukuran dan
  checksum, membatasi mutasi berdasarkan permission integrasi, serta mencatat
  upload/hapus/download di audit log. Semua admin booth mendapat katalog
  read-only dengan preview, pagination, refresh/retry, dan download tanpa
  menunggu Agent; metadata storage privat tidak diekspos.

- Delivery email Resend kini berjalan server-side melalui provider connection
  global/organisasi/booth. Tiga template (payout, pemulihan akses, dan alert)
  memakai data allowlist/bounded, queue persisten, deterministic idempotency key,
  timeout/retry terbatas, serta status delivered/bounced/complained/suppressed
  dari webhook Resend bertanda tangan dan terdeduplikasi. Superadmin memiliki
  UI antrean, email tes nyata dengan konfirmasi, retry hanya untuk kegagalan
  sementara, recipient masking, RBAC, audit, serta loading/error/empty state.
  Credential hanya dibuka adapter server. Verified domain, signed proof link,
  dan acceptance live tetap menjadi gate production. Detail ada di
  `EMAIL-DELIVERY.md`.

- Payment cloud kini membuat dynamic QRIS Xendit Payment Request v3 tanpa
  menunggu Agent, mengunci nominal dari konfigurasi booth, membatasi IDR,
  merender QR image server-side, dan menyediakan status polling yang
  ditahan minimal tiga detik per payment. Webhook memverifikasi callback token,
  nominal/currency, replay, serta idempotency sebelum membuat settlement record
  dasar satu kali. Fee global dan snapshot gross/platform/booth earning sudah
  dicatat. Refund penuh kini meminta Xendit secara idempotent, menyimpan status
  final dari webhook terverifikasi, membuat compensating ledger negatif, dan
  dapat memulihkan payment lama dari PostgreSQL setelah cache expiry. Acceptance
  Chargeback terkonfirmasi dan koreksi saldo kini dapat dicatat secara idempotent
  dari superadmin dengan ledger kompensasi append-only. Proyeksi saldo per booth
  memisahkan entry provisional sebagai pending dan entry final/adjustment sebagai
  available, dengan pembacaan cache plus PostgreSQL durable. Superadmin kini dapat
  mengimpor laporan CSV provider, menjalankan perbandingan gross dan provider fee,
  menyimpan run idempotent, melihat riwayat/selisih, dan mencatat audit. Acceptance
  sandbox/live, xenPlatform split, ingest laporan otomatis, migration PostgreSQL live,
  dan partial refund tetap terbuka.
  Detailnya ada di `PAYMENTS-LEDGER.md`.

- Runbook respons insiden produksi menetapkan severity dan target respons,
  Incident Commander, containment, preservasi bukti, recovery, komunikasi,
  postmortem, playbook fleet/privasi/finance/storage, serta drill kuartalan.
  Pelaksanaan drill nyata tetap menjadi gate produksi terpisah.
- Threat model formal mencakup 15 risiko pada boundary browser, cloud, Agent,
  Controller, filesystem, hardware, provider, dan link pelanggan. Register JSON
  mewajibkan owner, kontrol, residual risk, serta evidence; payment webhook,
  payout, dan release supply chain tetap berstatus blocked agar capability yang
  belum aman tidak ikut diklaim production-ready. Mekanisme updater lokal sudah
  memverifikasi manifest/signature/checksum serta dapat rollback, tetapi
  installer dan channel signing production belum tersedia.
- Public status page `/status` membaca probe cloud nyata dan hanya memproyeksikan
  state Cloud API, konfigurasi/voucher, serta upload/hasil pelanggan. Detail
  provider, database, latency, signed URL, response body, dan secret tidak masuk
  response publik; histori status dan alert subscription masih terbuka.
- Baseline hardware machine-readable membedakan komputer Linux/Windows/macOS,
  tablet standalone, dan companion mode. Tablet tidak diklaim memiliki Agent,
  USB printer, atau silent print; daftar perangkat tersertifikasi tetap kosong
  sampai acceptance perangkat nyata dan soak 72 jam selesai.
- Baseline performa sintetis lokal tersimpan sebagai JSON dengan host, p95,
  target check, dan daftar eksplisit yang belum terukur. Hardware simulator CI
  melewati discovery, camera capture/test, printer test/enqueue, kamera sibuk,
  dan printer terputus melalui fungsi Controller nyata. Keduanya tidak dianggap
  sebagai acceptance perangkat fisik atau mini PC 4 GB.
- Control-plane memiliki permission matrix eksplisit untuk enam platform role.
  Session legacy tetap dipetakan ke Platform Owner, Auditor tidak dapat
  menjalankan write, Fleet Admin tidak dapat mengubah integrasi/finance, dan UI
  menyembunyikan aksi yang tidak dimiliki session. Lifecycle akun
  invite/suspend/revoke multi-superadmin masih terbuka.
- Setup tablet standalone kini memiliki manifest/service worker API-safe,
  install prompt dengan fallback iOS, pilihan kamera depan/belakang, capture
  JPEG uji, permintaan persistent storage, dan deteksi kemampuan print. Ini
  belum menggantikan acceptance pada iPad/Android nyata dan belum menyediakan
  silent USB print atau background sync yang dijamin.
- Cloud settings/voucher/assets tidak menunggu Agent. Satu klik **Simpan** kini
  menggabungkan seluruh section yang berubah ke satu PATCH cloud, mempertahankan
  idempotency key ketika retry, memberi timeout sepuluh detik yang actionable,
  dan tidak menghapus edit baru yang terjadi ketika request sebelumnya berjalan.
- Settings memiliki mode PostgreSQL eksplisit `off|dual|primary`. Mode primary
  mengunci booth, menaikkan config version, menyimpan snapshot database lebih
  dahulu, lalu menyegarkan Redis. Kegagalan database mengembalikan 503 retryable
  tanpa cache parsial dan edit lokal UI tetap tersedia untuk retry. Cutover live,
  record-count, p95, dan restore acceptance masih terbuka.
- Direktori booth/lokasi memiliki mode PostgreSQL eksplisit `off|dual|primary`.
  Hubungan machine dan organization legacy tersimpan di schema private melalui
  RPC service-role-only. Setup/toggle primary menulis database sebelum cache,
  booth dapat memulihkan cache Redis, dan kegagalan menghasilkan 503 retryable
  tanpa partial pairing/access state. Cutover live dan Auth membership masih
  terbuka.
- **Generate 100** mempertahankan idempotency key yang sama setelah timeout.
  Mode PostgreSQL sekarang eksplisit `off|dual|primary`; mode primary menulis
  batch 1–100 melalui satu RPC/SQL transaction lebih dahulu, mengunci booth,
  menaikkan satu versi, lalu memperbarui Redis sebagai cache. Event, redeem,
  delete, dan recovery snapshot memakai RPC service-role-only; cache kosong
  dipulihkan tanpa dua fetch snapshot. Kegagalan database tidak membuat voucher
  Redis-only. Migration live, record-count, restart/restore acceptance, dan p95
  production tetap terbuka sehingga item checklist belum ditandai selesai.
- Admin, setup, booth, Local Manager, superadmin, session, dan status kini
  menghormati preferensi OS `prefers-reduced-motion`; animasi loop dan transisi
  panjang dipangkas tanpa mengubah state atau handler fitur.
- Seluruh surface web memiliki indikator `:focus-visible` yang konsisten untuk
  link, tombol, field, disclosure, dan target keyboard kustom; ini belum
  dianggap sebagai bukti bahwa seluruh alur keyboard E2E sudah lulus.
- Setup serta gate akses pelanggan mengumumkan hasil async dan error kritis
  melalui live region tanpa memindahkan fokus. Runbook operator dan matriks
  eskalasi support menetapkan fallback local-first, batas role, bukti aman, dan
  kondisi P0-P3.
- Audit statis seluruh surface memastikan setiap field yang terlihat memiliki
  label aksesibel dan setiap surface menyediakan region pengumuman async.
- Semua surface menetapkan font dasar 14 px dan tinggi minimum 44 px untuk
  tombol serta field utama. Pada perangkat `pointer: coarse`, link, tombol,
  disclosure, field, checkbox,
  radio, dan target keyboard kustom kini memiliki hit area minimal 48 px.
- Cache booth per tenant dan transisi tombol mulai cache-first. Tombol welcome
  tidak aktif sebelum config tersedia, memakai cache tanpa menunggu heartbeat,
  dan refresh cloud tidak mengubah flow pelanggan yang sedang berjalan.
- Gate akses membedakan QRIS yang dikonfigurasi dari QRIS yang efektif. Ketika
  offline, QRIS tidak pernah berubah menjadi sesi gratis; voucher offline tetap
  ditampilkan bila memang diaktifkan.
- Pustaka frame booth memiliki pencarian nama, pagination responsif, state kosong,
  dan kontrol navigasi yang dinonaktifkan saat hasil tidak tersedia.
- Voucher booth memiliki loading/error/disabled state dan redemption atomik.
  Jalur capture lokal menyimpan setiap attempt per slot ke SQLite, mendukung
  retake tak terbatas selama deadline sesi, serta mempertahankan satu pilihan
  final per slot sebelum sesi dapat diselesaikan.
- Settings snapshot berbasis versi lewat heartbeat 60 detik.
- Voucher cloud cache, atomic redeem offline, dan replay redemption.
- SQLite session/attempt serta foto di filesystem.
- Transactional outbox sesi nyata: penyelesaian sesi dan enqueue `session.sync`
  terjadi dalam satu transaksi; Agent mengunggah metadata/file di background,
  memverifikasi checksum, retry dengan backoff, dan menandai upload lokal.
- Checkpoint upload dicatat per file dan per-part di SQLite. File 5–25 MB memakai
  multipart R2/S3; setelah reconnect atau restart Agent meminta signed URL baru,
  melewati part yang ETag-nya sudah tersimpan, lalu menyelesaikan object secara
  idempotent. Signed URL dan credential tidak disimpan di SQLite atau log.
- Compositor Pillow membekukan konfigurasi frame per sesi, menyusun foto final
  dan layer/sticker, lalu menyimpan `result-frame.jpg` serta lembar 300 dpi yang
  mengikuti ukuran kertas dan jumlah strip printer. Completion bersifat
  idempotent dan hasil memiliki checksum SQLite.
- Print worker terpisah mengklaim job SQLite secara atomik, mengirim lembar
  hasil ke printer CUPS terpilih, menyimpan error asli, memulihkan job stale,
  dan mempertahankan file agar job gagal dapat dicoba ulang.
- Halaman hasil pelanggan menggunakan file composite asli dari Controller/cloud,
  bukan membentuk kolase generik di canvas browser. Foto mentah tetap dapat
  ditampilkan ketika upload composite masih tertunda.
- Session metadata dan file download cloud dengan expiry 24 jam.
- Share code hasil pelanggan baru memakai UUID v4 penuh (128 bit), cloud
  menolak kode pendek, expiry 24 jam tidak diperpanjang oleh upload ulang, dan
  endpoint file memvalidasi sesi induk serta manifest sebelum membaca file atau
  membuat signed URL object storage lima menit.
- Session admin baru disimpan dalam cookie host-only berprefix `__Host-` dengan
  `HttpOnly`, `Secure`, `SameSite=Lax`, dan scope `Path=/`; token tidak dapat
  dibaca JavaScript client atau dikirim ke subdomain lain.
- HMAC remote command, expiry, idempotency, allowlist, dan rate limit.
- Installation token lokal dan Local Manager lengkap untuk status service,
  cloud/pairing, perangkat, RAM/CPU/disk, antrean upload terperinci dengan
  progres/checkpoint dan retry per-job, pause/resume/restart, diagnosis, folder,
  kode setup, serta view/export rotating log.
- Local Manager juga menampilkan antrean cetak nyata, keberadaan file hasil,
  error printer, jumlah percobaan, dan retry satu job gagal secara idempotent.
- Local Manager menampilkan metrik bounded maksimal 512 request: latency p95,
  error rate, queue upload/cetak, kapasitas disk, dan kegagalan kamera, capture,
  printer, serta render. Endpoint hanya tersedia dengan installation token
  loopback dan registry tidak menyimpan payload atau ID sesi. Status sistem
  berubah menjadi **Penyimpanan menipis** di bawah 20% dan **Penyimpanan
  kritis** di bawah 10% atau reserve 2 GB, lengkap dengan tindakan operator.
- Local Manager memiliki lifecycle update nyata yang terpisah dari heartbeat:
  manifest RSA-2048/SHA-256, checksum bundle/per-file, download streaming 1 MB,
  staging aman, backup versi, health check, rollback otomatis, rollback manual
  berkonfirmasi, dan state restart-required. Channel release tetap unavailable
  sampai URL manifest dan public key production dipasang oleh installer.
- Lease offline bertanda tangan diperbarui setelah heartbeat cloud, memiliki
  mode online/normal/warning/critical/blocked pada ambang 24/48/72 jam,
  mematikan QRIS saat tidak online, dan tetap mengizinkan sesi aktif selesai.
- Cleanup storage memiliki preview/dry-run, menolak path di luar folder foto,
  dan selalu melindungi file yang belum berhasil di-upload. Cache thumbnail,
  GIF, dan temporary file dibatasi ukuran serta dirawat oldest-first.
- Capture browser ditulis melalui temporary file dan atomic replace. Kegagalan
  disk penuh atau pencatatan SQLite membersihkan file parsial/tanpa record,
  sementara restore database yang korup dibangun ke kandidat sementara,
  diverifikasi dengan SQLite quick check, lalu mengganti database secara atomik.
  mempertahankan sesi aktif, dan Diagnosis melaporkan SQLite corrupt dengan
  tindakan pemulihan tanpa ikut crash.
- Acceptance test menjalankan Controller sebagai subprocess, membuat sesi lewat
  HTTP, mengunggah dan memilih capture, mematikan proses secara paksa, lalu
  membuktikan sesi aktif, pilihan SQLite, serta byte JPEG yang sama pulih setelah
  proses baru memakai data root yang sama.
- Controller membuat backup SQLite harian dan manual yang dibatasi jumlahnya,
  menyimpan manifest/checksum, serta menyediakan restore Local Manager dengan
  confirmation, validasi quick-check, penolakan sesi aktif, dan safety backup.
- Hasil restore terakhir dicatat atomik di luar SQLite agar tetap tersedia
  setelah database diganti. Agent mengirim ringkasan backup/restore bounded
  setiap heartbeat dan superadmin menampilkannya di fleet tanpa filename,
  checksum, path, error mentah, atau secret lokal.
- Setup cloud-first membaca `?code=` dari installer, memvalidasi masa berlaku
  15 menit, dan dapat dilanjutkan setelah reload; PIN dan isi file tidak pernah
  disimpan di localStorage.
- Login admin remote sekarang default ke email/password. Opsi PIN hanya muncul
  setelah browser menemukan Local Controller loopback; Controller menerbitkan
  assertion HMAC terikat machine/booth dengan masa berlaku 60 detik dan nonce
  sekali pakai. Cloud menolak PIN tanpa proof lokal tersebut, sementara secret
  Agent tidak pernah dikirim ke browser.
- Wizard komputer mendeteksi OS, menyimpan identitas, memilih serta menguji
  kamera/printer, memilih folder, memilih/upload frame, menampilkan readiness,
  dan mengarahkan aksi akhir **Mulai gunakan photobox** ke booth.
- Pemilihan perangkat dan frame onboarding menyimpan konfigurasi cloud tanpa menunggu Agent.
  Setelah snapshot diterapkan, pilihan kamera/printer juga dicermin ke SQLite
  agar Controller dapat memulihkannya ketika file settings rusak atau terpotong.
- Bridge hardware dan upload sesi publik memakai token HMAC singkat yang terikat pada booth dan machine.
- Local Manager production menolak kontrol remote dan mengarahkan operator ke loopback komputer photobox.
- Capability gate mematikan QRIS yang belum memiliki adapter. R2/S3 hanya
  tersedia ketika seluruh credential server-side lengkap; tanpa provider, file
  kecil memakai fallback Redis legacy yang dilaporkan secara eksplisit.
- Owner/Admin/Operator dasar dan audit perubahan.
- Runtime feature flag memiliki allowlist, persistence Redis, precedence
  global/organization/booth, validasi tenant target, audit mutation, dan UI
  superadmin lengkap. Flag `direct_object_upload` dapat di-roll back per booth
  tanpa mematikan save cloud atau menunggu Agent.
- Superadmin memiliki fleet health nyata dengan state heartbeat siap/terlambat/
  offline, insiden bounded tanpa duplikat, acknowledgement yang diaudit, retry
  terpisah, dan resolusi otomatis pada heartbeat pemulihan. Alert proaktif ke
  email/pager masih belum tersedia.
- Superadmin menampilkan lokasi booth, state Agent dan Controller, versi,
  last seen, ringkasan RAM/disk yang telah disanitasi, serta 100 aktivitas
  sensitif terbaru dari audit log global dengan loading/error/empty/retry.
- Superadmin memiliki probe cache read/write/delete, probe koneksi PostgreSQL
  shadow yang bounded, serta live HEAD probe bertanda tangan untuk provider
  object storage aktif. Probe menerima 404 object acak sebagai endpoint sehat,
  menandai 403/timeout sebagai error, dan tidak mengekspos signed URL, response
  body, atau secret. Status ini independen dari settings, voucher, dan booth customer.
- Superadmin memiliki monitoring antrean remote bounded dan retry idempotent
  untuk job gagal/kedaluwarsa. Retry membuat command baru bertanda tangan,
  menolak mesin yang belum paired/nonaktif, menyensor payload/signature dari UI,
  dan mencatat mutasi di audit log. Superadmin juga dapat mengirim dua command
  aman yang telah diaudit (`devices.refresh` dan `service.restart`) dengan TTL,
  idempotency, serta konfirmasi restart. Arbitrary command dan arbitrary payload
  tetap tidak tersedia di browser.
- Kontrol akses booth superadmin sekarang memiliki regression test permission,
  persistence, perubahan resolusi booth, dan audit global. Agent tetap dapat
  heartbeat saat akses booth dimatikan; enqueue sesi/hardware baru ditolak.
- Superadmin menampilkan owner dan membership legacy yang dikelompokkan per
  booth. Projection hanya memuat identitas, role, status, dan waktu dibuat;
  password hash serta PIN hash tidak pernah masuk response atau UI.
- Audit interaction inventory mengklasifikasikan 434 kontrol pada 8 surface,
  10 route, dan 98 pola endpoint. Tidak ada kontrol aktif berstatus unknown;
  aksi native dialog dan event delegation juga dikenali agar audit tidak
  melaporkan false positive sebagai tombol mati.
- Inventaris data memetakan seluruh pola Redis aktif, tabel SQLite, PostgreSQL
  shadow, filesystem, browser cache, object pointer, serta fallback Base64
  legacy dan diuji agar perubahan schema SQLite tidak luput dari dokumentasi.
- Matriks capability machine-readable mencatat 30 area produk dengan status,
  source of truth, gate, dan file bukti. Build saat ini memiliki 12 capability
  real, 10 partial, 8 unavailable, serta nol mockup dan nol known-broken.
- Prosedur rollout/rollback mencakup feature flag, deployment web/API,
  PostgreSQL, object storage/provider, Controller/Agent, dan SQLite tanpa
  menghapus file unsynced atau melakukan downgrade schema destruktif.
- 83 test Python local-first/benchmark dan 364 test Node termasuk payment QRIS,
  webhook, full refund, compensating ledger, durable PostgreSQL recovery,
  settlement record, serta histori
  telemetry fleet bounded, proof PIN
  lokal satu kali, consent sesi
  berversi, proteksi pairing
  one-time/atomic, proteksi CSRF,
  rate limit autentikasi/setup, redaksi log lintas Cloud/Agent/Controller, pencabutan sesi
  login server-side, keamanan cookie,
  keamanan link
  unduhan pelanggan, public status
  projection, threat register, compositor/GIF/print queue,
  download hasil persisten, kontrak keamanan,
  idempotency, PostgreSQL shadow, serta syntax test seluruh JavaScript.
- Correlation ID, `Server-Timing`, structured request log, dan protocol version
  v2 pada Cloud–Agent.
- Registry provider yang hanya mengaktifkan capability ketika credential dan
  adapter benar-benar tersedia; secret tidak pernah dikirim ke client.
- Superadmin memiliki vault koneksi provider pada scope global, organization,
  dan booth. Credential BYO dienkripsi AES-256-GCM dengan additional data yang
  mengikat provider/scope/target/version; response hanya memuat nilai masked.
  Create/replace, default per capability, expiry, pause/resume, revoke, rewrap
  key version, permission, dan audit sudah teruji. Koneksi aktif kini menjadi
  environment server-only untuk adapter storage sesuai precedence
  booth/organization/global. Upload intent mengunci provider sampai finalize,
  dan record lama tetap membaca atau menghapus object melalui provider asal.
  Superadmin juga dapat menjalankan probe koneksi server-side dengan timeout,
  state UI persisten, permission, dan audit yang tidak membawa credential. OAuth,
  health/quota, usage, dan migrasi provider tetap
  terbuka. Prosedur operator ada di `PROVIDER-CONNECTIONS.md`.
- Adapter Cloudflare R2 dan S3-compatible memakai AWS Signature V4. Agent
  meminta URL PUT pendek, mengunggah file langsung tanpa melewati body Vercel,
  mengikat content type, SHA-256 metadata, dan Content-MD5, lalu cloud melakukan
  HEAD verification sebelum metadata sesi dipublikasikan. Download memakai URL
  GET pendek; record Redis baru hanya menyimpan metadata dan object key.
- Aset admin baru juga ditulis ke object storage ketika provider tersedia;
  penghapusan aset menghapus object lebih dahulu. Record Base64 lama tetap dapat
  dibaca selama migrasi bertahap. Admin dan setup memakai presigned browser PUT
  sampai 25 MB; fallback Base64 tanpa provider tetap dibatasi 2 MB.
- Link sesi berakhir maksimal 24 jam dan memiliki indeks cleanup fisik harian.
  Pelanggan dapat menghapus lebih awal melalui dialog konfirmasi; cloud tidak
  menunggu Agent, sementara job penghapusan lokal signed/idempotent bertahan
  tujuh hari agar dapat diproses setelah mesin kembali online.
- Migration PostgreSQL/Supabase awal, RLS semua tabel exposed, tenant helper,
  explicit grants, audit append-only, dan contract test statis.
- Jurnal migrasi PostgreSQL server-only dengan checksum, idempotency key, timeout
  pendek, dan shadow-write opt-in untuk audit, snapshot config, voucher/event,
  serta metadata aset; generate 100 voucher memakai satu event batch. Kegagalan
  Supabase tidak membatalkan write Redis yang sudah berhasil.
- Mutasi cloud admin membawa `Idempotency-Key`; response sukses disimpan 24 jam,
  replay tidak menjalankan operasi dua kali, dan reuse key untuk payload berbeda
  ditolak. Ini melindungi save/voucher dari retry transport tanpa mencegah user
  menekan **Generate 100** lagi sebagai aksi baru setelah response sukses diterima.
- CI untuk web, Python, serta start/reset/lint Supabase dengan CLI terpin.
- CI supply-chain mengaudit dependency production npm/Python dan memindai
  seluruh Git history dengan Gitleaks Action yang dipin ke commit SHA.

## Membutuhkan pilot/perangkat/credential

- Acceptance QRIS Xendit sandbox/live, callback publik, dan late-payment handling.
- Acceptance capture/compositor/print dengan model kamera dan printer produksi.
- Webcam permission dan preview 720p 20–24 FPS pada target mini PC.
- Batas RAM idle 150 MB, total kiosk 1,5 GB, boot 30–60 detik.
- Soak test 72 jam dan recovery storage penuh/kamera sibuk/printer putus.
- Credential/bucket R2 atau S3 production, lifecycle object, serta acceptance
  upload/download nyata untuk foto, frame besar, hasil kolase, dan GIF.
- Passkey remote. Login email/password sudah tersedia, tetapi passkey belum
  diimplementasikan dan belum boleh diklaim selesai.
- Snapshot kamera remote resolusi rendah dengan consent/expiry.
- Menjalankan migration terhadap project Supabase production dan menguji restore
  membutuhkan project/credential serta backup target yang disetujui.
- Validasi SQL lokal penuh membutuhkan Docker; environment pengembangan saat ini
  belum memiliki executable Docker. CI disiapkan untuk menjalankannya.

## Gated dan tidak boleh ditampilkan sebagai aktif

- Signed `.exe`, signed/notarized `.pkg`, paket `.deb` release.
- Flow operator tanpa Terminal; setup saat ini sudah memilih perintah sesuai OS,
  tetapi installer signed satu-klik belum tersedia.
- Installer/channel signing production dan staged fleet rollout updater.
- Acceptance performa GIF pada perangkat pilot dan batas waktu pembuatan untuk sesi delapan foto.
- Migrasi data lama otomatis.
- Remote restart ketika Agent offline.
- QRIS hanya dapat diaktifkan ketika credential Xendit dan webhook token lengkap;
  rollout production tetap ditahan sampai acceptance sandbox/live lulus.
- Object storage hanya aktif bila credential lengkap; fallback Redis tidak
  boleh disajikan sebagai storage production.

## Belum boleh diklaim selesai

- Runtime production masih memakai Redis untuk data cloud; migration PostgreSQL
  sudah memiliki schema/RLS dan shadow journal opt-in, tetapi belum cutover,
  dual-read, atau memindahkan entity ke tabel final.
- File sesi baru menuju R2/S3 secara langsung ketika provider dikonfigurasi.
  Migrasi record Base64 lama, lifecycle production, serta acceptance multipart
  terhadap provider nyata belum selesai; implementasi resume multipart lokal
  sudah memiliki unit/integration test sintetis.
- Installer signed/notarized, staged fleet rollout, payment/ledger/payout, email
  production, integrasi sesi companion penuh, hardware matrix, penetration test, disaster
  recovery drill, dan soak test 72 jam masih terbuka.
- Karena gate tersebut belum lulus, build ini adalah hardening increment dan
  belum boleh disebut mature production.

## Verifikasi keyboard terbaru

- Setup dan welcome booth diuji dari source workspace pada port terpisah agar
  tidak tercampur dengan salinan Agent terpasang di port 8080.
- Urutan Tab mengikuti aksi visual, dan link, tombol, input, serta summary yang
  menerima fokus memiliki outline `focus-visible` yang nyata.
- Migrasi object storage sekarang memiliki manifest persisten, checkpoint per
  object, pause/resume, retry terbatas, serta SHA-256 aktual pada byte sumber dan
  tujuan. Cron menjalankan batch worker terbatas dengan lock; UI superadmin juga
  menyediakan progress manual dan finalisasi. Finalisasi memeriksa metadata
  seluruh aset, lalu hanya mempause koneksi sumber yang khusus untuk booth.
  Koneksi organisasi/global tetap aktif agar booth lain tidak terganggu.
- Checklist saat ini: 505 dari 627 item selesai; screen reader, acceptance
  perangkat nyata, penetration test, dan pilot produksi tetap terbuka.
