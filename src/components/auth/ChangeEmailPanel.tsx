"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import { MailIcon } from "@/components/ui/icons";
import { GENERIC_ERROR, NETWORK_ERROR, RATE_LIMITED, SESSION_ENDED, sendJson } from "@/components/auth/postJson";

// Deliberately loose: the point is to catch typos before a round trip. The server's zod rule decides, and the
// only real proof an address works is the link that is mailed to it.
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/// After the person acts, the control they used disappears — a heading that takes focus when it appears (never on
/// first load) lands keyboard and screen-reader users on what replaced it.
function Heading({ children, focus }: { children: string; focus: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  return (
    <h3 ref={ref} tabIndex={-1} className="text-base font-semibold text-fg focus:outline-none">
      {children}
    </h3>
  );
}

/// "Email address" card (plan §0.5.E): idle → form (new address + CURRENT password) → "check your inbox".
/// The screen says the same thing whether or not the address already belongs to somebody — that is the
/// server's promise, and this panel must not undo it by hinting at the difference.
export function ChangeEmailPanel({ email }: { email: string | null }) {
  const [view, setView] = useState<"idle" | "form" | "sent">("idle");
  const [touched, setTouched] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState("");
  const startButton = useRef<HTMLButtonElement>(null);

  // Back at the start (Cancel, or Done after the mail was sent): the control the person just used is gone, so
  // focus goes to the button that took its place, not to <body>.
  useEffect(() => {
    if (touched && view === "idle") startButton.current?.focus();
  }, [touched, view]);
  function go(next: "idle" | "form" | "sent") {
    setTouched(true);
    setView(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setFormError(null);
    const address = newEmail.trim();
    const noEmail = !address ? "Enter the new email address." : !LOOKS_LIKE_EMAIL.test(address) ? "Enter a valid email address." : null;
    const noPassword = password ? null : "Enter your current password.";
    setEmailError(noEmail);
    setPasswordError(noPassword);
    if (noEmail || noPassword) return;

    setPending(true);
    const reply = await sendJson("/api/v1/auth/email-change/request", "POST", { newEmail: address, password });
    setPending(false);
    if (reply.ok) {
      setSentTo(address);
      setNewEmail("");
      setPassword("");
      return go("sent");
    }
    setPassword("");
    if (reply.code === "INVALID_PASSWORD") setPasswordError(reply.message ?? "Your password is incorrect.");
    else if (reply.code === "SAME_EMAIL") setEmailError(reply.message ?? "That is already your email address.");
    else if (reply.code === "VALIDATION") setEmailError(reply.message ?? "Enter a valid email address.");
    else if (reply.status === 429) setFormError(RATE_LIMITED);
    else if (reply.status === 401) setFormError(SESSION_ENDED);
    else setFormError(reply.code === "NETWORK" ? NETWORK_ERROR : GENERIC_ERROR);
  }

  return (
    <div className="mt-4 space-y-4">
      {view === "idle" && (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">
            Your email address is <strong className="font-semibold break-words text-fg">{email ?? "not set"}</strong>.
          </p>
          <Button variant="secondary" onClick={() => go("form")} ref={startButton}>
            Change email address
          </Button>
        </div>
      )}

      {view === "form" && (
        <form method="post" onSubmit={submit} noValidate className="max-w-md space-y-4">
          <Heading focus={touched}>Change your email address</Heading>
          <p className="text-sm text-fg-muted">
            We&apos;ll send a link to the new address. Nothing changes until it is opened. When it is, you&apos;ll be
            signed out everywhere and sign in with the new address.
          </p>
          <TextField
            label="New email address"
            name="newEmail"
            type="email"
            value={newEmail}
            onChange={(e) => {
              setNewEmail(e.target.value);
              if (emailError) setEmailError(null);
            }}
            error={emailError}
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            disabled={pending}
          />
          <PasswordField
            label="Your password"
            hint="Enter your current password to confirm it's you."
            name="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (passwordError) setPasswordError(null);
            }}
            error={passwordError}
            autoComplete="current-password"
            maxLength={128}
            disabled={pending}
          />
          {formError && <Alert variant="error">{formError}</Alert>}
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button type="submit" loading={pending}>
              {pending ? "Sending…" : "Send confirmation link"}
            </Button>
            <Button variant="ghost" onClick={() => go("idle")} disabled={pending}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {view === "sent" && (
        <div className="max-w-md space-y-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-info-bg text-info-icon">
              <MailIcon className="h-5 w-5" />
            </span>
            <Heading focus={touched}>Check your inbox</Heading>
          </div>
          <p className="text-sm leading-relaxed text-fg-2">
            If <strong className="font-semibold break-words text-fg">{sentTo}</strong> can be used, a confirmation link is
            on its way. It works once and stops working after an hour. Your current address keeps working until you
            open it, and we&apos;ve let it know about the request.
          </p>
          <Button variant="secondary" onClick={() => go("idle")}>
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
