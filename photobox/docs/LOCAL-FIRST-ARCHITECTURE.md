# Arsitektur local-first Photoslive

## Prinsip sumber kebenaran

Photoslive memiliki dua jalur yang sengaja dipisahkan:

- **Cloud data** menyimpan booth, akun, role, pengaturan, aset, voucher, event,
  metadata sesi, audit, dan telemetry terakhir. Operasi ini tidak pernah
  menunggu Agent.
- **Local Controller** di `127.0.0.1:8080` menjalankan booth, kamera, compositor,
  penyimpanan foto, dan print. SQLite serta filesystem lokal tetap bekerja saat
  internet mati.
- **Agent** hanya mengirim heartbeat setiap 5 menit, menarik snapshot config
  dan voucher berdasarkan nomor versi, menjalankan command hardware yang
  ditandatangani, serta menyinkronkan hasil offline.

Simpan pengaturan mengubah database cloud dan menaikkan `settingsVersion`.
Heartbeat berikutnya mengirim versi tersebut ke Agent; Agent hanya menarik satu
snapshot jika versinya berubah. Dengan demikian klik **Simpan** tidak membuat
job hardware dan tidak melambat ketika mesin sedang offline.

Booth membuka welcome dari cache config per tenant. Tanpa cache, tombol mulai
tetap disabled dan memiliki state retry yang eksplisit; dengan cache, tombol
dapat digunakan tanpa menunggu heartbeat atau request Controller. Refresh cloud
berjalan paralel. Jika pelanggan sudah masuk pemilihan frame/capture, snapshot
baru ditahan dan baru diterapkan setelah sesi kembali ke welcome agar jumlah
slot, harga, atau frame tidak berubah di tengah sesi.

## PostgreSQL utama dan Redis opsional

Supabase PostgreSQL adalah penyimpanan cloud tahan lama untuk registry mesin,
directory booth, akun admin, pengaturan, voucher/event, dan metadata sesi.
Mode `primary` diaktifkan per kapabilitas melalui environment variable
`PHOTOSLIVE_POSTGRES_*`. Service-role key hanya digunakan oleh function
server-side dan tidak pernah dikirim ke browser, Agent, atau log.

Redis bukan lagi sumber kebenaran untuk kapabilitas yang sudah berada pada mode
PostgreSQL `primary`. Redis hanya dipakai best-effort untuk cache singkat,
presence, dan antrean perintah hardware jarak jauh. Jika kuota Redis habis:

- setup, login, pengaturan, voucher, heartbeat, dan metadata sesi tetap memakai
  PostgreSQL;
- booth lokal, capture, print, serta antrean SQLite tetap berjalan;
- status presence dan perintah hardware jarak jauh dapat berstatus terbatas;
- operator tidak perlu memasang ulang Agent.

Mode `dual` dan fallback legacy tetap tersedia selama rollout. Data lama tidak
dihapus otomatis; cutover dan penghentian write lama harus melalui laporan
migrasi, checksum, backup, dan approval terpisah.

## Data lokal

| Data | Media | Retensi |
| --- | --- | --- |
| Pengaturan terakhir | `settings.json`, penulisan atomik; pilihan perangkat dicermin di SQLite | sampai diganti |
| Voucher offline | SQLite `vouchers` dan `voucher_events` | sampai dipakai/dihapus cloud |
| Sesi dan attempt | SQLite `photo_sessions`, `photo_files` | sesuai upload dan retensi |
| Foto mentah/hasil | folder foto pilihan operator | minimum sampai upload berhasil |
| Antrean sinkronisasi | SQLite `sync_queue`, termasuk `progress_json` checkpoint per file dan ETag multipart | sampai sukses atau ditindaklanjuti |
| Metadata sinkronisasi | SQLite `local_state` | sampai instalasi dihapus |
| Log Agent | file berotasi 512 KB | terbatas otomatis |
| Cache thumbnail | `data/cache/thumbnails` | maksimum 128 MB, oldest-first |
| Cache GIF | `data/cache/gif` | maksimum 256 MB, oldest-first |
| File sementara | `data/tmp` | maksimum 256 MB dan umur 24 jam |

Retensi 24 jam dihitung setelah upload berhasil. Controller memberi warning di
bawah 20% bebas dan menolak sesi baru di bawah 10% atau ketika reserve 2 GB
tidak tersedia. Ia tidak boleh menghapus foto yang belum berhasil di-upload.
Nilai batas cache dapat diturunkan melalui environment variable
`PHOTOSLIVE_THUMBNAIL_CACHE_MAX_BYTES`, `PHOTOSLIVE_GIF_CACHE_MAX_BYTES`,
`PHOTOSLIVE_TEMP_CACHE_MAX_BYTES`, dan `PHOTOSLIVE_TEMP_MAX_AGE_SECONDS`.

Admin selalu meminta `GET /api/storage/cleanup/preview` sebelum penghapusan.
Preview menghitung kandidat tanpa mutasi dan `POST /api/storage/cleanup` dengan
`{"dryRun": false}` hanya menghapus file uploaded yang telah melewati retensi,
cache terkelola, dan file sementara aman. Path yang keluar dari folder foto dan
foto tanpa `uploaded_at` selalu ditolak oleh Controller.

Saat endpoint complete dipanggil, perubahan status session dan insert outbox
`session.sync:{sessionId}` berada pada transaksi SQLite yang sama. Job memiliki
ID stabil sehingga complete/retry tidak membuat duplikat. Agent mengklaim satu
job secara atomik, memulihkan claim yang ditinggalkan lebih dari lima menit,
memverifikasi SHA-256 file di cloud, lalu menandai session/file `uploaded_at`.
Kegagalan memakai exponential backoff. Setelah 10 kegagalan, job masuk
dead-letter agar mini PC tidak melakukan retry tanpa batas. Job gagal maupun
dead-letter dapat diretry manual melalui
`POST /api/local/sync/retry`.

