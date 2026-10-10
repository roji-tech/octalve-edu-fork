import { z } from "zod";
import { BillingCycle, DiscountWorkflowMode, FeeCostBearer, RolloverMode } from "@prisma/client";

export const stepUpProofSchema = z.object({
  type: z.enum(["totp", "recovery", "password"]),
  value: z.string().min(1, "Step-up authentication proof is required").max(256),
});

export const updateSettingsSchema = z.object({
  changes: z
    .object({
      resultApprovalRequired: z.boolean().optional(),
      rolloverMode: z.nativeEnum(RolloverMode).optional(),
      classAutoAssignment: z.boolean().optional(),
      billingCycle: z.nativeEnum(BillingCycle).optional(),
      feeReminderEnabled: z.boolean().optional(),
      discountWorkflowMode: z.nativeEnum(DiscountWorkflowMode).optional(),
      feeCostBearer: z.nativeEnum(FeeCostBearer).optional(),
      multiCampusEnabled: z.boolean().optional(),
      mfaRequiredForTeaching: z.boolean().optional(),
    })
    .refine((obj) => Object.keys(obj).length > 0, {
      message: "At least one setting must be provided to update.",
    }),
  stepUp: stepUpProofSchema,
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type StepUpProofInput = z.infer<typeof stepUpProofSchema>;
