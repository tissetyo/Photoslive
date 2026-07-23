import assert from "node:assert/strict";
import test from "node:test";

import {
  createLedgerAdjustment,
  createLedgerReconciliationRun,
  createQrisPayment,
  createXenditRefund,
  getPayment,
  getRefund,
  getPaymentReconciliation,
  listPaymentReconciliation,
  listPaymentLedger,
  listLedgerReconciliationRuns,
  paymentStorageKeys,
  probeXendit,
  processXenditWebhook,
  recordManualChargeback,
  recordProviderFee,
  reconcileProviderLedger,
  reconcilePendingPayments,
  refreshQrisPayment,
  reviewLatePayment,
  summarizeLedgerBalance,
} from "../api/_payments.mjs";

class FakeRedis {
  constructor() { this.values = new Map(); this.lists = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async set(key, value, options = {}) {
    if (options.nx && this.values.has(key)) return null;
    this.values.set(key, structuredClone(value));
    return "OK";
  }
  async del(key) { return this.values.delete(key) ? 1 : 0; }
  async lpush(key, value) { const list = this.lists.get(key) || []; list.unshift(value); this.lists.set(key, list); return list.length; }
  async ltrim(key, start, end) { this.lists.set(key, (this.lists.get(key) || []).slice(start, end + 1)); return "OK"; }
  async lrange(key, start, end) { return (this.lists.get(key) || []).slice(start, end + 1); }
  pipeline() {
    const operations = [];
    return {
      lpush: (key, value) => { operations.push(() => this.lpush(key, value)); return this; },
      ltrim: (key, start, end) => { operations.push(() => this.ltrim(key, start, end)); return this; },
      exec: async () => Promise.all(operations.map(operation => operation())),
    };
  }
}

const environment = {
  XENDIT_SECRET_KEY: "xnd_development_secret",
  XENDIT_WEBHOOK_TOKEN: "webhook-secret",
  PHOTOSLIVE_PLATFORM_FEE_BPS: "500",
};

const providerPayment = (status = "REQUIRES_ACTION") => ({
  payment_request_id: "pr-photoslive-1",
  status,
  actions: [{ type: "PRESENT_TO_CUSTOMER", descriptor: "QR_STRING", value: "00020101021226670016COM.NOBUBANK.WWW" }],
});

const providerConnectionRef = Object.freeze({
  providerId: "xendit",
  source: "byo",
  connectionId: "booth:booth-one:xendit",
  credentialVersion: 3,
  credentialFingerprint: "a".repeat(64),
});

test("QRIS intent uses server amount, returns an image, and reuses the pending intent", async () => {
  const redis = new FakeRedis();
  const requests = [];
  const fetchImplementation = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(providerPayment()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const first = await createQrisPayment(redis, {
    boothCode: "booth-one",
    sessionId: "session-one",
    purpose: "session",
    amount: 35_000,
    currency: "IDR",
    providerConnectionRef,
    idempotencyKey: "request-one",
  }, { environment, fetchImplementation });
  assert.equal(first.reused, false);
  assert.equal(first.payment.amount, 35_000);
  assert.equal(first.payment.status, "pending");
  assert.match(first.payment.qrImageUrl, /^data:image\/png;base64,/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.xendit.co/v3/payment_requests");
  assert.equal(requests[0].body.request_amount, 35_000);
  assert.equal(requests[0].body.currency, "IDR");
  assert.equal(requests[0].body.channel_code, "QRIS");
  assert.deepEqual(requests[0].body.channel_properties, { qr_string_type: "DYNAMIC" });
  assert.equal(requests[0].body.metadata.booth_code, "booth-one");
  assert.match(requests[0].options.headers.authorization, /^Basic /);
  assert.ok(!JSON.stringify(first.payment).includes(environment.XENDIT_SECRET_KEY));
  assert.equal(first.payment.providerConnectionRef, undefined);

  const replay = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-one", purpose: "session", amount: 35_000, currency: "IDR",
  }, { environment, fetchImplementation });
  assert.equal(replay.reused, true);
  assert.equal(replay.payment.id, first.payment.id);
  assert.equal(requests.length, 1);
  const stored = await getPayment(redis, first.payment.id);
  assert.deepEqual(stored.providerConnectionRef, providerConnectionRef);
  assert.equal(stored.feeSnapshot.platformFeeBps, 500);
  assert.ok(Date.parse(stored.providerExpiresAt) >= Date.parse(stored.expiresAt));
  assert.equal((await getPaymentReconciliation(redis, first.payment.id)).status, "pending");
});

test("explicit booth fee is snapshotted onto a new payment and does not follow later defaults", async () => {
  const redis = new FakeRedis();
  const localEnvironment = { ...environment };
  const created = await createQrisPayment(redis, {
    boothCode: "booth-fee", sessionId: "session-fee", purpose: "session", amount: 40_000, currency: "IDR", platformFeeBps: 725,
  }, { environment: localEnvironment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  const stored = await getPayment(redis, created.payment.id);
  assert.deepEqual(stored.feeSnapshot, { platformFeeBps: 725, platformFee: 2_900 });
  localEnvironment.PHOTOSLIVE_PLATFORM_FEE_BPS = "900";
  assert.deepEqual((await getPayment(redis, created.payment.id)).feeSnapshot, { platformFeeBps: 725, platformFee: 2_900 });
});

test("QRIS rejects non-IDR and amounts above the provider channel limit before calling Xendit", async () => {
  const redis = new FakeRedis();
  let calls = 0;
  const fetchImplementation = async () => { calls += 1; return new Response("{}", { status: 500 }); };
  await assert.rejects(
    createQrisPayment(redis, {
      boothCode: "booth-one", sessionId: "too-large", purpose: "session", amount: 10_000_001, currency: "IDR",
    }, { environment, fetchImplementation }),
    /Nominal pembayaran QRIS tidak valid/,
  );
  await assert.rejects(
    createQrisPayment(redis, {
      boothCode: "booth-one", sessionId: "wrong-currency", purpose: "session", amount: 35_000, currency: "USD",
    }, { environment, fetchImplementation }),
    /hanya mendukung pembayaran IDR/,
  );
  assert.equal(calls, 0);
});

test("payment status refresh maps Xendit success and throttles repeated provider checks", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "print-one", purpose: "print", amount: 10_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  let checks = 0;
  const refreshed = await refreshQrisPayment(redis, created.payment.id, {
    force: true,
    environment,
    fetchImplementation: async () => { checks += 1; return new Response(JSON.stringify(providerPayment("SUCCEEDED")), { status: 200 }); },
  });
  assert.equal(refreshed.status, "paid");
  assert.ok(refreshed.paidAt);
  assert.ok(refreshed.settlementLedgerId);
  assert.equal((await listPaymentLedger(redis, "booth-one")).length, 1);
  await refreshQrisPayment(redis, created.payment.id, { environment, fetchImplementation: async () => { checks += 1; throw new Error("should not run"); } });
  assert.equal(checks, 1);
});

test("payment status supports provider settlement without duplicating captured ledger", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-settled", sessionId: "session-settled", purpose: "session", amount: 35_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  const refreshed = await refreshQrisPayment(redis, created.payment.id, {
    force: true,
    environment,
    fetchImplementation: async () => new Response(JSON.stringify(providerPayment("SETTLED")), { status: 200 }),
  });
  assert.equal(refreshed.status, "settled");
  assert.ok(refreshed.paidAt);
  assert.ok(refreshed.settlementLedgerId);
  assert.equal((await listPaymentLedger(redis, "booth-settled")).filter(entry => entry.type === "payment_captured").length, 1);
  const replay = await refreshQrisPayment(redis, created.payment.id, {
    force: true,
    environment,
    fetchImplementation: async () => new Response(JSON.stringify(providerPayment("SETTLED")), { status: 200 }),
  });
  assert.equal(replay.status, "settled");
  assert.equal((await listPaymentLedger(redis, "booth-settled")).filter(entry => entry.type === "payment_captured").length, 1);
});

