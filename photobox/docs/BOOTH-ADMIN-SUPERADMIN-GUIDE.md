# Panduan booth, admin, dan superadmin

## Operator booth

Gunakan URL lokal `/booth` agar capture tetap cepat dan offline. Flow pelanggan:
welcome, akses QRIS/voucher bila aktif, pilih frame, countdown, capture/retake,
hasil, print, lalu goodbye. Jangan reload saat sesi aktif kecuali recovery
otomatis sudah tampil. Error kamera/printer tidak boleh menghapus foto.

## Admin booth

Buka `/{boothCode}/admin`. Setting cloud harus dapat disimpan walau Agent
offline; tindakan hardware akan berstatus menunggu atau tidak tersedia. Gunakan:

- Dashboard untuk readiness dan link perbaikan.
- Tampilan untuk layar, logo, teks, warna, background, dan frame.
- Bagian **Frame dari Photoslive** untuk melihat preview dan mengunduh frame
  global yang dibagikan superadmin. File hasil unduhan tidak langsung aktif;
  pilih **Tambah desain** untuk mengatur slot foto, logo, dan stiker sebelum
  digunakan pada booth.
- Sesi & pembayaran untuk timer, voucher, QRIS, dan paid print.
- Kamera & printer untuk pilihan serta tes perangkat.
- Penyimpanan untuk folder, quota, retention, dan sesi 24 jam.
- Pengguna admin untuk role dan revoke session.

Owner mengelola membership; Admin mengelola booth; Operator menjalankan operasi
terbatas. PIN tidak digunakan untuk login remote.

## Superadmin

`/superadmin` adalah control plane fleet, bukan raw database console. Akses
bergantung role Platform Owner, Fleet Admin, Integration Admin, Finance Admin,
Support, atau Auditor. Perubahan akses, provider, finance, remote job, dan
recovery tercatat di audit log. Secret, installation token, dan rekening lengkap
tidak pernah ditampilkan.

### Perpustakaan frame global

Platform Owner dan Integration Admin dapat mengunggah PNG, JPEG, atau WebP
maksimal 25 MB melalui panel **Perpustakaan frame global**. Browser mengunggah
file langsung ke object storage dengan URL PUT bertanda tangan; API kemudian
memverifikasi ukuran dan checksum sebelum frame ditampilkan. Superadmin yang
memiliki izin write juga dapat menghapus frame. Semua admin booth hanya mendapat
akses preview dan download, sedangkan object key, credential, dan URL storage
permanen tidak pernah dikirim ke browser. Upload, hapus, dan download dicatat
di audit log.
