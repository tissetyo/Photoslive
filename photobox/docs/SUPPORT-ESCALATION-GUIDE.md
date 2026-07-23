# Panduan eskalasi support Photoslive

## Prioritas

| Prioritas | Kondisi | Respons awal | Target eskalasi |
|---|---|---:|---|
| P0 | Kebocoran data/secret, pembayaran atau payout ganda, seluruh fleet tidak bisa beroperasi | 10 menit | Security/incident commander segera |
| P1 | Booth tidak dapat menerima sesi, foto berisiko hilang, storage kritis, restore/update gagal | 30 menit | Engineering on-call |
| P2 | Satu perangkat/fitur gagal tetapi booth punya fallback | 4 jam kerja | Product/engineering queue |
| P3 | Pertanyaan, kosmetik, atau improvement tanpa gangguan operasi | 2 hari kerja | Product backlog |

## Triage pertama

1. Catat booth code, lokasi, waktu lokal, versi Agent/Controller, dan correlation
   ID.
2. Periksa fleet health, last seen, incident timeline, queue depth, disk, serta
   provider health tanpa membuka raw secret.
3. Tentukan domain: cloud data, Controller lokal, Agent/sync, hardware, storage,
   payment, payout, atau email.
4. Gunakan tindakan aman pada tabel di bawah. Setiap tindakan sensitif harus
   tercatat di audit log.

## Batas tindakan per role

| Role | Boleh | Tidak boleh |
|---|---|---|
| Operator | periksa/tes perangkat, retry job sendiri, export diagnosis | melihat secret, restore, rollout update |
| Support | membaca status teredaksi, acknowledge incident, memberi panduan | mengubah finance, credential, atau ownership |
| Fleet Admin | restart/retry job, maintenance, rollout yang disetujui | melihat credential/provider secret |
| Integration Admin | test/pause/rotate koneksi provider | mengubah payout atau membership |
| Finance Admin | rekonsiliasi dan payout sesuai maker-checker | remote hardware atau credential mentah |
| Platform Owner | aksi sensitif setelah re-authentication | melewati audit/idempotency/approval |

## Keputusan eskalasi

- **Cloud config/voucher gagal saat Agent offline:** P1/P2 cloud-data. Jangan
  restart Agent karena operasi ini tidak bergantung pada Agent.
- **Capture lokal gagal:** periksa Controller, kamera, disk, dan sesi aktif.
- **Upload tertunda:** jangan hapus file lokal; periksa provider dan dead-letter
  queue, lalu retry bounded.
- **Printer gagal:** pertahankan hasil digital, hentikan paid print bila perlu.
- **Payment pending:** jangan menandai paid manual tanpa bukti provider/webhook.
- **Payout mismatch/dobel:** P0, bekukan batch terkait dan jangan membuat entry
  ledger koreksi sebelum finance review.
- **Dugaan secret bocor:** P0, revoke/rotate dari control plane, simpan audit,
  jangan menyalin secret ke tiket.
- **Database lokal rusak:** hentikan sesi baru, export diagnosis, gunakan restore
  terverifikasi sesuai `LOCAL-BACKUP-RESTORE.md`.

## Paket bukti wajib

- Booth/machine ID dan tenant/organization.
- Waktu mulai/selesai dan timezone.
- Correlation ID, job/session/payment/payout ID yang relevan.
- Status Agent, Controller, cloud, internet, disk, kamera, printer, dan queue.
- Langkah reproduksi dan hasil yang diharapkan/aktual.
- Diagnosis serta log teredaksi.
- Dampak: jumlah booth, sesi, pelanggan, nominal, dan risiko kehilangan data.

Jangan lampirkan password, PIN, cookie, bearer token, signed URL, raw API key,
nomor rekening lengkap, atau bukti identitas pelanggan.

## Penutupan insiden

1. Verifikasi recovery pada booth terdampak, bukan hanya dashboard cloud.
2. Pastikan queue kembali bergerak dan tidak ada duplikasi.
3. Untuk payment/payout, rekonsiliasi provider, ledger, dan laporan bank.
4. Catat akar masalah, tindakan, owner follow-up, dan pencegahan di incident
   timeline.
5. P0/P1 memerlukan review setelah insiden sebelum ditutup.