test("Xendit provider probe authenticates without creating a payment or exposing balance", async () => {
  const requests = [];
  const ready = await probeXendit({
    environment,
    fetchImplementation: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ balance: 123_456 }), { status: 200 });
    },
  });
  assert.equal(ready.state, "ready");
  assert.equal(ready.provider, "xendit");
  assert.equal(requests[0].url, "https://api.xendit.co/balance?account_type=CASH&currency=IDR");
  assert.equal(requests[0].options.method, "GET");
  assert.ok(!JSON.stringify(ready).includes("123456"));

  const failed = await probeXendit({ environment, fetchImplementation: async () => new Response(JSON.stringify({ message: "API key invalid" }), { status: 401 }) });
  assert.equal(failed.state, "error");
  assert.match(failed.message, /API key invalid/);
});

test("Xendit webhook validates token and amount, ignores duplicates, and settles ledger once", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-two", purpose: "session", amount: 35_000, currency: "IDR", providerConnectionRef,
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  const payload = {
    event: "payment.capture",
    created: new Date().toISOString(),
    data: { payment_request_id: created.payment.providerPaymentId, payment_id: "payment-provider-1", status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  };
  let resolvedReference = null;
  const runtimeResolver = async input => { resolvedReference = input.providerConnectionRef; return { environment }; };
  await assert.rejects(
    processXenditWebhook(redis, new Request("https://photoslive.test/webhook", { method: "POST", headers: { "x-callback-token": "wrong", "webhook-id": "event-one" } }), payload, { runtimeResolver }),
    /Signature webhook tidak valid/,
  );
  const request = new Request("https://photoslive.test/webhook", { method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "event-one" } });
  const accepted = await processXenditWebhook(redis, request, payload, { runtimeResolver });
  assert.deepEqual(resolvedReference, providerConnectionRef);
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.payment.status, "paid");
  assert.equal(accepted.ledger.gross, 35_000);
  assert.equal(accepted.ledger.platformFee, 1_750);
  assert.equal(accepted.ledger.type, "payment_captured");
  assert.equal(accepted.ledger.providerFee, null);
  assert.equal(accepted.ledger.providerFeeFinal, false);
  assert.equal(accepted.ledger.boothEarning, 33_250);
  assert.equal((await listPaymentLedger(redis, "booth-one")).length, 1);

  const duplicate = await processXenditWebhook(redis, request, payload, { runtimeResolver });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await listPaymentLedger(redis, "booth-one")).length, 1);
  assert.equal((await getPayment(redis, created.payment.id)).status, "paid");
  assert.equal(await redis.get(paymentStorageKeys.providerPaymentKey(created.payment.providerPaymentId)), created.payment.id);
});

