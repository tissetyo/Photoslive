# Kontrak interaksi Photoslive

Dokumen ini adalah acceptance inventory. Sebuah kontrol hanya boleh terlihat
aktif jika memiliki handler, operasi, persistence, loading, sukses, error, dan
disabled state. Kontrol tanpa backend harus disembunyikan oleh feature flag.

## Snapshot inventaris otomatis

Audit 22 Juli 2026 mencakup 8 surface (`admin`, `booth`, `setup`, Local
Manager, tablet companion, `superadmin`, halaman hasil sesi, dan public status),
10 route produk, 98 pola endpoint, serta 428 kontrol form/interaktif. Sebanyak
427 kontrol terhubung melalui ID,
form handler, event delegation berbasis atribut/class, atau aksi native
`dialog`; satu checkbox proteksi foto belum ter-upload sengaja disabled dan
tidak dapat dimatikan operator. Jumlah kontrol dengan status `unknown` adalah
nol.

Audit menghasilkan exit code nonzero bila menemukan kontrol ber-ID tanpa
referensi handler atau kontrol aktif yang belum dapat diklasifikasikan. Angka
ini adalah bukti kelengkapan wiring, bukan bukti bahwa seluruh backend produk
sudah production-ready; status real/partial/unavailable tetap dicatat terpisah
di tracker.

## Booth lokal dan publik

| Route/kontrol | Operasi | Persistence dan state wajib |
| --- | --- | --- |
| `/{boothCode}` / Mulai foto | Cache config lalu pindah layar langsung | disabled sampai cache/fresh config siap; error dapat dicoba ulang; refresh background tidak mengubah sesi aktif; kamera diperiksa paralel |
| Modal akses QRIS | `POST cloud_data:/api/booth/qris`, lalu `GET /api/booth/payments/:id` | loading, QR image server-side, polling bounded, paid, expired/failed/refunded/chargeback, timeout, provider tidak tersedia; jika QRIS dikonfigurasi tetapi offline, tampilkan tindakan pemulihan dan jangan membuka sesi gratis |
| Modal voucher | redeem cloud atau SQLite lokal | atomic, success, used/not found, event expired, disabled saat submit |
| Pilih frame | config/aset cache | thumbnail nyata, selected, pagination, empty/error |
| Lanjutkan | create local session UUID | disabled sampai frame valid; error tanpa menghapus pilihan |
| Capture/retake | local camera endpoint | countdown tiap attempt, timeout sesi, slot kecil tetap di pojok |
| Terima foto | pilih attempt | satu final per slot, lanjut slot berikutnya |
| Print | enqueue lokal | accepted <1 detik, paid-print gate, printer error dapat ditindaklanjuti |
| Selesai/skip | close session/reset | timer 15 detik dan tombol skip |
| `/sesi/{code}` | metadata + file sesi | expiry 24 jam, per-file error, download mentah dan hasil; ZIP dibentuk di Web Worker agar UI tidak terblokir |

## Admin booth

| Area | API sumber kebenaran | Perilaku saat Agent offline |
| --- | --- | --- |
| Tampilan/frame | cloud settings/assets | tetap dapat disimpan; Controller menarik versi nanti |
| Frame dari Photoslive | `GET platform_frame_library` dan signed download | preview, pagination, empty/error/retry, serta download tetap bekerja tanpa Agent; admin booth tidak dapat upload/hapus |
| Sesi/pembayaran | cloud settings | tetap dapat disimpan; QRIS aktif hanya jika provider siap |
| Voucher/event | cloud vouchers/events | generate/create/print tetap bekerja tanpa Agent |
| Kamera/printer | signed hardware job | disabled atau berstatus menunggu/tidak tersedia |
| Penyimpanan lokal | Local Manager/Controller | remote hanya melihat telemetry terakhir; pilih folder wajib lokal |
| Pengguna | cloud users/roles | tetap bekerja tanpa Agent |
| Audit | cloud audit | tetap bekerja tanpa Agent |

Capability gate production wajib berasal dari respons `/api/settings` dan `/api/booth/config`. UI tidak boleh menganggap nama provider di dropdown sebagai bukti bahwa integrasi siap. Bila capability tidak tersedia, toggle dinonaktifkan, nilai efektif booth dipaksa `false`, dan server menolak aktivasi dengan HTTP 409.

Local Manager hanya aktif pada `127.0.0.1`/`localhost`. Dari domain production, route tersebut hanya menampilkan petunjuk untuk membuka URL loopback pada komputer photobox dan tidak mengirim request kontrol apa pun.

Hard stop Agent hanya tersedia di bagian **Advanced**, membutuhkan installation
token serta konfirmasi `STOP AGENT`, dan tidak menghentikan Controller/booth
lokal. Pemeriksaan, pemasangan, dan rollback update dari superadmin dikirim
sebagai remote job bertanda tangan dan memiliki expiry. Agent meneruskannya ke
endpoint updater Controller yang terlindungi; state updater sebenarnya tetap
dilaporkan melalui heartbeat, sehingga status job tidak dianggap sebagai bukti
update berhasil.

Build test memeriksa kontrol ber-ID, form-owned, event delegation berbasis
atribut/class, dan aksi native dialog pada keenam surface utama agar tidak ada
kontrol baru yang dirilis tanpa klasifikasi. Link inert `href="#"` juga
ditolak. Jalankan `npm run audit` untuk ringkasan atau `npm run audit:full`
untuk inventaris JSON lengkap.

Config yang dibaca dari cache selalu dianggap belum membuktikan koneksi cloud.
Pada domain publik, fetch config cloud yang berhasil menandai koneksi online;
pada loopback, sumber kebenarannya adalah `offlinePolicy.online` dari
Controller. Config baru ditahan sebagai `pendingConfig` ketika pelanggan sudah
meninggalkan welcome dan baru diterapkan setelah reset sesi.

