import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260731195039_browser_station_capabilities.sql", import.meta.url);
const readMigration = () => readFile(migrationUrl, "utf8");

test("browser station migration backfills legacy installations without machine-id prefix inference", async () => {
  const sql = await readMigration();
  assert.match(sql, /installation_kind text not null default 'helper'/);
  assert.match(sql, /insert into private\.machine_installations\(machine_id\)[\s\S]*select machine_id from public\.machines[\s\S]*on conflict \(machine_id\) do nothing/);
  assert.match(sql, /machine\.agent_version = 'web-only'/);
  assert.match(sql, /machine\.metadata->>'installationKind' = 'browser'/);
  assert.match(sql, /'print', jsonb_build_object\('mode', 'dialog', 'available', true, 'silent', false\)/);
  assert.doesNotMatch(sql, /left\(machine\.machine_id|machine_id like 'web%'/i);
});

test("browser and Helper credentials remain service-role-only", async () => {
  const sql = await readMigration();
  const rpcNames = [
    "photoslive_register_browser_installation",
    "photoslive_station_bootstrap",
    "photoslive_update_station_capabilities",
    "photoslive_revoke_browser_station",
    "photoslive_machine_runtime",
    "photoslive_set_helper_desired_state",
    "photoslive_create_helper_bootstrap",
    "photoslive_activate_helper",
    "photoslive_update_helper_runtime",
  ];
  for (const name of rpcNames) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([\\s\\S]*?\\) to service_role;`), `${name} service grant`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([\\s\\S]*?\\) from public, anon, authenticated;`), `${name} public revoke`);
  }
  assert.match(sql, /credential_hash text/);
  assert.match(sql, /helper_bootstrap_hash text/);
  assert.doesNotMatch(sql, /station_credential text|helper_bootstrap_token text/i);
});

test("pairing broadcast contains claim status but never a permanent station credential", async () => {
  const sql = await readMigration();
  assert.match(sql, /perform realtime\.send\(/);
  assert.match(sql, /jsonb_build_object\('claimId', new\.id, 'status', new\.status\)/);
  const broadcast = sql.slice(sql.indexOf("private.photoslive_broadcast_machine_claim"), sql.indexOf("drop trigger if exists photoslive_machine_claim_broadcast"));
  assert.doesNotMatch(broadcast, /credential_hash|helper_bootstrap|command_key|agent_token/i);
});
