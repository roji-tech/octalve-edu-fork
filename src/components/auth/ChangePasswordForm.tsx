"use client";

import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { PasswordField } from "@/components/ui/PasswordField";
import { checkNewPassword } from "@/lib/auth/password-policy";

/// "Password" card on the account page. Needs the CURRENT password (a stolen session alone can't take over
/// the account); success signs out every other device and keeps this one.
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [changed, setChanged] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setChanged(false);
    setFormError(null);
    const noCurrent = current ? null : "Enter your current password.";
    const problem = !next ? "Enter a new password." : checkNewPassword(next);
    const mismatch = !problem && next !== confirm ? "The two passwords don't match." : null;
    setCurrentError(noCurrent);
    setNextError(problem ?? mismatch);
    if (noCurrent || problem || mismatch) return;

    setPending(true);
    try {
      const res = await fetch("/api/v1/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const body = await res.json().catch(() => null);
      const code = body?.error?.code;
      if (res.ok) {
        setChanged(true);
        setCurrent("");
        setNext("");
        setConfirm("");
      } else if (code === "INVALID_CURRENT_PASSWORD") setCurrentError(body.error.message);
      else if (code === "VALIDATION" || code === "SAME_PASSWORD") setNextError(body.error.message);
      else if (res.status === 429) setFormError("Too many attempts. Please wait a few minutes and try again.");
      else if (res.status === 401) setFormError("Your session has ended. Please sign in again.");
      else setFormError("We couldn't change your password right now. Please try again in a moment.");
    } catch {
      setFormError("Can't reach the server. Check your internet connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form method="post" onSubmit={handleSubmit} noValidate className="mt-4 max-w-md space-y-4">
      <PasswordField
        label="Current password"
        name="currentPassword"
        value={current}
        onChange={(e) => {
          setCurrent(e.target.value);
          if (currentError) setCurrentError(null);
        }}
        error={currentError}
        autoComplete="current-password"
        maxLength={128}
        disabled={pending}
      />
      <PasswordField
        label="New password"
        name="newPassword"
        value={next}
        onChange={(e) => {
          setNext(e.target.value);
          if (nextError) setNextError(null);
        }}
        error={nextError}
        hint="At least 8 characters, with a letter and a number."
        autoComplete="new-password"
        maxLength={128}
        disabled={pending}
      />
      <PasswordField
        label="Confirm new password"
        name="confirmPassword"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        maxLength={128}
        disabled={pending}
      />
      {formError && <Alert variant="error">{formError}</Alert>}
      {changed && <Alert variant="success">Password changed. You&apos;ve been signed out of your other devices.</Alert>}
      <Button type="submit" loading={pending}>
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
