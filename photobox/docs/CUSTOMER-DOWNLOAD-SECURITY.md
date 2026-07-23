# Keamanan link hasil pelanggan

Halaman `/{boothCode}/sesi/{shareCode}` adalah bearer link: siapa pun yang
memiliki URL dapat membuka hasilnya sampai masa berlaku berakhir. Karena itu
link tidak memakai nomor sesi berurutan atau identifier yang mudah ditebak.

## Kontrak yang diterapkan

- Controller membuat `shareCode` dari UUID v4 utuh (32 karakter hex, 128 bit).
- Cloud hanya menerima kode URL-safe sepanjang 32–100 karakter. Kode pendek,
  karakter tambahan, atau hasil normalisasi diam-diam ditolak.
- Masa berlaku publik adalah maksimum 24 jam sejak metadata pertama berhasil
  disinkronkan ke cloud. Update metadata berikutnya tidak memperpanjangnya.
- TTL metadata, file, dan upload intent mengikuti sisa masa berlaku sesi; upload
  ulang tidak membuat link hidup kembali.
- Endpoint file selalu membaca sesi induk, memeriksa booth, expiry, dan manifest
  file sebelum membaca Redis atau membuat signed object-storage URL.
- Signed URL object storage berlaku lima menit dan response redirect tidak
  boleh disimpan oleh cache publik.
- Link yang salah, file di luar manifest, dan sesi kedaluwarsa memakai response
  generik agar keberadaan file tidak dibocorkan.
- Pelanggan dapat meminta penghapusan permanen melalui dialog konfirmasi pada
  halaman hasil. Cloud menghapus object terlebih dahulu, baru metadata; jika
  provider gagal, metadata retensi tetap disimpan agar penghapusan dapat dicoba
  ulang tanpa kehilangan daftar object.
- Salinan lokal dihapus oleh job `privacy.delete_session` yang ditandatangani
  dan tahan tujuh hari. Permintaan tidak menunggu Agent, sehingga halaman hasil
  tetap responsif ketika mesin sedang offline.
- Sesi kedaluwarsa masuk indeks retensi dan dibersihkan oleh `/api/retention`.
  Jadwal default harian kompatibel dengan baseline Vercel zero-cost; akses
  pelanggan tetap berhenti tepat pada expiry maksimum 24 jam.

## Batas yang disengaja

Link masih dapat diteruskan oleh pelanggan karena produk tidak mewajibkan login
pelanggan. Karena itu link hanya boleh berisi hasil satu sesi, tidak boleh masuk
log analitik penuh, dan tidak boleh digunakan sebagai identifier pembayaran.
Jika record mesin sudah tidak tersedia, cloud tetap dihapus tetapi salinan lokal
mengikuti retensi Controller; status tersebut ditampilkan secara eksplisit.

## Verifikasi

- `web/tests/customer-download-security.test.mjs` menguji entropy minimum,
  penolakan metadata/file setelah expiry, dan pembatasan file berdasarkan
  manifest sesi.
- `web/tests/session-retention.test.mjs` menguji cleanup fisik, retry provider,
  bearer deletion, audit, dan state UI.
- `web/tests/remote-jobs.test.mjs` membuktikan job privasi tetap berlaku tujuh
  hari walau Agent offline.
- `tests.test_local_first` menguji token 32 hex dan penghapusan file, database,
  sync queue, serta print queue lokal secara idempotent.

Konfigurasi operasional dan failure mode dijelaskan di
[`CLOUD-RETENTION.md`](CLOUD-RETENTION.md).
