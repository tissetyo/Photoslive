# Proteksi pengambilalihan onboarding

Onboarding Photoslive memakai token acak satu kali yang diterbitkan Agent dan
berlaku maksimal 15 menit. Token hanya berada di tautan yang dibuka otomatis,
tidak ditampilkan sebagai kode untuk operator. Token bukan `boothCode`: setelah
onboarding, URL booth memakai kode permanen yang berbeda.

## Kontrol yang aktif

- Hanya token terbaru pada sebuah mesin yang dapat divalidasi atau diklaim.
- Saat Agent membuat tautan pengganti, mapping token sebelumnya langsung dihapus.
- Mesin yang sudah memiliki pemilik tidak dapat menjalankan onboarding pemilik
  baru melalui tautan setup; pemilik harus login dan menambah user dari admin.
- Klaim legacy dari halaman admin memerlukan session Owner, Admin, atau
  Superadmin; endpoint tidak lagi menerima klaim anonim.
- Setup memakai lock `NX` ber-TTL. Dua submit bersamaan hanya dapat menghasilkan
  satu owner dan satu konsumsi kode.
- Setelah sukses, mapping token setup dihapus.
- Validasi dan setup tetap dilindungi rate limit dan pemeriksaan origin browser.

## Recovery

Jika tautan kedaluwarsa atau diganti, operator memilih **Jalankan ulang wizard** pada
Local Manager. Mesin yang sudah terdaftar tidak boleh di-onboard ulang;
gunakan login existing owner atau proses recovery yang diaudit.

## Bukti otomatis

`web/tests/pairing-takeover.test.mjs` memverifikasi penolakan kode lama,
penolakan re-onboarding mesin berpemilik, klaim atomik concurrent, autentikasi
endpoint legacy, dan invalidasi kode lama.
