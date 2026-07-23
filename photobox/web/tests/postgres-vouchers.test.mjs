import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  deletePostgresVoucher,
  persistPostgresVoucherBatch,
  persistPostgresVoucherEvent,
  postgresVoucherStatus,
  readPostgresVoucherSnapshot,
  redeemPostgresVoucher,
} from "../api/_postgres_vouchers.mjs";
import { persistVoucherBatch } from "../api/platform.mjs";

const configuredEnvironment = {
  PHOTOSLIVE_POSTGRES_CLOUD_DATA: "primary",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
};

function transactionRedis(log) {
  return {
    multi() {
      const commands = [];
      return {
        set(...args) { commands.push(["set", ...args]); return this; },
        sadd(...args) { commands.push(["sadd", ...args]); return this; },
        incr(...args) { commands.push(["incr", ...args]); return this; },
        async exec() { log.push(...commands, ["exec"]); return commands.map(() => "OK"); },
      };
    },
  };
}

test("PostgreSQL voucher mode is explicit and never enabled by credentials alone", () => {
  assert.equal(postgresVoucherStatus({ ...configuredEnvironment, PHOTOSLIVE_POSTGRES_CLOUD_DATA: "" }).mode, "off");
  assert.equal(postgresVoucherStatus(configuredEnvironment).primary, true);
  assert.equal(postgresVoucherStatus({ PHOTOSLIVE_POSTGRES_CLOUD_DATA: "primary" }).available, false);
});

