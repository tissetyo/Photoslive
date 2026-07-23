# Migrasi object storage

Migrasi storage tersedia dari Superadmin → **Migrasi object storage**. Hanya
Platform Owner atau Integration Admin dengan permission integrasi tulis yang
dapat membuat dan menjalankan migrasi.

## Perilaku yang sudah tersedia

1. Pilih photobox, provider sumber, dan provider tujuan.
2. Server membuat manifest dari aset object-storage milik photobox tersebut.
3. Worker retensi terjadwal memproses maksimal tiga migrasi dan lima object per
   migrasi per run. Tombol **Salin berikutnya** tetap tersedia untuk retry/manual
   progress tanpa menunggu jadwal berikutnya.
4. Byte sumber dan byte tujuan dihitung ulang dengan SHA-256. Metadata provider
   tidak dianggap sebagai bukti checksum.
5. Metadata aset baru dipindahkan ke provider tujuan setelah ukuran dan checksum
   cocok. Lokasi lama disimpan sebagai `previousStorage` agar tetap dapat dibaca.
6. Migrasi dapat dijeda dan dilanjutkan setelah reload atau worker terputus.
7. Object gagal dicoba maksimal delapan kali; error terakhir tetap terlihat.
8. Lock Redis ber-TTL mencegah worker terjadwal dan tindakan manual memproses
   migrasi yang sama secara bersamaan.
9. **Finalisasi cutover** baru tersedia setelah seluruh object tersalin. Server
   memeriksa ulang metadata setiap aset sebelum finalisasi. Koneksi provider
   sumber khusus booth dipause; koneksi global/organisasi tetap aktif karena
   dapat dipakai booth lain. Provider sumber tidak dihapus sehingga rollback
   masih mungkin.

Setiap create, pause, resume, process, dan finalize dicatat pada audit log. Credential dan
signed URL tidak pernah masuk response daftar migrasi.

## Batas yang disengaja

- Worker terjadwal saat ini mengikuti cron retensi harian agar tetap kompatibel
  dengan baseline hosting tanpa biaya. Volume besar dapat diproses manual atau
  dengan menaikkan jadwal pada plan hosting yang mendukung frekuensi lebih tinggi.
- Finalisasi tidak menghapus object sumber. Penghapusan fisik tetap merupakan
  operasi terpisah setelah masa rollback dan acceptance provider nyata.
- Satu manifest dibatasi 5.000 object dan satu object 25 MB pada control-plane
  worker agar request server tetap terbatas.

Jika koneksi provider gagal, perbaiki credential pada **Koneksi provider**, tes
koneksi, lalu lanjutkan migrasi yang sama. Jangan membuat manifest baru hanya
untuk mengulang object yang gagal.
