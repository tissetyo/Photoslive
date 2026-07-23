# Checklist Implementasi Keseluruhan Photoslive

## Aturan Penyelesaian

Sebuah item hanya boleh ditandai selesai jika:

- [ ] Fitur memiliki implementasi backend/local operation nyata.
- [ ] UI memiliki loading, success, error, disabled, empty, dan retry state.
- [ ] Data tetap tersimpan setelah reload dan restart.
- [ ] Permission dan tenant isolation sudah diuji.
- [ ] Aktivitas sensitif tercatat di audit log.
- [ ] Unit/integration/E2E test terkait sudah lulus.
- [ ] Dokumentasi operator dan teknis diperbarui.
- [ ] Tidak ada tombol aktif yang masih berupa mockup.
- [ ] Phase tidak boleh ditutup sebelum seluruh exit gate-nya lulus.

> Status 22 Juli 2026: **505 dari 627 item** memiliki bukti implementasi pada
> build ini; **122 masih terbuka** dan belum ada phase yang memenuhi seluruh
> exit gate. Detail bukti parsial dicatat di `MATURE-PRODUCT-TRACKER.md`.

### Penanda tindakan untuk item terbuka

- Item `- [ ]` tanpa penanda adalah pekerjaan **development** yang masih harus
  diselesaikan di repository, atau gate turunan yang otomatis tetap terbuka
  sampai seluruh prasyaratnya selesai.
- **[AKSI ANDA]** memerlukan akun, credential, keputusan, approval, perangkat,
  atau pelaksanaan langsung oleh pemilik Photoslive.
- **[AKSI BERSAMA]** baru dapat ditutup setelah implementasi selesai dan kita
  menjalankan acceptance/cutover bersama pada environment nyata.
- **[EKSTERNAL]** memerlukan provider atau pihak independen, misalnya KYC,
  notarization, penetration test, atau compliance review.
- Penanda bukan status selesai. Item tetap `- [ ]` sampai seluruh aturan
  penyelesaian di atas memiliki bukti. Instruksi praktis ada di
  `MANUAL-SETUP-ACTIONS.md`.

---

## Phase 0 — Audit dan Baseline

- [x] Inventaris seluruh route publik, booth, admin, setup, local manager, dan superadmin.
- [x] Inventaris seluruh tombol, input, toggle, upload, modal, tabel, dan pagination.
- [x] Tandai fitur real, partial, mockup, broken, dan unavailable.
- [x] Petakan seluruh endpoint cloud dan local.
- [x] Petakan data Redis, file lokal, SQLite, dan aset Base64.
- [x] Ukur latency tombol mulai, save settings, voucher, capture, render, dan print.
- [ ] Ukur RAM, CPU, disk, network, dan startup pada mini PC 4 GB. **[AKSI BERSAMA]**
- [x] Dokumentasikan bug produksi saat ini.
- [x] Buat hardware compatibility baseline.
- [x] Tambahkan correlation ID dan timing log.
- [x] Buat feature flag untuk migrasi bertahap.
- [x] Buat rollback procedure untuk setiap release.

Exit gate:

- [x] Interaction inventory lengkap.
- [x] Baseline performance tersimpan.
- [x] Tidak ada area produk yang status implementasinya tidak diketahui.

## Phase 1 — Struktur Repository dan Kontrak Bersama

- [ ] Pisahkan cloud web, booth PWA, Controller, Agent, contracts, dan design system.
- [ ] Cloud admin menggunakan Next.js/React.
- [ ] Booth menggunakan TypeScript/Vite PWA ringan.
- [x] Controller dan Agent tetap Python pada migrasi awal.
- [x] Buat shared API schemas.
- [x] Buat shared event schemas.
- [x] Buat provider capability contract.
- [x] Buat versioning untuk cloud/local protocol.
- [x] Buat backward compatibility policy.
- [x] Pin dependency versions dan commit lockfiles.
- [x] Siapkan CI untuk seluruh aplikasi dan service.
- [x] Pastikan build tidak memerlukan Electron.

Exit gate:

- [ ] Semua package dapat dibuild terpisah.
- [x] Contract test cloud–Agent–Controller lulus.
- [x] Booth dapat dijalankan tanpa bundle admin.

## Phase 2 — PostgreSQL, Auth, dan Migrasi Data

- [ ] Siapkan PostgreSQL/Supabase. **[AKSI ANDA]**
- [ ] Implementasikan Auth untuk admin dan superadmin.
- [ ] Implementasikan role Owner, Admin, Operator, Support, Auditor, dan superadmin roles.
- [x] Aktifkan RLS pada seluruh tabel exposed.
- [x] Buat tenant isolation berdasarkan booth membership.
- [ ] Pindahkan booth dan lokasi dari Redis. **[AKSI BERSAMA]** Private
  machine/organization links, RPC service-role-only, mode `off|dual|primary`,
  database-before-cache, recovery Redis, fail-closed setup/toggle, serta alat
  dry-run/apply idempotent dengan checksum dan verifikasi selesai; menunggu
  migration, eksekusi report/backfill, record-count, restart, multi-browser,
  dan restore acceptance pada project Supabase nyata.
