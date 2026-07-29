# Instalasi dan setup nonteknis

Setup utama hanya memiliki tiga langkah dan tidak bergantung pada Redis:

1. **Akun:** buka `/setup`, buat akun dengan email dan password, atau masuk.
   Registrasi tidak memerlukan Agent maupun mesin online. Akun pertama menjadi
   Owner organization dan dapat membuka `/admin` walaupun belum punya photobox.
2. **Hubungkan mesin:** dari Admin pilih **Tambah photobox**, lalu pindai QR atau
   masukkan kode yang sedang ditampilkan Local Manager. Pilih **Siapkan nanti**
   jika perangkat belum tersedia.
3. **Siap:** periksa identitas mesin, organization tujuan, nama/lokasi booth,
   versi service, dan perangkat yang terdeteksi. Konfirmasi menyimpan ownership
   permanen; QR/kode hanya berlaku 15 menit dan tidak dipakai lagi setelah claim.

## Komputer Windows, macOS, atau Linux

1. Instal Photoslive Agent dari tombol sesuai OS pada halaman setup.
2. Installer memasang Controller dan Agent sebagai service dan membuka Local
   Manager. Menutup browser tidak menghentikan service.
3. Pada Local Manager tekan **Hubungkan ke akun**. QR dan kode baru hanya dibuat
   setelah tombol ditekan, bukan melalui polling otomatis.
4. Scan QR dari Admin di ponsel atau salin kode `XXXX-XXXX`.
5. Setelah claim dikonfirmasi, Local Manager menyimpan mapping booth di SQLite
   dan installation credential dirotasi. Reboot atau reconnect tidak meminta
   pairing ulang.
6. Kamera, printer, folder foto, frame, QRIS, dan tes sesi diselesaikan dari
   readiness checklist Admin. Bagian tersebut tidak memblokir pairing.

Jika installer gagal, operator membuka Local Manager dan memilih **Diagnosis**.
Terminal tetap tersedia sebagai jalur teknisi, bukan alur setup utama. PIN tidak
ditampilkan pada setup awal dan hanya dapat diaktifkan kemudian untuk login
lokal.

## Tablet

Tablet standalone memakai PWA dan kamera browser. Silent USB printing, service
watchdog, dan kontrol filesystem penuh tidak dijanjikan. Untuk printer dan
storage komputer, gunakan tablet companion dengan QR pairing yang kedaluwarsa.
