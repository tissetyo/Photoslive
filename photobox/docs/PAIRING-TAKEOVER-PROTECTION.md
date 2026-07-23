# Proteksi pengambilalihan pairing

Pairing Photoslive memakai kode acak satu kali yang diterbitkan Agent dan
berlaku maksimal 15 menit. Kode setup bukan `boothCode`: setelah onboarding,
URL booth memakai kode permanen yang berbeda.

## Kontrol yang aktif

- Hanya kode terbaru pada sebuah mesin yang dapat divalidasi atau diklaim.
- Saat Agent membuat kode pengganti, mapping kode sebelumnya langsung dihapus.
- Mesin yang sudah memiliki pemilik tidak dapat menjalankan onboarding pemilik
  baru melalui kode setup; pemilik harus login dan menambah user dari admin.
- Klaim legacy dari halaman admin memerlukan session Owner, Admin, atau
  Superadmin; endpoint tidak lagi menerima klaim anonim.
- Setup memakai lock `NX` ber-TTL. Dua submit bersamaan hanya dapat menghasilkan
  satu owner dan satu konsumsi kode.
- Setelah sukses, mapping kode pairing dihapus.
- Validasi dan setup tetap dilindungi rate limit dan pemeriksaan origin browser.

## Recovery

Jika kode kedaluwarsa atau diganti, operator membuat kode baru melalui Agent
atau Local Manager. Mesin yang sudah terdaftar tidak boleh di-onboard ulang;
gunakan login existing owner atau proses recovery yang diaudit.

## Bukti otomatis

`web/tests/pairing-takeover.test.mjs` memverifikasi penolakan kode lama,
penolakan re-onboarding mesin berpemilik, klaim atomik concurrent, autentikasi
endpoint legacy, dan invalidasi kode lama.
