"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { PasswordField } from "@/components/ui/PasswordField";
import { TextField } from "@/components/ui/TextField";
import { CheckCircleIcon } from "@/components/ui/icons";
import { NETWORK_ERROR, RATE_LIMITED, problemFor, sendJson, type Reply } from "@/components/auth/postJson";
import { useFragmentToken } from "@/components/auth/useFragmentToken";
import { useSignOut } from "@/components/auth/useSignOut";
import { checkNewPassword } from "@/lib/auth/password-policy";
import { checkName } from "@/lib/auth/profile-policy";

const LINK = "inline-flex min-h-11 items-center font-semibold text-brand-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-md";
const WRAPPER = "rounded-2xl border border-line bg-surface p-6 shadow-card sm:p-7 lg:border-0 lg:bg-transparent lg:p-0 lg:shadow-none";

type Preview = { schoolName: string; role: string; roleLabel: string; email: string; accountExists: boolean; viewer: "none" | "invitee" | "other" };
type Outcome = { schoolCode: string; newAccount: boolean };

/// The page an invitation email opens (plan §0.5.4). The token is in the URL FRAGMENT, read once and removed from the address bar (like a
/// reset link). What the page offers depends on who is looking, and the rule behind every branch is the same — an EXISTING account is
/// attached only by its owner:
///   · no account for the address   → choose a name and a password (the link proves the address); then sign in
///   · an account, nobody signed in → sign in with it, then open the link again
///   · signed in as that account    → one button
///   · signed in as someone else    → sign out first
export function AcceptInviteForm() {
  const { token, version } = useFragmentToken();
  // keyed on the link: one opened in a tab that is already on this page starts from a clean slate
  return <AcceptInviteBody key={version} token={token} />;
}

