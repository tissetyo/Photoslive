# Restrukturisasi Produk Photoslive

Dokumen ini menjadi batas implementasi setelah audit route, kontrol, dan backend pada 31 Juli 2026. Tujuannya bukan menghapus fitur penting, tetapi mengurangi duplikasi dan membuat alur utama dapat dijalankan operator nonteknis.

## Alur utama

1. User membuat akun atau masuk melalui `/setup`.
2. Komputer photobox membuka `/setup` dan langsung menampilkan QR pairing berbasis web. Agent belum diasumsikan terpasang.
3. User memindai QR dari ponsel yang sudah login.
4. Setelah pairing berhasil, komputer memilih:
   - **Gunakan versi web** untuk kamera browser dan dialog print.
   - **Install Photoslive Agent** untuk hardware lanjutan, silent print, storage lokal, dan offline queue.
5. Account Admin di `/account-admin` menjadi fleet switcher dan pengaturan akun.
6. Pengaturan setiap photobox tetap berada di `/{boothCode}/admin`.

## Fitur yang wajib dipertahankan

- Editor frame lengkap: slot, layer, sticker/logo, opacity, rotation, scale, preview, dan raster thumbnail.
- Voucher umum sekali pakai dan voucher event.
- QRIS dinamis untuk akses sesi dan print berbayar.
- Aturan sesi, countdown, retake, jumlah slot, dan jumlah cetak.
- Kamera/printer, Agent opsional, storage, folder foto, sync queue, dan print queue.
- Finance, integrations/provider, user/role, audit, maintenance, dan recovery.
- Superadmin fleet, ownership, pairing, provider, finance, dan operational controls.

Fitur di atas tidak boleh dihapus hanya untuk menyederhanakan UI. Penyederhanaan dilakukan dengan grouping, progressive disclosure, readiness checklist, dan satu primary action per layar.

## Bagian yang disederhanakan

| Area | Keputusan |
| --- | --- |
| Setup cloud | Akun + QR pairing web-first. Tidak mengasumsikan Agent sudah ada. |
| Pilihan Agent | Baru tampil setelah pairing; installer berada dalam accordion tertutup. |
| Account Admin | Daftar photobox, tambah/scan QR, pengaturan akun, dan link ke user photobox. |
| Admin pembayaran | Gunakan istilah QRIS dinamis dan bedakan transaksi sesi dengan transaksi print. |
| Mobile admin | Form satu kolom, card list, bottom navigation, dialog full-screen. |

## Bagian legacy yang dikarantina

- Wizard enam langkah yang mencampur instalasi, hardware, frame, dan akun hanya tersedia melalui `?legacy=1` selama masa migrasi.
- Editor frame duplikat di Setup dipertahankan hanya untuk kompatibilitas legacy. Editor utama tetap berada di Admin.
- Teks atau link yang menyuruh semua user menginstal Agent dihapus dari alur utama.

Bagian legacy belum boleh dihapus dari source sampai migrasi mesin lama, rollback, dan pengujian produksi selesai.

## Kontrak capability

| Capability | Web/PWA | Dengan Agent |
| --- | --- | --- |
| Kamera browser | Ya | Ya |
| Printer dialog browser | Ya | Ya |
| Silent print | Tidak | Ya |
| DSLR/gPhoto2 | Tidak | Ya |
| Folder foto lokal terkelola | Terbatas | Ya |
| Offline queue penuh | Terbatas | Ya |

Kontrol yang tidak tersedia harus disabled atau disembunyikan dengan penjelasan. Tidak boleh ada tombol aktif tanpa handler dan backend/local operation nyata.

## Status implementasi saat dokumen dibuat

- Selesai lokal: audit kontrol, fondasi QR pairing web-first, station choice web/Agent, pengaturan password Account Admin, wording QRIS dinamis, dan cache PWA setup.
- Menunggu tindakan eksternal: menjalankan migration `20260731153000_web_pairing_snapshot.sql`, deploy Vercel, dan verifikasi QR claim pada production.
- Belum boleh disebut selesai: penghapusan legacy, physical camera/printer acceptance test, serta end-to-end QRIS production.

## Gate sebelum menghapus code

1. Route pengganti lolos browser E2E pada desktop dan ponsel.
2. Data tetap ada setelah reload/restart.
3. Mesin lama berhasil dimigrasikan dan dapat rollback.
4. Tidak ada import, route, installer, atau dokumentasi yang masih memakai bagian tersebut.
5. Hapus dilakukan dalam perubahan terpisah agar mudah direview dan di-rollback.
