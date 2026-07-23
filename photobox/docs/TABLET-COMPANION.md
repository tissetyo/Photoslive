# Tablet companion

Status build: **partial**. Pairing dan tes lokal sudah nyata; integrasi tablet
sebagai sumber kamera untuk seluruh alur booth dan acceptance perangkat fisik
belum selesai.

## Alur operator

1. Komputer photobox dan tablet terhubung ke Wi-Fi/LAN yang sama.
2. Buka `http://127.0.0.1:8080/local-agent` pada komputer.
3. Pada panel **Tablet companion**, pilih **Buat QR pairing**.
4. Pindai QR dari tablet dalam lima menit.
5. Tablet menukar token satu-kali dengan sesi lokal 12 jam. QR lama tidak dapat
   dipakai ulang.
6. Tes capture/storage dan printer. Putuskan tablet dari Local Manager jika
   perangkat berganti.

Token pairing berada di URL fragment sehingga tidak masuk request log. Controller
hanya menyimpan hash token. Listener LAN menggunakan port `8081` dan handler
terpisah yang tidak menyediakan settings, Local Manager, session, atau API admin.
Installation token Controller tetap hanya dipakai di loopback.

## Batas yang jujur

- Banyak browser tidak mengizinkan `getUserMedia` melalui alamat HTTP LAN.
  Companion menyediakan input kamera sistem sebagai fallback. Live preview
  lintas perangkat memerlukan trusted local HTTPS atau relay yang belum dibuat.
- Printer dan folder foto tetap berada di komputer. Tablet tidak mendapat akses
  filesystem atau CUPS langsung.
- Pairing bekerja tanpa cloud, tetapi alur sesi booth penuh dengan kamera tablet
  belum dinyatakan production-ready.
- `qrcode==8.2` dipasang bersama Controller. Jika dependency belum ada, Local
  Manager tetap memberi link pairing yang dapat disalin.

## Konfigurasi teknis

- `PHOTOSLIVE_COMPANION_ENABLED=0` menonaktifkan listener LAN.
- `PHOTOSLIVE_COMPANION_PORT=8081` mengubah port.
- `PHOTOSLIVE_COMPANION_PUBLIC_URL=http://alamat-lan:8081` dapat dipakai ketika
  deteksi alamat LAN tidak sesuai.
- Firewall hanya perlu membuka port companion pada jaringan privat yang dipercaya.
  Jangan mempublikasikan port tersebut ke internet.

## Bukti otomatis

- `tests/test_local_first.py` membuktikan claim satu-kali, heartbeat, proteksi
  route Controller, dan penulisan/penghapusan capture uji.
- `web/tests/companion-contract.test.mjs` mengunci batas endpoint, expiry,
  hashing secret, wiring Local Manager, reconnect, serta fallback standalone.
- Uji latency dan printer/storage pada hardware fisik tetap terbuka di checklist.
