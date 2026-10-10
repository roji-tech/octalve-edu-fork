import { expect, test } from "@playwright/test";
import { BillingCycle, DiscountWorkflowMode, FeeCostBearer, RolloverMode, type SchoolSettings } from "@prisma/client";
import { computeSettingsDeltas, isControlWeakened, stringifySettingValue, validateSettingsPayload } from "@/lib/school-settings/rules";

test.describe("SchoolSettings Pure Rules", () => {
  const baseSettings: SchoolSettings = {
    tenantId: "school-123",
    resultApprovalRequired: true,
    rolloverMode: RolloverMode.ADMIN_CONFIRMED,
    classAutoAssignment: false,
    billingCycle: BillingCycle.PER_TERM,
    feeReminderEnabled: true,
    discountWorkflowMode: DiscountWorkflowMode.MANUAL_OVERRIDE,
    feeCostBearer: FeeCostBearer.SCHOOL_ABSORBS,
    multiCampusEnabled: false,
    mfaRequiredForTeaching: true,
    updatedAt: new Date("2026-10-10T12:00:00Z"),
  };

  test("validates valid payload with single and multiple fields", () => {
    const res1 = validateSettingsPayload({ resultApprovalRequired: false });
    expect(res1.ok).toBe(true);
    if (res1.ok) {
      expect(res1.data).toEqual({ resultApprovalRequired: false });
    }

    const res2 = validateSettingsPayload({
      billingCycle: BillingCycle.PER_SESSION,
      multiCampusEnabled: true,
      rolloverMode: RolloverMode.AUTOMATIC,
    });
    expect(res2.ok).toBe(true);
    if (res2.ok) {
      expect(res2.data).toEqual({
        billingCycle: "PER_SESSION",
        multiCampusEnabled: true,
        rolloverMode: "AUTOMATIC",
      });
    }
  });

  test("rejects empty or non-object payloads", () => {
    expect(validateSettingsPayload({})).toEqual({
      ok: false,
      errors: ["At least one setting must be provided to update."],
    });
    expect(validateSettingsPayload(null)).toEqual({
      ok: false,
      errors: ["Payload must be an object of settings key-value pairs."],
    });
    expect(validateSettingsPayload([1, 2, 3])).toEqual({
      ok: false,
      errors: ["Payload must be an object of settings key-value pairs."],
    });
  });

  test("rejects unrecognized or non-updatable fields", () => {
    const res = validateSettingsPayload({
      tenantId: "hacked",
      arbitraryField: 123,
      resultApprovalRequired: true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain('Unrecognized or non-modifiable settings field: "tenantId".');
      expect(res.errors).toContain('Unrecognized or non-modifiable settings field: "arbitraryField".');
    }
  });

  test("rejects invalid types and illegal enum values", () => {
    const res = validateSettingsPayload({
      resultApprovalRequired: "yes",
      rolloverMode: "MANUAL",
      billingCycle: "MONTHLY",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toContain('Field "resultApprovalRequired" must be a boolean.');
      expect(res.errors).toContain('Field "rolloverMode" must be one of: AUTOMATIC, ADMIN_CONFIRMED.');
      expect(res.errors).toContain('Field "billingCycle" must be one of: PER_TERM, PER_SESSION.');
    }
  });

  test("computeSettingsDeltas computes exact diffs and ignores unchanged fields", () => {
    const deltas = computeSettingsDeltas(baseSettings, {
      resultApprovalRequired: false,
      rolloverMode: RolloverMode.ADMIN_CONFIRMED, // unchanged!
      billingCycle: BillingCycle.PER_SESSION,
    });

    expect(deltas).toHaveLength(2);
    expect(deltas).toEqual([
      {
        field: "resultApprovalRequired",
        fromValue: "true",
        toValue: "false",
        isWeakeningSecurity: true,
      },
      {
        field: "billingCycle",
        fromValue: "PER_TERM",
        toValue: "PER_SESSION",
        isWeakeningSecurity: false,
      },
    ]);
  });

  test("isControlWeakened correctly identifies security relaxations", () => {
    // Relaxing result approval
    expect(isControlWeakened("resultApprovalRequired", true, false)).toBe(true);
    // Hardening result approval
    expect(isControlWeakened("resultApprovalRequired", false, true)).toBe(false);

    // Disabling teacher MFA
    expect(isControlWeakened("mfaRequiredForTeaching", true, false)).toBe(true);
    // Enabling teacher MFA
    expect(isControlWeakened("mfaRequiredForTeaching", false, true)).toBe(false);

    // Removing approval workflow from discounts
    expect(isControlWeakened("discountWorkflowMode", DiscountWorkflowMode.APPROVAL_REQUIRED, DiscountWorkflowMode.MANUAL_OVERRIDE)).toBe(
      true,
    );
    // Strengthening discount workflow
    expect(isControlWeakened("discountWorkflowMode", DiscountWorkflowMode.MANUAL_OVERRIDE, DiscountWorkflowMode.APPROVAL_REQUIRED)).toBe(
      false,
    );

    // Neutral settings
    expect(isControlWeakened("multiCampusEnabled", false, true)).toBe(false);
    expect(isControlWeakened("billingCycle", "PER_TERM", "PER_SESSION")).toBe(false);
  });

  test("stringifySettingValue formats consistently", () => {
    expect(stringifySettingValue(true)).toBe("true");
    expect(stringifySettingValue(false)).toBe("false");
    expect(stringifySettingValue("PER_TERM")).toBe("PER_TERM");
  });
});
