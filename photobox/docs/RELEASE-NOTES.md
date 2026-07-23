# Release notes

## 0.3.0 — hardening increment

- Memisahkan cloud data mutation dari Agent/hardware queue.
- Menambahkan local-first recovery, bounded queue, storage safety, dan customer
  download retention.
- Menambahkan setup komputer/tablet, Local Manager, admin capability contract,
  fleet/superadmin controls, provider vault, payment ledger, manual payout
  control, observability, dan security contracts.
- Menormalkan design system dan menambah kontrak accessibility/contrast.
- Menambahkan perpustakaan frame global: superadmin mengunggah file asli ke
  object storage dan setiap admin booth dapat preview serta download tanpa Agent.
- Menambahkan finance risk engine persisten untuk perubahan rekening, payout
  bernilai tinggi, dan referensi transfer ganda, termasuk review RBAC dan audit.
- Menambahkan migrasi voucher/event PostgreSQL bertahap: batch 100 dalam satu
  transaksi, mode dual/primary, database-before-cache, redeem/delete atomik,
  dan recovery snapshot tanpa bergantung pada Agent.
- Menambahkan migrasi settings PostgreSQL bertahap: config version transaksional,
  database-before-cache, recovery snapshot, dan respons 503 retryable yang tidak
  menghilangkan edit lokal ketika database gagal.
- Menambahkan migrasi direktori booth/lokasi PostgreSQL: machine dan legacy
  organization link disimpan di schema private, RPC service-role-only,
  database-before-cache untuk setup/toggle, recovery cache, respons fail-closed
  retryable tanpa partial pairing, serta CLI backfill default-dry-run dengan
  checksum deterministik dan verifikasi snapshot.
- Menambahkan migrasi metadata sesi PostgreSQL: mode off/dual/primary,
  database-before-cache, status terminal anti-regresi, manifest object internal,
  recovery signed-download/retensi tanpa Redis, privacy deletion dua tahap yang
  retryable, dan respons publik tanpa machine ID/object key. Binary foto tetap
  mengikuti jalur disk/object storage dan tidak disimpan di database.
- Menambah dokumentasi operator, API, offline, finance, privacy, dan release.

Build ini belum mature production. Live provider acceptance, installer signing,
hardware matrix, penetration test, restore drill, visual regression, load test,
dan soak 72 jam masih menjadi release gate. Upgrade mengikuti `AGENT-UPDATES.md`;
rollback mengikuti `RELEASE-ROLLBACK.md` tanpa menghapus foto unsynced.