test("late payment is preserved, ledgered once, and routed to finance review", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-late", purpose: "session", amount: 35_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  const stored = await getPayment(redis, created.payment.id);
  stored.expiresAt = "2026-01-01T00:00:00.000Z";
  await redis.set(paymentStorageKeys.paymentKey(stored.id), stored);
  const payload = {
    event: "payment.capture",
    created: "2026-01-01T00:01:00.000Z",
    data: { payment_request_id: stored.providerPaymentId, payment_id: "provider-late", status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  };
  const accepted = await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "event-late" },
  }), payload, { runtimeResolver: async () => ({ environment }) });
  assert.equal(accepted.payment.latePayment, true);
  assert.equal(accepted.payment.reviewStatus, "pending");
  assert.equal(accepted.ledger.latePayment, true);
  const reconciliation = await getPaymentReconciliation(redis, stored.id);
  assert.equal(reconciliation.status, "review");
  assert.equal(reconciliation.reason, "late_payment");

  const queue = await listPaymentReconciliation(redis, { status: "review", boothCode: "booth-one" });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].payment.id, stored.id);
  const reviewed = await reviewLatePayment(redis, { paymentId: stored.id, decision: "approved", reviewerId: "finance-admin", note: "Dana terverifikasi di provider" });
  assert.equal(reviewed.reused, false);
  assert.equal(reviewed.payment.reviewStatus, "approved");
  assert.equal(reviewed.payment.reviewedBy, "finance-admin");
  assert.equal(reviewed.reconciliation.status, "resolved");
  assert.equal(reviewed.reconciliation.reviewDecision, "approved");
  assert.equal((await listPaymentReconciliation(redis, { status: "review" })).length, 0);
  const replay = await reviewLatePayment(redis, { paymentId: stored.id, decision: "approved", reviewerId: "finance-admin", note: "Dana terverifikasi di provider" });
  assert.equal(replay.reused, true);
  await assert.rejects(
    reviewLatePayment(redis, { paymentId: stored.id, decision: "rejected", reviewerId: "finance-admin", note: "Keputusan lain" }),
    /tidak memerlukan review|keputusan berbeda/,
  );
});

test("reconciliation worker recovers a missed webhook and invokes persistence callback", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-reconcile", purpose: "session", amount: 35_000, currency: "IDR", providerConnectionRef,
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  const job = await getPaymentReconciliation(redis, created.payment.id);
  job.nextAttemptAt = "2026-01-01T00:00:00.000Z";
  await redis.set(paymentStorageKeys.reconciliationKey(created.payment.id), job);
  const persisted = [];
  let reconciledReference = null;
  const result = await reconcilePendingPayments(redis, {
    limit: 5,
    runtimeResolver: async input => { reconciledReference = input.providerConnectionRef; return { environment }; },
    fetchImplementation: async () => new Response(JSON.stringify(providerPayment("SUCCEEDED")), { status: 200 }),
    onResult: async value => persisted.push(value),
  });
  assert.equal(result.checked, 1);
  assert.equal(result.resolved, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(reconciledReference, providerConnectionRef);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].payment.status, "paid");
  assert.equal(persisted[0].ledger.type, "payment_captured");
  assert.equal(persisted[0].reconciliation.status, "resolved");
});

test("paid webhook rejects a mismatched amount before changing the payment", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-three", purpose: "session", amount: 35_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  const payload = { event: "payment.capture", data: { payment_request_id: created.payment.providerPaymentId, status: "SUCCEEDED", request_amount: 1_000, currency: "IDR" } };
  await assert.rejects(
    processXenditWebhook(redis, new Request("https://photoslive.test/webhook", { method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "event-wrong-amount" } }), payload, { runtimeResolver: async () => ({ environment }) }),
    /Nominal webhook tidak sesuai/,
  );
  assert.equal((await getPayment(redis, created.payment.id)).status, "pending");
});

