# Instalasi dan setup nonteknis

## Komputer Windows, macOS, atau Linux

1. Buka `/setup` dan pilih **Mesin baru**.
2. Website mendeteksi sistem operasi. Tekan satu tombol installer yang tampil.
3. Jalankan installer. Controller dan Agent dipasang sebagai service; menutup
   browser tidak menghentikannya.
4. Installer membuka `/setup?code=...`. Kode berlaku 15 menit dan sudah terisi.
5. Isi nama photobox, lokasi, email owner, PIN lokal, dan konfirmasi PIN.
6. Pilih kamera dan printer yang benar-benar terdeteksi, lalu tekan tombol tes.
   Perangkat yang tidak ditemukan tidak boleh ditampilkan sebagai tersambung.
7. Gunakan folder foto default atau pilih folder writable melalui Local Manager.
8. Pilih frame awal atau lewati. Periksa ringkasan, lalu tekan **Mulai gunakan
   photobox**.

Setup menyimpan draft yang tidak mengandung secret dan dapat dilanjutkan setelah
restart. PIN hanya untuk akses lokal; admin dari perangkat lain memakai akun
remote. Jika installer gagal, operator membuka Local Manager dan memilih
**Diagnosis**—Terminal hanya jalur teknisi.

## Tablet

Tablet standalone memakai PWA dan kamera browser. Silent USB printing, service
watchdog, dan kontrol filesystem penuh tidak dijanjikan. Untuk printer dan
storage komputer, gunakan tablet companion dengan QR pairing yang kedaluwarsa.
