"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  FACTOR_FORMAT_ERROR,
  FactorModeToggle,
  SecondFactorField,
  factorPayload,
  type FactorMode,
} from "@/components/auth/SecondFactorField";

type Status = "idle" | "submitting" | "success" | "paused";

// A courtesy pause after "too many attempts" — the server enforces the limit, this just stops a stuck
// script (or an impatient thumb) hammering it while the window drains.
const PAUSE_SECONDS = 30;

/// Sign-in step 2 (plan §0.5.D), shown in place on the sign-in card after the password was accepted for an
/// account with two-step verification. The challenge token lives only in this page's memory (it is passed
/// in, never stored): reloading the page starts over at the password, which is the safe direction.
export function MfaStep({
  challenge,
  onBack,
  onExpired,
}: {
  challenge: string;
  /// Back to the password step.
  onBack: () => void;
  /// The challenge died (expired, used up, out of attempts): back to the password step with a message.
  onExpired: (message: string) => void;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<FactorMode>("code");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (status !== "paused") return;
    const timer = setTimeout(() => {
      if (secondsLeft <= 1) {
        setSecondsLeft(0);
        setStatus("idle");
      } else {
        setSecondsLeft(secondsLeft - 1);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [status, secondsLeft]);

  // After a rejected code the field was emptied while the inputs were disabled: put the caret back once
  // they are enabled again (calling focus() inside the submit handler would hit a disabled input).
  useEffect(() => {
    if (status === "paused" || (status === "idle" && (formError || fieldError))) inputRef.current?.focus();
  }, [status, formError, fieldError]);

  const busy = status === "submitting" || status === "success";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status !== "idle") return;
    setFormError(null);

    const payload = factorPayload(mode, value);
    if (!payload) {
      setFieldError(value.trim() ? FACTOR_FORMAT_ERROR[mode] : mode === "code" ? "Enter your authentication code." : "Enter a recovery code.");
      return inputRef.current?.focus();
    }
    setFieldError(null);

    setStatus("submitting");
    try {
      const res = await fetch("/api/v1/auth/login/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ challenge, ...payload }),
      });
      if (res.ok) {
        setStatus("success");
        router.replace("/dashboard");
        router.refresh();
        return;
      }

      const body = await res.json().catch(() => null);
      const code: string | undefined = body?.error?.code;
      setValue("");

      if (code === "INVALID_CHALLENGE") {
        // Expired, used up or out of attempts — only the password step can start a new one.
        return onExpired("Your sign-in timed out or ran out of attempts. Enter your password again to continue.");
      }
      if (res.status === 429) {
        setSecondsLeft(PAUSE_SECONDS);
        setStatus("paused");
        return;
      }
      setStatus("idle");
      if (code === "INVALID_CODE") {
        setFormError(
          mode === "code"
            ? "That code isn't right. Wait for your app to show a new one and try again."
            : "That recovery code isn't right, or it has already been used.",
        );
      } else if (res.status === 503) {
        setFormError("Two-step verification is unavailable right now. Please contact your school administrator.");
      } else {
        setFormError("We couldn't verify your code right now. Please try again in a moment.");
      }
    } catch {
      setValue("");
      setStatus("idle");
      setFormError("Can't reach the server. Check your internet connection and try again.");
    }
  }

  return (
    <>
      <h1 className="text-[22px] font-bold tracking-tight text-fg">Two-step verification</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
        {mode === "code"
          ? "Open your authenticator app and enter the 6-digit code it shows for this account."
          : "Enter one of your recovery codes to sign in."}
      </p>

      <form method="post" onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
        <SecondFactorField
          ref={inputRef}
          mode={mode}
          value={value}
          onChange={(next) => {
            setValue(next);
            if (fieldError) setFieldError(null);
          }}
          error={fieldError}
          disabled={busy}
          autoFocus
        />

        <div className="space-y-4 empty:hidden">
          {formError && <Alert variant="error">{formError}</Alert>}
          {status === "paused" && (
            <Alert variant="warning" title="Verification is paused for a moment">
              <span className="sr-only">Too many unsuccessful attempts. Please wait a moment and try again.</span>
              <span aria-hidden="true">
                Too many unsuccessful attempts. For your security, please wait {secondsLeft}s and try again.
              </span>
            </Alert>
          )}
          {status === "success" && <Alert variant="success">Signed in. Taking you to your dashboard…</Alert>}
        </div>

        <Button
          type="submit"
          className="w-full"
          loading={status === "submitting"}
          disabled={status === "paused" || status === "success"}
        >
          {status === "submitting"
            ? "Verifying…"
            : status === "success"
              ? "Signed in"
              : status === "paused"
                ? `Try again in ${secondsLeft}s`
                : "Verify"}
        </Button>
      </form>

      <div className="mt-4 flex flex-col items-start gap-x-4 sm:flex-row sm:items-center sm:justify-between">
        <FactorModeToggle
          mode={mode}
          disabled={busy}
          onChange={(next) => {
            setMode(next);
            setValue("");
            setFieldError(null);
            setFormError(null);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={onBack}
          className="inline-flex min-h-11 items-center rounded-md px-1 text-sm font-medium text-fg-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:text-fg-muted disabled:no-underline"
        >
          Back to sign in
        </button>
      </div>
    </>
  );
}
