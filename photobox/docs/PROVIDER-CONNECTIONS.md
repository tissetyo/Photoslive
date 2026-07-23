# Koneksi provider dan vault credential

Control plane provider menyimpan assignment provider pada scope `global`,
`organization`, atau `booth`. Credential BYO dienkripsi sebelum masuk ke Redis;
API dan UI hanya menerima proyeksi field yang telah dimasking.

## Batas implementasi saat ini

- Cloudflare R2 dan S3-compatible memiliki adapter object-storage.
- Xendit memiliki adapter Payment Request v3 untuk QRIS cloud, status polling,
  webhook, dan probe credential. Capability tetap berstatus **partial** sampai
  credential sandbox/live, callback, serta rekonsiliasi lulus acceptance.
- Resend masih terdaftar sebagai capability yang belum tersedia.
- Koneksi R2/S3 aktif dipakai langsung oleh upload, download, delete, multipart,
  dan cleanup retensi. Credential didekripsi hanya di server tepat sebelum
  adapter dijalankan dan tidak pernah dikirim ke client atau Agent.
- Provider yang dipilih disimpan pada upload intent dan metadata object. Karena
  itu perubahan default hanya berlaku untuk upload baru; finalize dan file lama
  tetap memakai provider asal selama credential-nya masih tersedia.
- Payment menyimpan connection ID, credential version, dan fingerprint
  SHA-256 non-rahasia saat QRIS dibuat. Versi credential lama tetap terenkripsi
  dalam arsip TTL delapan hari sehingga polling, webhook, dan reconciliation
  transaksi aktif tetap memakai akun asal setelah rotasi/default switch.
- Tes koneksi tersedia untuk adapter storage aktif dan Xendit. Probe dilakukan server-side
  dengan timeout tiga detik dan hanya mengembalikan state, pesan, provider,
  latensi, serta waktu pemeriksaan. Hasil aman terakhir disimpan dan ditampilkan
  lagi setelah reload. URL bertanda tangan dan credential tidak pernah dikirim
  ke UI atau audit log.
- OAuth, health/quota, usage, entitlement, dan migrasi antar
  provider belum tersedia dan tidak boleh dianggap selesai.

## Koneksi Xendit

Credential Xendit dapat berasal dari vault scoped booth/organization/global
atau fallback environment server. Field minimum adalah `secretKey` dan
`webhookToken`; keduanya selalu dimasking di UI. Probe hanya membaca saldo kas
IDR untuk memvalidasi autentikasi dan tidak membuat transaksi.

Webhook production diarahkan ke:

```text
POST /api/platform?action=xendit_webhook
```

Callback wajib membawa `x-callback-token`. Photoslive juga memvalidasi payment
request, booth, mata uang, dan nominal sebelum mengubah status. Detail operasi
dan residual risk ada di `PAYMENTS-LEDGER.md`.

## Konfigurasi vault

Sediakan key ring JSON server-side. Setiap nilai harus berupa 32 byte yang
dikodekan sebagai Base64 URL-safe.

```text
PROVIDER_CREDENTIAL_KEYS={"v1":"<base64url-32-byte>"}
PROVIDER_CREDENTIAL_ACTIVE_KEY_VERSION=v1
```

Environment variable ini hanya boleh tersedia pada runtime server. Jangan
menaruhnya di browser, Agent, log, screenshot, atau repository.

## Rotasi kunci master

1. Tambahkan kunci baru, misalnya `v2`, tanpa menghapus `v1`.
2. Ubah active key version menjadi `v2` dan deploy.
3. Di Superadmin, jalankan **Rotasi kunci** pada setiap koneksi lama.
4. Pastikan semua record menampilkan key version `v2`.
5. Hapus `v1` hanya setelah tidak ada record yang bergantung padanya.

Rewrap mendekripsi credential aktif dan seluruh versi arsip yang belum
kedaluwarsa dengan key lama, lalu mengenkripsinya dengan key aktif. Versi
credential tidak berubah karena nilai provider tidak diganti. Kunci lama baru
boleh dihapus setelah rewrap selesai dan test transaksi yang dipin ke versi lama
lulus.

## Lifecycle credential

- **Pause** menonaktifkan koneksi untuk transaksi baru tanpa memutus resolusi
  versi yang sudah dipin oleh transaksi aktif.
- **Resume** mengaktifkan kembali credential yang belum dicabut/kedaluwarsa.
- **Revoke** menghapus ciphertext dan field mask. Credential yang dicabut tidak
  dapat dipulihkan; resolver versi transaksi juga fail-closed dan operator harus
  mengisi nilai baru.
- **Replace** membuat credential version baru. Nilai lama tidak pernah dapat
  dibaca kembali melalui UI, tetapi ciphertext versi lama dipertahankan secara
  server-only selama TTL payment agar transaksi aktif dapat diselesaikan.

Pada capability yang sama, hanya satu koneksi default dapat aktif untuk setiap
scope dan target. Runtime mencari booth lebih dulu, lalu organization, kemudian
global. Scope paling spesifik yang memiliki koneksi aktif mengalahkan scope di
atasnya. Bila tidak ada record vault, environment deployment lama tetap menjadi
fallback kompatibilitas.

## Audit dan akses

- Membaca inventory membutuhkan `platform.integrations.read`.
- Create/replace, test, pause/resume, revoke, dan rewrap membutuhkan
  `platform.integrations.write`.
- Audit hanya menyimpan provider, scope, target, status, credential version,
  dan key version. Raw credential, IV, maupun ciphertext tidak dicatat.
