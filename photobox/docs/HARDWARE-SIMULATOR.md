# Hardware simulator CI

Photoslive menyediakan simulator perangkat yang hanya aktif bila environment
`PHOTOSLIVE_HARDWARE_SIMULATOR=1`. Simulator melewati fungsi Controller yang
sama dengan perangkat nyata: discovery, camera test/capture, printer test, dan
enqueue lembar tes. Tidak ada fallback simulator pada build produksi.

State kegagalan yang didukung:

- `PHOTOSLIVE_SIM_CAMERA_STATE=connected|busy|disconnected`
- `PHOTOSLIVE_SIM_PRINTER_STATE=connected|error|disconnected`

Jalankan suite terfokus:

```bash
python -m unittest photobox/tests/test_hardware_simulator.py
```

CI memverifikasi kamera berhasil, kamera sibuk, printer berhasil, dan printer
terputus. Hasil simulator **bukan** hardware acceptance. Webcam, gPhoto2,
CUPS/IPP, AirPrint, driver, kabel, dan antrean cetak fisik tetap harus diuji
pada pilot device dan dicatat di compatibility report.