test("full refund is requested once and finalized idempotently by verified webhook", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-refund", purpose: "session", amount: 35_000, currency: "IDR", providerConnectionRef,
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "refund-capture" },
  }), {
    event: "payment.capture",
    data: { payment_request_id: created.payment.providerPaymentId, payment_id: "py-refund", status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  }, { runtimeResolver: async () => ({ environment }) });

  const refundRequests = [];
  const requested = await createXenditRefund(redis, {
    paymentId: created.payment.id, reason: "REQUESTED_BY_CUSTOMER", requestedBy: "finance-admin",
  }, {
    environment,
    fetchImplementation: async (url, options) => {
      refundRequests.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ id: "rfd-full-1", payment_request_id: created.payment.providerPaymentId, amount: 35_000, currency: "IDR", status: "PENDING" }), { status: 200 });
    },
  });
  assert.equal(requested.reused, false);
  assert.equal(requested.refund.status, "pending");
  assert.equal(refundRequests[0].url, "https://api.xendit.co/refunds");
  assert.equal(refundRequests[0].body.amount, 35_000);
  assert.equal(refundRequests[0].body.payment_request_id, created.payment.providerPaymentId);
  assert.equal(refundRequests[0].body.reason, "REQUESTED_BY_CUSTOMER");
  assert.equal((await createXenditRefund(redis, { paymentId: created.payment.id }, { environment })).reused, true);
  await assert.rejects(createXenditRefund(redis, { paymentId: created.payment.id, amount: 10_000 }, { environment }), /refund penuh/);

  const payload = {
    event: "refund.succeeded",
    data: { id: "rfd-full-1", payment_request_id: created.payment.providerPaymentId, amount: 35_000, currency: "IDR", status: "SUCCEEDED", reason: "REQUESTED_BY_CUSTOMER" },
  };
  const request = new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "refund-succeeded-1" },
  });
  const accepted = await processXenditWebhook(redis, request, payload, { runtimeResolver: async () => ({ environment }) });
  assert.equal(accepted.payment.status, "refunded");
  assert.equal(accepted.refund.status, "succeeded");
  assert.equal(accepted.ledger.type, "refund");
  assert.equal(accepted.ledger.gross, -35_000);
  assert.equal(accepted.ledger.platformFee, -1_750);
  assert.equal(accepted.ledger.boothEarning, -33_250);
  assert.equal((await getRefund(redis, requested.refund.id)).status, "succeeded");
  assert.equal((await listPaymentLedger(redis, "booth-one")).length, 2);
  assert.equal((await processXenditWebhook(redis, request, payload, { runtimeResolver: async () => ({ environment }) })).duplicate, true);
  assert.equal((await listPaymentLedger(redis, "booth-one")).length, 2);
});

test("failed refund keeps payment paid and records provider failure", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-refund-failed", purpose: "print", amount: 10_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "failed-refund-capture" },
  }), { event: "payment.capture", data: { payment_request_id: created.payment.providerPaymentId, status: "SUCCEEDED", request_amount: 10_000, currency: "IDR" } }, { runtimeResolver: async () => ({ environment }) });
  const requested = await createXenditRefund(redis, { paymentId: created.payment.id, reason: "CANCELLATION" }, {
    environment,
    fetchImplementation: async () => new Response(JSON.stringify({ id: "rfd-failed-1", status: "PENDING" }), { status: 200 }),
  });
  const failed = await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "refund-failed-1" },
  }), {
    event: "refund.failed",
    data: { id: "rfd-failed-1", payment_request_id: created.payment.providerPaymentId, amount: 10_000, currency: "IDR", status: "FAILED", reason: "CANCELLATION", failure_code: "REFUND_FAILED" },
  }, { runtimeResolver: async () => ({ environment }) });
  assert.equal(failed.payment.status, "paid");
  assert.equal(failed.refund.status, "failed");
  assert.equal(failed.refund.failureCode, "REFUND_FAILED");
  assert.equal(failed.ledger, null);
  assert.equal((await getRefund(redis, requested.refund.id)).status, "failed");
});

test("refund terminal state cannot regress when provider webhooks arrive out of order", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-refund-order", purpose: "print", amount: 10_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "ordered-capture" },
  }), { event: "payment.capture", data: { payment_request_id: created.payment.providerPaymentId, status: "SUCCEEDED", request_amount: 10_000, currency: "IDR" } }, { runtimeResolver: async () => ({ environment }) });
  await createXenditRefund(redis, { paymentId: created.payment.id }, {
    environment,
    fetchImplementation: async () => new Response(JSON.stringify({ id: "rfd-order-1", status: "PENDING" }), { status: 200 }),
  });
  const succeededPayload = {
    event: "refund.succeeded",
    data: { id: "rfd-order-1", payment_request_id: created.payment.providerPaymentId, amount: 10_000, currency: "IDR" },
  };
  await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "ordered-success" },
  }), succeededPayload, { runtimeResolver: async () => ({ environment }) });
  await assert.rejects(processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "ordered-failure" },
  }), {
    event: "refund.failed",
    data: { id: "rfd-order-1", payment_request_id: created.payment.providerPaymentId, amount: 10_000, currency: "IDR" },
  }, { runtimeResolver: async () => ({ environment }) }), /Status refund final/);
  assert.equal((await getPayment(redis, created.payment.id)).status, "refunded");
  assert.equal((await listPaymentLedger(redis, "booth-one")).length, 2);
});

