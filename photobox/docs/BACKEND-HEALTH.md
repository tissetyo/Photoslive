# Health backend superadmin

Panel **Backend & integrasi** pada `/superadmin` memisahkan bukti konektivitas
dari kesiapan konfigurasi. Endpoint `GET /api/platform?action=backend_health`
hanya dapat diakses sesi superadmin dan tidak mengembalikan credential.

## Probe yang dijalankan

- **Cache cloud** melakukan write/read/delete pada key sementara dengan TTL 30
  detik. Hasil menampilkan state, latency, dan error yang dibatasi panjangnya.
- **PostgreSQL shadow** melakukan query read-only dengan timeout 100–2.000 ms
  hanya ketika shadow write diaktifkan dan credential server lengkap. Jika
  dinonaktifkan, UI menampilkan **Nonaktif**, bukan status sehat palsu.
- **Integrasi provider** melakukan request `HEAD` bertanda tangan ke object acak
  pada adapter R2/S3 aktif, dengan timeout maksimal lima detik. Respons 404
  dianggap sehat karena membuktikan endpoint dan credential dapat dijangkau
  tanpa membuat file. Provider storage terkonfigurasi lain ditandai **Siaga**.
- **Xendit** melakukan request saldo read-only dan **Resend** membaca daftar
  domain dengan timeout tiga detik ketika credential deployment lengkap.
  Kegagalan autentikasi atau timeout ditampilkan sebagai error, bukan status
  sehat palsu. Koneksi provider tersimpan juga dapat dites secara server-side
  dari panel Provider; secret tidak pernah dikirim ke browser.

Nilai API key, token Redis, service role key, endpoint database, dan nama
environment variable yang kurang tidak dikirim ke browser. Kegagalan panel ini
tidak memblokir fleet, audit log, settings, voucher, atau booth pelanggan.

## Batas saat ini

- Probe live tersedia untuk object storage, Xendit, Resend, dan monitoring
  webhook yang sudah memiliki adapter. Probe membuktikan konektivitas dan
  autentikasi, bukan keberhasilan transaksi pembayaran atau penerimaan email
  oleh mailbox tujuan.
- Histori time-series saat ini khusus telemetry mesin (RAM, disk, Agent,
  Controller, dan jumlah perangkat). Probe backend masih bersifat saat diminta;
  histori kegagalan payment/email mengikuti implementasi adapter masing-masing.
- PostgreSQL masih shadow migration path, belum menjadi source of truth utama.
