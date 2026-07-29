# Proteksi pengambilalihan pairing

Pairing Photoslive memakai token acak satu kali yang diterbitkan Agent hanya
setelah operator menekan **Hubungkan ke akun**. Token berlaku maksimal 15 menit,
ditampilkan sebagai QR, dan memiliki fallback code `XXXX-XXXX`. Raw token dan
fallback code tidak disimpan di PostgreSQL; server hanya menyimpan hash.
Token bukan `boothCode` atau credential login.

## Kontrol yang aktif

- Hanya claim berstatus `pending` dan belum kedaluwarsa yang dapat diklaim.
- Token dan fallback code hanya dapat digunakan sekali; replay ditolak.
- Claim memakai transaction, unique constraint, dan idempotency key sehingga
  klik ganda tidak membuat booth atau ownership kedua.
- Satu mesin tidak dapat dimiliki dua organization.
- Claim membutuhkan session Owner/Admin yang valid; pairing tidak menerima
  ownership anonim.
- Setelah sukses, status claim menjadi `claimed`, installation credential
  dirotasi, mapping permanen disimpan di cloud dan SQLite lokal.
- Revocation dan reassignment tidak menghapus histori. Reassignment meminta
  re-authentication dan hanya tersedia untuk role platform yang berizin.
- Redis hanya cache opsional; Auth, claim, ownership, dan audit memakai Supabase
  Auth/PostgreSQL sebagai sumber utama.

## Recovery

Jika QR/kode kedaluwarsa, operator memilih **Buat kode baru** pada Local Manager.
Mesin yang sudah paired tidak membuat claim baru sampai pairing dicabut melalui
Admin/Superadmin. Recovery dan pemindahan ownership selalu diaudit.

## Bukti otomatis

`web/tests/setup-contract.test.mjs` memverifikasi bahwa claim hanya dibuat oleh
tindakan operator, registrasi akun tidak membutuhkan installer, dan flow lama
tidak kembali menjadi dependency. Test PostgreSQL/Redis memastikan registrasi
dan login tetap berjalan saat cache Redis habis.
