import "../support/env";
import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { SAAS_URL } from "../support/env";
import { Role, Permission } from "@prisma/client";
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
import { api, cookieHeader, loginAs } from "../support/http";
import { fulfillPayment } from "@/lib/finance/service";
import { mockPaystack } from "@/lib/finance/mock-paystack";
import { trustedTenantId } from "@/lib/tenant/verified-tenant";

const SAAS = { baseUrl: SAAS_URL };

let a: TestTenant;
let b: TestTenant;
let admin: TestUser;
let bursarStaff: TestUser;
let parent1: TestUser;
let parent2: TestUser;
let outsider: TestUser;
const cookie: Record<string, string> = {};

let sessionA: { id: string };
let periodA: { id: string };
let classGroupA: { id: string };
let armA: { id: string };
let student1: { id: string; admissionNo: string };
let student2: { id: string; admissionNo: string };

async function cookieFor(user: TestUser) {
  const res = await loginAs(user, SAAS);
  expect(res.status).toBe(200);
  return cookieHeader(res.token!);
}

test.beforeAll(async () => {
  await seedInstance();
  a = await createTenant({ name: "Alpha Finance Academy" });
  b = await createTenant({ name: "Beta Independent School" });

  admin = await createUser();
  bursarStaff = await createUser();
  parent1 = await createUser();
  parent2 = await createUser();
  outsider = await createUser();

  await addMembership(admin.id, a.id, Role.ADMIN);

  // Bursar staff with CAN_MANAGE_FINANCE
  await db.tenantMembership.create({
    data: {
      userId: bursarStaff.id,
      tenantId: a.id,
      role: Role.NON_TEACHING_STAFF,
      permissions: [Permission.CAN_MANAGE_FINANCE],
    },
  });

  await addMembership(parent1.id, a.id, Role.PARENT);
  await addMembership(parent2.id, a.id, Role.PARENT);
  await addMembership(outsider.id, b.id, Role.ADMIN);

  cookie.admin = await cookieFor(admin);
  cookie.bursar = await cookieFor(bursarStaff);
  cookie.parent1 = await cookieFor(parent1);
  cookie.parent2 = await cookieFor(parent2);
  cookie.outsider = await cookieFor(outsider);

  // Academic Structure
  sessionA = await db.academicSession.create({
    data: {
      tenantId: a.id,
      label: "2026/2027",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2027-07-20"),
      status: "ACTIVE",
    },
  });

  periodA = await db.academicPeriod.create({
    data: {
      tenantId: a.id,
      sessionId: sessionA.id,
      kind: "TERM",
      ordinal: 1,
      label: "First Term 2026",
      startDate: new Date("2026-09-01"),
      endDate: new Date("2026-12-15"),
      isCurrent: true,
    },
  });

  classGroupA = await db.classGroup.create({
    data: {
      tenantId: a.id,
      name: "JSS 1",
      sortOrder: 1,
    },
  });

  armA = await db.classArm.create({
    data: {
      tenantId: a.id,
      classGroupId: classGroupA.id,
      name: "Emerald",
    },
  });

  // Students in School A
  student1 = await db.studentRecord.create({
    data: {
      tenantId: a.id,
      firstName: "Zainab",
      lastName: "Aliyu",
      dateOfBirth: new Date("2012-03-14"),
      admissionNo: "FIN/2026/001",
    },
  });

  student2 = await db.studentRecord.create({
    data: {
      tenantId: a.id,
      firstName: "Chidi",
      lastName: "Okonkwo",
      dateOfBirth: new Date("2012-07-22"),
      admissionNo: "FIN/2026/002",
    },
  });

  await db.studentEnrollment.createMany({
    data: [
      {
        tenantId: a.id,
        sessionId: sessionA.id,
        classArmId: armA.id,
        studentId: student1.id,
        status: "ACTIVE",
      },
      {
        tenantId: a.id,
        sessionId: sessionA.id,
        classArmId: armA.id,
        studentId: student2.id,
        status: "ACTIVE",
      },
    ],
  });

  // Link parent1 to student1 only
  const guardian1 = await db.guardianRecord.create({
    data: {
      tenantId: a.id,
      userId: parent1.id,
      firstName: "Halima",
      lastName: "Aliyu",
    },
  });

  await db.guardianLink.create({
    data: {
      tenantId: a.id,
      studentId: student1.id,
      guardianId: guardian1.id,
      relationship: "MOTHER",
      status: "APPROVED",
      isPrimary: true,
    },
  });

  // Link parent2 to student2 only
  const guardian2 = await db.guardianRecord.create({
    data: {
      tenantId: a.id,
      userId: parent2.id,
      firstName: "Emeka",
      lastName: "Okonkwo",
    },
  });

  await db.guardianLink.create({
    data: {
      tenantId: a.id,
      studentId: student2.id,
      guardianId: guardian2.id,
      relationship: "FATHER",
      status: "APPROVED",
      isPrimary: true,
    },
  });
});

