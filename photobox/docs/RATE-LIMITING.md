# Rate Limiting Cloud

Photoslive membatasi endpoint autentikasi dan onboarding yang berisiko disalahgunakan.
Limiter menggunakan counter atomik Redis per window, scope tindakan, identitas
booth/email, dan alamat client yang sudah di-hash SHA-256. Alamat IP dan email
mentah tidak disimpan pada key Redis.

| Tindakan | Batas | Window |
| --- | ---: | ---: |
| Login admin booth | 10 | 60 detik |
| Login superadmin | 5 | 60 detik |
| Bantuan password | 5 | 10 menit |
| Validasi setup code | 20 | 5 menit |
| Klaim/setup booth | 10 | 10 menit |

Request yang melewati batas menerima HTTP `429`, header `Retry-After`, dan pesan
yang langsung ditampilkan oleh UI. Endpoint booth lokal tidak memakai limiter
cloud ini agar capture dan retake offline tetap instan. Redis key otomatis
kedaluwarsa dan tidak berisi credential atau payload request.
