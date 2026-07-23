import assert from "node:assert/strict";
import test from "node:test";

import { createQrisPayment } from "../api/_payments.mjs";
import { trackPublicSessionRetention } from "../api/_session_retention.mjs";
import { persistVoucherBatch } from "../api/platform.mjs";

class LoadRedis {
  constructor() {
    this.values = new Map();
    this.lists = new Map();
    this.sets = new Map();
    this.sorted = new Map();
  }
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) {
    const list = this.lists.get(key) || [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }
  async ltrim(key, start, end) {
    this.lists.set(key, (this.lists.get(key) || []).slice(start, end + 1));
    return "OK";
  }
  async sadd(key, ...values) {
    const entries = this.sets.get(key) || new Set();
    values.forEach(value => entries.add(value));
    this.sets.set(key, entries);
    return entries.size;
  }
  async incr(key) {
    const value = Number(this.values.get(key) || 0) + 1;
    this.values.set(key, value);
    return value;
  }
  async zadd(key, ...entries) {
    const values = this.sorted.get(key) || new Map();
    entries.forEach(entry => values.set(entry.member, Number(entry.score)));
    this.sorted.set(key, values);
    return entries.length;
  }
  pipeline() {
    const operations = [];
    const pipeline = {
      set: (key, value, options) => { operations.push(() => this.set(key, value, options)); return pipeline; },
      sadd: (key, ...values) => { operations.push(() => this.sadd(key, ...values)); return pipeline; },
      incr: key => { operations.push(() => this.incr(key)); return pipeline; },
      lpush: (key, value) => { operations.push(() => this.lpush(key, value)); return pipeline; },
      ltrim: (key, start, end) => { operations.push(() => this.ltrim(key, start, end)); return pipeline; },
      exec: async () => Promise.all(operations.map(operation => operation())),
    };
    return pipeline;
  }
  multi() { return this.pipeline(); }
}

const paymentEnvironment = {
  XENDIT_SECRET_KEY: "xnd_development_load_test",
  XENDIT_WEBHOOK_TOKEN: "load-test-webhook-token",
  PHOTOSLIVE_PLATFORM_FEE_BPS: "500",
};

test("bounded load smoke covers voucher, payment, and session metadata paths", async () => {
  const redis = new LoadRedis();
  const startedAt = performance.now();
  const vouchers = Array.from({ length: 1_000 }, (_, index) => ({
    code: `LOAD-${String(index).padStart(6, "0")}`,
    boothCode: "load-booth",
    createdAt: new Date().toISOString(),
    redeemedAt: null,
  }));
  for (let batch = 0; batch < 10; batch += 1) {
    await persistVoucherBatch(redis, "load-booth", vouchers.slice(batch * 100, (batch + 1) * 100));
  }

  let providerCalls = 0;
  const fetchImplementation = async (_url, options) => {
    providerCalls += 1;
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      payment_request_id: `provider-${request.reference_id}`,
      status: "REQUIRES_ACTION",
      actions: [{ descriptor: "QR_STRING", value: `000201010212LOAD${request.reference_id}` }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  for (let index = 0; index < 25; index += 1) {
    await createQrisPayment(redis, {
      boothCode: "load-booth",
      sessionId: `payment-session-${index}`,
      purpose: index % 2 ? "print" : "session",
      amount: 35_000,
      currency: "IDR",
      idempotencyKey: `load-payment-${index}`,
    }, { environment: paymentEnvironment, fetchImplementation });
  }

  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  for (let index = 0; index < 500; index += 1) {
    await trackPublicSessionRetention(redis, {
      boothCode: "load-booth",
      shareCode: String(index).padStart(32, "a"),
      expiresAt,
      files: [],
    });
  }

  const elapsedMs = performance.now() - startedAt;
  assert.equal(redis.sets.get("photoslive:booth:load-booth:vouchers").size, 1_000);
  assert.equal(providerCalls, 25);
  assert.equal(redis.sorted.get("photoslive:public-session-retention").size, 500);
  assert.ok(elapsedMs < 15_000, `load smoke terlalu lambat: ${elapsedMs.toFixed(0)}ms`);
});
