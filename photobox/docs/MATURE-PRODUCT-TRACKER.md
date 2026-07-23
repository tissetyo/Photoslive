# Mature product tracker

Dokumen ini adalah sumber status untuk checklist Phase 0–21. Status **Selesai**
hanya boleh dipakai setelah seluruh aturan penyelesaian dan exit gate fase
lulus. Membangun sebagian code tidak sama dengan menutup sebuah fase.

| Phase | Status saat ini | Bukti yang sudah ada | Gate utama yang masih terbuka |
| --- | --- | --- | --- |
| 0 Audit dan baseline | Berjalan | Audit 8 surface/434 kontrol, 10 route, 98 pola endpoint, matriks 30 capability, baseline hardware lintas OS, correlation/timing log, prosedur rollback, serta benchmark sintetis tersimpan | benchmark mini PC 4 GB dan acceptance perangkat nyata |
| 1 Repo dan kontrak | Berjalan | JSON schema protocol v2, cross-runtime Cloud signature–Agent validation, Agent–Controller route contract, provider contract, dependency pin, CI | pemisahan package fisik dan live HTTP contract test end-to-end |
| 2 PostgreSQL/Auth/migrasi | Fondasi | migration core, RLS, explicit grants, shadow journal idempotent, direktori booth/lokasi dengan private machine links dan mode off/dual/primary, settings/voucher RPC transaksional, static contract test | Supabase project, backfill entity, Auth/membership, checksum report, backup/restore |
| 3 Performa/cloud-agent | Berjalan | config/voucher async, provider gates, outbox tidak memblokir booth | benchmark p95 dan DLQ cloud production |
| 4 Controller/SQLite | Berjalan | session/attempt, process-kill recovery acceptance, device selection recovery, transactional outbox, multipart byte-level checkpoint, checksum, rendered frame/print asset, print job, retry/recovery, direct signed object upload | live object-storage recovery acceptance |
| 5 Offline/storage | Sebagian | signed lease 24/48/72, QRIS offline gate, voucher offline, upload-aware cleanup dengan dry-run, cache/temp limit, 20% warning, 10%/2 GB session block, fault-safe capture write | hardware offline E2E dan recovery storage produksi |
| 6 Agent/installer | Sebagian | Agent protocol v2, service scripts lintas OS, setup prefilled otomatis, signed manifest, checksum, atomic update, health check dan automatic rollback | signed installers serta acceptance update lintas OS |
| 7 Local Manager | Sebagian | status cloud/pairing/system/device, metrik request/queue/kegagalan bounded, antrean upload dan cetak detail dengan retry per-job, pause/resume, restart, update/rollback, diagnosis, folder, setup code, backup/restore SQLite, log export | hard-stop Advanced dan acceptance release production |
| 8 Setup komputer/tablet | Sebagian | URL code prefill, wizard komputer, device/folder/frame, readiness, PIN local-only dengan proof Agent, PWA shell, kamera depan/belakang, capture test, storage persistence, batas print/background tablet, serta companion handshake lokal bertoken | signed one-click installer dan acceptance iPad/Android/perangkat companion nyata |
| 9 Booth pelanggan | Sebagian | welcome cache-first, config UI, QRIS offline gate, voucher redeem, frame search/pagination, confirmation, per-slot capture/retake/final selection, compositor Pillow, background GIF, print queue, persistent result download, direct object upload, countdown/goodbye, dan local outbox | offline browser E2E, live storage, dan acceptance printer nyata |
| 10 Admin booth | Berjalan | readiness, machine status, appearance, frame editor, session/payment/voucher, device/storage, maintenance, user/role/revoke, actionable repair, cloud save tanpa Agent, upload/print queue detail dengan retry per-job, desired-state connection switch, hardware pending/unavailable state, update/version/rollback, session recovery bertanda tangan, integrasi tenant-scoped read/test, serta finance ledger/saldo read-only | acceptance hardware dan provider nyata |
| 11 Superadmin | Sebagian | fleet/lokasi, owner/membership legacy, transfer ownership atomik, access, recovery, state Agent/Controller, version, telemetry, last seen, audit log, cache/database health, provider readiness, incident timeline/acknowledgement, delivery alert/retry, antrean email/retry/tes, monitoring antrean, pengiriman command aman, enam role platform, undangan/aktivasi dengan payload email terenkripsi, suspend/revoke, session revoke, re-authentication, serta boundary test tanpa raw DB/secret/Agent token dan Support tanpa akses finance | acceptance rollout/update Agent dan acceptance email production |
| 12 Marketplace | Berjalan | provider registry/capability gate, adapter SigV4 R2/S3, monitoring webhook bertanda tangan, direct Agent/browser upload, encrypted scoped connection vault, masked superadmin control, runtime selection/pinning per object, serta probe koneksi storage, Xendit, dan Resend | live credential acceptance, OAuth/health/quota, SMTP, dan migration provider |
| 13 Payment/ledger | Berjalan | dynamic QRIS cloud, seluruh status transaksi termasuk settled, create/status Xendit, webhook token/replay/idempotency, pin provider connection dan credential version per transaksi, fee global/per-booth, fee snapshot immutable, ledger PostgreSQL append-only dengan hash dan trigger penolak update/delete, late-payment review, reconciliation worker, refund penuh idempotent, chargeback terkonfirmasi, adjustment finance append-only, finalisasi provider fee append-only, proyeksi saldo pending/available, serta impor CSV provider untuk run rekonsiliasi persisten dan idempotent | sandbox/live acceptance, migration PostgreSQL live, xenPlatform split, ingest laporan settlement otomatis, dan partial refund |
| 14 Payout | Berjalan | mode manual per booth, rekening terenkripsi dan terverifikasi, batch harian idempotent, lock mutasi per record, maker-checker, re-authentication aksi sensitif, bukti transfer tervalidasi, ledger paid-out, email/retry, audit, UI superadmin, dan dual-write PostgreSQL | KYC, auto-payout, settlement bank otomatis, serta acceptance live |
| 15 Email | Berjalan | adapter Resend server-side, empat template bounded, payload undangan terenkripsi dengan key rotation, antrean persisten, idempotency, retry, webhook delivery events, RBAC/audit, dan UI superadmin | verified domain, acceptance live, signed proof link, serta integrasi payout/recovery production |
| 16 Design/accessibility | Sebagian | baseline font 14 px, kontrol 44 px, touch-target 48 px untuk coarse pointer, token, reduced-motion, visible keyboard focus, accessible form label, async announcement, select-arrow inset, number-spinner protection, dan keyboard-flow E2E setup/welcome booth | regression matrix, contrast, screen reader dan accessibility gate |
| 17 Security/privacy | Berjalan | threat model formal 15 risiko, HMAC jobs, scoped token, RLS schema, CSRF, rate limit, secure cookie, session revoke, pairing takeover guard, consent sesi berversi, retensi cloud dan early deletion cloud/lokal, secret redaction | passkey, pentest, dan incident drill |
| 18 Observability/DR | Fondasi | public status page aman, correlation, timing, structured request log, registry 512 request, latency/error/queue, alert storage 20%/10%/reserve 2 GB dan kegagalan hardware lokal, fleet health/incident timeline cloud, delivery webhook bertanda tangan dengan deduplikasi/retry/audit, backup SQLite harian/checksum/restore atomik termasuk database aktif yang korup, status backup/restore fleet tersanitasi, RPO/RTO, runbook operator, dan eskalasi support terdokumentasi | restore drill hardware dan histori status |
| 19 Testing matrix | Berjalan | 364 Node + 83 Python tests, termasuk direktori booth/lokasi PostgreSQL tenant-safe, backfill dry-run/checksum/apply-verify tersanitasi, metadata sesi dan aset PostgreSQL dengan recovery/redaksi/two-phase delete, transaksi/recovery settings dan voucher PostgreSQL, respons cloud retryable, finance risk engine, referensi transfer unik, lock payout dan re-authentication, perpustakaan frame global ber-RBAC, simulator kamera/printer dengan failure state, migrasi provider ber-checkpoint/checksum/recovery/worker lock/cutover, transfer ownership atomik, payment/ledger/payout, email, Agent lifecycle, offline Controller, design/accessibility contract, UI simplicity contract, dan traceability matrix | live PostgreSQL/Xendit/R2/S3/Resend, hardware fisik/load/offline/72-hour soak matrix |
| 20 Dokumentasi | Berjalan | index build 0.3.0, installer/setup nonteknis, Local Manager, booth/admin/superadmin, integration/finance, offline/troubleshooting, hardware, incident, backup, API, architecture, privacy/retention, payment disclosure, release notes, dan rollback | acceptance operator serta sinkronisasi dokumentasi dengan build produksi final |
| 21 Pilot/produksi | Belum dimulai | belum ada evidence pilot untuk build ini | seluruh gate Phase 0–20 dan staged rollout |