/// `token`: undefined = not read yet; "" = no token in the URL.
function AcceptInviteBody({ token }: { token: string | undefined }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | "dead" | null>(null);
  const [done, setDone] = useState<Outcome | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { signOut, pending: signingOut, error: signOutError } = useSignOut();

  useEffect(() => {
    if (!token) return;
    let current = true;
    sendJson("/api/v1/invitations/preview", "POST", { token }).then((reply) => {
      if (!current) return;
      setPreview(reply.ok ? (reply.data as unknown as Preview) : "dead");
    });
    return () => {
      current = false;
    };
  }, [token]);

  function explain(reply: Reply) {
    if (reply.code === "INVALID_TOKEN") return setPreview("dead");
    if (reply.code === "SIGN_IN_REQUIRED" || reply.code === "WRONG_ACCOUNT") {
      // Somebody signed in or out in another tab since the page loaded: ask again what this link needs.
      if (token) sendJson("/api/v1/invitations/preview", "POST", { token }).then((next) => next.ok && setPreview(next.data as unknown as Preview));
      return setFormError(reply.message ?? null);
    }
    setNameError(problemFor(reply, "name") ?? null);
    setPasswordError(problemFor(reply, "password") ?? null);
    if (reply.status === 429) setFormError(RATE_LIMITED);
    else if (reply.status === 0) setFormError(NETWORK_ERROR);
    else if (!problemFor(reply, "name") && !problemFor(reply, "password")) setFormError(reply.message ?? "We couldn't accept that invitation right now. Please try again in a moment.");
  }

  async function accept(body: Record<string, unknown>) {
    if (pending || !token) return;
    setFormError(null);
    setPending(true);
    const reply = await sendJson("/api/v1/invitations/accept", "POST", { token, ...body });
    setPending(false);
    if (reply.ok) return setDone({ schoolCode: String(reply.data!.schoolCode), newAccount: Boolean(reply.data!.newAccount) });
    explain(reply);
  }

  function submitNewAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checkedName = checkName(name);
    const problem = !password ? "Choose a password." : checkNewPassword(password);
    const mismatch = !problem && password !== confirm ? "The two passwords don't match." : null;
    setNameError(checkedName.ok ? null : checkedName.message);
    setPasswordError(problem ?? mismatch);
    if (!checkedName.ok || problem || mismatch) return;
    void accept({ name: checkedName.name, password });
  }

  if (token === undefined || (token && preview === null)) {
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
        <h1 className="mt-4 text-[22px] font-bold tracking-tight text-fg">You&apos;re in</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
          {done.newAccount ? "Your account is ready. Sign in with the email address this invitation was sent to and the password you just chose." : "You now have access to the school."}
        </p>
        <Button className="mt-6 w-full" onClick={() => router.push(done.newAccount ? "/login" : `/schools/${done.schoolCode}`)} autoFocus>
          {done.newAccount ? "Continue to sign in" : "Open the school"}
        </Button>
      </div>
    );
  }

  if (!token || preview === "dead" || preview === null) {
    return (
      <div className={WRAPPER}>
        <h1 className="text-[22px] font-bold tracking-tight text-fg">This link can&apos;t be used</h1>
        <Alert variant="error" className="mt-4">
          {token
            ? "This invitation link is invalid or has expired. Invitation links work once and only for a short time."
            : "This invitation link is incomplete. Open the whole link from your email, or ask your administrator to send it again."}
        </Alert>
        <p className="mt-6 text-sm text-fg-muted">Ask your school administrator to send a new invitation.</p>
        <p className="mt-2 text-sm">
          <Link href="/login" className={LINK}>
            Go to sign in
          </Link>
        </p>
      </div>
    );
  }

  const intro = (
    <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
      You&apos;ve been invited as <strong className="font-semibold text-fg">{preview.roleLabel}</strong>. This invitation is for {preview.email}.
    </p>
  );

  if (preview.viewer === "other") {
    return (
      <div className={WRAPPER}>
        <h1 className="text-[22px] font-bold tracking-tight text-fg">This invitation is for a different account</h1>
        {intro}
        <Alert variant="warning" className="mt-4">
          You&apos;re signed in as someone else. Sign out, then open the link in your email again.
        </Alert>
        {signOutError && (
          <p role="alert" className="mt-3 text-sm font-medium text-danger-text">
            {signOutError}
          </p>
        )}
        <Button className="mt-6 w-full" variant="secondary" loading={signingOut} onClick={signOut}>
          Sign out
        </Button>
      </div>
    );
  }

  if (preview.accountExists && preview.viewer === "none") {
    return (
      <div className={WRAPPER}>
        <h1 className="text-[22px] font-bold tracking-tight text-fg">Sign in to join {preview.schoolName}</h1>
        {intro}
        <p className="mt-4 text-sm leading-relaxed text-fg-muted">
          An account already exists for this address. Sign in with it, then open the link in your email again to finish joining.
        </p>
        <Link href="/login" className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-brand-strong px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-strong/25 transition-colors hover:bg-brand-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Sign in
        </Link>
      </div>
    );
  }

  if (preview.viewer === "invitee") {
    return (
      <div className={WRAPPER}>
        <h1 className="text-[22px] font-bold tracking-tight text-fg">Join {preview.schoolName}</h1>
        {intro}
        {formError && (
          <Alert variant="error" className="mt-4">
            {formError}
          </Alert>
        )}
        <Button className="mt-6 w-full" loading={pending} onClick={() => accept({})} autoFocus>
          {pending ? "Joining…" : `Join ${preview.schoolName}`}
        </Button>
      </div>
    );
  }

  return (
    <div className={WRAPPER}>
      <h1 className="text-[22px] font-bold tracking-tight text-fg">Join {preview.schoolName}</h1>
      {intro}
      <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">Choose how you&apos;ll sign in. Passwords need at least 8 characters, with a letter and a number.</p>
      <form method="post" onSubmit={submitNewAccount} noValidate className="mt-6 space-y-4">
        <TextField
          label="Your name"
          name="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameError) setNameError(null);
          }}
          error={nameError}
          autoComplete="name"
          maxLength={100}
          autoFocus
          disabled={pending}
        />
        <PasswordField
          label="Password"
          name="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) setPasswordError(null);
          }}
          error={passwordError}
          autoComplete="new-password"
          maxLength={128}
          disabled={pending}
        />
        <PasswordField label="Confirm password" name="confirmPassword" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} disabled={pending} />
        {formError && <Alert variant="error">{formError}</Alert>}
        <Button type="submit" className="w-full" loading={pending}>
          {pending ? "Creating your account…" : "Create account and join"}
        </Button>
      </form>
    </div>
  );
}
