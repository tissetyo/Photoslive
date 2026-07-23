# Matriks status capability Photoslive

Sumber machine-readable ada di
`contracts/product-capabilities.json`. Status berarti:

- **real**: operasi dan persistence nyata tersedia serta memiliki automated
  contract/integration test; masih dapat membutuhkan acceptance hardware.
- **partial**: jalur utama ada, tetapi gate production (credential, hardware,
  role final, installer signed, atau cutover) belum lulus.
- **unavailable**: tidak ada kontrol aktif; capability disembunyikan atau
  dinonaktifkan oleh feature/provider gate.
- **mockup**: kontrol terlihat tetapi tidak memiliki operasi nyata. Target dan
  hasil audit saat ini: **0**.
- **broken**: operasi seharusnya tersedia namun reproducibly gagal. Target dan
  hasil audit build saat ini: **0**; bug perangkat/production baru tetap harus
  ditambahkan saat ditemukan.

## Ringkasan build

| Status | Jumlah | Area utama |
| --- | ---: | --- |
| real | 12 | public/booth cache/voucher/frame/capture/result, admin config/voucher, feature flags, remote jobs |
| partial | 13 | setup komputer, print, device/storage/user admin, Local Manager, fleet, PostgreSQL, object storage, QRIS/settlement dasar, email Resend, installer, observability |
| unavailable | 5 | tablet modes, marketplace, payout, DR |
| mockup | 0 | tidak boleh dirilis |
| broken | 0 | tidak ada known reproducible failure pada automated build |

`real` tidak berarti seluruh phase mature selesai. Contohnya print queue dan
compositor memiliki implementasi nyata, tetapi compatibility model printer
produksi dan soak test tetap menjadi gate terpisah. Daftar detail, source of
truth, gate, dan file bukti harus dibaca dari kontrak JSON agar dokumentasi UI
tidak mengaktifkan fitur hanya karena namanya tersedia.

## Aturan perubahan

1. Capability baru wajib masuk kontrak sebelum kontrol UI diaktifkan.
2. `unavailable` wajib memiliki gate dan tidak boleh memiliki primary action
   aktif.
3. Perubahan `partial` menjadi `real` memerlukan backend/local operation,
   persistence, error states, test, dan dokumentasi.
4. Temuan production yang reproducible dipindah ke `broken` sampai regression
   test serta perbaikannya lulus.
5. Status tidak menggantikan feature flag: kontrak menjelaskan kematangan,
   sedangkan flag mengontrol rollout runtime.
