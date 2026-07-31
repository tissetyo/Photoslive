import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../../../supabase/migrations/20260731211140_admin_agent_status_from_postgres.sql", import.meta.url);

test("Admin Agent status RPC exposes operational state without credentials", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create or replace function public\.photoslive_agent_machine_status/);
  assert.match(sql, /coalesce\(v_record\.snapshot, '\{\}'::jsonb\)/);
  assert.match(sql, /'lastSeenAt', v_record\.last_seen_at/);
  assert.doesNotMatch(sql, /agentTokenHash|commandKey|agent_token_hash|command_key/);
  assert.match(sql, /revoke all on function public\.photoslive_agent_machine_status\(text\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.photoslive_agent_machine_status\(text\) to service_role/);
});
