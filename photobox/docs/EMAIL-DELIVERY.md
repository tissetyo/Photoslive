# Email delivery Resend

Photoslive memakai Resend sebagai adapter email pertama. Implementasi ini sudah
memiliki antrean persisten, template terbatas, idempotency, retry, delivery
events, RBAC, audit, dan UI superadmin. Build belum boleh disebut production
email sampai domain pengirim dan skenario live benar-benar diverifikasi.

## Konfigurasi server

Koneksi dapat dibuat pada scope global, organisasi, atau photobox dari panel
**Provider connections** superadmin. Credential yang wajib:

- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`, misalnya `Photoslive <hello@example.com>`
- `RESEND_WEBHOOK_SECRET`

Nilai disimpan terenkripsi di provider vault dan hanya dibuka pada adapter
server. Browser hanya menerima nama field dan nilai masked. Tombol **Tes
koneksi** menjalankan request read-only ke daftar domain Resend dengan timeout
tiga detik.

## Alur pengiriman

1. Backend memilih template dan membuat `businessKey` stabil.
2. Queue menurunkan deterministic SHA-256 idempotency key dari template,
   penerima, dan business key. Duplikat 30 hari memakai delivery yang sama.
3. Data template di-allowlist dan dibatasi sebelum masuk Redis.
4. Worker memilih provider sesuai scope, mengirim dengan timeout lima detik,
   lalu menyimpan ID message Resend.
5. Kegagalan sementara memakai exponential backoff maksimal delapan attempt.
6. Retry manual hanya tersedia untuk `failed`, `retry`, dan
   `waiting_configuration`. Email bounced, complained, atau suppressed tidak
   dapat dikirim ulang dari UI tanpa memperbaiki penerima/consent.

Resend merekomendasikan idempotency key untuk mencegah email ganda saat request
diulang: <https://resend.com/docs/dashboard/emails/idempotency-keys>.

## Webhook

Endpoint publik:

```text
POST /api/platform?action=resend_webhook
```

Daftarkan event berikut pada dashboard Resend:

- `email.delivered`
- `email.bounced`
- `email.complained`
- `email.suppressed`

Endpoint membaca raw body dan memverifikasi header `svix-id`,
`svix-timestamp`, dan `svix-signature` memakai `RESEND_WEBHOOK_SECRET`. Event
lebih tua dari lima menit ditolak, dan ID webhook yang sama dideduplikasi 30
hari. Status complaint/bounce/suppression tidak dapat ditimpa event delivered
yang datang terlambat. Panduan resmi verifikasi webhook:
<https://resend.com/docs/webhooks/verify-webhooks-requests>.

## Superadmin dan permission

- `platform.integrations.read`: melihat delivery masked dan summary.
- `platform.integrations.write`: memproses queue, mengirim tes nyata dengan
  konfirmasi eksplisit, serta retry kegagalan sementara.
- Semua proses, tes, dan retry dicatat di audit log tanpa alamat lengkap atau
  credential.

Panel **Pengiriman email** menampilkan loading, success, error, empty, retry,
disabled, dan status delivery. Status penerimaan mailbox hanya berubah setelah
webhook, bukan ketika API Resend baru menerima request.

## Gate yang masih terbuka

- verifikasi domain pengirim pada akun Resend production;
- acceptance live untuk delivered/bounce/complaint dan visual template;
- signed proof link berumur pendek;
- wiring template payout dan recovery ke workflow production masing-masing;
- bukti bahwa kegagalan email tidak mengubah status payout.
