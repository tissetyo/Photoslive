# Plan, kuota, dan pemakaian provider

Superadmin mengelola allowance gratis dan add-on berbayar melalui endpoint
`provider_economics`. Data di-scope ke global, organisasi, atau photobox dan
tidak menyimpan credential provider.

Setiap entitlement memiliki plan (`free`, `managed`, atau `addon`), metrik,
allowance, add-on, biaya bulanan IDR, dan pilihan hard limit. Pemakaian disimpan
sebagai snapshot bounded maksimal 90 catatan per koneksi. Ringkasan menghitung
nilai terpakai, batas, sisa, persentase, dan status `ready`, `warning`, atau
`exhausted`.

Operasi tulis hanya tersedia untuk role dengan
`platform.integrations.write`; auditor hanya dapat membaca. Perubahan plan dan
snapshot manual masuk audit log. Credential, API key, dan raw provider response
tidak pernah menjadi bagian record economics.

UI superadmin menyediakan loading, empty, error, retry, disabled, success, dan
persisted state. Biaya dan kuota terlihat pada tabel yang sama agar keputusan
upgrade tidak memerlukan membuka credential provider.
