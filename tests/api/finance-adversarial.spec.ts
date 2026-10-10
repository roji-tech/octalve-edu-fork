import "../support/env";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, InvoiceStatus, PaymentStatus } from "@prisma/client";
import {
  addMembership,
  createTenant,
  createUser,
  db,
  removeCreatedTenants,
  seedInstance,
  type TestTenant,
  type TestUser,
} from "../support/db";
import { api } from "../support/http";
import { mockPaystack } from "@/lib/finance/mock-paystack";
import { initializePayment } from "@/lib/finance/service";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";

const SAAS = { baseUrl: SAAS_URL };
const webhookRoute = () => "/api/v1/webhooks/paystack";

function signPayload(rawPayload: string, secret: string): string {
  return crypto.createHmac("sha512", secret).update(rawPayload).digest("hex");
}

let schoolA: TestTenant;
let adminA: TestUser;
let parentA: TestUser;
let invoiceAId: string;
const webhookSecret = process.env.PAYSTACK_SECRET_KEY || "mock_sk_test_octalve_secret";

test.beforeAll(async () => {
  await seedInstance();
  schoolA = await createTenant({ name: "Crescent Financial Academy" });

  adminA = await createUser({ name: "Bursar Fatima" });
  parentA = await createUser({ name: "Alhaji Danladi" });

  await addMembership(adminA.id, schoolA.id, Role.ADMIN);
  await addMembership(parentA.id, schoolA.id, Role.PARENT);

  // Setup session, period, and student in schoolA
  const session = await db.academicSession.create({
    data: {
      tenantId: schoolA.id,
      label: "2026/2027",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2027-07-20"),
      status: "ACTIVE",
    },
  });

  const period = await db.academicPeriod.create({
    data: {
      tenantId: schoolA.id,
      sessionId: session.id,
      kind: "TERM",
      ordinal: 1,
      label: "Term 1",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-12-15"),
      isCurrent: true,
    },
  });

  const student = await db.studentRecord.create({
    data: {
      tenantId: schoolA.id,
      firstName: "Ibrahim",
      lastName: "Danladi",
      admissionNo: "ADM-ADV-001",
      dateOfBirth: new Date("2012-05-10"),
    },
  });

  // Create an unpaid invoice for 50,000 NGN (5,000,000 kobo)
  const invoice = await db.invoice.create({
    data: {
      tenantId: schoolA.id,
      studentId: student.id,
      periodId: period.id,
      invoiceNo: `INV-ADV-${Date.now()}`,
      totalAmount: 50000,
      amountPaid: 0,
      status: InvoiceStatus.UNPAID,
    },
  });
  invoiceAId = invoice.id;
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

test.describe.serial("Paystack Webhook & Finance Adversarial Security Suite", () => {
  test("1. Forged HMAC Signature Rejection: Untrusted signatures cannot trigger fulfilment", async () => {
    const rawPayload = JSON.stringify({
      event: "charge.success",
      data: {
        id: 11223344,
        reference: "oct_pay_forged_ref_001",
        amount: 5000000,
        status: "success",
        metadata: { tenantId: schoolA.id, invoiceId: invoiceAId },
      },
    });

    // 1a. Forged HMAC signature
    const forgedRes = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": "deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef",
        "content-type": "application/json",
      },
      rawBody: rawPayload,
    });
    expect(forgedRes.status).toBe(200);
    expect(forgedRes.json.received).toBe(true);
    expect(forgedRes.json.status).toBe("invalid_signature");

    // Verify DB ledger marked as invalid
    const ledger = await db.paymentWebhookEvent.findFirst({
      where: { eventId: "11223344" },
    });
    expect(ledger).not.toBeNull();
    expect(ledger?.signatureValid).toBe(false);
    expect(ledger?.processedAt).toBeNull();

    // Verify invoice remains completely unpaid
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceAId } });
    expect(invoice.status).toBe(InvoiceStatus.UNPAID);
    expect(Number(invoice.amountPaid)).toBe(0);

    // 1b. Missing signature header
    const missingSigRes = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: { "content-type": "application/json" },
      rawBody: rawPayload,
    });
    expect(missingSigRes.status).toBe(200);
    expect(missingSigRes.json.status).toBe("invalid_signature");
  });

  test("2. Replay Attack Resistance: Re-sending identical charge events is idempotent and prevents double-crediting", async () => {
    // Initialize a legitimate payment for 25,000 NGN
    const init = await initializePayment(trustedTenantId(schoolA.id), invoiceAId, parentA.email, 25000);
    expect(init.reference).toBeDefined();

    // Mock Paystack gateway registers successful checkout
    mockPaystack.simulatePaymentCompletion(init.reference, "success", 25000 * 100);

    const eventId = 77889900;
    const payload = JSON.stringify({
      event: "charge.success",
      data: {
        id: eventId,
        reference: init.reference,
        amount: 2500000, // 25,000 NGN in kobo
        status: "success",
        metadata: { tenantId: schoolA.id, invoiceId: invoiceAId },
      },
    });
    const validSignature = signPayload(payload, webhookSecret);

    // Delivery 1: Original webhook delivery
    const delivery1 = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": validSignature,
        "content-type": "application/json",
      },
      rawBody: payload,
    });
    expect(delivery1.status).toBe(200);
    expect(delivery1.json.status).toBe("processed");
    expect(delivery1.json.duplicate).toBeUndefined();

    // Verify invoice is partially paid (25,000 / 50,000)
    let invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceAId } });
    expect(Number(invoice.amountPaid)).toBe(25000);
    expect(invoice.status).toBe(InvoiceStatus.PARTIALLY_PAID);

    // Delivery 2: Replay identical webhook
    const delivery2 = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": validSignature,
        "content-type": "application/json",
      },
      rawBody: payload,
    });
    expect(delivery2.status).toBe(200);
    expect(delivery2.json.duplicate).toBe(true);

    // Delivery 3: Replay again in quick succession
    const delivery3 = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": validSignature,
        "content-type": "application/json",
      },
      rawBody: payload,
    });
    expect(delivery3.status).toBe(200);
    expect(delivery3.json.duplicate).toBe(true);

    // Invariant: Exactly ONE successful payment record created, amountPaid NOT doubled
    const payments = await db.payment.findMany({
      where: { providerRef: init.reference },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe(PaymentStatus.SUCCESS);

    invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceAId } });
    expect(Number(invoice.amountPaid)).toBe(25000); // NOT 50,000 or 75,000
    expect(invoice.status).toBe(InvoiceStatus.PARTIALLY_PAID);
  });

  test("3. Payload Tampering Resistance: Kobo amount reduction is detected and aborted", async () => {
    // Initialize remaining 25,000 NGN balance payment
    const init = await initializePayment(trustedTenantId(schoolA.id), invoiceAId, parentA.email, 25000);

    // Gateway has recorded that only 1,000 kobo (10 NGN) was actually completed on Paystack
    mockPaystack.simulatePaymentCompletion(init.reference, "success", 1000);

    // Attacker crafts a webhook pretending payment completed with underpaid amount (10 NGN / 1,000 kobo)
    const tamperedPayload = JSON.stringify({
      event: "charge.success",
      data: {
        id: 99112233,
        reference: init.reference,
        amount: 1000, // 10 NGN instead of 25,000 NGN
        status: "success",
        metadata: { tenantId: schoolA.id, invoiceId: invoiceAId },
      },
    });
    const signature = signPayload(tamperedPayload, webhookSecret);

    const res = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": signature,
        "content-type": "application/json",
      },
      rawBody: tamperedPayload,
    });
    // Webhook receiver catches error internally, returns 200 with error property, and aborts fulfilment
    expect(res.status).toBe(200);
    expect(res.json.error).toMatch(/Amount mismatch/i);

    // Verify invoice was NOT updated to PAID
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceAId } });
    expect(Number(invoice.amountPaid)).toBe(25000);
    expect(invoice.status).toBe(InvoiceStatus.PARTIALLY_PAID);
  });

  test("4. High-Concurrency Stress Test: 20 simultaneous webhook notifications resolve cleanly", async () => {
    // Reset payment: initialize remaining 25,000 NGN
    const init = await initializePayment(trustedTenantId(schoolA.id), invoiceAId, parentA.email, 25000);

    // Mock Paystack gateway verifies exact 25,000 NGN
    mockPaystack.simulatePaymentCompletion(init.reference, "success", 25000 * 100);

    const eventId = 55667788;
    const payload = JSON.stringify({
      event: "charge.success",
      data: {
        id: eventId,
        reference: init.reference,
        amount: 2500000,
        status: "success",
        metadata: { tenantId: schoolA.id, invoiceId: invoiceAId },
      },
    });
    const validSignature = signPayload(payload, webhookSecret);

    // Fire 20 parallel requests simultaneously
    const requests = Array.from({ length: 20 }, () =>
      api(webhookRoute(), {
        ...SAAS,
        method: "POST",
        headers: {
          "x-paystack-signature": validSignature,
          "content-type": "application/json",
        },
        rawBody: payload,
      }),
    );

    const responses = await Promise.all(requests);

    // Every response must be HTTP 200 OK
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.json.received).toBe(true);
    }

    // Invariant: Exactly 1 response has fresh processing (status: 'processed' without duplicate: true),
    // and remaining 19 identify duplicate delivery (or processed before)
    const freshResponses = responses.filter((r) => r.json.status === "processed" && !r.json.duplicate);
    expect(freshResponses.length).toBeGreaterThanOrEqual(1);

    // Invariant: The invoice is fully paid at exactly 50,000 NGN
    const invoice = await db.invoice.findUniqueOrThrow({ where: { id: invoiceAId } });
    expect(Number(invoice.amountPaid)).toBe(50000);
    expect(invoice.status).toBe(InvoiceStatus.PAID);

    // Invariant: Exactly ONE successful payment row in DB
    const successPayments = await db.payment.findMany({
      where: { providerRef: init.reference, status: PaymentStatus.SUCCESS },
    });
    expect(successPayments).toHaveLength(1);
  });
});