Agent memeriksa outbox SQLite setiap 5 detik. Pemeriksaan ini lokal dan tidak
membuat request internet ketika antrean kosong. Saat koneksi pulih, maksimal
tiga job dikirim per putaran agar booth tetap responsif. Perintah hardware
jarak jauh diperiksa terpisah setiap 15 menit ketika tidak ada pekerjaan.

Setiap hari pukul 03.15 waktu lokal mesin, Agent menjalankan rekonsiliasi penuh
yang dibatasi maksimal 250 sesi per batch. Rekonsiliasi hanya mengirim metadata
dan checksum; file foto tetap mengikuti outbox/resumable upload. RPC PostgreSQL
bersifat idempotent dan seluruh batch diproses dalam satu transaksi. Waktu
terakhir sync incremental, rekonsiliasi penuh, jumlah sesi, jadwal, dan antrean
ditampilkan pada halaman admin. Foto tanpa `uploaded_at` tidak pernah menjadi
kandidat cleanup.

Antrean aktif dibatasi 1.000 job. Controller menolak penyelesaian sesi baru
dengan pesan yang dapat ditindaklanjuti ketika batas tercapai, sementara 200
job selesai terakhir dipertahankan sebagai riwayat operasional. Status lokal
menampilkan kapasitas tersisa agar Local Manager dapat memperingatkan operator.

## Keamanan

- Controller bind ke loopback dan mutasi pada namespace `/api/local/*` memakai
  installation token 256-bit dengan permission file `0600`.
- Token Agent, installation token, dan command key tidak pernah ditampilkan
  pada UI maupun output `agent.py --status`.
- Remote command menggunakan HMAC, expiry, idempotency key, allowlist jenis job,
  dan pembatasan 40 enqueue per mesin per 10 detik.
- PIN enam angka adalah akses operator lokal. Login admin remote memakai akun
  cloud. PIN remote lama masih berada pada mode kompatibilitas hingga migrasi
  akun selesai dan tidak boleh dianggap target akhir keamanan.

## Offline dan recovery

- Setiap heartbeat cloud yang berhasil memperbarui lease offline lokal yang
  ditandatangani HMAC dengan installation token. Controller menolak state yang
  berubah tanpa signature valid; token tidak pernah dikirim ke UI.
- Lease berada pada mode `normal` sampai 24 jam, `warning` pada 24–48 jam,
  `critical` pada 48–72 jam, lalu memblokir sesi baru setelah 72 jam. Sesi yang
  sudah aktif tetap dapat diselesaikan agar hasil pelanggan tidak hilang.
- QRIS hanya tersedia ketika heartbeat masih segar (maksimal 120 detik). Booth
  lokal menggunakan voucher yang sudah dialokasikan atau mode gratis saat
  offline. Instalasi lama tanpa lease tidak langsung terkunci, tetapi QRIS
  dinonaktifkan sampai Agent berhasil menghubungi cloud.
- Booth membedakan `configuredQrisEnabled` dari `qrisEnabled` efektif. Jika QRIS
  adalah satu-satunya metode yang dikonfigurasi dan internet mati, pelanggan
  melihat pesan offline; flow tidak boleh meneruskan pelanggan sebagai sesi
  gratis.
- Redeem voucher memakai transaksi SQLite `BEGIN IMMEDIATE`; redemption
  disinkronkan kembali ketika internet pulih.
- Pause Agent hanya menghentikan pengambilan command cloud. Heartbeat tetap
  aktif agar superadmin dapat melihat mesin dan mengaktifkannya kembali.
- Controller dan Agent dijaga supervisor OS. Menutup Local Manager tidak
  menghentikan service.
- Local Manager menampilkan state dan pesan lease sehingga operator tahu kapan
  internet perlu dipulihkan sebelum batas 72 jam.
- Local Manager juga menampilkan status Controller/Agent/cloud, booth dan
  status onboarding, perangkat aktual, RAM/CPU/disk, uptime, sync/print queue,
  folder, versi, update state, dan error terakhir. Kontrol mutasi menggunakan
  installation token loopback; log yang diexport berasal dari log berotasi dan
  tidak memuat installation/Agent token.

## Batas implementasi yang jujur

Source saat ini menyediakan script pemasangan teknisi, systemd user service,
macOS LaunchAgent, dan Windows scheduled task. Ketiga script menjalankan
Controller/Agent melalui supervisor OS, membuat installation token ketika
Controller mulai, lalu membuka tautan `/setup?setup=...` secara best-effort
tanpa input kode manual. Paket
`.deb`, signed `.exe`, serta
signed/notarized `.pkg`, update atomik dengan rollback, dan watchdog Windows
belum dapat dinyatakan production-ready tanpa certificate, pipeline release,
dan acceptance test pada ketiga OS.

Wizard membaca token `setup` dari URL sebagai sumber utama, memvalidasinya satu
kali tanpa menampilkannya ke operator, lalu membersihkan URL setelah state
dimuat. Progress non-sensitif disimpan
agar setup dapat dilanjutkan setelah reload/restart, sedangkan PIN dan isi file
tidak pernah masuk localStorage. Langkah perangkat/folder dan frame dapat
dilewati; readiness tetap membedakan item siap dari item yang perlu diatur di
admin.
