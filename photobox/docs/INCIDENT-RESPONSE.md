# Prosedur respons insiden Photoslive

Dokumen ini adalah runbook produksi untuk insiden cloud, fleet, privasi, dan
keuangan. Semua waktu menggunakan UTC di log dan waktu lokal operator di
komunikasi. Jangan menyalin token, credential, foto pelanggan, atau nomor
rekening lengkap ke tiket, chat, maupun audit note.

## Severity dan target respons

| Severity | Contoh | Acknowledge | Update status | Target pemulihan |
| --- | --- | ---: | ---: | ---: |
| SEV-1 | Kebocoran data/secret, pembayaran ganda, seluruh booth tidak dapat dipakai | 15 menit | 30 menit | 4 jam |
| SEV-2 | Banyak booth offline, upload/print/payment provider gagal luas | 30 menit | 60 menit | 8 jam |
| SEV-3 | Satu booth terganggu dan ada workaround aman | 4 jam | Saat ada perubahan | 2 hari kerja |

Temuan keamanan critical/high selalu diperlakukan minimal sebagai SEV-1 sampai
scope dan risiko terbukti lebih rendah. Risiko keselamatan, privasi, atau
keuangan tidak boleh diturunkan severity-nya hanya agar target terlihat lulus.

## Peran

- **Incident Commander (IC)**: satu orang yang menentukan severity, owner,
  containment, status, dan kapan insiden ditutup.
- **Technical Lead**: diagnosis, mitigasi, rollback, recovery, dan bukti teknis.
- **Communications Lead**: pembaruan operator/pemilik booth serta status page.
- **Security/Privacy Lead**: wajib untuk akses tidak sah, secret, dan foto.
- **Finance Lead**: wajib untuk payment, ledger, refund, chargeback, dan payout.

Satu orang boleh memegang beberapa peran saat tim kecil, tetapi IC tidak boleh
menyetujui sendiri koreksi ledger atau payout produksi.

## Alur wajib

1. **Detect dan record** — buat incident ID, correlation ID, waktu mulai,
   reporter, booth terdampak, versi, dan sumber alarm. Jangan mengubah bukti.
2. **Acknowledge dan classify** — IC ditetapkan, severity dipilih, scope awal
   dicatat, lalu incident timeline di `/superadmin` diakui.
3. **Contain** — nonaktifkan capability/booth yang berisiko menggunakan feature
   flag atau access control. Jangan mematikan Agent jika heartbeat masih
   diperlukan untuk pemulihan.
4. **Preserve evidence** — ekspor log tersanitasi, audit log, job ID, deployment
   ID, checksum, dan snapshot status. Jangan menyimpan raw secret.
5. **Mitigate** — gunakan rollback terdokumentasi atau perubahan paling kecil
   yang dapat diverifikasi. Foto unsynced dan sesi aktif harus dipertahankan.
6. **Recover** — pulihkan service bertahap, jalankan health check, satu sesi
   sintetis, lalu satu sesi perangkat nyata sebelum rollout penuh.
7. **Communicate** — update sesuai tabel severity. Nyatakan dampak, workaround,
   status recovery, dan waktu update berikutnya; jangan berspekulasi.
8. **Close** — hanya setelah monitoring stabil, queue kembali normal, data
   direkonsiliasi, dan owner bisnis/keamanan/finance yang relevan menyetujui.
9. **Postmortem** — untuk SEV-1/2, terbitkan maksimal lima hari kerja berisi
   timeline, root cause, contributing factors, dampak, detection gap, tindakan,
   owner, dan due date. Hindari menyalahkan individu.

## Playbook singkat

### Fleet atau Agent offline

1. Periksa `lastSeenAt`, Controller, internet, disk, dan versi di superadmin.
2. Jangan blokir simpan settings/voucher cloud.
3. Jika Agent masih online, kirim diagnosis/restart sebagai remote job terpisah.
4. Jika Agent mati, arahkan operator ke Local Manager dan OS supervisor.
5. Setelah heartbeat pulih, pastikan sync dan print queue kembali berjalan.

### Privasi atau secret

1. Cabut session/credential terdampak dan pause integration terkait.
2. Pertahankan audit evidence yang sudah disensor; jangan menyebarkan secret.
3. Jalankan penghapusan sesi pelanggan bila diminta dan verifikasi cloud serta
   job lokal selesai.
4. Nilai kewajiban notifikasi dengan penasihat hukum/privasi sebelum komunikasi.

### Payment, ledger, atau payout

1. Pause capability payment/payout yang terdampak tanpa menghentikan booth free
   atau voucher offline.
2. Jangan mengedit ledger langsung. Gunakan adjustment/refund yang dapat diaudit.
3. Rekonsiliasi provider, ledger, settlement batch, dan bukti bank.
4. Payout ganda atau rekening berubah memerlukan Finance Lead dan maker-checker.

### Storage kritis

1. Hentikan sesi baru; izinkan sesi aktif selesai bila reserve masih aman.
2. Jangan hapus foto unsynced.
3. Gunakan cleanup preview sebelum cleanup aktual.
4. Verifikasi folder writable, queue upload, dan reserve minimal sebelum reopen.

## Template update insiden

```text
[INCIDENT-ID] [SEV] [STATUS]
Dampak: ...
Mulai: ...
Scope: ...
Tindakan saat ini: ...
Workaround aman: ...
Update berikutnya: ...
Incident Commander: ...
```

## Drill dan bukti penyelesaian

Minimal setiap kuartal jalankan tabletop untuk satu outage fleet dan satu
insiden payment/privasi. Simpan tanggal, peserta, skenario, waktu acknowledge,
waktu containment, hasil recovery, gap, owner, dan due date. Drill dinyatakan
lulus hanya bila rollback/recovery yang dipilih cocok dengan runbook, secret
tidak muncul di artefak, dan semua tindakan korektif memiliki owner.

Dokumen terkait:

- `FLEET-HEALTH-INCIDENTS.md`
- `RELEASE-ROLLBACK.md`
- `DISASTER-RECOVERY-SLO.md`
- `THREAT-MODEL.md`
- `LOG-REDACTION.md`
