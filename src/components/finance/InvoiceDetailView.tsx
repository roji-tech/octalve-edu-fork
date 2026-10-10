"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { TextField } from "@/components/ui/TextField";
import { SelectField } from "@/components/ui/SelectField";
import { Alert } from "@/components/ui/Alert";
import { ArrowLeftIcon, CheckCircleIcon, PrinterIcon } from "@/components/ui/icons";
import { formatNaira } from "@/lib/finance/rules";
import { PaystackMockModal } from "./PaystackMockModal";

export interface InvoiceDetailData {
  id: string;
  invoiceNo: string;
  totalAmount: string | number;
  amountPaid: string | number;
  status: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "WAIVED";
  dueDate?: string | null;
  lineItems?: Array<{ name: string; amount: string | number; feeStructureId?: string }> | null;
  createdAt: string;
  student: {
    id: string;
    firstName: string;
    middleName?: string | null;
    lastName: string;
    admissionNo: string;
    userId?: string | null;
  };
  period: {
    id: string;
    label: string;
    kind?: string;
    session?: { id: string; label: string } | null;
  };
  payments: Array<{
    id: string;
    amount: string | number;
    provider: string;
    providerRef: string;
    status: "PENDING" | "SUCCESS" | "FAILED";
    verifiedServerSide: boolean;
    channel?: string | null;
    paidAt?: string | null;
    receiptNo?: string | null;
    createdAt: string;
  }>;
  discounts: Array<{
    id: string;
    amount: string | number;
    reason: string;
    mode: "MANUAL_OVERRIDE" | "APPROVAL_REQUIRED";
    appliedByUserId: string;
    createdAt: string;
  }>;
}

interface InvoiceDetailViewProps {
  schoolCode: string;
  invoice: InvoiceDetailData;
  canManageFinance: boolean;
  onRefresh?: () => void;
  tenantName?: string;
}

