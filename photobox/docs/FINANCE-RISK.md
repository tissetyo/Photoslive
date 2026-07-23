# Deteksi risiko finance Photoslive

## Status dan batas

Build ini memiliki deteksi risiko aplikasi yang nyata. Fitur ini membantu
superadmin menghentikan duplikasi finalisasi dan meninjau perubahan sensitif;
fitur ini bukan pengganti KYC, rekonsiliasi bank live, atau fraud engine bank.
Payout production tetap harus digate sampai acceptance provider selesai.

## Rule aktif

| Rule | Severity | Pemicu | Perlindungan |
| --- | --- | --- | --- |
| `payout_account_changed` | High | Versi rekening payout berubah | payout nonfinal dibatalkan, owner diberi alert, kasus persisten dibuat |
| `high_value_payout` | High | Payout baru melewati `FINANCE_HIGH_PAYOUT_IDR`; default Rp10.000.000 | kasus review dibuat tanpa memblokir pencatatan batch |
| `duplicate_transfer_reference` | Critical | Referensi bank sudah dipakai payout lain | finalisasi kedua ditolak atomik dan kasus dibuat |

Ambang payout bernilai tinggi minimal Rp1.000.000. Nilai environment yang kosong,
negatif, desimal, atau tidak valid kembali aman ke default Rp10.000.000.

## Workflow review

1. Finance Admin membuka **Risiko finance** di superadmin, memfilter booth,
   status, atau severity, lalu menekan **Akui** dengan catatan.
2. Investigasi memakai ledger, payout, rekening tersamarkan, bukti transfer, dan
   laporan provider. Secret dan nomor rekening penuh tidak masuk daftar risiko.
3. Platform Owner menekan **Selesaikan**, mengisi catatan dan password aktif.
4. Backend memverifikasi ulang identitas, menyimpan history bounded, menulis
   shadow event PostgreSQL best-effort, lalu mencatat audit.

Fingerprint membuat kejadian berulang menambah `occurrenceCount`, bukan membuat
banjir kasus. Jika kasus yang sudah resolved terjadi lagi, backend membuat kasus
baru agar recurrence tidak hilang.

## Operasional dan respons error

- Daftar dan ringkasan tetap dapat dibaca saat Agent offline karena tersimpan di
  cloud data plane.
- Tombol retry hanya mengulang pembacaan daftar, bukan tindakan payout.
- Marker referensi transfer dibandingkan case-insensitive dan dibackfill dari
  histori paid bounded sebelum referensi baru diklaim.
- Resolve gagal tanpa Platform Owner atau re-authentication; kegagalan tersebut
  juga masuk audit tanpa menyimpan password.
- Jangan resolve kasus critical sebelum laporan bank/provider cocok.

## Bukti otomatis

- `web/tests/finance-risk.test.mjs`
- `web/tests/payout-control.test.mjs`
- `web/tests/interactions.test.mjs`

## Tindakan eksternal yang tetap wajib

- KYC merchant dan rekening withdrawal.
- Rekonsiliasi provider serta bank live dengan selisih nol.
- Acceptance payout sandbox/live dan skenario gagal/chargeback.
- Penetration test serta maker-checker operasional oleh personel berbeda.
