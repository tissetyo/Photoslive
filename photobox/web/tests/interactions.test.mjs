import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surfaces = [
  ["admin.html", "app.js"],
  ["booth.html", "booth.js"],
  ["setup.html", "setup.js"],
  ["local-agent.html", "local-agent.js"],
  ["superadmin.html", "superadmin.js"],
  ["session.html", "session.js"],
];

test("every explicit button is wired to its surface script", () => {
  const missing = [];
  for (const [htmlName, scriptName] of surfaces) {
    const html = fs.readFileSync(path.join(root, htmlName), "utf8");
    const script = fs.readFileSync(path.join(root, scriptName), "utf8");
    for (const match of html.matchAll(/<button[^>]*\bid="([^"]+)"[^>]*>/g)) {
      if (!script.includes(match[1])) missing.push(`${htmlName}#${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `Kontrol tanpa handler: ${missing.join(", ")}`);
});

test("navigation never uses inert hash links", () => {
  const offenders = surfaces.flatMap(([htmlName]) => {
    const html = fs.readFileSync(path.join(root, htmlName), "utf8");
    return html.includes('href="#"') ? [htmlName] : [];
  });
  assert.deepEqual(offenders, [], `Link tanpa tujuan: ${offenders.join(", ")}`);
});