- [ ] Pindahkan config dan config version. **[AKSI BERSAMA]** RPC transaksional,
  recovery read, database-before-cache, dan fail-closed selesai; menunggu
  migration, record-count, restart, serta restore acceptance PostgreSQL nyata.
- [ ] Pindahkan user dan membership.
- [ ] Pindahkan voucher dan event. **[AKSI BERSAMA]** Implementasi transactional
  primary/dual, recovery read, dan cache refresh selesai; menunggu migration,
  record-count, restart, serta restore acceptance pada PostgreSQL nyata.
- [ ] Pindahkan session metadata. **[AKSI BERSAMA]** RPC service-role-only,
  mode `off|dual|primary`, database-before-cache, terminal-state guard, tombstone
  privacy deletion dua tahap, Redis/session-file/retention recovery dari manifest
  internal, validasi object key, dan public redaction selesai; menunggu migration
  production, record-count, verifikasi binary provider, restart,
  offline/reconnect, multi-browser, dan restore acceptance nyata.
- [ ] Pindahkan audit log.
- [ ] Migrasikan aset Base64 ke object storage. **[AKSI BERSAMA]** Adapter
  metadata PostgreSQL `off|dual|primary`, database-before-cache, private-key
  redaction, cache recovery, dan two-phase delete retry sudah teruji lokal;
  migration live, backfill binary/metadata lama, checksum/record-count,
  acceptance R2/S3, serta restore drill masih wajib diselesaikan.
- [ ] Jalankan dual-read sementara. **[AKSI BERSAMA]**
- [ ] Buat checksum dan migration report. **[AKSI BERSAMA]** Generator report
  direktori booth sudah tersedia, deterministik, dimasking, dan fail-on-mismatch;
  item tetap terbuka sampai report production disimpan dan jumlah record cocok.
- [ ] Buat backup sebelum cutover. **[AKSI BERSAMA]**
- [ ] Pertahankan legacy read fallback selama rollout.
- [ ] Hentikan write lama setelah verifikasi. **[AKSI ANDA]**
- [x] Jangan hapus data lama sebelum approval terpisah.

Exit gate:

- [ ] Jumlah record lama dan baru cocok. **[AKSI BERSAMA]**
- [x] Seluruh RLS test lulus.
- [x] Reload dan multi-browser persistence lulus.
- [ ] Restore backup berhasil diuji. **[AKSI BERSAMA]**

## Phase 3 — Performa dan Pemisahan Cloud dari Agent

- [ ] Save settings langsung ke cloud database. **[AKSI BERSAMA]** Mode
  `dual|primary` dan respons retryable telah terimplementasi; cutover live dan
  p95 production belum lulus.
- [x] Save settings tidak menunggu Agent.
- [ ] Voucher dibuat dalam satu database transaction. **[AKSI BERSAMA]** RPC dan
  fail-closed cache ordering teruji; menunggu integration test Supabase nyata.
- [ ] Generate 100 voucher menggunakan bulk insert. **[AKSI BERSAMA]** Satu SQL
  insert bounded 100 tersedia; menunggu p95 dan persistence acceptance live.
- [x] Tambahkan idempotency key.
- [x] Tombol mulai membaca cached booth config.
- [x] Tombol mulai tidak menunggu machine heartbeat.
- [x] Camera check berjalan paralel.
- [x] Hardware actions memakai job queue terpisah.
- [x] Cloud-data API tidak memanggil Agent dalam request yang sama.
- [x] Tambahkan optimistic UI untuk setting.
- [x] Tambahkan timeout yang jelas.
- [x] Tambahkan retry terbatas.
- [x] Tampilkan backend error asli.
- [x] Implementasikan sync worker nyata.
- [x] Tambahkan dead-letter queue.
- [x] Tambahkan retry manual dari admin.

Exit gate:

- [ ] Tombol mulai di bawah 200 ms. **[AKSI BERSAMA]**
- [ ] Save settings p95 di bawah 1 detik. **[AKSI BERSAMA]**
- [ ] Generate 100 voucher p95 di bawah 2 detik. **[AKSI BERSAMA]**
- [x] Setting dan voucher tetap bekerja saat Agent offline.

## Phase 4 — Local Controller dan SQLite

