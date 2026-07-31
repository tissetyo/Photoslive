import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260731214159_postgres_remote_jobs.sql", import.meta.url);

test("Helper command queue is durable and service-role-only", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists private\.agent_jobs/);
  assert.match(sql, /for update skip locked/);
  for (const name of [
    "photoslive_agent_machine_internal",
    "photoslive_enqueue_agent_job",
    "photoslive_claim_agent_job",
    "photoslive_update_agent_job",
    "photoslive_agent_job_status",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}[\\s\\S]{0,180}to service_role`));
  }
  assert.doesNotMatch(sql, /grant execute[\s\S]{0,160}to (anon|authenticated)/);
});

test("production bridge dispatches PostgreSQL jobs before requiring Redis", async () => {
  const bridge = await readFile(new URL("../api/bridge.mjs", import.meta.url), "utf8");
  const postgresDispatch = bridge.indexOf('action === "enqueue_job" && request.method === "POST" && postgresMachineStatus().primary');
  const requiredRedis = bridge.indexOf("const redis = getRedis();", postgresDispatch);
  assert.ok(postgresDispatch > 0);
  assert.ok(requiredRedis > postgresDispatch);
  assert.match(bridge, /readPostgresMachineInternal\(machineId\)/);
  assert.match(bridge, /enqueuePostgresJob\(job\)/);
  assert.match(bridge, /claimPostgresJob\(machine\.id\)/);
  assert.match(bridge, /updatePostgresJob\(machine\.id/);
  assert.match(bridge, /readPostgresJob\(machineId/);
});

test("Helper is active only when both Agent and local Controller are ready", async () => {
  const platform = await readFile(new URL("../api/platform.mjs", import.meta.url), "utf8");
  assert.match(platform, /const controllerReady = reported\.helper\?\.controller\?\.online === true/);
  assert.match(platform, /helper\.actualState === "online" && controllerReady/);
});
