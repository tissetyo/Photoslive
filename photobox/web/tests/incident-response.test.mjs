import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = path => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("production incident runbook defines accountable response and recovery gates", async () => {
  const runbook = await read("docs/INCIDENT-RESPONSE.md");
  for (const evidence of [
    "SEV-1",
    "Incident Commander",
    "Contain",
    "Preserve evidence",
    "Recover",
    "Communicate",
    "Postmortem",
    "maker-checker",
    "Jangan mengedit ledger langsung",
    "Jangan hapus foto unsynced",
    "Minimal setiap kuartal",
  ]) assert.match(runbook, new RegExp(evidence, "i"), `missing incident evidence: ${evidence}`);
  assert.match(runbook, /15 menit/);
  assert.match(runbook, /lima hari kerja/i);
});