- [x] Buat migration versioning untuk SQLite.
- [x] Simpan cached config.
- [x] Simpan device selection.
- [x] Simpan voucher allocation offline.
- [x] Simpan photo session.
- [x] Simpan seluruh capture attempt.
- [x] Simpan final selection.
- [x] Simpan rendered assets.
- [x] Simpan print jobs.
- [x] Simpan upload jobs.
- [x] Simpan remote hardware jobs.
- [x] Implementasikan transactional outbox.
- [x] Gunakan UUID lokal untuk session.
- [x] Tulis foto langsung ke disk.
- [x] Jangan menyimpan file besar di browser memory.
- [x] Implementasikan resumable upload.
- [x] Tambahkan file checksum.
- [x] Tambahkan retry dan exponential backoff.
- [x] Tambahkan queue size limit.
- [x] Tambahkan crash recovery.
- [x] Tambahkan idempotent session completion.

Exit gate:

- [x] Session aktif pulih setelah Controller restart.
- [x] Duplicate sync tidak membuat data ganda.
- [x] Foto tetap aman setelah internet terputus.
- [x] Queue kembali berjalan setelah reconnect.

## Phase 5 — Offline Policy dan Storage Safety

- [x] Implementasikan signed offline policy lease.
- [x] Normal mode sampai 24 jam.
- [x] Warning mode 24–48 jam.
- [x] Critical mode 48–72 jam.
- [x] Blokir sesi baru setelah 72 jam.
- [x] Izinkan sesi aktif selesai.
- [x] Nonaktifkan QRIS saat offline.
- [x] Izinkan voucher yang telah dialokasikan.
- [x] Implementasikan folder default.
- [x] Implementasikan folder picker native.
- [x] Validasi folder writable.
- [x] Ukur RAM dan disk aktual.
- [x] Warning ketika disk bebas di bawah 20%.
- [x] Critical ketika disk bebas di bawah 10%.
- [x] Reserve minimal 2 GB.
- [x] Blokir sesi baru ketika reserve tidak tersedia.
- [x] Retensi lokal dimulai setelah upload berhasil.
- [x] Foto belum ter-upload tidak boleh dihapus.
- [x] Batasi thumbnail cache.
- [x] Batasi GIF cache.
- [x] Rotasi log dan temporary files.
- [x] Tambahkan cleanup preview dan dry run.

Exit gate:

- [x] Booth menyelesaikan sesi tanpa internet.
- [x] Storage penuh tidak merusak session database.
- [x] Cleanup tidak menghapus foto unsynced.
- [x] Operator mendapat tindakan perbaikan yang jelas.

## Phase 6 — Agent, Installer, dan Service Lifecycle

- [ ] Buat installer Windows. **[AKSI BERSAMA]**
- [ ] Buat installer macOS signed/notarized. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Buat paket Linux `.deb`. **[AKSI BERSAMA]**
- [x] Pertahankan script Terminal untuk teknisi.
- [x] Pasang service otomatis.
- [x] Linux memakai systemd restart policy.
- [x] macOS memakai LaunchAgent KeepAlive.
- [x] Windows memakai restart-on-failure/watchdog.
- [x] Installer membuat installation token.
- [x] Installer membuka setup code otomatis.
- [x] Heartbeat berjalan setiap 60 detik.
- [x] Agent tetap heartbeat ketika booth access dimatikan.
- [x] Implementasikan pause/resume cloud connection.
- [x] Implementasikan service restart.
- [x] Implementasikan signed update.
- [x] Verifikasi checksum update.
- [x] Backup versi lama.
- [x] Jalankan post-update health check.
- [x] Rollback otomatis jika health check gagal.
- [x] Jangan tampilkan Agent token di log/UI.

Exit gate:

- [ ] Service kembali hidup setelah crash. **[AKSI BERSAMA]**
- [ ] Service kembali hidup setelah reboot. **[AKSI BERSAMA]**
- [x] Update gagal dapat rollback.
- [ ] Installer bekerja tanpa Terminal pada flow utama. **[AKSI BERSAMA]**

## Phase 7 — Local Manager

- [x] Tampilkan Agent state.
- [x] Tampilkan Controller state.
- [x] Tampilkan internet/cloud state.
- [x] Tampilkan pairing dan booth code.
- [x] Tampilkan kamera dan printer aktual.
- [x] Tampilkan RAM, CPU, disk, uptime, dan version.
- [x] Tampilkan folder foto.
- [x] Tampilkan sync queue.
- [x] Tampilkan print queue.
- [x] Tampilkan update dan error terakhir.
- [x] Implementasikan **Periksa**.
- [x] Implementasikan **Pause koneksi**.
- [x] Implementasikan **Resume**.
- [x] Implementasikan **Restart**.
- [x] Implementasikan **Update**.
- [x] Implementasikan **Rollback**.
- [x] Implementasikan **Tes perangkat**.
- [x] Implementasikan **Pilih folder**.
- [x] Implementasikan **Buat kode setup**.
- [x] Implementasikan **Diagnosis**.
- [x] Implementasikan **Lihat/export log**.
- [x] Implementasikan hard stop hanya pada Advanced.
- [x] Menutup browser Local Manager tidak menghentikan service.

