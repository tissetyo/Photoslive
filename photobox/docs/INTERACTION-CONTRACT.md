# Kontrak interaksi Photoslive

Dokumen ini adalah acceptance inventory. Sebuah kontrol hanya boleh terlihat
aktif jika memiliki handler, operasi, persistence, loading, sukses, error, dan
disabled state. Kontrol tanpa backend harus disembunyikan oleh feature flag.

## Booth lokal dan publik

| Route/kontrol | Operasi | Persistence dan state wajib |
| --- | --- | --- |
| `/{boothCode}` / Mulai foto | Cache config lalu pindah layar langsung | cache per booth; error dapat dicoba ulang; kamera diperiksa paralel |
| Modal akses QRIS | create payment | loading, QR, paid, timeout, provider tidak tersedia, offline hidden |
| Modal voucher | redeem cloud atau SQLite lokal | atomic, success, used/not found, event expired, disabled saat submit |
| Pilih frame | config/aset cache | thumbnail nyata, selected, pagination, empty/error |
| Lanjutkan | create local session UUID | disabled sampai frame valid; error tanpa menghapus pilihan |
| Capture/retake | local camera endpoint | countdown tiap attempt, timeout sesi, slot kecil tetap di pojok |
| Terima foto | pilih attempt | satu final per slot, lanjut slot berikutnya |
| Print | enqueue lokal | accepted <1 detik, paid-print gate, printer error dapat ditindaklanjuti |
| Selesai/skip | close session/reset | timer 15 detik dan tombol skip |
| `/sesi/{code}` | metadata + file sesi | expiry 24 jam, per-file error, download mentah dan hasil |

## Admin booth

| Area | API sumber kebenaran | Perilaku saat Agent offline |
| --- | --- | --- |
| Tampilan/frame | cloud settings/assets | tetap dapat disimpan; Controller menarik versi nanti |
| Sesi/pembayaran | cloud settings | tetap dapat disimpan; QRIS aktif hanya jika provider siap |
| Voucher/event | cloud vouchers/events | generate/create/print tetap bekerja tanpa Agent |
| Kamera/printer | signed hardware job | disabled atau berstatus menunggu/tidak tersedia |
| Penyimpanan lokal | Local Manager/Controller | remote hanya melihat telemetry terakhir; pilih folder wajib lokal |
| Pengguna | cloud users/roles | tetap bekerja tanpa Agent |
| Audit | cloud audit | tetap bekerja tanpa Agent |

Semua tombol submit harus memakai `disabled` dan `aria-busy` selama request,
memulihkan label setelah selesai, serta menampilkan pesan backend konkret.

## Setup

| Langkah | Wajib | Selesai jika |
| --- | --- | --- |
| Kode setup | ya | kode 15 menit tervalidasi |
| Identitas | nama; lokasi opsional | draft tersimpan dan wizard dapat dilanjutkan |
| Akses owner | email dan PIN | machine diklaim, owner/session cloud dibuat |
| Perangkat/folder | dapat dilewati | nama perangkat nyata tampil; tes memberi hasil nyata |
| Frame | dapat dilewati | pilihan atau editor tersimpan; preview slot nyata |
| Readiness | ya | route booth/admin jelas dan satu primary action |

## Local Manager

Kontrol nyata saat ini: Periksa, Pause, Resume, Restart melalui supervisor,
Diagnosis, Buat kode setup, Pilih folder, buka booth/admin, refresh dan log.
Update Agent disembunyikan sampai update atomik, signature, health check, dan
rollback tersedia.

## Superadmin

Daftar mesin, online/offline, access enable/disable, request pemulihan, dan
telemetry terakhir wajib berasal dari cloud. Restart/update hanya aktif saat
Agent online dan command backend tersedia. Semua mutasi masuk audit log.

