# Matriks pengujian Photoslive

Dokumen ini menghubungkan setiap klaim pengujian pada checklist induk dengan
bukti otomatis yang benar-benar dijalankan. Skenario yang memerlukan perangkat
fisik atau provider live tetap terbuka walaupun kontrak statiknya ada.

## Suite wajib

| Area | Bukti | Cakupan yang dibuktikan |
| --- | --- | --- |
| Domain cloud | `web/tests/cloud-idempotency.test.mjs`, `web/tests/postgres-directory.test.mjs`, `web/tests/postgres-directory-backfill.test.mjs`, `web/tests/postgres-sessions.test.mjs`, `web/tests/postgres-settings.test.mjs`, `web/tests/postgres-vouchers.test.mjs`, `web/tests/payments-ledger.test.mjs`, `web/tests/payout-control.test.mjs`, `web/tests/provider-connections.test.mjs` | direktori booth/lokasi private dan fail-closed, backfill dry-run/checksum/apply-verify tersanitasi, metadata sesi persist/manifest recovery/privacy deletion retryable/redaksi, config/version transaksional, transaksi/bulk voucher, recovery directory/settings/voucher/event, provider, fee, ledger, payout, idempotency |
| Domain lokal | `tests/test_local_first.py` | session, capture, queue, offline policy, storage reserve, crash recovery |
| Protocol | `web/tests/hardware-protocol.test.mjs`, `web/tests/setup-contract.test.mjs`, `web/tests/companion-contract.test.mjs` | signature Cloud–Agent, allowlist Agent–Controller, PWA/setup/companion contract |
| Pembayaran | `web/tests/payments-ledger.test.mjs` | duplicate webhook, replay protection, settlement/refund/chargeback idempotency |
| Payout dan fraud | `web/tests/payout-control.test.mjs`, `web/tests/finance-risk.test.mjs` | duplicate payout, frozen balance, immutable payout ledger, mutation lock, referensi transfer unik, risk persistence/dedupe, role-first authorization, review RBAC, dan re-authentication sensitif |
| Perpustakaan frame global | `web/tests/platform-frame-library.test.mjs` | RBAC upload superadmin, metadata aman lintas booth, direct object-storage upload, preview, pagination, retry, dan download admin |
| Update | `tests/test_updater.py` | update bertanda tangan, health check, rollback manual dan otomatis |
| Browser booth | `web/e2e/booth-local.spec.cjs` | sesi free/offline end-to-end, retake compact, skip goodbye, dan recovery setelah reload |
| Browser seluruh route | `web/e2e/surface-routes.spec.cjs`, `web/e2e/admin-quality.spec.cjs` | 9 route, desktop/tablet portrait-landscape, Axe, screenshot regression, persistence reload dan multi-browser |
| Load smoke | `web/tests/load-smoke.test.mjs`, `tests/test_local_first.py` | 1.000 voucher, 25 payment intent, 500 metadata sesi, 300 antrean upload, batas memori dan drain tanpa stall |
| Hardware simulator | `tests/test_hardware_simulator.py` | kamera/printer virtual, capture, print queue, busy, dan disconnect |

Perintah verifikasi:

```sh
cd photobox/web && npm test
cd photobox/web && npm run test:e2e
cd photobox && PYTHONPYCACHEPREFIX=/tmp/photoslive-pycache python3 -m unittest discover -s tests -v
```

## Skenario yang lulus otomatis

- Unit domain config, voucher, session, queue, provider, fee, ledger, dan payout.
- Contract Cloud–Agent–Controller–PWA, termasuk signature lintas JavaScript dan
  Python serta allowlist route hardware.
- Offline/online recovery: sesi dapat selesai offline, outbox bertahan, dan
  antrean kembali dilanjutkan dari checkpoint setelah koneksi pulih.
- Storage reserve: sesi baru diblokir sebelum disk benar-benar penuh tanpa
  merusak sesi aktif atau database.
- Duplicate webhook tidak menggandakan settlement maupun ledger.
- Duplicate payout tidak menggandakan payout maupun ledger paid-out.
- Mutation lock payout menolak worker kedua; aksi finance sensitif tanpa
  password aktif ditolak dan kegagalannya tercatat pada audit log.
- Risk engine membuat dan mendeduplikasi kasus perubahan rekening, payout
  bernilai tinggi, serta referensi transfer ganda; hanya Platform Owner yang
  dapat resolve setelah re-authentication.
- Kontrak voucher PostgreSQL membuktikan mode eksplisit, service-role RPC
  bounded untuk batch 100, write database-before-cache pada mode primary,
  fail-closed tanpa voucher Redis-only, operasi event/redeem/delete, recovery
  snapshot, dan permission function. Ini belum menggantikan integration test
  pada project Supabase nyata.
- Kontrak direktori PostgreSQL membuktikan private machine/organization link,
  service-role-only RPC, advisory/row lock, conflict guard satu mesin-satu booth,
  database-before-cache, recovery Redis, dan fail-closed setup. Migration dan
  restore pada Supabase nyata tetap merupakan acceptance terpisah.
- Kontrak settings PostgreSQL membuktikan mode eksplisit, row lock dan batas
  payload, database-before-cache, fail-closed tanpa cache parsial, recovery
  snapshot, serta respons 503 retryable. Ini belum menggantikan cutover live.
- Perpustakaan frame global hanya dapat dimutasi oleh platform role berizin;
  admin booth dapat melihat dan mengunduh tanpa menerima key atau konfigurasi
  object storage.
- Update invalid memicu rollback otomatis; rollback manual memulihkan backup.
- Chromium E2E menjalankan Controller Python dan simulator hardware sungguhan:
  welcome, pilih frame, countdown, capture, retake, hasil, goodbye, skip, serta
  pemulihan sesi aktif setelah browser reload.
- Test recovery Controller membunuh proses dengan `SIGKILL`, menjalankan ulang
  Controller, lalu memverifikasi sesi dan file capture tetap dapat dilanjutkan.
- Browser E2E memuat seluruh route produk, menguji overflow tiga viewport,
  accessibility utama, visual regression, dan persistence lintas browser.
- Load smoke memproses voucher, payment intent, metadata sesi, dan antrean lokal
  dengan input terbatas serta assertion waktu, memori, dan queue drain.

## Tetap terbuka

- Integration live PostgreSQL, Redis, R2/S3, Xendit, dan Resend dalam satu
  environment produksi.
- Webcam, gPhoto2, CUPS/IPP, dan AirPrint pada perangkat nyata.
- Agent benar-benar dimatikan oleh OS, internet lambat nyata, kamera sibuk,
  printer dicabut, quota provider habis, dan migrasi production terinterupsi.
- Soak test 72 jam pada mini PC 4 GB.

Kontrak atau simulator tidak boleh digunakan untuk mengklaim acceptance
hardware maupun provider live.
