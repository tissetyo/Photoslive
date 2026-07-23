# Object storage Photoslive

Photoslive mendukung Cloudflare R2 atau layanan S3-compatible untuk file sesi
dan aset baru. Credential hanya dibaca oleh API cloud. Agent tidak menerima
access key atau secret key.

## Konfigurasi R2

Isi environment variable server berikut pada project Vercel:

```text
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
```

Token R2 harus dibatasi ke bucket Photoslive. `R2_SESSION_TOKEN` bersifat
opsional. Region SigV4 R2 selalu `auto` dan endpoint memakai pola
`https://<account-id>.r2.cloudflarestorage.com/<bucket>/<object>`.

## Konfigurasi S3-compatible

```text
S3_ENDPOINT=https://objects.example.com
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_BUCKET=
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=true
```

`S3_SESSION_TOKEN` bersifat opsional. Path style adalah default karena paling
kompatibel dengan layanan non-AWS. Ubah `S3_FORCE_PATH_STYLE=false` hanya jika
provider mewajibkan bucket sebagai subdomain.

## Alur file sesi

1. Controller menyimpan capture, hasil frame, dan GIF ke disk serta SQLite.
2. Agent meminta upload intent menggunakan installation token.
3. Cloud mengembalikan presigned PUT singkat untuk file kecil. File 5–25 MB
   memakai multipart upload dengan signed URL baru untuk setiap part.
4. Agent mengunggah byte langsung ke bucket. Upload ID, ukuran part, dan ETag
   part yang selesai dicheckpoint ke SQLite; signed URL tidak pernah disimpan.
   Metadata object tetap mengikat content type dan SHA-256 file lengkap.
5. Agent meminta finalisasi. Cloud melakukan HEAD dan memverifikasi ukuran serta
   metadata SHA-256 sebelum file muncul pada halaman download.
6. Download menggunakan presigned GET singkat. Redis hanya menyimpan metadata
   dan object key.

Jika provider belum dikonfigurasi, hanya file kecil yang memakai fallback
Base64 legacy. Status capability harus tetap menyebut `legacy-redis`; fallback
ini tidak boleh dipromosikan sebagai object storage production.

## Batas dan acceptance production

- Upload sesi direct dibatasi 25 MB per file. File di bawah 5 MB memakai single
  PUT; file 5–25 MB memakai part minimum 5 MiB sesuai kontrak S3. Checkpoint
  per-part bertahan setelah Agent/Controller restart dan upload dilanjutkan dari
  part pertama yang belum memiliki ETag. Intent cloud berlaku 24 jam; intent
  kedaluwarsa membuat upload multipart baru tanpa memakai URL lama.
- Upload aset admin/setup memakai presigned PUT langsung dan dibatasi 25 MB
  ketika provider tersedia. Tanpa provider, fallback Base64 dibatasi 2 MB.
- Record Base64 lama masih dapat dibaca, tetapi belum dimigrasikan otomatis.
- Bucket production wajib memiliki lifecycle/retention, CORS yang diperlukan,
  least-privilege token, quota alert, serta acceptance test PUT/HEAD/GET/DELETE.
- CORS bucket harus mengizinkan origin admin Photoslive, method `PUT`, dan
  header `content-type` serta `x-amz-meta-sha256`. Jangan otomatis mengulang
  upload setelah error CORS karena object pertama mungkin sudah tersimpan.
- Jangan menandai provider siap produksi hanya karena environment variable
  lengkap. Jalankan live acceptance dan uji download 24 jam lebih dahulu.

## Verifikasi lokal tanpa credential

```bash
cd photobox/web
npm test
```

Test unit memverifikasi canonical SigV4, endpoint path-style R2, header yang
ditandatangani, operasi PUT/HEAD/DELETE, initiate/sign/complete/abort multipart,
resume dari checkpoint, redaksi secret, serta fallback tanpa provider. Test ini
bukan pengganti acceptance test ke bucket production.