> Pembaruan testing: suite saat ini memuat 364 kontrak Node dan 83 acceptance
> Python; jumlah ini termasuk migration recovery, session recovery, queue admin
> per-job, dan lifecycle Agent terbaru.

## Checklist implementasi terverifikasi

Legenda:

- `[x]` memiliki implementasi nyata dan bukti test/static contract pada build ini.
- `[ ]` belum selesai, masih parsial, atau memerlukan bukti runtime/hardware.
- Sebuah phase tetap **belum selesai** sampai semua item dan exit gate pada
  checklist produk lengkap lulus.

Ringkasan checklist terverifikasi per 23 Juli 2026: **177 selesai**, **63 masih
terbuka**, total **240 item konsolidasi**. Angka ini menghitung item pada tracker
implementasi, bukan mengganti rincian acceptance test pada checklist produk
induk. Belum ada phase yang boleh ditutup karena exit gate masing-masing masih
memiliki item terbuka.

### Phase 0 — Audit dan baseline

- [x] Inventaris route publik, booth, admin, setup, Local Manager, dan superadmin.
- [x] Inventaris kontrol final; audit otomatis mengklasifikasikan 434 kontrol:
      433 terhubung melalui ID, form, event delegation, atau aksi dialog native,
      dan 1 checkbox proteksi sengaja disabled. Tidak ada kontrol unknown.
- [x] Inventaris pola endpoint cloud dan lokal.
- [x] Pemetaan final seluruh data Redis, PostgreSQL shadow, SQLite, filesystem,
      browser cache, object pointer, dan Base64 legacy beserta ownership,
      retensi, serta larangan cleanup.
