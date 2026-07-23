# Update dan rollback Agent

Photoslive memasang update lokal hanya dari release manifest bertanda tangan.
Private signing key berada di sistem release dan **tidak** dikirim ke Agent,
Controller, browser, atau log.

## Konfigurasi channel

Installer production menyediakan dua environment variable service:

- `PHOTOSLIVE_UPDATE_MANIFEST_URL`: URL HTTPS menuju manifest release.
- `PHOTOSLIVE_UPDATE_PUBLIC_KEY_PATH`: file JSON public key RSA-2048 atau lebih.

Format public key:

```json
{"keyId":"photoslive-prod-1","n":"BASE64URL_MODULUS","e":65537}
```

Manifest schema v1 memuat `version`, `bundleUrl`, `sha256`, `files`,
`publishedAt`, dan `signature`. Signature RSA PKCS#1 v1.5 SHA-256 dihitung dari
canonical JSON seluruh field selain `signature`. Setiap path dan SHA-256 file di
dalam ZIP ikut ditandatangani.

URL manifest juga wajib HTTPS pada production. HTTP atau `file://` hanya boleh
dipakai dalam test dengan `PHOTOSLIVE_UPDATE_ALLOW_INSECURE=1`.

## Alur operator

1. Buka `http://127.0.0.1:8080/local-agent` pada komputer photobox.
2. Tekan **Periksa update**. Controller memverifikasi signature sebelum
   menampilkan versi sebagai siap.
3. Tekan **Pasang update**. Bundle di-stream ke disk, checksum bundle dan setiap
   file diverifikasi, lalu versi aktif dibackup.
4. Health check memeriksa hash, syntax Python, dan JSON release. Jika gagal,
   Controller memulihkan backup otomatis.
5. Setelah sukses, status menjadi **Perlu restart**. Tekan **Restart Agent**.

Rollback manual membutuhkan konfirmasi `ROLLBACK`. Rollback hanya mengganti file
aplikasi dari backup update terakhir; database, pengaturan, sesi, dan foto tidak
diubah.

## State API lokal

- `POST /api/local/agent/update/check`
- `POST /api/local/agent/update/apply`
- `POST /api/local/agent/update/rollback`
- `GET /api/local/agent/status` pada field `update`

Semua mutasi membutuhkan installation token dan hanya tersedia melalui Local
Manager loopback. Tindakan berjalan di worker terpisah sehingga request kamera,
booth, dan status tidak menunggu download release. Hanya satu update/rollback
dapat berjalan pada satu waktu.

## Operasi remote

Superadmin dapat mengirim tiga command allowlist ke satu mesin:

- `agent.update.check`
- `agent.update.apply`
- `agent.update.rollback`

Command ditandatangani, memiliki expiry dan idempotency key, lalu Agent
meneruskannya ke API loopback Controller memakai installation token. Payload
konfirmasi rollback dibuat tetap oleh Agent (`ROLLBACK`), bukan dipercaya dari
payload browser/cloud. **Periksa** dan **pasang** tetap dua operasi terpisah;
pasang hanya berhasil jika manifest sudah berstatus siap dan terverifikasi.

Status remote job berarti command diterima/dijalankan, bukan bahwa proses update
telah selesai. State aktual (`checking`, `ready`, `applying`, `restart_required`,
`failed`, atau `rolled_back`) berasal dari Controller dan dikirim pada heartbeat
berikutnya. Build ini baru mendukung kontrol per mesin; staged fleet rollout,
canary, dan rollout otomatis lintas banyak booth masih terbuka.

## Batas keamanan

- Production menolak URL bundle selain HTTPS.
- HTTP/file hanya dapat diaktifkan eksplisit untuk test dengan
  `PHOTOSLIVE_UPDATE_ALLOW_INSECURE=1`.
- ZIP traversal, symlink, file tambahan, file hilang, signature salah, dan hash
  tidak cocok ditolak sebelum file aktif diganti.
- Bundle di-stream dalam chunk 1 MB; ukuran maksimum default 128 MB agar aman
  untuk mini PC 4 GB.
- Release key rotation dilakukan dengan mengganti public-key file melalui
  installer/update yang masih ditandatangani key lama.
