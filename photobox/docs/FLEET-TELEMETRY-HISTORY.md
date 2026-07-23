# Histori telemetry fleet

Cloud menyimpan snapshot kesehatan setiap photobox untuk diagnosis tren tanpa
memperlambat heartbeat atau menambah database time-series baru.

## Kontrak penyimpanan

- Heartbeat tetap menjadi jalur utama dan tidak menunggu histori jika Redis
  histori gagal; kegagalan pencatatan ditangkap terpisah.
- Satu snapshot disimpan maksimal setiap lima menit per mesin.
- List dibatasi 2.016 snapshot, setara tujuh hari pada interval lima menit.
- Key histori memiliki TTL delapan hari agar mesin yang dihapus tidak
  meninggalkan data tanpa batas.
- Snapshot hanya memuat kapasitas/persentase disk dan RAM, state Agent dan
  Controller, serta jumlah kamera/printer. Hostname, folder, token, credential,
  payload device, dan error mentah tidak disimpan.

## Akses superadmin

Endpoint `GET /api/platform?action=telemetry_history&machineId=...&hours=...`
memerlukan permission `platform.fleet.read`. Rentang dibatasi 1–168 jam dan
response maksimal 2.016 snapshot.

Panel **Histori kesehatan mesin** menyediakan pilihan photobox, rentang 6 jam,
24 jam, 3 hari, atau 7 hari, grafik disk/RAM, loading, empty, error, disabled,
dan retry state. Membuka panel tidak memicu heartbeat atau pekerjaan hardware.

## Batas bukti

Implementasi ini membuktikan histori telemetry aplikasi yang bounded. Ia bukan
bukti restore drill hardware, soak test 72 jam, atau observability payment,
payout, dan email. Item tersebut tetap terbuka sampai diuji pada target nyata.