- [x] Matriks machine-readable mengklasifikasikan 30 capability sebagai real,
      partial, mockup, broken, atau unavailable; setiap item memiliki source of
      truth, gate, dan file bukti. Tidak ada mockup atau known-broken capability
      yang diaktifkan pada build ini.
- [ ] Baseline latency produksi dan benchmark mini PC 4 GB.
- [x] Baseline capability machine-readable untuk Linux, Windows, macOS, iPad,
      Android, dan tablet companion; capability `supported`, `limited`,
      `unavailable`, dan `planned` dipisahkan dari sertifikasi perangkat nyata.
- [ ] Hardware compatibility baseline dengan perangkat nyata.
- [x] Dokumentasi bug dan batas implementasi produksi saat ini.
- [x] Correlation ID, structured timing log, dan `Server-Timing`.
- [x] Feature flag runtime dengan default aman, precedence global/organization/booth,
      tenant isolation, audit log, dan kontrol superadmin. Rollback upload aset
      langsung kembali ke jalur kompatibilitas maksimal 2 MB.
- [x] Rollback procedure untuk web/API, feature flag, PostgreSQL, object storage,
      provider, Controller/Agent, dan SQLite/sesi lokal; setiap release wajib
      memiliki manifest versi lama, trigger, serta verifikasi pasca-rollback.

Exit gate Phase 0:

- [x] Interaction inventory lengkap.
- [x] Baseline performance tersimpan untuk regresi lokal; acceptance produksi tetap terbuka.
- [x] Seluruh area produk sudah diklasifikasikan real/partial/mockup/broken/unavailable.

### Phase 1 — Repository dan kontrak

- [ ] Pemisahan fisik cloud web, booth PWA, Controller, Agent, contracts, dan design system.
- [ ] Migrasi cloud admin ke Next.js/React.
- [ ] Migrasi booth ke TypeScript/Vite PWA ringan.
- [x] Controller dan Agent tetap Python selama migrasi awal.
- [x] Shared protocol/API JSON schema v2.
- [x] Shared hardware job dan session sync schema.
- [x] Provider capability contract dan registry.
- [x] Cloud/local protocol versioning.
- [x] Minimum protocol dan backward compatibility policy terdokumentasi.
- [x] Dependency web dipin dan lockfile tersedia.
- [x] CI web, Python, dan Supabase dibuat.
- [x] Build tidak menggunakan Electron.

Exit gate Phase 1:

- [ ] Semua package dapat dibuild terpisah.
- [ ] Contract test cloud–Agent–Controller end-to-end.
- [ ] Booth berjalan dari bundle yang benar-benar terpisah dari admin.

### Phase 2 — PostgreSQL, auth, dan migrasi

- [ ] Project PostgreSQL/Supabase production tersambung.
- [x] Migration core PostgreSQL tersedia.
- [x] Schema organization, booth, membership, config, voucher, session, asset,
      provider connection, feature flag, dan audit log.
- [x] RLS dan explicit grants didefinisikan untuk seluruh tabel exposed.
- [x] Tenant membership helper dan policy role dasar tersedia di migration.
- [x] Audit log dirancang append-only.
- [x] Asset schema memakai object reference/checksum, bukan Base64.
- [x] Shadow journal server-only memakai checksum, idempotency key, RLS, dan
      timeout pendek tanpa membatalkan Redis-primary write.
- [ ] Auth production dan role lengkap Owner/Admin/Operator/Support/Auditor/superadmin.
- [ ] Menjalankan migration dan RLS test pada database nyata.
- [ ] Migrasi record Redis dan Base64 nyata.
- [ ] Dual-read, checksum report, backup, restore test, dan cutover.
- [ ] Legacy read fallback dan penghentian legacy write.
- [x] Tidak ada penghapusan data lama otomatis pada perubahan ini.

Exit gate Phase 2:

- [ ] Jumlah record lama dan baru cocok.
- [ ] Seluruh RLS runtime test lulus.
- [ ] Multi-browser persistence pada PostgreSQL lulus.
- [ ] Restore backup berhasil diuji.

### Phase 3 — Performa dan pemisahan Agent

- [x] Simpan setting cloud tidak membuat hardware job dan tidak menunggu Agent.
- [x] Snapshot setting disinkronkan berdasarkan version lewat heartbeat.
- [x] Tombol mulai memakai cached booth config dan tidak menunggu heartbeat.
- [x] Pemeriksaan kamera dipisahkan dari transisi awal booth.
- [x] Hardware action memakai signed queue terpisah.
- [x] Cloud-data API tidak menjalankan operasi Controller dalam request save.
- [x] Mutasi cloud memakai idempotency key; replay mengembalikan response lama
      dan key yang dipakai untuk payload berbeda ditolak.
- [x] Save admin menggabungkan dirty section menjadi satu PATCH, memakai
      idempotency key yang sama saat retry, preview lokal langsung, timeout
      bounded, dan mempertahankan edit yang lebih baru selama request berjalan.
