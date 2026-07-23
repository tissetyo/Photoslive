# Tim Platform dan RBAC Superadmin

Dokumen ini menjelaskan lifecycle akun internal Photoslive pada `/superadmin`.
Akun platform berbeda dari Owner/Admin/Operator milik satu booth.

## Peran

| Peran | Akses utama |
| --- | --- |
| Platform Owner | Seluruh control plane, termasuk pengelolaan tim platform |
| Integration Admin | Koneksi provider dan operasi integrasi |
| Finance Admin | Ledger, payout, rekonsiliasi, dan kebijakan biaya |
| Fleet Admin | Fleet, access, remote job, rollout, dan feature flag |
| Support | Fleet read, recovery, dan audit read tanpa finance write |
| Auditor | Read-only pada fleet, integrasi, finance, audit, dan tim platform |

Permission tetap divalidasi oleh API. Menyembunyikan tombol di browser bukan
kontrol keamanan.

## Mengundang anggota

1. Platform Owner membuka **Tim platform**.
2. Isi nama, email, dan peran.
3. Konfirmasi password Platform Owner untuk re-authentication.
4. Sistem mengantrekan email undangan; tautan manual tetap tersedia sebagai
   fallback bila provider email belum siap.

Token undangan berlaku 24 jam. Server hanya menyimpan hash token; token mentah
hanya muncul sekali pada respons pembuatan undangan. Payload tautan pada antrean
email dienkripsi AES-GCM dan dibuka hanya saat worker mengirim email. Kunci aktif
dan kunci lama dapat dikonfigurasi berurutan melalui
`EMAIL_PAYLOAD_ENCRYPTION_KEYS`. Password baru minimal 12 karakter dan tidak
pernah dikembalikan oleh API.

## Transfer ownership booth

Platform Owner dapat memilih Admin/Operator aktif dari booth yang sama lalu
mengetik kode booth dan melakukan re-authentication. Redis menukar role owner
lama menjadi Admin dan target menjadi Owner dalam satu script atomik. Seluruh
sesi keduanya dicabut agar permission baru berlaku, perubahan masuk audit log,
dan notifikasi email untuk kedua pihak masuk antrean. Transfer ditolak bila
membership berubah, target nonaktif/lintas tenant, atau booth tidak memiliki
tepat satu owner aktif.

## Lifecycle dan sesi

- **Ubah peran** mencabut seluruh sesi lama agar permission baru segera berlaku.
- **Suspend** menolak login dan mencabut seluruh sesi aktif.
- **Aktifkan** memulihkan akun tanpa memulihkan sesi lama.
- **Cabut sesi** memaksa login ulang tanpa menghapus akun.
- **Cabut akun** menonaktifkan akun, mencabut sesi, dan melepas email dari akun.
- Semua mutasi meminta re-authentication Platform Owner dan masuk audit global.
- Permintaan bantuan password hanya diterima untuk email booth yang terdaftar;
  penyelesaian manual oleh platform dicatat sebagai audit recovery.

## Emergency bootstrap

Akun environment `SUPERADMIN_EMAIL` tetap tersedia sebagai break-glass selama
rollout akun database. Login break-glass dicatat sebagai
`platform_staff.login`. Credential harus berada di secret manager, dirotasi
setelah penggunaan, dan tidak boleh dibagikan lewat UI atau log.

## Batas yang masih terbuka

- Production acceptance tetap memerlukan review permission, session revocation,
  dan audit pada deployment serta database produksi.
