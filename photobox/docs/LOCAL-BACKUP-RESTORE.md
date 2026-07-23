# Backup dan restore database lokal

Dokumen ini berlaku untuk database SQLite Controller pada komputer photobox.
Foto tetap berada di folder foto dan tidak disalin ke backup database ini.

## Perilaku otomatis

- Controller membuat satu backup database per hari saat service mulai.
- Backup dibuat dengan SQLite Online Backup API agar konsisten walaupun service
  sedang hidup.
- Setiap backup memiliki manifest, checksum SHA-256, schema version, ukuran,
  waktu, dan alasan pembuatan.
- Maksimal 14 backup disimpan secara default. Nilai dapat diubah melalui
  `PHOTOSLIVE_LOCAL_BACKUP_LIMIT`, tetapi tidak boleh kurang dari tiga.
- Backup manual dan restore hanya tersedia dari Local Manager loopback:
  `http://127.0.0.1:8080/local-agent`.
- Status restore terakhir ditulis atomik ke `restore-status.json`. Agent hanya
  mengirim status, waktu, jumlah, ukuran, alasan, dan schema version yang sudah
  dibatasi ke cloud setiap heartbeat 60 detik. Nama file backup, checksum,
  folder lokal, dan pesan error mentah tidak pernah masuk dashboard fleet.

## Membuat backup manual

1. Buka **Local Manager** pada komputer photobox.
2. Pada **Backup database lokal**, tekan **Buat backup**.
3. Tunggu pesan berhasil dan pastikan backup baru tampil pada daftar.

Endpoint lokal yang digunakan adalah `POST /api/local/backups/create`. Request
wajib membawa installation token lokal dan tidak tersedia dari admin cloud.

## Restore

1. Pastikan tidak ada sesi pelanggan aktif.
2. Buka **Local Manager** dan pilih **Restore** pada backup yang diinginkan.
3. Periksa nama serta tanggal backup.
4. Ketik `RESTORE`, lalu tekan **Restore**.
5. Jalankan **Diagnosis** dan pastikan status database **Siap**.

Sebelum mengganti database yang sehat, Controller membuat backup
`before-restore`. Restore akan dibatalkan jika:

- ada sesi aktif;
- checksum backup berubah;
- SQLite quick check pada backup gagal; atau
- confirmation bukan `RESTORE`.

Jika database aktif sudah rusak, Local Manager tetap dapat dibuka dalam mode
pemulihan. Setelah backup valid dipulihkan, worker background dinyalakan lagi.

## Batas dan pemulihan foto

- Backup database tidak menggantikan upload cloud atau backup folder foto.
- Foto yang belum di-upload tetap dilindungi oleh kebijakan cleanup.
- Safety backup mempertahankan keadaan tepat sebelum restore untuk investigasi.
- Jangan memindahkan atau mengedit file `.db`/`.json` di folder backup secara
  manual. Perubahan checksum membuat restore ditolak.
- Restore drill pada mini PC produksi dan pemulihan setelah SSD rusak masih
  merupakan acceptance gate terpisah.
- Target waktu dan kehilangan data yang diizinkan tercatat di
  `DISASTER-RECOVERY-SLO.md`; target tersebut belum dianggap terpenuhi sebelum
  drill pada hardware selesai.

## Verifikasi teknis

Jalankan:

```sh
python3 -m unittest \
  tests.test_local_first.LocalFirstTests.test_local_database_backup_restore_and_safety_backup \
  tests.test_local_first.LocalFirstTests.test_tampered_backup_is_rejected_without_changing_live_database \
  tests.test_local_first.LocalFirstTests.test_daily_database_backup_is_idempotent_for_the_same_day \
  tests.test_local_first.LocalFirstTests.test_restore_refuses_to_replace_database_with_active_session
```

Test membuktikan round-trip restore, safety backup, checksum rejection, jadwal
harian idempotent, penolakan restore ketika sesi aktif, persistence status
restore, serta redaction telemetry sebelum dikirim ke cloud.
