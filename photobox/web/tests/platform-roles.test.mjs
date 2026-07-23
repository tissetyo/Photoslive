import assert from "node:assert/strict";
import test from "node:test";
import {
  hasPlatformPermission,
  normalizePlatformRole,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  platformPermissions,
  safePlatformIdentity,
} from "../api/_platform_roles.mjs";

test("platform role registry is explicit and legacy sessions default to owner", () => {
  assert.deepEqual(PLATFORM_ROLES, ["platform_owner", "integration_admin", "finance_admin", "fleet_admin", "support", "auditor"]);
  assert.equal(normalizePlatformRole("unknown"), "platform_owner");
  assert.deepEqual(platformPermissions("platform_owner"), PLATFORM_PERMISSIONS);
  assert.equal(hasPlatformPermission({ role: "superadmin" }, "platform.access.write"), true);
});

test("auditor is read-only and fleet admin cannot mutate integrations or finance", () => {
  const auditor = { role: "superadmin", platformRole: "auditor" };
  assert.equal(hasPlatformPermission(auditor, "platform.audit.read"), true);
  assert.equal(hasPlatformPermission(auditor, "platform.finance.read"), true);
  assert.equal(hasPlatformPermission(auditor, "platform.staff.read"), true);
  assert.equal(hasPlatformPermission(auditor, "platform.staff.write"), false);
  assert.equal(hasPlatformPermission(auditor, "platform.remote_jobs.write"), false);
  assert.equal(hasPlatformPermission(auditor, "platform.access.write"), false);
  const fleet = { role: "superadmin", platformRole: "fleet_admin" };
  assert.equal(hasPlatformPermission(fleet, "platform.remote_jobs.write"), true);
  assert.equal(hasPlatformPermission(fleet, "platform.access.write"), true);
  assert.equal(hasPlatformPermission(fleet, "platform.integrations.write"), false);
  assert.equal(hasPlatformPermission(fleet, "platform.finance.write"), false);
  assert.equal(hasPlatformPermission({ role: "superadmin", platformRole: "support" }, "platform.staff.write"), false);
  assert.equal(hasPlatformPermission({ role: "superadmin", platformRole: "platform_owner" }, "platform.staff.write"), true);
  assert.equal(hasPlatformPermission({ role: "superadmin", platformRole: "platform_owner" }, "platform.ownership.write"), true);
  assert.equal(hasPlatformPermission(fleet, "platform.ownership.write"), false);
});

test("safe platform identity exposes capabilities without credentials", () => {
  const identity = safePlatformIdentity({ userId: "staff-1", role: "superadmin", platformRole: "support", secret: "hidden" }, "SUPPORT@EXAMPLE.COM");
  assert.equal(identity.email, "support@example.com");
  assert.equal(identity.platformRole, "support");
  assert.equal(identity.permissions.includes("platform.recovery.write"), true);
  assert.equal(identity.permissions.includes("platform.remote_jobs.write"), false);
  assert.equal("secret" in identity, false);
});
