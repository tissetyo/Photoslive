# Photoslive

Photoslive adalah sistem photobox yang terdiri dari dashboard admin, booth untuk
pelanggan, dan controller hardware ringan untuk mini PC.

Implementasi aktif berada di [`photobox/`](photobox/README.md). Jalankan secara
lokal dengan:

```bash
python3 photobox/server.py
```

Lalu buka:

- Admin: `http://127.0.0.1:8080`
- Booth: `http://127.0.0.1:8080/booth`

## Deployment cloud

Domain HTTPS dapat meminta izin webcam langsung dari browser. Printer, kamera
DSLR/mirrorless, storage, dan monitoring sistem tidak berjalan di Vercel;
perangkat tersebut dikendalikan Photoslive Agent di mini PC melalui job yang
diambil dari cloud.

Baca [`photobox/docs/CLOUD-DEVICE-BRIDGE.md`](photobox/docs/CLOUD-DEVICE-BRIDGE.md)
sebelum deployment. Dokumen itu memuat kontrak pairing, endpoint Agent, mode
offline, keamanan, dan checklist yang harus selesai sebelum deployment dapat
disebut siap hardware produksi.

> Catatan: folder `app/` saat ini masih starter/placeholder dan belum merupakan
> UI Photoslive yang siap diterbitkan ke Vercel.
