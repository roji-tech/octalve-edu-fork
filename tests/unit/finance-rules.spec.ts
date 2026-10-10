import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { Prisma, InvoiceStatus, PaymentProvider } from "@prisma/client";
import {
  toKobo,
  toNairaDecimal,
  formatNaira,
  resolveInvoiceStatus,
  generateInvoiceNumber,
  generateReceiptNumber,
  generatePaymentReference,
  computeInvoiceBreakdown,
} from "@/lib/finance/rules";
import { verifyPaystackSignature, computePayloadHash } from "@/lib/finance/crypto";

test.describe("finance rules: currency and kobo conversions", () => {
  test("toKobo converts Decimal and numbers correctly", () => {
    expect(toKobo(100)).toBe(10000);
    expect(toKobo(150.5)).toBe(15050);
    expect(toKobo("250.75")).toBe(25075);
    expect(toKobo(new Prisma.Decimal("125000.00"))).toBe(12500000);
    expect(toKobo(0)).toBe(0);
  });

  test("toKobo rejects negative amounts", () => {
    expect(() => toKobo(-50)).toThrow(/cannot be negative/);
    expect(() => toKobo("-1.00")).toThrow(/cannot be negative/);
  });

  test("toNairaDecimal converts integer kobo to Decimal Naira", () => {
    const d1 = toNairaDecimal(10050);
    expect(d1.toString()).toBe("100.5");
    expect(d1.toFixed(2)).toBe("100.50");

    const d2 = toNairaDecimal(0);
    expect(d2.toString()).toBe("0");

    expect(() => toNairaDecimal(-100)).toThrow(/non-negative integer/);
    expect(() => toNairaDecimal(12.5)).toThrow(/non-negative integer/);
  });

  test("formatNaira formats human-readable currency with symbol", () => {
    const formatted = formatNaira(150000);
    expect(formatted).toMatch(/150,000\.00/);
    expect(formatted).toContain("₦");
  });
});

test.describe("finance rules: invoice lifecycle and breakdown", () => {
  test("resolveInvoiceStatus tracks unpaid, partial, paid, and waived states", () => {
    expect(resolveInvoiceStatus(1000, 0)).toBe(InvoiceStatus.UNPAID);
    expect(resolveInvoiceStatus(1000, 500)).toBe(InvoiceStatus.PARTIALLY_PAID);
    expect(resolveInvoiceStatus(1000, 1000)).toBe(InvoiceStatus.PAID);
    expect(resolveInvoiceStatus(1000, 1200)).toBe(InvoiceStatus.PAID);
    expect(resolveInvoiceStatus(1000, 500, { isWaived: true })).toBe(InvoiceStatus.WAIVED);
  });

  test("computeInvoiceBreakdown computes gross, discount, and net amounts", () => {
    const breakdown = computeInvoiceBreakdown([{ amount: "50000" }, { amount: "20000" }, { amount: "5000" }], [{ amount: "10000" }]);
    expect(breakdown.grossAmount.toString()).toBe("75000");
    expect(breakdown.totalDiscount.toString()).toBe("10000");
    expect(breakdown.netAmount.toString()).toBe("65000");
  });

  test("computeInvoiceBreakdown rejects discounts exceeding gross amount", () => {
    expect(() => computeInvoiceBreakdown([{ amount: "50000" }], [{ amount: "60000" }])).toThrow(/Total discounts cannot exceed/);
  });

  test("generates uniform invoice and receipt reference strings", () => {
    expect(generateInvoiceNumber("al-eemaan", 2026, 42)).toBe("INV-ALEEMAAN-2026-0042");
    expect(generateReceiptNumber("al-eemaan", 2026, 7)).toBe("RCP-ALEEMAAN-2026-0007");
    expect(generatePaymentReference(PaymentProvider.PAYSTACK)).toMatch(/^oct_pay_\d+_[a-f0-9]{24}$/);
  });
});

test.describe("finance crypto: webhook signature verification", () => {
  const secretKey = "sk_test_mock_secret_key_12345";
  const payloadObject = {
    event: "charge.success",
    data: {
      id: 998877,
      reference: "oct_pay_test_ref_1",
      amount: 1500000,
      currency: "NGN",
      status: "success",
    },
  };
  const rawBody = JSON.stringify(payloadObject);

  function signPayload(body: string, key: string): string {
    return crypto.createHmac("sha512", key).update(body).digest("hex");
  }

  test("verifies valid Paystack HMAC-SHA512 signature", () => {
    const sig = signPayload(rawBody, secretKey);
    expect(verifyPaystackSignature(rawBody, sig, secretKey)).toBe(true);
  });

  test("refuses tampered payload with unchanged signature", () => {
    const sig = signPayload(rawBody, secretKey);
    const tamperedBody = JSON.stringify({ ...payloadObject, event: "charge.failed" });
    expect(verifyPaystackSignature(tamperedBody, sig, secretKey)).toBe(false);
  });

  test("refuses re-stringified payload with re-ordered keys", () => {
    const sig = signPayload(rawBody, secretKey);
    const reorderedBody = JSON.stringify({
      data: payloadObject.data,
      event: payloadObject.event,
    });
    expect(verifyPaystackSignature(reorderedBody, sig, secretKey)).toBe(false);
  });

  test("refuses invalid or empty signatures gracefully", () => {
    expect(verifyPaystackSignature(rawBody, "", secretKey)).toBe(false);
    expect(verifyPaystackSignature(rawBody, null, secretKey)).toBe(false);
    expect(verifyPaystackSignature(rawBody, "bad_hex", secretKey)).toBe(false);
    expect(verifyPaystackSignature(rawBody, "0".repeat(128), secretKey)).toBe(false);
  });

  test("computePayloadHash computes deterministic sha256 hash", () => {
    const hash1 = computePayloadHash(rawBody);
    const hash2 = computePayloadHash(rawBody);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });
});