- [x] Sync worker Agent nyata untuk durable local outbox.
- [x] Exponential retry dan stale-claim recovery.
- [x] Dead-letter setelah 10 kegagalan.
- [x] Retry manual untuk failed/dead job.
- [ ] PostgreSQL transaction untuk setting dan bulk insert 100 voucher.
      Settings dan voucher/event sudah memiliki RPC transaksional, mode
      dual/primary, database-before-cache, fail-closed, recovery snapshot, dan
      error retryable; integration/cutover PostgreSQL nyata masih terbuka.
- [ ] Optimistic UI dan state timeout/retry konsisten pada seluruh surface.
- [ ] Performance p95 produksi untuk start, save, dan voucher.

Exit gate Phase 3:

- [ ] Tombol mulai p95 di bawah 200 ms pada target hardware.
- [ ] Save setting p95 di bawah 1 detik.
- [ ] Generate 100 voucher p95 di bawah 2 detik.
- [ ] Setting dan voucher production terverifikasi saat Agent offline.

### Phase 4 — Local Controller dan SQLite

- [x] SQLite schema versioning dan penolakan schema yang lebih baru.
- [x] Cached config lokal dengan atomic file write.
- [x] Voucher allocation dan redemption offline.
- [x] Session, seluruh capture attempt, dan final selection.
- [x] Upload job melalui SQLite `sync_queue`.
- [x] Transactional outbox saat session completion.
- [x] UUID/session ID lokal dan stable sync job ID.
- [x] Foto ditulis ke filesystem lokal.
- [x] Upload Base64 sesi dari browser dihapus.
- [x] Upload Agent langsung ke R2/S3 memakai presigned PUT dan final HEAD verification.
- [x] Fallback Agent kompatibel dengan cloud lama tanpa memblokir outbox.
- [x] SHA-256 file checksum.
- [x] Retry exponential, dead-letter, dan retry manual.
- [x] Recovery claim Agent yang ditinggalkan.
- [x] Idempotent session completion.
- [x] Browser menyimpan recovery token, merekonstruksi selected capture dari
      SQLite, melanjutkan slot aktif, dan membuka kembali hasil completed.
- [x] Backoff queue kembali claimable otomatis ketika waktunya tiba setelah
      koneksi pulih.
- [x] Checkpoint upload per file disimpan di SQLite; retry Agent melewati file
      yang sudah tersinkron dan melanjutkan file yang belum selesai.
- [x] Device selection dicermin ke SQLite dan dipulihkan bila settings JSON
      rusak atau terpotong; field operasional dibatasi dengan allowlist.
- [x] Rendered asset dan print job persistence lengkap.
- [x] File 5–25 MB memakai multipart upload; upload ID, part size, dan ETag
      tiap part tersimpan di SQLite. Retry meminta signed URL baru dan melewati
      part yang sudah berhasil tanpa menyimpan URL/credential.
- [x] Queue dibatasi 1.000 job terbuka, menolak enqueue baru dengan pesan
      perbaikan yang eksplisit, dan memangkas history completed secara bounded.

Exit gate Phase 4:

- [x] Duplicate completion tidak membuat sync job ganda pada unit test.
- [x] Job kembali dapat diklaim dan diretry pada unit test.
- [x] Session aktif, pilihan capture, record SQLite, dan file JPEG pulih setelah
      Controller benar-benar dihentikan dengan process kill lalu dijalankan
      kembali melalui HTTP acceptance test.
- [ ] Foto production tetap aman setelah reconnect dan object upload.

### Phase 5 — Offline dan storage safety

- [x] QRIS dinyatakan unavailable saat offline.
- [x] Voucher yang sudah dialokasikan dapat dipakai offline secara atomik.
- [x] Folder default dan folder custom melalui Local Controller.
- [x] Telemetry RAM dan disk aktual.
- [x] Warning disk di bawah 20%.
- [x] Critical disk di bawah 10%.
- [x] Reserve minimum 2 GB dan blokir sesi baru jika tidak tersedia.
- [x] Sesi aktif tidak bergantung pada request cloud untuk capture.
- [x] Cleanup upload-aware; foto unsynced tidak menjadi target cleanup aman.
- [x] Rotasi log Agent dasar.
- [x] Signed offline policy lease 24/48/72 jam; QRIS efektif hanya ketika
  heartbeat segar, sesi baru diblokir setelah 72 jam, dan sesi aktif tetap dapat selesai.
- [x] Batas thumbnail dan GIF cache dengan penghapusan oldest-first.
- [x] Temporary file memiliki batas umur/ukuran dan settings ditulis atomik.
- [x] Cleanup preview dan dry-run memiliki loading, empty, error, retry, dan confirm state.
- [x] Local integration test menyelesaikan capture, selection, compositor, dan
      enqueue upload tanpa request cloud.
- [x] Capture memakai temporary file dan atomic replace; fault injection disk
      penuh/database rusak tidak meninggalkan file tanpa record atau mengubah sesi aktif.
- [x] Diagnosis menjalankan SQLite quick check dan tetap mengembalikan tindakan
      pemulihan ketika database rusak, tanpa ikut crash karena queue tidak terbaca.
- [x] Simulasi storage penuh dan corruption recovery: fault injection memastikan
  capture gagal tidak meninggalkan file/record parsial, sementara database aktif
  yang benar-benar dirusak dapat dipulihkan dari backup terverifikasi melalui
  kandidat restore sehat dan atomic replace.

