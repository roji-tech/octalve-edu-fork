import { z } from "zod";
import { DiscountWorkflowMode } from "@prisma/client";

export const createFeeStructureSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  amount: z.coerce.number().positive("Amount must be positive"),
  periodId: z.string().trim().min(1, "Academic period ID is required"),
  classGroupId: z.string().trim().min(1).nullable().optional(),
});

export const queryFeeStructuresSchema = z.object({
  periodId: z.string().trim().min(1).optional(),
  classGroupId: z.string().trim().min(1).optional(),
});

export const generateInvoicesSchema = z.object({
  periodId: z.string().trim().min(1, "Academic period ID is required"),
  dueDate: z.string().date().optional(),
});

export const queryInvoicesSchema = z.object({
  periodId: z.string().trim().min(1).optional(),
  studentId: z.string().trim().min(1).optional(),
  status: z.enum(["UNPAID", "PARTIALLY_PAID", "PAID", "WAIVED"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export const initializePaymentSchema = z.object({
  amount: z.coerce.number().positive("Payment amount must be positive").optional(),
  channel: z.string().trim().optional(),
});

export const recordManualPaymentSchema = z.object({
  amount: z.coerce.number().positive("Payment amount must be positive"),
  channel: z.enum(["cash", "bank_transfer", "pos", "cheque", "other"]).default("cash"),
  receiptNo: z.string().trim().optional(),
  note: z.string().trim().max(255).optional(),
});

export const applyDiscountSchema = z.object({
  amount: z.coerce.number().positive("Discount amount must be positive"),
  reason: z.string().trim().min(2, "Reason is required").max(255),
  mode: z.nativeEnum(DiscountWorkflowMode).default(DiscountWorkflowMode.MANUAL_OVERRIDE),
});
