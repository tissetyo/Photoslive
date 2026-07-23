# Feature flags Photoslive

Feature flags dipakai untuk rollout dan rollback bertahap tanpa menampilkan
fitur backend yang belum siap. Hanya superadmin yang dapat membuat atau
menghapus override melalui `/superadmin`.

## Prioritas

Nilai efektif dihitung berurutan: **default → global → organization → booth**.
Scope yang lebih spesifik selalu menang. Tombol **Gunakan turunan** menghapus
override pada scope aktif sehingga nilai kembali mengikuti scope di atasnya.

Organization hanya dapat dipilih jika machine sudah memiliki
`organizationId`. Booth target selalu divalidasi terhadap tenant yang benar;
override satu booth tidak boleh memengaruhi booth lain.

## Flag aktif

| Key | Default | Dampak runtime |
| --- | --- | --- |
| `direct_object_upload` | aktif | Memakai presigned PUT sampai 25 MB. Jika dimatikan, admin dan setup kembali ke upload kompatibilitas maksimal 2 MB. |
| `tablet_pwa` | nonaktif | Reservasi rollout PWA tablet; belum ditampilkan sebagai fitur aktif. |
| `postgres_dual_read` | nonaktif | Reservasi rollout migrasi data; belum mengaktifkan dual-read sebelum worker tersedia. |
| `remote_snapshot` | nonaktif | Reservasi snapshot kamera; UI tetap tersembunyi sampai backend tersedia. |
| `provider_marketplace` | nonaktif | Reservasi marketplace provider. |
| `finance_ledger` | nonaktif | Reservasi finance ledger. |

Hanya `direct_object_upload` yang saat ini memiliki dampak runtime. Flag lain
tetap default nonaktif agar tidak menjadi kontrol mockup.

## Operasi dan keamanan

- GET/POST/DELETE memakai `action=feature_flags` dan mewajibkan session
  superadmin.
- Key flag berasal dari allowlist; payload config dibatasi 4 KB.
- Target booth/organization divalidasi sebelum write.
- Setiap perubahan dan penghapusan masuk ke audit log.
- Saat terjadi masalah upload object storage, nonaktifkan
  `direct_object_upload` pada booth terdampak lebih dahulu. Upload kecil tetap
  tersedia tanpa menunggu Agent.

