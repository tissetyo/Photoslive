# Dependency dan secret scanning

Pipeline `.github/workflows/quality.yml` memiliki dua gate supply-chain yang
berjalan pada setiap pull request dan push ke `main`.

## Dependency audit

- `npm ci` selalu memakai `web/package-lock.json` dan dilanjutkan dengan
  `npm audit --omit=dev --audit-level=high`.
- Dependency Controller dipin pada `requirements-controller.txt` dan diperiksa
  dengan `pip-audit==2.9.0`.
- Controller memerlukan Python 3.10+ dan Pillow 12.3.0. Pin Pillow dinaikkan
  setelah audit menemukan advisory pada 11.3.0; installer berhenti dengan pesan
  eksplisit bila runtime terlalu lama.
- Temuan severity high/critical menggagalkan job. Dependency tidak boleh
  dinaikkan otomatis oleh CI; perbaikan harus melalui pull request dan regresi.

## Secret scan

- Checkout memakai `fetch-depth: 0` supaya riwayat Git ikut diperiksa.
- Gitleaks Action dipin ke full commit SHA, bukan mutable branch atau floating
  version tag.
- `GITHUB_TOKEN` hanya diberikan kepada action melalui secret context GitHub.
- Secret nyata tidak boleh dimasukkan ke ignore file. False positive hanya boleh
  dikecualikan secara sempit dengan alasan dan review security.

Jika secret benar-benar bocor, menghapus string dari commit terakhir tidak
cukup. Cabut/rotate credential lebih dahulu, periksa audit provider, lalu bersihkan
history melalui prosedur insiden terpisah.

## Verifikasi

- `web/tests/supply-chain.test.mjs` menjaga workflow, full-history scan,
  commit pin, audit command, dan dependency pin agar tidak hilang diam-diam.
- Audit lokal JavaScript: `cd photobox/web && npm audit --omit=dev --audit-level=high`.
- Audit lokal Python: instal versi `pip-audit` yang sama dengan CI lalu jalankan
  `python -m pip_audit -r photobox/requirements-controller.txt`.
