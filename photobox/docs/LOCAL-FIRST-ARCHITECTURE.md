# Arsitektur local-first Photoslive

## Prinsip sumber kebenaran

Photoslive memiliki dua jalur yang sengaja dipisahkan:

- **Cloud data** menyimpan booth, akun, role, pengaturan, aset, voucher, event,
  metadata sesi, audit, dan telemetry terakhir. Operasi ini tidak pernah
  menunggu Agent.
- **Local Controller** di `127.0.0.1:8080` menjalankan booth, kamera, compositor,
  penyimpanan foto, dan print. SQLite serta filesystem lokal tetap bekerja saat
  internet mati.
- **Agent** hanya mengirim heartbeat setiap 60 detik, menarik snapshot config
  dan voucher berdasarkan nomor versi, menjalankan command hardware yang
  ditandatangani, serta menyinkronkan hasil offline.

Simpan pengaturan mengubah database cloud dan menaikkan `settingsVersion`.
Heartbeat berikutnya mengirim versi tersebut ke Agent; Agent hanya menarik satu
snapshot jika versinya berubah. Dengan demikian klik **Simpan** tidak membuat
job hardware dan tidak melambat ketika mesin sedang offline.

## Data lokal

| Data | Media | Retensi |
| --- | --- | --- |
| Pengaturan terakhir | `settings.json`, penulisan atomik | sampai diganti |
| Voucher offline | SQLite `vouchers` dan `voucher_events` | sampai dipakai/dihapus cloud |
| Sesi dan attempt | SQLite `photo_sessions`, `photo_files` | sesuai upload dan retensi |
| Foto mentah/hasil | folder foto pilihan operator | minimum sampai upload berhasil |
| Antrean sinkronisasi | SQLite `sync_queue` | sampai sukses atau ditindaklanjuti |
| Metadata sinkronisasi | SQLite `local_state` | sampai instalasi dihapus |
| Log Agent | file berotasi 512 KB | terbatas otomatis |

Retensi 24 jam dihitung setelah upload berhasil. Ketika disk kritis, Controller
harus menolak sesi baru; ia tidak boleh menghapus foto yang belum berhasil
di-upload.

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

- QRIS tidak tersedia tanpa internet. Booth lokal menggunakan voucher yang
  sudah dialokasikan atau mode gratis.
- Redeem voucher memakai transaksi SQLite `BEGIN IMMEDIATE`; redemption
  disinkronkan kembali ketika internet pulih.
- Pause Agent hanya menghentikan pengambilan command cloud. Heartbeat tetap
  aktif agar superadmin dapat melihat mesin dan mengaktifkannya kembali.
- Controller dan Agent dijaga supervisor OS. Menutup Local Manager tidak
  menghentikan service.

## Batas implementasi yang jujur

Source saat ini menyediakan script pemasangan, systemd user service, macOS
LaunchAgent, dan Windows scheduled task. Paket `.deb`, signed `.exe`, serta
signed/notarized `.pkg`, update atomik dengan rollback, dan watchdog Windows
belum dapat dinyatakan production-ready tanpa certificate, pipeline release,
dan acceptance test pada ketiga OS.

