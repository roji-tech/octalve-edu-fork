"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/auth/AuthShell";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import { CheckCircleIcon } from "@/components/ui/icons";
import { PASSWORD_MAX_BYTES, passwordByteLength } from "@/lib/auth/password-policy";

interface SetupWizardFormProps {
  requiresToken: boolean;
  /// A production build configured for plain HTTP (see setup/page.tsx).
  insecureBaseUrl: boolean;
}

export function SetupWizardForm({ requiresToken, insecureBaseUrl }: SetupWizardFormProps) {
  const router = useRouter();

  const [schoolName, setSchoolName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdAdminEmail, setCreatedAdminEmail] = useState<string | null>(null);

  const errorRef = useRef<HTMLDivElement>(null);

  const hasMinLength = password.length >= 8;
  const hasLetter = /[a-zA-Z]/.test(password);
  const hasNumber = /\d/.test(password);
  const passwordsMatch = password.length > 0 && password === confirmPassword;
  // bcrypt ignores everything after byte 72, so the server refuses longer
  // passwords rather than truncating. Say so as they type, in bytes-aware terms
  // (emoji / non-Latin letters take 2-4 bytes each).
  const tooLong = passwordByteLength(password) > PASSWORD_MAX_BYTES;
  const canSubmit =
    schoolName.trim().length > 0 &&
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    hasMinLength &&
    hasLetter &&
    hasNumber &&
    !tooLong &&
    passwordsMatch &&
    (!requiresToken || setupToken.trim().length > 0);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!canSubmit) {
      setErrorMessage("Please fill in every field correctly before continuing.");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await fetch("/api/v1/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(setupToken.trim() ? { "x-setup-token": setupToken.trim() } : {}),
        },
        body: JSON.stringify({
          schoolName: schoolName.trim(),
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(body?.error?.message ?? "Failed to complete setup");
      }

      setCreatedAdminEmail(email.trim().toLowerCase());
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "An unexpected error occurred.");
      // Bring the error into view for keyboard and screen-reader users.
      requestAnimationFrame(() => errorRef.current?.scrollIntoView({ block: "nearest" }));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (createdAdminEmail) {
    return (
      <AuthShell>
        <Card className="text-center">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-ok-bg text-ok-icon">
            <CheckCircleIcon className="h-7 w-7" />
          </span>
          <h1 className="mt-5 text-2xl font-bold tracking-tight text-fg">Setup complete</h1>
          <p className="mt-2 text-sm leading-relaxed text-fg-muted">
            The administrator account for{" "}
            <span className="font-medium text-fg">{createdAdminEmail}</span> has been created. This
            setup wizard is now permanently disabled.
          </p>
          <Button className="mt-6 w-full" onClick={() => router.push("/login")} autoFocus>
            Continue to sign in
          </Button>
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell size="md">
      <Card>
        <p className="text-xs font-semibold tracking-wider text-brand-fg uppercase">
          First-run setup
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-fg">
          Initialize this instance
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
          This runs once, on a fresh install. It creates your school and its first administrator
          account, then disables itself.
        </p>

        <div className="mt-6 space-y-4 empty:mt-0">
          {insecureBaseUrl && (
            <Alert variant="warning" title="This instance isn't served over HTTPS">
              Sign-in will work on a trusted local network, but sessions aren&apos;t protected in
              transit. Put this behind HTTPS (and set <code className="font-mono">APP_URL</code> to
              your <strong className="font-semibold">https</strong> address) before exposing it to
              the internet.
            </Alert>
          )}
          {errorMessage && (
            <div ref={errorRef}>
              <Alert variant="error">{errorMessage}</Alert>
            </div>
          )}
        </div>

        {/* method="post": a native submit (no JS / before hydration) must never put the password in the URL. */}
        <form method="post" onSubmit={handleSubmit} className="mt-6 space-y-5">
          <TextField
            label="School name"
            name="schoolName"
            value={schoolName}
            onChange={(e) => setSchoolName(e.target.value)}
            placeholder="e.g. Bright Future Academy"
            autoComplete="organization"
            disabled={isSubmitting}
            required
            autoFocus
          />

          <TextField
            label="Administrator name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Amina Yusuf"
            autoComplete="name"
            disabled={isSubmitting}
            required
          />

          <TextField
            label="Administrator email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@yourschool.com"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            disabled={isSubmitting}
            required
          />

          {requiresToken && (
            <div className="rounded-xl border border-warn-line bg-field p-4">
              <PasswordField
                label="Deployment setup token"
                name="setupToken"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="Enter SETUP_TOKEN from your environment"
                hint="Matches the SETUP_TOKEN environment variable on this server."
                autoComplete="off"
                disabled={isSubmitting}
                required
              />
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PasswordField
              label="Password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Min. 8 characters"
              autoComplete="new-password"
              maxLength={128}
              error={
                tooLong
                  ? `Too long — at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} characters; fewer with emoji or non-Latin letters).`
                  : null
              }
              disabled={isSubmitting}
              required
            />
            <PasswordField
              label="Confirm password"
              name="confirmPassword"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repeat password"
              autoComplete="new-password"
              maxLength={128}
              error={confirmPassword.length > 0 && !passwordsMatch ? "Passwords don't match." : null}
              disabled={isSubmitting}
              required
            />
          </div>

          <ul
            aria-label="Password requirements"
            className="space-y-1.5 rounded-xl border border-line bg-field p-3 text-xs"
          >
            {[
              { met: hasMinLength, text: "At least 8 characters" },
              { met: hasLetter && hasNumber, text: "Contains both letters and numbers" },
              { met: passwordsMatch, text: "Passwords match" },
            ].map(({ met, text }) => (
              <li key={text} className={met ? "text-ok-icon" : "text-fg-muted"}>
                <span aria-hidden="true">{met ? "✓" : "○"}</span> {text}
                <span className="sr-only">{met ? " — met" : " — not met yet"}</span>
              </li>
            ))}
          </ul>

          <Button type="submit" className="w-full" loading={isSubmitting} disabled={!canSubmit}>
            {isSubmitting ? "Setting up…" : "Complete setup"}
          </Button>
        </form>
      </Card>
    </AuthShell>
  );
}
