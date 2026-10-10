"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextField } from "@/components/ui/TextField";
import { formatNaira } from "@/lib/finance/rules";

export interface FeeItem {
  id: string;
  name: string;
  amount: string | number;
  periodId: string;
  classGroupId?: string | null;
  period?: { id: string; label: string };
  classGroup?: { id: string; name: string } | null;
}

interface FeeStructuresPanelProps {
  schoolCode: string;
  feeStructures: FeeItem[];
  periods: { id: string; label: string }[];
  classGroups: { id: string; name: string }[];
  canManageFinance: boolean;
  onRefresh?: () => void;
}

export function FeeStructuresPanel({
  schoolCode,
  feeStructures,
  periods,
  classGroups,
  canManageFinance,
  onRefresh,
}: FeeStructuresPanelProps) {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState<string>(periods[0]?.id || "");
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [classGroupId, setClassGroupId] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredFees = selectedPeriod ? feeStructures.filter((f) => f.periodId === selectedPeriod) : feeStructures;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/finance/fee-structures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          amount: parseFloat(amount),
          periodId: selectedPeriod,
          classGroupId: classGroupId || null,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to create fee schedule");
      }

      setIsCreateOpen(false);
      setName("");
      setAmount("");
      setClassGroupId("");
      onRefresh?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error creating fee schedule");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">Fee Schedules</h2>
          <p className="text-sm text-muted-foreground">Configure line-item fees per term and class for automated student invoicing.</p>
        </div>

        {canManageFinance && (
          <Button type="button" variant="primary" className="min-h-11 px-5" onClick={() => setIsCreateOpen(true)}>
            + Add Fee Schedule
          </Button>
        )}
      </div>

      {/* Period Filter Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {periods.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`min-h-11 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              selectedPeriod === p.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
            onClick={() => setSelectedPeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Fee Items Table / Cards */}
      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 border-b border-border text-muted-foreground font-semibold">
              <tr>
                <th className="px-4 py-3">Fee Item Name</th>
                <th className="px-4 py-3">Class Applicability</th>
                <th className="px-4 py-3 text-right">Amount (₦)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredFees.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">
                    No fee structures defined for this period. Click &ldquo;+ Add Fee Schedule&rdquo; to create one.
                  </td>
                </tr>
              ) : (
                filteredFees.map((fee) => (
                  <tr key={fee.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-4 font-medium text-foreground">{fee.name}</td>
                    <td className="px-4 py-4 text-muted-foreground">
                      {fee.classGroup?.name ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                          {fee.classGroup.name} only
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">
                          All Classes
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right font-semibold text-foreground">{formatNaira(fee.amount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Dialog */}
      <Dialog open={isCreateOpen} onClose={() => setIsCreateOpen(false)} title="Create Fee Schedule">
        <form onSubmit={handleCreate} className="space-y-4 py-2">
          {error && <div className="p-3 text-sm rounded bg-destructive/15 text-destructive border border-destructive/20">{error}</div>}

          <TextField
            label="Fee Item Name"
            placeholder="e.g. Tuition, Development Levy, PTA"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <TextField
            label="Amount (Naira)"
            type="number"
            step="0.01"
            min="0"
            placeholder="e.g. 75000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Target Class (Optional)</label>
            <select
              className="w-full min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={classGroupId}
              onChange={(e) => setClassGroupId(e.target.value)}
            >
              <option value="">Applies to all classes</option>
              {classGroups.map((cg) => (
                <option key={cg.id} value={cg.id}>
                  {cg.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-3">
            <Button type="button" variant="secondary" className="min-h-11" onClick={() => setIsCreateOpen(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="min-h-11" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : "Create Fee"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