Exit gate:

- [x] Semua kontrol memiliki local API nyata.
- [x] Local Manager hanya bind ke loopback.
- [x] Diagnosis menghasilkan laporan yang menyensor secret.

## Phase 8 — Setup Komputer dan Tablet

### Komputer

- [x] Deteksi OS otomatis.
- [x] Tampilkan satu installer utama.
- [x] Validasi setup code 15 menit.
- [x] Input nama photobox.
- [x] Input lokasi.
- [x] Input email owner.
- [x] Input dan konfirmasi PIN lokal.
- [x] Deteksi nama kamera aktual.
- [x] Deteksi nama printer aktual.
- [x] Pilih kamera.
- [x] Tes kamera.
- [x] Pilih printer.
- [x] Tes printer.
- [x] Pilih folder foto.
- [x] Pilih/upload frame.
- [x] Izinkan langkah opsional dilewati.
- [x] Tampilkan readiness summary.
- [x] Implementasikan **Mulai gunakan photobox**.

### Tablet standalone

- [x] Tambahkan PWA install flow.
- [x] Minta izin kamera.
- [x] Minta storage persistence bila didukung.
- [x] Pilih kamera depan/belakang.
- [x] Tes capture.
- [x] Deteksi print capability.
- [x] Jelaskan batas AirPrint/IPP.
- [x] Jelaskan batas background sync.
- [x] Simpan progress setup.

### Tablet companion

- [x] Komputer membuat pairing QR.
- [x] Tablet memindai QR.
- [x] Implementasikan local handshake.
- [x] Gunakan expiring pairing token.
- [ ] Uji latency. **[AKSI BERSAMA]**
- [ ] Uji printer dan storage companion. **[AKSI BERSAMA]**
- [x] Tampilkan reconnect state.
- [x] Tampilkan fallback standalone.

Exit gate:

- [x] Setup dapat dilanjutkan setelah restart.
- [ ] Tidak ada Terminal pada flow operator. **[AKSI BERSAMA]**
- [ ] Setup dapat diselesaikan orang nonteknis. **[AKSI ANDA]**
- [x] Card tidak berpindah-pindah antar-step.
- [x] Setiap langkah memiliki satu primary action.

## Phase 9 — Booth Pelanggan

- [x] Welcome menggunakan konfigurasi admin.
- [x] Logo, teks, font, warna, dan ukuran sinkron.
- [x] Modal akses hanya tampil jika QRIS/voucher aktif.
- [x] QRIS hilang saat offline.
- [x] Voucher redeem bekerja.
- [x] Pilihan frame menampilkan preview frame sebenarnya.
- [x] Frame list mendukung search dan pagination.
- [x] Kamera mulai saat frame selection.
- [x] Stream kamera dipertahankan antar-screen.
- [x] Confirmation memakai blur/overlay 30%.
- [x] Click-to-start bekerja.
- [x] Countdown default 15 detik.
- [x] Capture sesuai slot frame.
- [x] Retake tanpa batas selama session time.
- [x] Attempt tersimpan per slot.
- [x] Thumbnail tetap kecil di pojok.
- [x] Final selection tersimpan.
- [x] Frame dirender sesuai printer format.
- [x] GIF dibuat di background.
- [x] Hasil utama tampil sebelum GIF selesai.
- [ ] Print langsung bekerja. **[AKSI BERSAMA]**
- [ ] Paid print bekerja. **[AKSI BERSAMA]**
- [x] Printer offline ditangani tanpa kehilangan foto.
- [x] Goodbye tampil 15 detik.
- [x] Tombol **Lewati** bekerja.
- [x] Session kembali ke welcome.
- [x] Customer download page aktif 24 jam.
- [x] Foto mentah dapat diunduh satu per satu.
- [x] Frame/GIF dapat diunduh.
- [x] ZIP dapat dibuat tanpa memblokir booth.

Exit gate:

- [x] Seluruh flow lulus E2E.
- [x] Flow dapat selesai offline menggunakan voucher/free mode.
- [x] Retake tidak merusak layout.
- [x] Kamera tidak reconnect pada setiap layar.

## Phase 10 — Admin Booth

- [x] Dashboard readiness.
- [x] Machine status center.
- [x] Pengaturan layar portrait/landscape.
- [x] Logo, font, warna, ukuran teks, dan tombol.
- [x] Background dengan pagination.
- [x] Frame editor lengkap.
- [x] Layer, slot, sticker, opacity, rotation, dan scale.
- [x] Frame preview dan printer preview konsisten.
- [x] Aturan sesi dan slot.
- [x] Countdown dan session limit.
- [x] Retake policy.
- [x] QRIS dan voucher toggles.
- [x] Paid print toggle.
- [x] Voucher umum dan event.
- [x] Camera/printer selection dan test.
- [x] Storage, folder, quota, dan retention.
- [x] Sync/upload queue.
- [x] Print queue.
- [x] Agent connection switch.
- [x] Maintenance mode.
- [x] Update/version/rollback.
- [x] Session recovery.
- [x] Integrations.
- [x] Finance.
- [x] User dan role.
- [x] Login session revoke.
- [x] Actionable error dengan link perbaikan.

