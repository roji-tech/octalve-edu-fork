"use client";

import { useMemo, useState } from "react";
import { BillingCycle, DiscountWorkflowMode, FeeCostBearer, RolloverMode } from "@prisma/client";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { SelectField } from "@/components/ui/SelectField";
import { AlertTriangleIcon, BuildingIcon, CalendarIcon, CheckIcon, ShieldCheckIcon, SlidersIcon } from "@/components/ui/icons";
import { useApi } from "@/components/academics/useApi";
import { sendJson } from "@/components/auth/postJson";
import { computeSettingsDeltas, type UpdatableSettings } from "@/lib/school-settings/rules";
import type { SchoolSettingsDetail } from "@/lib/school-settings/service";
import { SettingsAuditLog } from "./SettingsAuditLog";
import { StepUpModal } from "./StepUpModal";

interface SchoolSettingsPanelProps {
  schoolCode: string;
}

export function SchoolSettingsPanel({ schoolCode }: SchoolSettingsPanelProps) {
  const { reply, loading, error, reload } = useApi(`/api/v1/schools/${schoolCode}/settings`);
  const [activeTab, setActiveTab] = useState<"settings" | "audit">("settings");

  // Staged modifications
  const [staged, setStaged] = useState<UpdatableSettings>({});
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const detail = reply?.data as SchoolSettingsDetail | undefined;
  const currentSettings = detail?.settings;
  const auditLog = detail?.auditLog ?? [];
  const hasMfa = detail?.hasMfa ?? false;

  // Active settings merged with staged overrides
  const effectiveSettings = useMemo(() => {
    if (!currentSettings) return null;
    return {
      ...currentSettings,
      ...staged,
    };
  }, [currentSettings, staged]);

  // Compute pending deltas
  const pendingDeltas = useMemo(() => {
    if (!currentSettings) return [];
    return computeSettingsDeltas(currentSettings, staged);
  }, [currentSettings, staged]);

  const hasChanges = pendingDeltas.length > 0;

  const handleToggle = (field: keyof UpdatableSettings) => {
    if (!effectiveSettings) return;
    const currentVal = effectiveSettings[field] as boolean;
    const newVal = !currentVal;

    setStaged((prev) => ({
      ...prev,
      [field]: newVal,
    }));
    setSaveSuccess(null);
  };

  const handleSelect = (field: keyof UpdatableSettings, value: string) => {
    setStaged((prev) => ({
      ...prev,
      [field]: value,
    }));
    setSaveSuccess(null);
  };

  const handleReset = () => {
    setStaged({});
    setSaveError(null);
    setSaveSuccess(null);
  };

  const handleConfirmStepUp = async (stepUp: { type: "totp" | "recovery" | "password"; value: string }) => {
    setSaving(true);
    setSaveError(null);

    try {
      const res = await sendJson(`/api/v1/schools/${schoolCode}/settings`, "PATCH", {
        changes: staged,
        stepUp,
      });

      if (!res.ok) {
        setSaveError(res.message || "Failed to update settings. Please check your credentials.");
        setSaving(false);
        return;
      }

      setSaving(false);
      setStepUpOpen(false);
      setStaged({});
      setSaveSuccess("School configuration updated successfully and recorded in audit log.");
      await reload(true);
    } catch {
      setSaveError("A network error occurred while updating settings.");
      setSaving(false);
    }
  };

  if (loading && !detail) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-line bg-surface">
        <p className="text-sm text-fg-muted">Loading school configuration...</p>
      </div>
    );
  }

  if (error || !effectiveSettings) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-6">
        <Alert variant="error">{error || "Failed to load school settings."}</Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Tab Navigation */}
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("settings")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
              activeTab === "settings" ? "bg-brand-tint text-brand-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            <SlidersIcon className="h-4 w-4" />
            Configuration
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("audit")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
              activeTab === "audit" ? "bg-brand-tint text-brand-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            <ShieldCheckIcon className="h-4 w-4" />
            Audit History ({auditLog.length})
          </button>
        </div>

        {hasChanges && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            {pendingDeltas.length} unsaved {pendingDeltas.length === 1 ? "change" : "changes"}
          </span>
        )}
      </div>

      {saveSuccess && <Alert variant="success">{saveSuccess}</Alert>}

      {activeTab === "audit" ? (
        <SettingsAuditLog auditLog={auditLog} />
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {/* Section 1: Academic & Grading Controls */}
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-xs space-y-5">
            <div className="flex items-center gap-3 border-b border-line pb-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-tint text-brand-fg">
                <CalendarIcon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-fg">Academic & Grading Controls</h3>
                <p className="text-xs text-fg-muted">Examination publishing and student rollover automation</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Result Approval Required */}
              <div className="flex items-start justify-between gap-4 pt-1">
                <div className="space-y-0.5">
                  <label htmlFor="result-approval-toggle" className="text-xs font-semibold text-fg cursor-pointer">
                    Result Approval Workflow
                  </label>
                  <p className="text-xs text-fg-muted">
                    When enabled, scores must transition from DRAFT &rarr; SUBMITTED &rarr; APPROVED before publishing to parents.
                  </p>
                </div>
                <button
                  type="button"
                  id="result-approval-toggle"
                  role="switch"
                  aria-checked={effectiveSettings.resultApprovalRequired}
                  onClick={() => handleToggle("resultApprovalRequired")}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                    effectiveSettings.resultApprovalRequired ? "bg-brand" : "bg-line"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow-sm transition-transform ${
                      effectiveSettings.resultApprovalRequired ? "translate-x-5" : "translate-x-0.5"
                    } mt-0.5`}
                  />
                </button>
              </div>

              {/* Rollover Mode */}
              <SelectField
                label="Year-End Student Rollover"
                value={effectiveSettings.rolloverMode}
                onChange={(e) => handleSelect("rolloverMode", e.target.value)}
                options={[
                  { value: RolloverMode.ADMIN_CONFIRMED, label: "Admin-Confirmed (Bursar/Admin approves batch)" },
                  { value: RolloverMode.AUTOMATIC, label: "Automatic (Session close triggers student advancement)" },
                ]}
                hint="Governs whether promotion/graduation runs automatically on session closure or requires explicit review."
              />

              {/* Class Auto-Assignment */}
              <div className="flex items-start justify-between gap-4 pt-2">
                <div className="space-y-0.5">
                  <label htmlFor="class-auto-assign-toggle" className="text-xs font-semibold text-fg cursor-pointer">
                    Class Arm Auto-Assignment
                  </label>
                  <p className="text-xs text-fg-muted">
                    Automatically balance and stream enrolled students into class arms based on seat capacity.
                  </p>
                </div>
                <button
                  type="button"
                  id="class-auto-assign-toggle"
                  role="switch"
                  aria-checked={effectiveSettings.classAutoAssignment}
                  onClick={() => handleToggle("classAutoAssignment")}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                    effectiveSettings.classAutoAssignment ? "bg-brand" : "bg-line"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow-sm transition-transform ${
                      effectiveSettings.classAutoAssignment ? "translate-x-5" : "translate-x-0.5"
                    } mt-0.5`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Section 2: Finance & Invoicing Controls */}
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-xs space-y-5">
            <div className="flex items-center gap-3 border-b border-line pb-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-tint text-brand-fg">
                <BuildingIcon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-fg">Finance & Billing Workflows</h3>
                <p className="text-xs text-fg-muted">Billing cycles, automated reminders, and cost bearer policies</p>
              </div>
            </div>

            <div className="space-y-4">
              {/* Billing Cycle */}
              <SelectField
                label="Default Billing Cycle"
                value={effectiveSettings.billingCycle}
                onChange={(e) => handleSelect("billingCycle", e.target.value)}
                options={[
                  { value: BillingCycle.PER_TERM, label: "Per Term (Termly invoicing & fee structures)" },
                  { value: BillingCycle.PER_SESSION, label: "Per Session (Annual single session billing)" },
                ]}
                hint="Controls the default frequency for recurring tuition and fee generation."
              />

              {/* Discount / Waiver Workflow */}
              <SelectField
                label="Discount & Waiver Mode"
                value={effectiveSettings.discountWorkflowMode}
                onChange={(e) => handleSelect("discountWorkflowMode", e.target.value)}
                options={[
                  { value: DiscountWorkflowMode.MANUAL_OVERRIDE, label: "Manual Bursar Override (Direct audit log)" },
                  { value: DiscountWorkflowMode.APPROVAL_REQUIRED, label: "Multi-Step Approval Required (Admin sign-off)" },
                ]}
                hint="Governs whether staff can apply fee discounts directly or if administrator sign-off is mandatory."
              />

              {/* Fee Cost Bearer */}
              <SelectField
                label="Payment Gateway Cost Bearer"
                value={effectiveSettings.feeCostBearer}
                onChange={(e) => handleSelect("feeCostBearer", e.target.value)}
                options={[
                  { value: FeeCostBearer.SCHOOL_ABSORBS, label: "School Absorbs (Net deduction from payout)" },
                  { value: FeeCostBearer.PASSED_TO_PARENT, label: "Passed to Parent (Surcharged at checkout)" },
                ]}
                hint="Determines whether Paystack processing and transaction fees are paid by the school or added to the parent's total."
              />

              {/* Automated Fee Reminders */}
              <div className="flex items-start justify-between gap-4 pt-1">
                <div className="space-y-0.5">
                  <label htmlFor="fee-reminder-toggle" className="text-xs font-semibold text-fg cursor-pointer">
                    Automated Fee Reminders
                  </label>
                  <p className="text-xs text-fg-muted">
                    Send automated payment notifications via email and WhatsApp links when invoices approach due date.
                  </p>
                </div>
                <button
                  type="button"
                  id="fee-reminder-toggle"
                  role="switch"
                  aria-checked={effectiveSettings.feeReminderEnabled}
                  onClick={() => handleToggle("feeReminderEnabled")}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                    effectiveSettings.feeReminderEnabled ? "bg-brand" : "bg-line"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow-sm transition-transform ${
                      effectiveSettings.feeReminderEnabled ? "translate-x-5" : "translate-x-0.5"
                    } mt-0.5`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* Section 3: Security & Architecture (Spans 2 columns) */}
          <div className="rounded-2xl border border-line bg-surface p-5 shadow-xs space-y-5 md:col-span-2">
            <div className="flex items-center gap-3 border-b border-line pb-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-tint text-brand-fg">
                <AlertTriangleIcon className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-fg">Security & Multi-Campus Architecture</h3>
                <p className="text-xs text-fg-muted">Tenant boundaries and privileged identity enforcement</p>
              </div>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              {/* Teaching Staff MFA */}
              <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-field/30 p-4">
                <div className="space-y-0.5">
                  <label htmlFor="mfa-teaching-toggle" className="text-xs font-bold text-fg cursor-pointer">
                    Mandatory MFA for Teaching Staff
                  </label>
                  <p className="text-xs text-fg-muted">
                    Requires two-factor authentication (TOTP or recovery codes) before teachers can enter scores or mark attendance.
                  </p>
                </div>
                <button
                  type="button"
                  id="mfa-teaching-toggle"
                  role="switch"
                  aria-checked={effectiveSettings.mfaRequiredForTeaching}
                  onClick={() => handleToggle("mfaRequiredForTeaching")}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                    effectiveSettings.mfaRequiredForTeaching ? "bg-brand" : "bg-line"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow-sm transition-transform ${
                      effectiveSettings.mfaRequiredForTeaching ? "translate-x-5" : "translate-x-0.5"
                    } mt-0.5`}
                  />
                </button>
              </div>

              {/* Multi-Campus */}
              <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-field/30 p-4">
                <div className="space-y-0.5">
                  <label htmlFor="multi-campus-toggle" className="text-xs font-bold text-fg cursor-pointer">
                    Multi-Campus Mode
                  </label>
                  <p className="text-xs text-fg-muted">
                    Enable branch-level campus division within this single institution, allowing campus-specific filtering.
                  </p>
                </div>
                <button
                  type="button"
                  id="multi-campus-toggle"
                  role="switch"
                  aria-checked={effectiveSettings.multiCampusEnabled}
                  onClick={() => handleToggle("multiCampusEnabled")}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                    effectiveSettings.multiCampusEnabled ? "bg-brand" : "bg-line"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-surface shadow-sm transition-transform ${
                      effectiveSettings.multiCampusEnabled ? "translate-x-5" : "translate-x-0.5"
                    } mt-0.5`}
                  />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Staged Changes Bar */}
      {hasChanges && (
        <div className="sticky bottom-6 z-20 flex items-center justify-between rounded-2xl border border-line bg-surface/95 p-4 shadow-lg backdrop-blur-md">
          <div className="flex items-center gap-2">
            <span className="flex h-2.5 w-2.5 rounded-full bg-brand" />
            <span className="text-sm font-semibold text-fg">
              {pendingDeltas.length} {pendingDeltas.length === 1 ? "setting modified" : "settings modified"}
            </span>
            <span className="text-xs text-fg-muted hidden sm:inline">&mdash; Step-up verification required to apply</span>
          </div>

          <div className="flex items-center gap-3">
            <Button type="button" variant="ghost" onClick={handleReset} disabled={saving}>
              Discard
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                setSaveError(null);
                setStepUpOpen(true);
              }}
              disabled={saving}
            >
              <CheckIcon className="h-4 w-4 mr-1" />
              Review & Save Changes
            </Button>
          </div>
        </div>
      )}

      {/* Step-Up Re-Authentication Modal */}
      <StepUpModal
        open={stepUpOpen}
        onClose={() => setStepUpOpen(false)}
        onConfirm={handleConfirmStepUp}
        hasMfa={hasMfa}
        deltas={pendingDeltas}
        saving={saving}
        error={saveError}
      />
    </div>
  );
}