test("confirmed provider chargeback creates one compensating ledger entry and cannot be refunded", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-chargeback", purpose: "session", amount: 35_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(redis, new Request("https://photoslive.test/api/payment", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "chargeback-capture" },
  }), {
    event: "payment.capture",
    data: { payment_request_id: created.payment.providerPaymentId, payment_id: "py-chargeback", status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  }, { runtimeResolver: async () => ({ environment }) });

  const first = await recordManualChargeback(redis, {
    paymentId: created.payment.id,
    providerChargebackId: "dispute-provider-001",
    disputedAt: new Date(Date.now() - 60_000).toISOString(),
    reason: "Cardholder dispute confirmed in Xendit dashboard",
    recordedBy: "finance-user",
  });
  assert.equal(first.reused, false);
  assert.equal(first.payment.status, "chargeback");
  assert.equal(first.ledger.type, "chargeback");
  assert.equal(first.ledger.gross, -35_000);
  assert.equal(first.ledger.platformFee, -1_750);
  assert.equal(first.ledger.boothEarning, -33_250);

  const replay = await recordManualChargeback(redis, {
    paymentId: created.payment.id,
    providerChargebackId: "dispute-provider-001",
    disputedAt: first.chargeback.disputedAt,
    reason: "Cardholder dispute confirmed in Xendit dashboard",
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.ledger.id, first.ledger.id);
  assert.equal((await listPaymentLedger(redis, "booth-one")).filter(entry => entry.type === "chargeback").length, 1);
  await assert.rejects(createXenditRefund(redis, { paymentId: created.payment.id }, { environment }), /Hanya pembayaran berhasil/);
});

