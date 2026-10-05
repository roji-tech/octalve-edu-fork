"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useFragmentToken } from "@/components/auth/useFragmentToken";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { CheckCircleIcon, MailIcon } from "@/components/ui/icons";
import { GENERIC_ERROR, NETWORK_ERROR, RATE_LIMITED, sendJson } from "@/components/auth/postJson";

const LINK = "inline-flex min-h-11 items-center font-semibold text-brand-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-md";
const WRAPPER = "rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-7 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none";

/// The page the link mailed to the NEW address opens (plan §0.5.E). Like the reset page, the token is in the URL
/// FRAGMENT: it is read once and removed from the address bar. Unlike the reset page it does NOT act on arrival —
/// it waits for a click. Mail clients and security scanners open links (and some run scripts) to preview them; a
/// page that spent the single-use token on load would be consumed before the person ever saw it.
export function ConfirmEmailForm() {
  const { token, version } = useFragmentToken();
  // keyed on the link: one opened in a tab that is already on this page starts from a clean slate
  return <ConfirmEmailBody key={version} token={token} />;
}

/// `token`: undefined = not read yet; "" = no token in the URL.
function ConfirmEmailBody({ token }: { token: string | undefined }) {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [linkDead, setLinkDead] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (done || linkDead) heading.current?.focus();
  }, [done, linkDead]);

  async function confirm() {
    if (pending || !token) return;
    setFormError(null);
    setPending(true);
    const reply = await sendJson("/api/v1/auth/email-change/confirm", "POST", { token });
    setPending(false);
    if (reply.ok) setDone(true);
    else if (reply.code === "INVALID_TOKEN") setLinkDead(true);
    else if (reply.status === 429) setFormError(RATE_LIMITED);
    else setFormError(reply.code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  if (token === undefined) {
    return (
      <div className={WRAPPER} aria-busy="true">
        <p className="text-sm text-fg-muted">One moment…</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className={WRAPPER}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-ok-bg text-ok-icon">
          <CheckCircleIcon className="h-6 w-6" />
        </span>
        <h1 ref={heading} tabIndex={-1} className="mt-4 text-[22px] font-bold tracking-tight text-fg focus:outline-none">
          Email address changed
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
          For your security you&apos;ve been signed out everywhere. Sign in with your new email address and your
          usual password.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-brand-strong px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-strong/25 transition-colors hover:bg-brand-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Continue to sign in
        </Link>
      </div>
    );
  }

  if (!token || linkDead) {
    return (
      <div className={WRAPPER}>
        <h1 ref={heading} tabIndex={-1} className="text-[22px] font-bold tracking-tight text-fg focus:outline-none">
          This link can&apos;t be used
        </h1>
        <Alert variant="error" className="mt-4">
          {linkDead
            ? "This link is invalid or has expired. Confirmation links work once and only for an hour."
            : "This link is incomplete. Open the whole link from your email, or request the change again from your account page."}
        </Alert>
        <p className="mt-6 text-sm">
          <Link href="/account" className={LINK}>
            Go to your account
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className={WRAPPER}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-info-bg text-info-icon">
        <MailIcon className="h-6 w-6" />
      </span>
      <h1 className="mt-4 text-[22px] font-bold tracking-tight text-fg">Confirm your new email address</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
        Confirming switches your account to this address, and signs you out of every device. From then on you sign in
        with this address.
      </p>
      {formError && (
        <Alert variant="error" className="mt-4">
          {formError}
        </Alert>
      )}
      <Button className="mt-6 w-full" onClick={confirm} loading={pending} autoFocus>
        {pending ? "Confirming…" : "Confirm email address"}
      </Button>
    </div>
  );
}
