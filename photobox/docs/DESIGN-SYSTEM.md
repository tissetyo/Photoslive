# Design system Photoslive

Design system ini berlaku untuk admin, setup, Local Manager, superadmin,
customer booth, halaman sesi, dan tablet companion.

## Token inti

- Spacing mengikuti ritme dasar 4 px: 4, 8, 12, 16, 20, 24, 32, dan 40 px.
- Radius komponen berbatas memakai 6 atau 8 px. Bentuk bulat hanya untuk status
  pill, switch, dot, dan elemen fisik yang memang berbentuk bundar.
- Tinggi kontrol utama 48 px dan touch target coarse pointer minimal 48 px.
- Icon tindakan berasal dari SVG bernama semantik di `web/icons`; huruf awal
  atau angka tidak boleh dipakai sebagai pengganti icon.
- Status selalu menggabungkan teks dengan icon/dot dan warna. Warna bukan
  satu-satunya pembeda.

## Komponen

Admin memakai token yang sama untuk panel, input, select, button, modal, toast,
tabel, dan pagination. Setup, superadmin, serta status page dinormalisasi oleh
token platform yang sama. Layout admin memiliki breakpoint 1120, 800, dan 580
px. Booth memiliki layout desktop, portrait, mobile, dan landscape pendek.

## Contrast inti

Pasangan warna berikut wajib memenuhi WCAG AA untuk teks normal:

- `#171a21` pada `#f5f6f8`.
- `#667085` pada `#ffffff`.
- `#ffffff` pada `#171a21`.
- ready `#18794e` pada `#eaf8f1`.
- warning `#8a5a00` pada `#fff7df`.
- danger `#b42336` pada `#fff0f1`.

Kontrak otomatis memeriksa token, responsive rules, icon SVG, status multimodal,
dan contrast inti. Visual regression serta screen-reader acceptance perangkat
nyata tetap merupakan gate terpisah.
