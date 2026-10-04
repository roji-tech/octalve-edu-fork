import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

// `referrer: no-referrer` — this page's URL carried a secret (briefly: the form removes it), so nothing
// the page links to or loads may ever see it as a Referer.
export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <ResetPasswordForm />
      <noscript>
        <p className="mt-4 text-sm text-fg-muted">This page needs JavaScript to read your reset link.</p>
      </noscript>
    </AuthShell>
  );
}
