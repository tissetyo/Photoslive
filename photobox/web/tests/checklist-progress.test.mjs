import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const photoboxRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function progress(file) {
  const body = fs.readFileSync(path.join(photoboxRoot, file), "utf8");
  const done = (body.match(/^- \[x\]/gm) || []).length;
  const open = (body.match(/^- \[ \]/gm) || []).length;
  return { body, done, open, total: done + open };
}

test("canonical checklist summary matches all 627 checkbox items", () => {
  const checklist = progress("docs/IMPLEMENTATION-CHECKLIST.md");
  assert.equal(checklist.total, 627);
  assert.match(checklist.body, new RegExp(`\\*\\*${checklist.done} dari ${checklist.total} item\\*\\*`));
  assert.match(checklist.body, new RegExp(`\\*\\*${checklist.open} masih terbuka\\*\\*`));
});

test("consolidated tracker summary matches its checkbox items", () => {
  const tracker = progress("docs/MATURE-PRODUCT-TRACKER.md");
  assert.match(tracker.body, new RegExp(`\\*\\*${tracker.done} selesai\\*\\*`));
  assert.match(tracker.body, new RegExp(`\\*\\*${tracker.open} masih\\nterbuka\\*\\*`));
  assert.match(tracker.body, new RegExp(`total \\*\\*${tracker.total} item konsolidasi\\*\\*`));
});

