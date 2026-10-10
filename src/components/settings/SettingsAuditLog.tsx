"use client";

import { ShieldCheckIcon } from "@/components/ui/icons";
import type { AuditEntryWithActor } from "@/lib/school-settings/service";

const FIELD_LABELS: Record<string, string> = {
  resultApprovalRequired: "Result Approval Required",
  rolloverMode: "Year-End Rollover Mode",
  classAutoAssignment: "Class Auto-Assignment",
  billingCycle: "Default Billing Cycle",
  feeReminderEnabled: "Automated Fee Reminders",
  discountWorkflowMode: "Discount / Waiver Workflow Mode",
  feeCostBearer: "Transaction Cost Bearer",
  multiCampusEnabled: "Multi-Campus Architecture",
  mfaRequiredForTeaching: "MFA Mandatory for Teaching Staff",
};

interface SettingsAuditLogProps {
  auditLog: AuditEntryWithActor[];
}

export function SettingsAuditLog({ auditLog }: SettingsAuditLogProps) {
  if (auditLog.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-8 text-center text-sm text-fg-muted">
        <p>No configuration modifications have been recorded yet.</p>
        <p className="mt-1 text-xs">All future configuration changes will appear in this immutable tamper-evident audit ledger.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xs">
      <div className="border-b border-line px-5 py-4">
        <h3 className="text-base font-semibold text-fg">Immutable Change History</h3>
        <p className="text-xs text-fg-muted mt-0.5">
          Recorded audit trail of administrative modifications, protected with step-up verification.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line bg-field/40 text-fg-muted font-medium">
            <tr>
              <th className="px-5 py-3">Timestamp</th>
              <th className="px-5 py-3">Actor</th>
              <th className="px-5 py-3">Setting Field</th>
              <th className="px-5 py-3">Previous Value</th>
              <th className="px-5 py-3">New Value</th>
              <th className="px-5 py-3 text-right">Verification</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {auditLog.map((entry) => (
              <tr key={entry.id} className="hover:bg-field/20 transition-colors">
                <td className="px-5 py-3 whitespace-nowrap text-fg-muted font-mono">
                  {new Date(entry.createdAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </td>
                <td className="px-5 py-3 whitespace-nowrap">
                  <div className="font-medium text-fg">{entry.actorName}</div>
                  <div className="text-[11px] text-fg-muted">{entry.actorEmail}</div>
                </td>
                <td className="px-5 py-3 whitespace-nowrap font-medium text-fg">{FIELD_LABELS[entry.field] ?? entry.field}</td>
                <td className="px-5 py-3 whitespace-nowrap">
                  <span className="inline-block rounded-md bg-field px-2 py-0.5 font-mono text-[11px] text-fg-muted line-through">
                    {entry.fromValue}
                  </span>
                </td>
                <td className="px-5 py-3 whitespace-nowrap">
                  <span className="inline-block rounded-md bg-brand-tint/60 px-2 py-0.5 font-mono text-[11px] font-semibold text-brand-fg">
                    {entry.toValue}
                  </span>
                </td>
                <td className="px-5 py-3 whitespace-nowrap text-right">
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    <ShieldCheckIcon className="h-3.5 w-3.5" />
                    Step-up Verified
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