test("chargeback replay is recovered from durable storage after Redis expiry", async () => {
  const sourceRedis = new FakeRedis();
  const created = await createQrisPayment(sourceRedis, {
    boothCode: "booth-one", sessionId: "session-chargeback-durable", purpose: "print", amount: 10_000, currency: "IDR",
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(sourceRedis, new Request("https://photoslive.test/api/payment", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "durable-chargeback-capture" },
  }), {
    event: "payment.capture",
    data: { payment_request_id: created.payment.providerPaymentId, payment_id: "py-durable-chargeback", status: "SUCCEEDED", request_amount: 10_000, currency: "IDR" },
  }, { runtimeResolver: async () => ({ environment }) });
  const recorded = await recordManualChargeback(sourceRedis, {
    paymentId: created.payment.id, providerChargebackId: "dispute-durable-001",
    disputedAt: new Date(Date.now() - 60_000).toISOString(), reason: "Confirmed dispute",
  });
  const durablePayment = structuredClone(recorded.payment);
  const durableChargeback = structuredClone(recorded.record);
  delete durablePayment.chargebackLedgerId;

  const recoveredRedis = new FakeRedis();
  const replay = await recordManualChargeback(recoveredRedis, {
    paymentId: created.payment.id, providerChargebackId: "dispute-durable-001",
    disputedAt: durableChargeback.disputedAt, reason: "Confirmed dispute",
  }, {
    paymentResolver: async () => durablePayment,
    chargebackResolver: async () => durableChargeback,
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.chargeback.id, recorded.chargeback.id);
  assert.equal((await getPayment(recoveredRedis, created.payment.id)).status, "chargeback");
  assert.equal((await listPaymentLedger(recoveredRedis, "booth-one")).filter(entry => entry.type === "chargeback").length, 1);
});

test("finance adjustment appends one immutable correction and rejects conflicting replay", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-adjustment", purpose: "session", amount: 35_000, currency: "IDR", providerConnectionRef,
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(redis, new Request("https://photoslive.test/api/platform?action=xendit_webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "adjustment-capture" },
  }), {
    event: "payment.capture",
    data: { payment_request_id: created.payment.providerPaymentId, payment_id: "py-adjustment", status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  }, { runtimeResolver: async () => ({ environment }) });

  const first = await createLedgerAdjustment(redis, {
    paymentId: created.payment.id, amount: -5_000, reference: "ticket-1001", reason: "Koreksi biaya operasional", createdBy: "finance-one",
  });
  assert.equal(first.reused, false);
  assert.equal(first.ledger.type, "adjustment");
  assert.equal(first.ledger.gross, 0);
  assert.equal(first.ledger.platformFee, 0);
  assert.equal(first.ledger.boothEarning, -5_000);
  assert.equal(first.ledger.adjustmentReference, "ticket-1001");

  const replay = await createLedgerAdjustment(redis, {
    paymentId: created.payment.id, amount: -5_000, reference: "ticket-1001", reason: "Koreksi biaya operasional", createdBy: "finance-two",
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.ledger.id, first.ledger.id);
  assert.equal((await listPaymentLedger(redis, "booth-one")).filter(entry => entry.type === "adjustment").length, 1);
  await assert.rejects(createLedgerAdjustment(redis, {
    paymentId: created.payment.id, amount: 5_000, reference: "ticket-1001", reason: "Koreksi berbeda",
  }), /Referensi koreksi sudah digunakan/);
});

test("provider fee finalization is append-only, idempotent, and releases captured balance", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-provider-fee", purpose: "session", amount: 35_000, currency: "IDR", providerConnectionRef,
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(redis, new Request("https://photoslive.test/api/platform?action=xendit_webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "provider-fee-capture" },
  }), {
    event: "payment.capture",
    data: { payment_request_id: created.payment.providerPaymentId, payment_id: "py-provider-fee", status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  }, { runtimeResolver: async () => ({ environment }) });

  const before = summarizeLedgerBalance(await listPaymentLedger(redis, "booth-one"));
  assert.equal(before.pendingBalance, 33_250);
  assert.equal(before.availableBalance, 0);
  const finalized = await recordProviderFee(redis, {
    paymentId: created.payment.id, amount: 250, reference: "settlement-2026-07-21", recordedBy: "finance-one",
  });
  assert.equal(finalized.reused, false);
  assert.equal(finalized.ledger.type, "provider_fee");
  assert.equal(finalized.ledger.providerFee, 250);
  assert.equal(finalized.ledger.providerFeeFinal, true);
  assert.equal(finalized.ledger.boothEarning, -250);

  const after = summarizeLedgerBalance(await listPaymentLedger(redis, "booth-one"));
  assert.equal(after.pendingBalance, 0);
  assert.equal(after.availableBalance, 33_000);
  assert.equal(after.totalBalance, 33_000);
  assert.equal(after.providerFee, 250);
  assert.equal(after.provisionalEntryCount, 0);

  const replay = await recordProviderFee(redis, {
    paymentId: created.payment.id, amount: 250, reference: "settlement-2026-07-21", recordedBy: "finance-two",
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.ledger.id, finalized.ledger.id);
  assert.equal((await listPaymentLedger(redis, "booth-one")).filter(entry => entry.type === "provider_fee").length, 1);
  await assert.rejects(recordProviderFee(redis, {
    paymentId: created.payment.id, amount: 300, reference: "settlement-other",
  }), /sudah difinalisasi dengan data berbeda/);
});

test("ledger balance projection keeps provisional provider entries pending and adjustments available", () => {
  const records = [
    { id: "ledger-capture", currency: "IDR", type: "payment_captured", gross: 35_000, platformFee: 1_750, providerFee: null, providerFeeFinal: false, boothEarning: 33_250, createdAt: "2026-07-21T10:00:00.000Z" },
    { id: "ledger-adjustment", currency: "IDR", type: "adjustment", gross: 0, platformFee: 0, providerFee: null, providerFeeFinal: false, boothEarning: -5_000, createdAt: "2026-07-21T10:01:00.000Z" },
    { id: "ledger-final", currency: "IDR", type: "payment_captured", gross: 10_000, platformFee: 500, providerFee: 200, providerFeeFinal: true, boothEarning: 9_300, createdAt: "2026-07-21T10:02:00.000Z" },
    { id: "ledger-final", currency: "IDR", type: "payment_captured", gross: 10_000, platformFee: 500, providerFee: 200, providerFeeFinal: true, boothEarning: 9_300, createdAt: "2026-07-21T10:02:00.000Z" },
  ];
  const balance = summarizeLedgerBalance(records);
  assert.equal(balance.pendingBalance, 33_250);
  assert.equal(balance.availableBalance, 4_300);
  assert.equal(balance.totalBalance, 37_550);
  assert.equal(balance.gross, 45_000);
  assert.equal(balance.platformFee, 2_250);
  assert.equal(balance.providerFee, 200);
  assert.equal(balance.entryCount, 3);
  assert.equal(balance.provisionalEntryCount, 1);
  assert.equal(balance.latestEntryAt, "2026-07-21T10:02:00.000Z");
});

test("provider report reconciles to zero after provider fee finalization", () => {
  const records = [
    { id: "capture-one", boothCode: "booth-one", paymentId: "pay-one", providerPaymentId: "pr-one", type: "payment_captured", currency: "IDR", gross: 35_000, platformFee: 1_750, providerFee: null, providerFeeFinal: false, boothEarning: 33_250 },
    { id: "fee-one", boothCode: "booth-one", paymentId: "pay-one", providerPaymentId: "pr-one", type: "provider_fee", currency: "IDR", gross: 0, platformFee: 0, providerFee: 250, providerFeeFinal: true, boothEarning: -250 },
  ];
  const result = reconcileProviderLedger(records, [{ provider_payment_id: "pr-one", gross: 35_000, provider_fee: 250, status: "settled" }]);
  assert.equal(result.zeroDifference, true);
  assert.equal(result.matchedCount, 1);
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.grossDifference, 0);
  assert.equal(result.providerFeeDifference, 0);
  assert.equal(result.details[0].ledgerBoothEarning, 33_000);
});

