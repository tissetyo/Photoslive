import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { hasPlatformPermission } from "../api/_platform_roles.mjs";

const html = readFileSync(new URL("../superadmin.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../superadmin.js", import.meta.url), "utf8");
const platform = readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");

test("superadmin ships no raw database or secret console", () => {
  const client = `${html}\n${script}`;
  assert.doesNotMatch(client, /raw[-_ ]?(sql|database)|sql[-_ ]?console|select\s+\*\s+from/i);
  assert.doesNotMatch(client, /PAYOUT_VAULT_KEYS|PROVIDER_CONNECTION_ENCRYPTION|EMAIL_PAYLOAD_ENCRYPTION|SESSION_SECRET/);
  assert.doesNotMatch(client, /commandKey|agentToken|installationToken/i);
});

test("superadmin mutations use the authenticated platform API or a presigned object upload", () => {
  const fetchTargets = [...script.matchAll(/fetch\(([^,\n]+)/g)].map(match => match[1].trim());
  assert.equal(fetchTargets[0], "`/api/platform?action=${action}`");
  assert.equal(fetchTargets.slice(1).every(target => target === "prepared.upload.url"), true);
  assert.match(platform, /const auth = await authenticate\(redis, request\)/);
  assert.match(platform, /hasPlatformPermission\(auth,/);
});

test("sensitive control-plane mutation families have audit evidence", () => {
  for (const action of [
    "booth.enabled",
    "feature_flag.updated",
    "provider_connection.${result.operation}",
    "finance.policy_updated",
    "payout.marked_paid",
    "platform_staff.invited",
    "booth.ownership_transferred",
    "hardware_job.created",
  ]) assert.equal(platform.includes(action), true, `Audit missing for ${action}`);
});

test("support cannot read finance or mutate integrations, ownership, or remote jobs", () => {
  const support = { role: "superadmin", platformRole: "support" };
  assert.equal(hasPlatformPermission(support, "platform.finance.read"), false);
  assert.equal(hasPlatformPermission(support, "platform.finance.write"), false);
  assert.equal(hasPlatformPermission(support, "platform.integrations.write"), false);
  assert.equal(hasPlatformPermission(support, "platform.ownership.write"), false);
  assert.equal(hasPlatformPermission(support, "platform.remote_jobs.write"), false);
  assert.equal(hasPlatformPermission(support, "platform.recovery.write"), true);
});
