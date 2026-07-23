# Akun testing lokal

Akun testing hanya aktif ketika Controller dijalankan dengan `PHOTOSLIVE_TEST_MODE=1` dan password testing minimal delapan karakter. Mode ini hanya menerima login dari loopback (`127.0.0.1`/`localhost`) dan tidak membuat akun di production.

Jalankan dari folder `photobox`:

```bash
PHOTOSLIVE_PORT=8082 \
PHOTOSLIVE_COMPANION_ENABLED=0 \
PHOTOSLIVE_TEST_MODE=1 \
PHOTOSLIVE_TEST_BOOTH_CODE=test-booth \
PHOTOSLIVE_TEST_EMAIL=owner@photoslive.test \
PHOTOSLIVE_TEST_PASSWORD=PhotosliveTest2026 \
PHOTOSLIVE_DATA_ROOT=/private/tmp/photoslive-local-test \
python3 server.py
```

Buka `http://127.0.0.1:8082/setup?mode=login&booth=test-booth`, pilih **Email & password**, lalu gunakan:

- Kode photobox: `test-booth`
- Email: `owner@photoslive.test`
- Password: `PhotosliveTest2026`

Data pengaturan, voucher, sesi, dan aset akun ini disimpan di `/private/tmp/photoslive-local-test`, terpisah dari data Controller utama. Banner **TEST MODE** selalu terlihat pada admin agar operator tidak salah mengira data testing sebagai production.

Jangan memasang environment variable testing ini pada deployment production. Tanpa password eksplisit, endpoint login testing mengembalikan `404`.
