# RPO dan RTO Photoslive

Dokumen ini menetapkan target pemulihan produksi. Target bukan bukti bahwa gate
produksi sudah lulus. Kolom **build saat ini** harus tetap jujur terhadap hasil
drill dan infrastruktur yang benar-benar tersedia.

## Definisi

- **RPO** adalah jumlah data maksimum yang boleh hilang setelah insiden.
- **RTO** adalah waktu maksimum sejak insiden dikonfirmasi sampai layanan dapat
  dipakai kembali dalam mode aman.
- Waktu dimulai setelah alert diterima operator. Insiden yang tidak terdeteksi
  belum memenuhi SLO observability.

## Target per kegagalan

| Skenario | Data yang dilindungi | Target RPO | Target RTO | Build saat ini |
| --- | --- | ---: | ---: | --- |
| Controller crash, disk sehat | transaksi SQLite dan file capture yang sudah di-commit | 0 | 2 menit | Teruji otomatis dengan process kill; supervisor hardware belum di-drill |
| Database SQLite korup, disk sehat | backup lokal terverifikasi dan foto di filesystem | 24 jam | 30 menit | Restore atomik dari backup terverifikasi lulus test; drill operator/hardware belum dilakukan |
| Internet/cloud putus | sesi lokal, voucher dialokasikan, antrean upload | 0 untuk data lokal | 5 menit setelah koneksi pulih untuk melanjutkan queue | Retry/recovery teruji; soak test jaringan nyata belum dilakukan |
| Agent reinstall, disk lokal dipertahankan | config cloud, SQLite, folder foto | 0 | 60 menit | Belum ada installer signed dan drill reinstall |
| SSD mini PC rusak total | file yang sudah ter-upload dan metadata cloud | sejak upload terakhir yang terverifikasi | 8 jam | Belum memenuhi: backup foto eksternal dan drill penggantian SSD belum tersedia |
| Database cloud gagal | booth/config/voucher/session metadata cloud | 15 menit | 4 jam | Belum memenuhi: PostgreSQL production, PITR, dan restore drill belum aktif |
| Object storage gagal | foto cloud dan hasil frame/GIF | 24 jam | 8 jam | Belum memenuhi: versioning/lifecycle dan restore provider belum diuji |
| Deployment web gagal | build web/API terakhir yang sehat | 0 data | 15 menit | Prosedur rollback ada; staged production drill belum dilakukan |

## Aturan pemulihan

1. Jangan menghapus atau memindahkan foto `unsynced` untuk mengejar RTO.
2. Selesaikan sesi aktif jika database dan storage masih sehat; blokir sesi baru
   ketika integritas data tidak dapat dijamin.
3. Restore hanya memakai backup dengan checksum cocok dan SQLite `quick_check`
   sehat. Kandidat restore diverifikasi sebelum atomic replace.
4. Setelah restore, verifikasi database, folder foto, sync queue, print queue,
   konfigurasi booth, dan satu capture uji sebelum membuka akses pelanggan.
5. Catat waktu deteksi, mulai pemulihan, selesai pemulihan, data yang hilang,
   dan keputusan operator pada incident timeline ketika control plane tersedia.

## Bukti yang masih wajib

- drill restore pada mini PC target 4 GB;
- reboot dan service-supervisor recovery;
- reinstall Agent tanpa kehilangan folder data;
- penggantian SSD dari backup eksternal;
- PostgreSQL PITR dan object-storage version restore;
- alert delivery dan pengukuran waktu aktual terhadap target di atas.

Sebelum bukti tersebut tersedia, status disaster recovery tetap **partial** dan
tidak boleh dipromosikan sebagai production-ready.