Exit gate Phase 5:

- [ ] Booth menyelesaikan E2E sesi offline pada hardware target.
- [x] Storage penuh tidak merusak session database pada fault-injection test.
- [ ] Cleanup production terbukti tidak menghapus foto unsynced.
- [ ] Operator menerima recovery action yang sudah diuji.

### Phase 6–11 — Agent, setup, booth, admin, dan superadmin

- [x] Heartbeat 60 detik dan Agent protocol v2.
- [x] Pause cloud job tidak menghentikan heartbeat.
- [x] Token sensitif disensor dari status/log UI.
- [x] Local Manager: status cloud/pairing/system/perangkat, antrean upload dan
  cetak dengan retry per-job, pause/resume, restart, tes perangkat, diagnosis,
  folder, setup code, backup/restore SQLite, dan export log.
- [x] Setup komputer dasar dapat menyimpan progress.
- [x] Installer membuka setup dengan kode terisi; URL code lebih diprioritaskan
  daripada draft lama dan divalidasi dengan kontrak 15 menit.
- [x] Wizard komputer mencakup identitas, perangkat nyata dan tes, folder,
  frame opsional, readiness, serta aksi akhir ke booth.
- [x] Fondasi tablet standalone memakai manifest dan service worker API-safe,
  install prompt/fallback iOS, izin kamera depan/belakang, capture JPEG uji,
  permintaan storage persistence, deteksi dialog print, dan penjelasan jujur
  batas AirPrint/IPP serta background sync. Acceptance perangkat nyata tetap
  terbuka dan tidak dianggap menutup setup tablet.
- [x] Card wizard tetap pada posisi yang sama antar-step dan setiap langkah
  hanya memiliki satu primary action; diverifikasi pada langkah 1 dan 6.
- [x] Superadmin menampilkan indeks antrean remote bounded, status/error/attempt,
      serta retry job gagal/kedaluwarsa yang ditandatangani ulang, idempotent,
      disanitasi dari payload/secret, dan dicatat di audit log.
- [x] Superadmin dapat mengirim command aman `devices.refresh` dan
      `service.restart` melalui allowlist, signature HMAC, expiry 10 menit,
      idempotency key, machine queue, global index, konfirmasi restart, dan
      audit log. Arbitrary payload tidak pernah tersedia di browser.
- [x] Superadmin dapat menonaktifkan/mengaktifkan akses booth secara persistent;
      hanya role superadmin yang diterima, perubahan langsung memengaruhi hasil
      resolusi booth/heartbeat policy, dan setiap mutasi tercatat di audit global.
- [x] Superadmin menampilkan owner/admin/operator per booth dari membership
      tenant yang benar, termasuk status aktif dan tanggal dibuat. Projection
      ini dibatasi 500 user dan tidak pernah mengirim password/PIN hash.
- [x] Superadmin menampilkan status backup database lokal, jumlah dan waktu
      backup terakhir, serta hasil restore terakhir dari heartbeat Agent.
      Filename, checksum, path, payload error, dan secret lokal tidak pernah
      masuk projection cloud atau UI fleet.
- [x] Superadmin melakukan probe HEAD bertanda tangan dan bounded pada provider
      object storage aktif. Respons 404 pada object acak membuktikan endpoint
      dan credential dapat dijangkau tanpa membuat file; status 403/timeout
      tampil sebagai error tanpa signed URL, body provider, atau secret.
- [x] Permission matrix control-plane memisahkan Platform Owner, Integration
      Admin, Finance Admin, Fleet Admin, Support, dan Auditor. Endpoint dan UI
      membedakan read-only dari write fleet, remote job, feature flag, access,
      recovery, integration, finance, dan staff. Session legacy tetap aman
      sebagai Platform Owner.
- [x] Lifecycle akun platform mendukung invite token satu kali yang disimpan
      sebagai hash, aktivasi 24 jam, perubahan role, suspend/activate, revoke
      account, revoke sesi, re-authentication Platform Owner, safe projection,
      audit login/mutasi/recovery, dan UI loading/error/empty/retry. Ownership
      transfer atomik, pencabutan sesi, notifikasi owner, dan pengiriman
      undangan otomatis dengan payload terenkripsi sudah memiliki tes kontrak.
- [x] Booth capture/retake/session lokal dasar.
- [x] Admin config dasar dan fleet/superadmin dasar.
- Bukti Admin Booth: readiness dan status mesin, appearance responsif,
      background pagination, frame/layer editor, aturan sesi/retake, QRIS,
      voucher, paid print, perangkat, storage, maintenance, user/role, serta
      error actionable yang membuka halaman perbaikan. Save pengaturan menuju
      Cloud Data API dan tidak menunggu heartbeat Agent. Capability queue,
      Agent switch, updater, recovery, integration, dan finance tetap dinyatakan
      belum selesai di `ADMIN-CAPABILITIES.md`.
- [x] Admin booth menampilkan jumlah sesi login aktif per pengguna dan dapat
      mencabut seluruh sesi secara server-side. Owner/admin permission, proteksi
      sesi owner, logout current session, cookie cleanup, dan audit log diuji.
