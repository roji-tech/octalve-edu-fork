"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { RESET_LINK_MINUTES } from "@/lib/auth/reset-constants";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK = "inline-flex min-h-11 items-center font-semibold text-brand-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-md";

/// Step 1 of "I forgot my password". The confirmation is the same whether or not the address has an
/// account (the server answers identically), and says so in those words.
export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const trimmed = email.trim();
    const problem = !trimmed ? "Enter your email address." : !EMAIL_PATTERN.test(trimmed) ? "Enter a valid email address." : null;
    setEmailError(problem);
    if (problem) return;

    setPending(true);
    try {
      const res = await fetch("/api/v1/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email: trimmed }),
      });
      if (res.ok) setSentTo(trimmed);
      else if (res.status === 429) setFormError("Too many requests. Please wait a few minutes and try again.");
      else setFormError("We couldn't send that right now. Please try again in a moment.");
    } catch {
      setFormError("Can't reach the server. Check your internet connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-7 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none">
      {sentTo ? (
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-fg">Check your email</h1>
          <Alert variant="success" className="mt-4">
            If an account exists for <strong className="font-semibold">{sentTo}</strong>, we&apos;ve sent a link to
            reset its password. It works for {RESET_LINK_MINUTES} minutes.
          </Alert>
          <p className="mt-4 text-sm leading-relaxed text-fg-muted">
            Nothing arrived? Check your spam folder, or ask for another link — only the newest one works.
          </p>
          <p className="mt-6 text-sm">
            <Link href="/login" className={LINK}>
              Back to sign in
            </Link>
          </p>
        </div>
      ) : (
        <>
          <h1 className="text-[22px] font-bold tracking-tight text-fg">Forgot your password?</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
            Enter your email address and we&apos;ll send you a link to choose a new one.
          </p>
          <form method="post" onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
            <TextField
              label="Email address"
              type="email"
              name="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError(null);
              }}
              error={emailError}
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              disabled={pending}
              placeholder="you@yourschool.com"
            />
            {formError && <Alert variant="error">{formError}</Alert>}
            <Button type="submit" className="w-full" loading={pending}>
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm">
            <Link href="/login" className={LINK}>
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
