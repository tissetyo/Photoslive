# Photoslive multi-photobox routing dan autentikasi

## URL kanonis

| URL | Fungsi |
| --- | --- |
| `/` | Landing page Photoslive |
| `/setup` | Wizard onboarding Agent, identitas mesin, akun pemilik, perangkat, dan frame |
| `/superadmin` | Control center semua mesin dan request pemulihan |
| `/{boothCode}` | Layar pelanggan untuk satu photobox |
| `/{boothCode}/admin` | Dashboard admin tenant |
| `/{boothCode}/{shareCode}` | Galeri publik satu sesi selama maksimal 24 jam |

`boothCode` adalah identifier permanen. Kode pairing/setup tetap sekali pakai dan
berlaku 15 menit; nilainya boleh menjadi `boothCode` pada setup pertama, tetapi
setelah diklaim kode pairing dihapus. Karena itu `pairingCode: null` adalah status
normal pada mesin yang sudah paired.

## Upgrade dan recovery Agent

Installer wajib mengganti source **dan** me-restart proses Agent/controller. Pada
Linux installer menggunakan `systemctl --user restart`, bukan hanya
`enable --now`. Versi aktif dapat diperiksa dengan:

```bash
python3 "$HOME/.local/share/photoslive/source/photobox/agent.py" --status
```

Untuk mesin lama yang sudah paired tetapi belum mempunyai onboarding akun:

```bash
python3 "$HOME/.local/share/photoslive/source/photobox/agent.py" --setup-code
```

Perintah menghasilkan kode baru yang berlaku 15 menit tanpa menghapus machine ID,
token Agent, atau konfigurasi controller.

## Model akses

- `superadmin`: melihat seluruh mesin, status, request password, dan menonaktifkan akses satu photobox.
- `owner`: akun pertama saat setup; dapat mengelola pengguna tenant.
- `admin`: dapat mengelola konfigurasi dan menambahkan operator.
- `operator`: akses operasional mesin.

Owner pertama dibuat dengan email dan PIN enam angka; password tidak diwajibkan
pada onboarding. Password dapat ditambahkan kemudian dari halaman pengguna
admin. Password dan PIN yang tersedia di-hash menggunakan PBKDF2-SHA256 dengan salt individual.
Session browser ditandatangani HMAC dan disimpan pada cookie `HttpOnly`, `Secure`,
`SameSite=Lax` selama tujuh hari.

## Wizard onboarding mesin baru

1. **Kode setup (wajib):** cloud memvalidasi kode dari Agent tanpa langsung
   mengklaim atau menghapusnya.
2. **Identitas:** owner mengisi nama photobox; lokasi boleh dikosongkan.
3. **Akses pemilik (wajib):** owner mengisi email, PIN enam angka, dan konfirmasi
   PIN. Pada tahap ini mesin diklaim dan session owner dibuat.
4. **Kamera dan printer (boleh dilewati):** UI membaca heartbeat Agent dan
   menunjukkan perangkat yang terdeteksi.
5. **Frame pertama (boleh dilewati):** owner memilih frame bawaan atau mengunggah
   frame melalui Agent ketika mesin online.
6. **Siap digunakan:** UI merangkum bagian yang sudah siap dan bagian yang masih
   perlu diselesaikan dari admin.

Kode setup baru dihapus hanya setelah langkah akses pemilik berhasil. Refresh
pada langkah sebelum klaim tidak boleh menghabiskan kode tersebut.

Environment production wajib berisi `SESSION_SECRET` minimal 32 karakter,
`SUPERADMIN_EMAIL`, dan `SUPERADMIN_PASSWORD_HASH`.

## Galeri sesi 24 jam

Saat local controller membuat sesi, booth mendaftarkan metadata ke cloud. Galeri
menampilkan satu foto final mentah per slot, kolase PNG, dan preview flipbook.
Metadata Redis dan file lokal sama-sama berumur maksimal 24 jam.

Untuk galeri yang tetap tersedia ketika mini PC offline, tahap berikutnya wajib
memakai object storage (R2/S3) dengan signed upload URL; file besar tidak boleh
melewati body Vercel Function atau Redis.
