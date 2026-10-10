"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { formatNaira } from "@/lib/finance/rules";

export interface InvoiceListItem {
  id: string;
  invoiceNo: string;
  totalAmount: string | number;
  amountPaid: string | number;
  status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "WAIVED";
  dueDate?: string | null;
  createdAt: string;
  student: {
    id: string;
    firstName: string;
    lastName: string;
    admissionNo: string;
  };
  period: {
    id: string;
    label: string;
  };
}

interface InvoicesDashboardProps {
  schoolCode: string;
  invoices: InvoiceListItem[];
  periods: { id: string; label: string }[];
  canManageFinance: boolean;
  onRefresh?: () => void;
}

export function InvoicesDashboard({ schoolCode, invoices, periods, canManageFinance, onRefresh }: InvoicesDashboardProps) {
  const [selectedStatus, setSelectedStatus] = useState<string>("ALL");
  const [selectedPeriod, setSelectedPeriod] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [isGenerateOpen, setIsGenerateOpen] = useState(false);
  const [generatePeriodId, setGeneratePeriodId] = useState(periods[0]?.id || "");
  const [generateDueDate, setGenerateDueDate] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateMessage, setGenerateMessage] = useState<string | null>(null);

  // Compute Financial KPIs
  const { totalInvoiced, totalCollected, totalOutstanding, collectionRate } = useMemo(() => {
    let invoiced = 0;
    let collected = 0;

    for (const inv of invoices) {
      if (inv.status !== "WAIVED") {
        invoiced += Number(inv.totalAmount);
        collected += Number(inv.amountPaid);
      }
    }

    const outstanding = Math.max(0, invoiced - collected);
    const rate = invoiced > 0 ? (collected / invoiced) * 100 : 0;

    return {
      totalInvoiced: invoiced,
      totalCollected: collected,
      totalOutstanding: outstanding,
      collectionRate: rate,
    };
  }, [invoices]);

  // Filtered roll
  const filteredInvoices = useMemo(() => {
    return invoices.filter((inv) => {
      if (selectedStatus !== "ALL" && inv.status !== selectedStatus) return false;
      if (selectedPeriod !== "ALL" && inv.period.id !== selectedPeriod) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const studentName = `${inv.student.firstName} ${inv.student.lastName}`.toLowerCase();
        return studentName.includes(q) || inv.student.admissionNo.toLowerCase().includes(q) || inv.invoiceNo.toLowerCase().includes(q);
      }
      return true;
    });
  }, [invoices, selectedStatus, selectedPeriod, searchQuery]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsGenerating(true);
    setGenerateMessage(null);

    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/finance/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodId: generatePeriodId,
          dueDate: generateDueDate || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to generate invoices");
      }

      setGenerateMessage(`Generated ${json.data.created} new invoices (${json.data.skipped} already existed/skipped).`);
      onRefresh?.();
      setTimeout(() => {
        setIsGenerateOpen(false);
        setGenerateMessage(null);
      }, 2000);
    } catch (err: unknown) {
      setGenerateMessage(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setIsGenerating(false);
    }
  };

  const statusBadge = (status: InvoiceListItem["status"]) => {
    switch (status) {
      case "PAID":
        return (
          <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            Paid
          </span>
        );
      case "PARTIALLY_PAID":
        return (
          <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Partial
          </span>
        );
      case "WAIVED":
        return (
          <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-300">
            Waived
          </span>
        );
      case "UNPAID":
      default:
        return (
          <span className="inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300">
            Unpaid
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-foreground">Invoicing & Collections</h2>
          <p className="text-sm text-muted-foreground">
            Track student fee balances, online Paystack payments, and automated reconciliations.
          </p>
        </div>

        {canManageFinance && (
          <Button type="button" variant="primary" className="min-h-11 px-5" onClick={() => setIsGenerateOpen(true)}>
            Generate Term Invoices
          </Button>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-border bg-card shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Invoiced</p>
          <p className="mt-1 text-xl sm:text-2xl font-bold text-foreground">{formatNaira(totalInvoiced)}</p>
        </div>
        <div className="p-4 rounded-xl border border-border bg-card shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">Total Collected</p>
          <p className="mt-1 text-xl sm:text-2xl font-bold text-emerald-600 dark:text-emerald-400">{formatNaira(totalCollected)}</p>
        </div>
        <div className="p-4 rounded-xl border border-border bg-card shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">Outstanding</p>
          <p className="mt-1 text-xl sm:text-2xl font-bold text-rose-600 dark:text-rose-400">{formatNaira(totalOutstanding)}</p>
        </div>
        <div className="p-4 rounded-xl border border-border bg-card shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Collection Rate</p>
          <p className="mt-1 text-xl sm:text-2xl font-bold text-foreground">{collectionRate.toFixed(1)}%</p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {["ALL", "UNPAID", "PARTIALLY_PAID", "PAID", "WAIVED"].map((st) => (
            <button
              key={st}
              type="button"
              className={`min-h-11 px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors ${
                selectedStatus === st ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
              onClick={() => setSelectedStatus(st)}
            >
              {st.replace("_", " ")}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          {periods.length > 1 && (
            <select
              aria-label="Filter by academic period"
              className="min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
            >
              <option value="ALL">All Periods</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            className="min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary w-full md:w-64"
            placeholder="Search student or invoice..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Invoices Roll */}
      <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 border-b border-border text-muted-foreground font-semibold">
              <tr>
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Student Name</th>
                <th className="px-4 py-3">Period</th>
                <th className="px-4 py-3 text-right">Total Due</th>
                <th className="px-4 py-3 text-right">Paid</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredInvoices.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No matching invoices found.
                  </td>
                </tr>
              ) : (
                filteredInvoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-4 font-mono font-medium text-foreground">{inv.invoiceNo}</td>
                    <td className="px-4 py-4">
                      <p className="font-medium text-foreground">
                        {inv.student.firstName} {inv.student.lastName}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">{inv.student.admissionNo}</p>
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">{inv.period.label}</td>
                    <td className="px-4 py-4 text-right font-medium text-foreground">{formatNaira(inv.totalAmount)}</td>
                    <td className="px-4 py-4 text-right text-emerald-600 dark:text-emerald-400 font-medium">
                      {formatNaira(inv.amountPaid)}
                    </td>
                    <td className="px-4 py-4 text-center">{statusBadge(inv.status)}</td>
                    <td className="px-4 py-4 text-right">
                      <Link
                        href={`/schools/${schoolCode}/finance/invoices/${inv.id}`}
                        className="inline-flex items-center justify-center min-h-9 px-3 text-xs font-semibold rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors"
                      >
                        View & Pay
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Batch Generation Modal */}
      <Dialog open={isGenerateOpen} onClose={() => setIsGenerateOpen(false)} title="Batch Generate Term Invoices">
        <form onSubmit={handleGenerate} className="space-y-4 py-2">
          {generateMessage && (
            <div className="p-3 text-sm rounded bg-primary/10 text-primary border border-primary/20">{generateMessage}</div>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Academic Period</label>
            <select
              className="w-full min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={generatePeriodId}
              onChange={(e) => setGeneratePeriodId(e.target.value)}
              required
            >
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Due Date (Optional)</label>
            <input
              type="date"
              className="w-full min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
              value={generateDueDate}
              onChange={(e) => setGenerateDueDate(e.target.value)}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            This action creates invoices for all active students enrolled in this period. Existing invoices are safely skipped (idempotent
            operation).
          </p>

          <div className="flex justify-end gap-3 pt-3">
            <Button type="button" variant="secondary" className="min-h-11" onClick={() => setIsGenerateOpen(false)} disabled={isGenerating}>
              Close
            </Button>
            <Button type="submit" variant="primary" className="min-h-11" disabled={isGenerating}>
              {isGenerating ? "Generating..." : "Generate Invoices"}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
