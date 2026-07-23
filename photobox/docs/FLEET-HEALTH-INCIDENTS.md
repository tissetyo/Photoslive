# Fleet health dan incident timeline

Superadmin membaca health fleet dari heartbeat Agent yang disimpan di cloud.
Implementasi ini tidak berada pada jalur simpan settings, voucher, atau tombol
mulai booth, sehingga Agent offline tidak memblokir operasi data cloud.

## State heartbeat

| State | Umur heartbeat | Tindakan |
| --- | ---: | --- |
| Siap | di bawah 90 detik | tidak ada |
| Terlambat | 90–180 detik | pantau; belum membuat insiden |
| Offline | 180 detik atau belum pernah heartbeat | buat satu insiden aktif |

Satu mesin hanya dapat memiliki satu insiden `agent.offline` aktif. Pemeriksaan
berulang tidak membuat duplikat. Superadmin dapat mengakui insiden; tindakan
tersebut menyimpan actor dan waktu serta masuk ke audit log. Heartbeat baru
menandai insiden aktif sebagai `resolved` tanpa menghapus histori.

Timeline dibatasi 200 record agar Redis dan halaman superadmin tetap ringan.
Record hanya memuat ID mesin, booth code, nama, state, dan timestamp; token
Agent, command key, payload telemetry, serta credential tidak ikut disimpan.

Di halaman yang sama, tabel perangkat menampilkan lokasi, state Agent dan
Controller, versi, last seen, serta ringkasan RAM/disk yang disanitasi. Audit
log global dibatasi pada 100 aktivitas sensitif terbaru dan dapat dimuat ulang
secara independen, sehingga kegagalan audit tidak memblokir status fleet.

## Routing alert

Setiap insiden baru dan pemulihan memasukkan satu delivery terdeduplikasi ke
antrean terpisah. Provider `Monitoring webhook` diatur melalui **Koneksi
provider** superadmin pada scope global, organisasi, atau photobox. Payload
ditandatangani HMAC SHA-256, memakai idempotency key, dan tidak menyimpan URL
atau signing secret pada record delivery.

Pengiriman memiliki timeout lima detik, exponential backoff, maksimal delapan
percobaan, tombol retry manual, dan audit log. Halaman superadmin memproses item
jatuh tempo tanpa menahan render health; cron retensi menjadi fallback harian.
Kegagalan webhook tidak memblokir booth, settings, voucher, heartbeat, atau
recovery Agent.

## Batas implementasi saat ini

- Evaluasi outage dijalankan saat halaman superadmin memeriksa fleet. Heartbeat
  menyelesaikan insiden secara langsung ketika mesin pulih.
- Adapter aktif saat ini adalah webhook generik. Email, Slack, SMS, dan pager
  khusus belum diimplementasikan dan dapat dihubungkan melalui endpoint webhook
  milik sistem monitoring eksternal.
- Tombol **Periksa sekarang** hanya mengambil ulang health cloud. Tombol ini
  tidak me-restart Agent dan aman digunakan saat mesin benar-benar offline.
- Restart/update remote tetap merupakan job hardware terpisah dan tidak boleh
  digabungkan dengan endpoint health.

## Operasi

1. Buka `/superadmin` dan lihat **Kesehatan fleet**.
2. Jika insiden baru muncul, periksa waktu heartbeat terakhir.
3. Klik **Akui** setelah operator mengambil alih diagnosis.
4. Periksa Local Manager pada komputer booth bila mesin dapat diakses.
5. Setelah heartbeat kembali, timeline berubah menjadi **Pulih** otomatis.
