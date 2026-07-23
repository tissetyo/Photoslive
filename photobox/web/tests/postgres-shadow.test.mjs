import assert from "node:assert/strict";
import test from "node:test";

const {
  appendPostgresLedgerEntry,
  postgresFinanceStatus,
  postgresShadowStatus,
  readPostgresChargebackByPaymentId,
  readPostgresLedgerEntries,
  readPostgresPaymentByProviderId,
  readPostgresPaymentById,
  writePostgresPaymentIntent,
  writePostgresPayout,
  writePostgresPayoutAccount,
  writePostgresPayoutPolicy,
  writePostgresChargeback,
  writePostgresReconciliationJob,
  writePostgresRefund,
  writePostgresShadowEvent,
} = await import("../api/_postgres.mjs");

const configuredEnvironment = {
  PHOTOSLIVE_POSTGRES_SHADOW: "true",
  PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "250",
  SUPABASE_URL: "https://project.supabase.co/",
  SUPABASE_SERVICE_ROLE_KEY: "server-secret-value",
};

const financeEnvironment = {
  ...configuredEnvironment,
  PHOTOSLIVE_POSTGRES_FINANCE: "true",
};

const event = {
  entityType: "audit",
  legacyKey: "booth-a:audit_123",
  operation: "upsert",
  idempotencyKey: "audit:audit_123",
  correlationId: "request-123",
  payload: { action: "settings.updated", boothCode: "booth-a" },
};

test("PostgreSQL shadow write is opt-in and does not expose its service key in status", () => {
  assert.equal(postgresShadowStatus({}).enabled, false);
  const status = postgresShadowStatus(configuredEnvironment);
  assert.equal(status.available, true);
  assert.equal(status.timeoutMs, 250);
  assert.ok(!JSON.stringify(status).includes("server-secret-value"));
});