Exit gate:

- [x] Setting dapat disimpan saat Agent offline.
- [x] Hardware action menunjukkan pending/unavailable dengan benar.
- [x] Seluruh kontrol tetap persistent setelah reload.
- [x] Tidak ada kontrol aktif tanpa backend.

Bukti UI 23 Juli 2026: halaman admin lokal telah diverifikasi pada System,
Tampilan, Sesi, Perangkat, Penyimpanan, Integrasi, Finance, dan Pengguna. Kontrol
turunan mengikuti toggle induk, fitur cloud yang tidak tersedia dinonaktifkan
dengan pesan serta retry yang jelas, dan navigasi bagian mengurangi halaman
panjang tanpa menyembunyikan konfigurasi nyata. Verifikasi visual superadmin
terautentikasi masih membutuhkan akun uji dan tidak dihitung selesai hanya dari
kontrak struktural.

## Phase 11 — Superadmin Control Plane

### Fleet dan backend

- [x] Lihat seluruh booth dan lokasi.
- [x] Lihat owner dan membership.
- [x] Aktif/nonaktifkan akses booth.
- [x] Lihat Agent/Controller state.
- [x] Lihat version, telemetry, dan last seen.
- [x] Kirim remote jobs.
- [x] Maintenance dan session recovery.
- [ ] Agent rollout. **[AKSI BERSAMA]**
- [x] Feature flags global/organization/booth.
- [x] Queue monitoring dan retry.
- [x] Webhook logs.
- [x] Provider health.
- [x] Cache/database health.
- [x] Backup/restore status.
- [x] Email delivery.
- [x] Incident timeline.
- [x] Audit log.

### User dan permission

- [x] Platform Owner role.
- [x] Integration Admin role.
- [x] Finance Admin role.
- [x] Fleet Admin role.
- [x] Support role.
- [x] Auditor role.
- [x] Invite/suspend/revoke user.
- [x] Ownership transfer.
- [x] Recovery request.
- [x] Revoke login session.
- [x] Re-authentication untuk aksi sensitif.
- [x] Emergency access tercatat.

### Batas keamanan

- [x] Tidak ada raw database console di UI.
- [x] Tidak ada master encryption key di UI.
- [x] Tidak ada Agent installation token di UI.
- [x] Semua operasi backend melalui secure APIs.
- [x] Semua perubahan sensitif masuk audit log.

Exit gate:

- [ ] Superadmin dapat mengontrol seluruh operasi backend yang diizinkan. **[AKSI BERSAMA]**
- [x] Support tidak dapat melihat secret/nomor rekening lengkap.
- [x] Auditor hanya memiliki akses read-only.

## Phase 12 — Integration Marketplace

- [x] Ganti `deploymentCapabilities()` hardcoded dengan provider registry.
- [x] Buat provider capability contract.
- [x] Buat global provider connections.
- [x] Buat organization provider connections.
- [x] Buat booth provider connections.
- [x] Dukung platform-managed provider.
- [x] Dukung BYO provider.
- [x] Dukung provider default dan per-booth override.
- [ ] Implementasikan OAuth bila tersedia. **[AKSI ANDA] [EKSTERNAL]**
- [x] Implementasikan encrypted API key input.
- [x] Tampilkan credential masked.
- [x] Implementasikan test connection.
- [x] Implementasikan rotate/revoke/pause.
- [x] Catat credential expiry.
- [x] Tambahkan health dan quota check.
- [x] Tambahkan usage snapshots.
- [x] Tambahkan managed plan dan entitlement.
- [x] Tambahkan free allowance dan paid add-on.
- [x] Tambahkan provider assignment audit.
- [x] Sembunyikan capability yang tidak tersedia.

Provider awal:

- [x] Cloudflare R2.
- [x] S3-compatible storage.
- [x] Xendit.
- [x] Resend.
- [ ] Custom SMTP. **[AKSI BERSAMA]**
- [x] Monitoring webhook.

Provider switching:

- [x] Sesi baru memakai provider baru.
- [x] File lama tetap readable.
- [x] Migration berjalan di background.
- [x] Migration dapat pause/resume.
- [x] Verifikasi checksum.
- [x] Putuskan provider lama hanya setelah migration selesai.
- [x] Payment aktif tetap pada provider asal.

Exit gate:

- [x] Tidak ada credential di browser/log/Agent.
- [x] Provider gagal tidak merusak booth lokal.
- [x] Quota dan biaya terlihat jelas.
- [x] Migration dapat dipulihkan setelah interruption.

## Phase 13 — Payment dan Ledger

- [x] Gunakan dynamic QRIS per transaksi.
- [x] Kaitkan payment ke booth/session/payment ID.
- [x] IDR only untuk v1.
- [ ] Implementasikan Xendit xenPlatform adapter. **[AKSI ANDA] [EKSTERNAL]**
- [x] Implementasikan payment create.
- [x] Implementasikan payment status.
- [x] Verifikasi webhook signature.
- [x] Tambahkan replay protection.
- [x] Tambahkan webhook idempotency.
- [x] Status pending/paid/settled/expired/refunded/chargeback.
- [x] Provider aktif tidak berubah selama transaksi.
- [x] Implementasikan platform fee default.
- [x] Implementasikan per-booth fee override.
- [x] Simpan fee snapshot per transaksi.
- [x] Buat immutable ledger.
- [x] Catat gross.
- [x] Catat provider fee.
- [x] Catat platform fee.
- [x] Catat booth earning.
- [x] Catat pending/available balance.
- [x] Koreksi melalui adjustment entry.
- [x] Implementasikan refund.
- [x] Implementasikan chargeback handling.
- [x] Rekonsiliasi provider vs ledger.

Exit gate:

- [x] Duplicate webhook tidak membuat pembayaran ganda.
- [x] Ledger tidak dapat diedit langsung.
- [x] Rekonsiliasi menghasilkan selisih nol pada test scenario.

## Phase 14 — Payout Otomatis dan Manual

### Otomatis

- [ ] Merchant/sub-account onboarding. **[AKSI ANDA] [EKSTERNAL]**
- [ ] KYC status tracking. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Withdrawal bank account. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Split platform fee. **[AKSI BERSAMA] [EKSTERNAL]**
- [ ] Daily auto-withdrawal. **[AKSI BERSAMA] [EKSTERNAL]**
- [x] Minimum payout configuration.
- [ ] Failed payout retry. **[AKSI BERSAMA] [EKSTERNAL]**
- [x] Email payout summary.

### Manual superadmin

- [x] `MANUAL_SUPERADMIN` mode per booth.
- [x] Daily settlement batch.
- [x] Row lock dan payout idempotency.
- [x] Payout review page.
- [x] Tampilkan rekening terverifikasi.
- [x] Nominal payout tidak dapat diedit.
- [x] Input transfer reference.
- [x] Upload bukti transfer.
- [x] Tandai payout paid.
- [x] Catat ledger paid-out.
- [x] Kirim email otomatis.
- [x] Retry email terpisah dari status transfer.
- [x] Resend email button.
- [x] Maker-checker untuk produksi.
- [x] Re-authentication untuk pilot satu superadmin.
- [x] Batalkan approval jika rekening berubah.

### Finance dashboard

- [x] Payment transactions.
- [x] Gross/net revenue.
- [x] Provider/platform fees.
- [x] Booth balances.
- [x] Settlement batches.
- [x] Refund/adjustment.
- [x] Chargeback.
- [ ] Auto/manual payout. **[AKSI BERSAMA]**
- [ ] Failed payout. **[AKSI BERSAMA]**
- [x] Proof of transfer.
- [x] CSV export.
- [x] Period report.
- [x] Reconciliation.
- [x] Finance audit.

Exit gate:

- [x] Double payout test lulus.
- [x] Perubahan rekening memerlukan approval ulang.
- [ ] Ledger, provider, dan bank report dapat direkonsiliasi. **[AKSI BERSAMA]**
- [ ] KYC belum selesai tidak dapat mengaktifkan payout produksi. **[AKSI BERSAMA] [EKSTERNAL]**

## Phase 15 — Email

- [x] Integrasikan Resend.
- [ ] Verifikasi domain pengirim. **[AKSI ANDA] [EKSTERNAL]**
- [x] Buat payout email template.
- [x] Buat recovery email template.
- [x] Buat alert email template.
- [x] Gunakan deterministic idempotency key.
- [x] Catat delivered.
- [x] Catat bounced.
- [x] Catat complained.
- [x] Catat suppressed.
- [x] Implementasikan retry.
- [x] Implementasikan resend manual.
- [x] Signed proof link memiliki expiry.
- [x] Email gagal tidak mengubah status payout.
- [x] Owner tetap dapat membuka laporan dari dashboard.

Exit gate:

- [ ] Email template lulus visual test. **[AKSI ANDA]**
- [x] Bounce dan retry scenario lulus.
- [x] Secret email provider tidak masuk client bundle.

## Phase 16 — Design System dan Accessibility