test("voucher batch uses one bounded service-role RPC without leaking the credential", async () => {
  const requests = [];
  const vouchers = Array.from({ length: 100 }, (_, index) => ({
    code: `CODE-${String(index).padStart(4, "0")}`,
    boothCode: "booth-one",
    eventId: index % 2 ? "event-legacy-one" : null,
    includesPrint: true,
    createdAt: "2026-07-22T00:00:00.000Z",
  }));
  const result = await persistPostgresVoucherBatch({ boothCode: "booth-one", vouchers, correlationId: "corr-vouchers" }, {
    environment: configuredEnvironment,
    async fetchImplementation(url, options) {
      requests.push({ url, options });
      return new Response(JSON.stringify({ version: 12, inserted: 100 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(result, { ok: true, skipped: false, version: 12, inserted: 100 });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/rest\/v1\/rpc\/photoslive_persist_voucher_batch$/);
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.p_vouchers.length, 100);
  assert.equal(body.p_booth_code, "booth-one");
  assert.doesNotMatch(requests[0].options.body, /service-role-test-key/);
});

test("primary mode commits PostgreSQL before refreshing the Redis cache", async () => {
  const commands = [];
  const version = await persistVoucherBatch(transactionRedis(commands), "booth-one", [{ code: "SAFE-0001", boothCode: "booth-one" }], {
    environment: configuredEnvironment,
    async fetchImplementation() {
      assert.equal(commands.length, 0, "Redis must remain untouched until the database transaction succeeds");
      return new Response(JSON.stringify({ version: 31, inserted: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(version, 31);
  assert.deepEqual(commands.map(command => command[0]), ["set", "sadd", "set", "exec"]);
  assert.equal(commands[2][2], 31);
  assert.equal(commands.some(command => command[0] === "incr"), false);
});

test("primary mode fails closed and does not create Redis-only vouchers", async () => {
  const commands = [];
  await assert.rejects(persistVoucherBatch(transactionRedis(commands), "booth-one", [{ code: "SAFE-0002" }], {
    environment: configuredEnvironment,
    fetchImplementation: async () => new Response("database unavailable", { status: 503 }),
  }), error => {
    assert.equal(error.status, 503);
    return true;
  });
  assert.deepEqual(commands, []);
});

test("event, redeem, and delete operations use their service-role RPC contracts", async () => {
  const requests = [];
  const fetchImplementation = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ version: requests.length + 40 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const options = { environment: configuredEnvironment, fetchImplementation };
  const event = await persistPostgresVoucherEvent({
    boothCode: "Booth-One",
    event: {
      id: "event-summer",
      name: "Summer Event",
      expiresAt: "2026-08-01T00:00:00.000Z",
      includesPrint: true,
      createdAt: "2026-07-22T00:00:00.000Z",
    },
  }, options);
  const redeemed = await redeemPostgresVoucher({
    boothCode: "Booth-One",
    code: "safe-0003",
    redeemedAt: "2026-07-22T01:00:00.000Z",
  }, options);
  const deleted = await deletePostgresVoucher({ boothCode: "Booth-One", code: "safe-0004" }, options);

  assert.equal(event.version, 41);
  assert.equal(redeemed.version, 42);
  assert.equal(deleted.version, 43);
  assert.deepEqual(requests.map(request => request.url.split("/").at(-1)), [
    "photoslive_persist_voucher_event",
    "photoslive_redeem_voucher",
    "photoslive_delete_voucher",
  ]);
  assert.equal(requests[0].body.p_booth_code, "booth-one");
  assert.equal(requests[1].body.p_code, "SAFE-0003");
  assert.equal(requests[2].body.p_code, "SAFE-0004");
});

test("primary snapshot restores vouchers and events without Redis", async () => {
  const snapshot = await readPostgresVoucherSnapshot("Booth-One", {
    environment: configuredEnvironment,
    async fetchImplementation(url, options) {
      assert.match(url, /\/rpc\/photoslive_voucher_snapshot$/);
      assert.deepEqual(JSON.parse(options.body), { p_booth_code: "booth-one" });
      return new Response(JSON.stringify({
        version: 17,
        vouchers: [{
          code: "safe-0005",
          boothCode: "booth-one",
          eventId: "event-summer",
          includesPrint: true,
          createdAt: "2026-07-22T00:00:00.000Z",
          redeemedAt: null,
        }],
        events: [{
          id: "event-summer",
          name: "Summer Event",
          expiresAt: "2026-08-01T00:00:00.000Z",
          includesPrint: true,
          createdAt: "2026-07-22T00:00:00.000Z",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(snapshot.version, 17);
  assert.equal(snapshot.vouchers[0].code, "SAFE-0005");
  assert.equal(snapshot.events[0].boothCode, "booth-one");
});

test("versioned voucher operations fail closed on malformed database responses", async () => {
  const result = await deletePostgresVoucher({ boothCode: "booth-one", code: "safe-0006" }, {
    environment: configuredEnvironment,
    fetchImplementation: async () => new Response(JSON.stringify({ deleted: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.reason, /Versi voucher PostgreSQL tidak valid/);
});

test("voucher migration exposes service-role-only transactional functions", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20260722110000_transactional_voucher_batches.sql", import.meta.url), "utf8").toLowerCase();
  assert.match(sql, /for update/);
  assert.match(sql, /jsonb_array_length\(p_vouchers\)/);
  assert.match(sql, /v_requested > 100/);
  assert.match(sql, /on conflict \(booth_id, code\) do nothing/);
  assert.match(sql, /voucher_version = voucher_version \+ 1/);
  assert.match(sql, /revoke all on function public\.photoslive_persist_voucher_batch\(text, jsonb\) from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.photoslive_persist_voucher_batch\(text, jsonb\) to service_role/);
  for (const signature of [
    "photoslive_persist_voucher_event(text, jsonb)",
    "photoslive_delete_voucher(text, text)",
    "photoslive_redeem_voucher(text, text, timestamptz)",
    "photoslive_voucher_snapshot(text)",
  ]) {
    const escaped = signature.replace(/[()]/g, match => `\\${match}`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped} from public, anon, authenticated`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped} to service_role`));
  }
});

test("voucher endpoints expose retryable failure without claiming a partial batch", () => {
  const api = readFileSync(new URL("../api/platform.mjs", import.meta.url), "utf8");
  assert.match(api, /Voucher belum dapat disimpan\. Data belum dibuat; coba lagi setelah koneksi cloud pulih\./);
  assert.match(api, /Voucher belum dapat dibuat\. Tidak ada voucher parsial; silakan coba lagi\./);
  assert.match(api, /retryable: true/);
});
