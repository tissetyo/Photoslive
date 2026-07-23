# Observability lokal

Controller menyediakan ringkasan kesehatan ringan untuk operator pada Local
Manager. Fitur ini tidak memasang daemon, database time-series, atau dependency
tambahan sehingga tetap sesuai untuk mini PC RAM 4 GB.

## Data yang tersedia

Endpoint loopback `GET /api/local/metrics` mengembalikan:

- latency rata-rata, p95, dan maksimum request API;
- jumlah dan persentase response error (`status >= 400`);
- maksimal 20 route terberat/bermasalah tanpa menyimpan session ID;
- kedalaman antrean upload dan cetak;
- kegagalan kamera, capture, printer, dan render selama Controller hidup;
- kapasitas disk folder foto beserta alert warning di bawah 20% dan critical di
  bawah 10% atau ketika reserve 2 GB tidak tersedia.

Endpoint memerlukan header `X-Photoslive-Token` dengan installation token lokal.
Local Manager mengambil token melalui surface loopback yang sudah ada. Payload
tidak berisi Agent token, credential provider, isi request, nama file, atau data
pelanggan.

## Batas resource

- Registry request memakai `deque(maxlen=512)` dan tidak tumbuh tanpa batas.
- Hanya metadata method, route yang dinormalisasi, status, latency, dan waktu
  yang berada di memory.
- Route sesi dinormalisasi menjadi `/api/sessions/:id` atau
  `/api/session-files/:id` agar ID pelanggan tidak masuk metrik.
- Local Manager refresh setiap 10 detik; pengambilan disk memakai filesystem
  metadata, bukan scan seluruh pustaka foto.
- Registry kembali kosong setelah Controller restart. Ini disengaja; metrik
  ini adalah alat diagnosis lokal, bukan histori audit.

## State UI

Panel **Kesehatan lokal** menampilkan loading saat refresh, nilai sukses, state
kosong sebelum ada request, state error dengan petunjuk retry, dan menonaktifkan
tombol refresh selama request berlangsung. Error pembacaan antrean ditampilkan
sebagai **Perlu diperiksa**, bukan sebagai antrean nol.

Card **Sistem** berubah warna dan teks ketika storage warning/kritis. Alert ini
lokal dan langsung terlihat operator; alert cloud serta routing eskalasi masih
merupakan pekerjaan terpisah.

## Yang belum dianggap selesai

Implementasi ini belum menutup observability produksi. Alert routing, histori
metrics cloud, status page, incident timeline, serta metrik payment, payout, dan
email masih memerlukan control plane cloud dan acceptance test terpisah.
