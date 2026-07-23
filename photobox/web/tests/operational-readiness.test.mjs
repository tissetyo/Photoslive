import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readDoc = name => readFileSync(new URL(`../../docs/${name}`, import.meta.url), "utf8");

test("operator runbooks cover local-first recovery without exposing unsafe shortcuts", () => {
  const runbook = readDoc("OPERATOR-RUNBOOKS.md");
  for (const topic of ["Kamera tidak terhubung", "Printer tidak terhubung", "Internet mati", "Disk hampir penuh", "Sesi pelanggan terhenti", "Agent atau Controller bermasalah"]) {
    assert.match(runbook, new RegExp(topic, "i"), `missing operator scenario: ${topic}`);
  }
  assert.match(runbook, /foto[\s\S]{0,100}tidak\s+boleh dihapus/i);
  assert.match(runbook, /Jangan kirim API[\s\S]+installation token/i);
});

test("support escalation guide defines severity, role boundaries, evidence, and closure", () => {
  const guide = readDoc("SUPPORT-ESCALATION-GUIDE.md");
  for (const required of ["P0", "P1", "P2", "P3", "Batas tindakan per role", "Paket bukti wajib", "Penutupan insiden"]) {
    assert.match(guide, new RegExp(required, "i"), `missing support contract: ${required}`);
  }
  assert.match(guide, /config\/voucher gagal saat Agent offline[\s\S]+Jangan\s+restart Agent/i);
  assert.match(guide, /Jangan lampirkan[\s\S]+raw API key/i);
});
