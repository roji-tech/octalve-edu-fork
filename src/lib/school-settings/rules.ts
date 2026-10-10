import { BillingCycle, DiscountWorkflowMode, FeeCostBearer, RolloverMode, type SchoolSettings } from "@prisma/client";

export const ALLOWED_SETTING_FIELDS = [
  "resultApprovalRequired",
  "rolloverMode",
  "classAutoAssignment",
  "billingCycle",
  "feeReminderEnabled",
  "discountWorkflowMode",
  "feeCostBearer",
  "multiCampusEnabled",
  "mfaRequiredForTeaching",
] as const;

export type UpdatableSettingField = (typeof ALLOWED_SETTING_FIELDS)[number];

export interface UpdatableSettings {
  resultApprovalRequired?: boolean;
  rolloverMode?: RolloverMode;
  classAutoAssignment?: boolean;
  billingCycle?: BillingCycle;
  feeReminderEnabled?: boolean;
  discountWorkflowMode?: DiscountWorkflowMode;
  feeCostBearer?: FeeCostBearer;
  multiCampusEnabled?: boolean;
  mfaRequiredForTeaching?: boolean;
}

export interface SettingsDelta {
  field: UpdatableSettingField;
  fromValue: string;
  toValue: string;
  isWeakeningSecurity: boolean;
}

/// Identifies whether a transition represents weakening a security control (PRD §14).
export function isControlWeakened(field: UpdatableSettingField, fromValue: unknown, toValue: unknown): boolean {
  if (field === "resultApprovalRequired" && fromValue === true && toValue === false) {
    return true;
  }
  if (field === "mfaRequiredForTeaching" && fromValue === true && toValue === false) {
    return true;
  }
  if (field === "discountWorkflowMode" && fromValue === "APPROVAL_REQUIRED" && toValue === "MANUAL_OVERRIDE") {
    return true;
  }
  return false;
}

/// Stringifies a setting value consistently for immutable audit storage.
export function stringifySettingValue(val: unknown): string {
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "string") return val;
  return String(val);
}

/// Computes the minimal atomic diff between current settings and requested updates.
/// Fields that are unchanged are omitted.
export function computeSettingsDeltas(current: Pick<SchoolSettings, UpdatableSettingField>, requested: UpdatableSettings): SettingsDelta[] {
  const deltas: SettingsDelta[] = [];

  for (const field of ALLOWED_SETTING_FIELDS) {
    if (field in requested && requested[field] !== undefined) {
      const from = current[field];
      const to = requested[field];

      if (from !== to) {
        const fromStr = stringifySettingValue(from);
        const toStr = stringifySettingValue(to);

        deltas.push({
          field,
          fromValue: fromStr,
          toValue: toStr,
          isWeakeningSecurity: isControlWeakened(field, from, to),
        });
      }
    }
  }

  return deltas;
}

/// Pure validation of the raw update payload.
export function validateSettingsPayload(payload: unknown):
  | {
      ok: true;
      data: UpdatableSettings;
    }
  | {
      ok: false;
      errors: string[];
    } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["Payload must be an object of settings key-value pairs."] };
  }

  const raw = payload as Record<string, unknown>;
  const errors: string[] = [];
  const clean: UpdatableSettings = {};

  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return { ok: false, errors: ["At least one setting must be provided to update."] };
  }

  for (const key of keys) {
    if (!ALLOWED_SETTING_FIELDS.includes(key as UpdatableSettingField)) {
      errors.push(`Unrecognized or non-modifiable settings field: "${key}".`);
      continue;
    }

    const settingKey = key as UpdatableSettingField;
    const val = raw[key];
    switch (settingKey) {
      case "resultApprovalRequired":
      case "classAutoAssignment":
      case "feeReminderEnabled":
      case "multiCampusEnabled":
      case "mfaRequiredForTeaching":
        if (typeof val !== "boolean") {
          errors.push(`Field "${key}" must be a boolean.`);
        } else {
          clean[settingKey] = val;
        }
        break;

      case "rolloverMode":
        if (val !== RolloverMode.AUTOMATIC && val !== RolloverMode.ADMIN_CONFIRMED) {
          errors.push(`Field "${key}" must be one of: ${Object.values(RolloverMode).join(", ")}.`);
        } else {
          clean[settingKey] = val as RolloverMode;
        }
        break;

      case "billingCycle":
        if (val !== BillingCycle.PER_TERM && val !== BillingCycle.PER_SESSION) {
          errors.push(`Field "${key}" must be one of: ${Object.values(BillingCycle).join(", ")}.`);
        } else {
          clean[settingKey] = val as BillingCycle;
        }
        break;

      case "discountWorkflowMode":
        if (val !== DiscountWorkflowMode.MANUAL_OVERRIDE && val !== DiscountWorkflowMode.APPROVAL_REQUIRED) {
          errors.push(`Field "${key}" must be one of: ${Object.values(DiscountWorkflowMode).join(", ")}.`);
        } else {
          clean[settingKey] = val as DiscountWorkflowMode;
        }
        break;

      case "feeCostBearer":
        if (val !== FeeCostBearer.SCHOOL_ABSORBS && val !== FeeCostBearer.PASSED_TO_PARENT) {
          errors.push(`Field "${key}" must be one of: ${Object.values(FeeCostBearer).join(", ")}.`);
        } else {
          clean[settingKey] = val as FeeCostBearer;
        }
        break;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, data: clean };
}
