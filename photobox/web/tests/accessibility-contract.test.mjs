import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("every product surface respects the operating-system reduced-motion preference", () => {
  for (const path of ["../styles.css", "../setup.css", "../booth.css", "../local-agent.css", "../platform.css"]) {
    const css = read(path);
    assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, `${path} has no reduced-motion contract`);
    assert.match(css, /animation-duration:\s*\.01ms\s*!important/, `${path} still permits long animation`);
    assert.match(css, /animation-iteration-count:\s*1\s*!important/, `${path} still permits looping animation`);
    assert.match(css, /transition-duration:\s*\.01ms\s*!important/, `${path} still permits long transition`);
  }
});

test("every product surface exposes a visible keyboard focus indicator", () => {
  for (const path of ["../styles.css", "../setup.css", "../booth.css", "../local-agent.css", "../platform.css"]) {
    const css = read(path);
    assert.match(css, /a:focus-visible/, `${path} does not expose focus for links`);
    assert.match(css, /button:focus-visible/, `${path} does not expose focus for buttons`);
    assert.match(css, /input:focus-visible/, `${path} does not expose focus for inputs`);
    assert.match(css, /select:focus-visible/, `${path} does not expose focus for selects`);
    assert.match(css, /summary:focus-visible/, `${path} does not expose focus for disclosures`);
    assert.match(css, /\[tabindex\][\s\S]*?:focus-visible/, `${path} does not cover custom keyboard targets`);
    assert.match(css, /outline:\s*3px\s+solid/, `${path} has no visible focus outline`);
    assert.match(css, /outline-offset:\s*[34]px/, `${path} focus outline is not separated from the control`);
  }
});

test("customer and setup asynchronous errors are announced without moving focus", () => {
  const setup = read("../setup.html");
  const booth = read("../booth.html");
  assert.match(setup, /id="setup-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(setup, /id="tablet-print-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(booth, /id="access-payment-error"[^>]*role="alert"[^>]*aria-atomic="true"/);
  assert.match(booth, /id="access-voucher-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
});

test("every visible form control has an accessible label and each surface has an announcement region", () => {
  const surfaces = ["admin.html", "setup.html", "booth.html", "local-agent.html", "superadmin.html", "session.html", "status.html", "companion.html"];
  for (const name of surfaces) {
    const html = read(`../${name}`);
    for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attributes = match[2];
      const hidden = /\bhidden\b/.test(attributes) || /\bclass="[^"]*\bhidden\b/.test(attributes);
      if (hidden) continue;
      const id = attributes.match(/\bid="([^"]+)"/)?.[1];
      const directlyNamed = /\baria-label(?:ledby)?="[^"]+"/.test(attributes);
      const explicitLabel = id && new RegExp(`<label[^>]*\\bfor="${id}"`).test(html);
      const before = html.slice(Math.max(0, match.index - 1200), match.index);
      const wrapped = before.lastIndexOf("<label") > before.lastIndexOf("</label>");
      assert.ok(directlyNamed || explicitLabel || wrapped, `${name}: ${id || match[1]} has no accessible label`);
    }
    assert.match(html, /aria-live="polite"|role="status"|role="alert"/, `${name} has no asynchronous announcement region`);
  }
});

test("every product surface enforces the readable type and control-size baseline", () => {
  for (const path of ["../styles.css", "../setup.css", "../booth.css", "../local-agent.css", "../platform.css"]) {
    const css = read(path);
    assert.match(css, /body\s*\{\s*font-size:\s*14px;/, `${path} has no 14px readable base type`);
    assert.match(css, /button,[\s\S]*?input:not\(\[type="checkbox"\]\)[\s\S]*?select,[\s\S]*?textarea\s*\{\s*min-height:\s*44px;/, `${path} permits undersized primary controls`);
  }
});

test("coarse-pointer devices receive 48px targets for native and custom controls", () => {
  for (const path of ["../styles.css", "../setup.css", "../booth.css", "../local-agent.css", "../platform.css"]) {
    const css = read(path);
    assert.match(css, /@media\s*\(pointer:\s*coarse\)/, `${path} has no touchscreen contract`);
    assert.match(css, /a\[href\],[\s\S]*?button,[\s\S]*?\[role="button"\][\s\S]*?min-width:\s*48px;\s*min-height:\s*48px;/, `${path} has undersized interactive targets`);
    assert.match(css, /label:has\(input\[type="checkbox"\]\)[\s\S]*?min-height:\s*48px;/, `${path} has undersized checkbox labels`);
  }
});

test("select arrows keep a consistent protected inset on every surface", () => {
  for (const path of ["../styles.css", "../setup.css", "../booth.css", "../local-agent.css", "../platform.css"]) {
    const css = read(path);
    assert.match(css, /select:not\(\[multiple\]\)[\s\S]*?padding-inline-end:\s*48px\s*!important/, `${path} does not reserve enough space for the select arrow`);
    assert.match(css, /background-position:\s*right 16px center\s*!important/, `${path} places the select arrow against the edge`);
    assert.match(css, /background-size:\s*16px\s*!important/, `${path} uses an inconsistent select arrow size`);
  }
});

test("number fields remove native spinner overlays that can cover unit suffixes", () => {
  for (const path of ["../styles.css", "../setup.css", "../booth.css", "../local-agent.css", "../platform.css"]) {
    const css = read(path);
    assert.match(css, /input\[type="number"\][\s\S]*?appearance:\s*textfield/, `${path} still exposes a number spinner overlay`);
    assert.match(css, /::-webkit-inner-spin-button[\s\S]*?display:\s*none/, `${path} still permits WebKit spinner controls over suffix text`);
  }
});