- [x] Log Cloud, Agent, Controller, diagnosis, dan export memakai redaksi
      terpusat untuk token, cookie, password/PIN hash, provider credential, dan
      signed object URL; struktur serta ukuran output dibatasi.
- [x] Login booth/superadmin, bantuan password, validasi setup, dan klaim booth
      memakai counter rate limit Redis yang atomik, tenant-scoped, expire
      otomatis, serta mengembalikan HTTP 429 dan `Retry-After`.
- Bukti login PIN lokal: UI remote default ke email/password, opsi PIN memerlukan
  capability loopback, assertion HMAC 60 detik yang terikat machine/booth, serta
  nonce cloud sekali pakai.
- [x] Seluruh mutasi Cloud Platform memakai same-origin dan Fetch Metadata gate;
      cross-site/opaque browser request ditolak sebelum body diproses, sedangkan
      client non-browser bertoken tetap didukung.
- [x] Superadmin menampilkan lokasi seluruh booth, state Agent/Controller,
      version, telemetry RAM/disk, last seen, dan audit log global bounded
      dengan loading, empty, error, serta retry state.
- [ ] Signed installer `.exe`, notarized `.pkg`, dan release `.deb`.
- [x] PIN enam angka dibatasi hanya untuk login lokal; cloud menolak raw PIN
      tanpa assertion Controller yang valid.
- [x] Atomic updater memakai manifest RSA-2048/SHA-256, checksum bundle/per-file,
      download streaming, backup versi, health check, rollback otomatis, serta
      rollback manual dari Local Manager. Superadmin dapat mengirim check,
      apply, dan rollback signed/expiring per mesin; heartbeat membawa state
      updater nyata. Acceptance installer lintas OS dan staged rollout tetap terbuka.
- [ ] Semua Local Manager control memiliki API production.
- [ ] Setup tablet standalone dan companion.
- [ ] Acceptance production compositor, GIF, dan print pada hardware pilot.
- [ ] Admin role/session revoke/finance/integration production.
- [ ] Superadmin control plane, rollout, health, incident, dan role lengkap.
- [ ] Seluruh exit gate Phase 6–11.

### Phase 12 — Integration marketplace

- [x] Hardcoded deployment capability diganti provider registry.
- [x] Provider capability contract.
- [x] Registry awal R2, S3-compatible, Xendit, dan Resend.
- [x] Adapter tanpa implementasi selalu dilaporkan unavailable; R2/S3 hanya aktif bila credential lengkap.
- [x] Secret value tidak pernah dikirim lewat provider registry.
- [x] Adapter SigV4 R2/S3 untuk PUT/GET/HEAD/DELETE dengan URL berumur pendek.
- [x] File sesi object storage tidak disimpan ulang sebagai Base64 di Redis.
- [x] Aset admin/setup memakai presigned PUT dan final HEAD verification.
- [x] Global/organization/booth provider connections runtime dengan precedence,
      default per capability, serta platform-managed/BYO assignment.
- [x] Encrypted credential store AES-256-GCM, masked projection, expiry,
      replace/rewrap, pause/resume/revoke, permission, dan audit tanpa secret.
- [x] Koneksi storage tersimpan dikonsumsi oleh upload/download/delete aset,
      upload sesi Agent termasuk multipart, dan cleanup retensi; upload intent
      mengunci provider sampai finalize. Tes koneksi melakukan probe server-side
      dengan timeout, state UI yang persisten setelah reload, permission, serta
      audit tanpa credential.
  Masih terbuka: OAuth, health/quota, usage, serta acceptance provider live.
- [x] Monitoring webhook server-side dengan HMAC SHA-256, idempotency key,
      deduplikasi per event insiden, timeout, retry exponential, delivery state,
      credential vault, probe koneksi, dan UI superadmin tanpa secret.
- [ ] Acceptance production R2/S3, Xendit, Resend, dan SMTP.
- [x] Provider switching memiliki manifest, checkpoint, pause/resume, checksum,
      retry terbatas, recovery interruption, dan UI superadmin nyata.
- [x] Background migration ber-lock dan disconnect aman provider booth setelah cutover terverifikasi.
- [ ] Seluruh exit gate Phase 12.

### Phase 13–15 — Payment, payout, dan email

- [x] Dynamic QRIS cloud, create/status Xendit, IDR-only, QR image server-side,
      fee global/per-booth yang disalin ke intent, serta reconciliation worker
      untuk webhook hilang. Payment terlambat masuk antrean review superadmin
      dengan approve/reject, catatan, reviewer, persistence, dan audit nyata.
- [ ] Acceptance sandbox/live dan adapter xenPlatform production.
- [x] Webhook Xendit memverifikasi callback token, nominal, replay, dan idempotency.
- [ ] Migration PostgreSQL append-only, RLS, direct dual-write, dan static contract
      sudah tersedia, tetapi belum boleh disebut ledger production sebelum migration
      diterapkan serta diuji pada project Supabase Photoslive.
- [x] Refund penuh meminta provider satu kali, menerima status final dari webhook,
      menulis compensating ledger, menolak regresi terminal, dapat direhidrasi
      dari PostgreSQL setelah cache expiry, serta memiliki UI permission/loading/
      success/error dan audit superadmin.