- [x] Font dasar 14–16 px.
- [x] Field/tombol 44–48 px.
- [x] Touch target minimal 48 px.
- [x] Spacing menggunakan skala 4/8 px.
- [x] Border radius 6–8 px.
- [x] Icon SVG sesuai konteks.
- [x] Status memakai icon, teks, dan warna.
- [x] Select arrow memiliki padding konsisten.
- [x] Number input suffix tidak tertutup controls.
- [x] Modal, table, pagination, toast, dan dialog memakai token sama.
- [x] Admin responsif desktop/tablet/touchscreen.
- [x] Booth mendukung portrait/landscape.
- [x] Keyboard navigation.
- [x] Visible focus.
- [x] Form label dan error announcement.
- [x] Contrast test.
- [x] Reduced motion.
- [ ] Screen reader test. **[AKSI BERSAMA]**

Bukti tambahan: kontrak UI simplicity memeriksa capability gating, disabled
state, actionable error, dan navigasi bagian. Browser lokal tidak menemukan
overflow horizontal pada delapan halaman admin yang diuji. Matrix visual
superadmin authenticated, screen reader, dan perangkat sentuh fisik tetap
memerlukan tindakan lanjutan.

Exit gate:

- [x] Visual regression lulus.
- [x] Accessibility test lulus.
- [x] Tidak ada overflow, overlap, atau inconsistent spacing.

## Phase 17 — Security dan Privacy

- [x] Threat model.
- [x] RLS/tenant isolation test.
- [x] CSRF protection.
- [x] Secure cookie.
- [x] Rate limit.
- [ ] Password/passkey remote login.
- [x] PIN hanya untuk login lokal.
- [x] Session revoke.
- [x] Secret encryption dan rotation.
- [x] Webhook replay protection.
- [x] Pairing takeover protection.
- [x] Remote command signing.
- [x] Download URL sulit ditebak dan memiliki expiry.
- [x] Consent pemrosesan foto.
- [x] Cloud retention policy.
- [x] Early deletion request.
- [ ] Encrypt storage dan transport. **[AKSI BERSAMA]**
- [x] Log redaction.
- [x] Dependency scanning.
- [x] Secret scanning.
- [ ] Penetration test. **[AKSI ANDA] [EKSTERNAL]**
- [x] Incident response procedure.
- [x] Finance fraud detection.
- [x] Rekening payout change alert.

Exit gate:

- [ ] Tidak ada critical/high security finding. **[AKSI BERSAMA] [EKSTERNAL]**
- [x] Privacy deletion scenario lulus.
- [ ] Security incident drill selesai. **[AKSI BERSAMA]**

## Phase 18 — Observability dan Disaster Recovery

- [x] Structured logs.
- [x] Metrics untuk latency dan error rate.
- [x] Queue depth.
- [x] Disk dan storage alerts.
- [x] Camera/capture failure metrics.
- [x] Printer failure metrics.
- [x] Payment/webhook failure metrics.
- [x] Payout/email failure metrics.
- [x] Agent offline alerts.
- [x] Actionable alert routing.
- [x] Incident timeline.
- [x] System health dashboard dan histori telemetry bounded 7 hari.
- [x] Database backup schedule.
- [ ] Object storage versioning/lifecycle. **[AKSI ANDA] [EKSTERNAL]**
- [x] Local database backup.
- [x] Restore procedure.
- [x] Restore drill.
- [ ] Recovery setelah SSD rusak. **[AKSI BERSAMA]**
- [x] Recovery setelah Agent reinstall.
- [x] Recovery setelah database corruption.
- [x] Define RPO/RTO.
- [x] Status page.
- [x] Operator runbooks.
- [x] Support escalation guide.

Exit gate:

- [x] Restore drill berhasil.
- [x] Alert sampai ke operator yang benar.
- [x] Incident dapat didiagnosis tanpa membuka raw secret.

## Phase 19 — Testing Matrix

- [x] Unit test config, voucher, session, queue, provider, fee, ledger, dan payout.
- [ ] Integration test PostgreSQL, Redis, R2, Agent, Controller, payment, dan email. **[AKSI BERSAMA]**
- [x] Contract test cloud–Agent–Controller–PWA.
- [x] Browser E2E semua route.
- [ ] E2E setiap kontrol interaktif.
- [x] Hardware simulator CI.
- [ ] Webcam acceptance test. **[AKSI BERSAMA]**
- [ ] gPhoto2 acceptance test. **[AKSI BERSAMA]**
- [ ] CUPS/IPP printer acceptance test. **[AKSI BERSAMA]**
- [ ] AirPrint test. **[AKSI BERSAMA]**
- [x] Offline/online recovery.
- [x] Slow internet/API timeout.
- [ ] Agent mati.
- [x] Controller mati.
- [x] Storage penuh.
- [x] Kamera sibuk.
- [x] Printer terputus.
- [x] Duplicate webhook.
- [x] Duplicate payout.
- [x] Update gagal/rollback.
- [x] Provider outage.
- [x] Quota exhausted.
- [x] Migration interrupted.
- [x] Multi-browser persistence.
- [x] Desktop/tablet/portrait/landscape visual test.
- [x] Accessibility test.
- [x] Load test voucher/payment/session.
- [ ] 72-hour soak test pada RAM 4 GB. **[AKSI BERSAMA]**
- [x] Memory leak dan queue-stall check.

