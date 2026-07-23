# Redaksi Log dan Diagnosis

Photoslive menerapkan redaksi sebelum data ditulis atau dikirim sebagai log dan
diagnosis. Implementasi yang sama dipakai oleh Agent dan Controller melalui
`redaction.py`; Cloud API memakai `web/api/_observability.mjs`.

Nilai dengan nama sensitif seperti authorization, cookie, token, secret,
password, PIN/hash, API key, credential, signature, access key, dan command key
diganti dengan `[REDACTED]`. String error juga membersihkan Bearer token, session
cookie, parameter credential, serta signature URL object storage. Struktur log
dibatasi hingga 100 field/item dan delapan tingkat agar payload error tidak
membebani mesin kecil.

Redaksi diterapkan pada:

- structured request/error log Cloud API;
- kegagalan PostgreSQL shadow write;
- file log Agent sebelum persistence;
- request log Controller;
- error dan hasil diagnosis Controller;
- export/tail log Agent dari Local Manager.

Redaksi bukan pengganti larangan mengirim secret ke client. Agent installation
token, session cookie, provider credential, dan signing key tetap hanya berada
di server atau file konfigurasi lokal yang terlindungi.
