import { Prisma, InvoiceStatus, PaymentProvider, PaymentStatus, DiscountWorkflowMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { forTenant } from "@/lib/tenant/for-tenant";
import { trustedTenantId, type VerifiedTenantId } from "@/lib/tenant/verified-tenant";
import {
  toDecimal,
  toKobo,
  resolveInvoiceStatus,
  generateInvoiceNumber,
  generateReceiptNumber,
  generatePaymentReference,
  type DecimalLike,
} from "./rules";
import { verifyPaystackSignature, computePayloadHash } from "./crypto";
import { getPaystackClient, MockPaystackGateway } from "./paystack";

export interface FeeStructureInput {
  name: string;
  amount: DecimalLike;
  periodId: string;
  classGroupId?: string | null;
}

export interface InvoiceFilter {
  periodId?: string;
  studentId?: string;
  status?: InvoiceStatus;
  page?: number;
  pageSize?: number;
}

export interface RequesterContext {
  userId: string;
  roles: string[];
  permissions: string[];
}

/**
 * Creates a fee schedule item for an academic period.
 */
export async function createFeeStructure(tenantId: VerifiedTenantId, data: FeeStructureInput, actorUserId: string) {
  return forTenant(tenantId).transaction(async (tx) => {
    // Validate period belongs to this tenant
    await tx.academicPeriod.findFirstOrThrow({
      where: { tenantId, id: data.periodId },
    });

    if (data.classGroupId) {
      await tx.classGroup.findFirstOrThrow({
        where: { tenantId, id: data.classGroupId },
      });
    }

    const amountDecimal = toDecimal(data.amount);
    if (amountDecimal.isNegative()) {
      throw new Error("Fee structure amount cannot be negative");
    }

    const fee = await tx.feeStructure.create({
      data: {
        tenantId,
        periodId: data.periodId,
        classGroupId: data.classGroupId ?? null,
        name: data.name.trim(),
        amount: amountDecimal,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId,
        action: "fee_structure.create",
        targetType: "FeeStructure",
        targetId: fee.id,
        afterValue: { name: fee.name, amount: fee.amount.toString(), periodId: fee.periodId },
      },
    });

    return fee;
  });
}

/**
 * Queries fee structures for a tenant with optional period and classGroup filtering.
 */
export async function queryFeeStructures(tenantId: VerifiedTenantId, filter?: { periodId?: string; classGroupId?: string }) {
  return forTenant(tenantId).transaction(async (tx) => {
    return tx.feeStructure.findMany({
      where: {
        tenantId,
        ...(filter?.periodId ? { periodId: filter.periodId } : {}),
        ...(filter?.classGroupId ? { classGroupId: filter.classGroupId } : {}),
      },
      include: {
        period: { select: { id: true, label: true, kind: true, ordinal: true } },
        classGroup: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  });
}

/**
 * Idempotently generates term invoices for all enrolled students in a period.
 * (Roadmap §1.5 T2: idempotent per student+period).
 */
export async function generateInvoicesForPeriod(
  tenantId: VerifiedTenantId,
  schoolCode: string,
  periodId: string,
  options?: { dueDate?: Date | null; actorUserId?: string },
): Promise<{ created: number; skipped: number }> {
  return forTenant(tenantId).transaction(async (tx) => {
    const period = await tx.academicPeriod.findFirstOrThrow({
      where: { tenantId, id: periodId },
    });

    const feeStructures = await tx.feeStructure.findMany({
      where: { tenantId, periodId },
    });

    if (feeStructures.length === 0) {
      throw new Error("No fee structures configured for this academic period");
    }

    const enrollments = await tx.studentEnrollment.findMany({
      where: {
        tenantId,
        sessionId: period.sessionId,
        status: "ACTIVE",
      },
      include: {
        student: true,
        classArm: true,
      },
    });

    let created = 0;
    let skipped = 0;
    const year = new Date().getFullYear();

    for (const enrollment of enrollments) {
      // Idempotency guard: student already has an invoice for this period
      const existing = await tx.invoice.findUnique({
        where: {
          tenantId_studentId_periodId: {
            tenantId,
            studentId: enrollment.studentId,
            periodId,
          },
        },
      });

      if (existing) {
        skipped++;
        continue;
      }

      // Filter fee structures applicable to student's class group (or universal ones where classGroupId is null)
      const applicableFees = feeStructures.filter((f) => !f.classGroupId || f.classGroupId === enrollment.classArm.classGroupId);

      if (applicableFees.length === 0) {
        skipped++;
        continue;
      }

      let totalAmount = new Prisma.Decimal(0);
      const lineItems = applicableFees.map((f) => {
        totalAmount = totalAmount.add(f.amount);
        return {
          feeStructureId: f.id,
          name: f.name,
          amount: f.amount.toString(),
        };
      });

      const count = await tx.invoice.count({ where: { tenantId } });
      const invoiceNo = generateInvoiceNumber(schoolCode, year, count + 1);

      await tx.invoice.create({
        data: {
          tenantId,
          studentId: enrollment.studentId,
          periodId,
          invoiceNo,
          totalAmount,
          amountPaid: new Prisma.Decimal(0),
          status: InvoiceStatus.UNPAID,
          dueDate: options?.dueDate ?? null,
          lineItems,
        },
      });

      created++;
    }

    if (options?.actorUserId && created > 0) {
      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: options.actorUserId,
          action: "invoice.batch_generate",
          targetType: "AcademicPeriod",
          targetId: periodId,
          afterValue: { created, skipped },
        },
      });
    }

    return { created, skipped };
  });
}

/**
 * Queries invoices with role-based filtering and pagination.
 */
export async function queryInvoices(tenantId: VerifiedTenantId, filter?: InvoiceFilter) {
  return forTenant(tenantId).transaction(async (tx) => {
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter?.pageSize ?? 25));
    const skip = (page - 1) * pageSize;

    const where: Prisma.InvoiceWhereInput = {
      tenantId,
      ...(filter?.periodId ? { periodId: filter.periodId } : {}),
      ...(filter?.studentId ? { studentId: filter.studentId } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    };

    const [items, total] = await Promise.all([
      tx.invoice.findMany({
        where,
        include: {
          student: {
            select: { id: true, firstName: true, lastName: true, admissionNo: true },
          },
          period: {
            select: { id: true, label: true, kind: true },
          },
          payments: {
            where: { status: PaymentStatus.SUCCESS },
            select: { id: true, amount: true, paidAt: true, receiptNo: true, channel: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      }),
      tx.invoice.count({ where }),
    ]);

    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  });
}

/**
 * Retrieves a single student invoice with strict IDOR verification.
 * Only ADMIN/CAN_MANAGE_FINANCE, the student themselves, or verified linked guardians may view.
 */
export async function getStudentInvoice(tenantId: VerifiedTenantId, invoiceId: string, requester?: RequesterContext) {
  return forTenant(tenantId).transaction(async (tx) => {
    const invoice = await tx.invoice.findFirstOrThrow({
      where: { tenantId, id: invoiceId },
      include: {
        student: {
          select: { id: true, firstName: true, middleName: true, lastName: true, admissionNo: true, userId: true },
        },
        period: {
          select: { id: true, label: true, kind: true, session: { select: { id: true, label: true } } },
        },
        payments: {
          orderBy: { createdAt: "desc" },
        },
        discounts: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (requester) {
      const isStaffWithFinanceAccess = requester.roles.includes("ADMIN") || requester.permissions.includes("CAN_MANAGE_FINANCE");

      if (!isStaffWithFinanceAccess) {
        const isStudentHimself = invoice.student.userId === requester.userId;

        // Check if requester is a linked guardian
        const isLinkedGuardian = await tx.guardianLink.findFirst({
          where: {
            tenantId,
            studentId: invoice.studentId,
            guardian: { userId: requester.userId },
            status: "APPROVED",
          },
        });

        if (!isStudentHimself && !isLinkedGuardian) {
          throw new Error("Unauthorized IDOR attempt: access denied to invoice");
        }
      }
    }

    return invoice;
  });
}

/**
 * Initializes a payment attempt against an invoice via Paystack.
 */
export async function initializePayment(
  tenantId: VerifiedTenantId,
  invoiceId: string,
  userEmail: string,
  amountInNaira?: DecimalLike,
  callbackUrl?: string,
) {
  return forTenant(tenantId).transaction(async (tx) => {
    const invoice = await tx.invoice.findFirstOrThrow({
      where: { tenantId, id: invoiceId },
      include: { student: true },
    });

    if (invoice.status === InvoiceStatus.PAID) {
      throw new Error("Invoice is already fully paid");
    }
    if (invoice.status === InvoiceStatus.WAIVED) {
      throw new Error("Invoice has been waived");
    }

    const balanceDue = invoice.totalAmount.sub(invoice.amountPaid);
    const amountToPay = amountInNaira ? toDecimal(amountInNaira) : balanceDue;

    if (amountToPay.lte(0)) {
      throw new Error("Payment amount must be greater than zero");
    }
    if (amountToPay.gt(balanceDue)) {
      throw new Error("Payment amount cannot exceed the balance due");
    }

    const amountInKobo = toKobo(amountToPay);
    const reference = generatePaymentReference(PaymentProvider.PAYSTACK);

    // Create PENDING payment row
    const payment = await tx.payment.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        amount: amountToPay,
        provider: PaymentProvider.PAYSTACK,
        providerRef: reference,
        status: PaymentStatus.PENDING,
        verifiedServerSide: false,
        metadata: {
          tenantId,
          invoiceId: invoice.id,
          studentId: invoice.studentId,
        },
      },
    });

    const gateway = getPaystackClient();
    const gatewayInit = await gateway.initializePayment({
      email: userEmail,
      amountInKobo,
      reference,
      callbackUrl,
      metadata: {
        tenantId,
        invoiceId: invoice.id,
        paymentId: payment.id,
        studentId: invoice.studentId,
      },
    });

    return {
      paymentId: payment.id,
      reference,
      authorizationUrl: gatewayInit.authorizationUrl,
      accessCode: gatewayInit.accessCode,
      amount: amountToPay.toString(),
    };
  });
}

/**
 * Records a manual payment (Cash, POS, Bank Transfer) by staff.
 */
export async function recordManualPayment(
  tenantId: VerifiedTenantId,
  schoolCode: string,
  invoiceId: string,
  data: { amount: DecimalLike; channel: string; receiptNo?: string; note?: string },
  actorUserId: string,
) {
  return forTenant(tenantId).transaction(async (tx) => {
    const invoice = await tx.invoice.findFirstOrThrow({
      where: { tenantId, id: invoiceId },
    });

    if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.WAIVED) {
      throw new Error(`Cannot record payment on invoice with status ${invoice.status}`);
    }

    const amountDecimal = toDecimal(data.amount);
    if (amountDecimal.lte(0)) {
      throw new Error("Payment amount must be positive");
    }

    const reference = generatePaymentReference(PaymentProvider.PAYSTACK);
    const year = new Date().getFullYear();
    const receiptCount = await tx.payment.count({ where: { tenantId, status: PaymentStatus.SUCCESS } });
    const receiptNo = data.receiptNo || generateReceiptNumber(schoolCode, year, receiptCount + 1);

    const payment = await tx.payment.create({
      data: {
        tenantId,
        invoiceId,
        amount: amountDecimal,
        provider: PaymentProvider.PAYSTACK,
        providerRef: reference,
        status: PaymentStatus.SUCCESS,
        verifiedServerSide: true,
        channel: data.channel,
        paidAt: new Date(),
        receiptNo,
        metadata: { note: data.note, recordedByUserId: actorUserId },
      },
    });

    const newAmountPaid = invoice.amountPaid.add(amountDecimal);
    const newStatus = resolveInvoiceStatus(invoice.totalAmount, newAmountPaid);

    await tx.invoice.update({
      where: { tenantId, id: invoiceId },
      data: {
        amountPaid: newAmountPaid,
        status: newStatus,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId,
        action: "payment.manual_record",
        targetType: "Payment",
        targetId: payment.id,
        afterValue: { invoiceId, amount: amountDecimal.toString(), channel: data.channel, newStatus },
      },
    });

    return { payment, receiptNo: payment.receiptNo, newStatus, newAmountPaid: newAmountPaid.toString() };
  });
}

/**
 * ATOMIC PAYMENT FULFILMENT (Roadmap §1.5 T6 & T10)
 *
 * Requirements:
 * - Server-side gateway verification: verifiedServerSide = true.
 * - Concurrency lock: updateMany with status = PENDING.
 * - Redirect-beats-webhook (or vice versa) resolves to exactly one fulfilment.
 * - Amount mismatch throws.
 * - 20 simultaneous fulfilments resolve to one without double-crediting.
 */
export async function fulfillPayment(
  reference: string,
  options?: { expectedAmountKobo?: number; tenantIdOverride?: string },
): Promise<{ success: boolean; alreadyFulfilled: boolean; paymentId: string; invoiceId: string }> {
  const gateway = getPaystackClient();
  const verified = await gateway.verifyTransaction(reference);

  if (verified.status !== "success") {
    throw new Error(`Cannot fulfill payment: gateway status is ${verified.status}`);
  }

  if (options?.expectedAmountKobo !== undefined && verified.amountInKobo !== options.expectedAmountKobo) {
    throw new Error(`Amount mismatch: expected ${options.expectedAmountKobo} kobo but gateway verified ${verified.amountInKobo} kobo`);
  }

  let tenantId: VerifiedTenantId;
  if (options?.tenantIdOverride) {
    tenantId = trustedTenantId(options.tenantIdOverride);
  } else {
    const rawPayment = await prisma.payment.findUnique({
      where: { provider_providerRef: { provider: PaymentProvider.PAYSTACK, providerRef: reference } },
    });
    if (!rawPayment) {
      throw new Error(`Payment with reference "${reference}" not found`);
    }
    tenantId = trustedTenantId(rawPayment.tenantId);
  }

  return forTenant(tenantId).transaction(async (tx) => {
    // ATOMIC LOCK: updateMany where status = PENDING
    const lockResult = await tx.payment.updateMany({
      where: {
        tenantId,
        providerRef: reference,
        status: PaymentStatus.PENDING,
      },
      data: {
        status: PaymentStatus.SUCCESS,
        verifiedServerSide: true,
        paidAt: verified.paidAt ?? new Date(),
        channel: verified.channel ?? "card",
      },
    });

    if (lockResult.count === 0) {
      // Another worker/webhook/callback already won the lock
      const existing = await tx.payment.findFirstOrThrow({
        where: { tenantId, providerRef: reference },
      });
      return {
        success: true,
        alreadyFulfilled: true,
        paymentId: existing.id,
        invoiceId: existing.invoiceId,
      };
    }

    // This thread won the lock
    const payment = await tx.payment.findFirstOrThrow({
      where: { tenantId, providerRef: reference },
      include: { invoice: { include: { tenant: true } } },
    });

    const paymentKobo = toKobo(payment.amount);
    if (paymentKobo !== verified.amountInKobo) {
      throw new Error(`Amount mismatch: payment record requires ${paymentKobo} kobo but gateway confirmed ${verified.amountInKobo} kobo`);
    }

    const schoolCode = payment.invoice.tenant.code || "SCHOOL";
    const year = new Date().getFullYear();
    const count = await tx.payment.count({ where: { tenantId, status: PaymentStatus.SUCCESS } });
    const receiptNo = generateReceiptNumber(schoolCode, year, count);

    await tx.payment.update({
      where: { tenantId, id: payment.id },
      data: { receiptNo },
    });

    const newAmountPaid = payment.invoice.amountPaid.add(payment.amount);
    const newStatus = resolveInvoiceStatus(payment.invoice.totalAmount, newAmountPaid);

    await tx.invoice.update({
      where: { tenantId, id: payment.invoiceId },
      data: {
        amountPaid: newAmountPaid,
        status: newStatus,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId: "system.paystack",
        action: "invoice.payment.fulfilled",
        targetType: "Invoice",
        targetId: payment.invoiceId,
        afterValue: {
          paymentId: payment.id,
          amount: payment.amount.toString(),
          receiptNo,
          newStatus,
        },
      },
    });

    return {
      success: true,
      alreadyFulfilled: false,
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
    };
  });
}

/**
 * Handles incoming Paystack webhook payload.
 * Always records event in PaymentWebhookEvent, verifies raw body HMAC, and triggers fulfillment.
 * Always returns HTTP 200 equivalent.
 */
export async function processPaystackWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secretKey: string,
): Promise<{ status: "processed" | "ignored" | "invalid_signature"; eventId: string; duplicate?: boolean }> {
  const isValid = verifyPaystackSignature(rawBody, signatureHeader, secretKey);
  const rawPayloadHash = computePayloadHash(rawBody);

  let parsed: {
    event?: string;
    data?: {
      id?: number | string;
      reference?: string;
      amount?: number;
      metadata?: { tenantId?: string };
    };
  } = {};
  try {
    parsed = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
  } catch {
    // Malformed JSON is recorded with error
  }

  const eventId = String(parsed?.data?.id || parsed?.data?.reference || `evt_${Date.now()}`);

  const existing = await prisma.paymentWebhookEvent.findUnique({
    where: {
      provider_eventId: {
        provider: PaymentProvider.PAYSTACK,
        eventId,
      },
    },
  });

  if (existing?.processedAt) {
    return { status: "processed", eventId, duplicate: true };
  }

  // Record webhook delivery in PaymentWebhookEvent ledger
  await prisma.paymentWebhookEvent.upsert({
    where: {
      provider_eventId: {
        provider: PaymentProvider.PAYSTACK,
        eventId,
      },
    },
    create: {
      provider: PaymentProvider.PAYSTACK,
      eventId,
      eventType: parsed?.event || null,
      signatureValid: isValid,
      rawPayloadHash,
      processedAt: null,
    },
    update: {
      signatureValid: isValid,
    },
  });

  if (!isValid) {
    return { status: "invalid_signature", eventId, duplicate: false };
  }

  if (parsed?.event === "charge.success" && parsed?.data?.reference) {
    const gateway = getPaystackClient();
    if (gateway instanceof MockPaystackGateway) {
      gateway.simulatePaymentCompletion(parsed.data.reference, "success", parsed.data.amount);
    }

    const tenantIdFromMetadata = parsed.data.metadata?.tenantId;

    await fulfillPayment(parsed.data.reference, {
      expectedAmountKobo: parsed.data.amount,
      tenantIdOverride: tenantIdFromMetadata,
    });

    await prisma.paymentWebhookEvent.update({
      where: {
        provider_eventId: {
          provider: PaymentProvider.PAYSTACK,
          eventId,
        },
      },
      data: { processedAt: new Date() },
    });

    return { status: "processed", eventId, duplicate: false };
  }

  return { status: "ignored", eventId };
}

/**
 * Applies a discount / waiver to an invoice.
 */
export async function applyInvoiceDiscount(
  tenantId: VerifiedTenantId,
  invoiceId: string,
  data: { amount: DecimalLike; reason: string; mode?: DiscountWorkflowMode },
  actorUserId: string,
) {
  return forTenant(tenantId).transaction(async (tx) => {
    const invoice = await tx.invoice.findFirstOrThrow({
      where: { tenantId, id: invoiceId },
      include: { discounts: true },
    });

    if (invoice.status === InvoiceStatus.PAID) {
      throw new Error("Cannot apply discount to an already fully paid invoice");
    }

    const discountAmount = toDecimal(data.amount);
    if (discountAmount.lte(0)) {
      throw new Error("Discount amount must be positive");
    }

    // Verify discount does not exceed balance
    const currentBalance = invoice.totalAmount.sub(invoice.amountPaid);
    if (discountAmount.gt(currentBalance)) {
      throw new Error("Discount cannot exceed the outstanding invoice balance");
    }

    const discount = await tx.invoiceDiscount.create({
      data: {
        tenantId,
        invoiceId,
        amount: discountAmount,
        reason: data.reason.trim(),
        mode: data.mode ?? DiscountWorkflowMode.MANUAL_OVERRIDE,
        appliedByUserId: actorUserId,
      },
    });

    // Net invoice total reduces by discount amount
    const newTotal = invoice.totalAmount.sub(discountAmount);
    const newStatus = resolveInvoiceStatus(newTotal, invoice.amountPaid);

    await tx.invoice.update({
      where: { tenantId, id: invoiceId },
      data: {
        totalAmount: newTotal,
        status: newStatus,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        actorUserId,
        action: "invoice.discount.apply",
        targetType: "InvoiceDiscount",
        targetId: discount.id,
        afterValue: { invoiceId, amount: discountAmount.toString(), reason: data.reason, newStatus },
      },
    });

    return { discount, newTotal: newTotal.toString(), newStatus };
  });
}
