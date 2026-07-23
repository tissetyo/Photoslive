import { now, randomId } from "./_store.mjs";
import { enqueueIncidentAlert } from "./_alert_routing.mjs";

export const FLEET_READY_AFTER_MS = 90_000;
export const FLEET_OFFLINE_AFTER_MS = 180_000;

const incidentIndexKey = "photoslive:fleet:incidents";
const incidentKey = id => `photoslive:fleet:incident:${id}`;
const activeIncidentKey = machineId => `photoslive:machine:${machineId}:active-incident`;

export function machineHealth(machine, atMs = Date.now()) {
  const lastSeenMs = machine?.lastSeenAt ? Date.parse(machine.lastSeenAt) : 0;
  const ageMs = lastSeenMs ? Math.max(0, atMs - lastSeenMs) : null;
  let state = "offline";
  if (ageMs !== null && ageMs < FLEET_READY_AFTER_MS) state = "ready";
  else if (ageMs !== null && ageMs < FLEET_OFFLINE_AFTER_MS) state = "delayed";
  return {
    state,
    ageMs,
    lastSeenAt: machine?.lastSeenAt || null,
    checkedAt: new Date(atMs).toISOString(),
  };
}

async function createOfflineIncident(redis, machine, health) {
  const pointerKey = activeIncidentKey(machine.id);
  let id = await redis.get(pointerKey);
  if (id) {
    const existing = await redis.get(incidentKey(id));
    if (existing) return existing;
    await redis.del(pointerKey);
  }

  id = randomId("incident");
  const acquired = await redis.set(pointerKey, id, { nx: true });
  if (!acquired) {
    const activeId = await redis.get(pointerKey);
    return activeId ? redis.get(incidentKey(activeId)) : null;
  }
  const record = {
    id,
    type: "agent.offline",
    severity: "critical",
    status: "open",
    machineId: machine.id,
    boothCode: machine.boothCode || "",
    organizationId: machine.organizationId || "",
    machineName: machine.name || "Photoslive Booth",
    lastSeenAt: health.lastSeenAt,
    openedAt: now(),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
  };
  await redis.set(incidentKey(id), record);
  await redis.lpush(incidentIndexKey, id);
  await redis.ltrim(incidentIndexKey, 0, 199);
  await enqueueIncidentAlert(redis, record, "fleet.incident.opened").catch(() => null);
  return record;
}

export async function evaluateMachineHealth(redis, machine, atMs = Date.now()) {
  const health = machineHealth(machine, atMs);
  if (health.state === "offline") await createOfflineIncident(redis, machine, health);
  return health;
}

export async function resolveMachineIncident(redis, machine, resolvedAt = now()) {
  const pointerKey = activeIncidentKey(machine.id);
  const id = await redis.get(pointerKey);
  if (!id) return null;
  const record = await redis.get(incidentKey(id));
  if (!record) {
    await redis.del(pointerKey);
    return null;
  }
  const resolved = { ...record, status: "resolved", resolvedAt };
  await redis.set(incidentKey(id), resolved);
  await redis.del(pointerKey);
  await enqueueIncidentAlert(redis, resolved, "fleet.incident.resolved").catch(() => null);
  return resolved;
}

export async function acknowledgeFleetIncident(redis, id, actorId, acknowledgedAt = now()) {
  const record = await redis.get(incidentKey(String(id || "")));
  if (!record) return null;
  if (record.status === "resolved" || record.status === "acknowledged") return { incident: record, changed: false };
  const acknowledged = {
    ...record,
    status: "acknowledged",
    acknowledgedAt,
    acknowledgedBy: String(actorId || "superadmin").slice(0, 160),
  };
  await redis.set(incidentKey(record.id), acknowledged);
  return { incident: acknowledged, changed: true };
}

export async function listFleetIncidents(redis, limit = 100) {
  const ids = await redis.lrange(incidentIndexKey, 0, Math.max(0, Math.min(199, Number(limit || 100) - 1)));
  const records = (await Promise.all(ids.map(id => redis.get(incidentKey(id))))).filter(Boolean);
  return records.sort((a, b) => String(b.openedAt).localeCompare(String(a.openedAt)));
}

export async function evaluateFleetHealth(redis, machines, atMs = Date.now()) {
  const healthRows = await Promise.all(machines.map(async machine => ({
    machineId: machine.id,
    boothCode: machine.boothCode || "",
    machineName: machine.name || "Photoslive Booth",
    accessEnabled: machine.accessEnabled !== false,
    ...(await evaluateMachineHealth(redis, machine, atMs)),
  })));
  const incidents = await listFleetIncidents(redis);
  const activeIncidents = incidents.filter(item => item.status !== "resolved");
  return {
    checkedAt: new Date(atMs).toISOString(),
    summary: {
      total: healthRows.length,
      ready: healthRows.filter(item => item.state === "ready").length,
      delayed: healthRows.filter(item => item.state === "delayed").length,
      offline: healthRows.filter(item => item.state === "offline").length,
      disabled: healthRows.filter(item => !item.accessEnabled).length,
      activeIncidents: activeIncidents.length,
    },
    machines: healthRows,
    incidents,
  };
}
