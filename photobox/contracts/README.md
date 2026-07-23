# Photoslive protocol contracts

Versi protokol aktif adalah **v2**. Agent mengirim
`X-Photoslive-Protocol-Version: 2` dan `protocolVersion: 2` pada heartbeat.
Cloud menerima v1 selama masa migrasi, menolak versi yang lebih baru dengan
HTTP 426, dan selalu mengembalikan versi protokol pada response header.

Perubahan kompatibel menambah field opsional. Perubahan required field,
semantik signature, atau jenis command membuat direktori versi baru. Cloud
wajib mempertahankan dua versi selama staged rollout dan Agent tidak boleh
menjalankan command yang tidak terdapat dalam allowlist lokal.

Kontrak v2:

- `heartbeat.schema.json` untuk Agent → Cloud heartbeat.
- `hardware-job.schema.json` untuk signed Cloud → Agent command.
- `session-sync.schema.json` untuk durable Controller outbox → Agent → Cloud.
- `multipart-checkpoint.schema.json` untuk checkpoint non-secret Agent →
  Controller setelah satu part object storage berhasil.
