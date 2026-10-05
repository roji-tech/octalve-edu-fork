"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { PasswordField } from "@/components/ui/PasswordField";
import { CheckCircleIcon } from "@/components/ui/icons";
import { useFragmentToken } from "@/components/auth/useFragmentToken";
import { checkNewPassword } from "@/lib/auth/password-policy";

const LINK = "inline-flex min-h-11 items-center font-semibold text-brand-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-md";

/// Step 2: the page the emailed link opens. The token is in the URL FRAGMENT (`#token=…`), which the browser
/// never sends to a server; it is read once and then removed from the address bar, so it is not left in
/// history, a screenshot, or a shared screen.
export function ResetPasswordForm() {
  const { token, version } = useFragmentToken();
  // keyed on the link: one opened in a tab that is already on this page starts from a clean slate
  return <ResetPasswordBody key={version} token={token} />;
}

/// `token`: undefined = not read yet; "" = no token in the URL.
function ResetPasswordBody({ token }: { token: string | undefined }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [linkDead, setLinkDead] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !token) return;
    setFormError(null);
    const problem = !password ? "Enter a new password." : checkNewPassword(password);
    const mismatch = !problem && password !== confirm ? "The two passwords don't match." : null;
    setPasswordError(problem ?? mismatch);
    if (problem || mismatch) return;

    setPending(true);
    try {
      const res = await fetch("/api/v1/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) setDone(true);
      else if (body?.error?.code === "INVALID_TOKEN") setLinkDead(true);
      else if (body?.error?.code === "VALIDATION") setPasswordError(body.error.message);
      else if (res.status === 429) setFormError("Too many attempts. Please wait a few minutes and try again.");
      else setFormError("We couldn't update your password right now. Please try again in a moment.");
    } catch {
      setFormError("Can't reach the server. Check your internet connection and try again.");
    } finally {
      setPending(false);
    }
  }

  const wrapper =
    "rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-7 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none";

  if (token === undefined) {
    return <div className={wrapper} aria-busy="true"><p className="text-sm text-fg-muted">One moment…</p></div>;
  }

  if (done) {
    return (
      <div className={wrapper}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ok-bg text-ok-icon">
          <CheckCircleIcon className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-[22px] font-bold tracking-tight text-fg">Password updated</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
          You&apos;ve been signed out everywhere. Sign in with your new password.
        </p>
        <Button className="mt-6 w-full" onClick={() => router.push("/login")} autoFocus>
          Continue to sign in
        </Button>
      </div>
    );
  }

  if (!token || linkDead) {
    return (
      <div className={wrapper}>
        <h1 className="text-[22px] font-bold tracking-tight text-fg">This link can&apos;t be used</h1>
        <Alert variant="error" className="mt-4">
          {linkDead
            ? "This link is invalid or has expired. Reset links work once and only for a short time."
            : "This reset link is incomplete. Open the whole link from your email, or ask for a new one."}
        </Alert>
        <p className="mt-6 text-sm">
          <Link href="/forgot-password" className={LINK}>
            Request a new link
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className={wrapper}>
      <h1 className="text-[22px] font-bold tracking-tight text-fg">Choose a new password</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
        At least 8 characters, with a letter and a number.
      </p>
      <form method="post" onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
        <PasswordField
          label="New password"
          name="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) setPasswordError(null);
          }}
          error={passwordError}
          autoComplete="new-password"
          maxLength={128}
          autoFocus
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
        <Button type="submit" className="w-full" loading={pending}>
          {pending ? "Saving…" : "Set new password"}
        </Button>
      </form>
    </div>
  );
}
