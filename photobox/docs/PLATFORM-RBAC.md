# Permission control-plane superadmin

Photoslive memisahkan login platform (`role: superadmin`) dari jabatan
operasional (`platformRole`). Session lama tanpa `platformRole` dipetakan ke
`platform_owner` agar rollout tidak memutus akses pemilik platform.

| Platform role | Baca fleet/audit/health | Acknowledge incident | Remote hardware | Feature flag | Access booth | Recovery | Integration | Finance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Platform Owner | Ya | Ya | Ya | Ya | Ya | Ya | Ya | Ya |
| Integration Admin | Ya | Tidak | Tidak | Ya | Tidak | Tidak | Ya | Tidak |
| Finance Admin | Ya | Tidak | Tidak | Tidak | Tidak | Tidak | Tidak | Ya |
| Fleet Admin | Ya | Ya | Ya | Tidak | Ya | Tidak | Tidak | Tidak |
| Support | Ya | Ya | Tidak | Tidak | Tidak | Ya | Tidak | Tidak |
| Auditor | Ya | Tidak | Tidak | Tidak | Tidak | Tidak | Tidak | Tidak |

API memeriksa permission terpisah untuk read dan write. UI menerima daftar
permission dari session yang telah ditandatangani, lalu menyembunyikan form
write dan mengganti tombol akses menjadi status read-only. UI bukan batas
keamanan; API tetap menjadi sumber otorisasi.

Build saat ini membaca satu akun bootstrap dari `SUPERADMIN_EMAIL`,
`SUPERADMIN_PASSWORD_HASH`, dan opsional `SUPERADMIN_ROLE`. Default role adalah
`platform_owner`. Lifecycle beberapa akun platform—invite, suspend, revoke,
session revoke, re-authentication, dan emergency access—belum selesai dan tidak
boleh dianggap tersedia hanya karena permission matrix ini sudah ada.
