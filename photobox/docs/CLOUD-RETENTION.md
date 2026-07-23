# Retensi cloud dan penghapusan foto

## Kebijakan produksi

- Link hasil pelanggan berakhir maksimal 24 jam setelah sesi pertama kali
  didaftarkan ke cloud. Update atau upload ulang tidak memperpanjang expiry.
- Setelah expiry, endpoint metadata dan file langsung menolak akses walaupun
  cleanup fisik belum dijalankan.
- Cleanup fisik berjalan satu kali per hari pada `03:17 UTC` melalui Vercel
  Cron. Dengan jadwal zero-cost ini, object kedaluwarsa dihapus paling lambat
  sekitar 24 jam setelah aksesnya ditutup.
- Provider object storage sebaiknya juga diberi lifecycle rule sebagai lapisan
  pertahanan kedua. Lifecycle bukan pengganti indeks retensi aplikasi.
- Foto yang belum berhasil di-upload tidak ikut cleanup cloud. Di Controller,
  foto unsynced dilindungi dari cleanup berbasis usia.

## Environment

Set `CRON_SECRET` pada environment Production dan Preview yang menjalankan cron.
Vercel mengirim header `Authorization: Bearer <CRON_SECRET>` ke
`GET /api/retention`. Endpoint menolak request jika secret kosong atau salah.

Provider object storage dikonfigurasi sesuai `OBJECT-STORAGE.md`. Credential
tidak pernah dikirim ke browser, Agent, response cleanup, atau audit log.

## Early deletion pelanggan

Pemegang bearer link dapat memilih **Hapus semua foto sekarang** dan harus
mengonfirmasi tindakan destruktif. Urutannya:

1. Cloud membuat job lokal `privacy.delete_session` yang signed, idempotent, dan
   berlaku tujuh hari. Job tetap boleh dibuat ketika akses booth dimatikan.
2. Object storage dihapus lebih dahulu. Kegagalan provider menghasilkan error
   yang dapat dicoba ulang dan record retensi tidak dibuang.
3. Metadata file, metadata sesi, dan indeks retensi dihapus.
4. Agent mengambil job saat online dan Controller menghapus folder sesi, record
   file/sesi, upload queue, serta print queue secara idempotent.
5. Aksi cloud dicatat sebagai `photo_session.deleted_by_customer`; Controller
   menulis event lokal tanpa menyimpan bearer token lengkap.

Early deletion tidak bergantung pada heartbeat dalam request pelanggan. Jika
mesin offline, cloud selesai lebih dahulu dan penghapusan lokal diteruskan saat
Agent kembali sebelum job kedaluwarsa.

## Operasi dan recovery

- Response `207` dari cron berarti sebagian record gagal dibersihkan. Record
  gagal tetap berada pada indeks dan akan dicoba lagi pada run berikutnya.
- Jangan menghapus retention key secara manual sebelum object provider
  mengonfirmasi penghapusan.
- Jika Agent offline lebih dari tujuh hari, operator harus menjalankan cleanup
  lokal dari Controller/Local Manager setelah mesin pulih.
- Verifikasi rutin: jalankan suite `web/tests/session-retention.test.mjs`, cek
  audit log, dan pastikan lifecycle bucket tidak lebih longgar dari kebijakan
  organisasi.
