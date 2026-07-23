import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const adminCss = read("web/styles.css");
const platformCss = read("web/platform.css");
const boothCss = read("web/booth.css");
const adminHtml = read("web/admin.html");
const adminJs = read("web/app.js");
const guide = read("docs/DESIGN-SYSTEM.md");

const luminance = hex => {
  const channels = hex.match(/[a-f0-9]{2}/gi).map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (foreground, background) => {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

test("admin and platform expose the shared 4px spacing, 6-8px radius and 48px control tokens", () => {
  for (const token of ["--space-1: 4px", "--space-2: 8px", "--space-4: 16px", "--radius-sm: 8px", "--radius-md: 8px", "--control-height: 48px"]) assert.match(adminCss, new RegExp(token));
  assert.match(platformCss, /--space-1:4px;--space-2:8px/);
  assert.match(platformCss, /--radius-sm:6px;--radius-md:8px;--control-height:48px/);
  assert.match(adminCss, /dialog \{[^}]+border-radius: var\(--radius-md\)/);
  assert.match(adminCss, /\.asset-pagination button \{[^}]+border-radius: var\(--radius-sm\)/);
});

test("admin and booth have explicit tablet, mobile, portrait and landscape layouts", () => {
  for (const breakpoint of [1120, 800, 580]) assert.match(adminCss, new RegExp(`@media \\(max-width: ${breakpoint}px\\)`));
  assert.match(boothCss, /orientation:portrait/);
  assert.match(boothCss, /orientation:landscape/);
  assert.match(boothCss, /max-width:720px/);
});

test("admin actions use semantic SVG icons and status combines text, icon or dot, and color", () => {
  assert.match(adminHtml, /<img src="\/icons\/layout-dashboard\.svg"/);
  assert.match(adminHtml, /<img src="\/icons\/camera\.svg"/);
  assert.match(adminHtml, /<img src="\/icons\/printer\.svg"/);
  assert.match(adminHtml, /class="status-led"/);
  assert.match(adminHtml, /id="agent-overall-state">BELUM TERHUBUNG/);
  assert.match(adminJs, /agent-overall-state"\)\.textContent = online \? "ONLINE" : "OFFLINE"/);
  assert.match(adminJs, /circle-check\.svg" : "\/icons\/triangle-alert\.svg/);
});

test("core text and semantic status colors meet WCAG AA normal-text contrast", () => {
  for (const [foreground, background] of [
    ["171a21", "f5f6f8"], ["667085", "ffffff"], ["ffffff", "171a21"],
    ["18794e", "eaf8f1"], ["8a5a00", "fff7df"], ["b42336", "fff0f1"],
  ]) assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  assert.match(guide, /Visual regression serta screen-reader acceptance[\s\S]+tetap/);
});
