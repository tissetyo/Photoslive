# Observability webhook pembayaran

Photoslive mencatat hasil delivery webhook Xendit ke daftar bounded maksimal
500 record. Record ini hanya memuat provider, jenis event, referensi event yang
sudah di-hash, booth/payment yang berhasil diidentifikasi, status HTTP, latency,
correlation ID, dan error pendek. Callback token dan payload provider tidak
pernah disimpan atau dikirim ke browser.

Superadmin dengan permission `platform.finance.read` dapat melihat 100 record
terbaru melalui `GET /api/platform?action=webhook_events&limit=100`. Dashboard
menampilkan jumlah berhasil, gagal, dan delivery duplikat yang ditangani secara
idempotent. Support tanpa permission finance ditolak.

Saat terjadi kegagalan, operator menggunakan correlation ID dan pesan error
aman untuk menelusuri structured log. Tombol **Perbarui log** memiliki loading,
empty, success, error, dan retry state. Log ini membantu diagnosis, tetapi tidak
menggantikan reconciliation provider-versus-ledger.

Panel payout juga menggabungkan payout berstatus dibayar dengan delivery email
yang tersimpan. Metric membedakan email diterima, masih menunggu, gagal/bounce,
dan payout yang tidak mempunyai delivery record. Status transfer tidak pernah
diturunkan hanya karena email gagal.
