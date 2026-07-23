# Baseline performa dan kompatibilitas hardware

Photoslive membedakan **probe**, **benchmark sintetis**, dan **acceptance
production**. Deteksi device bukan bukti bahwa capture atau print berulang akan
stabil. Daftar machine-readable berada di
`contracts/hardware-compatibility.json`; `testedDevices` sengaja kosong sampai
hasil pilot perangkat nyata ditandatangani operator.

## Menjalankan probe

```bash
python3 scripts/probe_hardware.py --output /tmp/photoslive-hardware.json
```

Probe hanya membaca OS, CPU, RAM, disk, folder foto, kamera, dan printer. Ia
tidak mengubah pilihan perangkat dan tidak mencetak atau mengambil foto.

## Menjalankan benchmark aman

```bash
python3 scripts/benchmark_local.py --iterations 20 \
  --output /tmp/photoslive-benchmark.json --enforce-targets
```

Seluruh database, voucher, foto sintetis, render, dan print queue benchmark
berada dalam temporary directory. Data produksi dan `data/settings.json` tidak
disentuh. Laporan mencatat p95 save settings, bulk 100 voucher, start session,
capture upload, render, serta enqueue print.

Benchmark ini bukan pengganti cloud p95, kamera nyata, printer fisik, atau soak
test 72 jam. Karena itu Phase 0 tetap terbuka sampai perintah dijalankan pada
mini PC target 4 GB dan acceptance berikut lulus:

1. preview dan 20 capture beruntun;
2. 20 print beruntun dengan ukuran kertas produksi;
3. disconnect/reconnect kamera serta printer;
4. reboot recovery Agent dan Controller;
5. sesi offline, reconnect, dan sinkronisasi;
6. soak 72 jam tanpa memory leak atau antrean berhenti.

## Baseline workspace 22 Juli 2026

Laporan tersimpan di `docs/evidence/local-benchmark-2026-07-22.json`. Pada host
Darwin ARM64 8 GB, 20 iterasi sintetis menghasilkan p95 save settings 5,89 ms,
generate 100 voucher 2,45 ms, start session 5,73 ms, capture upload 12,74 ms,
render 133,04 ms, dan enqueue print 4,12 ms. Seluruh target sintetis lulus.

Laporan secara eksplisit memakai `productionAcceptance: false` dan mencatat
empat area belum terukur: kamera nyata, printer fisik, cloud p95, dan soak 72
jam pada RAM 4 GB. Baseline ini cukup untuk mendeteksi regresi kode lokal, bukan
untuk menutup performance gate produksi.

## Format bukti pilot

Simpan report probe dan benchmark bersama release ID. Catat vendor/model,
driver, firmware, adapter, hasil tiap acceptance, operator, tanggal, serta log
yang telah disensor. Baru setelah itu perangkat boleh ditambahkan ke
`testedDevices` dengan status `passed` atau `failed`; status hasil marketing
seperti “semua kamera” atau “semua printer” tidak diperbolehkan.
