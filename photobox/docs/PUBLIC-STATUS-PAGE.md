# Public status page

Route `/status` menampilkan status cloud Photoslive tanpa memerlukan login.
Endpoint `GET /api/platform?action=public_status` memproyeksikan tiga komponen:
Cloud API, konfigurasi/voucher, serta upload/hasil pelanggan.

Projection sengaja tidak mengirim nama provider, credential state, latency,
signed URL, response body, pesan internal, database vendor, atau telemetry booth.
Halaman memiliki timeout delapan detik, retry manual, loading, success, degraded,
outage, dan disabled state.

Status ini bukan pengganti incident management. Histori incident publik,
subscription notifikasi, serta alert routing proaktif masih belum tersedia.
Superadmin tetap menjadi tempat diagnosis detail yang terautentikasi.
