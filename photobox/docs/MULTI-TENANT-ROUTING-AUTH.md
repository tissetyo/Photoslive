# Photoslive multi-photobox routing dan autentikasi

## URL kanonis

| URL | Fungsi |
| --- | --- |
| `/` | Landing page Photoslive |
| `/setup` | Registrasi/login akun, lalu pilihan untuk menghubungkan mesin |
| `/admin` | Admin organization; tetap tersedia sebelum ada mesin |
| `/superadmin` | Control center semua mesin dan request pemulihan |
| `/{boothCode}` | Layar pelanggan untuk satu photobox |
| `/{boothCode}/admin` | Dashboard admin tenant |
| `/{boothCode}/sesi/{shareCode}` | Galeri publik satu sesi selama maksimal 24 jam |

`boothCode` adalah identifier permanen. Token pairing tetap sekali pakai dan
berlaku 15 menit. Operator dapat memindai QR atau memasukkan fallback code.
Setelah claim, ownership mesin berlaku sampai dicabut dan tidak terpengaruh
logout browser, reboot, atau reconnect internet.

## Upgrade dan recovery Agent

Installer wajib mengganti source **dan** me-restart proses Agent/controller. Pada
Linux installer menggunakan `systemctl --user restart`, bukan hanya
`enable --now`. Versi aktif dapat diperiksa dengan:

```bash
python3 "$HOME/.local/share/photoslive/source/photobox/agent.py" --status
```

Untuk membuat QR/kode pairing baru pada mesin yang belum paired:

```bash
python3 "$HOME/.local/share/photoslive/source/photobox/agent.py" --pairing-link
```

Perintah ini jalur teknisi. Flow operator memakai tombol Local Manager.

## Model akses

- `superadmin`: melihat seluruh mesin, status, request password, dan menonaktifkan akses satu photobox.
- `owner`: akun pertama saat setup; dapat mengelola pengguna tenant.
- `admin`: dapat mengelola konfigurasi dan menambahkan operator.
- `operator`: akses operasional mesin.

Owner pertama dibuat melalui Supabase Auth menggunakan email dan password.
Registrasi tidak memerlukan mesin. Session aplikasi memakai cookie host-only
`HttpOnly`, `Secure`, `SameSite=Lax` dengan silent renewal sampai 90 hari dan
tetap dapat dicabut. PIN bersifat opsional dan hanya untuk login lokal.

### Login remote dan PIN lokal

Admin yang membuka `/{boothCode}/admin` dari komputer lain masuk memakai email
dan password. Opsi **PIN lokal** disembunyikan secara default dan baru muncul
setelah halaman setup berhasil menemukan Local Controller pada loopback
`127.0.0.1` milik komputer photobox tersebut.

Controller tidak pernah mengirim `commandKey`, installation token, atau Agent
token ke browser. Sebagai gantinya, Controller menerbitkan assertion HMAC yang:

- terikat pada `machineId`, `boothCode`, dan tujuan `admin-pin`;
- memiliki nonce acak dan masa berlaku maksimal 60 detik;
- hanya diterbitkan melalui endpoint loopback dengan origin cloud yang sama;
- hanya dapat digunakan sekali karena nonce dikonsumsi atomik di cloud.

Cloud menolak login PIN tanpa assertion yang valid, walaupun PIN benar. Jika
browser tidak dapat menjangkau Controller atau kebijakan Private Network Access
memblokir request, opsi PIN tetap tersembunyi dan operator memakai email serta
password. Dengan demikian, PIN enam angka bukan kredensial admin remote.

Setiap session juga dicatat pada indeks per pengguna. Halaman **Pengguna admin**
menampilkan jumlah session aktif dan menyediakan aksi **Cabut sesi**. Aksi ini
menghapus record session di server, bukan hanya cookie browser, sehingga session
lama langsung tidak dapat dipakai lagi. Owner dapat mencabut session admin dan
operator; admin tidak dapat mencabut session owner. Pencabutan diri sendiri
menghapus cookie saat ini dan mengarahkan pengguna kembali ke halaman login.
Seluruh pencabutan tercatat sebagai `user.sessions_revoked` pada audit log booth.

## Setup akun dan mesin

1. **Akun:** registrasi/login email dan password. User langsung masuk `/admin`.
2. **Pairing:** pilih Scan QR, Masukkan kode, atau Siapkan nanti. Claim
   menampilkan konfirmasi machine code, OS, organization, owner, booth/lokasi,
   versi, dan perangkat.
3. **Siap:** ownership permanen disimpan di PostgreSQL dan SQLite lokal.
   Konfigurasi kamera, printer, folder, frame, QRIS, dan tes sesi dilanjutkan
   dari readiness checklist Admin dan tidak memblokir pairing.

Kartu setup tetap pada posisi yang sama. Background saat ini dipertahankan,
animasi menghormati `prefers-reduced-motion`, dan Admin memakai drawer/bottom
navigation serta card list pada layar kecil.

Environment production wajib berisi `SESSION_SECRET` minimal 32 karakter,
`SUPERADMIN_EMAIL`, dan `SUPERADMIN_PASSWORD_HASH`.

## Galeri sesi 24 jam

Saat local controller membuat sesi, booth mendaftarkan metadata ke cloud. Galeri
menampilkan satu foto final mentah per slot, kolase PNG, dan preview flipbook.
Metadata Redis dan file lokal sama-sama berumur maksimal 24 jam.

Untuk galeri yang tetap tersedia ketika mini PC offline, tahap berikutnya wajib
memakai object storage (R2/S3) dengan signed upload URL; file besar tidak boleh
melewati body Vercel Function atau Redis.