Semua tombol submit harus memakai `disabled` dan `aria-busy` selama request,
memulihkan label setelah selesai, serta menampilkan pesan backend konkret.

Penyelesaian sesi tidak mengunggah Base64 dari browser. Controller menyelesaikan
session dan membuat outbox dalam satu transaksi; Agent memproses outbox secara
asinkron. UI hasil hanya menyatakan foto aman setelah transaksi lokal berhasil.
Jika R2/S3 tersedia, Agent meminta presigned PUT per file dan mengunggah byte
langsung ke bucket. Cloud memverifikasi ukuran serta checksum metadata melalui
HEAD sebelum memasukkan file ke halaman download. Tanpa provider, hanya file di
bawah batas fallback legacy yang dikirim sebagai Base64; keadaan ini tidak boleh
ditampilkan sebagai object storage production.

## Setup

| Langkah | Wajib | Selesai jika |
| --- | --- | --- |
| Kode setup | ya | kode 15 menit tervalidasi |
| Identitas | nama; lokasi opsional | draft tersimpan dan wizard dapat dilanjutkan |
| Akses owner | email dan PIN | machine diklaim, owner/session cloud dibuat |
| Perangkat/folder | dapat dilewati | nama perangkat nyata tampil; tes memberi hasil nyata |
| Frame | dapat dilewati | pilihan atau editor tersimpan; preview slot nyata |
| Readiness | ya | route booth/admin jelas dan satu primary action |

Kode dari installer dikirim sebagai `/setup?code=...`, harus mengalahkan draft
lama, lalu dihapus dari address bar setelah dimuat. Aksi readiness utama adalah
**Mulai gunakan photobox** dan membuka route booth; admin tetap tersedia sebagai
route terpisah. PIN/file input tidak boleh masuk draft browser.

Halaman setup mendeteksi OS dan menampilkan tepat satu installer utama. Tautan
OS lain dan perintah Terminal hanya berada di bagian alternatif/teknisi. Ini
belum menyatakan paket native sudah signed atau notarized; gate tersebut tetap
terbuka sampai artifact release lintas OS tersedia dan diuji.

## Local Manager

Kontrol nyata saat ini: Periksa, Pause, Resume, Restart melalui supervisor,
periksa/pasang update bertanda tangan, rollback versi dengan konfirmasi,
Diagnosis, Buat kode setup, Pilih folder, backup/restore database lokal, buka
booth/admin, refresh dan log. Antrean upload menampilkan progres per-file dan
jumlah part yang tersimpan, error terakhir, retry semua, dan retry satu job
tanpa mengulang file/part yang sudah memiliki checkpoint selesai.
Antrean cetak menampilkan file hasil, keberadaan file, jumlah percobaan, error
printer asli, dan retry satu job gagal. Retry tidak membuat job cetak kedua.
Panel kesehatan membaca `/api/local/metrics` dengan installation token,
menampilkan loading/error/retry, latency p95, error rate, queue depth, dan
kegagalan operasi dari registry RAM yang dibatasi 512 request.
Update Agent memverifikasi RSA-2048/SHA-256 manifest, checksum bundle dan setiap
file, membuat backup versi, menjalankan health check, serta rollback otomatis
bila validasi pascapasang gagal. UI menampilkan state checking/downloading/
installing/failed/restart-required dan tidak menunggu heartbeat Agent.

## Superadmin

Panel **Perpustakaan frame global** memakai direct upload object storage dalam
dua langkah (`prepare` lalu `finalize`). Platform Owner/Integration Admin dapat
upload dan hapus; role read-only hanya dapat melihat atau mengunduh. Tombol
upload disabled selama hashing/upload/finalize, error backend ditampilkan,
refresh/retry tersedia, dan metadata storage privat tidak masuk list response.

Daftar mesin, lokasi, state Agent/Controller, version, RAM/disk, last seen,
access enable/disable, request pemulihan, dan telemetry terakhir wajib berasal
dari cloud. Owner dan membership dibaca dari indeks tenant booth, ditampilkan
sebagai identitas/role/status saja, dan tidak pernah menyertakan password/PIN
hash. Audit log global menampilkan maksimum 100 aktivitas sensitif
terbaru dan memiliki loading, empty, error, serta retry state. Restart/update hanya aktif saat
Agent online dan command backend tersedia. Panel fleet membedakan Siap,
Terlambat, dan Offline, menyimpan incident timeline bounded, menyediakan retry
health serta acknowledgement yang diaudit, dan menutup insiden ketika heartbeat
kembali. Semua mutasi masuk audit log.

Panel **Backend & integrasi** memakai endpoint superadmin terautentikasi. Cache
dibuktikan dengan probe write/read/delete ber-TTL, PostgreSQL hanya diprobe saat
shadow migration diaktifkan, dan daftar provider hanya menyatakan readiness
adapter—bukan keberhasilan transaksi live. Panel memiliki loading, success,
error, empty, disabled, dan retry tanpa membocorkan secret server.

Panel **Antrean remote** membaca indeks global bounded beserta antrean mesin
yang masih aktif. Hanya metadata operasional yang dikirim ke browser; payload,
signature, dan command key tetap server-side. Job gagal atau kedaluwarsa dapat
dicoba ulang melalui job baru yang ditandatangani, memiliki expiry, terikat pada
mesin yang masih paired/aktif, dideduplikasi selama 10 menit, dan dicatat di
audit log. Form pengiriman hanya menawarkan `devices.refresh` dan
`service.restart`; restart meminta konfirmasi, memakai idempotency key baru,
dan arbitrary payload tidak dapat dimasukkan dari browser. Panel memiliki
loading, success, empty, error, disabled, dan retry.
