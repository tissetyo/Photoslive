# Known limitations build saat ini

Dokumen ini mencatat batas yang masih nyata agar UI dan operator tidak
menganggap Photoslive sudah melewati production gate.

| Area | Status | Dampak | Mitigasi saat ini | Gate selesai |
| --- | --- | --- | --- | --- |
| PostgreSQL/Auth | Partial | Redis masih primary dan role production belum final | Shadow write opt-in, legacy fallback | cutover, RLS runtime, backup/restore |
| QRIS | Unavailable | Pembayaran online belum boleh dipakai | sembunyikan capability; voucher/free mode | adapter Xendit dan webhook acceptance |
| Tablet standalone | Partial | PWA, kamera browser, capture test, dan dialog print tersedia; tidak ada silent USB print dan background sync tidak dijamin | storage persistence diminta, batas AirPrint/IPP ditampilkan, companion dianjurkan | PWA acceptance iPad/Android nyata |
| Tablet companion | Unavailable | Belum ada handshake lokal aman | gunakan komputer sebagai booth | pairing QR dan reconnect E2E |
| Installer/update | Partial | Installer pilot belum signed/notarized | script teknisi dan OS supervisor | signed package, health check, rollback |
| Printer | Partial | CUPS/IPP path ada tetapi model produksi belum tervalidasi | test page dan actionable error | hardware matrix dan 20-print test |
| Object storage | Partial | Adapter tersedia tetapi credential/provider production belum diuji | fallback legacy maksimal 2 MB | live provider test dan lifecycle |
| Finance/payout/email | Unavailable | Tidak ada ledger, payout, atau delivery production | tidak tampil sebagai kontrol aktif | phase 13–15 exit gate |
| Disaster recovery | Unavailable | Restore drill belum ada | backup sebelum rollout, rollback doc | restore drill dan RPO/RTO |

Temuan baru yang reproducible harus ditambahkan ke matriks capability sebagai
`broken`, diberi regression test, lalu dikembalikan ke `real` atau `partial`
setelah perbaikan terverifikasi. Batas ini tidak boleh disamarkan oleh placeholder
atau pesan sukses optimistis.