test("disabled PostgreSQL shadow write performs no network request", async () => {
  let called = false;
  const result = await writePostgresShadowEvent(event, {
    environment: {},
    fetchImplementation: async () => { called = true; return new Response(null, { status: 201 }); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test("PostgreSQL shadow write is idempotent and server authenticated", async () => {
  let request;
  const result = await writePostgresShadowEvent(event, {
    environment: configuredEnvironment,
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 201 });
    },
  });
  assert.equal(result.ok, true);
  assert.match(request.url, /on_conflict=idempotency_key$/);
  assert.equal(request.options.headers.apikey, "server-secret-value");
  assert.equal(request.options.headers.authorization, "Bearer server-secret-value");
  assert.match(request.options.headers.prefer, /ignore-duplicates/);
  const body = JSON.parse(request.options.body);
  assert.equal(body.idempotency_key, event.idempotencyKey);
  assert.match(body.payload_checksum, /^[a-f0-9]{64}$/);
});

test("PostgreSQL outage does not fail the Redis-primary request path", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await writePostgresShadowEvent(event, {
      environment: configuredEnvironment,
      fetchImplementation: async () => new Response("database unavailable", { status: 503 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.match(result.reason, /503/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("invalid shadow event is rejected before any network request", async () => {
  let called = false;
  await assert.rejects(
    writePostgresShadowEvent({ ...event, entityType: "secret" }, {
      environment: configuredEnvironment,
      fetchImplementation: async () => { called = true; return new Response(null, { status: 201 }); },
    }),
    /tidak valid/,
  );
  assert.equal(called, false);
});

test("PostgreSQL shadow write aborts at its bounded timeout", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await writePostgresShadowEvent(event, {
      environment: { ...configuredEnvironment, PHOTOSLIVE_POSTGRES_TIMEOUT_MS: "100" },
      fetchImplementation: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /timeout setelah 100 ms/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("PostgreSQL finance dual-write is separately gated and keeps service credentials server-side", async () => {
  assert.equal(postgresFinanceStatus(configuredEnvironment).available, false);
  assert.equal(postgresFinanceStatus(financeEnvironment).available, true);
  const requests = [];
  const fetchImplementation = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(null, { status: 201 });
  };
  const payment = {
    id: `pay_${"a".repeat(32)}`, boothCode: "booth-a", sessionId: "session-a", purpose: "session",
    amount: 35_000, currency: "IDR", provider: "xendit", providerPaymentId: "pr-a", status: "pending",
    providerConnectionRef: { providerId: "xendit", source: "byo", connectionId: "booth:booth-a:xendit", credentialVersion: 4, credentialFingerprint: "b".repeat(64) },
    expiresAt: "2026-07-21T12:00:00.000Z", providerExpiresAt: "2026-07-22T12:00:00.000Z",
    feeSnapshot: { platformFeeBps: 500, platformFee: 1_750 }, createdAt: "2026-07-21T11:00:00.000Z", updatedAt: "2026-07-21T11:00:00.000Z",
  };
  const ledger = {
    id: `ledger_${"b".repeat(32)}`, paymentId: payment.id, boothCode: "booth-a", type: "payment_captured",
    currency: "IDR", gross: 35_000, providerFee: null, providerFeeFinal: false, platformFee: 1_750,
    boothEarning: 33_250, provider: "xendit", providerPaymentId: "pr-a", idempotencyKey: `ledger:${payment.id}:payment_captured`, createdAt: "2026-07-21T11:01:00.000Z",
  };
  const adjustment = {
    ...ledger, id: `ledger_${"c".repeat(32)}`, type: "adjustment", gross: 0, platformFee: 0, boothEarning: -5_000,
    adjustmentReference: "ticket-1001", adjustmentReason: "Koreksi biaya", createdBy: "finance-admin",
    idempotencyKey: `ledger:${payment.id}:adjustment:ticket-1001`, createdAt: "2026-07-21T11:02:00.000Z",
  };
  const reconciliation = {
    paymentId: payment.id, boothCode: "booth-a", status: "pending", reason: "provider_pending",
    attempts: 0, nextAttemptAt: payment.expiresAt, createdAt: payment.createdAt, updatedAt: payment.updatedAt,
  };
  const refund = {
    id: `refund_${"d".repeat(32)}`, paymentId: payment.id, boothCode: "booth-a", provider: "xendit",
    providerRefundId: "rfd-a", amount: 35_000, currency: "IDR", reason: "REQUESTED_BY_CUSTOMER",
    status: "pending", createdBy: "finance-admin", createdAt: payment.createdAt, updatedAt: payment.updatedAt,
  };
  const chargeback = {
    id: `chargeback_${"e".repeat(32)}`, paymentId: payment.id, boothCode: "booth-a", provider: "xendit",
    providerChargebackId: "dispute-a", amount: 35_000, currency: "IDR", reason: "Confirmed dispute",
    disputedAt: payment.updatedAt, recordedBy: "finance-admin", createdAt: payment.updatedAt,
  };
  await writePostgresPaymentIntent(payment, { environment: financeEnvironment, fetchImplementation });
  await appendPostgresLedgerEntry(ledger, { environment: financeEnvironment, fetchImplementation });
  await appendPostgresLedgerEntry(adjustment, { environment: financeEnvironment, fetchImplementation });
  await writePostgresReconciliationJob(reconciliation, { environment: financeEnvironment, fetchImplementation });
  await writePostgresRefund(refund, { environment: financeEnvironment, fetchImplementation });
  await writePostgresChargeback(chargeback, { environment: financeEnvironment, fetchImplementation });
  assert.deepEqual(requests.map(item => new URL(item.url).pathname), [
    "/rest/v1/payment_intents", "/rest/v1/financial_ledger_entries", "/rest/v1/financial_ledger_entries", "/rest/v1/payment_reconciliation_jobs", "/rest/v1/payment_refunds", "/rest/v1/payment_chargebacks",
  ]);
  assert.equal(requests[0].options.headers.authorization, "Bearer server-secret-value");
  assert.equal(requests[0].body.provider_connection_id, "booth:booth-a:xendit");
  assert.equal(requests[0].body.provider_connection_source, "byo");
  assert.equal(requests[0].body.provider_credential_version, 4);
  assert.equal(requests[0].body.provider_credential_fingerprint, "b".repeat(64));
  assert.equal(requests[1].body.provider_fee, null);
  assert.match(requests[1].options.headers.prefer, /ignore-duplicates/);
  assert.equal(requests[2].body.metadata.adjustmentReference, "ticket-1001");
  assert.equal(requests[2].body.metadata.adjustmentReason, "Koreksi biaya");
  assert.equal(requests[2].body.metadata.createdBy, "finance-admin");
  assert.equal(requests[4].body.provider_refund_id, "rfd-a");
  assert.equal(requests[4].body.status, "pending");
  assert.equal(requests[4].body.requested_by, "finance-admin");
  assert.equal(requests[5].body.provider_chargeback_id, "dispute-a");
  assert.ok(!JSON.stringify(requests.map(item => item.body)).includes("server-secret-value"));
});

test("manual payout persistence writes policy, sealed account, payout, and payout-linked ledger", async () => {
  const requests = [];
  const fetchImplementation = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return new Response(null, { status: 201 });
  };
  const createdAt = "2026-07-21T12:00:00.000Z";
  const payoutId = `payout_${"f".repeat(32)}`;
  await writePostgresPayoutPolicy({ boothCode: "booth-a", mode: "manual_superadmin", minimumAmount: 10_000, createdAt, updatedAt: createdAt, updatedBy: "finance" }, { environment: financeEnvironment, fetchImplementation });
  await writePostgresPayoutAccount({ boothCode: "booth-a", bankCode: "ID_BCA", accountName: "Owner", accountNumberMasked: "•••• 7890", sealed: { format: "aes-256-gcm", keyVersion: "v1", iv: "iv", ciphertext: "cipher" }, status: "verified", version: 1, verifiedAt: createdAt, verifiedBy: "checker", verificationReference: "bank-check", createdAt, updatedAt: createdAt, updatedBy: "maker" }, { environment: financeEnvironment, fetchImplementation });
  await writePostgresPayout({ id: payoutId, boothCode: "booth-a", period: "2026-07-21", mode: "manual_superadmin", currency: "IDR", amount: 90_000, status: "approved", accountVersion: 1, account: { bankCode: "ID_BCA", accountName: "Owner", accountNumberMasked: "•••• 7890" }, preparedBy: "maker", approvedBy: "checker", approvedAt: createdAt, createdAt, updatedAt: createdAt }, { environment: financeEnvironment, fetchImplementation });
  await appendPostgresLedgerEntry({ id: `ledger_${"9".repeat(32)}`, boothCode: "booth-a", paymentId: null, payoutId, type: "payout", currency: "IDR", gross: 0, providerFee: 0, providerFeeFinal: true, platformFee: 0, boothEarning: -90_000, provider: "manual_bank_transfer", providerPaymentId: "TRX-1", idempotencyKey: `ledger:payout:${payoutId}`, createdAt }, { environment: financeEnvironment, fetchImplementation });
  assert.deepEqual(requests.map(item => new URL(item.url).pathname), [
    "/rest/v1/payout_policies", "/rest/v1/payout_accounts", "/rest/v1/payouts", "/rest/v1/financial_ledger_entries",
  ]);
  assert.equal(requests[1].body.sealed_account.ciphertext, "cipher");
  assert.equal(requests[2].body.account_snapshot.accountNumberMasked, "•••• 7890");
  assert.equal(requests[3].body.payment_id, null);
  assert.equal(requests[3].body.payout_id, payoutId);
});

test("PostgreSQL finance reader restores a payment without leaking service credentials", async () => {
  let request;
  const row = {
    id: `pay_${"e".repeat(32)}`, booth_code: "booth-a", session_id: "session-a", purpose: "session",
    amount: 35000, currency: "IDR", provider: "xendit", provider_payment_id: "pr-durable",
    provider_connection_id: "booth:booth-a:xendit", provider_connection_source: "byo",
    provider_credential_version: 4, provider_credential_fingerprint: "b".repeat(64), status: "paid",
    checkout_expires_at: "2026-07-21T12:00:00.000Z", provider_expires_at: "2026-07-22T12:00:00.000Z",
    paid_at: "2026-07-21T11:01:00.000Z", platform_fee_bps: 500, platform_fee: 1750,
    late_payment: false, review_status: "not_required", metadata: { reconciliationState: "resolved" },
    created_at: "2026-07-21T11:00:00.000Z", updated_at: "2026-07-21T11:01:00.000Z",
  };
  const payment = await readPostgresPaymentByProviderId("pr-durable", {
    environment: financeEnvironment,
    fetchImplementation: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify([row]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(request.url, /payment_intents\?provider_payment_id=eq\.pr-durable/);
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.authorization, "Bearer server-secret-value");
  assert.equal(payment.id, row.id);
  assert.equal(payment.boothCode, "booth-a");
  assert.deepEqual(payment.feeSnapshot, { platformFeeBps: 500, platformFee: 1750 });
  assert.equal(payment.providerConnectionRef.credentialVersion, 4);
  assert.ok(!JSON.stringify(payment).includes("server-secret-value"));
});

test("PostgreSQL finance reader restores a payment by internal id for late refund", async () => {
  let requestedUrl = "";
  const row = {
    id: `pay_${"f".repeat(32)}`, booth_code: "booth-a", session_id: "session-a", purpose: "session",
    amount: 35000, currency: "IDR", provider: "xendit", provider_payment_id: "pr-refund-durable",
    status: "paid", checkout_expires_at: "2026-07-21T12:00:00.000Z", platform_fee_bps: 500,
    platform_fee: 1750, late_payment: false, review_status: "not_required",
    created_at: "2026-07-21T11:00:00.000Z", updated_at: "2026-07-21T11:01:00.000Z",
  };
  const payment = await readPostgresPaymentById(row.id, {
    environment: financeEnvironment,
    fetchImplementation: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify([row]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(requestedUrl, new RegExp(`payment_intents\\?id=eq\\.${row.id}`));
  assert.equal(payment.id, row.id);
  assert.equal(payment.providerPaymentId, "pr-refund-durable");
});

test("PostgreSQL finance reader restores a confirmed chargeback for durable idempotency", async () => {
  let requestedUrl = "";
  const paymentId = `pay_${"9".repeat(32)}`;
  const row = {
    id: `chargeback_${"8".repeat(32)}`, payment_id: paymentId, booth_code: "booth-a", provider: "xendit",
    provider_chargeback_id: "dispute-durable", amount: 35000, currency: "IDR", reason: "Confirmed dispute",
    disputed_at: "2026-07-21T11:00:00.000Z", recorded_by: "finance-admin", created_at: "2026-07-21T11:01:00.000Z",
  };
  const chargeback = await readPostgresChargebackByPaymentId(paymentId, {
    environment: financeEnvironment,
    fetchImplementation: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify([row]), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(requestedUrl, new RegExp(`payment_chargebacks\\?payment_id=eq\\.${paymentId}`));
  assert.equal(chargeback.providerChargebackId, "dispute-durable");
  assert.equal(chargeback.status, "confirmed");
});

test("PostgreSQL finance reader restores append-only ledger entries for balance projection", async () => {
  let requestedUrl = "";
  const rows = [{
    id: "ledger-durable", booth_code: "booth-a", payment_id: "pay-durable", entry_type: "adjustment",
    currency: "IDR", gross: 0, provider_fee: null, provider_fee_final: false, platform_fee: 0,
    booth_earning: -5000, provider: "xendit", provider_payment_id: "pr-durable",
    idempotency_key: "ledger:pay-durable:adjustment:ticket", metadata: { adjustmentReference: "ticket", adjustmentReason: "Correction", createdBy: "finance-admin" },
    created_at: "2026-07-21T11:03:00.000Z",
  }, {
    id: "ledger-provider-fee", booth_code: "booth-a", payment_id: "pay-durable", entry_type: "provider_fee",
    currency: "IDR", gross: 0, provider_fee: 250, provider_fee_final: true, platform_fee: 0,
    booth_earning: -250, provider: "xendit", provider_payment_id: "pr-durable",
    idempotency_key: "ledger:pay-durable:provider_fee", metadata: { providerFeeReference: "settlement-001", recordedBy: "finance-admin" },
    created_at: "2026-07-21T11:04:00.000Z",
  }];
  const ledger = await readPostgresLedgerEntries(["booth-a"], {
    environment: financeEnvironment,
    fetchImplementation: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.match(requestedUrl, /financial_ledger_entries\?booth_code=eq\.booth-a/);
  assert.match(requestedUrl, /order=created_at\.desc/);
  assert.equal(ledger[0].boothCode, "booth-a");
  assert.equal(ledger[0].boothEarning, -5000);
  assert.equal(ledger[0].adjustmentReference, "ticket");
  assert.equal(ledger[1].providerFee, 250);
  assert.equal(ledger[1].providerFeeFinal, true);
  assert.equal(ledger[1].providerFeeReference, "settlement-001");
  assert.equal(ledger[1].recordedBy, "finance-admin");
});

test("disabled PostgreSQL finance writer never contacts the network", async () => {
  let called = false;
  const result = await writePostgresPaymentIntent({
    id: `pay_${"c".repeat(32)}`, boothCode: "booth-a", sessionId: "session-a", purpose: "session",
    amount: 35_000, currency: "IDR", provider: "xendit", providerPaymentId: "pr-c", status: "pending",
    expiresAt: "2026-07-21T12:00:00.000Z", feeSnapshot: {}, createdAt: "2026-07-21T11:00:00.000Z", updatedAt: "2026-07-21T11:00:00.000Z",
  }, { environment: configuredEnvironment, fetchImplementation: async () => { called = true; return new Response(null, { status: 201 }); } });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});