- [x] Chargeback terkonfirmasi dicatat idempotent dari superadmin, mengunci status
  payment, membuat ledger kompensasi sekali, tersimpan ke PostgreSQL, dan diaudit.
- [x] Koreksi finance dibuat sebagai adjustment append-only bertanda positif/negatif,
      memiliki referensi unik, permission, konfirmasi UI, PostgreSQL, dan audit.
- [x] Proyeksi saldo per booth memisahkan pending dan available secara konservatif,
      deduplikasi cache/PostgreSQL, permission read, empty/error/retry UI, dan test agregasi.
- [x] Reconciliation provider-vs-ledger manual melalui impor CSV, run persisten/idempotent, permission finance, audit, riwayat, dan skenario nol-selisih.
- [ ] Ingest laporan settlement/provider fee otomatis dan partial refund.
- [ ] Auto payout dan manual superadmin payout.
- [ ] Maker-checker, transfer proof, dan finance dashboard.
- [x] Adapter Resend, template payout/recovery/alert, antrean persisten bounded,
      deterministic idempotency, serta server-only credential.
- [x] Webhook Resend terverifikasi HMAC/Svix, timestamp tolerance, deduplikasi,
      dan state delivered/bounced/complained/suppressed tanpa regresi terminal.
- [x] UI superadmin antrean/tes/retry memiliki RBAC, loading/error/empty state,
      persistence, audit, serta recipient masking.
- [ ] Resend production, verified domain, signed proof link, dan acceptance live.
- [ ] Seluruh exit gate Phase 13–15.

### Phase 16–18 — Design, security, observability, dan DR

- [x] Token UI dasar, radius/spacing/icon consistency dari iterasi sebelumnya.
- [x] UI admin mengikuti capability aktual: kontrol dependen dinonaktifkan saat
      induknya mati, provider yang belum tersedia tidak ditampilkan sebagai
      pilihan aktif, error lokal/cloud memberi tindakan perbaikan, dan halaman
      panjang memiliki navigasi bagian yang tetap sederhana. Verifikasi browser
      lokal mencakup System, Tampilan, Sesi, Perangkat, Penyimpanan, Integrasi,
      Finance, dan Pengguna tanpa overflow horizontal. Navigasi domain
      superadmin sudah dikelompokkan secara struktural; visual authenticated
      superadmin masih memerlukan akun uji dan tetap menjadi bukti terbuka.
- Bukti desain sekarang mencakup token bersama, breakpoint admin, layout booth
  portrait/landscape, status multimodal, dan contrast inti di
  `docs/DESIGN-SYSTEM.md` serta `tests/design-system.test.mjs`.
- [x] Navigasi keyboard setup dan welcome booth diverifikasi pada build source
      lokal: urutan Tab mengikuti alur visual dan seluruh kontrol interaktif
      menampilkan focus ring yang terlihat.
- [x] HMAC command, expiry, idempotency, allowlist, dan rate limit hardware job.
- [x] Local installation token dan secret redaction dasar.
- [x] Correlation ID, structured request log, dan server timing.
- [x] PostgreSQL RLS/static security contract.
- [x] Link hasil pelanggan memakai kode acak 128 bit, expiry cloud maksimal 24
      jam yang tidak dapat diperpanjang oleh upload ulang, serta endpoint file
      yang memvalidasi sesi induk dan manifest sebelum memberi byte/signed URL.
- [x] Session admin memakai cookie `__Host-` host-only dengan `HttpOnly`,
      `Secure`, `SameSite=Lax`, `Path=/`, dan logout menghapus cookie memakai
      atribut scope yang identik.
- [x] Backup SQLite harian/manual memakai Online Backup API, manifest/checksum,
      retention bounded, safety backup, dan restore yang menolak sesi aktif.
- [x] RPO/RTO didefinisikan per Controller crash, korupsi SQLite, offline,
      reinstall Agent, kerusakan SSD, cloud database, object storage, dan web
      deployment; target tanpa drill tetap ditandai belum terpenuhi.
- [x] Registry observability lokal dibatasi 512 request dan menampilkan latency
      p95/error rate, queue depth upload/cetak, serta kegagalan
      kamera/capture/printer/render di Local Manager tanpa dependency baru.
      Local Manager juga menaikkan state warning/kritis dengan tindakan jelas
      pada ambang disk 20%, 10%, atau reserve 2 GB.
- [x] Superadmin fleet health membedakan heartbeat siap/terlambat/offline,
      menyimpan maksimal 200 insiden tanpa duplikat, mengaudit acknowledgement,
      menyediakan retry UI, dan menyelesaikan insiden pada heartbeat pemulihan.
      Routing proaktif ke email/pager tetap belum tersedia.
- [x] Superadmin memverifikasi cache dengan probe write/read/delete ber-TTL,
      memeriksa koneksi PostgreSQL shadow dengan timeout bounded, dan
      menampilkan readiness adapter tanpa mengirim credential ke browser.
      Provider transaction health serta alert proaktif tetap terbuka.
- [ ] Visual regression dan accessibility matrix penuh.
- [x] Threat model dengan register machine-readable, trust boundary, residual
      risk, owner, evidence, dan gate eksplisit untuk payment, payout, serta updater.
