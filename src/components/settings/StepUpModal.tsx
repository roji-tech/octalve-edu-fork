"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import { AlertTriangleIcon, ShieldCheckIcon } from "@/components/ui/icons";
import type { SettingsDelta } from "@/lib/school-settings/rules";

interface StepUpModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (stepUp: { type: "totp" | "recovery" | "password"; value: string }) => Promise<void>;
  hasMfa: boolean;
  deltas: SettingsDelta[];
  saving: boolean;
  error: string | null;
}

export function StepUpModal({ open, onClose, onConfirm, hasMfa, deltas, saving, error }: StepUpModalProps) {
  const [proofValue, setProofValue] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  const hasWeakeningChanges = deltas.some((d) => d.isWeakeningSecurity);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!proofValue.trim()) return;

    const type = hasMfa ? (useRecovery ? "recovery" : "totp") : "password";
    await onConfirm({ type, value: proofValue.trim() });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Step-up Authentication Required"
      description="School configuration modifications require instant identity re-confirmation."
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {hasWeakeningChanges && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-600 dark:text-amber-400">
            <div className="flex items-center gap-2 font-semibold">
              <AlertTriangleIcon className="h-4 w-4 shrink-0" />
              <span>Security Controls Modification Warning</span>
            </div>
            <p className="mt-1">
              One or more requested changes relax critical school security controls (e.g., results approval or MFA policy).
            </p>
          </div>
        )}

        {/* Changes summary */}
        <div className="rounded-xl border border-line bg-field/30 p-3 space-y-2">
          <p className="text-xs font-semibold text-fg">Proposed Adjustments ({deltas.length}):</p>
          <ul className="space-y-1.5 max-h-36 overflow-y-auto text-xs">
            {deltas.map((d) => (
              <li key={d.field} className="flex items-center justify-between gap-2 border-b border-line/40 pb-1">
                <span className="font-mono text-fg-muted">{d.field}</span>
                <span className="font-medium text-fg">
                  <span className="line-through text-fg-muted mr-1">{d.fromValue}</span>
                  <span>&rarr; {d.toValue}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {error && <Alert variant="error">{error}</Alert>}

        {hasMfa ? (
          <div className="space-y-3">
            {!useRecovery ? (
              <TextField
                label="Authenticator Code (TOTP)"
                name="totpCode"
                value={proofValue}
                onChange={(e) => setProofValue(e.target.value)}
                placeholder="6-digit code from authenticator app"
                autoComplete="one-time-code"
                required
                hint="Open your authenticator app (e.g. Google Authenticator) and enter the current 6-digit code."
              />
            ) : (
              <TextField
                label="Recovery Code"
                name="recoveryCode"
                value={proofValue}
                onChange={(e) => setProofValue(e.target.value)}
                placeholder="e.g. abcd-1234-efgh"
                required
                hint="Enter one of your unused one-time backup recovery codes."
              />
            )}

            <button
              type="button"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setProofValue("");
              }}
              className="text-xs text-brand-fg hover:underline font-medium"
            >
              {useRecovery ? "Use authenticator app code instead" : "Can't access your authenticator? Use a recovery code"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <PasswordField
              label="Account Password"
              name="password"
              value={proofValue}
              onChange={(e) => setProofValue(e.target.value)}
              placeholder="Confirm your account password"
              required
              hint="Because two-factor authentication is not yet enabled on your account, please re-type your account password."
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !proofValue.trim()}>
            <ShieldCheckIcon className="h-4 w-4 mr-1.5" />
            {saving ? "Verifying & Saving..." : "Confirm & Apply"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
