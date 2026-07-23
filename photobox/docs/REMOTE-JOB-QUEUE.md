# Antrean remote superadmin

Antrean remote hanya untuk operasi hardware yang sudah dibuat oleh API bridge.
Simpan settings, voucher, aset, dan alur pelanggan tidak melewati antrean ini
dan tidak menunggu Agent.

## Penyimpanan dan retensi

- Job lengkap berada di `photoslive:job:{jobId}` dengan TTL 24 jam.
- ID terbaru masuk ke indeks `photoslive:jobs` yang dibatasi 500 item.
- Antrean aktif per mesin tetap berada di
  `photoslive:machine:{machineId}:jobs` dan ikut dibaca sebagai backfill.
- Job historis yang dibuat sebelum indeks global diperkenalkan hanya terlihat
  jika masih berada di antrean mesin; tidak ada scan Redis pada request UI.

Endpoint `platform?action=remote_jobs` hanya tersedia untuk sesi superadmin.
Respons daftar menyertakan ID, mesin, booth, tipe, status, attempts, waktu,
error yang dipotong maksimal 240 karakter, dan eligibility retry. Payload,
signature, command key, installation token, serta credential tidak dikirim ke
browser.

## Retry

Hanya status `failed` dan `expired` yang dapat dicoba ulang. Mesin harus masih
paired dan akses booth tidak boleh dinonaktifkan. Retry:

1. membuat job baru dengan `retryOf` menunjuk job sumber;
2. menyalin payload server-side, memberi expiry 10 menit, lalu menandatangani
   ulang HMAC memakai command key mesin;
3. memasukkannya ke antrean mesin dan indeks global;
4. memakai pointer idempotensi TTL 10 menit agar klik/request ulang tidak
   menciptakan job ganda; dan
5. mencatat `hardware_job.retried` pada audit log saat job baru benar-benar
   dibuat.

Retry tidak menjamin eksekusi bila Agent tetap offline. UI menampilkan job
sebagai **Menunggu** sampai Agent mengklaimnya atau expiry tercapai.

## Membuat perintah

Superadmin dapat memilih photobox aktif dan mengirim dua command yang sengaja
dibatasi:

- **Periksa perangkat** (`devices.refresh`); dan
- **Restart Controller** (`service.restart`), dengan konfirmasi eksplisit.

Cloud membuat idempotency key per tindakan, memberi expiry 10 menit,
menandatangani job menggunakan command key mesin, memasukkannya ke machine
queue serta indeks global, lalu mencatat `hardware_job.created` di audit log.
Endpoint memvalidasi ulang allowlist server-side; mengganti nilai form atau
mengirim `printer.print`, `camera.capture`, atau payload bebas akan ditolak.

Update/rollback Agent, maintenance, dan rollout fleet belum menjadi bagian
form ini. Fitur tersebut tetap terbuka di checklist dan tidak boleh disamakan
dengan restart Controller.