test("provider reconciliation exposes missing reports and fee differences", () => {
  const records = [
    { id: "capture-one", paymentId: "pay-one", providerPaymentId: "pr-one", type: "payment_captured", currency: "IDR", gross: 35_000, boothEarning: 33_250 },
    { id: "fee-one", paymentId: "pay-one", providerPaymentId: "pr-one", type: "provider_fee", currency: "IDR", providerFee: 200, providerFeeFinal: true, boothEarning: -200 },
    { id: "capture-two", paymentId: "pay-two", providerPaymentId: "pr-two", type: "payment_captured", currency: "IDR", gross: 10_000, boothEarning: 9_500 },
  ];
  const result = reconcileProviderLedger(records, [{ providerPaymentId: "pr-one", gross: 35_000, providerFee: 250, status: "settled" }]);
  assert.equal(result.zeroDifference, false);
  assert.equal(result.mismatchCount, 2);
  assert.equal(result.details[0].reason, "provider_fee_difference");
  assert.equal(result.providerFeeDifference, -50);
  assert.equal(result.missingFromProvider[0].reason, "missing_provider_report");
  assert.equal(result.grossDifference, 10_000);
  assert.throws(() => reconcileProviderLedger([], [
    { providerPaymentId: "duplicate", gross: 1_000, providerFee: 10, status: "settled" },
    { providerPaymentId: "duplicate", gross: 1_000, providerFee: 10, status: "settled" },
  ]), /muncul lebih dari sekali/);
});

test("ledger reconciliation run is persistent and idempotent by report reference", async () => {
  const redis = new FakeRedis();
  const input = {
    boothCode: "booth-one", provider: "xendit", reference: "settlement-2026-07-21", createdBy: "finance-one",
    ledgerRecords: [
      { id: "capture-one", paymentId: "pay-one", providerPaymentId: "pr-one", type: "payment_captured", currency: "IDR", gross: 35_000, boothEarning: 33_250 },
      { id: "fee-one", paymentId: "pay-one", providerPaymentId: "pr-one", type: "provider_fee", currency: "IDR", providerFee: 250, providerFeeFinal: true, boothEarning: -250 },
    ],
    providerRows: [{ providerPaymentId: "pr-one", gross: 35_000, providerFee: 250, status: "settled" }],
  };
  const created = await createLedgerReconciliationRun(redis, input);
  assert.equal(created.reused, false);
  assert.equal(created.run.zeroDifference, true);
  const replay = await createLedgerReconciliationRun(redis, input);
  assert.equal(replay.reused, true);
  assert.equal(replay.run.id, created.run.id);
  const runs = await listLedgerReconciliationRuns(redis, { boothCode: "booth-one" });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].inputHash, created.run.inputHash);
  await assert.rejects(createLedgerReconciliationRun(redis, {
    ...input, providerRows: [{ providerPaymentId: "pr-one", gross: 34_000, providerFee: 250, status: "settled" }],
  }), /sudah digunakan untuk laporan berbeda/);
});

test("finance balance, provider fee, and ledger reconciliation endpoints enforce finance permissions", async () => {
  const { financeBalancesControl, financeProviderFeeControl, financeLedgerReconciliationControl } = await import("../api/platform.mjs");
  const response = await financeBalancesControl(new FakeRedis(), new Request("https://photoslive.test/api/platform?action=finance_balances"));
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Akses saldo finance ditolak/);
  const feeResponse = await financeProviderFeeControl(new FakeRedis(), new Request("https://photoslive.test/api/platform?action=finance_provider_fee", { method: "POST" }), {
    paymentId: "pay-one", amount: 250, reference: "settlement-one",
  });
  assert.equal(feeResponse.status, 403);
  assert.match(await feeResponse.text(), /Akses biaya provider ditolak/);
  const reconciliationResponse = await financeLedgerReconciliationControl(new FakeRedis(), new Request("https://photoslive.test/api/platform?action=finance_ledger_reconciliation"));
  assert.equal(reconciliationResponse.status, 403);
  assert.match(await reconciliationResponse.text(), /Akses rekonsiliasi ledger ditolak/);
});

