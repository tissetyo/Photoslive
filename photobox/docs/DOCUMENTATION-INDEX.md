# Dokumentasi Photoslive

Dokumen ini adalah pintu masuk sesuai peran. Semua panduan mengikuti build
`0.3.0`; fitur yang membutuhkan provider atau perangkat nyata tetap diberi
status belum tersedia sampai health check-nya lulus.

## Operator

- Instalasi dan setup: `INSTALLATION-SETUP-GUIDE.md`.
- Operasi booth dan admin: `BOOTH-ADMIN-SUPERADMIN-GUIDE.md`.
- Local Manager: `LOCAL-MANAGER-GUIDE.md`.
- Offline dan troubleshooting: `OFFLINE-TROUBLESHOOTING.md`.
- Kompatibilitas: `HARDWARE-COMPATIBILITY.md`.
- Backup: `LOCAL-BACKUP-RESTORE.md`.

## Platform dan developer

- Tindakan manual pemilik sebelum production: `MANUAL-SETUP-ACTIONS.md`.
- Arsitektur: `LOCAL-FIRST-ARCHITECTURE.md`.
- API: `API-REFERENCE.md`.
- Migrasi settings PostgreSQL: `POSTGRES-SETTINGS.md`.
- Migrasi voucher/event PostgreSQL: `POSTGRES-VOUCHERS.md`.
- Migrasi direktori booth/lokasi PostgreSQL dan CLI backfill: `POSTGRES-DIRECTORY.md`.
- Migrasi metadata sesi PostgreSQL: `POSTGRES-SESSIONS.md`.
- Integrasi dan finance: `INTEGRATIONS-FINANCE-GUIDE.md`.
- Deteksi dan review risiko finance: `FINANCE-RISK.md`.
- Plan, kuota, dan pemakaian provider: `PROVIDER-ECONOMICS.md`.
- Migrasi storage dan checkpoint: `PROVIDER-MIGRATIONS.md`.
- Log webhook dan metric delivery: `WEBHOOK-OBSERVABILITY.md`.
- Tim platform dan RBAC superadmin: `PLATFORM-STAFF-RBAC.md`.
- Privacy dan disclosure: `PRIVACY-TERMS.md`.
- Insiden: `INCIDENT-RESPONSE.md` dan `SUPPORT-ESCALATION-GUIDE.md`.
- Upgrade/rollback: `AGENT-UPDATES.md` dan `RELEASE-ROLLBACK.md`.
- Baseline performa: `PERFORMANCE-HARDWARE-BASELINE.md`.
- Simulator perangkat CI: `HARDWARE-SIMULATOR.md`.
- Perubahan build: `RELEASE-NOTES.md`.

Jangan menggunakan screenshot lama sebagai sumber kebenaran. Capability aktif
harus cocok dengan `PRODUCT-CAPABILITY-MATRIX.md` dan health check runtime.
