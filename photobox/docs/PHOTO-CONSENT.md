# Persetujuan pemrosesan foto

Tombol **Mulai foto** adalah tindakan afirmatif pelanggan. Teks tepat di layar
welcome menjelaskan bahwa melanjutkan berarti menyetujui pemrosesan foto hanya
untuk sesi tersebut.

Controller menolak pembuatan sesi booth jika request tidak membawa consent
versi aktif. Saat sesi dibuat, SQLite menyimpan:

- waktu persetujuan dari clock Controller;
- versi naskah persetujuan;
- hubungan dengan session ID yang sama dengan capture, hasil frame, dan GIF.

Consent di-reset ketika booth kembali ke welcome dan harus diberikan lagi pada
sesi pelanggan berikutnya. Nilai waktu dari browser tidak dipercaya; browser
hanya mengirim tindakan afirmatif dan versi naskah.

Implementasi ini belum menutup early deletion request atau cloud lifecycle.
Keduanya tetap gate terpisah pada checklist.
