import { fileURLToPath } from "node:url";
import { getRedis, machineKey, sha256 } from "../api/_store.mjs";
import { persistPostgresBoothDirectory, postgresDirectoryStatus, readPostgresBoothDirectory } from "../api/_postgres_directory.mjs";

const clean = (value, maximum = 120) => String(value ?? "").trim().slice(0, maximum);
const boothCodePattern = /^[a-z0-9][a-z0-9-]{2,63}$/;
const machineIdPattern = /^[A-Za-z0-9._:-]{3,160}$/;

function normalizeBoothCode(value) {
  return clean(value, 64).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function safeLegacyId(value, fallback) {
  const result = clean(value || fallback, 120).replace(/[^A-Za-z0-9._:-]/g, "-");
  return /^[A-Za-z0-9._:-]{3,120}$/.test(result) ? result : fallback;
}

function machineReference(machineId) {
  const value = clean(machineId, 160);
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function directoryInput(machine = {}) {
  const machineId = clean(machine.id, 160);
  const boothCode = normalizeBoothCode(machine.boothCode);
  if (!machine.paired) return { skip: "not_paired" };
  if (!boothCodePattern.test(boothCode)) return { skip: "invalid_booth_code" };
  if (!machineIdPattern.test(machineId)) return { skip: "invalid_machine_id" };
  const fallbackOrganization = `organization-${boothCode}`;
  return {
    input: {
      boothCode,
      machineId,
      organizationLegacyId: safeLegacyId(machine.organizationId, fallbackOrganization),
      organizationName: clean(machine.organizationName || machine.name || "Photoslive", 120),
      name: clean(machine.name || "Photoslive Booth", 120),
      location: clean(machine.location, 120),
      accessEnabled: machine.accessEnabled !== false,
    },
  };
}

async function machineIds(redis, limit) {
  const ids = await redis.smembers("photoslive:machines");
  return [...new Set((Array.isArray(ids) ? ids : []).map(value => clean(value, 160)).filter(Boolean))].sort().slice(0, limit);
}

function matchesSnapshot(input, snapshot) {
  return Boolean(snapshot
    && snapshot.boothCode === input.boothCode
    && snapshot.machineId === input.machineId
    && snapshot.organizationLegacyId === input.organizationLegacyId
    && snapshot.name === input.name
    && snapshot.location === input.location
    && snapshot.accessEnabled === input.accessEnabled);
}

export async function backfillPostgresDirectory({
  redis,
  environment = process.env,
  dryRun = true,
  limit = 5_000,
  fetchImplementation,
} = {}) {
  if (!redis) throw new Error("Redis diperlukan untuk backfill directory");
  const boundedLimit = Math.max(1, Math.min(5_000, Number(limit) || 5_000));
  const status = postgresDirectoryStatus(environment);
  if (!dryRun && (!status.enabled || !status.configured)) throw new Error(status.reason || "PostgreSQL directory belum siap");

  const report = {
    version: 1,
    mode: status.mode,
    dryRun: Boolean(dryRun),
    limit: boundedLimit,
    scanned: 0,
    candidates: 0,
    migrated: 0,
    verified: 0,
    skipped: 0,
    failed: 0,
    mismatched: 0,
    checksumSha256: "",
    issues: [],
  };
  const candidates = [];
  for (const id of await machineIds(redis, boundedLimit)) {
    report.scanned += 1;
    const machine = await redis.get(machineKey(id));
    if (!machine) {
      report.skipped += 1;
      report.issues.push({ machine: machineReference(id), reason: "missing_record" });
      continue;
    }
    const prepared = directoryInput({ ...machine, id: machine.id || id });
    if (!prepared.input) {
      report.skipped += 1;
      report.issues.push({ machine: machineReference(id), reason: prepared.skip });
      continue;
    }
    candidates.push(prepared.input);
  }
  report.candidates = candidates.length;
  report.checksumSha256 = await sha256(JSON.stringify(candidates));
  if (dryRun) return report;

  const options = { environment, fetchImplementation };
  for (const input of candidates) {
    try {
      const persisted = await persistPostgresBoothDirectory(input, options);
      if (!persisted.ok || persisted.skipped) {
        report.failed += 1;
        report.issues.push({ boothCode: input.boothCode, machine: machineReference(input.machineId), reason: clean(persisted.reason || "persist_failed", 160) });
        continue;
      }
      report.migrated += 1;
      const snapshot = await readPostgresBoothDirectory(input.boothCode, options);
      if (matchesSnapshot(input, snapshot)) report.verified += 1;
      else {
        report.mismatched += 1;
        report.issues.push({ boothCode: input.boothCode, machine: machineReference(input.machineId), reason: "snapshot_mismatch" });
      }
    } catch (error) {
      report.failed += 1;
      report.issues.push({ boothCode: input.boothCode, machine: machineReference(input.machineId), reason: clean(error?.message || error, 160) });
    }
  }
  return report;
}

function cliOptions(argv) {
  const apply = argv.includes("--apply");
  const limitArgument = argv.find(value => value.startsWith("--limit="));
  return { dryRun: !apply, limit: limitArgument ? Number(limitArgument.split("=")[1]) : 5_000 };
}

async function main() {
  const report = await backfillPostgresDirectory({ redis: getRedis(), ...cliOptions(process.argv.slice(2)) });
  console.log(JSON.stringify(report, null, 2));
  if (!report.dryRun && (report.failed || report.mismatched || report.verified !== report.candidates)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(JSON.stringify({ error: clean(error?.message || error, 240) }));
    process.exitCode = 1;
  });
}
