# Integrasi, API key, finance, dan payout

Provider dapat dikelola platform atau BYO pada scope global, organization, atau
booth. Credential hanya dikirim ke secure server API, dienkripsi, dimask, dan
tidak masuk browser bundle, Agent, atau log. Urutan aman: tambah koneksi, tes,
assign, pantau health/quota, rotate bila perlu, lalu revoke versi lama.

Provider yang memiliki adapter source saat ini mencakup Cloudflare R2,
S3-compatible storage, Xendit, Resend, dan monitoring webhook. Label tersedia
tidak sama dengan production-ready: provider baru boleh aktif setelah credential,
health check, webhook, dan acceptance live lulus.

Pembayaran v1 memakai IDR dan dynamic QRIS. Payment menyimpan snapshot provider
dan fee; webhook diverifikasi dan idempotent. Ledger append-only mencatat gross,
provider fee, platform fee, booth earning, adjustment, refund, dan chargeback.
Nominal payout tidak diedit setelah batch dibuat.

Manual payout membutuhkan rekening terverifikasi, maker-checker, transfer
reference, proof, dan audit. Email gagal tidak membatalkan transfer. Production
payout dan KYC tetap dinonaktifkan sampai review finance/compliance lulus.
