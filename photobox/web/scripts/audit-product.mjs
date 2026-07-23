import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const surfaces = [
  ["admin", "app.js"],
  ["booth", "booth.js"],
  ["setup", "setup.js"],
  ["local-agent", "local-agent.js"],
  ["superadmin", "superadmin.js"],
  ["session", "session.js"],
  ["status", "status.js"],
  ["companion", "companion.js"],
];
const inventory = [];
const endpointSources = [
  path.resolve(root, "../server.py"),
  path.join(root, "api/platform.mjs"),
  path.join(root, "api/bridge.mjs"),
];
const endpoints = [...new Set(endpointSources.flatMap(source => {
  const content = fs.readFileSync(source, "utf8");
  return [...content.matchAll(/["'`]((?:\/api\/)[^"'`?${}\s]*)/g)].map(match => match[1]);
}))].sort();
const routes = [
  "/", "/setup", "/:boothCode", "/:boothCode/admin", "/:boothCode/sesi/:sessionCode",
  "/superadmin", "/status", "http://127.0.0.1:8080/booth", "http://127.0.0.1:8080/local-agent",
  "http://<machine-lan-ip>:8081/companion",
];

for (const [surface, scriptName] of surfaces) {
  const html = fs.readFileSync(path.join(root, `${surface}.html`), "utf8");
  const script = fs.readFileSync(path.join(root, scriptName), "utf8");
  const forms = [];
  const formStack = [];
  for (const token of html.matchAll(/<\/?form\b[^>]*>/g)) {
    if (!token[0].startsWith("</")) {
      formStack.push({
        start: token.index,
        id: token[0].match(/\bid="([^"]+)"/)?.[1] || null,
        method: token[0].match(/\bmethod="([^"]+)"/)?.[1]?.toLowerCase() || "get",
      });
    } else {
      const form = formStack.pop();
      if (form) forms.push({ ...form, end: token.index + token[0].length });
    }
  }
  for (const match of html.matchAll(/<(button|input|select|textarea)\b([^>]*)>/g)) {
    const [, tag, attributes] = match;
    const id = attributes.match(/\bid="([^"]+)"/)?.[1] || null;
    const type = attributes.match(/\btype="([^"]+)"/)?.[1] || (tag === "button" ? "button" : tag);
    const disabled = /\bdisabled\b/.test(attributes);
    const dataAttributes = [...attributes.matchAll(/\b(data-[a-z0-9-]+)(?:=|\s|$)/gi)].map(item => item[1]);
    const delegatedAttribute = dataAttributes.find(attribute => script.includes(`[${attribute}]`) || script.includes(attribute)) || null;
    const classNames = attributes.match(/\bclass="([^"]+)"/)?.[1]?.split(/\s+/).filter(Boolean) || [];
    const delegatedClass = classNames.find(className => script.includes(`.${className}`)) || null;
    const ownerForm = forms.find(form => match.index > form.start && match.index < form.end);
    const formOwned = Boolean(ownerForm?.id && script.includes(ownerForm.id));
    const nativeDialogAction = Boolean(
      tag === "button"
      && ownerForm?.method === "dialog"
      && /\bvalue="(?:cancel|default)"/.test(attributes)
    );
    const wired = Boolean((id && script.includes(id)) || delegatedAttribute || delegatedClass || formOwned || nativeDialogAction);
    inventory.push({
      surface,
      line: html.slice(0, match.index).split("\n").length,
      tag,
      type,
      id,
      formId: ownerForm?.id || null,
      wired,
      wiring: id && script.includes(id)
        ? "id"
        : delegatedAttribute
          ? "delegated-attribute"
          : delegatedClass
            ? "delegated-class"
            : formOwned
              ? "form"
              : nativeDialogAction
                ? "native-dialog"
                : null,
      delegatedAttribute,
      delegatedClass,
      disabled,
      classification: wired ? "wired" : disabled ? "unavailable" : "unknown",
    });
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  surfaces: surfaces.length,
  routes: routes.length,
  discoveredEndpointPatterns: endpoints.length,
  controls: inventory.length,
  controlsWithId: inventory.filter(item => item.id).length,
  wiredControls: inventory.filter(item => item.wired).length,
  controlsWithoutId: inventory.filter(item => !item.id).length,
  unwiredControlsWithoutId: inventory.filter(item => !item.id && !item.wired).length,
  explicitUnwiredControls: inventory.filter(item => item.id && !item.wired).map(item => `${item.surface}#${item.id}`),
  unknownControls: inventory.filter(item => item.classification === "unknown").map(item => `${item.surface}:${item.line}:${item.tag}${item.id ? `#${item.id}` : ""}`),
  classifications: Object.fromEntries(["wired", "unavailable", "unknown"].map(classification => [classification, inventory.filter(item => item.classification === classification).length])),
};

console.log(JSON.stringify(process.argv.includes("--summary") ? summary : { summary, routes, endpoints, inventory }, null, 2));
if (summary.explicitUnwiredControls.length || summary.unknownControls.length) process.exitCode = 1;
