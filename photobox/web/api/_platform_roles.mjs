export const PLATFORM_ROLES = Object.freeze([
  "platform_owner",
  "integration_admin",
  "finance_admin",
  "fleet_admin",
  "support",
  "auditor",
]);

export const PLATFORM_PERMISSIONS = Object.freeze([
  "platform.overview.read",
  "platform.audit.read",
  "platform.backend.read",
  "platform.integrations.read",
  "platform.fleet.read",
  "platform.fleet.write",
  "platform.remote_jobs.read",
  "platform.remote_jobs.write",
  "platform.flags.read",
  "platform.flags.write",
  "platform.access.write",
  "platform.recovery.write",
  "platform.integrations.write",
  "platform.finance.read",
  "platform.finance.write",
  "platform.staff.read",
  "platform.staff.write",
  "platform.ownership.write",
]);

const READ_ONLY = [
  "platform.overview.read",
  "platform.audit.read",
  "platform.backend.read",
  "platform.integrations.read",
  "platform.fleet.read",
  "platform.remote_jobs.read",
  "platform.flags.read",
  "platform.staff.read",
];

const ROLE_PERMISSIONS = Object.freeze({
  platform_owner: PLATFORM_PERMISSIONS,
  integration_admin: [...READ_ONLY, "platform.flags.write", "platform.integrations.write"],
  finance_admin: [...READ_ONLY, "platform.finance.read", "platform.finance.write"],
  fleet_admin: [...READ_ONLY, "platform.fleet.write", "platform.remote_jobs.write", "platform.access.write"],
  support: [...READ_ONLY, "platform.fleet.write", "platform.recovery.write"],
  auditor: [...READ_ONLY, "platform.finance.read"],
});

export function normalizePlatformRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return PLATFORM_ROLES.includes(role) ? role : "platform_owner";
}

export function platformPermissions(role) {
  return [...ROLE_PERMISSIONS[normalizePlatformRole(role)]];
}

export function isPlatformSession(auth) {
  return auth?.role === "superadmin";
}

export function hasPlatformPermission(auth, permission) {
  return Boolean(isPlatformSession(auth) && ROLE_PERMISSIONS[normalizePlatformRole(auth.platformRole)]?.includes(permission));
}

export function safePlatformIdentity(auth, email = "") {
  if (!isPlatformSession(auth)) return null;
  const platformRole = normalizePlatformRole(auth.platformRole);
  return {
    id: String(auth.userId || "superadmin"),
    email: String(email || "").trim().toLowerCase(),
    role: "superadmin",
    platformRole,
    permissions: platformPermissions(platformRole),
  };
}
