# Alert routing

Photoslive mengirim event `fleet.incident.opened` dan
`fleet.incident.resolved` melalui provider **Monitoring webhook**. Delivery
berjalan di control plane dan tidak menjadi dependensi jalur booth maupun
Agent.

## Konfigurasi

1. Buka `/superadmin` dan bagian **Koneksi provider**.
2. Pilih **Monitoring webhook**, scope, dan sumber credential.
3. Isi URL HTTPS serta signing secret minimal 16 karakter.
4. Simpan lalu gunakan **Tes koneksi**. Endpoint menerima event
   `photoslive.integration.test`.
5. Lihat hasil dan retry pada bagian **Routing alert**.

Platform-managed memakai environment `MONITORING_WEBHOOK_URL` dan
`MONITORING_WEBHOOK_SECRET`. BYO disimpan menggunakan vault AES-256-GCM. Nilai
credential tidak dikirim kembali ke browser, response API, record delivery,
atau audit log.

## Verifikasi signature

Signature berada di header `X-Photoslive-Signature` dengan format
`sha256=<hex>`. Hitung HMAC SHA-256 atas raw request body menggunakan signing
secret dan bandingkan secara constant-time. Gunakan `Idempotency-Key` atau
`X-Photoslive-Delivery` untuk menolak delivery duplikat.

## Operasi

- `queued`: siap dikirim.
- `retry`: gagal sementara dan menunggu exponential backoff.
- `waiting_configuration`: provider belum aktif atau credential tidak dapat
  digunakan.
- `failed`: delapan percobaan gagal; gunakan retry manual setelah penyebab
  diperbaiki.
- `delivered`: endpoint mengembalikan status HTTP 2xx.

Response body endpoint tidak dibaca atau dicatat. URL wajib HTTPS dan tidak
boleh memuat username/password. Pengiriman otomatis terjadi ketika superadmin
memuat antrean; cron `/api/retention` memberikan fallback terjadwal.
