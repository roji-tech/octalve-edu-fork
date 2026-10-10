import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { InvoiceStatus, PaymentProvider } from "@prisma/client";

export type DecimalLike = Prisma.Decimal | number | string;

export function toDecimal(val: DecimalLike): Prisma.Decimal {
  if (val instanceof Prisma.Decimal) return val;
  return new Prisma.Decimal(val);
}

/**
 * Converts Naira (Decimal or number) to integer kobo for payment gateways.
 * 1 Naira = 100 Kobo.
 */
export function toKobo(naira: DecimalLike): number {
  const d = toDecimal(naira);
  if (d.isNegative()) {
    throw new Error("Amount in Naira cannot be negative");
  }
  const kobo = d.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  return kobo.toNumber();
}

/**
 * Converts integer kobo to Decimal Naira.
 */
export function toNairaDecimal(kobo: number): Prisma.Decimal {
  if (kobo < 0 || !Number.isInteger(kobo)) {
    throw new Error("Kobo amount must be a non-negative integer");
  }
  return new Prisma.Decimal(kobo).div(100);
}

/**
 * Formats Naira currency representation with thousand separators.
 * E.g. "₦125,000.00"
 */
export function formatNaira(naira: DecimalLike): string {
  const d = toDecimal(naira);
  const num = d.toNumber();
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}

/**
 * Resolves invoice lifecycle status from due amount and payments.
 */
export function resolveInvoiceStatus(totalDue: DecimalLike, amountPaid: DecimalLike, options?: { isWaived?: boolean }): InvoiceStatus {
  if (options?.isWaived) {
    return InvoiceStatus.WAIVED;
  }

  const due = toDecimal(totalDue);
  const paid = toDecimal(amountPaid);

  if (paid.lte(0)) {
    return InvoiceStatus.UNPAID;
  }
  if (paid.gte(due)) {
    return InvoiceStatus.PAID;
  }
  return InvoiceStatus.PARTIALLY_PAID;
}

/**
 * Generates human-readable invoice reference string.
 */
export function generateInvoiceNumber(schoolCode: string, year: number, seq: number): string {
  const code = schoolCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const paddedSeq = String(seq).padStart(4, "0");
  return `INV-${code}-${year}-${paddedSeq}`;
}

/**
 * Generates human-readable receipt reference string.
 */
export function generateReceiptNumber(schoolCode: string, year: number, seq: number): string {
  const code = schoolCode
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const paddedSeq = String(seq).padStart(4, "0");
  return `RCP-${code}-${year}-${paddedSeq}`;
}

/**
 * Generates a unique, URL-safe transaction payment reference.
 */
export function generatePaymentReference(provider: PaymentProvider = PaymentProvider.PAYSTACK): string {
  const prefix = provider === PaymentProvider.PAYSTACK ? "oct_pay" : "oct_flw";
  const token = crypto.randomBytes(12).toString("hex");
  return `${prefix}_${Date.now()}_${token}`;
}

/**
 * Computes net invoice sum from line items and discounts.
 */
export function computeInvoiceBreakdown(
  lineItems: { amount: DecimalLike }[],
  discounts: { amount: DecimalLike }[] = [],
): { grossAmount: Prisma.Decimal; totalDiscount: Prisma.Decimal; netAmount: Prisma.Decimal } {
  let gross = new Prisma.Decimal(0);
  for (const item of lineItems) {
    const itemAmount = toDecimal(item.amount);
    if (itemAmount.isNegative()) {
      throw new Error("Line item amount cannot be negative");
    }
    gross = gross.add(itemAmount);
  }

  let totalDiscount = new Prisma.Decimal(0);
  for (const discount of discounts) {
    const discountAmount = toDecimal(discount.amount);
    if (discountAmount.isNegative()) {
      throw new Error("Discount amount cannot be negative");
    }
    totalDiscount = totalDiscount.add(discountAmount);
  }

  if (totalDiscount.gt(gross)) {
    throw new Error("Total discounts cannot exceed the gross invoice amount");
  }

  const netAmount = gross.sub(totalDiscount);
  return { grossAmount: gross, totalDiscount, netAmount };
}