export function InvoiceDetailView({
  schoolCode,
  invoice: initialInvoice,
  canManageFinance,
  onRefresh,
  tenantName = "School of Record",
}: InvoiceDetailViewProps) {
  const [invoice, setInvoice] = useState<InvoiceDetailData>(initialInvoice);
  const [notification, setNotification] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Paystack online payment modal state
  const [isPayModalOpen, setIsPayModalOpen] = useState(false);
  const [payAmount, setPayAmount] = useState<string>("");
  const [isInitializingPayment, setIsInitializingPayment] = useState(false);
  const [mockPaymentRef, setMockPaymentRef] = useState<string | null>(null);
  const [mockFormattedAmount, setMockFormattedAmount] = useState<string>("");

  // Manual payment recording modal state
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualAmount, setManualAmount] = useState<string>("");
  const [manualChannel, setManualChannel] = useState<string>("bank_transfer");
  const [manualRef, setManualRef] = useState<string>("");
  const [manualNote, setManualNote] = useState<string>("");
  const [isSubmittingManual, setIsSubmittingManual] = useState(false);

  // Discount modal state
  const [isDiscountModalOpen, setIsDiscountModalOpen] = useState(false);
  const [discountAmount, setDiscountAmount] = useState<string>("");
  const [discountReason, setDiscountReason] = useState<string>("");
  const [discountMode, setDiscountMode] = useState<string>("MANUAL_OVERRIDE");
  const [isSubmittingDiscount, setIsSubmittingDiscount] = useState(false);

  // Derived financials
  const totalAmountNum = Number(invoice.totalAmount);
  const amountPaidNum = Number(invoice.amountPaid);
  const remainingBalance = Math.max(0, totalAmountNum - amountPaidNum);
  const isFullySettled = invoice.status === "PAID" || remainingBalance === 0;
  const isWaived = invoice.status === "WAIVED";

  // Total discounts applied
  const totalDiscountsNum = invoice.discounts.reduce((sum, d) => sum + Number(d.amount), 0);

  // Refresh invoice data from API
  const refreshInvoice = async () => {
    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/finance/invoices/${invoice.id}`);
      if (res.ok) {
        const json = await res.json();
        if (json.data?.invoice) {
          setInvoice(json.data.invoice);
        }
      }
    } catch {
      // Fallback to caller-provided refresh
    }
    onRefresh?.();
  };

  // 1. Initialize Online Paystack Payment
  const handleStartOnlinePayment = () => {
    setPayAmount(remainingBalance.toString());
    setIsPayModalOpen(true);
  };

  const handleProceedToPaystack = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsInitializingPayment(true);
    setNotification(null);

    const amountNum = Number(payAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setNotification({ type: "error", message: "Please enter a valid payment amount." });
      setIsInitializingPayment(false);
      return;
    }

    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/finance/invoices/${invoice.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amountNum }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to initialize payment.");
      }

      const { reference, authorizationUrl } = json.data;
      setIsPayModalOpen(false);

      // Dual-mode handling: in dev/test, open interactive mock modal
      if (authorizationUrl?.startsWith("mock://") || !authorizationUrl) {
        setMockPaymentRef(reference);
        setMockFormattedAmount(formatNaira(amountNum));
      } else {
        // In real gateway mode, redirect to Paystack checkout URL
        window.location.href = authorizationUrl;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error initializing checkout.";
      setNotification({ type: "error", message: msg });
    } finally {
      setIsInitializingPayment(false);
    }
  };

  // Mock Paystack Success Handler
  const handleMockPaystackSuccess = async () => {
    if (!mockPaymentRef) return;
    try {
      // Trigger status check & atomic fulfilment
      const res = await fetch(`/api/v1/schools/${schoolCode}/finance/payments/${mockPaymentRef}/status`);
      const json = await res.json();

      if (res.ok && json.data?.verified) {
        setNotification({
          type: "success",
          message: `Payment successful! Receipt ${json.data.receiptNo || ""} has been issued.`,
        });
        await refreshInvoice();
      } else {
        setNotification({ type: "error", message: "Payment was not completed or failed verification." });
      }
    } catch {
      setNotification({ type: "error", message: "Verification check failed. Please refresh." });
    } finally {
      setMockPaymentRef(null);
    }
  };

  // 2. Submit Manual Payment
  const handleOpenManualModal = () => {
    setManualAmount(remainingBalance.toString());
    setManualRef("");
    setManualNote("");
    setManualChannel("bank_transfer");
    setIsManualModalOpen(true);
  };

  const handleSubmitManualPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingManual(true);
    setNotification(null);

    const amountNum = Number(manualAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setNotification({ type: "error", message: "Please specify a valid payment amount." });
      setIsSubmittingManual(false);
      return;
    }

    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/finance/invoices/${invoice.id}/manual-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amountNum,
          channel: manualChannel,
          reference: manualRef || undefined,
          note: manualNote || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to record manual payment.");
      }

      setNotification({
        type: "success",
        message: `Manual payment of ${formatNaira(amountNum)} recorded. Receipt: ${json.data?.receiptNo || "Generated"}`,
      });
      setIsManualModalOpen(false);
      await refreshInvoice();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error saving manual payment.";
      setNotification({ type: "error", message: msg });
    } finally {
      setIsSubmittingManual(false);
    }
  };

  // 3. Submit Discount
  const handleOpenDiscountModal = () => {
    setDiscountAmount("");
    setDiscountReason("");
    setDiscountMode("MANUAL_OVERRIDE");
    setIsDiscountModalOpen(true);
  };

  const handleSubmitDiscount = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmittingDiscount(true);
    setNotification(null);

    const amountNum = Number(discountAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setNotification({ type: "error", message: "Please enter a valid discount amount." });
      setIsSubmittingDiscount(false);
      return;
    }

    try {
      const res = await fetch(`/api/v1/schools/${schoolCode}/finance/invoices/${invoice.id}/discount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amountNum,
          reason: discountReason,
          mode: discountMode,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || "Failed to apply discount.");
      }

      setNotification({
        type: "success",
        message: `Discount of ${formatNaira(amountNum)} applied successfully.`,
      });
      setIsDiscountModalOpen(false);
      await refreshInvoice();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error applying discount.";
      setNotification({ type: "error", message: msg });
    } finally {
      setIsSubmittingDiscount(false);
    }
  };

  const studentFullName = [invoice.student.firstName, invoice.student.middleName, invoice.student.lastName].filter(Boolean).join(" ");

  const statusBadgeStyle = {
    PAID: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    PARTIALLY_PAID: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    UNPAID: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20",
    WAIVED: "bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20",
  }[invoice.status];

  return (
    <div className="space-y-6">
      {/* Action Navigation & Print Trigger (Hidden when printed) */}
      <div className="flex flex-wrap items-center justify-between gap-4 print:hidden">
        <Link
          href={`/schools/${schoolCode}/finance/invoices`}
          className="inline-flex items-center gap-2 text-sm font-medium text-fg-muted hover:text-fg transition-colors"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          Back to Invoices
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" className="inline-flex items-center gap-2" onClick={() => window.print()}>
            <PrinterIcon className="h-4 w-4" />
            Print Receipt / Invoice
          </Button>

          {canManageFinance && !isFullySettled && !isWaived && (
            <>
              <Button type="button" variant="secondary" onClick={handleOpenDiscountModal}>
                Apply Discount
              </Button>
              <Button type="button" variant="secondary" onClick={handleOpenManualModal}>
                Record Payment
              </Button>
            </>
          )}

          {!isFullySettled && !isWaived && (
            <Button
              type="button"
              variant="primary"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={handleStartOnlinePayment}
            >
              Pay with Paystack
            </Button>
          )}
        </div>
      </div>

      {/* Notifications */}
      {notification && (
        <div className="print:hidden">
          <Alert variant={notification.type === "error" ? "error" : "success"}>{notification.message}</Alert>
        </div>
      )}

      {/* Main Printable Container */}
      <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8 shadow-sm print:border-none print:p-0 print:shadow-none">
        {/* Printable Letterhead Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between border-b border-line pb-6 gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="font-serif text-2xl font-bold tracking-tight text-fg">{tenantName}</span>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusBadgeStyle}`}>
                {invoice.status.replace("_", " ")}
              </span>
            </div>
            <p className="mt-1 text-xs text-fg-muted uppercase tracking-wider">Official Billing Statement & Student Invoice</p>
          </div>

          <div className="sm:text-right font-mono text-sm">
            <p className="font-semibold text-fg">Invoice No: {invoice.invoiceNo}</p>
            <p className="text-xs text-fg-muted mt-0.5">Issued: {new Date(invoice.createdAt).toLocaleDateString()}</p>
            {invoice.dueDate && <p className="text-xs text-fg-muted mt-0.5">Due Date: {new Date(invoice.dueDate).toLocaleDateString()}</p>}
          </div>
        </div>

        {/* Student & Session Info */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-6 border-b border-line text-sm">
          <div>
            <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Student Details</h3>
            <p className="mt-1 text-base font-semibold text-fg">{studentFullName}</p>
            <p className="text-fg-muted mt-0.5 font-mono text-xs">Admission No: {invoice.student.admissionNo}</p>
          </div>

          <div className="md:text-right">
            <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Academic Period</h3>
            <p className="mt-1 text-base font-semibold text-fg">{invoice.period.label}</p>
            {invoice.period.session && <p className="text-fg-muted mt-0.5 text-xs">Session: {invoice.period.session.label}</p>}
          </div>
        </div>

        {/* Financial KPI Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-6 border-b border-line">
          <div className="rounded-xl bg-field p-4 border border-line/60">
            <p className="text-xs font-medium text-fg-muted">Total Invoiced</p>
            <p className="mt-1 text-xl font-bold tracking-tight text-fg">{formatNaira(totalAmountNum)}</p>
          </div>

          <div className="rounded-xl bg-field p-4 border border-line/60">
            <p className="text-xs font-medium text-fg-muted">Total Discounts</p>
            <p className="mt-1 text-xl font-bold tracking-tight text-fg">{formatNaira(totalDiscountsNum)}</p>
          </div>

          <div className="rounded-xl bg-field p-4 border border-line/60">
            <p className="text-xs font-medium text-fg-muted">Total Paid</p>
            <p className="mt-1 text-xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400">{formatNaira(amountPaidNum)}</p>
          </div>

          <div className="rounded-xl bg-field p-4 border border-line/60">
            <p className="text-xs font-medium text-fg-muted">Remaining Balance</p>
            <p
              className={`mt-1 text-xl font-bold tracking-tight ${
                remainingBalance > 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"
              }`}
            >
              {formatNaira(remainingBalance)}
            </p>
          </div>
        </div>

        {/* Line Items Breakdown Table */}
        <div className="py-6 border-b border-line">
          <h3 className="text-sm font-semibold tracking-wide text-fg-2 uppercase mb-3">Fee Breakdown</h3>
          <div className="overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="bg-field/70 border-b border-line text-xs font-semibold text-fg-muted uppercase">
                <tr>
                  <th className="py-3 px-4">Item Description</th>
                  <th className="py-3 px-4 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {invoice.lineItems && invoice.lineItems.length > 0 ? (
                  invoice.lineItems.map((item, idx) => (
                    <tr key={idx} className="hover:bg-field/30">
                      <td className="py-3 px-4 font-medium text-fg">{item.name}</td>
                      <td className="py-3 px-4 text-right font-mono text-fg">{formatNaira(item.amount)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="py-3 px-4 font-medium text-fg">Standard Term Fees</td>
                    <td className="py-3 px-4 text-right font-mono text-fg">{formatNaira(totalAmountNum)}</td>
                  </tr>
                )}
              </tbody>
              <tfoot className="bg-field/40 font-semibold border-t border-line">
                <tr>
                  <td className="py-3 px-4 text-fg">Subtotal</td>
                  <td className="py-3 px-4 text-right font-mono text-fg">{formatNaira(totalAmountNum)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        {/* Discounts / Concessions Section */}
        {invoice.discounts.length > 0 && (
          <div className="py-6 border-b border-line">
            <h3 className="text-sm font-semibold tracking-wide text-fg-2 uppercase mb-3">Applied Discounts & Waivers</h3>
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-left text-sm">
                <thead className="bg-field/70 border-b border-line text-xs font-semibold text-fg-muted uppercase">
                  <tr>
                    <th className="py-3 px-4">Reason / Notes</th>
                    <th className="py-3 px-4">Workflow Mode</th>
                    <th className="py-3 px-4">Applied Date</th>
                    <th className="py-3 px-4 text-right">Discount Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {invoice.discounts.map((discount) => (
                    <tr key={discount.id} className="hover:bg-field/30">
                      <td className="py-3 px-4 font-medium text-fg">{discount.reason}</td>
                      <td className="py-3 px-4 text-xs font-mono text-fg-muted">{discount.mode}</td>
                      <td className="py-3 px-4 text-xs text-fg-muted">{new Date(discount.createdAt).toLocaleDateString()}</td>
                      <td className="py-3 px-4 text-right font-mono text-emerald-600 dark:text-emerald-400">
                        -{formatNaira(discount.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Payment History & Receipts */}
        <div className="py-6">
          <h3 className="text-sm font-semibold tracking-wide text-fg-2 uppercase mb-3">Payment & Receipt Ledger</h3>
          {invoice.payments.length === 0 ? (
            <p className="text-sm text-fg-muted rounded-xl border border-dashed border-line p-6 text-center">
              No payments recorded for this invoice yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full text-left text-sm">
                <thead className="bg-field/70 border-b border-line text-xs font-semibold text-fg-muted uppercase">
                  <tr>
                    <th className="py-3 px-4">Date</th>
                    <th className="py-3 px-4">Receipt No</th>
                    <th className="py-3 px-4">Method / Channel</th>
                    <th className="py-3 px-4">Reference</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Amount Paid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {invoice.payments.map((p) => {
                    const isSuccess = p.status === "SUCCESS";
                    return (
                      <tr key={p.id} className="hover:bg-field/30">
                        <td className="py-3 px-4 text-xs text-fg-muted">
                          {p.paidAt ? new Date(p.paidAt).toLocaleDateString() : new Date(p.createdAt).toLocaleDateString()}
                        </td>
                        <td className="py-3 px-4 font-mono font-medium text-fg">{p.receiptNo || "—"}</td>
                        <td className="py-3 px-4 text-xs font-medium uppercase text-fg-muted">{p.channel || p.provider}</td>
                        <td className="py-3 px-4 font-mono text-xs text-fg-muted">{p.providerRef}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold ${
                              isSuccess
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                            }`}
                          >
                            {isSuccess && <CheckCircleIcon className="h-3 w-3" />}
                            {p.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-semibold text-fg">{formatNaira(p.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Printable Verification Footer */}
        <div className="hidden print:block pt-12 mt-8 border-t border-line text-xs text-fg-muted">
          <div className="flex justify-between items-end">
            <div className="space-y-1">
              <p className="font-semibold text-fg">Computerized Invoice & Receipt Document</p>
              <p>Generated by Octalve Edu Finance Management System</p>
              <p>Printed on: {new Date().toLocaleString()}</p>
            </div>
            <div className="text-right space-y-4">
              <div className="w-48 border-b border-line pb-1" />
              <p className="font-semibold text-fg">Authorized Bursary Officer / Seal</p>
            </div>
          </div>
        </div>
      </div>

      {/* Online Paystack Checkout Amount Dialog */}
      <Dialog
        open={isPayModalOpen}
        onClose={() => setIsPayModalOpen(false)}
        title="Pay Invoice via Paystack"
        description="Choose the amount you want to pay towards this invoice."
      >
        <form onSubmit={handleProceedToPaystack} className="space-y-4 pt-2">
          <div className="rounded-xl bg-field p-3 border border-line text-xs space-y-1">
            <div className="flex justify-between text-fg-muted">
              <span>Total Invoice Amount:</span>
              <span className="font-mono">{formatNaira(totalAmountNum)}</span>
            </div>
            <div className="flex justify-between text-fg-muted">
              <span>Amount Already Settled:</span>
              <span className="font-mono text-emerald-600">{formatNaira(amountPaidNum)}</span>
            </div>
            <div className="flex justify-between font-semibold text-fg pt-1 border-t border-line">
              <span>Outstanding Balance:</span>
              <span className="font-mono">{formatNaira(remainingBalance)}</span>
            </div>
          </div>

          <TextField
            label="Payment Amount (₦)"
            type="number"
            step="0.01"
            min="1"
            max={remainingBalance}
            value={payAmount}
            onChange={(e) => setPayAmount(e.target.value)}
            required
            hint="You can pay the full balance or make a partial instalment."
          />

          <div className="flex items-center justify-end gap-3 pt-3">
            <Button type="button" variant="secondary" onClick={() => setIsPayModalOpen(false)} disabled={isInitializingPayment}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={isInitializingPayment}
            >
              {isInitializingPayment ? "Initializing..." : "Proceed to Paystack"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Manual Payment Recording Modal */}
      <Dialog
        open={isManualModalOpen}
        onClose={() => setIsManualModalOpen(false)}
        title="Record Manual Payment"
        description="Record cash, POS, or bank transfer payments received at the bursary."
      >
        <form onSubmit={handleSubmitManualPayment} className="space-y-4 pt-2">
          <TextField
            label="Amount Paid (₦)"
            type="number"
            step="0.01"
            min="1"
            value={manualAmount}
            onChange={(e) => setManualAmount(e.target.value)}
            required
          />

          <SelectField
            label="Payment Channel"
            value={manualChannel}
            onChange={(e) => setManualChannel(e.target.value)}
            options={[
              { value: "bank_transfer", label: "Direct Bank Transfer" },
              { value: "cash", label: "Cash Receipt" },
              { value: "pos", label: "POS Terminal" },
            ]}
          />

          <TextField
            label="Bank / Transaction Reference (Optional)"
            type="text"
            placeholder="e.g. GTB/TRF/98124012"
            value={manualRef}
            onChange={(e) => setManualRef(e.target.value)}
          />

          <TextField
            label="Internal Notes / Remarks (Optional)"
            type="text"
            placeholder="e.g. Paid at school bursary by parent"
            value={manualNote}
            onChange={(e) => setManualNote(e.target.value)}
          />

          <div className="flex items-center justify-end gap-3 pt-3">
            <Button type="button" variant="secondary" onClick={() => setIsManualModalOpen(false)} disabled={isSubmittingManual}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmittingManual}>
              {isSubmittingManual ? "Recording..." : "Record Payment & Issue Receipt"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Apply Discount / Waiver Modal */}
      <Dialog
        open={isDiscountModalOpen}
        onClose={() => setIsDiscountModalOpen(false)}
        title="Apply Fee Discount or Waiver"
        description="Grant a scholarship concession or administrative fee waiver."
      >
        <form onSubmit={handleSubmitDiscount} className="space-y-4 pt-2">
          <TextField
            label="Discount Amount (₦)"
            type="number"
            step="0.01"
            min="1"
            value={discountAmount}
            onChange={(e) => setDiscountAmount(e.target.value)}
            required
          />

          <TextField
            label="Reason / Scholarship Scheme"
            type="text"
            placeholder="e.g. Staff child waiver, Merit scholarship"
            value={discountReason}
            onChange={(e) => setDiscountReason(e.target.value)}
            required
          />

          <SelectField
            label="Workflow Mode"
            value={discountMode}
            onChange={(e) => setDiscountMode(e.target.value)}
            options={[
              { value: "MANUAL_OVERRIDE", label: "Manual Direct Override" },
              { value: "APPROVAL_REQUIRED", label: "Require Principal Approval" },
            ]}
          />

          <div className="flex items-center justify-end gap-3 pt-3">
            <Button type="button" variant="secondary" onClick={() => setIsDiscountModalOpen(false)} disabled={isSubmittingDiscount}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmittingDiscount}>
              {isSubmittingDiscount ? "Applying..." : "Apply Discount"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Interactive Paystack Simulator Modal (Dev/Test) */}
      {mockPaymentRef && (
        <PaystackMockModal
          isOpen={Boolean(mockPaymentRef)}
          onClose={() => setMockPaymentRef(null)}
          reference={mockPaymentRef}
          amountFormatted={mockFormattedAmount}
          onSuccess={handleMockPaystackSuccess}
        />
      )}
    </div>
  );
}
