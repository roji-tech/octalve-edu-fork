"use client";

import type { Ref } from "react";
import { TextField } from "@/components/ui/TextField";
import { normaliseRecoveryCode, normaliseTotpCode } from "@/lib/auth/mfa/codes";

/// Which second factor is being typed: the 6-digit code from an authenticator app, or one of the
/// single-use recovery codes. Shared by sign-in step 2 and the "turn off" form, so both behave alike.
export type FactorMode = "code" | "recovery";

/// The request-body fragment for what was typed — `{ code }` or `{ recoveryCode }` — or null if it isn't
/// shaped like that kind of code (checked in the browser first, so a typo never costs a request).
export function factorPayload(mode: FactorMode, raw: string): { code: string } | { recoveryCode: string } | null {
  const value = raw.trim();
  if (mode === "code") return normaliseTotpCode(value) ? { code: value } : null;
  return normaliseRecoveryCode(value) ? { recoveryCode: value } : null;
}

export const FACTOR_FORMAT_ERROR: Record<FactorMode, string> = {
  code: "Enter the 6-digit code from your authenticator app.",
  recovery: "Enter one of your recovery codes (ten characters, like ABCDE-FGHJK).",
};

export function SecondFactorField({
  mode,
  value,
  onChange,
  error,
  disabled,
  autoFocus,
  ref,
}: {
  mode: FactorMode;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
  autoFocus?: boolean;
  ref?: Ref<HTMLInputElement>;
}) {
  // `key` remounts the input when the mode flips, so a field focused for one kind of code (and its
  // autofocus) is never reused for the other.
  return mode === "code" ? (
    <TextField
      key="code"
      ref={ref}
      label="Authentication code"
      name="code"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      hint="The 6-digit code from your authenticator app."
      inputMode="numeric"
      autoComplete="one-time-code"
      autoCapitalize="none"
      spellCheck={false}
      maxLength={7}
      placeholder="123456"
      autoFocus={autoFocus}
      disabled={disabled}
      className="tracking-[0.3em] tabular-nums"
    />
  ) : (
    <TextField
      key="recovery"
      ref={ref}
      label="Recovery code"
      name="recoveryCode"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      hint="One of the ten codes you saved when you turned on two-step verification. Each works once."
      autoComplete="off"
      autoCapitalize="characters"
      spellCheck={false}
      maxLength={16}
      placeholder="ABCDE-FGHJK"
      autoFocus={autoFocus}
      disabled={disabled}
      className="tracking-widest uppercase"
    />
  );
}

/// The "Use a recovery code instead" / "Use your authenticator app instead" switch.
export function FactorModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: FactorMode;
  onChange: (mode: FactorMode) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(mode === "code" ? "recovery" : "code")}
      className="inline-flex min-h-11 items-center rounded-md px-1 text-sm font-medium text-brand-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:text-fg-muted disabled:no-underline"
    >
      {mode === "code" ? "Use a recovery code instead" : "Use your authenticator app instead"}
    </button>
  );
}