- [x] CSRF same-origin gate dan pairing takeover guard: hanya kode terbaru yang
      belum diklaim dapat dipakai, concurrent setup dikunci atomik, kode lama
      dibatalkan, dan endpoint pairing legacy memerlukan session admin.
- [x] Consent pemrosesan foto diberikan melalui aksi lanjut yang eksplisit,
      diwajibkan endpoint sesi booth, diberi versi, dan disimpan bersama sesi
      pada SQLite Controller.
- [x] Cloud retention menutup akses maksimal 24 jam, mengindeks expiry, dan
      menghapus object storage sebelum metadata melalui cron terautentikasi;
      kegagalan provider mempertahankan record untuk retry.
- [x] Early deletion pelanggan memiliki konfirmasi destruktif, audit cloud,
      object cleanup, dan job lokal signed/idempotent yang tetap berlaku tujuh
      hari ketika Agent offline.
- [x] Dependency scanning CI mengaudit lockfile npm dan requirement Python
      terpin serta menggagalkan severity high/critical.
- [x] Secret scanning CI memeriksa seluruh history memakai Gitleaks Action yang
      dipin ke full commit SHA.
- Bukti tambahan: incident response runbook menetapkan severity dan SLA,
  Incident Commander, containment, preservasi bukti, recovery, komunikasi,
  postmortem, playbook fleet/privasi/finance/storage, serta tabletop drill
  kuartalan. Pelaksanaan drill tetap terbuka pada item berikutnya.
- [ ] Passkey remote, pentest, dan incident drill.
- [x] Public status page dengan loading/error/retry/timeout, projection komponen
      yang aman, dan tanpa provider/database detail atau secret.
- [x] Alert routing proaktif untuk insiden Agent offline/pulih dengan antrean
      terpisah, retry manual, proses cron fallback, permission, dan audit log.
- [x] Histori telemetry fleet time-series bounded: bucket 5 menit, retensi 7 hari,
      projection tanpa hostname/credential, RBAC, range selector, grafik, empty,
      loading, error, dan retry state di superadmin.
- [ ] Restore drill hardware.
- [ ] Seluruh exit gate Phase 16–18.

### Phase 19 — Testing matrix

- [x] Unit/integration dasar local config, voucher, session, outbox, retry, storage.
- [x] Static security/provider/observability/PostgreSQL contract tests.
- [x] CI web dan Python.
- [x] CI Supabase start/reset/lint disiapkan.
- [ ] Supabase runtime test lokal; Docker belum tersedia.
- [ ] Hardware simulator dan webcam/gPhoto2/CUPS/AirPrint acceptance tests.
- [ ] Full browser E2E seluruh route dan kontrol.
- [ ] Fault matrix offline/timeout/process death/storage/device/provider.
- [ ] Load test dan 72-hour soak test pada RAM 4 GB.

Exit gate Phase 19:

- [ ] Seluruh P0/P1 test lulus.
- [ ] Tidak ada blocker/critical defect.
- [ ] Seluruh performance budget terpenuhi.

### Phase 20–21 — Dokumentasi, pilot, dan produksi

- [x] Architecture local-first.
- [x] Interaction contract dan route behavior.
- [x] Protocol contracts dan current implementation status.
- [x] Mature product tracker/checklist ini.
- [x] Panduan operator backup/restore database lokal beserta batas dan perintah
      verifikasi tersedia pada build ini.
- [ ] Installer, setup, Local Manager, operator, admin, superadmin, finance,
      offline, troubleshooting, incident, backup/restore, privacy, dan release guide final.
- [ ] Pilot mini PC, Windows/macOS, tablet standalone, dan companion.
- [ ] QRIS/payout sandbox dan transaksi live internal.
- [ ] 5–10 booth rollout, security review, compliance review, dan staged production.
- [ ] Seluruh final production gate.

### Default arsitektur yang dikunci

- [x] Local-first dengan cloud control.
- [x] Tidak menggunakan Electron.
- [x] Provider registry mendukung arah platform-managed dan BYO.
- [x] Capability yang belum tersedia disembunyikan/dinonaktifkan.
- [x] IDR-only dicatat sebagai target v1.
- [x] Tablet standalone memiliki batas browser yang dinyatakan transparan.
- [x] Companion tetap direkomendasikan untuk hardware/print penuh.
- [x] Rollout tidak boleh disebut selesai tanpa rollback dan bukti gate.
- [ ] QRIS Xendit production, payout harian, manual payout, dan Resend baru
      dianggap terkunci secara operasional setelah adapter serta compliance lulus.

## Bukti verifikasi lokal terakhir

- `python3 -m unittest discover -s tests -q`: 83/83 lulus.
- Node test runner dari `web`: 364/364 lulus termasuk syntax check seluruh JavaScript.
- `node web/scripts/audit-product.mjs --summary`: delapan surface, 434 kontrol,
  433 wired, satu unavailable, dan nol unknown.
- `git diff --check`: lulus.
- Supabase CLI dipin ke `2.109.1`; runtime SQL lokal belum dijalankan karena
  Docker tidak tersedia pada mesin pengembangan ini.

## Aturan pembaruan

Setiap perubahan status wajib menambahkan test atau bukti operasional. Item
hardware, finance, security, installer, dan disaster recovery tidak boleh
ditandai selesai hanya berdasarkan code review atau simulator.