test("refund request restores an expired Redis payment through durable resolver", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-refund-durable", purpose: "session", amount: 35_000,
    currency: "IDR", providerConnectionRef,
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "durable-refund-capture" },
  }), {
    event: "payment.capture",
    data: { payment_request_id: created.payment.providerPaymentId, status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  }, { runtimeResolver: async () => ({ environment }) });
  const durable = await getPayment(redis, created.payment.id);
  await redis.del(paymentStorageKeys.paymentKey(durable.id));
  await redis.del(paymentStorageKeys.providerPaymentKey(durable.providerPaymentId));
  let resolvedPaymentId = null;
  const requested = await createXenditRefund(redis, { paymentId: durable.id }, {
    environment,
    paymentResolver: async paymentId => { resolvedPaymentId = paymentId; return durable; },
    fetchImplementation: async () => new Response(JSON.stringify({ id: "rfd-durable-1", status: "PENDING" }), { status: 200 }),
  });
  assert.equal(resolvedPaymentId, durable.id);
  assert.equal(requested.refund.status, "pending");
  assert.equal((await getPayment(redis, durable.id)).status, "paid");
});

test("webhook can restore an expired Redis payment through durable resolver", async () => {
  const redis = new FakeRedis();
  const created = await createQrisPayment(redis, {
    boothCode: "booth-one", sessionId: "session-durable", purpose: "session", amount: 35_000, currency: "IDR", providerConnectionRef,
  }, { environment, fetchImplementation: async () => new Response(JSON.stringify(providerPayment()), { status: 200 }) });
  const durable = await getPayment(redis, created.payment.id);
  await redis.del(paymentStorageKeys.paymentKey(durable.id));
  await redis.del(paymentStorageKeys.providerPaymentKey(durable.providerPaymentId));
  let resolvedProviderId = null;
  const accepted = await processXenditWebhook(redis, new Request("https://photoslive.test/webhook", {
    method: "POST", headers: { "x-callback-token": environment.XENDIT_WEBHOOK_TOKEN, "webhook-id": "durable-capture" },
  }), {
    event: "payment.capture",
    data: { payment_request_id: durable.providerPaymentId, status: "SUCCEEDED", request_amount: 35_000, currency: "IDR" },
  }, {
    paymentResolver: async providerId => { resolvedProviderId = providerId; return durable; },
    runtimeResolver: async () => ({ environment }),
  });
  assert.equal(resolvedProviderId, durable.providerPaymentId);
  assert.equal(accepted.payment.status, "paid");
  assert.equal((await getPayment(redis, durable.id)).status, "paid");
});

test("production booth routes payment data through cloud and never through hardware bridge", async () => {
  const boothSource = await import("node:fs/promises").then(fs => fs.readFile(new URL("../booth.js", import.meta.url), "utf8"));
  const bridgeSource = await import("node:fs/promises").then(fs => fs.readFile(new URL("../api/bridge.mjs", import.meta.url), "utf8"));
  const platformSource = await import("node:fs/promises").then(fs => fs.readFile(new URL("../api/platform.mjs", import.meta.url), "utf8"));
  assert.match(boothSource, /pathname === "\/api\/booth\/qris"/);
  assert.match(boothSource, /\/api\/booth\/payments\/\$\{encodeURIComponent\(payment\.id\)\}/);
  assert.match(boothSource, /function pollQrisPayment/);
  assert.doesNotMatch(bridgeSource, /path === "\/api\/booth\/qris"/);
  assert.match(platformSource, /userId: "xendit-status-poll"/);
  assert.match(platformSource, /entityType: "ledger"/);
  assert.match(platformSource, /action === "finance_reconciliation"/);
  assert.match(platformSource, /action === "finance_refund"/);
  assert.match(platformSource, /action === "finance_chargeback"/);
  assert.match(platformSource, /action === "finance_adjustment"/);
  assert.match(platformSource, /action === "finance_balances"/);
  assert.match(platformSource, /action === "finance_provider_fee"/);
  assert.match(platformSource, /action === "finance_ledger_reconciliation"/);
  assert.match(platformSource, /payment\.late_reviewed/);
  const superadminHtml = await import("node:fs/promises").then(fs => fs.readFile(new URL("../superadmin.html", import.meta.url), "utf8"));
  const superadminSource = await import("node:fs/promises").then(fs => fs.readFile(new URL("../superadmin.js", import.meta.url), "utf8"));
  assert.match(superadminHtml, /id="finance-refund-form"/);
  assert.match(superadminHtml, /id="finance-chargeback-form"/);
  assert.match(superadminHtml, /id="finance-adjustment-form"/);
  assert.match(superadminHtml, /id="finance-balances-card"/);
  assert.match(superadminHtml, /id="finance-provider-fee-form"/);
  assert.match(superadminHtml, /id="finance-ledger-reconciliation-form"/);
  assert.match(superadminSource, /api\("finance_refund"/);
  assert.match(superadminSource, /api\("finance_chargeback"/);
  assert.match(superadminSource, /api\("finance_adjustment"/);
  assert.match(superadminSource, /api\("finance_balances"/);
  assert.match(superadminSource, /api\("finance_provider_fee"/);
  assert.match(superadminSource, /api\("finance_ledger_reconciliation"/);
  assert.match(superadminSource, /function parseProviderCsv/);
});