test.afterAll(async () => {
  await removeCreatedTenants();
});

const as = (who: string, extra: object = {}) => ({ ...SAAS, cookie: cookie[who], ...extra });
const feeStructuresRoute = (code = a.code) => `/api/v1/schools/${code}/finance/fee-structures`;
const invoicesRoute = (code = a.code) => `/api/v1/schools/${code}/finance/invoices`;
const invoiceDetailRoute = (id: string, code = a.code) => `/api/v1/schools/${code}/finance/invoices/${id}`;
const payRoute = (id: string, code = a.code) => `/api/v1/schools/${code}/finance/invoices/${id}/pay`;
const manualPayRoute = (id: string, code = a.code) => `/api/v1/schools/${code}/finance/invoices/${id}/manual-payment`;
const discountRoute = (id: string, code = a.code) => `/api/v1/schools/${code}/finance/invoices/${id}/discount`;
const webhookRoute = () => `/api/v1/webhooks/paystack`;

test.describe("Phase 1.5: Finance, Invoicing & Dual-Mode Paystack Integration", () => {
  test.describe.configure({ mode: "serial" });
  let invoice1Id: string;
  let invoice2Id: string;

  test("1. Fee Structures: create and query schedules", async () => {
    // Unauthenticated
    const unauth = await api(feeStructuresRoute(), { ...SAAS });
    expect(unauth.status).toBe(401);

    // Parent cannot create fee structure
    const parentTry = await api(feeStructuresRoute(), {
      ...as("parent1"),
      method: "POST",
      body: { periodId: periodA.id, name: "Tuition", amount: 50000 },
    });
    expect(parentTry.status).toBe(403);

    // Bursar creates Tuition Fee
    const tuitionRes = await api(feeStructuresRoute(), {
      ...as("bursar"),
      method: "POST",
      body: { periodId: periodA.id, name: "Tuition Fee", amount: 50000 },
    });
    expect(tuitionRes.status).toBe(201);
    expect(tuitionRes.json.data.feeStructure.name).toBe("Tuition Fee");
    expect(Number(tuitionRes.json.data.feeStructure.amount)).toBe(50000);
    expect(tuitionRes.json.data.feeStructure.id).toBeDefined();

    // Admin creates Sports Levy for ClassGroup JSS 1
    const sportsRes = await api(feeStructuresRoute(), {
      ...as("admin"),
      method: "POST",
      body: {
        periodId: periodA.id,
        classGroupId: classGroupA.id,
        name: "Sports Levy",
        amount: 5000,
      },
    });
    expect(sportsRes.status).toBe(201);
    expect(sportsRes.json.data.feeStructure.id).toBeDefined();

    // List fee structures
    const listRes = await api(`${feeStructuresRoute()}?periodId=${periodA.id}`, as("admin"));
    expect(listRes.status).toBe(200);
    expect(listRes.json.data.feeStructures).toHaveLength(2);
  });

  test("2. Batch Invoice Generation: idempotent student invoicing", async () => {
    // Generate invoices for Period A
    const genRes = await api(invoicesRoute(), {
      ...as("bursar"),
      method: "POST",
      body: { periodId: periodA.id, dueDate: "2026-10-31" },
    });
    expect(genRes.status).toBe(201);
    expect(genRes.json.data.created).toBe(2);
    expect(genRes.json.data.skipped).toBe(0);

    // Replay generation for same period: must be idempotent!
    const replayRes = await api(invoicesRoute(), {
      ...as("bursar"),
      method: "POST",
      body: { periodId: periodA.id },
    });
    expect(replayRes.status).toBe(201);
    expect(replayRes.json.data.created).toBe(0);
    expect(replayRes.json.data.skipped).toBe(2);

    // Query invoices
    const listRes = await api(invoicesRoute(), as("bursar"));
    expect(listRes.status).toBe(200);
    expect(listRes.json.data.items).toHaveLength(2);

    const inv1 = listRes.json.data.items.find((i: { student: { id: string } }) => i.student.id === student1.id);
    const inv2 = listRes.json.data.items.find((i: { student: { id: string } }) => i.student.id === student2.id);

    expect(inv1).toBeDefined();
    expect(inv2).toBeDefined();
    expect(Number(inv1.totalAmount)).toBe(55000); // 50,000 + 5,000
    expect(inv1.status).toBe("UNPAID");

    invoice1Id = inv1.id;
    invoice2Id = inv2.id;
  });

  test("3. IDOR Guard: student/guardian isolation", async () => {
    // Bursar can view any invoice in School A
    const bursarView = await api(invoiceDetailRoute(invoice1Id), as("bursar"));
    expect(bursarView.status).toBe(200);
    expect(bursarView.json.data.invoice.invoiceNo).toBeDefined();

    // Parent 1 can view student1's invoice
    const parent1View = await api(invoiceDetailRoute(invoice1Id), as("parent1"));
    expect(parent1View.status).toBe(200);
    expect(parent1View.json.data.invoice.student.id).toBe(student1.id);

    // Parent 1 attempting to view student2's invoice (IDOR attempt) MUST be refused with 403
    const idorAttempt = await api(invoiceDetailRoute(invoice2Id), as("parent1"));
    expect(idorAttempt.status).toBe(403);

    // Outsider from School B attempting to view School A's invoice MUST be refused with 403
    const crossSchoolAttempt = await api(invoiceDetailRoute(invoice1Id), as("outsider"));
    expect(crossSchoolAttempt.status).toBe(403);
  });

  test("4. Payment Initialization: gateway checkout reference", async () => {
    const initRes = await api(payRoute(invoice1Id), {
      ...as("parent1"),
      method: "POST",
      body: { amount: 25000 },
    });
    expect(initRes.status).toBe(200);
    expect(initRes.json.data.reference).toMatch(/^oct_pay_\d+_[a-f0-9]+$/);
    expect(initRes.json.data.authorizationUrl).toContain("mock");

    // Verify payment record in DB is PENDING
    const payment = await db.payment.findUnique({
      where: {
        provider_providerRef: {
          provider: "PAYSTACK",
          providerRef: initRes.json.data.reference,
        },
      },
    });
    expect(payment).toBeDefined();
    expect(payment?.status).toBe("PENDING");
    expect(Number(payment?.amount)).toBe(25000);
  });

  test("5. Atomic Concurrency Lock: 20 simultaneous fulfilments resolve to exactly ONE credit", async () => {
    // Initialize a dedicated payment for concurrency testing
    const initRes = await api(payRoute(invoice1Id), {
      ...as("parent1"),
      method: "POST",
      body: { amount: 20000 },
    });
    if (initRes.status !== 200) {
      console.error("DEBUG TEST 5 initRes error:", JSON.stringify(initRes.json));
    }
    expect(initRes.status).toBe(200);
    const ref = initRes.json.data.reference;

    // Simulate completion in mock gateway with exact amount
    mockPaystack.simulatePaymentCompletion(ref, "success", 20000 * 100);

    // Launch 20 concurrent fulfilment calls simultaneously
    const verifiedTenant = trustedTenantId(a.id);
    const promises = Array.from({ length: 20 }, () => fulfillPayment(ref, { tenantIdOverride: verifiedTenant }));

    const results = await Promise.all(promises);

    // Invariants:
    // Exactly 1 result did the actual fulfilment (alreadyFulfilled === false)
    // Exactly 19 results detected concurrent fulfilment (alreadyFulfilled === true)
    const freshFulfilments = results.filter((r) => r.alreadyFulfilled === false);
    const existingFulfilments = results.filter((r) => r.alreadyFulfilled === true);

    expect(freshFulfilments).toHaveLength(1);
    expect(existingFulfilments).toHaveLength(19);

    // Verify payment in DB has receipt number generated
    const fulfilledPayment = await db.payment.findUnique({
      where: { id: freshFulfilments[0].paymentId },
    });
    expect(fulfilledPayment?.receiptNo).toMatch(/^RCP-[A-Z0-9]+-\d{4}-\d{4}$/);

    // Verify database state: invoice amountPaid incremented by EXACTLY 20,000 (not 20 x 20,000!)
    const invoice = await db.invoice.findUnique({
      where: { id: invoice1Id },
    });
    expect(invoice).toBeDefined();
    expect(Number(invoice?.amountPaid)).toBe(20000);
    expect(invoice?.status).toBe("PARTIALLY_PAID");
  });

  test("6. Webhook Security: exact HMAC-SHA512 verification & tamper refusal", async () => {
    // Initialize another payment to be fulfilled via webhook
    const initRes = await api(payRoute(invoice1Id), {
      ...as("parent1"),
      method: "POST",
      body: { amount: 15000 },
    });
    if (initRes.status !== 200) {
      console.error("DEBUG TEST 6 ERROR:", JSON.stringify(initRes.json));
    }
    expect(initRes.status).toBe(200);
    const ref = initRes.json.data.reference;
    const webhookSecret = process.env.PAYSTACK_SECRET_KEY || "mock_sk_test_octalve_secret";

    const payloadObj = {
      event: "charge.success",
      data: {
        id: 99887766,
        reference: ref,
        amount: 1500000, // 15,000 Naira in Kobo
        status: "success",
        channel: "card",
        paid_at: new Date().toISOString(),
        metadata: {
          tenantId: a.id,
        },
      },
    };

    const rawPayload = JSON.stringify(payloadObj);
    const validSignature = crypto.createHmac("sha512", webhookSecret).update(rawPayload).digest("hex");

    // Test 6a: Altered/tampered signature fails
    const badSigRes = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": "tampered_signature_hex_value_00000000",
        "content-type": "application/json",
      },
      rawBody: rawPayload,
    });
    expect(badSigRes.status).toBe(200);
    expect(badSigRes.json.status).toBe("invalid_signature");

    // Test 6b: Valid signature succeeds and returns 200
    const validRes = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": validSignature,
        "content-type": "application/json",
      },
      rawBody: rawPayload,
    });
    expect(validRes.status).toBe(200);
    expect(validRes.json.received).toBe(true);

    // Test 6c: Idempotent replay of same webhook event returns duplicate: true
    const replayRes = await api(webhookRoute(), {
      ...SAAS,
      method: "POST",
      headers: {
        "x-paystack-signature": validSignature,
        "content-type": "application/json",
      },
      rawBody: rawPayload,
    });
    expect(replayRes.status).toBe(200);
    expect(replayRes.json.duplicate).toBe(true);

    // Verify invoice amountPaid was incremented: 20,000 + 15,000 = 35,000
    const updatedInvoice = await db.invoice.findUnique({
      where: { id: invoice1Id },
    });
    expect(Number(updatedInvoice?.amountPaid)).toBe(35000);
    expect(updatedInvoice?.status).toBe("PARTIALLY_PAID");

    // Verify PaymentWebhookEvent ledger: rawPayloadHash is SHA-256, NEVER plaintext secret
    const webhookLedger = await db.paymentWebhookEvent.findFirst({
      where: { eventId: "99887766" },
    });
    expect(webhookLedger).toBeDefined();
    expect(webhookLedger?.signatureValid).toBe(true);
    expect(webhookLedger?.rawPayloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("7. Manual Payment: record bursary payment & settle invoice to PAID", async () => {
    // Invoice 1 total is 55,000; amountPaid is 35,000. Balance is 20,000.
    const manualRes = await api(manualPayRoute(invoice1Id), {
      ...as("bursar"),
      method: "POST",
      body: {
        amount: 20000,
        channel: "cash",
        reference: "CSH-2026-0099",
        note: "Settled in full at bursary counter",
      },
    });
    if (manualRes.status !== 201) {
      console.error("DEBUG TEST 7 ERROR:", JSON.stringify(manualRes.json));
    }
    expect(manualRes.status).toBe(201);
    expect(manualRes.json.data.receiptNo).toMatch(/^RCP-[A-Z0-9]+-\d{4}-\d{4}$/);

    // Invoice should now be PAID
    const invoice = await db.invoice.findUnique({
      where: { id: invoice1Id },
    });
    expect(Number(invoice?.amountPaid)).toBe(55000);
    expect(invoice?.status).toBe("PAID");
  });

  test("8. Fee Discount & Waivers: apply scholarship concession", async () => {
    // Invoice 2 is 55,000. Apply a 10,000 scholarship discount.
    const discountRes = await api(discountRoute(invoice2Id), {
      ...as("bursar"),
      method: "POST",
      body: {
        amount: 10000,
        reason: "Merit Scholarship Concession",
        mode: "MANUAL_OVERRIDE",
      },
    });
    if (discountRes.status !== 201) {
      console.error("DEBUG TEST 8 ERROR:", JSON.stringify(discountRes.json));
    }
    expect(discountRes.status).toBe(201);
    expect(discountRes.json.data.discount.reason).toBe("Merit Scholarship Concession");

    // Invoice 2 totalAmount adjusted: 55,000 - 10,000 = 45,000
    const invoice = await db.invoice.findUnique({
      where: { id: invoice2Id },
      include: { discounts: true },
    });
    expect(invoice?.discounts).toHaveLength(1);
    expect(Number(invoice?.totalAmount)).toBe(45000);
    expect(invoice?.status).toBe("UNPAID");
  });
});
