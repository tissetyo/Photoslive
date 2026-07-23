import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backfillPostgresDirectory } from "../scripts/backfill-postgres-directory.mjs";
import { machineKey } from "../api/_store.mjs";

const environment = {
  PHOTOSLIVE_POSTGRES_DIRECTORY: "dual",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-secret-value",
};

class FakeRedis {
  constructor(records = []) {
    this.values = new Map(records.map(record => [machineKey(record.id), structuredClone(record)]));
    this.ids = records.map(record => record.id);
  }
  async smembers(key) { return key === "photoslive:machines" ? [...this.ids].reverse() : []; }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
}

const records = [
  { id: "machine_two", paired: true, boothCode: "booth-two", name: "Booth Two", location: "Lobby", accessEnabled: false },
  { id: "machine_one", paired: true, boothCode: "booth-one", name: "Booth One", location: "Hall", organizationId: "org_one" },
  { id: "machine_idle", paired: false, boothCode: "booth-idle", name: "Idle" },
];

test("directory backfill defaults to a deterministic non-mutating report", async () => {
  let calls = 0;
  const options = { redis: new FakeRedis(records), environment, fetchImplementation: async () => { calls += 1; } };
  const first = await backfillPostgresDirectory(options);
  const second = await backfillPostgresDirectory(options);
  assert.equal(calls, 0);
  assert.equal(first.dryRun, true);
  assert.equal(first.scanned, 3);
  assert.equal(first.candidates, 2);
  assert.equal(first.skipped, 1);
  assert.match(first.checksumSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.checksumSha256, second.checksumSha256);
});

test("apply persists each booth and verifies the database snapshot", async () => {
  const snapshots = new Map();
  const fetchImplementation = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("photoslive_persist_booth_directory")) {
      const snapshot = {
        boothCode: body.p_booth_code,
        machineId: body.p_machine_id,
        organizationId: "00000000-0000-4000-8000-000000000001",
        organizationLegacyId: body.p_organization_legacy_id,
        name: body.p_name,
        location: body.p_location,
        accessEnabled: body.p_access_enabled,
        updatedAt: "2026-07-22T12:00:00.000Z",
      };
      snapshots.set(snapshot.boothCode, snapshot);
      return Response.json(snapshot);
    }
    return Response.json(snapshots.get(body.p_booth_code));
  };
  const report = await backfillPostgresDirectory({ redis: new FakeRedis(records), environment, dryRun: false, fetchImplementation });
  assert.equal(report.candidates, 2);
  assert.equal(report.migrated, 2);
  assert.equal(report.verified, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.mismatched, 0);
});

test("apply reports bounded, redacted failures without leaking credentials", async () => {
  const report = await backfillPostgresDirectory({
    redis: new FakeRedis(records.slice(0, 1)), environment, dryRun: false,
    fetchImplementation: async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
  });
  assert.equal(report.failed, 1);
  assert.equal(report.migrated, 0);
  assert.equal(JSON.stringify(report).includes(environment.SUPABASE_SERVICE_ROLE_KEY), false);
  assert.equal(JSON.stringify(report).includes("machine_two"), false);
  assert.match(report.issues[0].machine, /\.\.\./);
});

test("CLI remains dry-run unless --apply is supplied explicitly", () => {
  const source = readFileSync(new URL("../scripts/backfill-postgres-directory.mjs", import.meta.url), "utf8");
  assert.match(source, /const apply = argv\.includes\("--apply"\)/);
  assert.match(source, /dryRun: !apply/);
  assert.match(source, /report\.verified !== report\.candidates/);
});
