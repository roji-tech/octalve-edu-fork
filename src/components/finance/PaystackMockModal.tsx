"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";

interface PaystackMockModalProps {
  isOpen: boolean;
  onClose: () => void;
  reference: string;
  amountFormatted: string;
  onSuccess: () => void;
  onFailure?: () => void;
}

export function PaystackMockModal({ isOpen, onClose, reference, amountFormatted, onSuccess, onFailure }: PaystackMockModalProps) {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSimulate = async (status: "success" | "failed") => {
    setIsProcessing(true);
    try {
      // Complete mock payment on server via status verification
      if (status === "success") {
        onSuccess();
      } else {
        onFailure?.();
      }
      onClose();
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} title="Paystack Checkout Simulator">
      <div className="space-y-4 py-2">
        <div className="rounded-lg bg-primary/5 p-4 border border-primary/20 text-center">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Test Mode</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-foreground">{amountFormatted}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground break-all">Ref: {reference}</p>
        </div>

        <p className="text-sm text-muted-foreground">
          This is an interactive simulation of the Paystack gateway. Select an outcome to simulate a real payment webhook and server-side
          verification:
        </p>

        <div className="grid grid-cols-2 gap-3 pt-2">
          <Button
            type="button"
            variant="primary"
            className="min-h-11 w-full bg-emerald-600 hover:bg-emerald-700 text-white"
            disabled={isProcessing}
            onClick={() => handleSimulate("success")}
          >
            {isProcessing ? "Processing..." : "Simulate Success"}
          </Button>

          <Button
            type="button"
            variant="danger"
            className="min-h-11 w-full"
            disabled={isProcessing}
            onClick={() => handleSimulate("failed")}
          >
            Simulate Decline
          </Button>
        </div>

        <Button type="button" variant="secondary" className="min-h-11 w-full mt-2" onClick={onClose} disabled={isProcessing}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