Exit gate:

- [ ] Seluruh P0/P1 test lulus.
- [ ] Tidak ada blocker atau critical defect.
- [ ] Performance budget terpenuhi.

## Phase 20 — Dokumentasi dan Operasional

- [x] Installer guide.
- [x] Setup guide nonteknis.
- [x] Local Manager guide.
- [x] Booth operator guide.
- [x] Admin guide.
- [x] Superadmin guide.
- [x] Integration/API key guide.
- [x] Finance dan payout guide.
- [x] Offline operation guide.
- [x] Hardware compatibility list.
- [x] Troubleshooting guide.
- [x] Incident runbooks.
- [x] Backup/restore guide.
- [x] API documentation.
- [x] Architecture documentation.
- [x] Data retention/privacy policy.
- [x] Terms/payment disclosure.
- [x] Release notes.
- [x] Upgrade/rollback procedure.

Exit gate:

- [ ] Operator nonteknis dapat setup dari dokumentasi. **[AKSI ANDA]**
- [ ] Support dapat menangani insiden umum tanpa developer. **[AKSI ANDA]**
- [ ] Dokumentasi sesuai build produksi terakhir. **[AKSI BERSAMA]**

## Phase 21 — Pilot dan Produksi

- [ ] Deploy internal development. **[AKSI BERSAMA]**
- [x] Jalankan hardware simulator.
- [ ] Pilot satu mini PC 4 GB. **[AKSI ANDA]**
- [ ] Pilot satu Windows/macOS. **[AKSI ANDA]**
- [ ] Pilot satu iPad/Android standalone. **[AKSI ANDA]**
- [ ] Pilot tablet companion. **[AKSI ANDA]**
- [ ] Jalankan 72-hour soak test. **[AKSI BERSAMA]**
- [ ] Jalankan ratusan sesi test. **[AKSI BERSAMA]**
- [ ] Aktifkan QRIS sandbox. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Aktifkan payout manual sandbox. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Aktifkan auto-settlement sandbox. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Pilot transaksi live internal. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Rekonsiliasi transaksi live. **[AKSI BERSAMA]**
- [ ] Rollout 5–10 booth. **[AKSI ANDA]**
- [ ] Pantau error, latency, queue, dan support tickets. **[AKSI BERSAMA]**
- [ ] Rollback jika error budget terlewati. **[AKSI ANDA]**
- [ ] Production security review. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Production finance/compliance review. **[AKSI ANDA] [EKSTERNAL]**
- [ ] Aktifkan paid infrastructure. **[AKSI ANDA]**
- [ ] Aktifkan staged production rollout. **[AKSI ANDA]**
- [ ] Jadwalkan post-launch review. **[AKSI ANDA]**

Final production gate:

- [ ] Seluruh Phase 0–20 selesai.
- [ ] Tidak ada tombol atau fitur mockup.
- [ ] Semua data persistent.
- [ ] Booth tetap berjalan offline.
- [ ] Agent dapat pulih otomatis.
- [ ] Payment dan payout dapat direkonsiliasi. **[AKSI BERSAMA]**
- [ ] Backup dan restore terbukti. **[AKSI BERSAMA]**
- [ ] Security audit lulus. **[AKSI ANDA] [EKSTERNAL]**
- [ ] 72-hour soak test lulus. **[AKSI BERSAMA]**
- [ ] Target performa terpenuhi. **[AKSI BERSAMA]**
- [ ] Rollback tersedia.
- [ ] Produk baru boleh disebut mature production setelah gate ini selesai.

## Default yang Dikunci

- [x] Local-first dengan cloud control.
- [ ] Superadmin mengontrol seluruh backend melalui secure control plane.
- [x] Hybrid provider: platform-managed dan BYO.
- [x] Zero-cost baseline dengan upgrade fleksibel.
- [x] Provider baru dipasang melalui capability adapter.
- [x] QRIS dinamis pusat.
- [x] Xendit sebagai payment provider pertama.
- [x] Fee global dengan per-booth override.
- [ ] Auto-payout harian sebagai default.
- [x] Manual payout superadmin tetap tersedia.
- [x] Resend sebagai email provider awal.
- [x] IDR only untuk v1.
- [x] Tablet standalone memiliki batas browser yang transparan.
- [x] Companion direkomendasikan untuk silent print.
- [x] Free tier hanya untuk pilot.
- [x] Rollout bertahap dan selalu memiliki rollback.
