# Proteksi CSRF

Seluruh mutasi pada Cloud Platform API melewati validasi origin sebelum body
diproses. Browser dengan `Sec-Fetch-Site: cross-site`, origin berbeda, atau
opaque origin (`null`) menerima HTTP `403`. Request browser same-origin tetap
diterima.

Client non-browser seperti script teknisi yang tidak mengirim header `Origin`
tetap didukung. Perlindungan ini bekerja bersama cookie `SameSite=Lax`,
`HttpOnly`, `Secure`, dan host-only; bukan menggantikannya. API Agent/Controller
memakai installation/scoped token dan tidak memakai cookie admin.

Validasi diterapkan terpusat melalui `web/api/_csrf.mjs`, sebelum handler login,
setup, profil, user, konfigurasi, voucher, atau operasi superadmin dijalankan.
